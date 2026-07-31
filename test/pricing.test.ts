/**
 * The shared leg-pricing primitives.
 *
 * Pure: no D1, no network, no Workers APIs. These three functions sit under
 * everything the engine reports — `round8` quantises every number written to D1
 * or handed out by the API, and `convert`/`resolveLeg` are the chain-pricing
 * core the india-mode overlay runs on — so their edges are tested directly
 * rather than only through their callers.
 */
import { describe, expect, it } from "vitest";
import { convert, resolveLeg, round8 } from "../src/engine/pricing";
import type { Book, BookEntry } from "../src/engine/types";

function book(entries: Record<string, [number, number]>): Book {
  const map = new Map<string, BookEntry>();
  for (const [symbol, [bid, ask]] of Object.entries(entries)) {
    map.set(symbol, { bid, ask });
  }
  return map;
}

const BOOK = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
});

const FEE = 0.001;

describe("round8", () => {
  it("quantises to 8 decimals", () => {
    expect(round8(1.234567894)).toBe(1.23456789);
    expect(round8(1.234567895)).toBe(1.2345679);
    expect(round8(-1.234567894)).toBe(-1.23456789);
    expect(round8(100)).toBe(100);
    expect(round8(0)).toBe(0);
  });

  it("is idempotent, which is what makes stored and reported figures agree", () => {
    for (const n of [1.694305898, -0.6317675, 1 / 3, 60010.123456789]) {
      expect(round8(round8(n))).toBe(round8(n));
    }
  });

  it("returns NaN for anything non-finite rather than a plausible number", () => {
    expect(round8(Number.NaN)).toBeNaN();
    expect(round8(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(round8(Number.NEGATIVE_INFINITY)).toBeNaN();
  });

  it("passes very large values through untouched", () => {
    // Past 2^53 the x1e8 multiply has already lost more precision than the
    // rounding would remove, so corrupting the value further would be worse
    // than leaving it alone.
    const huge = 1e300;
    expect(round8(huge)).toBe(huge);
    expect(round8(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("resolveLeg", () => {
  it("reads the side off the book's own key, not off the asset names", () => {
    // USDT -> BTC is listed as BTCUSDT, so it is a BUY at the ask...
    expect(resolveLeg("USDT", "BTC", BOOK)).toEqual({
      pair: "BTCUSDT",
      side: "BUY",
      from: "USDT",
      to: "BTC",
    });
    // ...and the same market the other way round is a SELL at the bid.
    expect(resolveLeg("BTC", "USDT", BOOK)).toEqual({
      pair: "BTCUSDT",
      side: "SELL",
      from: "BTC",
      to: "USDT",
    });
  });

  it("returns null when the exchange lists neither direction", () => {
    expect(resolveLeg("USDT", "DOGE", BOOK)).toBeNull();
    expect(resolveLeg("DOGE", "SOL", BOOK)).toBeNull();
  });

  it("rejects a degenerate or empty hop", () => {
    expect(resolveLeg("BTC", "BTC", BOOK)).toBeNull();
    expect(resolveLeg("", "BTC", BOOK)).toBeNull();
    expect(resolveLeg("BTC", "", BOOK)).toBeNull();
  });

  it("prefers the BUY spelling when a book lists both, so ties are deterministic", () => {
    const both = book({ BTCUSDT: [59990, 60000], USDTBTC: [1, 2] });
    expect(resolveLeg("USDT", "BTC", both)?.pair).toBe("BTCUSDT");
    expect(resolveLeg("USDT", "BTC", both)?.side).toBe("BUY");
  });
});

describe("convert", () => {
  it("buys at the ask and charges the fee on the output", () => {
    const step = convert("USDT", "BTC", 100, BOOK, FEE)!;
    expect(step).not.toBeNull();
    // 100 / 60000 * 0.999
    expect(step.out).toBeCloseTo(0.001665, 10);
    expect(step.leg).toEqual({
      pair: "BTCUSDT",
      side: "BUY",
      price: 60000,
      inAsset: "USDT",
      inAmount: 100,
      outAsset: "BTC",
      outAmount: 0.001665,
    });
  });

  it("sells at the bid, and hands back the unrounded amount to chain on", () => {
    const step = convert("ETH", "USDT", 0.0332667, BOOK, FEE)!;
    // 0.0332667 * 3060 * 0.999
    expect(step.out).toBeCloseTo(101.694305898, 8);
    expect(step.leg.side).toBe("SELL");
    expect(step.leg.price).toBe(3060);
    // The reported amount is quantised; `out` is not — chaining the quantised
    // figure is the precision hazard the whole split exists to avoid.
    expect(step.leg.outAmount).toBe(round8(step.out));
  });

  it("is fee-free at rate 0, which is what a 194S valuation uses", () => {
    const free = convert("BTC", "USDT", 1, BOOK, 0)!;
    expect(free.out).toBe(59990);
  });

  it("returns null, never NaN, for an unlisted market", () => {
    expect(convert("USDT", "DOGE", 100, BOOK, FEE)).toBeNull();
    expect(convert("BTC", "BTC", 100, BOOK, FEE)).toBeNull();
  });

  it("returns null for a poisoned quote on either side of the entry", () => {
    const poisons: Array<[number, number]> = [
      [0, 60000],
      [59990, 0],
      [-59990, 60000],
      [59990, -60000],
      [Number.NaN, 60000],
      [59990, Number.NaN],
      [Number.POSITIVE_INFINITY, 60000],
      [59990, Number.POSITIVE_INFINITY],
    ];

    for (const [bid, ask] of poisons) {
      const bad = book({ BTCUSDT: [bid, ask] });
      const label = `bid=${bid} ask=${ask}`;
      // Both directions, because half a broken entry is a corrupt quote and
      // trading the other half of it would launder bad data into the P&L.
      expect(convert("USDT", "BTC", 100, bad, FEE), label).toBeNull();
      expect(convert("BTC", "USDT", 1, bad, FEE), label).toBeNull();
    }
  });

  it("returns null for an unusable amount", () => {
    for (const amount of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(convert("USDT", "BTC", amount, BOOK, FEE), String(amount)).toBeNull();
    }
  });

  it("returns null for a fee rate outside [0, 1)", () => {
    for (const fee of [-0.001, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(convert("USDT", "BTC", 100, BOOK, fee), String(fee)).toBeNull();
    }
  });

  it("returns null rather than a non-finite output on an extreme quote", () => {
    // An amount that underflows to zero once divided is not a fill, it is a
    // rounding artefact — and `out` must never leave here as 0 or Infinity.
    const extreme = book({ BTCUSDT: [1e-320, 1e308] });
    expect(convert("USDT", "BTC", 1e-300, extreme, FEE)).toBeNull();
  });
});
