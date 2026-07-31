/**
 * Funding-rate (cash-and-carry) math.
 *
 * The strategy this prices is **delta-neutral carry**: buy the asset on the
 * spot market, sell the same size of its perpetual future, and collect the
 * funding payment the perp's longs pay its shorts every interval. Price risk
 * cancels between the two legs, so the return is the funding stream less what
 * it costs to get in and out.
 *
 * Pure functions, exactly like `./profit.ts`: no I/O, no clock, no Workers or
 * Hono imports, no dependency on `src/types.ts`. Everything is deterministic
 * given `(rate, intervalMinutes, feeRate, holdingDays)`.
 *
 * ## Modelling boundaries (read these before believing a number)
 *
 * - **The predicted next rate is the dominant error source.** A venue publishes
 *   the rate for the *next* settlement only. Annualising it assumes that one
 *   rate repeats ~1095 times a year, which it does not: funding mean-reverts,
 *   flips sign with sentiment, and the eye-catching figures are precisely the
 *   ones least likely to persist. Every percentage here is "what the last
 *   observation would pay if it never changed", not a forecast.
 * - **Only long-spot / short-perp is modelled.** The mirror (short spot, long
 *   perp, collecting negative funding) needs borrow, and borrow cost is not
 *   modelled — so negative rows are ranked and reported, never presented as
 *   tradable from the other side.
 * - **Basis is ignored.** Entry and exit are assumed to happen at the same
 *   spot/perp price, i.e. the basis at entry equals the basis at exit. In
 *   reality convergence is where a carry trade makes or loses most of its
 *   non-funding P&L.
 * - **Slippage, depth, margin and liquidation are ignored.** The short perp leg
 *   needs collateral, that collateral earns nothing here, and an adverse move
 *   large enough to liquidate it is not simulated at all.
 * - **A year is 365 days**, and returns are **simple, not compounded** — funding
 *   is assumed withdrawn, not reinvested. Compounding would raise every figure
 *   below and would be the less conservative choice.
 */
import { round8 } from "./profit";

/** Minutes in a 365-day year: the annualisation constant everything shares. */
export const MINUTES_PER_YEAR = 525_600;

/**
 * Assumed settlement cadence when a venue does not tell us its own.
 *
 * 8 hours is the industry default (Binance, Bybit and OKX all use it for the
 * large majority of their linear perps), so it is the least-wrong guess. Rows
 * that fall back to it are tagged `interval_source = 'assumed'` all the way
 * through to the dashboard, because the annualised figure scales *linearly*
 * with this number — a contract that actually settles hourly would be
 * under-reported by 8x.
 */
export const DEFAULT_FUNDING_INTERVAL_MINUTES = 480;

/**
 * Fee-charging legs in one round trip: buy spot, sell perp, sell spot, buy
 * perp back. Both venues charge on entry *and* on exit, and a carry trade that
 * only counted the entry would look twice as good as it is.
 */
export const FUNDING_ROUND_TRIP_LEGS = 4;

/**
 * Longest settlement cadence treated as real: one day.
 *
 * A perp quoting a weekly interval is a parsing accident far more often than it
 * is a product, and the interval divides into the annualised figure, so a wrong
 * one is not a small error.
 */
const MAX_FUNDING_INTERVAL_MINUTES = 1440;

/**
 * How many funding settlements a year of `intervalMinutes` holds.
 *
 * `null` — never `Infinity`, never `NaN` — for a non-finite, non-positive or
 * implausibly long interval, so a junk value from an upstream cannot become a
 * junk annualised percentage further down.
 */
export function periodsPerYear(intervalMinutes: number): number | null {
  if (!Number.isFinite(intervalMinutes)) return null;
  if (intervalMinutes <= 0) return null;
  if (intervalMinutes > MAX_FUNDING_INTERVAL_MINUTES) return null;
  return MINUTES_PER_YEAR / intervalMinutes;
}

/**
 * The funding rate expressed as a simple annual percentage.
 *
 * `rate` is the per-interval fraction a short receives (positive) or pays
 * (negative), e.g. `0.0001` = 0.01% per settlement. At the 8-hour default that
 * is 1095 settlements a year and `0.0001 x 1095 x 100 = 10.95%`.
 *
 * A magnitude of 1 (100% per settlement) or more is rejected outright: real
 * funding rates are capped in the basis points, so such a value is a decoded
 * field that was never a rate.
 */
export function annualizedPct(rate: number, intervalMinutes: number): number | null {
  if (!Number.isFinite(rate) || Math.abs(rate) >= 1) return null;
  const periods = periodsPerYear(intervalMinutes);
  if (periods === null) return null;
  return round8(rate * periods * 100);
}

/** A usable fee rate: real, non-negative, and less than 100%. */
function isValidFee(feeRate: number): boolean {
  return Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1;
}

/**
 * Total fee paid to open and close the pair, as a fraction of notional.
 *
 * Approximated as `legs x feeRate` rather than `1 - (1 - feeRate)^legs`: at
 * realistic taker fees the two differ in the sixth decimal, and the linear form
 * is the one a desk actually quotes. Being marginally the *larger* of the two
 * also keeps the estimate on the conservative side.
 */
export function roundTripFeeFraction(
  feeRate: number,
  legs: number = FUNDING_ROUND_TRIP_LEGS,
): number | null {
  if (!isValidFee(feeRate)) return null;
  if (!Number.isFinite(legs) || legs <= 0) return null;
  return round8(feeRate * legs);
}

/**
 * The round-trip fee, spread over a `holdingDays` position and annualised.
 *
 * This is why holding period matters to a carry trade at all: the funding
 * stream accrues per day, the fee is paid once. Held for a day, a 0.4%
 * round trip costs 146% a year; held for a year, 0.4%.
 */
export function feeDragAnnualPct(
  feeRate: number,
  holdingDays: number,
  legs: number = FUNDING_ROUND_TRIP_LEGS,
): number | null {
  if (!Number.isFinite(holdingDays) || holdingDays <= 0) return null;
  const fraction = roundTripFeeFraction(feeRate, legs);
  if (fraction === null) return null;
  return round8(fraction * (365 / holdingDays) * 100);
}

/**
 * What the position keeps: the annualised funding less the annualised fee drag.
 *
 * Worked example — rate `0.0001` per 8h, fee `0.001`/leg, held 30 days:
 *
 * ```
 * periods    525600 / 480                  = 1095
 * annual     0.0001 x 1095 x 100           = 10.95%
 * fees       0.001 x 4                     =  0.004 (0.4% of notional)
 * drag       0.004 x (365 / 30) x 100      =  4.86666667%
 * net        10.95 - 4.86666667            =  6.08333333%
 * ```
 *
 * `null` if either half is unpriceable, so an unusable input can never surface
 * as a `NaN` percentage.
 */
export function netAnnualPct(
  rate: number,
  intervalMinutes: number,
  feeRate: number,
  holdingDays: number,
  legs: number = FUNDING_ROUND_TRIP_LEGS,
): number | null {
  const annual = annualizedPct(rate, intervalMinutes);
  if (annual === null) return null;
  const drag = feeDragAnnualPct(feeRate, holdingDays, legs);
  if (drag === null) return null;
  return round8(annual - drag);
}

/** The minimum a row needs to be priceable. Callers pass richer objects. */
export interface FundingInput {
  symbol: string;
  /** Per-interval funding fraction; positive means the short is paid. */
  rate: number;
  intervalMinutes: number;
}

/** One priced row: the caller's quote plus the three derived percentages. */
export interface FundingOpportunity<T extends FundingInput = FundingInput> {
  /** The input, untouched — extra venue fields ride along to the caller. */
  quote: T;
  symbol: string;
  annualizedPct: number;
  feeDragAnnualPct: number;
  netAnnualPct: number;
}

/**
 * Price and rank every quote, best net annual return first.
 *
 * - **Unpriceable rows are dropped**, not zeroed: "we could not compute this"
 *   and "this pays nothing" are different facts and must not share a value.
 * - **Negative rows are kept.** A deeply negative rate is the headline result of
 *   the scan on the day it happens — it says the market is paying shorts to
 *   stay short — and dropping it would leave the dashboard silently empty in
 *   exactly the conditions worth looking at.
 * - **Ties keep input order** (`Array.prototype.sort` is stable), so two scans
 *   of the same board rank identically.
 *
 * The fee drag is a function of `(feeRate, holdingDays)` alone, so it is the
 * same for every row and ranking by `netAnnualPct` is equivalent to ranking by
 * `annualizedPct`. It is still computed per row: the two only coincide while
 * every symbol is charged the same fee, and the stored figure should be the one
 * that was actually used.
 */
export function rankFundingOpportunities<T extends FundingInput>(
  quotes: Iterable<T>,
  feeRate: number,
  holdingDays: number,
  legs: number = FUNDING_ROUND_TRIP_LEGS,
): Array<FundingOpportunity<T>> {
  const ranked: Array<FundingOpportunity<T>> = [];

  for (const quote of quotes) {
    if (!quote || typeof quote.symbol !== "string" || quote.symbol.length === 0) {
      continue;
    }
    const annual = annualizedPct(quote.rate, quote.intervalMinutes);
    if (annual === null) continue;
    const drag = feeDragAnnualPct(feeRate, holdingDays, legs);
    if (drag === null) continue;

    ranked.push({
      quote,
      symbol: quote.symbol,
      annualizedPct: annual,
      feeDragAnnualPct: drag,
      netAnnualPct: round8(annual - drag),
    });
  }

  return ranked.sort((a, b) => b.netAnnualPct - a.netAnnualPct);
}
