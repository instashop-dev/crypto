/**
 * Pure carry-position math: `src/engine/carry.ts`.
 *
 * Every expectation is hand-derived from the closed forms in the module
 * docblock — no fixtures, no clock, no I/O. The worked example (1000 USDT
 * notional, 0.0001 per 8h for 30 days, 0.1%/spot leg, 0.05%/perp leg) is
 * deliberately the same trade `test/funding-math.test.ts` prices as a *quote*,
 * so the position's realised 7.30% and the board's predicted 7.30% are the same
 * number arrived at from opposite ends. If those two ever disagree, one of the
 * two modules has drifted.
 */
import { describe, expect, it } from "vitest";
import {
  accrueAmount,
  CARRY_STALE_CLOSE_MS,
  DAYS_PER_YEAR,
  MAX_CATCHUP_SETTLEMENTS,
  MS_PER_DAY,
  realizedFigures,
  settlementBoundaries,
  shouldClose,
} from "../src/engine";

/** The 8-hour cadence almost every linear perp settles on. */
const INTERVAL = 480;
const PERIOD_MS = INTERVAL * 60_000;
const HOUR_MS = 3_600_000;

const NOTIONAL = 1000;
const RATE = 0.0001;
const SPOT_FEE = 0.001;
const PERP_FEE = 0.0005;

/** An arbitrary but fixed epoch-aligned instant, so nothing depends on `now`. */
const T0 = 1_700_000_000_000;

describe("settlementBoundaries", () => {
  it("walks the epoch-aligned grid when the venue publishes no next-funding ts", () => {
    // Anchored at 0, so boundaries are whole multiples of the interval.
    expect(settlementBoundaries(0, PERIOD_MS, INTERVAL)).toEqual([PERIOD_MS]);
    expect(settlementBoundaries(0, 3 * PERIOD_MS, INTERVAL)).toEqual([
      PERIOD_MS,
      2 * PERIOD_MS,
      3 * PERIOD_MS,
    ]);
  });

  it("is half-open: exclusive of the last accrual, inclusive of now", () => {
    // A boundary landing exactly on `now` has settled and is accrued.
    expect(settlementBoundaries(0, PERIOD_MS, INTERVAL)).toHaveLength(1);
    // One millisecond earlier it has not.
    expect(settlementBoundaries(0, PERIOD_MS - 1, INTERVAL)).toEqual([]);
    // And the boundary already accrued is never accrued twice.
    expect(settlementBoundaries(PERIOD_MS, 2 * PERIOD_MS - 1, INTERVAL)).toEqual([]);
  });

  it("anchors to the venue's next-funding timestamp when it has one", () => {
    // Settlements at 01:00, 09:00, 17:00 rather than 00:00, 08:00, 16:00.
    const anchor = HOUR_MS;
    expect(settlementBoundaries(0, 10 * HOUR_MS, INTERVAL, anchor)).toEqual([
      HOUR_MS,
      HOUR_MS + PERIOD_MS,
    ]);
    // The anchor is a *phase*, not a start: boundaries before it are on the
    // same grid, which is what makes a position opened yesterday accrue on the
    // schedule a rate row published today describes.
    expect(settlementBoundaries(-2 * PERIOD_MS, 0, INTERVAL, anchor)).toEqual([
      anchor - 2 * PERIOD_MS,
      anchor - PERIOD_MS,
    ]);
  });

  it("catches up across missed polls, oldest boundary first", () => {
    // Three days of 8-hourly settlements missed in one go: nine boundaries, in
    // the order they settled, so each is priced by its own rate row.
    const boundaries = settlementBoundaries(T0, T0 + 3 * MS_PER_DAY, INTERVAL, T0);
    expect(boundaries).toHaveLength(9);
    expect(boundaries[0]).toBe(T0 + PERIOD_MS);
    expect(boundaries[8]).toBe(T0 + 3 * MS_PER_DAY);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i] - boundaries[i - 1]).toBe(PERIOD_MS);
    }
  });

  it("caps a pathological gap, keeping the newest boundaries", () => {
    const gap = 200 * PERIOD_MS;
    const boundaries = settlementBoundaries(T0, T0 + gap, INTERVAL, T0);

    expect(boundaries).toHaveLength(MAX_CATCHUP_SETTLEMENTS);
    // The newest end is intact; the discarded boundaries are the old ones, which
    // are exactly the ones past the 7-day rate retention window anyway.
    expect(boundaries[boundaries.length - 1]).toBe(T0 + gap);
    expect(boundaries[0]).toBe(
      T0 + gap - (MAX_CATCHUP_SETTLEMENTS - 1) * PERIOD_MS,
    );
  });

  it("scales with the cadence: an hourly contract settles 8x as often", () => {
    expect(settlementBoundaries(0, PERIOD_MS, 60)).toHaveLength(8);
    expect(settlementBoundaries(0, PERIOD_MS, 240)).toHaveLength(2);
  });

  it("returns [] for an unusable interval rather than looping forever", () => {
    for (const bad of [0, -480, Number.NaN, Number.POSITIVE_INFINITY, 10_080]) {
      expect(settlementBoundaries(0, 10 * PERIOD_MS, bad), String(bad)).toEqual([]);
    }
  });

  it("returns [] when time has not moved, or has moved backwards", () => {
    expect(settlementBoundaries(T0, T0, INTERVAL)).toEqual([]);
    expect(settlementBoundaries(T0, T0 - PERIOD_MS, INTERVAL)).toEqual([]);
    expect(settlementBoundaries(Number.NaN, T0, INTERVAL)).toEqual([]);
    expect(settlementBoundaries(T0, Number.NaN, INTERVAL)).toEqual([]);
  });

  it("ignores a non-finite anchor and falls back to the epoch grid", () => {
    expect(settlementBoundaries(0, PERIOD_MS, INTERVAL, Number.NaN)).toEqual([
      PERIOD_MS,
    ]);
  });
});

describe("settlementBoundaries - how many it lists", () => {
  it("counts one boundary per elapsed period, capped at the catch-up limit", () => {
    // The count used to have its own `settlementsCrossed` wrapper; nothing in
    // `src/` ever called it (the accrual pass needs the boundaries themselves,
    // not their number), so the assertions live on the list's length instead.
    expect(settlementBoundaries(0, 3 * PERIOD_MS, INTERVAL)).toHaveLength(3);
    expect(settlementBoundaries(0, PERIOD_MS - 1, INTERVAL)).toHaveLength(0);
    expect(settlementBoundaries(T0, T0 + MS_PER_DAY, INTERVAL, T0)).toHaveLength(3);
    expect(
      settlementBoundaries(T0, T0 + 200 * PERIOD_MS, INTERVAL, T0),
    ).toHaveLength(MAX_CATCHUP_SETTLEMENTS);
  });
});

describe("accrueAmount", () => {
  it("pays the short leg on a positive rate", () => {
    // 0.01% of 1000 USDT, once.
    expect(accrueAmount(RATE, NOTIONAL, 1)).toBe(0.1);
    // 30 days at 8-hourly settlements is 90 of them.
    expect(accrueAmount(RATE, NOTIONAL, 90)).toBe(9);
    expect(accrueAmount(RATE, NOTIONAL, 0)).toBe(0);
  });

  it("charges the short leg on a negative rate — a carry can cost", () => {
    expect(accrueAmount(-RATE, NOTIONAL, 90)).toBe(-9);
    expect(accrueAmount(-0.001034, NOTIONAL, 1)).toBeCloseTo(-1.034, 8);
    // Zero is a real rate that pays nothing, and is not confused with `null`.
    expect(accrueAmount(0, NOTIONAL, 90)).toBe(0);
  });

  it("scales linearly with notional", () => {
    expect(accrueAmount(RATE, 2 * NOTIONAL, 90)).toBe(18);
    expect(accrueAmount(RATE, 1, 90)).toBeCloseTo(0.009, 8);
  });

  it("returns null, never NaN or a silent zero, for unusable input", () => {
    // A rate of 100% per settlement is a mis-decoded field, not a bonanza.
    expect(accrueAmount(1, NOTIONAL, 1)).toBeNull();
    expect(accrueAmount(-1, NOTIONAL, 1)).toBeNull();
    expect(accrueAmount(Number.NaN, NOTIONAL, 1)).toBeNull();
    expect(accrueAmount(RATE, 0, 1)).toBeNull();
    expect(accrueAmount(RATE, -100, 1)).toBeNull();
    expect(accrueAmount(RATE, Number.NaN, 1)).toBeNull();
    // Settlements are a count: half a settlement is a caller error.
    expect(accrueAmount(RATE, NOTIONAL, 1.5)).toBeNull();
    expect(accrueAmount(RATE, NOTIONAL, -1)).toBeNull();
  });
});

describe("shouldClose", () => {
  const settings = { holdDays: 30, exitAnnualPct: 0 };
  const fresh = (nowTs: number) => ({ entryTs: T0, lastRateTs: nowTs });

  it("holds a healthy position", () => {
    const now = T0 + 5 * MS_PER_DAY;
    expect(shouldClose(fresh(now), 12.5, settings, now)).toBeNull();
  });

  it("closes on max_hold the moment the horizon is reached", () => {
    const due = T0 + 30 * MS_PER_DAY;
    expect(shouldClose(fresh(due - 1), 12.5, settings, due - 1)).toBeNull();
    expect(shouldClose(fresh(due), 12.5, settings, due)).toBe("max_hold");
  });

  it("closes below the exit threshold, and holds exactly on it", () => {
    const now = T0 + MS_PER_DAY;
    expect(shouldClose(fresh(now), 0, settings, now)).toBeNull();
    expect(shouldClose(fresh(now), -0.01, settings, now)).toBe("rate_below_exit");
    // The bar is a setting, not a sign test: a positive one closes a position
    // that is still earning, which is what raising it means.
    expect(
      shouldClose(fresh(now), 4, { holdDays: 30, exitAnnualPct: 5 }, now),
    ).toBe("rate_below_exit");
  });

  it("never closes on an unknown current rate — 'unknown' is not 'below'", () => {
    const now = T0 + MS_PER_DAY;
    expect(shouldClose(fresh(now), null, settings, now)).toBeNull();
  });

  it("closes on stale data after a day with nothing fresh", () => {
    const still = T0 + CARRY_STALE_CLOSE_MS;
    expect(shouldClose({ entryTs: T0, lastRateTs: T0 }, null, settings, still)).toBeNull();
    expect(
      shouldClose({ entryTs: T0, lastRateTs: T0 }, null, settings, still + 1),
    ).toBe("stale_data");
  });

  it("measures staleness from entry when no rate has ever been seen", () => {
    const now = T0 + CARRY_STALE_CLOSE_MS + 1;
    expect(shouldClose({ entryTs: T0, lastRateTs: null }, null, settings, now)).toBe(
      "stale_data",
    );
  });

  it("prefers stale_data over rate_below_exit on a two-day-old row", () => {
    // The percentage is real but it is not *current*, and labelling a data
    // outage as a rate collapse would corrupt the close-reason series.
    const now = T0 + 2 * MS_PER_DAY;
    expect(shouldClose({ entryTs: T0, lastRateTs: T0 }, -50, settings, now)).toBe(
      "stale_data",
    );
  });

  it("prefers max_hold over everything else", () => {
    const now = T0 + 30 * MS_PER_DAY;
    expect(shouldClose({ entryTs: T0, lastRateTs: T0 }, -50, settings, now)).toBe(
      "max_hold",
    );
  });

  it("treats an unusable hold horizon as 'no horizon', not 'close now'", () => {
    const now = T0 + 1000 * MS_PER_DAY;
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        shouldClose(fresh(now), 12.5, { holdDays: bad, exitAnnualPct: 0 }, now),
        String(bad),
      ).toBeNull();
    }
  });

  it("ignores a non-finite exit threshold rather than closing on it", () => {
    const now = T0 + MS_PER_DAY;
    expect(
      shouldClose(fresh(now), -50, { holdDays: 30, exitAnnualPct: Number.NaN }, now),
    ).toBeNull();
  });
});

describe("realizedFigures", () => {
  const position = {
    entryTs: T0,
    notionalUsdt: NOTIONAL,
    accruedFundingUsdt: 9,
    spotFeeRate: SPOT_FEE,
    perpFeeRate: PERP_FEE,
  };

  it("reproduces the worked example, and agrees with the board's prediction", () => {
    const out = realizedFigures(position, T0 + 30 * MS_PER_DAY)!;

    // 1000 x (2 x 0.001 + 2 x 0.0005)
    expect(out.roundTripFeeUsdt).toBe(3);
    expect(out.realizedPnlUsdt).toBe(6);
    expect(out.holdDays).toBe(30);
    // The same 7.30% `netAnnualPct(0.0001, 480, 0.001, 0.0005, 30)` predicts.
    expect(out.realizedAnnualPct).toBeCloseTo(7.3, 8);
  });

  it("annualises over the ACTUAL hold, not the planned one", () => {
    // Same funding collected, closed at half the horizon: the one round trip of
    // fees is spread over 15 days instead of 30, so the annualised figure is
    // twice the size. Amortising over `funding_hold_days` here would report the
    // prediction back as if it were the outcome.
    const out = realizedFigures(position, T0 + 15 * MS_PER_DAY)!;
    expect(out.holdDays).toBe(15);
    expect(out.realizedPnlUsdt).toBe(6);
    expect(out.realizedAnnualPct).toBeCloseTo((6 / NOTIONAL) * (365 / 15) * 100, 8);
    expect(out.realizedAnnualPct).toBeCloseTo(14.6, 8);
  });

  it("reports the loss when the funding did not cover the round trip", () => {
    const out = realizedFigures(
      { ...position, accruedFundingUsdt: 0.5 },
      T0 + 10 * MS_PER_DAY,
    )!;
    expect(out.realizedPnlUsdt).toBe(-2.5);
    expect(out.realizedAnnualPct).toBeCloseTo(-9.125, 8);
  });

  it("carries a negative accrual through: shorts pay when funding flips", () => {
    const out = realizedFigures(
      { ...position, accruedFundingUsdt: -9 },
      T0 + 30 * MS_PER_DAY,
    )!;
    expect(out.realizedPnlUsdt).toBe(-12);
    expect(out.realizedAnnualPct).toBeCloseTo(-14.6, 8);
  });

  it("leaves the annualised figure null on an instant close", () => {
    const out = realizedFigures({ ...position, accruedFundingUsdt: 0 }, T0)!;
    expect(out.holdDays).toBe(0);
    // The fees were still paid — a position opened and closed in one instant
    // costs the round trip and earns nothing.
    expect(out.realizedPnlUsdt).toBe(-3);
    // But a percentage return over no time at all is a division artefact, not a
    // measurement, so it is absent rather than infinite.
    expect(out.realizedAnnualPct).toBeNull();
  });

  it("charges the perp legs at the snapshotted perp rate", () => {
    // The same position priced as if all four legs were spot: 0.4% not 0.3%.
    const out = realizedFigures(
      { ...position, perpFeeRate: SPOT_FEE },
      T0 + 30 * MS_PER_DAY,
    )!;
    expect(out.roundTripFeeUsdt).toBe(4);
    expect(out.realizedPnlUsdt).toBe(5);
  });

  it("returns null when the position cannot be priced at all", () => {
    expect(realizedFigures({ ...position, notionalUsdt: 0 }, T0 + MS_PER_DAY)).toBeNull();
    expect(
      realizedFigures({ ...position, notionalUsdt: Number.NaN }, T0 + MS_PER_DAY),
    ).toBeNull();
    expect(realizedFigures({ ...position, spotFeeRate: 1 }, T0 + MS_PER_DAY)).toBeNull();
    expect(realizedFigures({ ...position, perpFeeRate: -1 }, T0 + MS_PER_DAY)).toBeNull();
    expect(
      realizedFigures({ ...position, accruedFundingUsdt: Number.NaN }, T0 + MS_PER_DAY),
    ).toBeNull();
    // Closing before entry is not a zero-length hold, it is nonsense.
    expect(realizedFigures(position, T0 - 1)).toBeNull();
  });

  it("shares its year with the rest of the engine", () => {
    expect(DAYS_PER_YEAR).toBe(365);
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(CARRY_STALE_CLOSE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
