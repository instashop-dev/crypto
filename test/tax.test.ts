import { describe, expect, it } from "vitest";
import {
  computeChainTax,
  disposalValues,
  NO_TAX,
  priceChain,
  taxOnProfit,
  type ChainHop,
  type TaxPolicy,
} from "../src/engine/tax";
import type { Book, BookEntry } from "../src/engine/types";

/**
 * The tax core, driven directly by an ordered chain of hops.
 *
 * `computeChainTax` is deliberately generic in the chain length — the live
 * caller is the two-hop cross-exchange spread (`spreadTax` in
 * `src/engine/crossExchange.ts`, exercised in `test/crossExchange.test.ts`),
 * but the worked example here is the **three-hop** `USDT>BTC>ETH>USDT` chain,
 * kept for two reasons: its arithmetic is the one written out in the README's
 * India-mode section, and a three-hop case is a stronger test of the per-leg
 * disposal machinery than a two-hop one.
 *
 * Every expectation below is derived by hand from the book fixtures and written
 * out in full, so the derivation can be re-checked without running the engine.
 */
function book(entries: Record<string, [number, number]>): Book {
  const map = new Map<string, BookEntry>();
  for (const [symbol, [bid, ask]] of Object.entries(entries)) {
    map.set(symbol, { bid, ask });
  }
  return map;
}

const BASE = "USDT";
const FEE = 0.001;

/** +1.694305898% over the three hops below. */
const PROFITABLE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
});

/** Same markets, ETH marked down so the chain loses to fees. */
const LOSING = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [2990, 2991],
});

/** Statutory rates: 1% TDS u/s 194S, 30% u/s 115BBH. */
const INDIA: TaxPolicy = { enabled: true, tdsRate: 0.01, taxRate: 0.3 };

/**
 * The chain under test, spelled out rather than enumerated: the tax core takes
 * `{from, to}` pairs and resolves the market (and therefore the side) from the
 * book's own keys, so this is the whole input.
 */
const FORWARD: ChainHop[] = [
  { from: "USDT", to: "BTC" },
  { from: "BTC", to: "ETH" },
  { from: "ETH", to: "USDT" },
];

// ---------------------------------------------------------------------------
// The worked example, on 100 USDT of notional at fee 0.1%
// ---------------------------------------------------------------------------
//
//   leg 1  USDT -> BTC   BUY BTCUSDT at ask 60000
//          a1 = 100 / 60000 * 0.999      = 0.001665      BTC
//   leg 2  BTC  -> ETH   BUY ETHBTC   at ask 0.05
//          a2 = 0.001665 / 0.05 * 0.999  = 0.0332667     ETH
//   leg 3  ETH  -> USDT  SELL ETHUSDT at bid 3060
//          a3 = 0.0332667 * 3060 * 0.999 = 101.694305898 USDT
//
//   grossProfit = 101.694305898 - 100    = 1.694305898
//
// Disposal values (fee-free, marked into USDT — a valuation, not a trade):
//   leg 1  100 USDT is already the base asset      = 100
//   leg 2  0.001665  BTC  SELL BTCUSDT at bid 59990 =  99.883350
//   leg 3  0.0332667 ETH  SELL ETHUSDT at bid 3060  = 101.796102
//   tdsBase = 301.679452   (~3.017x notional, because all three legs are VDA
//                           disposals — USDT is itself a VDA)
//
//   tdsWithheld = 0.01 * 301.679452  = 3.01679452
//   taxDue      = 0.30 * 1.694305898 = 0.5082917694
//   netProfit   = 1.694305898 - 0.5082917694 = 1.1860141286
//   cashProfit  = 1.694305898 - 3.01679452   = -1.322488622   <- NEGATIVE
//
// Reported figures are quantised to 8 decimals (see `round8`), so the hand
// values above are quantised here too before being compared — an unrounded
// comparison would sit exactly on `toBeCloseTo(x, 8)`'s knife edge.
const to8 = (n: number): number => Math.round(n * 1e8) / 1e8;

const END_AMOUNT = to8(101.694305898); // 101.6943059
const GROSS_PROFIT = to8(1.694305898); // 1.6943059
const VALUES = [100, 99.88335, 101.796102]; // already exact at 8dp
const TDS_BASE = 301.679452;
const TDS_WITHHELD = 3.01679452;
const TAX_DUE = to8(0.5082917694); // 0.50829177
const NET_PROFIT = to8(1.694305898 - TAX_DUE); // 1.18601413
const CASH_PROFIT = to8(1.694305898 - TDS_WITHHELD); // -1.32248862

const tax100 = (policy: TaxPolicy = INDIA, b: Book = PROFITABLE) =>
  computeChainTax(FORWARD, b, FEE, 100, BASE, policy);

// ---------------------------------------------------------------------------
// (1)-(4) taxOnProfit: 115BBH allows no loss offset
// ---------------------------------------------------------------------------

describe("taxOnProfit", () => {
  it("(1) charges 30% of a positive gain", () => {
    // 0.3 * 1.694305898 = 0.5082917694, quantised to 8dp on the way out.
    expect(taxOnProfit(1.694305898, 0.3)).toBe(to8(0.5082917694)); // 0.50829177
    expect(taxOnProfit(100, 0.3)).toBe(30);
    // 31.2% is the statutory rate once the 4% cess is included.
    expect(taxOnProfit(100, 0.312)).toBe(31.2);
  });

  it("(2) charges nothing on a loss: no set-off, no refundable credit", () => {
    expect(taxOnProfit(-1.694305898, 0.3)).toBe(0);
    expect(taxOnProfit(-1e-9, 0.3)).toBe(0);
  });

  it("(3) charges nothing on a flat trade", () => {
    expect(taxOnProfit(0, 0.3)).toBe(0);
    expect(taxOnProfit(-0, 0.3)).toBe(0);
  });

  it("(4) charges nothing at a zero rate, and rejects junk rates", () => {
    expect(taxOnProfit(1.694305898, 0)).toBe(0);
    expect(taxOnProfit(100, Number.NaN)).toBe(0);
    expect(taxOnProfit(100, -0.3)).toBe(0);
    expect(taxOnProfit(100, 1)).toBe(0);
    expect(taxOnProfit(Number.NaN, 0.3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (5) a disabled policy is the pre-Phase-8 world
// ---------------------------------------------------------------------------

describe("(5) disabled policy", () => {
  it("still returns a breakdown, with every tax figure zero", () => {
    const t = tax100({ enabled: false, tdsRate: 0.01, taxRate: 0.3 })!;
    expect(t).not.toBeNull();

    expect(t.tdsBase).toBe(0);
    expect(t.tdsWithheld).toBe(0);
    expect(t.taxDue).toBe(0);
    expect(t.tdsRate).toBe(0);
    expect(t.taxRate).toBe(0);
    expect(t.legTds).toEqual([0, 0, 0]);

    // The three P&L views collapse into one when nothing is taxed.
    expect(t.grossProfit).toBe(GROSS_PROFIT);
    expect(t.netProfit).toBe(t.grossProfit);
    expect(t.cashProfit).toBe(t.grossProfit);
    expect(t.netProfitPct).toBe(t.grossProfitPct);

    // Rates carried on a disabled policy are ignored, not applied.
    expect(t.endAmount).toBe(END_AMOUNT);
    expect(t.startAmount).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// (6)-(11) the worked example
// ---------------------------------------------------------------------------

describe("(6) disposalValues", () => {
  it("values every leg's input asset in USDT at the fee-free bid", () => {
    const chain = priceChain(FORWARD, PROFITABLE, FEE, 100)!;
    expect(chain).not.toBeNull();
    expect(chain.disposals.map((d) => d.inAsset)).toEqual(["USDT", "BTC", "ETH"]);

    expect(disposalValues(chain.disposals, PROFITABLE, BASE)).toEqual(VALUES);
  });

  it("values all three legs, not just the one the exchange calls a SELL", () => {
    const chain = priceChain(FORWARD, PROFITABLE, FEE, 100)!;
    const values = disposalValues(chain.disposals, PROFITABLE, BASE)!;

    // Legs 1 and 2 are BUYs by listing direction, yet both dispose of a VDA.
    expect(values).toHaveLength(3);
    expect(values.every((v) => v > 0)).toBe(true);
    // ~3x notional, not ~1x: that is the whole point of the feature.
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(TDS_BASE, 8);
    expect(TDS_BASE / 100).toBeGreaterThan(3);
  });
});

describe("(7) the TDS base", () => {
  it("sums the three disposals and withholds 1% of them", () => {
    const t = tax100()!;
    expect(t.tdsBase).toBe(TDS_BASE); // 301.679452
    expect(t.tdsWithheld).toBe(TDS_WITHHELD); // 3.01679452
    // Over three times the notional, on a 100 USDT trade.
    expect(t.tdsBase / t.startAmount).toBeCloseTo(3.01679452, 8);
  });
});

describe("(8) the 115BBH charge", () => {
  it("taxes the gain at 30% and reports the net", () => {
    const t = tax100()!;
    expect(t.grossProfit).toBe(GROSS_PROFIT);
    expect(t.taxDue).toBe(TAX_DUE); // 0.50829177
    expect(t.netProfit).toBe(NET_PROFIT); // 1.18601413
    // On a 100 USDT notional the net profit and its percentage coincide.
    expect(t.netProfitPct).toBe(NET_PROFIT);
  });
});

describe("(9) netProfit nets the tax, not the withholding", () => {
  it("is exactly gross x (1 - taxRate)", () => {
    const t = tax100()!;
    expect(t.netProfit).toBeCloseTo(t.grossProfit * 0.7, 10);
    // If TDS were (wrongly) subtracted too, this would be ~-1.83.
    expect(t.netProfit).not.toBeCloseTo(t.grossProfit - t.taxDue - t.tdsWithheld, 6);
  });
});

describe("(10) cashProfit is the honest headline", () => {
  it("goes negative on a +1.69% chain because TDS is ~3% of notional", () => {
    const t = tax100()!;
    expect(t.cashProfit).toBe(CASH_PROFIT); // -1.32248862
    expect(t.cashProfit).toBeLessThan(0);
    // ...even though both the gross and the post-tax economic result are up.
    expect(t.grossProfit).toBeGreaterThan(0);
    expect(t.netProfit).toBeGreaterThan(0);

    // Break-even for the cash view needs a net edge above tdsBase/notional %,
    // i.e. about 3.02% per round trip — an order of magnitude above any
    // edge this repo has ever measured, on any strategy.
    expect((t.tdsWithheld / t.startAmount) * 100).toBeCloseTo(3.01679452, 8);
    expect(t.grossProfitPct).toBeLessThan((t.tdsWithheld / t.startAmount) * 100);
  });
});

describe("(11) legTds", () => {
  it("breaks the withholding down per leg and sums back to the total", () => {
    const t = tax100()!;
    expect(t.legTds).toEqual(VALUES.map((v) => Math.round(v * 0.01 * 1e8) / 1e8));
    expect(t.legTds.reduce((a, b) => a + b, 0)).toBeCloseTo(t.tdsWithheld, 8);
  });
});

// ---------------------------------------------------------------------------
// (12) a losing chain still bleeds TDS
// ---------------------------------------------------------------------------

describe("(12) losing book", () => {
  it("owes no tax, is still withheld on, and nets exactly the gross loss", () => {
    const t = tax100(INDIA, LOSING)!;

    expect(t.grossProfit).toBeLessThan(0);
    expect(t.taxDue).toBe(0); // no loss offset, and no negative tax either
    expect(t.tdsWithheld).toBeGreaterThan(0); // withholding is on turnover
    expect(t.netProfit).toBe(t.grossProfit);
    expect(t.cashProfit).toBeCloseTo(t.grossProfit - t.tdsWithheld, 10);
    expect(t.cashProfit).toBeLessThan(t.grossProfit);
  });
});

// ---------------------------------------------------------------------------
// (13) linearity in the notional
// ---------------------------------------------------------------------------

describe("(13) scaling the notional", () => {
  it("doubles every absolute figure and leaves every percentage alone", () => {
    const one = tax100()!;
    const two = computeChainTax(FORWARD, PROFITABLE, FEE, 200, BASE, INDIA)!;

    expect(two.startAmount).toBe(200);
    expect(two.grossProfit).toBeCloseTo(one.grossProfit * 2, 8);
    expect(two.tdsBase).toBeCloseTo(one.tdsBase * 2, 8);
    expect(two.tdsWithheld).toBeCloseTo(one.tdsWithheld * 2, 8);
    expect(two.taxDue).toBeCloseTo(one.taxDue * 2, 8);
    expect(two.netProfit).toBeCloseTo(one.netProfit * 2, 8);
    expect(two.cashProfit).toBeCloseTo(one.cashProfit * 2, 8);

    expect(two.grossProfitPct).toBeCloseTo(one.grossProfitPct, 8);
    expect(two.netProfitPct).toBeCloseTo(one.netProfitPct, 8);
  });
});

// ---------------------------------------------------------------------------
// (15) poisoned input never produces NaN
// ---------------------------------------------------------------------------

describe("(15) poisoned books", () => {
  const poison: Record<string, [number, number]> = {
    "zero bid": [0, 0.05],
    "zero ask": [0.0499, 0],
    "negative bid": [-0.0499, 0.05],
    "NaN ask": [0.0499, Number.NaN],
    "Infinity bid": [Number.POSITIVE_INFINITY, 0.05],
  };

  for (const [name, entry] of Object.entries(poison)) {
    it(`returns null, never NaN, for a ${name} on ETHBTC`, () => {
      const bad = book({
        BTCUSDT: [59990, 60000],
        ETHBTC: entry,
        ETHUSDT: [3060, 3061],
      });

      expect(priceChain(FORWARD, bad, FEE, 100)).toBeNull();
      expect(computeChainTax(FORWARD, bad, FEE, 100, BASE, INDIA)).toBeNull();
      expect(computeChainTax(FORWARD, bad, FEE, 100, BASE, NO_TAX)).toBeNull();
    });
  }

  it("returns null for an unusable notional, an empty chain and a missing leg", () => {
    expect(computeChainTax(FORWARD, PROFITABLE, FEE, 0, BASE, INDIA)).toBeNull();
    expect(computeChainTax(FORWARD, PROFITABLE, FEE, Number.NaN, BASE, INDIA)).toBeNull();
    expect(computeChainTax([], PROFITABLE, FEE, 100, BASE, INDIA)).toBeNull();

    // The book lost a market since the chain was priced.
    const stale = book({ BTCUSDT: [59990, 60000], ETHUSDT: [3060, 3061] });
    expect(computeChainTax(FORWARD, stale, FEE, 100, BASE, INDIA)).toBeNull();

    // A chain whose disposed asset cannot be marked into the base asset.
    const orphan = disposalValues([{ inAsset: "DOGE", inAmount: 5 }], PROFITABLE, BASE);
    expect(orphan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (17) quantisation
// ---------------------------------------------------------------------------

describe("(17) reported figures are round8-quantised", () => {
  it("holds for every numeric field of the breakdown", () => {
    // A notional chosen so the chain lands on long binary fractions.
    const t = computeChainTax(FORWARD, PROFITABLE, 0.00075, 137.77, BASE, {
      enabled: true,
      tdsRate: 0.01,
      taxRate: 0.312,
    })!;

    const quantised = (n: number) => Math.round(n * 1e8) / 1e8;
    const fields = [
      t.startAmount,
      t.endAmount,
      t.grossProfit,
      t.grossProfitPct,
      t.tdsBase,
      t.tdsWithheld,
      t.taxDue,
      t.netProfit,
      t.netProfitPct,
      t.cashProfit,
      ...t.legTds,
    ];
    for (const value of fields) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(quantised(value));
    }
  });
});

// ---------------------------------------------------------------------------
// (18) NO_TAX
// ---------------------------------------------------------------------------

describe("(18) NO_TAX", () => {
  it("is inert: the identity policy every default falls back to", () => {
    expect(NO_TAX).toEqual({ enabled: false, tdsRate: 0, taxRate: 0 });

    const t = tax100(NO_TAX)!;

    expect(t.netProfit).toBe(t.grossProfit);
    expect(t.cashProfit).toBe(t.grossProfit);
    expect(t.tdsWithheld).toBe(0);
    expect(t.taxDue).toBe(0);
    expect(t.legTds).toEqual([0, 0, 0]);

    // And it produces exactly the untaxed figures the engine already reported.
    expect(t.endAmount).toBe(END_AMOUNT);
    expect(t.grossProfit).toBe(GROSS_PROFIT);
  });
});
