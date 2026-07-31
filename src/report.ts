/**
 * The 7-day profitability report: `GET /api/report`.
 *
 * This is the acceptance test for the whole rebuild, written down as an
 * endpoint. `docs/profitability-recommendations.md` §6 asks three questions of
 * the recorded data after a soak, and every field below exists to answer one of
 * them:
 *
 * 1. **Realised vs predicted carry error** — did a rate observed at entry
 *    survive being held? (`answers.realizedVsPredictedCarryErrorPct`)
 * 2. **Spread survival rate** — what fraction of cross-exchange spreads outlive
 *    the ~4s collection skew that may have invented them?
 *    (`answers.spreadSurvivalRate`)
 * 3. **Did any strategy clear its break-even over the window?** — the whole
 *    effort's yes/no. (`answers.anyStrategyClearedBreakEven`)
 *
 * Read-only and additive: it writes nothing, changes no strategy path, and
 * every figure in it is derived from rows the scanner had already recorded.
 *
 * ## Three rules this module keeps
 *
 * - **Aggregate in SQL.** A week is ~150k funding rows and ~100k spread rows.
 *   The reductions live in `src/db.ts` and what crosses into this file is a
 *   handful of already-grouped rows. Nothing here loops over a table.
 * - **One fee basis for the whole window.** The funding, cross-venue and basis
 *   figures are recomputed against *today's* settings rather than read from the
 *   stored `net_annual_pct` columns — see the section header in `src/db.ts` for
 *   why (rows written before Phase 13 used a materially different fee model, and
 *   averaging across that boundary describes no fee schedule that ever existed).
 *   `meta.settings` states the basis that was used. The `xchg` section is the
 *   one that does not recompute, and for the opposite reason: `persist_net_pct`
 *   is not a gross figure awaiting a drag, it is a net one, and re-charging it
 *   would double-count the very fees it already paid.
 * - **`null` is "not measured".** An average of no positions is not zero, a
 *   survival rate over no measured spreads is not zero, and a report that said
 *   otherwise would turn "we have no evidence" into "we have evidence of
 *   nothing" — which is the exact mistake the whole repo's NULL convention
 *   exists to prevent.
 */
import { ASSET_UNIVERSE, BASE_ASSET, perpAssets, STRATEGY_CROSS_EXCHANGE } from "./config";
import {
  BASIS_RETENTION_MS,
  getSettings,
  reportBasis,
  reportCarry,
  reportFundingByVenue,
  reportVenueSpreads,
  reportWindow,
  reportXchg,
  reportXchgMedianPersist,
  type ReportBasis,
  type ReportCarry,
  type ReportFundingVenue,
  type ReportVenueSpreads,
  type ReportWindow,
  type ReportXchg,
  type Settings,
} from "./db";
import {
  feeDragAnnualPct,
  MS_PER_DAY,
  round8,
  roundTripFeeFraction,
  venueSpreadDragAnnualPct,
} from "./engine";

/**
 * Longest window the report will serve: 7 days.
 *
 * Not a display choice — it is `FUNDING_RETENTION_MS` and `BASIS_RETENTION_MS`
 * expressed in days. Asking for 30 would silently answer with the 7 days of rate
 * rows that still exist while the position and spread tables (which are never
 * pruned) contributed 30, and the sections would then be describing different
 * windows under one heading. Derived from the constant rather than written as a
 * literal, so the two cannot drift.
 */
export const REPORT_MAX_DAYS = Math.floor(BASIS_RETENTION_MS / MS_PER_DAY);

/** Shortest window: one day. A window of zero has nothing in it by definition. */
export const REPORT_MIN_DAYS = 1;

/** What `?days=` means when it is absent or unparseable. */
export const REPORT_DEFAULT_DAYS = REPORT_MAX_DAYS;

/** A parsed `?days=`: what was asked for, and what will actually be served. */
export interface ReportDays {
  /** The caller's number, `null` when absent or unparseable. */
  requested: number | null;
  /** {@link requested} clamped into `[REPORT_MIN_DAYS, REPORT_MAX_DAYS]`. */
  days: number;
}

/**
 * Clamp `?days=` into `[1, 7]`.
 *
 * **Clamps rather than rejects**, unlike `?strategy=` and `?venue=` on the
 * history routes. Those reject because a silently-ignored filter looks exactly
 * like a strategy that never fires — a wrong answer to the question that was
 * asked. This one is a window size, and `?days=30` still gets a truthful answer
 * about the 7 days that exist; `meta.requestedDays` reports what was asked for
 * beside what was served, so the clamp is visible rather than silent.
 */
export function parseReportDays(raw: string | undefined): ReportDays {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) {
    return { requested: null, days: REPORT_DEFAULT_DAYS };
  }
  const requested = Math.trunc(n);
  return {
    requested,
    days: Math.min(Math.max(requested, REPORT_MIN_DAYS), REPORT_MAX_DAYS),
  };
}

/**
 * The **gross** percentage a two-leg spread must clear to break even on fees:
 * `(1/(1 − fee)² − 1) × 100`.
 *
 * At the shipped 0.1% taker rate this is **0.2003004%** — the figure
 * `test/crossExchange.test.ts` asserts against `evaluateSpread` itself and the
 * one `public/app.js` marks *gross* edges against. The compounded form rather
 * than the linear `2 × fee`, because a spread's two legs are multiplicative: the
 * second leg is charged on what the first one left.
 *
 * **This bar belongs to gross figures only.** Nothing in this report is judged
 * against it: every percentage the `xchg` section reports is a `persist_net_pct`
 * that has already had both legs' fees taken out of it, so comparing one to this
 * number charges the same round trip twice. It is reported in `meta.settings` as
 * the fee basis in force, beside the drags, and used nowhere else here.
 *
 * `null` for an unusable fee rate, so a hand-edited setting cannot put a `NaN`
 * into the response.
 */
export function twoLegBreakEvenPct(feeRate: number): number | null {
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) return null;
  return round8((1 / (1 - feeRate) ** 2 - 1) * 100);
}

/** Which symbols the cross-venue section is computed over. See
 *  {@link reportVenueSpreads} for why it is bounded to the verified majors. */
const VERIFIED_SPREAD_SYMBOLS: readonly string[] = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

/** The funding section: per venue, plus the window's overall best. */
export interface ReportFundingSection {
  venues: ReportFundingVenue[];
  /**
   * The best net annual carry available anywhere in the window: the best gross
   * any venue quoted, less the current drag. `null` when no venue quoted.
   */
  bestNetAnnualPct: number | null;
  /**
   * Polls, summed across venues, whose best row cleared the current bar. `null`
   * when the drag could not be priced — the comparison was never made.
   */
  qualifyingPolls: number | null;
  observations: number;
  /** The drag subtracted from every gross figure in this section. */
  feeDragAnnualPct: number | null;
}

/**
 * The cross-exchange section: `reportXchg` plus the two derived fractions.
 *
 * The two are deliberately different questions about the same column, and
 * neither is the gross fee bar:
 *
 * - {@link survivalRate} — net above **zero**. `persist_net_pct` is already net
 *   of both legs' fees, so zero is where the round trip paid for itself. This is
 *   the break-even, and `answers.spreadSurvivalRate` is this number.
 * - {@link qualifyingRate} — net at or above `xchg_min_profit_pct`, the display
 *   threshold the dashboard flags rows with. Strictly the harder bar, and a
 *   preference rather than an economic fact.
 */
export interface ReportXchgSection extends ReportXchg {
  /** The display threshold {@link qualifyingRate} was taken against. */
  minProfitPct: number;
  /** Fraction of measured rows whose re-priced net was above zero. */
  survivalRate: number | null;
  /** Fraction of measured rows that also cleared {@link minProfitPct}. */
  qualifyingRate: number | null;
  medianPersistNetPct: number | null;
  /** The README decision rule, in one sentence. See {@link xchgVerdict}. */
  verdict: string;
}

/** The cross-venue section: `reportVenueSpreads` plus its net figures. */
export interface ReportVenueSpreadSection extends ReportVenueSpreads {
  /** The all-perp four-leg drag subtracted from the gross figures. */
  feeDragAnnualPct: number | null;
  avgNetAnnualPct: number | null;
  maxNetAnnualPct: number | null;
}

/** Which of the five strategies produced a positive result over the window. */
export interface BreakEvenAnswers {
  /** Best net annual carry, after the current drag, was above zero. */
  funding: boolean;
  /** Closed paper carry positions netted a positive realised P&L. */
  carry: boolean;
  /**
   * At least one re-priced spread was still worth something after fees — i.e.
   * had a `persist_net_pct` above zero. Not the gross two-leg bar: that column
   * has already paid the round trip.
   */
  xchg: boolean;
  /** Best cross-venue differential, after the all-perp drag, was above zero. */
  venueSpreads: boolean;
  /** Best net annual basis was above zero. */
  basis: boolean;
}

/** The §6 acceptance criteria, answered literally. */
export interface ReportAnswers {
  /**
   * (a) Mean `realized_annual_pct − predicted_net_annual_pct` over the
   * positions closed in the window. Negative means entry over-promised, which is
   * the direction `src/engine/funding.ts` predicts. `null` until something has
   * closed.
   */
  realizedVsPredictedCarryErrorPct: number | null;
  /**
   * (b) Fraction of re-priced cross-exchange spreads that were still positive on
   * a later snapshot. `null` when nothing has been re-priced.
   */
  spreadSurvivalRate: number | null;
  /** (c) The whole effort's yes/no, per strategy. */
  anyStrategyClearedBreakEven: BreakEvenAnswers;
}

/** What the window actually covered, and what it was priced with. */
export interface ReportMeta {
  /** What `?days=` asked for; `null` when it was absent or unparseable. */
  requestedDays: number | null;
  /** The clamped window actually used. */
  days: number;
  fromTs: number;
  toTs: number;
  /**
   * Days between the oldest and newest row found in *any* table, which is what
   * the report genuinely observed. Smaller than `days` on a deployment younger
   * than the window; `null` when every table was empty.
   */
  servedDays: number | null;
  /** First/last ts and row count, per table. `null` bounds mean "no rows". */
  covered: {
    fundingRates: ReportWindow;
    basisRates: ReportWindow;
    spreads: ReportWindow;
    closedPositions: ReportWindow;
  };
  /** The fee basis every recomputed figure in this report was priced at. */
  settings: {
    feeRate: number;
    perpFeeRate: number;
    holdDays: number;
    minAnnualPct: number;
    fundingDragAnnualPct: number | null;
    venueSpreadDragAnnualPct: number | null;
    /**
     * The **gross** two-leg fee bar at the current `fee_rate`, stated so a
     * reader can price a gross edge. No figure in this report is judged against
     * it — see {@link twoLegBreakEvenPct}.
     */
    xchgBreakEvenPct: number | null;
    /** The display threshold the `xchg` section's `qualifyingRate` used. */
    minProfitPct: number;
  };
}

export interface Report {
  funding: ReportFundingSection;
  carry: ReportCarry;
  xchg: ReportXchgSection;
  venueSpreads: ReportVenueSpreadSection;
  basis: ReportBasis;
  answers: ReportAnswers;
  meta: ReportMeta;
}

/**
 * The README's cross-exchange decision rule, as a sentence.
 *
 * The rule has been in the README and on the dashboard since Phase 16: *if
 * surviving nets never stay above zero once the round trip is paid, this
 * strategy is display-only.* It has never had a place that actually applied it
 * to the data — a reader had to eyeball a column. This is that place.
 *
 * **The bar is zero, not the gross fee break-even.** `persist_net_pct` is
 * `evaluateSpread`'s output on a later book, already net of both legs' taker
 * fees; holding it against `(1/(1−fee)² − 1) × 100` would charge those legs a
 * second time and condemn a strategy on double-counted costs. So the verdict
 * turns on `survived`, and reports `qualifying` — the same
 * `xchg_min_profit_pct` the dashboard badges rows with — beside it, because "it
 * paid for itself" and "it cleared the threshold we bother to display" are two
 * facts and the string is more useful carrying both.
 *
 * Three outcomes, and the first is not a failure: a window with nothing measured
 * in it says "no evidence yet", which is different from "evidence of nothing"
 * and must not read as a verdict against the strategy.
 */
export function xchgVerdict(
  measured: number,
  survived: number,
  qualifying: number,
  minProfitPct: number,
): string {
  if (measured === 0) {
    return "not measured: no cross-exchange spread in this window has been re-priced yet";
  }
  if (survived === 0) {
    return `display-only: 0 of ${measured} measured spreads survived with positive net`;
  }
  return (
    `${survived} of ${measured} survived;` +
    ` ${qualifying} cleared the ${minProfitPct}% display bar — investigate`
  );
}

/**
 * A ratio that is `null` rather than `0` over an empty denominator — or over a
 * numerator that was itself never measured.
 */
function rate(numerator: number | null, denominator: number): number | null {
  if (numerator === null) return null;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return round8(numerator / denominator);
}

/** `a − b`, propagating `null` — "unpriceable" must not become a number. */
function less(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return round8(a - b);
}

/**
 * Build the report for the `days`-long window ending at `nowTs`.
 *
 * The queries are issued in two waves — `Promise.all` over the independent
 * ones, then the median, which needs the measured count the first wave produced.
 * Concurrency here is not about speed so much as about the read budget being
 * paid once: every one of these is a windowed aggregate, and issuing them
 * serially would hold the request open for the sum rather than the max.
 */
export async function buildReport(
  db: D1Database,
  window: ReportDays,
  nowTs: number = Date.now(),
): Promise<Report> {
  const { days } = window;
  const settings: Settings = await getSettings(db);
  const fromTs = nowTs - days * MS_PER_DAY;
  const toTs = nowTs;

  const fundingDrag = feeDragAnnualPct(
    settings.fee_rate,
    settings.perp_fee_rate,
    settings.funding_hold_days,
  );
  const spreadDrag = venueSpreadDragAnnualPct(
    settings.perp_fee_rate,
    settings.funding_hold_days,
  );
  // The per-row basis drag the basis section applies in SQL: the same
  // `2 x spot + 2 x perp` fraction `feeDragAnnualPct` is built on, handed over
  // un-annualised because each basis row amortises it over its own life.
  const basisFeeFraction = roundTripFeeFraction(settings.fee_rate, settings.perp_fee_rate);
  // Reported in `meta.settings` as the gross fee basis, and judged against
  // nowhere in this report — see {@link twoLegBreakEvenPct}.
  const breakEvenPct = twoLegBreakEvenPct(settings.fee_rate);
  const minAnnualPct = settings.funding_min_annual_pct;
  const minProfitPct = settings.xchg_min_profit_pct;

  const [
    fundingVenues,
    carry,
    xchg,
    venueSpreads,
    basis,
    fundingWindow,
    basisWindow,
    spreadWindow,
    closedWindow,
  ] = await Promise.all([
    // A `null` drag means the stored fee rates are unusable, and it is passed
    // straight through rather than defaulted to `0`. Zero is not a neutral
    // stand-in here: it is the claim that the round trip is free, and every
    // `qualifyingPolls` count taken against it would be inflated by polls that
    // clear the bar only because nobody charged them. The counts come back
    // `null` instead, and `meta.settings.fundingDragAnnualPct` says why.
    reportFundingByVenue(db, fromTs, toTs, fundingDrag, minAnnualPct),
    reportCarry(db, fromTs, toTs),
    // The xchg bar is the display threshold, not a fee bar: `persist_net_pct`
    // has already paid both legs. See {@link ReportXchgSection}.
    reportXchg(db, STRATEGY_CROSS_EXCHANGE, fromTs, toTs, minProfitPct),
    reportVenueSpreads(db, fromTs, toTs, VERIFIED_SPREAD_SYMBOLS, spreadDrag, minAnnualPct),
    reportBasis(db, fromTs, toTs, basisFeeFraction, minAnnualPct),
    reportWindow(db, "funding_rates", "ts", fromTs, toTs),
    reportWindow(db, "basis_rates", "ts", fromTs, toTs),
    reportWindow(db, "opportunities", "ts", fromTs, toTs, STRATEGY_CROSS_EXCHANGE),
    reportWindow(db, "funding_positions", "close_ts", fromTs, toTs),
  ]);

  const medianPersistNetPct = await reportXchgMedianPersist(
    db,
    STRATEGY_CROSS_EXCHANGE,
    fromTs,
    toTs,
    xchg.measured,
  );

  // The best gross any venue quoted in the window, then charged the one drag.
  // `Math.max` over an empty list is `-Infinity`, so the empty case is separated
  // rather than clamped.
  const grossBests = fundingVenues
    .map((v) => v.maxBestAnnualPct)
    .filter((v): v is number => v !== null);
  const bestFundingGross = grossBests.length > 0 ? Math.max(...grossBests) : null;
  const bestFundingNet = less(bestFundingGross, fundingDrag);

  const funding: ReportFundingSection = {
    venues: fundingVenues,
    bestNetAnnualPct: bestFundingNet,
    // A sum of per-venue counts that are themselves `null` when the drag was
    // unpriceable: the total is then unknown too, not zero.
    qualifyingPolls:
      fundingDrag === null
        ? null
        : fundingVenues.reduce((n, v) => n + (v.qualifyingPolls ?? 0), 0),
    observations: fundingVenues.reduce((n, v) => n + v.observations, 0),
    feeDragAnnualPct: fundingDrag,
  };

  const xchgSection: ReportXchgSection = {
    ...xchg,
    minProfitPct,
    survivalRate: rate(xchg.survived, xchg.measured),
    qualifyingRate: rate(xchg.qualifying, xchg.measured),
    medianPersistNetPct,
    verdict: xchgVerdict(xchg.measured, xchg.survived, xchg.qualifying, minProfitPct),
  };

  const venueSpreadSection: ReportVenueSpreadSection = {
    ...venueSpreads,
    feeDragAnnualPct: spreadDrag,
    avgNetAnnualPct: less(venueSpreads.avgGrossAnnualPct, spreadDrag),
    maxNetAnnualPct: less(venueSpreads.maxGrossAnnualPct, spreadDrag),
  };

  const covered = {
    fundingRates: fundingWindow,
    basisRates: basisWindow,
    spreads: spreadWindow,
    closedPositions: closedWindow,
  };
  const firsts = Object.values(covered)
    .map((w) => w.firstTs)
    .filter((v): v is number => v !== null);
  const lasts = Object.values(covered)
    .map((w) => w.lastTs)
    .filter((v): v is number => v !== null);
  const servedDays =
    firsts.length > 0 && lasts.length > 0
      ? round8((Math.max(...lasts) - Math.min(...firsts)) / MS_PER_DAY)
      : null;

  return {
    funding,
    carry,
    xchg: xchgSection,
    venueSpreads: venueSpreadSection,
    basis,
    answers: {
      realizedVsPredictedCarryErrorPct: carry.avgPredictionErrorPct,
      spreadSurvivalRate: xchgSection.survivalRate,
      // Each of the five is "did this strategy end the window ahead of the
      // costs it actually pays", and **all five** are judged against a
      // *fee-aware net* figure above zero — there is no exception. The fee bar
      // is already inside every one of these columns, so the threshold settings
      // (`funding_min_annual_pct`, `xchg_min_profit_pct`) are display
      // preferences and zero is the arithmetic. The `qualifying*` fields beside
      // each section report the threshold question for whoever wants it.
      anyStrategyClearedBreakEven: {
        funding: bestFundingNet !== null && bestFundingNet > 0,
        carry: carry.closedCount > 0 && carry.realizedPnlUsdt > 0,
        // No exception for the spreads either: `persist_net_pct` is already net
        // of both legs' fees, so a single measured row above zero is a spread
        // that outlived the skew *and* paid for itself. Judging this against
        // the gross fee bar would charge the same round trip twice and answer
        // "no" to a strategy that had in fact broken even.
        xchg: xchg.survived > 0,
        venueSpreads:
          venueSpreadSection.maxNetAnnualPct !== null &&
          venueSpreadSection.maxNetAnnualPct > 0,
        basis: basis.maxBestNetAnnualPct !== null && basis.maxBestNetAnnualPct > 0,
      },
    },
    meta: {
      requestedDays: window.requested,
      days,
      fromTs,
      toTs,
      servedDays,
      covered,
      settings: {
        feeRate: settings.fee_rate,
        perpFeeRate: settings.perp_fee_rate,
        holdDays: settings.funding_hold_days,
        minAnnualPct,
        fundingDragAnnualPct: fundingDrag,
        venueSpreadDragAnnualPct: spreadDrag,
        xchgBreakEvenPct: breakEvenPct,
        minProfitPct,
      },
    },
  };
}
