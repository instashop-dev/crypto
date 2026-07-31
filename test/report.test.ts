/**
 * `GET /api/report` and the aggregates behind it, against the migrated
 * in-memory D1.
 *
 * Every fixture here is **seeded directly** rather than produced by running
 * scans, and that is the point: the report's job is to reduce a week of
 * recorded rows correctly, so the rows have to be placed at chosen timestamps
 * with chosen values. A scan-driven fixture could not put a row six days in the
 * past, nor write one with the pre-Phase-13 fee model that the current-drag
 * recompute exists to survive.
 *
 * No network and no clock drift: `buildReport` takes `nowTs`, so the whole
 * window is a pure function of the seeded data.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ASSET_UNIVERSE, BASE_ASSET, perpAssets, STRATEGY_CROSS_EXCHANGE } from "../src/config";
import {
  accrueFundingPosition,
  closeFundingPosition,
  ensureSeeded,
  insertBasisRates,
  insertFundingPosition,
  insertFundingRates,
  insertOpportunities,
  insertScan,
  markOpportunityPersistence,
  updateSettings,
  type BasisRateInput,
  type FundingRateInput,
} from "../src/db";
import { feeDragAnnualPct, rankVenueSpreads, venueSpreadDragAnnualPct } from "../src/engine";
import {
  buildReport,
  CARRY_ANSWER_NOTE,
  parseReportDays,
  REPORT_MAX_DAYS,
  twoLegBreakEvenPct,
  VENUE_SPREAD_POPULATION_NOTE,
  xchgVerdict,
  type Report,
} from "../src/report";
import { app } from "../src/index";
import type { Env } from "../src/types";

const DAY_MS = 86_400_000;
const NOW = 1_785_000_000_000;

/** The shipped fee model: 0.1% spot per leg, 0.05% perp per leg, 30-day hold. */
const FUNDING_DRAG = feeDragAnnualPct(0.001, 0.0005, 30)!; // 3.65
const SPREAD_DRAG = venueSpreadDragAnnualPct(0.0005, 30)!; // 2.43333333
const BREAK_EVEN = twoLegBreakEvenPct(0.001)!; // 0.2003004%
/** The shipped `xchg_min_profit_pct`: the *display* bar, not a fee bar. */
const MIN_PROFIT = 0.05;

const ASSETS = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

beforeEach(async () => {
  await ensureSeeded(env.DB);
});

function report(days = REPORT_MAX_DAYS, nowTs = NOW): Promise<Report> {
  return buildReport(env.DB, { requested: days, days }, nowTs);
}

/** A funding row with the boring fields defaulted. */
function fundingRow(overrides: Partial<FundingRateInput> = {}): FundingRateInput {
  const annualizedPct = overrides.annualizedPct ?? 10.95;
  return {
    venue: "okx",
    symbol: "BTC",
    instrument: "BTC-USDT-SWAP",
    rate: 0.0001,
    intervalMinutes: 480,
    intervalSource: "api",
    annualizedPct,
    // Defaults to the *current* fee model, so a test that wants the stale one
    // has to say so out loud.
    netAnnualPct: annualizedPct - FUNDING_DRAG,
    nextFundingTs: null,
    markPrice: null,
    ...overrides,
  };
}

/** A basis row with the boring fields defaulted. */
function basisRow(overrides: Partial<BasisRateInput> = {}): BasisRateInput {
  return {
    venue: "okx",
    symbol: "BTC",
    instrument: "BTC-USD_UM-260925",
    expiryTs: NOW + 90 * DAY_MS,
    daysToExpiry: 90,
    spotPrice: 60_000,
    futurePrice: 61_200,
    priceSource: "mid",
    basisPct: 2,
    annualizedPct: 8.11111111,
    netAnnualPct: 6.89444444,
    ...overrides,
  };
}

/**
 * Seed one cross-exchange spread row and, optionally, its survival measurement.
 *
 * The measurement goes through {@link markOpportunityPersistence} rather than a
 * raw UPDATE so the fixture is written the same way the scanner writes it —
 * including the `WHERE persist_checked_ts IS NULL` guard.
 */
async function seedSpread(
  scanId: number,
  ts: number,
  netPct: number,
  persist: { netPct: number | null; checkedTs: number } | null,
  skewMs: number | null = 4000,
): Promise<number> {
  const [id] = await insertOpportunities(
    env.DB,
    scanId,
    [{ cycle: "BTCUSDT:binance-ws>mexc-rest", grossPct: netPct + 0.2, netPct, legs: [], skewMs }],
    ts,
    STRATEGY_CROSS_EXCHANGE,
  );
  if (persist) {
    await markOpportunityPersistence(env.DB, [
      { id, persistNetPct: persist.netPct, checkedTs: persist.checkedTs },
    ]);
  }
  return id;
}

// ---------------------------------------------------------------------------

describe("parseReportDays", () => {
  it("defaults to the retention window when absent or unparseable", () => {
    expect(REPORT_MAX_DAYS).toBe(7);
    expect(parseReportDays(undefined)).toEqual({ requested: null, days: 7 });
    expect(parseReportDays("")).toEqual({ requested: null, days: 7 });
    expect(parseReportDays("soon")).toEqual({ requested: null, days: 7 });
  });

  it("clamps rather than rejects, and reports what was asked for", () => {
    // `?days=30` still gets a truthful answer about the 7 days that exist —
    // the rate tables are pruned at 7 — and `requested` makes the clamp visible.
    expect(parseReportDays("30")).toEqual({ requested: 30, days: 7 });
    expect(parseReportDays("0")).toEqual({ requested: 0, days: 1 });
    expect(parseReportDays("-5")).toEqual({ requested: -5, days: 1 });
    expect(parseReportDays("3")).toEqual({ requested: 3, days: 3 });
    expect(parseReportDays("3.9")).toEqual({ requested: 3, days: 3 });
  });
});

describe("twoLegBreakEvenPct", () => {
  it("is the same bar evaluateSpread breaks even at, and the dashboard marks", () => {
    // `test/crossExchange.test.ts` proves this is the gross edge at which
    // `evaluateSpread` nets exactly zero, and `public/app.js` computes the same
    // expression for its marker. Three places, one formula.
    expect(twoLegBreakEvenPct(0.001)).toBeCloseTo(0.2003004, 7);
    expect(twoLegBreakEvenPct(0.001)).toBeCloseTo((1 / (1 - 0.001) ** 2 - 1) * 100, 8);
    expect(twoLegBreakEvenPct(0)).toBe(0);
  });

  it("is null for an unusable fee rather than a NaN bar", () => {
    expect(twoLegBreakEvenPct(Number.NaN)).toBeNull();
    expect(twoLegBreakEvenPct(-0.001)).toBeNull();
    expect(twoLegBreakEvenPct(1)).toBeNull();
  });
});

describe("xchgVerdict", () => {
  it("says 'not measured' for an empty window rather than condemning the strategy", () => {
    // "No evidence yet" and "evidence of nothing" are different claims.
    expect(xchgVerdict(0, 0, 0, MIN_PROFIT)).toMatch(/not measured/);
  });

  it("implements the README rule when nothing survived", () => {
    // The bar is zero, not the gross fee break-even: `persist_net_pct` has
    // already paid both legs.
    expect(xchgVerdict(40, 0, 0, MIN_PROFIT)).toBe(
      "display-only: 0 of 40 measured spreads survived with positive net",
    );
  });

  it("carries both the survival count and the display-bar count", () => {
    expect(xchgVerdict(40, 3, 1, MIN_PROFIT)).toBe(
      `3 of 40 survived; 1 cleared the ${MIN_PROFIT}% display bar — investigate`,
    );
  });

  it("is a verdict on survival, not on the display bar", () => {
    // Nothing cleared 0.05%, but two spreads still paid for themselves — which
    // is the question the README rule asks. A verdict driven by the threshold
    // (or by the gross fee bar) would call this display-only on rows that broke
    // even.
    expect(xchgVerdict(40, 2, 0, MIN_PROFIT)).toMatch(/^2 of 40 survived; 0 cleared/);
  });
});

describe("buildReport - an empty database", () => {
  it("answers every section with zeros and nulls, never a false positive", async () => {
    const r = await report();

    expect(r.funding.venues).toEqual([]);
    expect(r.funding.bestNetAnnualPct).toBeNull();
    expect(r.funding.observations).toBe(0);

    expect(r.carry.openCount).toBe(0);
    expect(r.carry.closedCount).toBe(0);
    expect(r.carry.avgPredictionErrorPct).toBeNull();
    expect(r.carry.best).toBeNull();
    expect(r.carry.worst).toBeNull();

    expect(r.xchg.rows).toBe(0);
    expect(r.xchg.measured).toBe(0);
    expect(r.xchg.survivalRate).toBeNull();
    expect(r.xchg.qualifyingRate).toBeNull();
    expect(r.xchg.medianPersistNetPct).toBeNull();
    expect(r.xchg.verdict).toMatch(/not measured/);

    expect(r.venueSpreads.polls).toBe(0);
    expect(r.venueSpreads.maxNetAnnualPct).toBeNull();

    expect(r.basis.polls).toBe(0);
    expect(r.basis.maxBestNetAnnualPct).toBeNull();

    // (a) is a structure even when nothing has happened: an empty book has an
    // empty *population*, and both halves of it say so separately.
    expect(r.answers.realizedVsPredictedCarry).toEqual({
      closedAvgErrorPct: null,
      closedCount: 0,
      closeReasons: {},
      openAvgAccruedVsPredictedPct: null,
      openCount: 0,
      note: CARRY_ANSWER_NOTE,
    });
    expect(r.carry.openMarks).toEqual([]);
    expect(r.carry.closeReasons).toEqual([]);
    expect(r.answers.spreadSurvivalRate).toBeNull();
    expect(r.answers.anyStrategyClearedBreakEven).toEqual({
      funding: false,
      carry: false,
      xchg: false,
      venueSpreads: false,
      basis: false,
    });

    expect(r.meta.servedDays).toBeNull();
    expect(r.meta.covered.fundingRates).toEqual({ firstTs: null, lastTs: null, rows: 0 });
  });
});

describe("buildReport - the funding section", () => {
  beforeEach(async () => {
    // Three polls, two venues. Each poll's best row is what the section reports.
    const polls: Array<[number, number, number]> = [
      // [days ago, okx best annualised, gate best annualised]
      [6, 4, 2],
      [3, 12, 20],
      [1, 8, 6],
    ];
    for (const [daysAgo, okx, gate] of polls) {
      const ts = NOW - daysAgo * DAY_MS;
      await insertFundingRates(
        env.DB,
        null,
        [
          fundingRow({ venue: "okx", symbol: "BTC", annualizedPct: okx }),
          fundingRow({ venue: "okx", symbol: "ETH", annualizedPct: okx - 1 }),
          fundingRow({ venue: "gate", symbol: "BTC", annualizedPct: gate }),
        ],
        ts,
      );
    }
  });

  it("reports each venue's per-poll best, and counts what cleared the bar", async () => {
    const r = await report();

    const okx = r.funding.venues.find((v) => v.venue === "okx")!;
    const gate = r.funding.venues.find((v) => v.venue === "gate")!;

    expect(okx.observations).toBe(6);
    expect(okx.polls).toBe(3);
    // Best per poll: 4, 12, 8 — the ETH rows never win, which is the point of
    // "best per poll" rather than "average row".
    expect(okx.avgBestAnnualPct).toBeCloseTo(8, 6);
    expect(okx.maxBestAnnualPct).toBe(12);
    // Net of the 3.65% drag against a 5% bar: 0.35, 8.35, 4.35 — one poll.
    expect(okx.qualifyingPolls).toBe(1);

    expect(gate.observations).toBe(3);
    expect(gate.maxBestAnnualPct).toBe(20);
    // 2, 20, 6 gross -> -1.65, 16.35, 2.35 net: one poll clears 5%.
    expect(gate.qualifyingPolls).toBe(1);

    // The best carry available anywhere in the window, net of the same drag.
    expect(r.funding.bestNetAnnualPct).toBeCloseTo(20 - FUNDING_DRAG, 6);
    expect(r.funding.feeDragAnnualPct).toBeCloseTo(FUNDING_DRAG, 6);
    expect(r.funding.observations).toBe(9);
    expect(r.funding.qualifyingPolls).toBe(2);
  });

  it("re-prices against the CURRENT drag, not the stored net column", async () => {
    // The whole reason this section reads `annualized_pct`. A row written before
    // Phase 13 charged the spot taker rate on all four legs — a 4.86666667%
    // drag at a 30-day hold — so its stored `net_annual_pct` is ~1.22 lower than
    // the same board would report today. Averaging across that boundary would
    // describe a fee schedule that never existed.
    const staleModelDrag = feeDragAnnualPct(0.001, 0.001, 30)!;
    await insertFundingRates(
      env.DB,
      null,
      [
        fundingRow({
          venue: "kucoin",
          annualizedPct: 30,
          netAnnualPct: 30 - staleModelDrag,
        }),
      ],
      NOW - 5 * DAY_MS,
    );

    const r = await report();
    const kucoin = r.funding.venues.find((v) => v.venue === "kucoin")!;

    expect(staleModelDrag).toBeCloseTo(4.86666667, 6);
    expect(kucoin.maxBestAnnualPct).toBe(30);
    // The report's figure is 30 − 3.65, the drag in force *now* — not the
    // 30 − 4.867 the row was written with.
    expect(r.funding.bestNetAnnualPct).toBeCloseTo(30 - FUNDING_DRAG, 6);
    expect(r.funding.bestNetAnnualPct).not.toBeCloseTo(30 - staleModelDrag, 6);
  });

  it("moves with the settings, because the fee basis is today's", async () => {
    await updateSettings(env.DB, { funding_hold_days: 365 });
    const r = await report();
    // Held a year, the 0.3% round trip is a 0.3% drag rather than 3.65%.
    expect(r.meta.settings.fundingDragAnnualPct).toBeCloseTo(0.3, 6);
    expect(r.funding.bestNetAnnualPct).toBeCloseTo(20 - 0.3, 6);
  });

  it("excludes rows outside the window", async () => {
    await insertFundingRates(
      env.DB,
      null,
      [fundingRow({ venue: "bybit", annualizedPct: 900 })],
      // Nine days ago: inside no window this endpoint will serve.
      NOW - 9 * DAY_MS,
    );

    const seven = await report(7);
    expect(seven.funding.venues.some((v) => v.venue === "bybit")).toBe(false);

    // ...and a 2-day window drops the 6-days-ago poll as well.
    const two = await report(2);
    expect(two.funding.venues.find((v) => v.venue === "okx")!.polls).toBe(1);
  });
});

describe("buildReport - the carry section", () => {
  async function seedPosition(opts: {
    symbol: string;
    entryTs: number;
    predicted: number;
    notional?: number;
    /** Funding booked so far, and over how many settlements. */
    accrued?: { usdt: number; count: number };
    close?: {
      ts: number;
      realizedPnl: number;
      realizedAnnual: number;
      reason?: string;
    };
  }): Promise<number> {
    const id = await insertFundingPosition(env.DB, null, {
      venue: "okx",
      symbol: opts.symbol,
      instrument: `${opts.symbol}-USDT-SWAP`,
      notionalUsdt: opts.notional ?? 1000,
      entryTs: opts.entryTs,
      entryRate: 0.0001,
      entryAnnualizedPct: opts.predicted + 3.65,
      intervalMinutes: 480,
      spotFeeRate: 0.001,
      perpFeeRate: 0.0005,
      predictedNetAnnualPct: opts.predicted,
    });
    if (opts.accrued) {
      await accrueFundingPosition(
        env.DB,
        id,
        opts.accrued.usdt,
        opts.accrued.count,
        opts.entryTs,
      );
    }
    if (opts.close) {
      await closeFundingPosition(env.DB, id, {
        closeTs: opts.close.ts,
        closeReason: opts.close.reason ?? "max_hold",
        realizedPnlUsdt: opts.close.realizedPnl,
        realizedAnnualPct: opts.close.realizedAnnual,
      });
    }
    return id;
  }

  it("aggregates the open book and the window's closes, with best and worst", async () => {
    await seedPosition({ symbol: "BTC", entryTs: NOW - 2 * DAY_MS, predicted: 10 });
    await seedPosition({ symbol: "ETH", entryTs: NOW - DAY_MS, predicted: 8 });
    await seedPosition({
      symbol: "SOL",
      entryTs: NOW - 6 * DAY_MS,
      predicted: 12,
      close: { ts: NOW - 3 * DAY_MS, realizedPnl: 4, realizedAnnual: 9 },
    });
    await seedPosition({
      symbol: "XRP",
      entryTs: NOW - 6 * DAY_MS,
      predicted: 20,
      close: { ts: NOW - 2 * DAY_MS, realizedPnl: -1, realizedAnnual: -3 },
    });

    const r = await report();

    expect(r.carry.openCount).toBe(2);
    expect(r.carry.openNotionalUsdt).toBe(2000);
    expect(r.carry.closedCount).toBe(2);
    expect(r.carry.realizedPnlUsdt).toBe(3);
    expect(r.carry.avgRealizedAnnualPct).toBeCloseTo(3, 6);
    // (9 − 12) and (−3 − 20): the entry figure over-promised on both, which is
    // the direction `src/engine/funding.ts` predicts it will.
    expect(r.carry.avgPredictionErrorPct).toBeCloseTo(-13, 6);
    expect(r.carry.best!.symbol).toBe("SOL");
    expect(r.carry.worst!.symbol).toBe("XRP");

    expect(r.answers.realizedVsPredictedCarry.closedAvgErrorPct).toBeCloseTo(-13, 6);
    expect(r.answers.realizedVsPredictedCarry.closedCount).toBe(2);
    expect(r.answers.realizedVsPredictedCarry.openCount).toBe(2);
    // Realised P&L over the window is positive, so carry cleared its costs.
    expect(r.answers.anyStrategyClearedBreakEven.carry).toBe(true);
  });

  it("windows the closes but not the open book", async () => {
    // A position closed nine days ago is outside every window this serves...
    await seedPosition({
      symbol: "OLD",
      entryTs: NOW - 20 * DAY_MS,
      predicted: 50,
      close: { ts: NOW - 9 * DAY_MS, realizedPnl: 99, realizedAnnual: 99 },
    });
    // ...while a position opened just as long ago and still running is not "in"
    // a window at all: it is simply the book as it stands.
    await seedPosition({ symbol: "LONG", entryTs: NOW - 20 * DAY_MS, predicted: 7 });

    const r = await report();
    expect(r.carry.closedCount).toBe(0);
    expect(r.carry.realizedPnlUsdt).toBe(0);
    expect(r.carry.openCount).toBe(1);
    expect(r.carry.avgPredictionErrorPct).toBeNull();
    expect(r.answers.anyStrategyClearedBreakEven.carry).toBe(false);
  });

  it("marks the open book to date, fee-free, beside the closed mean", async () => {
    // The bias this structure exists for, in one fixture. Two positions closed
    // inside the window — and inside a 7-day window nothing can reach
    // `max_hold` (the planned hold is 30 days), so both closed for adverse
    // reasons. Two more are open and doing fine. A single blended scalar would
    // have reported only the first pair.
    await seedPosition({
      symbol: "SOL",
      entryTs: NOW - 6 * DAY_MS,
      predicted: 12,
      close: {
        ts: NOW - 3 * DAY_MS,
        realizedPnl: -2,
        realizedAnnual: -8,
        reason: "rate_below_exit",
      },
    });
    await seedPosition({
      symbol: "XRP",
      entryTs: NOW - 6 * DAY_MS,
      predicted: 20,
      close: {
        ts: NOW - 2 * DAY_MS,
        realizedPnl: -3,
        realizedAnnual: -12,
        reason: "stale_data",
      },
    });
    // 2 USDT on 1000 over 2 days: (2/1000) x (365/2) x 100 = 36.5%/yr gross.
    await seedPosition({
      symbol: "BTC",
      entryTs: NOW - 2 * DAY_MS,
      predicted: 10,
      accrued: { usdt: 2, count: 6 },
    });
    // 0.5 USDT on 1000 over 1 day: (0.5/1000) x 365 x 100 = 18.25%/yr gross.
    await seedPosition({
      symbol: "ETH",
      entryTs: NOW - DAY_MS,
      predicted: 8,
      accrued: { usdt: 0.5, count: 3 },
    });

    const r = await report();
    const a = r.answers.realizedVsPredictedCarry;

    // The closed half: adverse by construction, and the reasons prove it —
    // there is no `max_hold` in here and there cannot be.
    expect(a.closedCount).toBe(2);
    expect(a.closedAvgErrorPct).toBeCloseTo(((-8 - 12) + (-12 - 20)) / 2, 6);
    expect(a.closeReasons).toEqual({ rate_below_exit: 1, stale_data: 1 });
    expect(a.closeReasons.max_hold).toBeUndefined();

    // The open half: gross accrual annualised over the hold so far. **No fee is
    // charged** — the round trip is paid on exit and neither has exited — so
    // amortising one here would invent a cost over a moving denominator.
    expect(a.openCount).toBe(2);
    expect(a.openAvgAccruedVsPredictedPct).toBeCloseTo(
      ((36.5 - 10) + (18.25 - 8)) / 2,
      6,
    );
    // ...and it is emphatically not the fee-charged figure a closed position
    // would report: 1000 USDT costs 3 USDT of round trip, which over two days
    // would be a −54.75%/yr drag all by itself.
    expect(a.openAvgAccruedVsPredictedPct).toBeGreaterThan(0);
    expect(a.note).toBe(CARRY_ANSWER_NOTE);

    const btc = r.carry.openMarks.find((m) => m.symbol === "BTC")!;
    expect(btc.holdDays).toBeCloseTo(2, 6);
    expect(btc.accruedFundingUsdt).toBe(2);
    expect(btc.accrualCount).toBe(6);
    expect(btc.accruedAnnualPct).toBeCloseTo(36.5, 6);
    expect(btc.predictedNetAnnualPct).toBe(10);
    expect(btc.accruedVsPredictedPct).toBeCloseTo(26.5, 6);
    expect(r.carry.openMarks).toHaveLength(2);

    // The accrual coverage that says whether the closed figures were even
    // measurable: booked settlements against the settlements the hold spanned.
    // Three days at the 8-hour cadence spans 9; a close that booked none of
    // them is a hole in the data, not a carry that paid nothing.
    const below = r.carry.closeReasons.find((c) => c.reason === "rate_below_exit")!;
    expect(below.count).toBe(1);
    expect(below.avgErrorPct).toBeCloseTo(-20, 6);
    expect(below.avgAccrualCount).toBe(0);
    expect(below.avgSpannedSettlements).toBeCloseTo(9, 6);
  });

  it("does not blend the two halves into one number", async () => {
    // An open book that is doing well and a single adverse close. The closed
    // mean must stay negative and the open mark positive; a scalar that
    // averaged them would report a number no position ever experienced.
    await seedPosition({
      symbol: "SOL",
      entryTs: NOW - 5 * DAY_MS,
      predicted: 30,
      close: {
        ts: NOW - 4 * DAY_MS,
        realizedPnl: -3,
        realizedAnnual: -100,
        reason: "stale_data",
      },
    });
    await seedPosition({
      symbol: "BTC",
      entryTs: NOW - 4 * DAY_MS,
      predicted: 10,
      // 4 USDT on 1000 over 4 days: (4/1000) x (365/4) x 100 = 36.5%/yr.
      accrued: { usdt: 4, count: 12 },
    });

    const a = (await report()).answers.realizedVsPredictedCarry;
    expect(a.closedAvgErrorPct).toBeCloseTo(-130, 6);
    expect(a.openAvgAccruedVsPredictedPct).toBeCloseTo(26.5, 6);
    expect(a.closedCount).toBe(1);
    expect(a.openCount).toBe(1);
  });

  it("marks a position entered at the report's own clock as null, not infinity", async () => {
    // A zero-length hold has no annualised return: the divisor is zero and any
    // finite answer would be an artefact of the division.
    await seedPosition({
      symbol: "BTC",
      entryTs: NOW,
      predicted: 10,
      accrued: { usdt: 1, count: 1 },
    });

    const r = await report();
    expect(r.carry.openMarks[0].accruedAnnualPct).toBeNull();
    expect(r.carry.openMarks[0].accruedVsPredictedPct).toBeNull();
    expect(r.answers.realizedVsPredictedCarry.openAvgAccruedVsPredictedPct).toBeNull();
    // The position is still on the book — "unmeasurable" is not "absent".
    expect(r.answers.realizedVsPredictedCarry.openCount).toBe(1);
  });
});

describe("buildReport - the cross-exchange section", () => {
  let scanId = 0;

  beforeEach(async () => {
    scanId = await insertScan(env.DB, "manual", NOW - 5 * DAY_MS);
  });

  it("counts survival and the display bar apart, with the median and a verdict", async () => {
    const ts = NOW - 4 * DAY_MS;
    // Five measured rows: three above zero, of which two also clear 0.05%.
    await seedSpread(scanId, ts, 0.5, { netPct: 0.3, checkedTs: ts + 60_000 }, 4000);
    await seedSpread(scanId, ts, 0.4, { netPct: 0.1, checkedTs: ts + 60_000 }, 3000);
    await seedSpread(scanId, ts, 0.3, { netPct: 0.01, checkedTs: ts + 60_000 }, 5000);
    await seedSpread(scanId, ts, 0.2, { netPct: -0.2, checkedTs: ts + 60_000 }, 6000);
    await seedSpread(scanId, ts, 0.1, { netPct: -0.4, checkedTs: ts + 60_000 }, 2000);
    // One stamped-but-unmeasured row: expired before any snapshot could price it.
    await seedSpread(scanId, ts, 0.9, { netPct: null, checkedTs: ts + 200_000 }, 1000);
    // ...and one never looked at.
    await seedSpread(scanId, ts, 0.8, null, null);

    const r = await report();

    expect(r.xchg.rows).toBe(7);
    expect(r.xchg.measured).toBe(5);
    expect(r.xchg.expiredUnmeasured).toBe(1);
    // Two distinct measures over the same five rows, and neither is the other:
    // survival is `> 0` (the fees are already inside `persist_net_pct`) and
    // qualifying is `>= xchg_min_profit_pct`.
    expect(r.xchg.survived).toBe(3);
    expect(r.xchg.qualifying).toBe(2);
    expect(r.xchg.minProfitPct).toBe(MIN_PROFIT);
    expect(r.xchg.survivalRate).toBeCloseTo(0.6, 8);
    expect(r.xchg.qualifyingRate).toBeCloseTo(0.4, 8);
    // Odd count: the middle of [-0.4, -0.2, 0.01, 0.1, 0.3].
    expect(r.xchg.medianPersistNetPct).toBeCloseTo(0.01, 8);
    expect(r.xchg.maxPersistNetPct).toBeCloseTo(0.3, 8);
    // Skew is recorded on every row that has one, measured or not.
    expect(r.xchg.avgSkewMs).toBeCloseTo((4000 + 3000 + 5000 + 6000 + 2000 + 1000) / 6, 6);
    expect(r.xchg.maxSkewMs).toBe(6000);

    expect(r.xchg.verdict).toBe(
      `3 of 5 survived; 2 cleared the ${MIN_PROFIT}% display bar — investigate`,
    );
    expect(r.answers.spreadSurvivalRate).toBeCloseTo(0.6, 8);
    expect(r.answers.anyStrategyClearedBreakEven.xchg).toBe(true);
  });

  it("counts a spread that paid for itself but stayed under the gross fee bar", async () => {
    // The double-charge this section was built wrong for. 0.1% of surviving net
    // is BELOW the 0.2003% gross two-leg bar and ABOVE zero — and it is a real
    // profit, because `persist_net_pct` already paid both legs. Judging it
    // against the gross figure charges the round trip twice and reports a
    // strategy that broke even as display-only.
    const ts = NOW - 4 * DAY_MS;
    await seedSpread(scanId, ts, 0.5, { netPct: 0.1, checkedTs: ts + 60_000 });

    const r = await report();

    expect(0.1).toBeLessThan(BREAK_EVEN);
    expect(r.xchg.survived).toBe(1);
    expect(r.xchg.survivalRate).toBe(1);
    expect(r.answers.anyStrategyClearedBreakEven.xchg).toBe(true);
    expect(r.xchg.verdict).toMatch(/^1 of 1 survived/);
  });

  it("averages the two middle values for an even count", async () => {
    const ts = NOW - 4 * DAY_MS;
    for (const v of [-0.3, -0.1, 0.1, 0.5]) {
      await seedSpread(scanId, ts, 0.5, { netPct: v, checkedTs: ts + 60_000 });
    }
    const r = await report();
    // (−0.1 + 0.1) / 2 = 0, the textbook median rather than a convenient pick.
    expect(r.xchg.measured).toBe(4);
    expect(r.xchg.medianPersistNetPct).toBe(0);
  });

  it("reads display-only when nothing survived, whatever the display bar says", async () => {
    const ts = NOW - 4 * DAY_MS;
    // A zero net is not a survivor: it paid for itself and made nothing.
    await seedSpread(scanId, ts, 0.5, { netPct: 0, checkedTs: ts + 60_000 });
    await seedSpread(scanId, ts, 0.4, { netPct: -0.1, checkedTs: ts + 60_000 });

    const before = await report();
    expect(before.xchg.survived).toBe(0);
    expect(before.xchg.verdict).toBe(
      "display-only: 0 of 2 measured spreads survived with positive net",
    );
    expect(before.answers.anyStrategyClearedBreakEven.xchg).toBe(false);

    // Neither the display threshold nor the fee rate can change that verdict:
    // it is a statement about the rows, and the rows already paid their fees.
    await updateSettings(env.DB, { xchg_min_profit_pct: -1, fee_rate: 0.0005 });
    const after = await report();
    expect(after.xchg.qualifying).toBe(2);
    expect(after.xchg.survived).toBe(0);
    expect(after.xchg.verdict).toMatch(/^display-only/);
    expect(after.answers.anyStrategyClearedBreakEven.xchg).toBe(false);
  });

  it("moves the qualifying count, and only that, with xchg_min_profit_pct", async () => {
    const ts = NOW - 4 * DAY_MS;
    await seedSpread(scanId, ts, 0.5, { netPct: 0.15, checkedTs: ts + 60_000 });
    await seedSpread(scanId, ts, 0.4, { netPct: 0.02, checkedTs: ts + 60_000 });

    const before = await report();
    expect(before.xchg.survived).toBe(2);
    expect(before.xchg.qualifying).toBe(1);
    expect(before.xchg.qualifyingRate).toBeCloseTo(0.5, 8);

    await updateSettings(env.DB, { xchg_min_profit_pct: 0.01 });
    const after = await report();
    expect(after.xchg.minProfitPct).toBe(0.01);
    expect(after.xchg.qualifying).toBe(2);
    // Survival is a property of the rows, not of a setting.
    expect(after.xchg.survived).toBe(2);
    expect(after.xchg.survivalRate).toBe(1);
  });

  it("still answers survival when the gross fee bar is unpriceable", async () => {
    // `updateSettings` accepts any finite number; only the route validates the
    // range. An unusable `fee_rate` leaves `meta.settings.xchgBreakEvenPct`
    // null — and nothing else in this section moves, because no figure in it is
    // judged against that bar any more.
    const ts = NOW - 4 * DAY_MS;
    await seedSpread(scanId, ts, 0.5, { netPct: 0.001, checkedTs: ts + 60_000 });
    await seedSpread(scanId, ts, 0.4, { netPct: 0, checkedTs: ts + 60_000 });
    await updateSettings(env.DB, { fee_rate: 1 });

    const r = await report();

    expect(r.meta.settings.xchgBreakEvenPct).toBeNull();
    expect(r.xchg.measured).toBe(2);
    expect(r.xchg.survivalRate).toBeCloseTo(0.5, 8);
    expect(r.xchg.qualifying).toBe(0);
    expect(r.answers.anyStrategyClearedBreakEven.xchg).toBe(true);
  });

  it("ignores rows of another strategy and rows outside the window", async () => {
    const ts = NOW - 4 * DAY_MS;
    await seedSpread(scanId, ts, 0.5, { netPct: 0.3, checkedTs: ts + 60_000 });
    await insertOpportunities(
      env.DB,
      scanId,
      [{ cycle: "USDT>BTC>ETH>USDT", grossPct: 1, netPct: 1, legs: [] }],
      ts,
      "triangular",
    );
    await seedSpread(scanId, NOW - 9 * DAY_MS, 0.5, {
      netPct: 5,
      checkedTs: NOW - 9 * DAY_MS,
    });

    const r = await report();
    expect(r.xchg.rows).toBe(1);
    expect(r.xchg.maxPersistNetPct).toBeCloseTo(0.3, 8);
  });
});

describe("buildReport - the cross-venue spread section", () => {
  it("reproduces rankVenueSpreads' gross figure, in SQL, per poll", async () => {
    // The equivalence claim in `reportVenueSpreads`' docblock, pinned. The SQL
    // takes MAX(annualized_pct) − MIN(annualized_pct) within one (ts, symbol);
    // the pure engine annualises each venue on its own cadence and then
    // differences. They must agree, or the report is measuring something else.
    const ts = NOW - 2 * DAY_MS;
    const rows = [
      // BTC on three venues: the widest pair is 18 − 4 = 14.
      fundingRow({ venue: "okx", symbol: "BTC", annualizedPct: 4 }),
      fundingRow({ venue: "gate", symbol: "BTC", annualizedPct: 18 }),
      fundingRow({ venue: "kucoin", symbol: "BTC", annualizedPct: 9 }),
      // ETH on two: 11 − 5 = 6, so BTC is the poll's best.
      fundingRow({ venue: "okx", symbol: "ETH", annualizedPct: 5 }),
      fundingRow({ venue: "gate", symbol: "ETH", annualizedPct: 11 }),
      // SOL on one venue only: no second opinion, no differential.
      fundingRow({ venue: "okx", symbol: "SOL", annualizedPct: 40 }),
    ];
    await insertFundingRates(env.DB, null, rows, ts);

    const r = await report();

    // The same board through the pure engine. `rate` is what the engine
    // annualises, so the fixture's rates are derived from the annual figures to
    // keep the two comparable.
    const engine = rankVenueSpreads(
      rows.map((row) => ({
        venue: row.venue,
        symbol: row.symbol,
        rate: (row.annualizedPct / 100) * (480 / 525_600),
        intervalMinutes: 480,
      })),
      0.0005,
      30,
      ASSETS,
    );

    expect(r.venueSpreads.polls).toBe(1);
    expect(r.venueSpreads.maxGrossAnnualPct).toBeCloseTo(14, 6);
    expect(r.venueSpreads.maxGrossAnnualPct).toBeCloseTo(engine[0].grossAnnualPct, 6);
    expect(r.venueSpreads.maxNetAnnualPct).toBeCloseTo(engine[0].netAnnualPct, 6);
    expect(r.venueSpreads.feeDragAnnualPct).toBeCloseTo(SPREAD_DRAG, 6);
    expect(r.answers.anyStrategyClearedBreakEven.venueSpreads).toBe(true);
  });

  it("averages the best differential per poll and counts the qualifying ones", async () => {
    for (const [daysAgo, low, high] of [
      [5, 1, 3],
      [3, 2, 12],
      [1, 4, 6],
    ] as Array<[number, number, number]>) {
      await insertFundingRates(
        env.DB,
        null,
        [
          fundingRow({ venue: "okx", symbol: "BTC", annualizedPct: low }),
          fundingRow({ venue: "gate", symbol: "BTC", annualizedPct: high }),
        ],
        NOW - daysAgo * DAY_MS,
      );
    }

    const r = await report();
    // Gross per poll: 2, 10, 2 — mean 4.66667, max 10.
    expect(r.venueSpreads.polls).toBe(3);
    expect(r.venueSpreads.avgGrossAnnualPct).toBeCloseTo(4.66666667, 6);
    expect(r.venueSpreads.maxGrossAnnualPct).toBeCloseTo(10, 6);
    expect(r.venueSpreads.avgNetAnnualPct).toBeCloseTo(4.66666667 - SPREAD_DRAG, 6);
    // Net of the 2.43333333% all-perp drag against a 5% bar: only the 10% poll.
    expect(r.venueSpreads.qualifyingPolls).toBe(1);
  });

  it("is bounded to the verified majors, where a shared ticker means one asset", async () => {
    // Outside the majors the same three letters are routinely two different
    // projects on two venues, and a single aggregate cannot carry the
    // `verifiedPair: false` label that `/api/funding` puts on those rows.
    await insertFundingRates(
      env.DB,
      null,
      [
        fundingRow({ venue: "okx", symbol: "SOMECOIN", annualizedPct: 1 }),
        fundingRow({ venue: "gate", symbol: "SOMECOIN", annualizedPct: 900 }),
      ],
      NOW - DAY_MS,
    );

    const r = await report();
    expect(r.venueSpreads.polls).toBe(0);
    expect(r.venueSpreads.maxGrossAnnualPct).toBeNull();

    // ...and the response says so itself, because `GET /api/funding`'s
    // `spreads` *does* show that 899-point differential. A reader looking at a
    // big number on the dashboard and `venueSpreads: false` here has to be able
    // to tell the two populations apart without reading the source.
    expect(r.venueSpreads.symbols).toEqual(ASSETS);
    expect(r.venueSpreads.note).toBe(VENUE_SPREAD_POPULATION_NOTE);
    expect(r.venueSpreads.note).toMatch(/verified majors/);
    expect(r.answers.anyStrategyClearedBreakEven.venueSpreads).toBe(false);
  });
});

describe("buildReport - the basis section", () => {
  it("reports the best net per poll and counts what qualified", async () => {
    await insertBasisRates(
      env.DB,
      null,
      [
        // 8.11% gross over 90 days: less a 1.21666667% drag, 6.89444444% net.
        basisRow({ instrument: "M3", annualizedPct: 8.11111111 }),
        // 7.3% gross over 30 days pays the same 0.3% round trip in a third of
        // the time: 3.65% of drag, so 3.65% net. The near-dated contract
        // out-grosses nothing here and loses on net, which is the whole reason
        // this section cannot read a board-wide drag.
        basisRow({ instrument: "M1", annualizedPct: 7.3, daysToExpiry: 30 }),
      ],
      NOW - 4 * DAY_MS,
    );
    await insertBasisRates(
      env.DB,
      null,
      [basisRow({ instrument: "M3", annualizedPct: 3.71666667 })],
      NOW - DAY_MS,
    );

    const r = await report();

    expect(r.basis.polls).toBe(2);
    expect(r.basis.observations).toBe(3);
    // Best per poll: 6.89444444 and 2.5.
    expect(r.basis.maxBestNetAnnualPct).toBeCloseTo(6.89444444, 6);
    expect(r.basis.avgBestNetAnnualPct).toBeCloseTo((6.89444444 + 2.5) / 2, 6);
    // Against the 5% bar, one of the two polls.
    expect(r.basis.qualifyingPolls).toBe(1);
    expect(r.answers.anyStrategyClearedBreakEven.basis).toBe(true);
  });

  it("re-prices each row against the CURRENT fees, not its stored net column", async () => {
    // The funding section's rule, applied per row because a dated contract
    // amortises its round trip over its own remaining life. The stored net here
    // was priced at a fee schedule nobody charges now; averaging a window across
    // that boundary would describe a fee model that never existed.
    await insertBasisRates(
      env.DB,
      null,
      [
        basisRow({
          annualizedPct: 8.11111111,
          daysToExpiry: 90,
          // As if written when both legs cost 0.1%: 0.004 x (365/90) x 100.
          netAnnualPct: 8.11111111 - 1.62222222,
        }),
      ],
      NOW - DAY_MS,
    );

    const r = await report();
    // 8.11111111 − 0.003 x (365/90) x 100 = 6.89444444, today's drag.
    expect(r.basis.maxBestNetAnnualPct).toBeCloseTo(6.89444444, 6);
    expect(r.basis.maxBestNetAnnualPct).not.toBeCloseTo(8.11111111 - 1.62222222, 6);

    // ...and it moves with the settings, which a stored column cannot.
    await updateSettings(env.DB, { fee_rate: 0.002 });
    const after = await report();
    // (0.002 x 2 + 0.0005 x 2) x (365/90) x 100 = 2.02777778.
    expect(after.basis.maxBestNetAnnualPct).toBeCloseTo(8.11111111 - 2.02777778, 6);
  });

  it("reports nothing rather than free legs when the fees are unusable", async () => {
    await insertBasisRates(env.DB, null, [basisRow({ annualizedPct: 900 })], NOW - DAY_MS);
    await updateSettings(env.DB, { fee_rate: 1 });

    const r = await report();

    // The rows are still counted — they exist — but no net figure can be
    // derived from them, and a 900% gross must not be reported as a net.
    expect(r.basis.observations).toBe(1);
    expect(r.basis.polls).toBe(1);
    expect(r.basis.maxBestNetAnnualPct).toBeNull();
    expect(r.basis.avgBestNetAnnualPct).toBeNull();
    expect(r.basis.qualifyingPolls).toBeNull();
    expect(r.answers.anyStrategyClearedBreakEven.basis).toBe(false);
  });

  it("does not call an all-backwardation window a positive result", async () => {
    await insertBasisRates(
      env.DB,
      null,
      [basisRow({ basisPct: -1, annualizedPct: -4.06, netAnnualPct: -5.27 })],
      NOW - DAY_MS,
    );

    const r = await report();
    // −4.06 gross less the 1.21666667% drag over 90 days.
    expect(r.basis.maxBestNetAnnualPct).toBeCloseTo(-5.27666667, 6);
    expect(r.answers.anyStrategyClearedBreakEven.basis).toBe(false);
  });
});

describe("buildReport - meta", () => {
  it("reports the window asked for beside the one actually covered", async () => {
    await insertFundingRates(env.DB, null, [fundingRow()], NOW - 4 * DAY_MS);
    await insertBasisRates(env.DB, null, [basisRow()], NOW - DAY_MS);

    const r = await buildReport(env.DB, { requested: 30, days: 7 }, NOW);

    expect(r.meta.requestedDays).toBe(30);
    expect(r.meta.days).toBe(7);
    expect(r.meta.fromTs).toBe(NOW - 7 * DAY_MS);
    expect(r.meta.toTs).toBe(NOW);
    // Three days between the oldest and newest row anywhere: a deployment
    // younger than the window says so rather than implying a full week.
    expect(r.meta.servedDays).toBeCloseTo(3, 6);
    expect(r.meta.covered.fundingRates).toEqual({
      firstTs: NOW - 4 * DAY_MS,
      lastTs: NOW - 4 * DAY_MS,
      rows: 1,
    });
    expect(r.meta.covered.basisRates.rows).toBe(1);
    expect(r.meta.covered.spreads.rows).toBe(0);
  });

  it("states the fee basis every recomputed figure was priced at", async () => {
    const r = await report();
    expect(r.meta.settings).toEqual({
      feeRate: 0.001,
      perpFeeRate: 0.0005,
      holdDays: 30,
      minAnnualPct: 5,
      fundingDragAnnualPct: FUNDING_DRAG,
      venueSpreadDragAnnualPct: SPREAD_DRAG,
      xchgBreakEvenPct: BREAK_EVEN,
      minProfitPct: MIN_PROFIT,
    });
  });
});

describe("buildReport - an unpriceable fee drag", () => {
  beforeEach(async () => {
    const ts = NOW - 2 * DAY_MS;
    await insertFundingRates(
      env.DB,
      null,
      [
        fundingRow({ venue: "okx", symbol: "BTC", annualizedPct: 4 }),
        fundingRow({ venue: "gate", symbol: "BTC", annualizedPct: 18 }),
      ],
      ts,
    );
    // `updateSettings` accepts any finite number; only the route range-checks.
    await updateSettings(env.DB, { perp_fee_rate: 1 });
  });

  it("reports the qualifying counts as null, never as zero-fee counts", async () => {
    const r = await report();

    // Both drags are unpriceable, so no comparison against the bar was ever
    // made. Zero would read as "nothing qualified" — a measurement — and would
    // in fact be the *opposite* risk: passing a drag of 0 makes the legs free
    // and inflates the count with polls that only clear the bar unfeed.
    expect(r.meta.settings.fundingDragAnnualPct).toBeNull();
    expect(r.meta.settings.venueSpreadDragAnnualPct).toBeNull();

    expect(r.funding.qualifyingPolls).toBeNull();
    expect(r.funding.venues.every((v) => v.qualifyingPolls === null)).toBe(true);
    expect(r.venueSpreads.qualifyingPolls).toBeNull();
    expect(r.basis.qualifyingPolls).toBeNull();

    // The gross figures survive — they never depended on a fee.
    expect(r.funding.venues.find((v) => v.venue === "gate")!.maxBestAnnualPct).toBe(18);
    expect(r.venueSpreads.maxGrossAnnualPct).toBeCloseTo(14, 6);
    // ...and every net figure is null rather than silently equal to its gross.
    expect(r.funding.bestNetAnnualPct).toBeNull();
    expect(r.venueSpreads.maxNetAnnualPct).toBeNull();
    expect(r.answers.anyStrategyClearedBreakEven.funding).toBe(false);
    expect(r.answers.anyStrategyClearedBreakEven.venueSpreads).toBe(false);
  });
});

describe("GET /api/report", () => {
  function api(path: string) {
    return app.request(path, {}, env as unknown as Env);
  }

  it("serves the whole report with the acceptance answers on it", async () => {
    await insertFundingRates(
      env.DB,
      null,
      [fundingRow({ annualizedPct: 30 })],
      Date.now() - DAY_MS,
    );

    const res = await api("/api/report");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Report & { maxDays: number };
    expect(body.maxDays).toBe(7);
    expect(body.meta.requestedDays).toBeNull();
    expect(body.meta.days).toBe(7);
    expect(Object.keys(body.answers.anyStrategyClearedBreakEven).sort()).toEqual([
      "basis",
      "carry",
      "funding",
      "venueSpreads",
      "xchg",
    ]);
    expect(body.answers.anyStrategyClearedBreakEven.funding).toBe(true);
    expect(body.funding.bestNetAnnualPct).toBeCloseTo(30 - FUNDING_DRAG, 6);
  });

  it("clamps ?days= and says so rather than silently ignoring it", async () => {
    const body = (await (await api("/api/report?days=30")).json()) as Report;
    expect(body.meta.requestedDays).toBe(30);
    expect(body.meta.days).toBe(7);

    const narrow = (await (await api("/api/report?days=2")).json()) as Report;
    expect(narrow.meta.days).toBe(2);

    const junk = (await (await api("/api/report?days=soon")).json()) as Report;
    expect(junk.meta.requestedDays).toBeNull();
    expect(junk.meta.days).toBe(7);
  });

  it("answers 200 on an empty database", async () => {
    const res = await api("/api/report");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Report;
    expect(body.funding.venues).toEqual([]);
    expect(body.xchg.verdict).toMatch(/not measured/);
  });
});
