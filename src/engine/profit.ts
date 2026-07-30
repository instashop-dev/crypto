/**
 * Profitability math for triangular arbitrage.
 *
 * Pure functions over a snapshot `Book`: no I/O, no clock, no Workers or Hono
 * imports, no dependency on `src/types.ts`. Everything is deterministic given
 * `(universe, baseAsset, book, feeRate)`.
 *
 * ## Modelling simplifications (MVP, per the design doc)
 *
 * - **Depth is ignored.** Every leg fills entirely at the top-of-book quote,
 *   regardless of size. Real fills would walk the book and be strictly worse,
 *   so reported profits are an upper bound.
 * - **Exchange filters are ignored** — no lot-size, tick-size or min-notional
 *   rounding is applied to leg amounts.
 * - **Fees are taker fees taken from the output asset** of each leg, which is
 *   how Binance charges a market order settling in the received asset.
 */
import {
  cycleLabel,
  enumerateTriangles,
  resolveLeg,
  type Triangle,
} from "./triangles";
import type { Book, ExecutedLeg } from "./types";

/** A triangle priced against a snapshot, on a notional of 1 base unit. */
export interface TriangleQuote {
  triangle: Triangle;
  /** e.g. `"USDT>BTC>ETH>USDT"`. */
  cycle: string;
  /** Round-trip return in percent **before** fees (fee rate 0). */
  grossPct: number;
  /** Round-trip return in percent **after** the per-leg fee. */
  netPct: number;
  /** The three legs as priced at the net fee rate, on notional 1. */
  legs: ExecutedLeg[];
}

/** A cycle simulated at a real notional. Phase 4 persists this as a `trade`. */
export interface ExecutedTrade {
  cycle: string;
  startAmount: number;
  endAmount: number;
  /** `endAmount - startAmount`, in the base asset. */
  profit: number;
  /** `profit / startAmount` in percent; equals the quote's `netPct`. */
  profitPct: number;
  legs: ExecutedLeg[];
}

/**
 * Round to 8 decimals — the precision every amount we hand out or store is
 * quantised to, so that D1 rows, API responses and test expectations all agree
 * instead of drifting by float dust.
 *
 * Applied to *reported* amounts only. The conversion chain itself carries full
 * double precision (see {@link convert}): quantising mid-chain would be
 * catastrophic on a notional of 1, where a BTC leg holds ~2e-5 and 8-decimal
 * rounding is a ~0.1% error — the same order of magnitude as the arbitrage
 * edge being measured.
 */
export function round8(n: number): number {
  if (!Number.isFinite(n)) return Number.NaN;
  const scaled = n * 1e8;
  // Beyond 2^53 the multiply has already lost more than the rounding would
  // remove, so pass the value through rather than corrupt it.
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    return n;
  }
  return Math.round(scaled) / 1e8;
}

/** A usable amount or price: a real, strictly positive number. */
function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A usable fee rate: real, non-negative, and less than 100%. */
function isValidFee(feeRate: number): boolean {
  return Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1;
}

/**
 * Convert `amount` of `from` into `to` at the snapshot's best quote.
 *
 * Direction is resolved from the book's own keys (see
 * {@link import("./triangles").resolveLeg}):
 *
 * - book lists `to + from` — BUY the base at the **ask**:
 *   `out = amount / ask * (1 - feeRate)`
 * - book lists `from + to` — SELL the base at the **bid**:
 *   `out = amount * bid * (1 - feeRate)`
 *
 * Returns `null` — never a `NaN`/`Infinity` result — when neither direction is
 * listed, when the quote is poisoned (non-finite or non-positive bid *or* ask),
 * when `amount` is not a positive real, when `feeRate` is out of range, or when
 * the arithmetic would produce a non-finite output.
 *
 * The returned `out` is **unrounded** and is what callers must chain into the
 * next leg; `leg.outAmount` is the same value quantised by {@link round8} for
 * reporting.
 */
export function convert(
  from: string,
  to: string,
  amount: number,
  book: Book,
  feeRate: number,
): { out: number; leg: ExecutedLeg } | null {
  if (!isPositive(amount) || !isValidFee(feeRate)) return null;

  const leg = resolveLeg(from, to, book);
  if (!leg) return null;

  const entry = book.get(leg.pair);
  if (!entry) return null;
  // Both sides are validated even though only one is used: an entry with a
  // broken half is a corrupt quote, and silently trading the other half of it
  // would launder bad data into the P&L.
  if (!isPositive(entry.bid) || !isPositive(entry.ask)) return null;

  const price = leg.side === "BUY" ? entry.ask : entry.bid;
  const converted = leg.side === "BUY" ? amount / price : amount * price;
  const out = converted * (1 - feeRate);
  if (!isPositive(out)) return null;

  return {
    out,
    leg: {
      pair: leg.pair,
      side: leg.side,
      price,
      inAsset: from,
      inAmount: round8(amount),
      outAsset: to,
      outAmount: round8(out),
    },
  };
}

/**
 * Run all three conversions of `tri` starting from `startAmount`, carrying full
 * precision between legs. `null` if any leg is unpriceable.
 */
function runChain(
  tri: Triangle,
  book: Book,
  feeRate: number,
  startAmount: number,
): { amount: number; legs: ExecutedLeg[] } | null {
  let amount = startAmount;
  const legs: ExecutedLeg[] = [];

  for (const leg of tri.legs) {
    const step = convert(leg.from, leg.to, amount, book, feeRate);
    if (!step) return null;
    amount = step.out;
    legs.push(step.leg);
  }

  return { amount, legs };
}

/**
 * Price a triangle on a notional of 1 base unit.
 *
 * `grossPct` is a full re-run of the chain at fee rate 0 rather than an
 * algebraic un-fee of the net figure: the two agree here, but only because
 * every leg happens to charge the same rate, and re-running keeps the number
 * honest if that ever stops being true.
 *
 * Returns `null` if any leg is missing or poisoned, so a bad quote can never
 * surface as a `NaN` percentage.
 */
export function evaluateTriangle(
  tri: Triangle,
  book: Book,
  feeRate: number,
): TriangleQuote | null {
  const net = runChain(tri, book, feeRate, 1);
  if (!net) return null;

  const gross = runChain(tri, book, 0, 1);
  if (!gross) return null;

  return {
    triangle: tri,
    cycle: cycleLabel(tri),
    grossPct: round8((gross.amount - 1) * 100),
    netPct: round8((net.amount - 1) * 100),
    legs: net.legs,
  };
}

/**
 * Every priceable cycle out of `baseAsset`, best net return first.
 *
 * Ties keep enumeration order (`Array.prototype.sort` is stable), which is a
 * pure function of `universe` order — so two scans of the same book produce
 * byte-identical rankings.
 */
export function rankOpportunities(
  universe: string[],
  baseAsset: string,
  book: Book,
  feeRate: number,
): TriangleQuote[] {
  const quotes: TriangleQuote[] = [];

  for (const tri of enumerateTriangles(universe, baseAsset, book)) {
    const quote = evaluateTriangle(tri, book, feeRate);
    if (quote) quotes.push(quote);
  }

  return quotes.sort((a, b) => b.netPct - a.netPct);
}

/**
 * Re-price a quoted cycle at a real notional — identical math, real amounts.
 *
 * Because every leg is linear in its input and the whole chain is scale-free,
 * `profitPct` reproduces the quote's `netPct` (up to float dust); the point of
 * this call is the concrete per-leg amounts Phase 4 applies to balances.
 *
 * Returns `null` if the book has moved out from under the quote and a leg can
 * no longer be priced.
 */
export function simulateExecution(
  quote: TriangleQuote,
  book: Book,
  feeRate: number,
  startAmount: number,
): ExecutedTrade | null {
  if (!isPositive(startAmount)) return null;

  const chain = runChain(quote.triangle, book, feeRate, startAmount);
  if (!chain) return null;

  const profit = chain.amount - startAmount;

  return {
    cycle: quote.cycle,
    startAmount: round8(startAmount),
    endAmount: round8(chain.amount),
    profit: round8(profit),
    profitPct: round8((profit / startAmount) * 100),
    legs: chain.legs,
  };
}
