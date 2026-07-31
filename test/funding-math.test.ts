/**
 * Pure funding-carry math: `src/engine/funding.ts`.
 *
 * Every expectation here is hand-derived from the closed forms in the module
 * docblock — no fixtures, no clock, no I/O. The worked example
 * (0.0001 per 8h, 0.1%/leg, held 30 days) is the same one the README and the
 * module comments quote, so all three move together or not at all.
 */
import { describe, expect, it } from "vitest";
import {
  annualizedPct,
  DEFAULT_FUNDING_INTERVAL_MINUTES,
  feeDragAnnualPct,
  FUNDING_ROUND_TRIP_LEGS,
  MINUTES_PER_YEAR,
  netAnnualPct,
  periodsPerYear,
  rankFundingOpportunities,
  roundTripFeeFraction,
  type FundingInput,
} from "../src/engine";

/** The worked example, named once. */
const RATE = 0.0001;
const INTERVAL = 480;
const FEE = 0.001;
const HOLD_DAYS = 30;
const ANNUAL = 10.95;
const DRAG = 4.86666667;
const NET = 6.08333333;

describe("periodsPerYear", () => {
  it("divides the 365-day year by the settlement cadence", () => {
    expect(periodsPerYear(480)).toBe(1095);
    expect(periodsPerYear(240)).toBe(2190);
    expect(periodsPerYear(60)).toBe(8760);
    expect(MINUTES_PER_YEAR).toBe(525_600);
  });

  it("returns null for an unusable interval rather than Infinity or NaN", () => {
    for (const bad of [0, -480, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(periodsPerYear(bad), String(bad)).toBeNull();
    }
    // Longer than a day is a parsing accident far more often than a product,
    // and the interval divides into every figure downstream.
    expect(periodsPerYear(1440)).toBe(365);
    expect(periodsPerYear(1441)).toBeNull();
    expect(periodsPerYear(10_080)).toBeNull();
  });
});

describe("annualizedPct", () => {
  it("reproduces the worked example", () => {
    expect(annualizedPct(RATE, INTERVAL)).toBe(ANNUAL);
  });

  it("scales linearly with the rate and inversely with the interval", () => {
    expect(annualizedPct(0.0002, 480)).toBe(21.9);
    // Half the rate, half the interval: twice as many settlements of half the
    // size is the same annual figure. A dashboard that showed these two
    // differently would be wrong about which contract pays more.
    expect(annualizedPct(0.00005, 240)).toBe(ANNUAL);
    expect(annualizedPct(0.0001, 60)).toBe(87.6);
  });

  it("carries the sign: a negative rate is a cost, not an absence", () => {
    expect(annualizedPct(-0.0002, 480)).toBe(-21.9);
    expect(annualizedPct(-0.001034, 480)).toBeCloseTo(-113.223, 3);
    expect(annualizedPct(0, 480)).toBe(0);
  });

  it("rejects a magnitude of 1 or more as a mis-decoded field", () => {
    expect(annualizedPct(1, 480)).toBeNull();
    expect(annualizedPct(-1, 480)).toBeNull();
    expect(annualizedPct(12.5, 480)).toBeNull();
    // Just inside the bar is still a (preposterous) rate, and is priced.
    expect(annualizedPct(0.999, 480)).toBeCloseTo(109_390.5, 1);
  });

  it("returns null, never NaN, for non-finite inputs", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(annualizedPct(bad, 480), String(bad)).toBeNull();
      expect(annualizedPct(0.0001, bad), String(bad)).toBeNull();
    }
  });
});

describe("roundTripFeeFraction", () => {
  it("charges all four legs: in and out, on both venues", () => {
    expect(FUNDING_ROUND_TRIP_LEGS).toBe(4);
    expect(roundTripFeeFraction(FEE)).toBe(0.004);
    expect(roundTripFeeFraction(FEE, 2)).toBe(0.002);
    expect(roundTripFeeFraction(0)).toBe(0);
  });

  it("returns null for an out-of-range fee or leg count", () => {
    expect(roundTripFeeFraction(1)).toBeNull();
    expect(roundTripFeeFraction(-0.001)).toBeNull();
    expect(roundTripFeeFraction(Number.NaN)).toBeNull();
    expect(roundTripFeeFraction(FEE, 0)).toBeNull();
  });
});

describe("feeDragAnnualPct", () => {
  it("amortises the round trip over the holding period", () => {
    expect(feeDragAnnualPct(FEE, HOLD_DAYS)).toBe(DRAG);
    // Held a year, the whole round trip is 0.4% of one year's notional.
    expect(feeDragAnnualPct(FEE, 365)).toBe(0.4);
    // Held a day, the same 0.4% is paid 365 times over.
    expect(feeDragAnnualPct(FEE, 1)).toBe(146);
  });

  it("returns null for a non-positive or non-finite holding period", () => {
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(feeDragAnnualPct(FEE, bad), String(bad)).toBeNull();
    }
  });
});

describe("netAnnualPct", () => {
  it("reproduces the worked example end to end", () => {
    expect(netAnnualPct(RATE, INTERVAL, FEE, HOLD_DAYS)).toBe(NET);
    expect(netAnnualPct(RATE, INTERVAL, FEE, HOLD_DAYS)).toBeCloseTo(6, 0);
    expect(ANNUAL - DRAG).toBeCloseTo(NET, 8);
  });

  it("keeps more of the carry the longer the position is held", () => {
    expect(netAnnualPct(RATE, INTERVAL, FEE, 365)).toBe(10.55);
    expect(netAnnualPct(RATE, INTERVAL, FEE, 1)).toBe(-135.05);
    // The break-even holding period: drag equals the carry.
    const breakEven = (0.004 * 365 * 100) / ANNUAL;
    expect(netAnnualPct(RATE, INTERVAL, FEE, breakEven)).toBeCloseTo(0, 6);
  });

  it("agrees with the holding-period return re-annualised", () => {
    // The whole point of annualising: netAnnual x (days/365) must equal the
    // return actually earned over those days, which is the funding collected
    // less the one round trip of fees.
    const periodNet = (ANNUAL * HOLD_DAYS) / 365 - 0.004 * 100;
    expect((NET * HOLD_DAYS) / 365).toBeCloseTo(periodNet, 8);
    expect(periodNet).toBeCloseTo(0.5, 8);
  });

  it("is interval-agnostic: 4h at half the rate is the same trade", () => {
    expect(netAnnualPct(0.00005, 240, FEE, HOLD_DAYS)).toBe(NET);
    expect(netAnnualPct(0.0000125, 60, FEE, HOLD_DAYS)).toBe(NET);
  });

  it("returns null, never NaN, when either half is unpriceable", () => {
    expect(netAnnualPct(1, INTERVAL, FEE, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, 0, FEE, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, INTERVAL, 1, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, INTERVAL, FEE, 0)).toBeNull();
    expect(netAnnualPct(Number.NaN, INTERVAL, FEE, HOLD_DAYS)).toBeNull();
  });
});

describe("rankFundingOpportunities", () => {
  const quote = (symbol: string, rate: number, intervalMinutes = INTERVAL): FundingInput => ({
    symbol,
    rate,
    intervalMinutes,
  });

  it("sorts by net annual return, best first", () => {
    const ranked = rankFundingOpportunities(
      [quote("BTC", 0.0001), quote("ETH", 0.00025), quote("SOL", 0.00005)],
      FEE,
      HOLD_DAYS,
    );

    expect(ranked.map((r) => r.symbol)).toEqual(["ETH", "BTC", "SOL"]);
    expect(ranked[1].annualizedPct).toBe(ANNUAL);
    expect(ranked[1].feeDragAnnualPct).toBe(DRAG);
    expect(ranked[1].netAnnualPct).toBe(NET);
    // The input rides along untouched, so venue fields survive the ranking.
    expect(ranked[1].quote).toEqual(quote("BTC", 0.0001));
  });

  it("keeps ties in input order, so two scans of one board rank identically", () => {
    const ranked = rankFundingOpportunities(
      [quote("ADA", 0.0001), quote("BTC", 0.0001), quote("LTC", 0.0001)],
      FEE,
      HOLD_DAYS,
    );
    expect(ranked.map((r) => r.symbol)).toEqual(["ADA", "BTC", "LTC"]);
  });

  it("drops unpriceable rows instead of scoring them zero", () => {
    const ranked = rankFundingOpportunities(
      [
        quote("BTC", 0.0001),
        quote("BAD", 12),
        quote("ZERO", 0.0001, 0),
        quote("HUGE", 0.0001, 10_080),
        quote("NAN", Number.NaN),
        { symbol: "", rate: 0.0001, intervalMinutes: INTERVAL },
      ],
      FEE,
      HOLD_DAYS,
    );

    // "we could not compute this" and "this pays nothing" must not share a value.
    expect(ranked.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(ranked.every((r) => Number.isFinite(r.netAnnualPct))).toBe(true);
  });

  it("keeps negative rows — they are the finding on the day they happen", () => {
    const ranked = rankFundingOpportunities(
      [quote("SOL", -0.001034), quote("BTC", 0.0001), quote("ADA", -0.00002)],
      FEE,
      HOLD_DAYS,
    );

    expect(ranked.map((r) => r.symbol)).toEqual(["BTC", "ADA", "SOL"]);
    expect(ranked[2].netAnnualPct).toBeLessThan(-100);
    expect(ranked.filter((r) => r.netAnnualPct < 0)).toHaveLength(2);
  });

  it("drops everything when the fee or holding period is unusable", () => {
    const quotes = [quote("BTC", 0.0001), quote("ETH", 0.00025)];
    expect(rankFundingOpportunities(quotes, 1, HOLD_DAYS)).toEqual([]);
    expect(rankFundingOpportunities(quotes, FEE, 0)).toEqual([]);
    expect(rankFundingOpportunities([], FEE, HOLD_DAYS)).toEqual([]);
  });

  it("assumes 8 hours when a venue does not publish its cadence", () => {
    // Not a preference — it is the industry default, and the annualised figure
    // scales linearly with it, which is why every row carries its provenance.
    expect(DEFAULT_FUNDING_INTERVAL_MINUTES).toBe(480);
    expect(annualizedPct(RATE, DEFAULT_FUNDING_INTERVAL_MINUTES)).toBe(ANNUAL);
  });
});
