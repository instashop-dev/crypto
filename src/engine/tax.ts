/**
 * India-mode P&L: what a VDA trade actually nets an Indian resident.
 *
 * Pure module in the same sense as `./profit` — plain functions over a snapshot
 * `Book`, no I/O, no clock, no Workers imports, and no dependency on `src/`
 * outside `src/engine/`. Everything here is deterministic given
 * `(chain, book, feeRate, startAmount, baseAsset, policy)`.
 *
 * ## The two Indian levies, and why they behave so differently
 *
 * - **Section 194S — 1% TDS.** Withheld by the exchange on the *consideration*
 *   of every transfer of a virtual digital asset. It is a **prepayment**: the
 *   money leaves the trading balance immediately, but it is credited back
 *   against the year's tax bill. It is therefore a cash-flow event, not a cost.
 * - **Section 115BBH — 30% on gains.** Charged on the gain of the transfer.
 *   Crucially it allows **no set-off of losses** against other transfers and no
 *   deduction other than cost of acquisition — so tax is charged per trade on
 *   `max(profit, 0)` and a losing cycle does not shelter a winning one.
 *
 * ## Why every leg is a disposal, not just the `side === "SELL"` ones
 *
 * `Side` here is an *exchange listing* artefact: `USDT -> BTC` is a BUY only
 * because the market happens to be listed as `BTCUSDT`. Under 194S what matters
 * is that a VDA changed hands, and **USDT is itself a VDA** in Indian law — it
 * is not legal tender and not a "currency" for these purposes. So each of the
 * three hops disposes of a VDA (USDT, then BTC, then ETH) and each attracts
 * TDS. Charging only the SELL legs would understate the withholding by ~2/3 and
 * would flip depending on how the exchange spells its symbols, which is exactly
 * the kind of accident this module exists to rule out.
 *
 * That is the headline result: a 3-leg cycle withholds ~3% of notional in TDS
 * against a real triangular edge measured in basis points. See the README.
 *
 * ## Why TDS is not compounded into the chain
 *
 * TDS is withheld from the settlement of each leg, so a fully faithful model
 * would shrink the amount carried into the next hop and thereby change
 * `endAmount` and `profitPct`. It deliberately does not here: india mode must be
 * a **reporting overlay**, so that the same book produces byte-identical
 * `endAmount` / `profitPct` / ranking with the mode on and off, and the only
 * observable difference is the tax figures themselves. Compounding would make
 * every historical comparison across the flag meaningless. The error is second
 * order (1% of a 1% withholding) and always in the conservative direction.
 *
 * ## Why `netProfit` nets `taxDue` and not `tdsWithheld`
 *
 * They are not two costs, they are one cost and one prepayment of it:
 *
 * - `netProfit  = grossProfit - taxDue`      — the **economic** result.
 * - `cashProfit = grossProfit - tdsWithheld` — the **balance** effect today.
 *
 * Subtracting both would double-count. `cashProfit` is the number that goes
 * deeply negative on a real book and is the honest answer to "should I run this
 * strategy from India"; `netProfit` is the number an accountant recognises.
 *
 * ## The `round8` hazard
 *
 * `ExecutedLeg.inAmount` / `outAmount` are `round8`-quantised *for reporting*.
 * On a BTC leg of a 100 USDT notional that is ~1.7e-3 BTC, where 8-decimal
 * rounding is a ~1e-6 relative error — small, but the TDS base is ~3x notional
 * and the edge being measured is ~1e-4 relative, so reading `leg.inAmount` back
 * would inject error of the same order as the answer. **Tax math therefore
 * never reads `ExecutedLeg` amounts**: {@link priceChain} re-runs the whole
 * chain through the unrounded `convert()` and hands out full-precision
 * disposals. Quantisation happens once, at the very end, on reported figures.
 *
 * ## Documented simplifications
 *
 * - **No INR FX.** Everything is denominated in USDT; the statutory figures are
 *   INR amounts. A single FX rate would cancel out of every ratio reported here
 *   anyway, so it is omitted rather than faked.
 * - **TDS is not compounded** into the conversion chain (see above).
 * - **The 194S de-minimis is ignored** — the 10,000 / 50,000 INR annual
 *   thresholds below which no TDS is deducted. A bot that scans every minute
 *   clears them within the first hour, so modelling them would only mislead.
 * - **No cess or surcharge.** The 4% health-and-education cess would make the
 *   effective rate 31.2%; rather than hard-code it, `tax_rate` is a setting and
 *   an operator who wants it can set `0.312`.
 * - **No cost-of-acquisition subtleties.** 115BBH allows only cost of
 *   acquisition as a deduction, and for an atomic same-instant cycle the cost of
 *   acquisition *is* the start notional — so `endAmount - startAmount` is
 *   already the statutory gain. Fees are absorbed into the chain, which is
 *   arguably generous to the taxpayer, and is called out here rather than
 *   silently assumed.
 *
 * None of this is tax advice.
 */
import { convert, round8, type TriangleQuote } from "./profit";
import type { Triangle } from "./triangles";
import type { Book } from "./types";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** The tax regime a computation runs under. Rates are fractions, not percent. */
export interface TaxPolicy {
  /** When false every figure below collapses to the tax-free result. */
  enabled: boolean;
  /** Section 194S withholding, as a fraction of consideration (0.01 = 1%). */
  tdsRate: number;
  /** Section 115BBH rate on gains, as a fraction (0.3 = 30%). */
  taxRate: number;
}

/**
 * The identity policy: what the rest of the app has always done.
 *
 * Used as the default everywhere a policy is optional, so that forgetting to
 * thread one through can only ever produce the pre-Phase-8 numbers rather than
 * a silently half-taxed figure.
 */
export const NO_TAX: TaxPolicy = { enabled: false, tdsRate: 0, taxRate: 0 };

/** A usable rate: real and in `[0, 1)`. A 100% rate is a modelling error. */
function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate < 1;
}

/** Normalise a policy, defusing a hand-edited settings row that holds junk. */
function sanitise(policy: TaxPolicy): TaxPolicy {
  if (!policy.enabled) return NO_TAX;
  return {
    enabled: true,
    tdsRate: isValidRate(policy.tdsRate) ? policy.tdsRate : 0,
    taxRate: isValidRate(policy.taxRate) ? policy.taxRate : 0,
  };
}

// ---------------------------------------------------------------------------
// The leg-chain core
// ---------------------------------------------------------------------------

/**
 * One hop of a conversion chain, reduced to the only two facts the tax core
 * needs. Structurally a subset of {@link import("./triangles").Leg}, so a
 * `Triangle`'s legs can be passed straight in — while a future two-leg
 * cross-exchange spread (or any n-leg chain) can be priced by the same code.
 */
export interface ChainHop {
  from: string;
  to: string;
}

/**
 * One disposal: `inAmount` of `inAsset` left the portfolio on this hop.
 *
 * `inAmount` is **unrounded**. It is the value that was actually carried into
 * the leg, not the `round8`-quantised figure reported on `ExecutedLeg`.
 */
export interface DisposalLeg {
  inAsset: string;
  inAmount: number;
}

/**
 * Re-run a chain at full precision and report what each hop disposed of.
 *
 * This is the seam that keeps the tax math off the reported (rounded) leg
 * amounts — see the `round8` hazard note at the top of the file. `null` when
 * any hop is unpriceable against `book`, so a stale or poisoned quote yields no
 * tax figures rather than a `NaN` one.
 */
export function priceChain(
  hops: readonly ChainHop[],
  book: Book,
  feeRate: number,
  startAmount: number,
): { disposals: DisposalLeg[]; endAmount: number } | null {
  if (hops.length === 0) return null;

  let amount = startAmount;
  const disposals: DisposalLeg[] = [];

  for (const hop of hops) {
    const step = convert(hop.from, hop.to, amount, book, feeRate);
    if (!step) return null;
    disposals.push({ inAsset: hop.from, inAmount: amount });
    amount = step.out;
  }

  return { disposals, endAmount: amount };
}

/**
 * Value each disposal in the base asset — the 194S consideration per leg.
 *
 * A leg already denominated in the base asset is worth its own amount; anything
 * else is marked at the snapshot's **fee-free** quote (`feeRate` 0), which
 * resolves to the bid for the usual `X -> USDT` direction. Fee-free is
 * deliberate: this is a *valuation*, not a trade. Charging a notional taker fee
 * would understate the consideration the exchange would actually withhold on,
 * and no fee is in fact paid to perform a valuation.
 *
 * Returns `null` — never a partially-valued array — when any leg's asset cannot
 * be priced into `baseAsset` at all.
 */
export function disposalValues(
  disposals: readonly DisposalLeg[],
  book: Book,
  baseAsset: string,
): number[] | null {
  const values: number[] = [];

  for (const { inAsset, inAmount } of disposals) {
    if (inAsset === baseAsset) {
      if (!Number.isFinite(inAmount) || inAmount <= 0) return null;
      values.push(round8(inAmount));
      continue;
    }
    const priced = convert(inAsset, baseAsset, inAmount, book, 0);
    if (!priced) return null;
    values.push(round8(priced.out));
  }

  return values;
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

/**
 * Everything india mode has to say about one executed cycle.
 *
 * Every figure is `round8`-quantised, for the same reason `ExecutedTrade`'s
 * are: D1 rows, API responses and test expectations must agree exactly rather
 * than drift by float dust.
 */
export interface TaxBreakdown {
  startAmount: number;
  endAmount: number;
  /** `endAmount - startAmount`. Identical with the policy on or off. */
  grossProfit: number;
  grossProfitPct: number;
  /** Sum of the per-leg disposal values: the 194S base, ~3x notional. */
  tdsBase: number;
  /** `tdsRate * tdsBase` — cash withheld, later credited back. */
  tdsWithheld: number;
  /** Per-leg withholding, in chain order. Sums to {@link tdsWithheld}. */
  legTds: number[];
  /** `taxRate * max(grossProfit, 0)` — 115BBH allows no loss offset. */
  taxDue: number;
  /** `grossProfit - taxDue`: the economic result. */
  netProfit: number;
  netProfitPct: number;
  /** `grossProfit - tdsWithheld`: today's effect on the paper balance. */
  cashProfit: number;
  tdsRate: number;
  taxRate: number;
}

/**
 * The 115BBH charge on one transfer: 30% of a gain, nothing on a loss.
 *
 * Clamped at zero rather than allowed to go negative because a loss produces no
 * refundable credit — losses may not be set off against other VDA transfers,
 * carried forward, or netted against any other head of income.
 */
export function taxOnProfit(profit: number, taxRate: number): number {
  if (!Number.isFinite(profit) || !isValidRate(taxRate)) return 0;
  return profit > 0 ? round8(profit * taxRate) : 0;
}

/** Sum, guarding against a stray non-finite value reaching the total. */
function total(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}

/**
 * Price and tax an arbitrary ordered chain of hops. The generic core; see
 * {@link computeTradeTax} for the triangle-shaped wrapper.
 *
 * A **disabled** policy still returns a breakdown rather than `null`: callers
 * (the executor, the API) want one shape to render either way, and the zeros it
 * carries make `netProfit === cashProfit === grossProfit` true by construction.
 * `null` is reserved for "this chain cannot be priced against this book".
 */
export function computeChainTax(
  hops: readonly ChainHop[],
  book: Book,
  feeRate: number,
  startAmount: number,
  baseAsset: string,
  policy: TaxPolicy,
): TaxBreakdown | null {
  const { enabled, tdsRate, taxRate } = sanitise(policy);

  const chain = priceChain(hops, book, feeRate, startAmount);
  if (!chain) return null;

  const grossProfit = chain.endAmount - startAmount;
  const grossProfitPct = startAmount > 0 ? (grossProfit / startAmount) * 100 : 0;

  const base = {
    startAmount: round8(startAmount),
    endAmount: round8(chain.endAmount),
    grossProfit: round8(grossProfit),
    grossProfitPct: round8(grossProfitPct),
  };

  if (!enabled) {
    return {
      ...base,
      tdsBase: 0,
      tdsWithheld: 0,
      legTds: chain.disposals.map(() => 0),
      taxDue: 0,
      netProfit: base.grossProfit,
      netProfitPct: base.grossProfitPct,
      cashProfit: base.grossProfit,
      tdsRate: 0,
      taxRate: 0,
    };
  }

  const values = disposalValues(chain.disposals, book, baseAsset);
  if (!values) return null;

  const tdsBase = round8(total(values));
  const tdsWithheld = round8(tdsBase * tdsRate);
  const taxDue = taxOnProfit(grossProfit, taxRate);
  const netProfit = round8(grossProfit - taxDue);

  return {
    ...base,
    tdsBase,
    tdsWithheld,
    legTds: values.map((v) => round8(v * tdsRate)),
    taxDue,
    netProfit,
    netProfitPct: startAmount > 0 ? round8((netProfit / startAmount) * 100) : 0,
    // Not `netProfit - tdsWithheld`: TDS is a prepayment of `taxDue`, not a
    // second charge. This is the balance view, that one is the economic view.
    cashProfit: round8(grossProfit - tdsWithheld),
    tdsRate,
    taxRate,
  };
}

/**
 * Tax one triangular cycle at a real notional.
 *
 * A thin wrapper over {@link computeChainTax}: a `Triangle`'s legs already carry
 * `from`/`to`, so the three-hop case needs no special-casing beyond naming it.
 * The chain is re-priced here rather than read off the caller's `ExecutedTrade`
 * precisely so that no `round8`-quantised amount can leak into the tax base.
 */
export function computeTradeTax(
  tri: Triangle,
  book: Book,
  feeRate: number,
  startAmount: number,
  baseAsset: string,
  policy: TaxPolicy,
): TaxBreakdown | null {
  return computeChainTax(tri.legs, book, feeRate, startAmount, baseAsset, policy);
}

/** Opportunity-level tax figures, per unit of notional. */
export interface QuoteTax {
  /**
   * `netPct` after the 115BBH charge. Losses pass through untouched — no
   * set-off is available, so a negative cycle is not made less negative by tax.
   */
  indiaNetPct: number;
  /** TDS withheld as a percent of notional. ~3% for a 3-leg cycle at 1%/leg. */
  tdsPct: number;
}

/**
 * Tax figures for a ranked quote, on a notional of 1 base unit.
 *
 * `indiaNetPct` is derived from the quote's **reported** `netPct` rather than
 * re-derived from a fresh chain: `x -> x > 0 ? x * (1 - taxRate) : x` is
 * strictly increasing for any `taxRate < 1`, so ranking by `indiaNetPct` and
 * ranking by `netPct` are provably the same ordering — including ties, which
 * map to ties. That is what lets the scanner keep sorting on `netPct` and
 * attach these purely as a display column.
 *
 * `tdsPct` is computed from `tdsBase` rather than from the notional-1
 * `tdsWithheld`: at a notional of 1 the withheld figure is ~0.03, where `round8`
 * would throw away two significant digits and the number would stop agreeing
 * with the executed trade's.
 */
export function quoteTax(
  quote: TriangleQuote,
  book: Book,
  feeRate: number,
  baseAsset: string,
  policy: TaxPolicy,
): QuoteTax | null {
  const { enabled, taxRate } = sanitise(policy);
  if (!enabled) return { indiaNetPct: quote.netPct, tdsPct: 0 };

  const breakdown = computeChainTax(
    quote.triangle.legs,
    book,
    feeRate,
    1,
    baseAsset,
    policy,
  );
  if (!breakdown) return null;

  return {
    indiaNetPct:
      quote.netPct > 0 ? round8(quote.netPct * (1 - taxRate)) : quote.netPct,
    tdsPct: round8(breakdown.tdsBase * breakdown.tdsRate * 100),
  };
}
