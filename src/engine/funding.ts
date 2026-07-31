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
 * given `(rate, intervalMinutes, spotFeeRate, perpFeeRate, holdingDays)`.
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
 * - **Fees are taker fees, one rate per venue class.** The two spot legs are
 *   charged `spotFeeRate` and the two perp legs `perpFeeRate`, because the perp
 *   taker rate is roughly half the spot one (~0.05% vs ~0.1% on the venues this
 *   scanner quotes) and charging the spot rate on all four legs overstated the
 *   drag by a third. Maker rebates, fee tiers and per-symbol schedules are not
 *   modelled: taker on every leg is the conservative assumption.
 * - **A year is 365 days**, and returns are **simple, not compounded** — funding
 *   is assumed withdrawn, not reinvested. Compounding would raise every figure
 *   below and would be the less conservative choice.
 *
 * ## A second strategy lives at the bottom of this file
 *
 * The **cross-venue funding spread** (Phase 16): long one venue's perp, short
 * another venue's perp on the same asset, and collect the *difference* between
 * the two funding streams. It shares this file because it shares the
 * annualisation and the fee helpers above — and it must, or the two would drift.
 * Its own caveats are on {@link rankVenueSpreads}; the boundaries listed above
 * apply to it unchanged, except that it has no spot leg at all.
 */
import { round8 } from "./pricing";

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
 * Spot legs in one round trip: buy the asset on entry, sell it on exit. Charged
 * at the spot taker rate (`fee_rate`).
 */
export const FUNDING_SPOT_LEGS = 2;

/**
 * Perp legs in one round trip: sell the perp on entry, buy it back on exit.
 * Charged at the perp taker rate (`perp_fee_rate`), which is roughly half the
 * spot one.
 */
export const FUNDING_PERP_LEGS = 2;

/**
 * Fee-charging legs in one round trip: buy spot, sell perp, sell spot, buy
 * perp back — 2 spot + 2 perp. Both venues charge on entry *and* on exit, and a
 * carry trade that only counted the entry would look twice as good as it is.
 *
 * The total the README and the dashboard copy quote; the math below never uses
 * it, because the two halves are charged at different rates.
 */
export const FUNDING_ROUND_TRIP_LEGS = FUNDING_SPOT_LEGS + FUNDING_PERP_LEGS;

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
 * Total fee paid to open and close the pair, as a fraction of notional:
 * `2 x spotFeeRate + 2 x perpFeeRate`.
 *
 * The two rates are separate because the two venues charge differently — perp
 * taker is ~0.05% where spot taker is ~0.1%, so a single rate applied to all
 * four legs overstates the cost by a third.
 *
 * Each side is summed linearly — `2 x spotFeeRate`, `2 x perpFeeRate` — rather
 * than compounded as `1 - (1 - rate)^2`: at realistic taker fees the two forms
 * differ in the sixth decimal, and the linear one is what a desk actually
 * quotes. Being marginally the *larger* of the two also keeps the estimate on
 * the conservative side.
 *
 * `null` if either rate is unusable — a missing perp rate must not silently
 * price as a free perp leg.
 */
export function roundTripFeeFraction(
  spotFeeRate: number,
  perpFeeRate: number,
): number | null {
  if (!isValidFee(spotFeeRate) || !isValidFee(perpFeeRate)) return null;
  return round8(spotFeeRate * FUNDING_SPOT_LEGS + perpFeeRate * FUNDING_PERP_LEGS);
}

/**
 * The round-trip fee, spread over a `holdingDays` position and annualised.
 *
 * This is why holding period matters to a carry trade at all: the funding
 * stream accrues per day, the fee is paid once. At 0.1% spot / 0.05% perp the
 * round trip is 0.3% of notional: held for a day it costs 109.5% a year, held
 * for a year, 0.3%.
 */
export function feeDragAnnualPct(
  spotFeeRate: number,
  perpFeeRate: number,
  holdingDays: number,
): number | null {
  if (!Number.isFinite(holdingDays) || holdingDays <= 0) return null;
  const fraction = roundTripFeeFraction(spotFeeRate, perpFeeRate);
  if (fraction === null) return null;
  return round8(fraction * (365 / holdingDays) * 100);
}

/**
 * What the position keeps: the annualised funding less the annualised fee drag.
 *
 * Worked example — rate `0.0001` per 8h, spot fee `0.001`/leg, perp fee
 * `0.0005`/leg, held 30 days:
 *
 * ```
 * periods    525600 / 480                  = 1095
 * annual     0.0001 x 1095 x 100           = 10.95%
 * fees       0.001 x 2 + 0.0005 x 2        =  0.003 (0.3% of notional)
 * drag       0.003 x (365 / 30) x 100      =  3.65%
 * net        10.95 - 3.65                  =  7.30%
 * ```
 *
 * `null` if either half is unpriceable, so an unusable input can never surface
 * as a `NaN` percentage.
 */
export function netAnnualPct(
  rate: number,
  intervalMinutes: number,
  spotFeeRate: number,
  perpFeeRate: number,
  holdingDays: number,
): number | null {
  const annual = annualizedPct(rate, intervalMinutes);
  if (annual === null) return null;
  const drag = feeDragAnnualPct(spotFeeRate, perpFeeRate, holdingDays);
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
 * The fee drag is a function of `(spotFeeRate, perpFeeRate, holdingDays)` alone,
 * so it is the same for every row and ranking by `netAnnualPct` is equivalent to
 * ranking by `annualizedPct`. It is still computed per row: the two only
 * coincide while every symbol is charged the same fees, and the stored figure
 * should be the one that was actually used.
 */
export function rankFundingOpportunities<T extends FundingInput>(
  quotes: Iterable<T>,
  spotFeeRate: number,
  perpFeeRate: number,
  holdingDays: number,
): Array<FundingOpportunity<T>> {
  const ranked: Array<FundingOpportunity<T>> = [];

  for (const quote of quotes) {
    if (!quote || typeof quote.symbol !== "string" || quote.symbol.length === 0) {
      continue;
    }
    const annual = annualizedPct(quote.rate, quote.intervalMinutes);
    if (annual === null) continue;
    const drag = feeDragAnnualPct(spotFeeRate, perpFeeRate, holdingDays);
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

// ---------------------------------------------------------------------------
// Cross-venue funding spreads
// ---------------------------------------------------------------------------

/**
 * Fee-charging legs in one cross-venue spread round trip: **four, all perp**.
 *
 * Long one venue's perp and short another's on entry, and close both on exit.
 * There is no spot leg anywhere in this trade, which is why the drag is
 * {@link feeDragAnnualPct} called with the *perp* rate in both positions rather
 * than a formula of its own — see {@link venueSpreadDragAnnualPct}.
 */
export const VENUE_SPREAD_PERP_LEGS = FUNDING_SPOT_LEGS + FUNDING_PERP_LEGS;

/**
 * The all-perp round trip, annualised over `holdingDays`:
 * `4 x perpFeeRate x (365 / holdingDays) x 100`.
 *
 * Deliberately **not** a second formula. It is {@link feeDragAnnualPct} with
 * `perpFeeRate` substituted for the spot rate, because both of this trade's leg
 * classes are perps — so a change to how a round trip is amortised lands on the
 * carry and on the spread at once, and the two can never quietly disagree.
 *
 * At the shipped 0.05% perp taker rate: 0.2% of notional, which is 2.43%/yr over
 * a 30-day hold. That is the bar a venue differential has to clear before it is
 * worth anything.
 */
export function venueSpreadDragAnnualPct(
  perpFeeRate: number,
  holdingDays: number,
): number | null {
  return feeDragAnnualPct(perpFeeRate, perpFeeRate, holdingDays);
}

/** The minimum a row needs to take part in a spread. Callers pass richer rows. */
export interface VenueRateQuote {
  /** Venue name, e.g. `"okx"`. Compared and echoed; never parsed. */
  venue: string;
  /** Canonical asset symbol, e.g. `"BTC"`. See the join rules below. */
  symbol: string;
  /** Per-interval funding fraction; positive means the short is paid. */
  rate: number;
  intervalMinutes: number;
}

/** One side of a spread: the caller's row plus its own annualisation. */
export interface VenueSpreadLeg<T extends VenueRateQuote = VenueRateQuote> {
  venue: string;
  rate: number;
  intervalMinutes: number;
  /** This venue's rate annualised on **its own** cadence. */
  annualizedPct: number;
  /** The input row, untouched — extra columns ride along to the caller. */
  quote: T;
}

/** One symbol's differential between two venues, priced as an all-perp trade. */
export interface VenueSpread<T extends VenueRateQuote = VenueRateQuote> {
  symbol: string;
  /** The perp **bought**: the venue paying less (or charging more) to be long. */
  long: VenueSpreadLeg<T>;
  /** The perp **sold**: the venue paying the short the most. */
  short: VenueSpreadLeg<T>;
  /** `short.annualizedPct - long.annualizedPct`. Never negative. */
  grossAnnualPct: number;
  /** {@link venueSpreadDragAnnualPct}; identical for every row on a board. */
  feeDragAnnualPct: number;
  /** What the pair keeps: gross less drag. Routinely negative. */
  netAnnualPct: number;
  /**
   * Whether this symbol is one whose identity is known to mean the same asset
   * on both venues. See {@link rankVenueSpreads} — a ticker outside the checked
   * set can be two different projects, and the spread would then be fiction.
   */
  verifiedPair: boolean;
}

/** Reused for the common `verifiedSymbols` default; never mutated. */
const NO_VERIFIED_SYMBOLS: ReadonlySet<string> = new Set<string>();

/**
 * Price one venue pair for one symbol. `null` when the pair cannot be priced.
 *
 * **Annualise first, then difference.** Each side is annualised on *its own*
 * settlement cadence and only then subtracted, because the raw `rate` fields are
 * per-settlement fractions and two venues do not have to settle on the same
 * clock: 0.01% every 4 hours is twice the carry of 0.01% every 8, and
 * differencing the raw numbers would call that pair flat. Getting this backwards
 * is silent — it produces a plausible small number — which is why it has a test
 * of its own asserting the wrong-order result is *not* what comes out.
 *
 * Rejected, all as `null` rather than as a zero:
 *
 * - the two rows are not the **same symbol**, compared as an exact string (see
 *   {@link rankVenueSpreads} for why nothing cleverer is allowed);
 * - the two rows are from the same venue (a venue against itself is not a
 *   spread, and the label would claim a cross-venue trade that is not one);
 * - either side's rate or interval is unusable ({@link annualizedPct});
 * - the fee drag is unpriceable.
 *
 * The direction is derived, not supplied: the higher-annualised venue is always
 * the one shorted, so `grossAnnualPct` is `>= 0` by construction. The mirror
 * trade is the same number negated and is never emitted, exactly as
 * `rankSpreads` drops the provably-losing direction of a spot spread.
 */
export function evaluateVenueSpread<T extends VenueRateQuote>(
  a: T,
  b: T,
  perpFeeRate: number,
  holdingDays: number,
  verifiedSymbols: ReadonlySet<string> = NO_VERIFIED_SYMBOLS,
): VenueSpread<T> | null {
  if (!a || !b) return null;
  if (typeof a.symbol !== "string" || a.symbol.length === 0) return null;
  if (a.symbol !== b.symbol) return null;
  if (!a.venue || !b.venue || a.venue === b.venue) return null;

  const annualA = annualizedPct(a.rate, a.intervalMinutes);
  const annualB = annualizedPct(b.rate, b.intervalMinutes);
  if (annualA === null || annualB === null) return null;

  const drag = venueSpreadDragAnnualPct(perpFeeRate, holdingDays);
  if (drag === null) return null;

  const aIsShort = annualA >= annualB;
  const short: VenueSpreadLeg<T> = {
    venue: aIsShort ? a.venue : b.venue,
    rate: aIsShort ? a.rate : b.rate,
    intervalMinutes: aIsShort ? a.intervalMinutes : b.intervalMinutes,
    annualizedPct: aIsShort ? annualA : annualB,
    quote: aIsShort ? a : b,
  };
  const long: VenueSpreadLeg<T> = {
    venue: aIsShort ? b.venue : a.venue,
    rate: aIsShort ? b.rate : a.rate,
    intervalMinutes: aIsShort ? b.intervalMinutes : a.intervalMinutes,
    annualizedPct: aIsShort ? annualB : annualA,
    quote: aIsShort ? b : a,
  };

  const gross = round8(short.annualizedPct - long.annualizedPct);
  return {
    symbol: a.symbol,
    long,
    short,
    grossAnnualPct: gross,
    feeDragAnnualPct: drag,
    netAnnualPct: round8(gross - drag),
    verifiedPair: verifiedSymbols.has(a.symbol),
  };
}

/**
 * The best venue pair for every symbol quoted by two or more venues, best net
 * differential first.
 *
 * **The join is exact string equality on `symbol`, and nothing else.** That is a
 * rule, not an implementation detail:
 *
 * - **Multiplier-prefixed contracts are distinct symbols.** `1000PEPE` and
 *   `PEPE` are never joined. A funding *rate* is scale-invariant, so the
 *   arithmetic would survive the join — but the join *identity* would not: a
 *   venue may list both, they are separate contracts with separate order books
 *   and separate funding, and pairing them would report a differential between
 *   two things that are not the same instrument. The prefixes are preserved by
 *   the venue parsers (`src/funding.ts`) precisely so this comparison can be
 *   trusted.
 * - **A shared ticker is not a shared asset.** Outside a checked set, the same
 *   three letters are routinely two different projects on two different venues.
 *   Those rows are still emitted — suppressing them would hide the fat tail this
 *   board exists to show — but carry `verifiedPair: false`, and the dashboard
 *   marks them. `verifiedSymbols` is the caller's list of identities it has
 *   actually checked (the shipped one is the 11-asset major set).
 *
 * Within a symbol, **the first row per venue wins**: a board carries one row per
 * `(venue, symbol)` by construction, and where it does not the input order is
 * the caller's ranking, so first-seen is that venue's best-paying row.
 *
 * The pair chosen is `(lowest annualised, highest annualised)`, which is the
 * maximum differential available on that symbol — every other pair is a subset
 * of that range. Ties keep input order, so two scans of one board rank
 * identically.
 *
 * Unpriceable rows are dropped rather than zeroed, and a symbol left with fewer
 * than two venues is skipped: "no second opinion" and "no differential" are
 * different facts.
 *
 * **What this does not model.** The fee drag is the *only* cost here: both legs
 * are perps, so both need margin, and margin on two venues at once is neither
 * free nor modelled. Nor is the risk that only one leg gets liquidated, which is
 * the way this trade actually goes wrong — a delta-neutral pair on paper is two
 * separate margin accounts in practice.
 */
export function rankVenueSpreads<T extends VenueRateQuote>(
  rows: Iterable<T>,
  perpFeeRate: number,
  holdingDays: number,
  verifiedSymbols: Iterable<string> = [],
): Array<VenueSpread<T>> {
  const verified = new Set<string>();
  for (const symbol of verifiedSymbols) {
    if (typeof symbol === "string" && symbol.length > 0) verified.add(symbol);
  }

  // Insertion-ordered, so the output order is a pure function of the input's.
  const bySymbol = new Map<string, Array<{ row: T; annual: number }>>();
  for (const row of rows) {
    if (!row || typeof row.symbol !== "string" || row.symbol.length === 0) continue;
    if (typeof row.venue !== "string" || row.venue.length === 0) continue;

    const annual = annualizedPct(row.rate, row.intervalMinutes);
    if (annual === null) continue;

    const group = bySymbol.get(row.symbol);
    if (!group) {
      bySymbol.set(row.symbol, [{ row, annual }]);
      continue;
    }
    if (group.some((entry) => entry.row.venue === row.venue)) continue;
    group.push({ row, annual });
  }

  const spreads: Array<VenueSpread<T>> = [];
  for (const group of bySymbol.values()) {
    if (group.length < 2) continue;
    // Stable sort, so equal rates keep the board's own order and the two ends
    // are still two different venues.
    const sorted = [...group].sort((x, y) => x.annual - y.annual);
    const spread = evaluateVenueSpread(
      sorted[0].row,
      sorted[sorted.length - 1].row,
      perpFeeRate,
      holdingDays,
      verified,
    );
    if (spread) spreads.push(spread);
  }

  return spreads.sort((x, y) => y.netAnnualPct - x.netAnnualPct);
}
