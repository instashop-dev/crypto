/**
 * Paper funding-carry position math: accrual, close rules and realised figures.
 *
 * Where `./funding.ts` prices a carry someone *might* hold, this prices one that
 * is being held. The two halves of the measurement it exists to make are
 * `entry_annualized_pct` — what the rate observed at entry said the year would
 * pay — and {@link realizedFigures}'s `realizedAnnualPct`, which is what the
 * position actually earned over the days it was actually open. Their difference
 * is the extrapolation error `./funding.ts`'s own docblock calls its dominant
 * unknown, measured per position instead of asserted.
 *
 * Pure functions, exactly like `./funding.ts`: no I/O, no clock (every function
 * that needs "now" is handed it), no Workers or Hono imports, no dependency on
 * `src/types.ts` or on the D1 row shapes. The orchestration — reading rate rows,
 * writing positions — lives in `src/scan.ts` and `src/db.ts`.
 *
 * ## Modelling boundaries (read these before believing a number)
 *
 * - **Basis and mark-to-market are not modelled at all.** Entry and exit are
 *   assumed to happen at the same spot price *and* the same perp price, so the
 *   two legs cancel exactly and the position's whole P&L is the funding stream
 *   less fees. That is the same simplification `./funding.ts` makes, carried
 *   forward deliberately: in reality basis convergence is where a carry trade
 *   makes or loses most of its non-funding P&L, and pricing it would need a
 *   spot/perp price pair per venue per poll that this scanner does not collect.
 *   A realised figure here is therefore the *funding* result, not the trade's.
 * - **Everything `./funding.ts` ignores is still ignored**: slippage, depth,
 *   margin, collateral yield and liquidation. The short perp leg needs
 *   collateral, that collateral earns nothing, and an adverse move large enough
 *   to liquidate it is not simulated.
 * - **Only settlements the scanner actually observed are accrued.** A boundary
 *   with no persisted rate row within {@link CARRY_STALE_CLOSE_MS} before it is
 *   *skipped*, not estimated from a neighbouring rate: an unobserved settlement
 *   is missing data, and inventing a payment for it is the one error that would
 *   flatter the realised figure without leaving a trace. `accrualCount` is
 *   stored so the hole is visible.
 * - **The settlement cadence is snapshotted at entry, like the fee rates.** A
 *   position accrues on the `interval_minutes` its entry row carried, for the
 *   whole hold. Venues do change a contract's cadence — 8h to 4h to 1h is a
 *   routine listing-desk decision on a volatile perp — and when one does
 *   mid-hold, this keeps accruing on the *stale* grid: at a shortened cadence
 *   it books fewer settlements than really paid, at a lengthened one it books
 *   boundaries the venue no longer settles on (each priced by whatever row
 *   preceded it, so the error is a count error, not a rate error). The
 *   alternative — re-reading the cadence every pass — makes a position's grid
 *   move under it and re-dates every settlement it already booked, which is
 *   worse: nothing opens on a guessed interval in the first place
 *   (`interval_source = 'api'` only), and a real cadence change is rare enough
 *   to be worth a wrong count on one position rather than a moving grid on all
 *   of them. `entry_annualized_pct` was computed from the same snapshot, so at
 *   least the prediction and the accrual disagree with reality identically.
 * - **Funding is not compounded.** It accumulates in USDT beside the position
 *   and never grows the notional, matching `./funding.ts`'s simple returns.
 * - **The short leg's sign convention is the venue's**: a positive rate means
 *   longs pay shorts, so this position (short perp) *receives*. A negative rate
 *   is a cost and is accrued as a negative number — never dropped, never
 *   absolute-valued.
 */
import { round8 } from "./pricing";
import { periodsPerYear, roundTripFeeFraction } from "./funding";

/** Milliseconds in a day: the unit `funding_hold_days` is quoted in. */
export const MS_PER_DAY = 86_400_000;

/** Days in the year every annualisation here shares, as in `./funding.ts`. */
export const DAYS_PER_YEAR = 365;

/**
 * How long a position may go without a fresh rate before it is closed: 24h.
 *
 * A carry whose venue stopped quoting is not a carry that pays nothing — it is
 * a position nobody can price, and holding it would let it accrue an entry rate
 * that no longer has any evidence behind it. 24 hours is three 8-hour
 * settlements: long enough that a venue being briefly unreachable (or dropping
 * a tail contract off a capped board for a few polls) does not close anything,
 * short enough that a dead venue cannot silently carry a position for a week.
 *
 * The same constant bounds how old a rate row may be to price a settlement
 * boundary, and deliberately so: a rate too stale to keep the position open is
 * too stale to say what one of its settlements paid.
 */
export const CARRY_STALE_CLOSE_MS = 24 * 60 * 60 * 1000;

/**
 * Most settlement boundaries one accrual pass will catch up on: 64.
 *
 * Not a market limit — it is a guard on a loop whose bound comes from a stored
 * timestamp. At the 8-hour default this is three weeks, comfortably past the
 * 7-day `funding_rates` retention window, so every boundary that could still
 * have an observed rate behind it is inside the cap. A larger gap than this has
 * no data to price it anyway and the position closes on staleness instead.
 */
export const MAX_CATCHUP_SETTLEMENTS = 64;

/** Why a position was closed. `'manual'` is the only one no rule produces. */
export type CarryCloseReason =
  | "max_hold"
  | "rate_below_exit"
  | "stale_data"
  | "manual";

/**
 * The settlement boundaries strictly after `lastAccrualTs` and at or before
 * `nowTs`, oldest first.
 *
 * **Where the boundaries fall.** Funding settles on the venue's own schedule,
 * not on the scanner's, so the grid is anchored to `anchorTs` — a point known
 * to be on the venue's schedule, in practice the `next_funding_ts` it published
 * or a boundary this position already accrued on (the caller in `src/scan.ts`
 * picks, and prefers the latter because it cannot change under a running
 * position) — and steps backwards and forwards from it in whole intervals. When
 * there is no such timestamp the grid is anchored to the **epoch** instead, i.e.
 * to whole multiples of the interval since 1970-01-01T00:00Z. For the 8-hour cadence
 * almost every contract uses, epoch multiples land on 00:00 / 08:00 / 16:00 UTC,
 * which is exactly where the venues settle — so the fallback is usually the same
 * grid, and where it is not it is at least a *fixed* one. Anchoring to the
 * position's own entry time was the alternative and is worse: it would give
 * every position a private grid, so two positions on one contract would accrue
 * the same settlement at different moments.
 *
 * The interval is validated through {@link periodsPerYear}, so a junk cadence
 * yields `[]` rather than an infinite grid, and the result is capped at
 * {@link MAX_CATCHUP_SETTLEMENTS}, keeping the **newest** boundaries when a gap
 * is longer than the cap — the old ones are the ones with no rate rows left.
 */
export function settlementBoundaries(
  lastAccrualTs: number,
  nowTs: number,
  intervalMinutes: number,
  anchorTs: number | null = null,
): number[] {
  if (!Number.isFinite(lastAccrualTs) || !Number.isFinite(nowTs)) return [];
  if (periodsPerYear(intervalMinutes) === null) return [];
  if (nowTs <= lastAccrualTs) return [];

  const period = intervalMinutes * 60_000;
  const anchor =
    anchorTs !== null && Number.isFinite(anchorTs) ? anchorTs : 0;

  // The grid is `anchor + k x period` for every integer k, so the boundaries
  // wanted are those with `lastAccrualTs < anchor + k x period <= nowTs`.
  const firstK = Math.floor((lastAccrualTs - anchor) / period) + 1;
  const lastK = Math.floor((nowTs - anchor) / period);
  if (lastK < firstK) return [];

  const from = Math.max(firstK, lastK - MAX_CATCHUP_SETTLEMENTS + 1);
  const out: number[] = [];
  for (let k = from; k <= lastK; k++) out.push(anchor + k * period);
  return out;
}

/**
 * How many settlement boundaries elapsed in `(lastAccrualTs, nowTs]`.
 *
 * The count of {@link settlementBoundaries}, and the number the accrual pass
 * would use if every boundary had a rate behind it. It rarely does — see the
 * module header on skipped boundaries — so this is the *upper bound* on a
 * position's accruals, not the figure stored in `accrual_count`.
 */
export function settlementsCrossed(
  lastAccrualTs: number,
  nowTs: number,
  intervalMinutes: number,
  anchorTs: number | null = null,
): number {
  return settlementBoundaries(lastAccrualTs, nowTs, intervalMinutes, anchorTs)
    .length;
}

/**
 * Funding received by the short perp leg over `settlements` settlements, in
 * USDT: `rate x notional x settlements`.
 *
 * **Sign is the venue's.** A positive rate means longs pay shorts, and this
 * position is short the perp, so it receives — a positive number. A negative
 * rate means it pays, and the return is negative. Neither case is dropped or
 * clamped: a carry that turned into a cost is the finding on the day it happens,
 * exactly as a negative row is on the board.
 *
 * `null` — never `NaN`, never a silent zero — when the inputs cannot price a
 * payment: a non-finite or non-positive notional, a fractional or negative
 * settlement count, or a rate whose magnitude is 1 or more (100% per settlement
 * is a mis-decoded field, the same bar `annualizedPct` holds). "We could not
 * compute this" and "this paid nothing" must not share a value, so the caller
 * skips the boundary rather than booking a zero for it.
 */
export function accrueAmount(
  rate: number,
  notionalUsdt: number,
  settlements: number,
): number | null {
  if (!Number.isFinite(rate) || Math.abs(rate) >= 1) return null;
  if (!Number.isFinite(notionalUsdt) || notionalUsdt <= 0) return null;
  if (!Number.isInteger(settlements) || settlements < 0) return null;
  return round8(rate * notionalUsdt * settlements);
}

/** What {@link shouldClose} needs to know about a position. */
export interface CarryCloseInput {
  entryTs: number;
  /**
   * Timestamp of the freshest funding row observed for this position's
   * `(venue, symbol)`; `null` when none has been seen at all, in which case
   * `entryTs` is the last moment the pair was known to be quoted.
   */
  lastRateTs: number | null;
}

/** The two tunables the close rules read, named without the D1 spelling. */
export interface CarryCloseSettings {
  /** `funding_hold_days`: the planned hold, and the fee-drag horizon. */
  holdDays: number;
  /** `funding_exit_annual_pct`: net annual % below which the carry is over. */
  exitAnnualPct: number;
}

/**
 * Whether to close, and why. `null` means hold.
 *
 * Three rules, in this precedence:
 *
 * 1. **`max_hold`** — `funding_hold_days` have elapsed since entry. This is not
 *    a stop-loss but the horizon the fee drag was amortised over: holding past
 *    it means the position was priced against a round trip it never made.
 * 2. **`stale_data`** — nothing fresh for this `(venue, symbol)` in
 *    {@link CARRY_STALE_CLOSE_MS}. Checked *before* the exit threshold, on
 *    purpose: a percentage carried by a two-day-old row is not a current
 *    judgement about the market, and letting it fire `rate_below_exit` would
 *    label a data outage as a rate collapse.
 * 3. **`rate_below_exit`** — the current net annual carry has fallen below
 *    `funding_exit_annual_pct`. `null` for `currentNetAnnualPct` never triggers
 *    it; "unknown" is not "below".
 *
 * A non-positive or non-finite `holdDays` disables rule 1 rather than closing
 * everything instantly: it is a shared setting whose other job is a divisor, and
 * a fat-fingered zero must not flush the book.
 */
export function shouldClose(
  position: CarryCloseInput,
  currentNetAnnualPct: number | null,
  settings: CarryCloseSettings,
  nowTs: number,
): CarryCloseReason | null {
  const { holdDays, exitAnnualPct } = settings;

  if (Number.isFinite(holdDays) && holdDays > 0 && Number.isFinite(nowTs)) {
    if (nowTs - position.entryTs >= holdDays * MS_PER_DAY) return "max_hold";
  }

  const lastSeen = position.lastRateTs ?? position.entryTs;
  if (Number.isFinite(lastSeen) && nowTs - lastSeen > CARRY_STALE_CLOSE_MS) {
    return "stale_data";
  }

  if (
    currentNetAnnualPct !== null &&
    Number.isFinite(currentNetAnnualPct) &&
    Number.isFinite(exitAnnualPct) &&
    currentNetAnnualPct < exitAnnualPct
  ) {
    return "rate_below_exit";
  }

  return null;
}

/** What {@link realizedFigures} needs to know about a position. */
export interface CarryRealizedInput {
  entryTs: number;
  notionalUsdt: number;
  /** Funding collected so far, signed; see {@link accrueAmount}. */
  accruedFundingUsdt: number;
  /** The two taker rates as snapshotted at entry, not today's settings. */
  spotFeeRate: number;
  perpFeeRate: number;
}

/** A closed position's arithmetic. */
export interface CarryRealized {
  /** The one round trip of fees, in USDT: `notional x (2 spot + 2 perp)`. */
  roundTripFeeUsdt: number;
  /** `accrued − fees`, in USDT. Signed; a carry can and does lose. */
  realizedPnlUsdt: number;
  /** How long it was actually held, in days. */
  holdDays: number;
  /**
   * The realised return, annualised over the **actual** hold — `null` for a
   * hold of zero length, where a percentage return has no meaning at all and
   * any finite answer would be an artefact of the division.
   */
  realizedAnnualPct: number | null;
}

/**
 * Close out the arithmetic: funding collected, less one round trip of fees,
 * annualised over the days the position was actually open.
 *
 * The annualisation is over the **realised** hold, never over
 * `funding_hold_days` — that is the entire point of the pairing this table
 * exists for. `predicted_net_annual_pct` amortised the fees over the *planned*
 * hold; a position closed early on a rate collapse paid the same fees over
 * fewer days, and the realised figure has to say so.
 *
 * Worked example — 1000 USDT notional, 0.0001 per 8h collected for 30 days
 * (90 settlements), spot fee 0.001/leg, perp fee 0.0005/leg:
 *
 * ```
 * accrued    0.0001 x 1000 x 90        =  9.00 USDT
 * fees       1000 x (2x0.001 + 2x0.0005) =  3.00 USDT
 * realised   9.00 - 3.00               =  6.00 USDT
 * annual     (6 / 1000) x (365/30) x 100 =  7.30%     <- the predicted figure
 * ```
 *
 * `null` when the position cannot be priced at all: a non-positive notional, an
 * unusable fee rate, a non-finite accrual or an exit before entry.
 */
export function realizedFigures(
  position: CarryRealizedInput,
  closeTs: number,
): CarryRealized | null {
  const { entryTs, notionalUsdt, accruedFundingUsdt } = position;
  if (!Number.isFinite(notionalUsdt) || notionalUsdt <= 0) return null;
  if (!Number.isFinite(accruedFundingUsdt)) return null;
  if (!Number.isFinite(entryTs) || !Number.isFinite(closeTs)) return null;
  if (closeTs < entryTs) return null;

  const fraction = roundTripFeeFraction(
    position.spotFeeRate,
    position.perpFeeRate,
  );
  if (fraction === null) return null;

  const roundTripFeeUsdt = round8(notionalUsdt * fraction);
  const realizedPnlUsdt = round8(accruedFundingUsdt - roundTripFeeUsdt);
  const holdDays = round8((closeTs - entryTs) / MS_PER_DAY);

  return {
    roundTripFeeUsdt,
    realizedPnlUsdt,
    holdDays,
    realizedAnnualPct:
      holdDays > 0
        ? round8((realizedPnlUsdt / notionalUsdt) * (DAYS_PER_YEAR / holdDays) * 100)
        : null,
  };
}
