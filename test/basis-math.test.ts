/**
 * Dated-futures basis math: `src/engine/basis.ts`.
 *
 * Pure functions, so no D1, no `fetchMock` and no clock — `nowTs` is always an
 * argument. Every worked example below is arithmetic a reader can check by hand,
 * which is the point: this is the file that decides whether a number on the
 * dashboard means anything.
 */
import { describe, expect, it } from "vitest";
import {
  annualizedBasisPct,
  basisDragAnnualPct,
  basisPct,
  daysToExpiry,
  evaluateBasis,
  feeDragAnnualPct,
  MIN_DAYS_TO_EXPIRY,
  rankBasisOpportunities,
  type BasisInput,
} from "../src/engine";

const DAY_MS = 86_400_000;
const NOW = 1_785_500_000_000;

/** The shipped taker rates: 0.1% spot per leg, 0.05% futures per leg. */
const SPOT_FEE = 0.001;
const PERP_FEE = 0.0005;

function contract(overrides: Partial<BasisInput> = {}): BasisInput {
  return {
    symbol: "BTC",
    instrument: "BTC-USD_UM-260925",
    expiryTs: NOW + 90 * DAY_MS,
    spotPrice: 60_000,
    futurePrice: 61_200,
    ...overrides,
  };
}

describe("daysToExpiry", () => {
  it("counts the remaining life in days", () => {
    expect(daysToExpiry(NOW + 90 * DAY_MS, NOW)).toBe(90);
    expect(daysToExpiry(NOW + 1.5 * DAY_MS, NOW)).toBe(1.5);
  });

  it("refuses a contract that has already settled", () => {
    expect(daysToExpiry(NOW - DAY_MS, NOW)).toBeNull();
    // Exactly at expiry is past it: there is no carry left to earn.
    expect(daysToExpiry(NOW, NOW)).toBeNull();
  });

  it("refuses a contract inside the one-day floor", () => {
    // The divisor guard, and it is a whole day. An hour out, the multiplier is
    // 8760x: a 0.05% mismark — well inside a thin far-dated book, and exactly
    // what the `last`-price fallback produces — annualises to +438%/yr and
    // sorts straight to the top of a board ranked by net.
    expect(MIN_DAYS_TO_EXPIRY).toBe(1);
    expect(daysToExpiry(NOW + 10 * 60_000, NOW)).toBeNull();
    expect(daysToExpiry(NOW + 60 * 60_000, NOW)).toBeNull();
    expect(daysToExpiry(NOW + 23 * 3_600_000, NOW)).toBeNull();
    // Exactly at the floor is kept: the guard is `< 1 day`, not `<= 1 day`.
    expect(daysToExpiry(NOW + MIN_DAYS_TO_EXPIRY * DAY_MS, NOW)).toBeCloseTo(
      MIN_DAYS_TO_EXPIRY,
      8,
    );
  });

  it("returns null rather than NaN for unusable timestamps", () => {
    expect(daysToExpiry(Number.NaN, NOW)).toBeNull();
    expect(daysToExpiry(NOW + DAY_MS, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("basisPct", () => {
  it("is the future's premium over spot, in percent", () => {
    expect(basisPct(61_200, 60_000)).toBe(2);
    expect(basisPct(60_000, 60_000)).toBe(0);
  });

  it("keeps backwardation as a negative number rather than clamping it", () => {
    // A future below spot is a real observation — the reverse carry is what
    // harvests it — and zeroing it would hide the market state worth seeing.
    expect(basisPct(59_400, 60_000)).toBe(-1);
  });

  it("refuses a non-positive or unusable price on either leg", () => {
    expect(basisPct(61_200, 0)).toBeNull();
    expect(basisPct(0, 60_000)).toBeNull();
    expect(basisPct(-1, 60_000)).toBeNull();
    expect(basisPct(Number.NaN, 60_000)).toBeNull();
  });
});

describe("annualizedBasisPct", () => {
  it("scales the basis by how fast it is earned", () => {
    // The same 2% is worth four times as much over 90 days as over 365.
    expect(annualizedBasisPct(2, 365)).toBeCloseTo(2, 8);
    expect(annualizedBasisPct(2, 90)).toBeCloseTo(8.11111111, 6);
    expect(annualizedBasisPct(2, 30)).toBeCloseTo(24.33333333, 6);
  });

  it("carries the sign of a backwardated basis through", () => {
    expect(annualizedBasisPct(-1, 90)).toBeCloseTo(-4.05555556, 6);
  });

  it("refuses a horizon inside the floor", () => {
    expect(annualizedBasisPct(2, 0)).toBeNull();
    expect(annualizedBasisPct(2, -30)).toBeNull();
    expect(annualizedBasisPct(2, MIN_DAYS_TO_EXPIRY / 2)).toBeNull();
  });
});

describe("basisDragAnnualPct", () => {
  it("is the perp carry's own fee helper, called with the contract's life", () => {
    // Not a second formula: the four legs and their amortisation are shared
    // with `feeDragAnnualPct`, so the two strategies cannot drift apart.
    expect(basisDragAnnualPct(SPOT_FEE, PERP_FEE, 90)).toBe(
      feeDragAnnualPct(SPOT_FEE, PERP_FEE, 90),
    );
    // 0.1% x 2 + 0.05% x 2 = 0.3% of notional, over 90 days: 1.21666667%/yr.
    expect(basisDragAnnualPct(SPOT_FEE, PERP_FEE, 90)).toBeCloseTo(1.21666667, 6);
  });

  it("refuses an unusable fee rate rather than pricing a free leg", () => {
    expect(basisDragAnnualPct(SPOT_FEE, Number.NaN, 90)).toBeNull();
    expect(basisDragAnnualPct(-0.001, PERP_FEE, 90)).toBeNull();
  });
});

describe("evaluateBasis", () => {
  it("prices a worked example end to end", () => {
    // BTC 90 days out at a 2% premium, shipped fees:
    //   basis      61200 / 60000 - 1        =  2%
    //   annual     2 x (365 / 90)           =  8.11111111%
    //   drag       0.003 x (365 / 90) x 100 =  1.21666667%
    //   net        8.11111111 - 1.21666667  =  6.89444444%
    const priced = evaluateBasis(contract(), SPOT_FEE, PERP_FEE, NOW);

    expect(priced).not.toBeNull();
    expect(priced!.daysToExpiry).toBe(90);
    expect(priced!.basisPct).toBe(2);
    expect(priced!.annualizedPct).toBeCloseTo(8.11111111, 6);
    expect(priced!.feeDragAnnualPct).toBeCloseTo(1.21666667, 6);
    expect(priced!.netAnnualPct).toBeCloseTo(6.89444444, 6);
    // The input rides along untouched, so venue columns reach the caller.
    expect(priced!.quote).toEqual(contract());
  });

  it("prices backwardation as a negative net rather than dropping it", () => {
    const priced = evaluateBasis(
      contract({ futurePrice: 59_400 }),
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );
    expect(priced!.basisPct).toBe(-1);
    expect(priced!.annualizedPct).toBeCloseTo(-4.05555556, 6);
    // Fees make a losing trade worse, not better: the drag is always subtracted.
    expect(priced!.netAnnualPct).toBeCloseTo(-5.27222222, 6);
  });

  it("charges an expiring contract far more drag than a distant one", () => {
    const near = evaluateBasis(
      contract({ expiryTs: NOW + 3 * DAY_MS, futurePrice: 60_120 }),
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );
    // A 0.2% basis over 3 days annualises to 24.33% and looks excellent...
    expect(near!.annualizedPct).toBeCloseTo(24.33333333, 6);
    // ...until the 0.3% round trip is amortised over those same 3 days.
    expect(near!.feeDragAnnualPct).toBeCloseTo(36.5, 6);
    expect(near!.netAnnualPct).toBeCloseTo(-12.16666667, 6);
  });

  it("drops a contract inside a day of settlement rather than annualising it", () => {
    // The exclusion the floor exists for. 60030/60000 is a 0.05% premium — the
    // width of a rounding error on a thin book — and an hour from settlement it
    // annualises to +438%/yr, which would rank first on a board sorted by net.
    // Nobody could trade it either: there is no room to open two legs.
    const hour = contract({ expiryTs: NOW + 3_600_000, futurePrice: 60_030 });
    expect(0.05 * (365 / (1 / 24))).toBeCloseTo(438, 0);
    expect(evaluateBasis(hour, SPOT_FEE, PERP_FEE, NOW)).toBeNull();
    // ...and the annualiser refuses that horizon on its own, not only via the
    // `daysToExpiry` gate above it.
    expect(annualizedBasisPct(0.05, 1 / 24)).toBeNull();

    // A day out is kept, and reads like the near-dated contract it is.
    const day = evaluateBasis(
      contract({ expiryTs: NOW + DAY_MS, futurePrice: 60_030 }),
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );
    expect(day!.daysToExpiry).toBe(1);
    expect(day!.annualizedPct).toBeCloseTo(18.25, 6);
  });

  it("drops an expired contract, an unpriceable leg and an unusable fee", () => {
    expect(evaluateBasis(contract({ expiryTs: NOW - DAY_MS }), SPOT_FEE, PERP_FEE, NOW))
      .toBeNull();
    expect(evaluateBasis(contract({ spotPrice: 0 }), SPOT_FEE, PERP_FEE, NOW)).toBeNull();
    expect(evaluateBasis(contract({ symbol: "" }), SPOT_FEE, PERP_FEE, NOW)).toBeNull();
    expect(evaluateBasis(contract(), SPOT_FEE, 2, NOW)).toBeNull();
  });
});

describe("rankBasisOpportunities", () => {
  it("ranks by net, which is not the same order as by gross basis", () => {
    const board = rankBasisOpportunities(
      [
        // 0.2% over 7 days: 10.43%/yr gross, against 15.64%/yr of drag.
        contract({ instrument: "NEAR", expiryTs: NOW + 7 * DAY_MS, futurePrice: 60_120 }),
        // 3% over 180 days: 6.08%/yr gross against only 0.61%/yr of drag.
        contract({ instrument: "FAR", expiryTs: NOW + 180 * DAY_MS, futurePrice: 61_800 }),
      ],
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );

    expect(board.map((r) => r.instrument)).toEqual(["FAR", "NEAR"]);
    // The near contract's *gross* is the larger of the two; the far one wins
    // anyway, which is the whole reason the drag is per row on this board.
    expect(board[1].annualizedPct).toBeCloseTo(10.42857143, 6);
    expect(board[0].annualizedPct).toBeCloseTo(6.08333333, 6);
    expect(board[1].annualizedPct).toBeGreaterThan(board[0].annualizedPct);
    // Net flips the order: 6.08 − 0.61 = 5.47 beats 10.43 − 15.64 = −5.21.
    expect(board[0].netAnnualPct).toBeCloseTo(5.475, 6);
    expect(board[1].netAnnualPct).toBeCloseTo(-5.21428571, 6);
  });

  it("drops unpriceable rows instead of ranking them at zero", () => {
    const board = rankBasisOpportunities(
      [
        contract({ instrument: "GOOD" }),
        contract({ instrument: "EXPIRED", expiryTs: NOW - DAY_MS }),
        contract({ instrument: "NO-SPOT", spotPrice: 0 }),
      ],
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );
    expect(board.map((r) => r.instrument)).toEqual(["GOOD"]);
  });

  it("keeps input order for ties, so two polls of one board rank alike", () => {
    const board = rankBasisOpportunities(
      [
        contract({ instrument: "FIRST" }),
        contract({ instrument: "SECOND" }),
        contract({ instrument: "THIRD" }),
      ],
      SPOT_FEE,
      PERP_FEE,
      NOW,
    );
    expect(board.map((r) => r.instrument)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("is empty, not throwing, for an empty board", () => {
    expect(rankBasisOpportunities([], SPOT_FEE, PERP_FEE, NOW)).toEqual([]);
  });
});
