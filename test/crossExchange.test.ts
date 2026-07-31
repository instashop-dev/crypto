/**
 * Cross-exchange spread math, against hand-derived values.
 *
 * Pure: no D1, no network, no Workers APIs — just books in, quotes out. The
 * worked example throughout is
 *
 *   Binance  BTCUSDT  bid 60000 / ask 60010
 *   MEXC     BTCUSDT  bid 60500 / ask 60510
 *
 * at a 0.1%/leg taker fee, where buying on Binance (at 60010) and selling on
 * MEXC (at 60500) gives
 *
 *   grossPct = (60500 / 60010 - 1) * 100                 = +0.8165305782
 *   netPct   = ((60500 / 60010) * 0.999^2 - 1) * 100     = +0.6149983335
 *
 * and the mirror direction (buy MEXC at 60510, sell Binance at 60000) is
 * deeply negative, as the module header proves it must be.
 *
 * Every figure is priced on a notional of 1 base unit and nothing is ever
 * filled: since Phase 12 the engine measures spreads, it does not trade them.
 * The tax block at the foot re-prices at 100 USDT to answer "what would this
 * have cost", which is an analysis, not an order.
 */
import { describe, expect, it } from "vitest";
import {
  crossVenueBook,
  evaluateSpread,
  NO_TAX,
  rankSpreads,
  spreadHops,
  spreadLabel,
  spreadQuoteTax,
  spreadTax,
  type SpreadMarket,
  type SpreadQuote,
  type TaxPolicy,
  type VenueBook,
} from "../src/engine";

const FEE = 0.001;
const BASE = "USDT";

/** Reported (round8-quantised) figures for the worked example. */
const GROSS_PCT = 0.81653058;
const NET_PCT = 0.61499833;
/** The same two before quantisation, to 10 significant decimals. */
const GROSS_PCT_EXACT = 0.8165305782;
const NET_PCT_EXACT = 0.6149983335;

const BTC: SpreadMarket = { symbol: "BTCUSDT", base: "BTC", quote: "USDT" };
const ETH: SpreadMarket = { symbol: "ETHUSDT", base: "ETH", quote: "USDT" };
/** A market that does not settle in the base asset. */
const ETHBTC: SpreadMarket = { symbol: "ETHBTC", base: "ETH", quote: "BTC" };

function venue(name: string, entries: Record<string, [number, number]>): VenueBook {
  return {
    venue: name,
    book: new Map(
      Object.entries(entries).map(([symbol, [bid, ask]]) => [symbol, { bid, ask }]),
    ),
  };
}

const BINANCE = venue("binance-ws", { BTCUSDT: [60000, 60010] });
const MEXC = venue("mexc-rest", { BTCUSDT: [60500, 60510] });

/** The forward (profitable) direction of the worked example. */
function workedQuote(): SpreadQuote {
  const q = evaluateSpread(BTC, BINANCE, MEXC, FEE, BASE);
  if (!q) throw new Error("worked example failed to price");
  return q;
}

describe("evaluateSpread - the worked example", () => {
  it("reproduces both percentages to the last stored digit", () => {
    const q = workedQuote();

    expect(q.grossPct).toBe(GROSS_PCT);
    expect(q.netPct).toBe(NET_PCT);
    // ...and the stored figures are the unrounded ones, quantised — not some
    // other number that happens to round to the same 8 decimals.
    expect(q.grossPct).toBeCloseTo(GROSS_PCT_EXACT, 8);
    expect(q.netPct).toBeCloseTo(NET_PCT_EXACT, 8);
  });

  it("records the direction, the two prices and a readable label", () => {
    const q = workedQuote();

    expect(q.symbol).toBe("BTCUSDT");
    expect(q.base).toBe("BTC");
    expect(q.quote).toBe("USDT");
    expect(q.buyVenue).toBe("binance-ws");
    expect(q.sellVenue).toBe("mexc-rest");
    // Bought at the buy venue's ASK, sold at the sell venue's BID: the two
    // prices a taker actually gets, never the mid.
    expect(q.buyPrice).toBe(60010);
    expect(q.sellPrice).toBe(60500);
    expect(q.label).toBe("BTCUSDT binance-ws>mexc-rest");
    expect(q.label).toBe(spreadLabel("BTCUSDT", "binance-ws", "mexc-rest"));
  });

  it("carries two legs tagged with the venue that would fill them", () => {
    const { legs } = workedQuote();

    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({
      pair: "BTCUSDT",
      side: "BUY",
      price: 60010,
      inAsset: "USDT",
      inAmount: 1,
      outAsset: "BTC",
      // (1 / 60010) * 0.999, quantised for reporting.
      outAmount: 0.00001665,
      venue: "binance-ws",
    });
    expect(legs[1]).toMatchObject({
      pair: "BTCUSDT",
      side: "SELL",
      price: 60500,
      inAsset: "BTC",
      outAsset: "USDT",
      venue: "mexc-rest",
    });
    // The chain joins up: what leg 1 produced is what leg 2 spends.
    expect(legs[1].inAmount).toBe(legs[0].outAmount);
    // Every reported amount is quantised to 8 decimals.
    for (const leg of legs) {
      for (const amount of [leg.inAmount, leg.outAmount]) {
        expect(amount).toBe(Math.round(amount * 1e8) / 1e8);
      }
    }
  });

  it("nets less than it grosses, at any fee rate above zero", () => {
    for (const fee of [0.0001, 0.001, 0.002, 0.01]) {
      const q = evaluateSpread(BTC, BINANCE, MEXC, fee, BASE)!;
      expect(q).not.toBeNull();
      expect(q.netPct).toBeLessThan(q.grossPct);
    }
    // At fee 0 the two coincide by construction.
    const free = evaluateSpread(BTC, BINANCE, MEXC, 0, BASE)!;
    expect(free.netPct).toBe(free.grossPct);
  });

  it("nets ~0 at the exact break-even bid, bidB/askA = 1/(1-f)^2", () => {
    const breakEven = venue("mexc-rest", {
      BTCUSDT: [60010 / ((1 - FEE) * (1 - FEE)), 70000],
    });

    const q = evaluateSpread(BTC, BINANCE, breakEven, FEE, BASE)!;
    expect(q.netPct).toBeCloseTo(0, 8);
    // The gross edge at break-even is exactly the two legs of fees:
    // 1/(1-f)^2 - 1 = 0.2003004...%, which the whole edge is spent paying.
    expect(q.grossPct).toBeCloseTo((1 / (1 - FEE) ** 2 - 1) * 100, 8);
    expect(q.grossPct).toBeCloseTo(0.2003004, 7);
  });
});

describe("evaluateSpread - direction", () => {
  it("prices the mirror direction as a loss", () => {
    const mirror = evaluateSpread(BTC, MEXC, BINANCE, FEE, BASE)!;

    expect(mirror.buyVenue).toBe("mexc-rest");
    expect(mirror.sellVenue).toBe("binance-ws");
    expect(mirror.buyPrice).toBe(60510);
    expect(mirror.sellPrice).toBe(60000);
    expect(mirror.grossPct).toBeLessThan(0);
    expect(mirror.netPct).toBeLessThan(0);
  });

  it("cannot make both directions profitable, for any pair of books", () => {
    // (bidB/askA)(bidA/askB) = (bidA/askA)(bidB/askB) <= 1, so at most one
    // direction can gross above zero. Checked over a spread of shapes,
    // including one where the two venues quote identically.
    const cases: Array<[VenueBook, VenueBook]> = [
      [BINANCE, MEXC],
      [MEXC, BINANCE],
      [
        venue("a", { BTCUSDT: [100, 101] }),
        venue("b", { BTCUSDT: [100, 101] }),
      ],
      [
        venue("a", { BTCUSDT: [1, 1_000_000] }),
        venue("b", { BTCUSDT: [999_999, 1_000_000] }),
      ],
      [
        venue("a", { BTCUSDT: [0.00000001, 0.00000002] }),
        venue("b", { BTCUSDT: [1e12, 2e12] }),
      ],
    ];

    for (const [a, b] of cases) {
      const both = rankSpreads([BTC], a, b, FEE, BASE, { bothDirections: true });
      expect(both).toHaveLength(2);
      expect(both.filter((q) => q.grossPct > 0).length).toBeLessThanOrEqual(1);
      expect(both.filter((q) => q.netPct > 0).length).toBeLessThanOrEqual(1);
    }
  });

  it("emits only the better direction by default", () => {
    const ranked = rankSpreads([BTC], BINANCE, MEXC, FEE, BASE);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].netPct).toBe(NET_PCT);
    expect(ranked[0].buyVenue).toBe("binance-ws");

    // Argument order does not decide the winner; the prices do.
    const flipped = rankSpreads([BTC], MEXC, BINANCE, FEE, BASE);
    expect(flipped).toHaveLength(1);
    expect(flipped[0].label).toBe(ranked[0].label);
    expect(flipped[0].netPct).toBe(ranked[0].netPct);
  });
});

describe("evaluateSpread - guards", () => {
  it("skips a symbol that only one venue lists", () => {
    const thin = venue("mexc-rest", { ETHUSDT: [3000, 3001] });

    expect(evaluateSpread(BTC, BINANCE, thin, FEE, BASE)).toBeNull();
    expect(evaluateSpread(BTC, thin, BINANCE, FEE, BASE)).toBeNull();
    expect(rankSpreads([BTC], BINANCE, thin, FEE, BASE)).toEqual([]);
  });

  it("excludes a market that does not settle in the base asset", () => {
    const a = venue("a", { ETHBTC: [0.05, 0.0501] });
    const b = venue("b", { ETHBTC: [0.06, 0.0601] });

    // Priced on both venues, and a fat edge — but filling it would leave the
    // portfolio holding BTC rather than closing back to USDT.
    expect(evaluateSpread(ETHBTC, a, b, FEE, BASE)).toBeNull();
    expect(rankSpreads([ETHBTC], a, b, FEE, BASE)).toEqual([]);
  });

  it("skips a poisoned quote on either venue, and never returns NaN", () => {
    const poisons: Array<[number, number]> = [
      [0, 60010],
      [60000, 0],
      [-60000, 60010],
      [60000, -60010],
      [Number.NaN, 60010],
      [60000, Number.NaN],
      [Number.POSITIVE_INFINITY, 60010],
      [60000, Number.POSITIVE_INFINITY],
    ];

    for (const [bid, ask] of poisons) {
      const bad = venue("bad", { BTCUSDT: [bid, ask] });
      const label = `bid=${bid} ask=${ask}`;

      // Broken on the buy side, on the sell side, and on both.
      expect(evaluateSpread(BTC, bad, MEXC, FEE, BASE), label).toBeNull();
      expect(evaluateSpread(BTC, BINANCE, bad, FEE, BASE), label).toBeNull();
      expect(rankSpreads([BTC], bad, MEXC, FEE, BASE), label).toEqual([]);
    }
  });

  it("rejects a fee rate outside [0, 1)", () => {
    for (const fee of [-0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateSpread(BTC, BINANCE, MEXC, fee, BASE), String(fee)).toBeNull();
      expect(rankSpreads([BTC], BINANCE, MEXC, fee, BASE), String(fee)).toEqual([]);
    }
  });

  it("rejects a spread between a venue and itself", () => {
    // bid <= ask on one book makes this a guaranteed loss, and the label would
    // claim a cross-venue trade that never happened.
    expect(evaluateSpread(BTC, BINANCE, BINANCE, FEE, BASE)).toBeNull();
    expect(
      evaluateSpread(BTC, BINANCE, { venue: "binance-ws", book: MEXC.book }, FEE, BASE),
    ).toBeNull();
  });

  it("returns nothing for empty books or an empty market list", () => {
    const empty = venue("empty", {});

    expect(rankSpreads([BTC], empty, empty, FEE, BASE)).toEqual([]);
    expect(rankSpreads([BTC], BINANCE, empty, FEE, BASE)).toEqual([]);
    expect(rankSpreads([], BINANCE, MEXC, FEE, BASE)).toEqual([]);
  });
});

describe("rankSpreads", () => {
  const a = venue("a", { BTCUSDT: [60000, 60010], ETHUSDT: [3000, 3001] });
  const b = venue("b", { BTCUSDT: [60500, 60510], ETHUSDT: [3020, 3021] });

  it("sorts by net return, best first", () => {
    const ranked = rankSpreads([ETH, BTC], a, b, FEE, BASE);

    expect(ranked.map((q) => q.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(ranked[0].netPct).toBeGreaterThan(ranked[1].netPct);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].netPct).toBeGreaterThanOrEqual(ranked[i].netPct);
    }
  });

  it("breaks exact ties by market order, stably", () => {
    // Two markets quoted identically: their spreads are numerically equal, so
    // the ranking must fall back on enumeration order rather than wobble.
    const flat1 = venue("a", { BTCUSDT: [100, 101], ETHUSDT: [100, 101] });
    const flat2 = venue("b", { BTCUSDT: [110, 111], ETHUSDT: [110, 111] });

    const forward = rankSpreads([BTC, ETH], flat1, flat2, FEE, BASE);
    const reverse = rankSpreads([ETH, BTC], flat1, flat2, FEE, BASE);

    expect(forward[0].netPct).toBe(forward[1].netPct);
    expect(forward.map((q) => q.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(reverse.map((q) => q.symbol)).toEqual(["ETHUSDT", "BTCUSDT"]);
  });

  it("emits both directions of every market under bothDirections", () => {
    const both = rankSpreads([BTC, ETH], a, b, FEE, BASE, { bothDirections: true });

    expect(both).toHaveLength(4);
    expect(new Set(both.map((q) => q.label)).size).toBe(4);
    // Still sorted, and still with at most one winner per market.
    expect(both[0].netPct).toBeGreaterThanOrEqual(both[3].netPct);
    expect(both.filter((q) => q.netPct > 0)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// India mode: a spread is a two-disposal chain
// ---------------------------------------------------------------------------
//
// On the worked example at a 100 USDT notional:
//
//   disposal 1  100.00000000 USDT (face value, on the buy venue)
//   disposal 2  100.71571405 USDT (0.00166472 BTC marked at MEXC's 60500 bid)
//   tds base    200.71571405  = 2.0072x notional  ->  1% = 2.00715714 withheld
//   tax due     30% of 0.61499833                 =    0.1844995
//   net profit  0.61499833 - 0.1844995            =    0.43049883
const INDIA: TaxPolicy = { enabled: true, tdsRate: 0.01, taxRate: 0.3 };
const TDS_BASE = 200.71571405;
const TDS_WITHHELD = 2.00715714;

describe("spreadTax", () => {
  it("bills two disposals, not one and not three", () => {
    const q = workedQuote();

    expect(spreadHops(q)).toEqual([
      { from: "USDT", to: "BTC" },
      { from: "BTC", to: "USDT" },
    ]);

    const breakdown = spreadTax(q, FEE, 100, BASE, INDIA)!;
    expect(breakdown).not.toBeNull();
    expect(breakdown.legTds).toHaveLength(2);
    expect(breakdown.tdsBase).toBe(TDS_BASE);
    expect(breakdown.tdsWithheld).toBe(TDS_WITHHELD);
    // ~2% of notional for two legs, against ~3% for a triangle's three.
    expect(breakdown.tdsBase / 100).toBeCloseTo(2.0072, 4);
    expect(breakdown.tdsWithheld / 100).toBeCloseTo(0.02, 3);
    expect(breakdown.legTds.reduce((a, b) => a + b, 0)).toBeCloseTo(TDS_WITHHELD, 8);
  });

  it("values each disposal on the venue where that leg executes", () => {
    const q = workedQuote();
    const breakdown = spreadTax(q, FEE, 100, BASE, INDIA)!;

    // The BTC disposal happens on MEXC, so it is marked at MEXC's 60500 bid.
    // Marking it at Binance's 60000 bid would understate the base by ~0.83%.
    const btc = 0.0016647225462; // (100 / 60010) * 0.999, unrounded
    expect(breakdown.tdsBase - 100).toBeCloseTo(btc * 60500, 5);
    expect(breakdown.tdsBase - 100).not.toBeCloseTo(btc * 60000, 2);

    // The synthetic book that makes that true feeds each side to exactly one leg.
    expect(crossVenueBook(q).get("BTCUSDT")).toEqual({ bid: 60500, ask: 60010 });
  });

  it("charges 30% of the gain, leaving 70% as net profit", () => {
    const breakdown = spreadTax(workedQuote(), FEE, 100, BASE, INDIA)!;

    expect(breakdown.grossProfit).toBe(0.61499833);
    expect(breakdown.taxDue).toBeCloseTo(0.61499833 * 0.3, 8);
    expect(breakdown.netProfit).toBeCloseTo(0.61499833 * 0.7, 8);
    expect(breakdown.netProfit).toBe(0.43049883);
    // The cash view: TDS alone is over 3x the whole edge.
    expect(breakdown.cashProfit).toBeCloseTo(0.61499833 - TDS_WITHHELD, 8);
    expect(breakdown.cashProfit).toBeLessThan(0);
  });

  it("still withholds on a losing spread, and charges no tax on it", () => {
    const mirror = evaluateSpread(BTC, MEXC, BINANCE, FEE, BASE)!;
    const breakdown = spreadTax(mirror, FEE, 100, BASE, INDIA)!;

    expect(breakdown.grossProfit).toBeLessThan(0);
    expect(breakdown.taxDue).toBe(0);
    expect(breakdown.netProfit).toBe(breakdown.grossProfit);
    expect(breakdown.tdsWithheld).toBeGreaterThan(0);
    expect(breakdown.tdsBase / 100).toBeGreaterThan(1.98);
  });

  it("collapses to the untaxed result under NO_TAX", () => {
    const breakdown = spreadTax(workedQuote(), FEE, 100, BASE, NO_TAX)!;

    expect(breakdown.tdsBase).toBe(0);
    expect(breakdown.tdsWithheld).toBe(0);
    expect(breakdown.taxDue).toBe(0);
    expect(breakdown.netProfit).toBe(breakdown.grossProfit);
    expect(breakdown.cashProfit).toBe(breakdown.grossProfit);
    // The trade itself is untouched either way — the overlay never moves it.
    const taxed = spreadTax(workedQuote(), FEE, 100, BASE, INDIA)!;
    expect(taxed.endAmount).toBe(breakdown.endAmount);
    expect(taxed.grossProfit).toBe(breakdown.grossProfit);
  });

  it("returns null when the quote can no longer be priced", () => {
    const broken: SpreadQuote = { ...workedQuote(), sellPrice: 0 };
    expect(spreadTax(broken, FEE, 100, BASE, INDIA)).toBeNull();
    expect(spreadQuoteTax(broken, FEE, BASE, INDIA)).toBeNull();
  });
});

describe("spreadQuoteTax", () => {
  it("reports ~2% TDS and a 70% net, per unit of notional", () => {
    const q = workedQuote();
    const figures = spreadQuoteTax(q, FEE, BASE, INDIA)!;

    // `tdsBase * tdsRate`, quantised once — not the notional-1 `tdsWithheld`,
    // which round8 would have stripped two significant digits from.
    expect(figures.tdsPct).toBe(TDS_WITHHELD);
    expect(figures.tdsPct).toBeCloseTo(2.0072, 4);
    expect(figures.indiaNetPct).toBeCloseTo(q.netPct * 0.7, 8);
    // The drag is ~3x the edge it sits on: the same verdict as for triangles,
    // one leg cheaper.
    expect(figures.tdsPct).toBeGreaterThan(q.netPct);
  });

  it("is an order-preserving transform of netPct", () => {
    const a = venue("a", { BTCUSDT: [60000, 60010], ETHUSDT: [3000, 3001] });
    const b = venue("b", { BTCUSDT: [60500, 60510], ETHUSDT: [3020, 3021] });
    const ranked = rankSpreads([BTC, ETH], a, b, FEE, BASE);

    const india = ranked.map((q) => spreadQuoteTax(q, FEE, BASE, INDIA)!.indiaNetPct);
    expect(india[0]).toBeGreaterThan(india[1]);
    // Losses pass through untouched: no set-off is available.
    const mirror = evaluateSpread(BTC, MEXC, BINANCE, FEE, BASE)!;
    expect(spreadQuoteTax(mirror, FEE, BASE, INDIA)!.indiaNetPct).toBe(mirror.netPct);
  });

  it("is inert when the policy is disabled", () => {
    const q = workedQuote();
    expect(spreadQuoteTax(q, FEE, BASE, NO_TAX)).toEqual({
      indiaNetPct: q.netPct,
      tdsPct: 0,
    });
  });
});
