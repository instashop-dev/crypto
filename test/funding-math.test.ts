/**
 * Pure funding-carry math: `src/engine/funding.ts`.
 *
 * Every expectation here is hand-derived from the closed forms in the module
 * docblock — no fixtures, no clock, no I/O. The worked example
 * (0.0001 per 8h, 0.1%/spot leg, 0.05%/perp leg, held 30 days) is the same one
 * the README and the module comments quote, so all three move together or not
 * at all.
 */
import { describe, expect, it } from "vitest";
import {
  annualizedPct,
  DEFAULT_FUNDING_INTERVAL_MINUTES,
  evaluateVenueSpread,
  feeDragAnnualPct,
  FUNDING_PERP_LEGS,
  FUNDING_ROUND_TRIP_LEGS,
  FUNDING_SPOT_LEGS,
  MINUTES_PER_YEAR,
  netAnnualPct,
  periodsPerYear,
  rankFundingOpportunities,
  rankVenueSpreads,
  roundTripFeeFraction,
  VENUE_SPREAD_PERP_LEGS,
  venueSpreadDragAnnualPct,
  type FundingInput,
  type VenueRateQuote,
} from "../src/engine";

/** The worked example, named once. */
const RATE = 0.0001;
const INTERVAL = 480;
/** Spot taker, charged on the buy-spot and sell-spot legs. */
const SPOT_FEE = 0.001;
/** Perp taker, charged on the sell-perp and buy-back legs: half the spot rate. */
const PERP_FEE = 0.0005;
const HOLD_DAYS = 30;
const ANNUAL = 10.95;
/** (2 x 0.001 + 2 x 0.0005) x (365/30) x 100. */
const DRAG = 3.65;
const NET = 7.3;

/**
 * What the same example priced at before the fees were split — the spot rate
 * charged on all four legs. Kept as a named constant because several tests
 * assert the size of the correction, not just the new number.
 */
const SPOT_ONLY_DRAG = 4.86666667;
const SPOT_ONLY_NET = 6.08333333;

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
  it("charges all four legs: in and out, two spot and two perp", () => {
    expect(FUNDING_SPOT_LEGS).toBe(2);
    expect(FUNDING_PERP_LEGS).toBe(2);
    expect(FUNDING_ROUND_TRIP_LEGS).toBe(4);
    // 2 x 0.001 + 2 x 0.0005
    expect(roundTripFeeFraction(SPOT_FEE, PERP_FEE)).toBe(0.003);
    expect(roundTripFeeFraction(0, 0)).toBe(0);
  });

  it("prices the perp legs cheaper than the spot ones", () => {
    // The whole point of the split: charging the spot rate on all four legs
    // costs 0.4% of notional where the real round trip costs 0.3%.
    expect(roundTripFeeFraction(SPOT_FEE, SPOT_FEE)).toBe(0.004);
    expect(roundTripFeeFraction(SPOT_FEE, 0)).toBe(0.002);
    expect(roundTripFeeFraction(0, PERP_FEE)).toBe(0.001);
  });

  it("returns null when either rate is out of range, never a free leg", () => {
    expect(roundTripFeeFraction(1, PERP_FEE)).toBeNull();
    expect(roundTripFeeFraction(SPOT_FEE, 1)).toBeNull();
    expect(roundTripFeeFraction(-0.001, PERP_FEE)).toBeNull();
    expect(roundTripFeeFraction(SPOT_FEE, -0.001)).toBeNull();
    expect(roundTripFeeFraction(Number.NaN, PERP_FEE)).toBeNull();
    expect(roundTripFeeFraction(SPOT_FEE, Number.NaN)).toBeNull();
  });
});

describe("feeDragAnnualPct", () => {
  it("amortises the round trip over the holding period", () => {
    expect(feeDragAnnualPct(SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBe(DRAG);
    // Held a year, the whole round trip is 0.3% of one year's notional.
    expect(feeDragAnnualPct(SPOT_FEE, PERP_FEE, 365)).toBe(0.3);
    // Held a day, the same 0.3% is paid 365 times over.
    expect(feeDragAnnualPct(SPOT_FEE, PERP_FEE, 1)).toBe(109.5);
  });

  it("is a quarter lighter than charging the spot rate on all four legs", () => {
    expect(feeDragAnnualPct(SPOT_FEE, SPOT_FEE, HOLD_DAYS)).toBe(SPOT_ONLY_DRAG);
    // 0.001 of notional per round trip, annualised over 30 days.
    expect(SPOT_ONLY_DRAG - DRAG).toBeCloseTo(0.001 * (365 / 30) * 100, 6);
    expect(DRAG / SPOT_ONLY_DRAG).toBeCloseTo(0.75, 8);
  });

  it("returns null for a non-positive or non-finite holding period", () => {
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(feeDragAnnualPct(SPOT_FEE, PERP_FEE, bad), String(bad)).toBeNull();
    }
  });
});

describe("netAnnualPct", () => {
  it("reproduces the worked example end to end", () => {
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBe(NET);
    expect(ANNUAL - DRAG).toBeCloseTo(NET, 8);
  });

  it("lifts the worked example from 6.08% to 7.30% by pricing the perp legs", () => {
    // The recorded production figure was computed with the spot rate on all
    // four legs; the correction is exactly the two perp legs' overcharge,
    // 2 x (0.001 - 0.0005) of notional, annualised over the 30-day hold.
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, SPOT_FEE, HOLD_DAYS)).toBe(
      SPOT_ONLY_NET,
    );
    expect(NET - SPOT_ONLY_NET).toBeCloseTo(
      2 * (SPOT_FEE - PERP_FEE) * (365 / HOLD_DAYS) * 100,
      6,
    );
  });

  it("keeps more of the carry the longer the position is held", () => {
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, PERP_FEE, 365)).toBe(10.65);
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, PERP_FEE, 1)).toBe(-98.55);
    // The break-even holding period: drag equals the carry. At 0.3% a round
    // trip against 10.95% a year, that is exactly 10 days.
    const breakEven = (0.003 * 365 * 100) / ANNUAL;
    expect(breakEven).toBeCloseTo(10, 8);
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, PERP_FEE, breakEven)).toBeCloseTo(
      0,
      6,
    );
  });

  it("agrees with the holding-period return re-annualised", () => {
    // The whole point of annualising: netAnnual x (days/365) must equal the
    // return actually earned over those days, which is the funding collected
    // less the one round trip of fees.
    const periodNet = (ANNUAL * HOLD_DAYS) / 365 - 0.003 * 100;
    expect((NET * HOLD_DAYS) / 365).toBeCloseTo(periodNet, 8);
    expect(periodNet).toBeCloseTo(0.6, 8);
  });

  it("is interval-agnostic: 4h at half the rate is the same trade", () => {
    expect(netAnnualPct(0.00005, 240, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBe(NET);
    expect(netAnnualPct(0.0000125, 60, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBe(NET);
  });

  it("returns null, never NaN, when either half is unpriceable", () => {
    expect(netAnnualPct(1, INTERVAL, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, 0, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, INTERVAL, 1, PERP_FEE, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, 1, HOLD_DAYS)).toBeNull();
    expect(netAnnualPct(RATE, INTERVAL, SPOT_FEE, PERP_FEE, 0)).toBeNull();
    expect(netAnnualPct(Number.NaN, INTERVAL, SPOT_FEE, PERP_FEE, HOLD_DAYS)).toBeNull();
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
      SPOT_FEE,
      PERP_FEE,
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
      SPOT_FEE,
      PERP_FEE,
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
      SPOT_FEE,
      PERP_FEE,
      HOLD_DAYS,
    );

    // "we could not compute this" and "this pays nothing" must not share a value.
    expect(ranked.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(ranked.every((r) => Number.isFinite(r.netAnnualPct))).toBe(true);
  });

  it("keeps negative rows — they are the finding on the day they happen", () => {
    const ranked = rankFundingOpportunities(
      [quote("SOL", -0.001034), quote("BTC", 0.0001), quote("ADA", -0.00002)],
      SPOT_FEE,
      PERP_FEE,
      HOLD_DAYS,
    );

    expect(ranked.map((r) => r.symbol)).toEqual(["BTC", "ADA", "SOL"]);
    expect(ranked[2].netAnnualPct).toBeLessThan(-100);
    expect(ranked.filter((r) => r.netAnnualPct < 0)).toHaveLength(2);
  });

  it("drops everything when either fee or the holding period is unusable", () => {
    const quotes = [quote("BTC", 0.0001), quote("ETH", 0.00025)];
    expect(rankFundingOpportunities(quotes, 1, PERP_FEE, HOLD_DAYS)).toEqual([]);
    expect(rankFundingOpportunities(quotes, SPOT_FEE, 1, HOLD_DAYS)).toEqual([]);
    expect(rankFundingOpportunities(quotes, SPOT_FEE, PERP_FEE, 0)).toEqual([]);
    expect(rankFundingOpportunities([], SPOT_FEE, PERP_FEE, HOLD_DAYS)).toEqual([]);
  });

  it("assumes 8 hours when a venue does not publish its cadence", () => {
    // Not a preference — it is the industry default, and the annualised figure
    // scales linearly with it, which is why every row carries its provenance.
    expect(DEFAULT_FUNDING_INTERVAL_MINUTES).toBe(480);
    expect(annualizedPct(RATE, DEFAULT_FUNDING_INTERVAL_MINUTES)).toBe(ANNUAL);
  });
});

// ---------------------------------------------------------------------------
// Cross-venue funding spreads (Phase 16)
// ---------------------------------------------------------------------------

/**
 * The venue-spread worked example, hand-derived like everything above:
 *
 * ```
 * short  0.0002 per 8h x 1095 x 100     = 21.90%
 * long   0.0001 per 8h x 1095 x 100     = 10.95%
 * gross                                 = 10.95%
 * drag   4 x 0.0005 x (365 / 30) x 100  =  2.43333333%
 * net                                   =  8.51666667%
 * ```
 */
const SPREAD_DRAG = 2.43333333;
const SPREAD_GROSS = 10.95;
const SPREAD_NET = 8.51666667;

/** One venue's row for one symbol. Cadence defaults to the usual 8 hours. */
function venueRate(
  venue: string,
  symbol: string,
  rate: number,
  intervalMinutes = INTERVAL,
): VenueRateQuote {
  return { venue, symbol, rate, intervalMinutes };
}

describe("venueSpreadDragAnnualPct", () => {
  it("charges four perp legs, and is the carry formula with the perp rate", () => {
    expect(VENUE_SPREAD_PERP_LEGS).toBe(4);
    expect(venueSpreadDragAnnualPct(PERP_FEE, HOLD_DAYS)).toBe(SPREAD_DRAG);
    // Not a second formula: it is feeDragAnnualPct with the perp rate in both
    // positions, because both of this trade's leg classes are perps.
    expect(venueSpreadDragAnnualPct(PERP_FEE, HOLD_DAYS)).toBe(
      feeDragAnnualPct(PERP_FEE, PERP_FEE, HOLD_DAYS),
    );
    // 4 x 0.0005 = 0.2% of notional, whatever the holding period.
    expect(venueSpreadDragAnnualPct(PERP_FEE, 365)).toBe(0.2);
    // ...and strictly cheaper than the carry's, which pays the spot rate twice.
    expect(venueSpreadDragAnnualPct(PERP_FEE, HOLD_DAYS)).toBeLessThan(DRAG);
  });

  it("returns null for an unusable fee or holding period", () => {
    expect(venueSpreadDragAnnualPct(1, HOLD_DAYS)).toBeNull();
    expect(venueSpreadDragAnnualPct(-0.001, HOLD_DAYS)).toBeNull();
    expect(venueSpreadDragAnnualPct(PERP_FEE, 0)).toBeNull();
    expect(venueSpreadDragAnnualPct(PERP_FEE, Number.NaN)).toBeNull();
  });
});

describe("evaluateVenueSpread", () => {
  it("reproduces the worked example, shorting the venue that pays most", () => {
    const spread = evaluateVenueSpread(
      venueRate("okx", "BTC", 0.0001),
      venueRate("bybit", "BTC", 0.0002),
      PERP_FEE,
      HOLD_DAYS,
    )!;

    expect(spread.short.venue).toBe("bybit");
    expect(spread.short.annualizedPct).toBe(21.9);
    expect(spread.long.venue).toBe("okx");
    expect(spread.long.annualizedPct).toBe(ANNUAL);
    expect(spread.grossAnnualPct).toBe(SPREAD_GROSS);
    expect(spread.feeDragAnnualPct).toBe(SPREAD_DRAG);
    expect(spread.netAnnualPct).toBe(SPREAD_NET);

    // The direction is derived, so argument order cannot change the answer.
    const mirrored = evaluateVenueSpread(
      venueRate("bybit", "BTC", 0.0002),
      venueRate("okx", "BTC", 0.0001),
      PERP_FEE,
      HOLD_DAYS,
    )!;
    expect(mirrored.grossAnnualPct).toBe(SPREAD_GROSS);
    expect(mirrored.short.venue).toBe("bybit");
  });

  it("annualises each side on its own cadence BEFORE differencing", () => {
    // Same per-settlement rate, different clocks: 0.0001 every 4h is twice the
    // carry of 0.0001 every 8h.
    const spread = evaluateVenueSpread(
      venueRate("okx", "BTC", 0.0001, 480),
      venueRate("gate", "BTC", 0.0001, 240),
      PERP_FEE,
      HOLD_DAYS,
    )!;

    expect(spread.short.venue).toBe("gate");
    expect(spread.short.annualizedPct).toBe(21.9);
    expect(spread.long.annualizedPct).toBe(ANNUAL);
    expect(spread.grossAnnualPct).toBe(SPREAD_GROSS);
    expect(spread.netAnnualPct).toBe(SPREAD_NET);

    // The wrong order — difference the raw rates, then annualise the difference
    // — reads this pair as perfectly flat. It is the one way to get this
    // quietly wrong, so it is asserted against by name.
    const wrongOrder = annualizedPct(0.0001 - 0.0001, 480);
    expect(wrongOrder).toBe(0);
    expect(spread.grossAnnualPct).not.toBe(wrongOrder);
  });

  it("prices a differential of two negative rates the same way", () => {
    // Nobody is paying the shorts here. Long the venue at -0.0003 (it pays the
    // long 32.85%/yr), short the one at -0.0001 (that short pays 10.95%/yr).
    const spread = evaluateVenueSpread(
      venueRate("kucoin", "SOL", -0.0003),
      venueRate("okx", "SOL", -0.0001),
      PERP_FEE,
      HOLD_DAYS,
    )!;

    expect(spread.long.venue).toBe("kucoin");
    expect(spread.short.venue).toBe("okx");
    expect(spread.grossAnnualPct).toBe(21.9);
    expect(spread.netAnnualPct).toBe(19.46666667);
  });

  it("refuses a same-venue, cross-symbol or unpriceable pair", () => {
    const btc = venueRate("okx", "BTC", 0.0002);

    // A venue against itself is not a spread.
    expect(
      evaluateVenueSpread(btc, venueRate("okx", "BTC", 0.0001), PERP_FEE, HOLD_DAYS),
    ).toBeNull();
    // Two different assets is not one either.
    expect(
      evaluateVenueSpread(btc, venueRate("gate", "ETH", 0.0001), PERP_FEE, HOLD_DAYS),
    ).toBeNull();
    // A rate of 100%+ per settlement is a mis-decoded field, not a market.
    expect(
      evaluateVenueSpread(btc, venueRate("gate", "BTC", 5), PERP_FEE, HOLD_DAYS),
    ).toBeNull();
    // ...and an unusable cadence, or an unusable fee, takes the pair with it.
    expect(
      evaluateVenueSpread(btc, venueRate("gate", "BTC", 0.0001, 0), PERP_FEE, HOLD_DAYS),
    ).toBeNull();
    expect(
      evaluateVenueSpread(btc, venueRate("gate", "BTC", 0.0001), 1, HOLD_DAYS),
    ).toBeNull();
  });
});

describe("rankVenueSpreads", () => {
  const MAJORS = ["BTC", "ETH", "SOL"];

  it("picks the widest pair on a symbol quoted by three venues", () => {
    const spreads = rankVenueSpreads(
      [
        venueRate("bybit", "BTC", 0.00015),
        venueRate("okx", "BTC", 0.0002),
        venueRate("gate", "BTC", 0.0001),
      ],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    // The middle venue appears in neither leg: every other pair is a subset of
    // the (min, max) range, so the widest is the only one worth reporting.
    expect(spreads).toHaveLength(1);
    expect(spreads[0].short.venue).toBe("okx");
    expect(spreads[0].long.venue).toBe("gate");
    expect(spreads[0].grossAnnualPct).toBe(SPREAD_GROSS);
    expect(spreads[0].netAnnualPct).toBe(SPREAD_NET);
  });

  it("never joins a multiplier-prefixed contract to its unprefixed namesake", () => {
    const spreads = rankVenueSpreads(
      [
        venueRate("gate", "1000PEPE", 0.0002),
        venueRate("kucoin", "PEPE", 0.0001),
        // A second venue on the *same* prefixed symbol is a legitimate join.
        venueRate("kucoin", "1000PEPE", 0.0001),
      ],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    // The rate is scale-invariant, so the arithmetic would have survived the
    // join — the identity would not: they are two different contracts, with
    // two different books.
    expect(spreads).toHaveLength(1);
    expect(spreads[0].symbol).toBe("1000PEPE");
    expect(spreads[0].short.venue).toBe("gate");
    expect(spreads[0].long.venue).toBe("kucoin");
    expect(spreads[0].verifiedPair).toBe(false);
  });

  it("flags pairs outside the verified set, and keeps them", () => {
    const spreads = rankVenueSpreads(
      [
        venueRate("okx", "BTC", 0.0002),
        venueRate("gate", "BTC", 0.0001),
        venueRate("gate", "XYZ", 0.0009),
        venueRate("kucoin", "XYZ", 0.0001),
      ],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    const bySymbol = new Map(spreads.map((s) => [s.symbol, s]));
    expect(spreads).toHaveLength(2);
    expect(bySymbol.get("BTC")!.verifiedPair).toBe(true);
    // Same ticker on two venues can be two different projects — reported (the
    // fat tail is why the board is multi-venue) but never claimed as sound.
    expect(bySymbol.get("XYZ")!.verifiedPair).toBe(false);

    // With no verified set at all, nothing is claimed rather than everything.
    expect(
      rankVenueSpreads(
        [venueRate("okx", "BTC", 0.0002), venueRate("gate", "BTC", 0.0001)],
        PERP_FEE,
        HOLD_DAYS,
      ).every((s) => !s.verifiedPair),
    ).toBe(true);
  });

  it("ranks by net differential and skips symbols with one venue", () => {
    const spreads = rankVenueSpreads(
      [
        venueRate("okx", "BTC", 0.0002),
        venueRate("gate", "BTC", 0.0001),
        venueRate("okx", "ETH", 0.0009),
        venueRate("gate", "ETH", 0.0001),
        // One venue only: no second opinion, so no differential.
        venueRate("kucoin", "SOL", 0.0005),
      ],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    expect(spreads.map((s) => s.symbol)).toEqual(["ETH", "BTC"]);
    for (let i = 1; i < spreads.length; i++) {
      expect(spreads[i].netAnnualPct).toBeLessThanOrEqual(spreads[i - 1].netAnnualPct);
    }
    // ETH: (0.0009 - 0.0001) x 1095 x 100 = 87.6% gross.
    expect(spreads[0].grossAnnualPct).toBe(87.6);
  });

  it("emits a zero differential rather than dropping it", () => {
    const spreads = rankVenueSpreads(
      [venueRate("okx", "BTC", 0.0001), venueRate("gate", "BTC", 0.0001)],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    // Two venues agreeing is a measurement, and the fee drag makes the pair
    // trade a guaranteed loss — which is exactly what should be reported.
    expect(spreads).toHaveLength(1);
    expect(spreads[0].grossAnnualPct).toBe(0);
    expect(spreads[0].netAnnualPct).toBe(-SPREAD_DRAG);
    expect(spreads[0].short.venue).not.toBe(spreads[0].long.venue);
  });

  it("keeps the first row per venue and drops unpriceable ones", () => {
    const spreads = rankVenueSpreads(
      [
        // A board carries one row per (venue, symbol); where it does not, input
        // order is the caller's ranking, so first-seen wins.
        venueRate("okx", "BTC", 0.0002),
        venueRate("okx", "BTC", 0.0009),
        venueRate("gate", "BTC", 0.0001),
        // Dropped, not zeroed — which leaves ETH with one usable venue, so ETH
        // produces nothing at all.
        venueRate("okx", "ETH", 5),
        venueRate("gate", "ETH", 0.0001),
      ],
      PERP_FEE,
      HOLD_DAYS,
      MAJORS,
    );

    expect(spreads.map((s) => s.symbol)).toEqual(["BTC"]);
    expect(spreads[0].short.annualizedPct).toBe(21.9);
  });

  it("is deterministic and takes any iterable", () => {
    const rows = [
      venueRate("okx", "BTC", 0.0002),
      venueRate("gate", "BTC", 0.0001),
      venueRate("okx", "ETH", 0.0002),
      venueRate("gate", "ETH", 0.0001),
    ];
    const once = rankVenueSpreads(rows, PERP_FEE, HOLD_DAYS, MAJORS);
    const twice = rankVenueSpreads(rows, PERP_FEE, HOLD_DAYS, MAJORS);
    const fromSet = rankVenueSpreads(new Set(rows), PERP_FEE, HOLD_DAYS, new Set(MAJORS));

    // Ties keep input order, so two reads of one board rank identically.
    expect(once.map((s) => s.symbol)).toEqual(["BTC", "ETH"]);
    expect(twice.map((s) => s.symbol)).toEqual(once.map((s) => s.symbol));
    expect(fromSet.map((s) => s.symbol)).toEqual(once.map((s) => s.symbol));
  });

  it("carries the caller's row through untouched", () => {
    // Extra columns ride along, which is what lets the route project the
    // instrument name and the cadence provenance onto the response.
    const rows = [
      { ...venueRate("okx", "BTC", 0.0002), instrument: "BTC-USDT-SWAP" },
      { ...venueRate("gate", "BTC", 0.0001), instrument: "BTC_USDT" },
    ];
    const [spread] = rankVenueSpreads(rows, PERP_FEE, HOLD_DAYS, ["BTC"]);

    expect(spread.short.quote.instrument).toBe("BTC-USDT-SWAP");
    expect(spread.long.quote.instrument).toBe("BTC_USDT");
    expect(spread.short.quote).toBe(rows[0]);
  });

  it("produces nothing when the drag cannot be priced", () => {
    const rows = [venueRate("okx", "BTC", 0.0002), venueRate("gate", "BTC", 0.0001)];
    expect(rankVenueSpreads(rows, 1, HOLD_DAYS, ["BTC"])).toEqual([]);
    expect(rankVenueSpreads(rows, PERP_FEE, 0, ["BTC"])).toEqual([]);
    expect(rankVenueSpreads([], PERP_FEE, HOLD_DAYS, ["BTC"])).toEqual([]);
  });
});
