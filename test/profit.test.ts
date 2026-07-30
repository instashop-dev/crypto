import { describe, expect, it } from "vitest";
import {
  convert,
  evaluateTriangle,
  rankOpportunities,
  round8,
  simulateExecution,
} from "../src/engine/profit";
import { enumerateTriangles } from "../src/engine/triangles";
import type { Book, BookEntry } from "../src/engine/types";

/**
 * All expectations below are derived by hand from the book fixtures, using
 * exact rational arithmetic, and are written out to 20 significant digits so
 * the derivation can be re-checked without running the engine.
 *
 * Quantise the same way the engine reports amounts (8 decimals). Comparing a
 * hand value to a reported value requires rounding the hand value too — an
 * unrounded comparison can only ever be accurate to +/-5e-9, which is exactly
 * the tolerance of `toBeCloseTo(x, 8)` and would sit on the knife edge.
 */
const to8 = (n: number): number => Math.round(n * 1e8) / 1e8;

function book(entries: Record<string, [number, number]>): Book {
  const map = new Map<string, BookEntry>();
  for (const [symbol, [bid, ask]] of Object.entries(entries)) {
    map.set(symbol, { bid, ask });
  }
  return map;
}

/** The reference book for cases (a)-(e) and (g). bid/ask per market. */
const BOOK = book({
  BTCUSDT: [50000, 50010],
  ETHBTC: [0.05, 0.0501],
  ETHUSDT: [2510, 2511],
});

/** Same markets, but ETHUSDT marked up so the forward cycle is profitable. */
const PROFITABLE = book({
  BTCUSDT: [50000, 50010],
  ETHBTC: [0.05, 0.0501],
  ETHUSDT: [2520, 2521],
});

const FEE = 0.001;
const UNIVERSE = ["USDT", "BTC", "ETH"];

function triangle(label: string, b: Book) {
  const tri = enumerateTriangles(UNIVERSE, "USDT", b).find(
    (t) => t.assets.join(">") === label,
  );
  if (!tri) throw new Error(`triangle ${label} not enumerated`);
  return tri;
}

// ---------------------------------------------------------------------------
// (a) hand-computed forward cycle at fee 0.1%
// ---------------------------------------------------------------------------
//
// Cycle USDT>BTC>ETH>USDT on BOOK, notional 1 USDT, fee 0.001 (mult 0.999):
//
//   leg 1  USDT -> BTC   book lists "BTC"+"USDT" = BTCUSDT  => BUY at ask 50010
//          a1 = (1 / 50010) * 0.999            = 0.00001997600479904019...
//   leg 2  BTC  -> ETH   book lists "ETH"+"BTC" = ETHBTC    => BUY at ask 0.0501
//          a2 = (a1 / 0.0501) * 0.999          = 0.00039832392802876550...
//   leg 3  ETH  -> USDT  "USDT"+"ETH" absent; "ETH"+"USDT" = ETHUSDT => SELL at bid 2510
//          a3 = (a2 * 2510) * 0.999            = 0.99879326629284921458...
//
// Closed form: a3 = 2510 / (50010 * 0.0501) * 0.999^3
//                 = 2510 / 2505.501 * 0.997002999
//                 = 1.00179564885426108391 * 0.997002999
//                 = 0.99879326629284921458
//   netPct = (a3 - 1) * 100 = -0.12067337071507854117 %
const A_LEG1 = 0.0000199760047990401992;
const A_LEG2 = 0.0003983239280287655;
const A_NET_OUT = 0.99879326629284921458;
const A_NET_PCT = -0.12067337071507854117;
// (b) same chain at fee 0: 2510 / 2505.501
const A_GROSS_OUT = 1.00179564885426108391;
const A_GROSS_PCT = 0.17956488542610839109;

describe("(a) hand-computed USDT>BTC>ETH>USDT at fee 0.001", () => {
  it("prices each leg on the side the listing dictates", () => {
    const l1 = convert("USDT", "BTC", 1, BOOK, FEE);
    expect(l1).not.toBeNull();
    expect(l1!.leg).toMatchObject({ pair: "BTCUSDT", side: "BUY", price: 50010 });
    expect(l1!.out).toBeCloseTo(A_LEG1, 12);

    const l2 = convert("BTC", "ETH", l1!.out, BOOK, FEE);
    expect(l2).not.toBeNull();
    expect(l2!.leg).toMatchObject({ pair: "ETHBTC", side: "BUY", price: 0.0501 });
    expect(l2!.out).toBeCloseTo(A_LEG2, 12);

    const l3 = convert("ETH", "USDT", l2!.out, BOOK, FEE);
    expect(l3).not.toBeNull();
    expect(l3!.leg).toMatchObject({ pair: "ETHUSDT", side: "SELL", price: 2510 });
    expect(l3!.out).toBeCloseTo(A_NET_OUT, 12);
  });

  it("evaluateTriangle reproduces the hand-computed net figures to 8dp", () => {
    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, FEE)!;
    expect(q).not.toBeNull();
    expect(q.cycle).toBe("USDT>BTC>ETH>USDT");

    expect(q.netPct).toBe(to8(A_NET_PCT)); // -0.12067337
    // Reported (rounded) leg amounts on notional 1.
    expect(q.legs.map((l) => l.outAmount)).toEqual([
      to8(A_LEG1), // 0.00001998
      to8(A_LEG2), // 0.00039832
      to8(A_NET_OUT), // 0.99879327
    ]);
    expect(q.legs.map((l) => `${l.pair}:${l.side}@${l.price}`)).toEqual([
      "BTCUSDT:BUY@50010",
      "ETHBTC:BUY@0.0501",
      "ETHUSDT:SELL@2510",
    ]);
    // Assets chain end-to-end.
    expect(q.legs.map((l) => l.inAsset)).toEqual(["USDT", "BTC", "ETH"]);
    expect(q.legs.map((l) => l.outAsset)).toEqual(["BTC", "ETH", "USDT"]);
  });
});

describe("(b) the same cycle at fee 0 gives grossPct", () => {
  it("matches the hand-computed fee-free chain", () => {
    const l1 = convert("USDT", "BTC", 1, BOOK, 0)!;
    const l2 = convert("BTC", "ETH", l1.out, BOOK, 0)!;
    const l3 = convert("ETH", "USDT", l2.out, BOOK, 0)!;
    expect(l3.out).toBeCloseTo(A_GROSS_OUT, 12);

    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, FEE)!;
    expect(q.grossPct).toBe(to8(A_GROSS_PCT)); // 0.17956489

    // gross is a real re-run at fee 0, not netPct un-fee'd by hand: at fee 0
    // the two figures coincide.
    const zeroFee = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, 0)!;
    expect(zeroFee.netPct).toBe(q.grossPct);
    expect(zeroFee.grossPct).toBe(q.grossPct);
  });
});

// ---------------------------------------------------------------------------
// (c) direction handling on the mirror cycle
// ---------------------------------------------------------------------------
//
// Cycle USDT>ETH>BTC>USDT, notional 1 USDT, fee 0.001:
//
//   leg 1  USDT -> ETH   "ETH"+"USDT" = ETHUSDT   => BUY  at ask 2511
//          b1 = (1 / 2511) * 0.999      = 0.00039784946236559139...
//   leg 2  ETH  -> BTC   "BTC"+"ETH" absent; "ETH"+"BTC" = ETHBTC => SELL at bid 0.05
//          b2 = (b1 * 0.05) * 0.999     = 0.00001987258064516129...
//   leg 3  BTC  -> USDT  "USDT"+"BTC" absent; "BTC"+"USDT" = BTCUSDT => SELL at bid 50000
//          b3 = (b2 * 50000) * 0.999    = 0.99263540322580645161...
//
// Closed form: b3 = (1/2511) * 0.05 * 50000 * 0.999^3
//                 = 2500/2511 * 0.997002999 = 0.99263540322580645161
//   netPct = -0.73645967741935483870 %
const C_LEG1 = 0.00039784946236559139;
const C_LEG2 = 0.0000198725806451612903;
const C_NET_OUT = 0.99263540322580645161;
const C_NET_PCT = -0.7364596774193548387;

describe("(c) direction handling: a cycle that needs two SELL legs", () => {
  it("buys at the ask and sells at the bid, per listing direction", () => {
    const q = evaluateTriangle(triangle("USDT>ETH>BTC>USDT", BOOK), BOOK, FEE)!;

    expect(q.legs.map((l) => `${l.pair}:${l.side}@${l.price}`)).toEqual([
      "ETHUSDT:BUY@2511", // buying ETH with USDT pays the ask
      "ETHBTC:SELL@0.05", // selling ETH for BTC receives the bid
      "BTCUSDT:SELL@50000", // selling BTC for USDT receives the bid
    ]);
    expect(q.legs.map((l) => l.outAmount)).toEqual([
      to8(C_LEG1),
      to8(C_LEG2),
      to8(C_NET_OUT),
    ]);
    expect(q.netPct).toBe(to8(C_NET_PCT)); // -0.73645968

    // Same market, opposite sides in the two directions of travel.
    const fwd = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, FEE)!;
    expect(fwd.legs[1]).toMatchObject({ pair: "ETHBTC", side: "BUY", price: 0.0501 });
    expect(q.legs[1]).toMatchObject({ pair: "ETHBTC", side: "SELL", price: 0.05 });

    // Crossing the spread twice makes the mirror strictly worse here.
    expect(q.netPct).toBeLessThan(fwd.netPct);
  });
});

describe("(d) missing pairs", () => {
  it("convert returns null when neither listing direction exists", () => {
    expect(convert("BTC", "DOGE", 1, BOOK, FEE)).toBeNull();
    expect(convert("DOGE", "USDT", 1, BOOK, FEE)).toBeNull();
    expect(convert("BTC", "BTC", 1, BOOK, FEE)).toBeNull();
    expect(convert("BTC", "ETH", 1, book({ BTCUSDT: [50000, 50010] }), FEE)).toBeNull();
  });

  it("evaluateTriangle returns null if the book lost a leg since enumeration", () => {
    const tri = triangle("USDT>BTC>ETH>USDT", BOOK);
    const stale = book({ BTCUSDT: [50000, 50010], ETHUSDT: [2510, 2511] }); // no ETHBTC
    expect(evaluateTriangle(tri, stale, FEE)).toBeNull();
    expect(simulateExecution(
      evaluateTriangle(tri, BOOK, FEE)!, stale, FEE, 100,
    )).toBeNull();
  });

  it("rankOpportunities yields nothing when no cycle closes", () => {
    expect(rankOpportunities(UNIVERSE, "USDT", book({ BTCUSDT: [1, 2] }), FEE)).toEqual([]);
  });
});

describe("(e) poisoned quotes never produce NaN", () => {
  const poison: Record<string, [number, number]> = {
    "zero bid": [0, 0.0501],
    "zero ask": [0.05, 0],
    "negative bid": [-0.05, 0.0501],
    "negative ask": [0.05, -0.0501],
    "NaN bid": [Number.NaN, 0.0501],
    "NaN ask": [0.05, Number.NaN],
    "Infinity ask": [0.05, Number.POSITIVE_INFINITY],
    "-Infinity bid": [Number.NEGATIVE_INFINITY, 0.0501],
  };

  for (const [name, [bid, ask]] of Object.entries(poison)) {
    it(`returns null for a ${name} on ETHBTC, both sides of the market`, () => {
      const bad = book({ BTCUSDT: [50000, 50010], ETHUSDT: [2510, 2511], ETHBTC: [bid, ask] });
      // A corrupt entry is rejected whichever half we would have used.
      expect(convert("BTC", "ETH", 1, bad, FEE)).toBeNull();
      expect(convert("ETH", "BTC", 1, bad, FEE)).toBeNull();

      const tri = triangle("USDT>BTC>ETH>USDT", BOOK);
      expect(evaluateTriangle(tri, bad, FEE)).toBeNull();

      // The ranked list drops the poisoned cycles instead of ranking NaN.
      const ranked = rankOpportunities(UNIVERSE, "USDT", bad, FEE);
      expect(ranked).toEqual([]);
    });
  }

  it("rejects non-finite or non-positive amounts and fee rates", () => {
    expect(convert("USDT", "BTC", Number.NaN, BOOK, FEE)).toBeNull();
    expect(convert("USDT", "BTC", Number.POSITIVE_INFINITY, BOOK, FEE)).toBeNull();
    expect(convert("USDT", "BTC", 0, BOOK, FEE)).toBeNull();
    expect(convert("USDT", "BTC", -100, BOOK, FEE)).toBeNull();
    expect(convert("USDT", "BTC", 1, BOOK, Number.NaN)).toBeNull();
    expect(convert("USDT", "BTC", 1, BOOK, -0.1)).toBeNull();
    expect(convert("USDT", "BTC", 1, BOOK, 1)).toBeNull();
    expect(simulateExecution(
      evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, FEE)!, BOOK, FEE, 0,
    )).toBeNull();
  });

  it("round8 never leaks a non-finite value into a rounded amount", () => {
    expect(round8(1.005)).toBe(1.005);
    expect(round8(0.000000005)).toBe(0.00000001);
    expect(round8(0.000000004)).toBe(0);
    expect(round8(-1.234567891)).toBe(-1.23456789);
    expect(round8(Number.NaN)).toBeNaN();
    expect(round8(Number.POSITIVE_INFINITY)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// (f) fee compounding on a profitable book
// ---------------------------------------------------------------------------
//
// PROFITABLE differs only in ETHUSDT bid 2520 (was 2510):
//   gross = 2520 / (50010 * 0.0501) = 2520 / 2505.501 = 1.00578686657878005237
//   net   = gross * 0.999^3 = gross * 0.997002999    = 1.00277252233385658197
//   grossPct = 0.57868665787800523727 %   netPct = 0.27725223338565819770 %
const F_GROSS_OUT = 1.00578686657878005237;
const F_NET_OUT = 1.00277252233385658197;
const F_GROSS_PCT = 0.57868665787800523727;
const F_NET_PCT = 0.2772522333856582;

describe("(f) fee compounding", () => {
  it("net chain equals gross chain times (1 - fee)^3", () => {
    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", PROFITABLE), PROFITABLE, FEE)!;
    expect(q.grossPct).toBe(to8(F_GROSS_PCT));
    expect(q.netPct).toBe(to8(F_NET_PCT));

    // Three legs, one fee each, taken from the output asset => exactly 0.999^3.
    const grossOut = 1 + q.grossPct / 100;
    const netOut = 1 + q.netPct / 100;
    expect(grossOut).toBeCloseTo(F_GROSS_OUT, 9);
    expect(netOut).toBeCloseTo(F_NET_OUT, 9);
    expect(netOut).toBeCloseTo(grossOut * 0.999 ** 3, 8);

    // Break-even gross for a 3-leg 0.1% cycle: 1 / 0.999^3 - 1
    //   = 1 / 0.997002999 - 1 = 0.003006010015021099 => 0.3006010015 %
    // (the design doc's "~0.3006% gross at 0.1%/leg"). This book clears it.
    const breakEven = (1 / 0.999 ** 3 - 1) * 100;
    expect(breakEven).toBeCloseTo(0.3006010015021099, 8);
    expect(q.grossPct).toBeGreaterThan(breakEven);
    expect(q.netPct).toBeGreaterThan(0);
  });

  it("raising the fee monotonically lowers netPct and leaves grossPct alone", () => {
    const tri = triangle("USDT>BTC>ETH>USDT", PROFITABLE);
    const cheap = evaluateTriangle(tri, PROFITABLE, 0.0005)!;
    const dear = evaluateTriangle(tri, PROFITABLE, 0.002)!;
    expect(cheap.grossPct).toBe(dear.grossPct);
    expect(cheap.netPct).toBeGreaterThan(dear.netPct);
    expect(dear.netPct).toBeLessThan(0); // 0.2%/leg eats the 0.58% edge
  });
});

describe("(g) simulateExecution scales the quote", () => {
  it("reproduces netPct at a 100 USDT notional", () => {
    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", PROFITABLE), PROFITABLE, FEE)!;
    const trade = simulateExecution(q, PROFITABLE, FEE, 100)!;
    expect(trade).not.toBeNull();

    expect(trade.cycle).toBe("USDT>BTC>ETH>USDT");
    expect(trade.startAmount).toBe(100);
    // 100 * 1.00277252233385658197 = 100.27725223338565819770
    expect(trade.endAmount).toBe(to8(100 * F_NET_OUT)); // 100.27725223
    expect(trade.profit).toBe(to8(100 * F_NET_OUT - 100)); // 0.27725223
    expect(trade.profitPct).toBeCloseTo(q.netPct, 8);
    expect(trade.profit).toBeCloseTo(trade.endAmount - trade.startAmount, 8);

    // Real per-leg amounts, 100x the notional-1 leg amounts.
    expect(trade.legs).toHaveLength(3);
    expect(trade.legs[0].inAmount).toBe(100);
    expect(trade.legs[2].outAmount).toBe(trade.endAmount);
    for (let i = 0; i < 3; i++) {
      expect(trade.legs[i].pair).toBe(q.legs[i].pair);
      expect(trade.legs[i].side).toBe(q.legs[i].side);
      expect(trade.legs[i].price).toBe(q.legs[i].price);
      expect(trade.legs[i].outAmount).toBeCloseTo(q.legs[i].outAmount * 100, 5);
    }
  });

  it("is scale-free: profitPct is the same at 1, 100 and 10000 USDT", () => {
    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", PROFITABLE), PROFITABLE, FEE)!;
    for (const size of [1, 100, 10000]) {
      const t = simulateExecution(q, PROFITABLE, FEE, size)!;
      expect(t.profitPct).toBeCloseTo(q.netPct, 8);
      expect(t.endAmount).toBeCloseTo(size * F_NET_OUT, 6);
    }
  });

  it("reports a loss on an unprofitable cycle rather than clamping", () => {
    const q = evaluateTriangle(triangle("USDT>BTC>ETH>USDT", BOOK), BOOK, FEE)!;
    const trade = simulateExecution(q, BOOK, FEE, 100)!;
    expect(trade.profit).toBeLessThan(0);
    expect(trade.endAmount).toBe(to8(100 * A_NET_OUT)); // 99.87932663
    expect(trade.profitPct).toBeCloseTo(A_NET_PCT, 8);
  });
});

describe("rankOpportunities", () => {
  it("sorts by netPct descending and keeps the ordering stable", () => {
    const ranked = rankOpportunities(UNIVERSE, "USDT", PROFITABLE, FEE);
    expect(ranked.map((q) => q.cycle)).toEqual([
      "USDT>BTC>ETH>USDT", // the profitable direction
      "USDT>ETH>BTC>USDT",
    ]);
    expect(ranked[0].netPct).toBeGreaterThan(ranked[1].netPct);
    expect(rankOpportunities(UNIVERSE, "USDT", PROFITABLE, FEE)).toEqual(ranked);
  });
});
