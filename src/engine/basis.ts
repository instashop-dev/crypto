/**
 * Dated-futures basis (cash-and-carry to settlement) math.
 *
 * The strategy this prices is the **other** delta-neutral carry: buy the asset
 * on the spot market, sell a *dated* future on the same asset, and hold both to
 * the future's settlement. At expiry the future converges to spot by
 * construction, so the profit is the gap the two were trading at when the pair
 * was opened — less what it costs to get in and out.
 *
 * The one thing that makes this different from `./funding.ts` — and the whole
 * reason it exists as a separate strategy — is that **the return is locked in at
 * entry**. A perp carry earns whatever funding turns out to be over the hold,
 * and `./funding.ts` opens its own docblock by naming that extrapolation as its
 * dominant error source: the venue publishes the rate for the *next* settlement
 * and annualising it assumes ~1095 repetitions that mean reversion will not
 * deliver. A dated future has no such assumption in it. The price is the price;
 * convergence at expiry is a contractual fact, not a forecast. What is left
 * uncertain is whether the *position* survives to expiry, which is a margin
 * question — and margin is not modelled here at all (see below).
 *
 * Pure functions, exactly like `./funding.ts` and `./crossExchange.ts`: no I/O,
 * no clock (`nowTs` is always a parameter), no Workers or Hono imports, no
 * dependency on `src/types.ts`.
 *
 * ## Modelling boundaries (read these before believing a number)
 *
 * - **Margin and liquidation are not modelled.** This is the big one, and it is
 *   bigger here than it is for a perp carry: the short future leg needs
 *   collateral for however many months are left until settlement, that
 *   collateral earns nothing in this model, and a spot rally large enough to
 *   liquidate the short before expiry turns a "locked-in" return into a
 *   realised loss. The basis is locked in; being *there* at expiry is not.
 * - **The futures leg is charged `perp_fee_rate`.** OKX quotes one taker
 *   schedule for its whole derivatives book, so the dated-future taker rate is
 *   the same order as the perp one — but it is an approximation, made so that
 *   this strategy and the perp carry are priced by literally the same helper
 *   ({@link import("./funding").feeDragAnnualPct}) and cannot drift apart. If it
 *   is wrong it is wrong by basis points on a figure quoted in percent.
 * - **Contracts inside a day of settlement are excluded entirely.** See
 *   {@link MIN_DAYS_TO_EXPIRY}: the annualisation multiplier past that point is
 *   large enough to turn a rounding error into a headline, and the carry is not
 *   actionable anyway.
 * - **The hold *is* `daysToExpiry`.** Unlike a perp carry, the holding period is
 *   not a tunable assumption: the trade ends when the contract settles. So the
 *   fee drag is amortised over the actual remaining life of the contract, and
 *   `funding_hold_days` is deliberately not consulted anywhere in this file.
 * - **Mid prices on both legs.** See {@link midPrice}. A real round trip crosses
 *   two spreads on entry and two on exit; the mid-to-mid figure ignores all
 *   four, so every number here is an upper bound in exactly the way the rest of
 *   this repo's figures are.
 * - **Backwardation is kept, not clamped.** A future trading *below* spot is a
 *   negative basis and a valid observation — the reverse carry (short spot, long
 *   future) is the trade that harvests it. It is reported and never presented as
 *   tradable from that side, because the short-spot leg needs borrow and borrow
 *   cost is not modelled, exactly as `./funding.ts` treats a negative funding
 *   rate.
 * - **A year is 365 days**, and returns are **simple, not compounded**, matching
 *   `./funding.ts` so the two strategies' annualised figures are comparable.
 */
import { DAYS_PER_YEAR, MS_PER_DAY } from "./carry";
import { feeDragAnnualPct } from "./funding";
import { round8 } from "./pricing";

/**
 * Shortest remaining life a contract may have and still be priced: **one day**.
 *
 * `daysToExpiry` is a *divisor* in both the annualisation and the fee-drag term,
 * so a contract in its last hours produces an annualised figure that is
 * arithmetically correct and completely meaningless. At an hour the multiplier
 * is 8760x: a 0.05% mismark — well inside the width of a thin far-dated book,
 * and exactly what the `last`-price fallback produces — becomes a **+438%/yr**
 * headline that then sorts to the top of the board. At a day it is 365x, which
 * is the same order as the near-dated contracts a reader is already used to
 * comparing.
 *
 * The exclusion is not only about arithmetic sensitivity: near-expiry carry is
 * not actionable. A contract settling inside 24 hours leaves no room to open
 * both legs, and the basis it still shows is the residual nobody bothered to
 * arbitrage away rather than a return anyone could capture.
 *
 * Contracts inside it (and any already past expiry) are skipped, not zeroed:
 * "too close to settlement to annualise" is not "pays nothing".
 */
export const MIN_DAYS_TO_EXPIRY = 1;

/**
 * Days from `nowTs` until settlement. `null` when the contract has expired, is
 * inside {@link MIN_DAYS_TO_EXPIRY}, or either timestamp is unusable.
 */
export function daysToExpiry(expiryTs: number, nowTs: number): number | null {
  if (!Number.isFinite(expiryTs) || !Number.isFinite(nowTs)) return null;
  const days = (expiryTs - nowTs) / MS_PER_DAY;
  if (!(days >= MIN_DAYS_TO_EXPIRY)) return null;
  return round8(days);
}

/**
 * The raw basis: how much dearer the future is than spot, in percent.
 *
 * Positive is *contango* (the normal state of a crypto futures curve, and the
 * direction the cash-and-carry harvests); negative is *backwardation*.
 *
 * `null` for a non-positive or unusable spot price — the ratio has no meaning
 * without one, and a zero denominator must never reach the annualisation.
 */
export function basisPct(futurePrice: number, spotPrice: number): number | null {
  if (!Number.isFinite(futurePrice) || futurePrice <= 0) return null;
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  return round8((futurePrice / spotPrice - 1) * 100);
}

/**
 * The basis extrapolated to a simple annual rate: `basis x (365 / days)`.
 *
 * A 2% basis on a contract 90 days out is 8.11%/yr; the same 2% on one 30 days
 * out is 24.33%/yr, because it is earned three times as fast. This is the figure
 * that makes contracts of different maturities comparable, and it is the only
 * reason a board sorted by it means anything.
 */
export function annualizedBasisPct(basis: number, days: number): number | null {
  if (!Number.isFinite(basis)) return null;
  if (!Number.isFinite(days) || days < MIN_DAYS_TO_EXPIRY) return null;
  return round8(basis * (DAYS_PER_YEAR / days));
}

/**
 * The round-trip fee drag for a basis carry, annualised over the contract's
 * remaining life.
 *
 * Deliberately {@link feeDragAnnualPct} rather than a formula of its own — two
 * spot legs at `spotFeeRate` and two futures legs at `perpFeeRate`, the same
 * four legs a perp carry pays — so a change to how a round trip is amortised
 * lands on both strategies at once and they can never quietly disagree. The only
 * difference is the third argument: the holding period here is *not* a setting,
 * it is `daysToExpiry`, because the trade ends when the contract does.
 */
export function basisDragAnnualPct(
  spotFeeRate: number,
  perpFeeRate: number,
  days: number,
): number | null {
  return feeDragAnnualPct(spotFeeRate, perpFeeRate, days);
}

/** The minimum a row needs to be priceable. Callers pass richer objects. */
export interface BasisInput {
  /** Canonical asset symbol, e.g. `BTC`. */
  symbol: string;
  /** The venue's own contract name, e.g. `BTC-USD_UM-260925`. */
  instrument: string;
  /** Epoch millis of settlement. */
  expiryTs: number;
  spotPrice: number;
  futurePrice: number;
}

/** One priced contract: the caller's quote plus every derived figure. */
export interface BasisOpportunity<T extends BasisInput = BasisInput> {
  /** The input, untouched — extra venue fields ride along to the caller. */
  quote: T;
  symbol: string;
  instrument: string;
  expiryTs: number;
  daysToExpiry: number;
  spotPrice: number;
  futurePrice: number;
  /** Future over spot, in percent. Negative is backwardation, and is kept. */
  basisPct: number;
  /** {@link basisPct} extrapolated to a year. */
  annualizedPct: number;
  /** The four-leg round trip amortised over {@link daysToExpiry}. */
  feeDragAnnualPct: number;
  /** What the pair keeps: annualised basis less the drag. */
  netAnnualPct: number;
}

/**
 * Price one contract. `null` when any part of it is unpriceable.
 *
 * Rejected as `null` rather than as a zero, for the reason
 * {@link import("./funding").rankFundingOpportunities} drops rather than zeroes:
 * "we could not compute this" and "this pays nothing" are different facts and
 * must not share a value. The cases are an unusable symbol, a contract at or
 * past {@link MIN_DAYS_TO_EXPIRY}, a non-positive price on either leg, and an
 * unusable fee rate.
 */
export function evaluateBasis<T extends BasisInput>(
  quote: T,
  spotFeeRate: number,
  perpFeeRate: number,
  nowTs: number,
): BasisOpportunity<T> | null {
  if (!quote || typeof quote.symbol !== "string" || quote.symbol.length === 0) {
    return null;
  }

  const days = daysToExpiry(quote.expiryTs, nowTs);
  if (days === null) return null;

  const basis = basisPct(quote.futurePrice, quote.spotPrice);
  if (basis === null) return null;

  const annual = annualizedBasisPct(basis, days);
  if (annual === null) return null;

  const drag = basisDragAnnualPct(spotFeeRate, perpFeeRate, days);
  if (drag === null) return null;

  return {
    quote,
    symbol: quote.symbol,
    instrument: quote.instrument,
    expiryTs: quote.expiryTs,
    daysToExpiry: days,
    spotPrice: quote.spotPrice,
    futurePrice: quote.futurePrice,
    basisPct: basis,
    annualizedPct: annual,
    feeDragAnnualPct: drag,
    netAnnualPct: round8(annual - drag),
  };
}

/**
 * Price and rank every contract, best net annual return first.
 *
 * Unlike the perp board, the fee drag here is **not** the same for every row:
 * it is amortised over each contract's own remaining life, so a week-out
 * contract carries an order of magnitude more drag than a year-out one and
 * ranking by net is genuinely not the same as ranking by gross. That is the
 * point of the column — a fat near-dated basis is routinely worth less than a
 * thin far-dated one once the round trip is paid.
 *
 * Ties keep input order (`Array.prototype.sort` is stable), so two polls of the
 * same board rank identically.
 */
export function rankBasisOpportunities<T extends BasisInput>(
  quotes: Iterable<T>,
  spotFeeRate: number,
  perpFeeRate: number,
  nowTs: number,
): Array<BasisOpportunity<T>> {
  const ranked: Array<BasisOpportunity<T>> = [];
  for (const quote of quotes) {
    const priced = evaluateBasis(quote, spotFeeRate, perpFeeRate, nowTs);
    if (priced !== null) ranked.push(priced);
  }
  return ranked.sort((a, b) => b.netAnnualPct - a.netAnnualPct);
}
