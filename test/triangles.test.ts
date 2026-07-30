import { describe, expect, it } from "vitest";
import { cycleLabel, enumerateTriangles, resolveLeg } from "../src/engine/triangles";
import type { Book, BookEntry } from "../src/engine/types";

/**
 * Build a book from symbol -> [bid, ask]. Prices are irrelevant to enumeration
 * (only key presence matters), but are kept plausible so the same fixtures can
 * be reasoned about alongside the profit tests.
 */
function book(entries: Record<string, [number, number]>): Book {
  const map = new Map<string, BookEntry>();
  for (const [symbol, [bid, ask]] of Object.entries(entries)) {
    map.set(symbol, { bid, ask });
  }
  return map;
}

/**
 * The reference exchange listing. Note that only ONE spelling of each market
 * exists — BTCUSDT not USDTBTC, ETHBTC not BTCETH — which is the whole reason
 * leg direction has to be resolved against the book instead of derived.
 */
const LISTED = {
  BTCUSDT: [50000, 50010] as [number, number],
  ETHUSDT: [2510, 2511] as [number, number],
  ETHBTC: [0.05, 0.0501] as [number, number],
};

/** Compact "PAIR:SIDE" view of a triangle's legs, for exact-set assertions. */
function shape(tri: { legs: { pair: string; side: string }[] }): string[] {
  return tri.legs.map((leg) => `${leg.pair}:${leg.side}`);
}

describe("resolveLeg", () => {
  const b = book(LISTED);

  it("BUYs the base when the book lists `to + from`", () => {
    // Converting USDT -> BTC: the listing is BTC(base)/USDT(quote), so we spend
    // quote to acquire base => BUY.
    expect(resolveLeg("USDT", "BTC", b)).toEqual({
      pair: "BTCUSDT",
      side: "BUY",
      from: "USDT",
      to: "BTC",
    });
  });

  it("SELLs the base when the book lists `from + to`", () => {
    // Converting BTC -> USDT on the same market: we give up base => SELL.
    expect(resolveLeg("BTC", "USDT", b)).toEqual({
      pair: "BTCUSDT",
      side: "SELL",
      from: "BTC",
      to: "USDT",
    });
  });

  it("resolves both directions of a single-direction listing (ETHBTC)", () => {
    // BTCETH does not exist anywhere; both hops must route through ETHBTC.
    expect(b.has("BTCETH")).toBe(false);
    expect(resolveLeg("BTC", "ETH", b)).toMatchObject({ pair: "ETHBTC", side: "BUY" });
    expect(resolveLeg("ETH", "BTC", b)).toMatchObject({ pair: "ETHBTC", side: "SELL" });
  });

  it("returns null for unlisted, identical or empty assets", () => {
    expect(resolveLeg("BTC", "DOGE", b)).toBeNull();
    expect(resolveLeg("BTC", "BTC", b)).toBeNull();
    expect(resolveLeg("", "BTC", b)).toBeNull();
    expect(resolveLeg("BTC", "", b)).toBeNull();
  });
});

describe("enumerateTriangles", () => {
  it("emits exactly the cycles whose three legs are all listed", () => {
    // Universe includes XYZ, which has no market at all.
    const tris = enumerateTriangles(["USDT", "BTC", "ETH", "XYZ"], "USDT", book(LISTED));

    expect(tris.map(cycleLabel)).toEqual([
      "USDT>BTC>ETH>USDT",
      "USDT>ETH>BTC>USDT",
    ]);

    // USDT -> BTC  buy BTCUSDT at ask
    // BTC  -> ETH  buy ETHBTC  at ask   (listing is ETH/BTC)
    // ETH  -> USDT sell ETHUSDT at bid
    expect(shape(tris[0])).toEqual(["BTCUSDT:BUY", "ETHBTC:BUY", "ETHUSDT:SELL"]);
    // The mirror cycle trades the same three markets on the opposite sides.
    expect(shape(tris[1])).toEqual(["ETHUSDT:BUY", "ETHBTC:SELL", "BTCUSDT:SELL"]);

    expect(tris[0].assets).toEqual(["USDT", "BTC", "ETH", "USDT"]);
    expect(tris[1].assets).toEqual(["USDT", "ETH", "BTC", "USDT"]);
  });

  it("treats the two directions of a cycle as distinct triangles", () => {
    const tris = enumerateTriangles(["BTC", "ETH"], "USDT", book(LISTED));
    expect(tris).toHaveLength(2);
    expect(new Set(tris.map(cycleLabel)).size).toBe(2);
  });

  it("excludes assets with no usable pairs", () => {
    // XYZ never appears; SOL is listed against USDT only, so the middle hop
    // SOL -> BTC / BTC -> SOL is unavailable and no triangle can close.
    const tris = enumerateTriangles(
      ["USDT", "BTC", "ETH", "SOL", "XYZ"],
      "USDT",
      book({ ...LISTED, SOLUSDT: [150, 150.1] }),
    );
    const labels = tris.map(cycleLabel);
    expect(labels).toEqual(["USDT>BTC>ETH>USDT", "USDT>ETH>BTC>USDT"]);
    expect(labels.some((l) => l.includes("SOL") || l.includes("XYZ"))).toBe(false);
  });

  it("drops the base asset from the intermediate hops", () => {
    const tris = enumerateTriangles(["USDT", "BTC", "ETH"], "USDT", book(LISTED));
    for (const tri of tris) {
      expect(tri.assets[0]).toBe("USDT");
      expect(tri.assets[3]).toBe("USDT");
      expect(tri.assets[1]).not.toBe("USDT");
      expect(tri.assets[2]).not.toBe("USDT");
      expect(tri.assets[1]).not.toBe(tri.assets[2]);
    }
  });

  it("returns nothing when the base asset has no markets", () => {
    expect(enumerateTriangles(["BTC", "ETH"], "EUR", book(LISTED))).toEqual([]);
    expect(enumerateTriangles([], "USDT", book(LISTED))).toEqual([]);
  });

  it("orders output by universe order, deterministically", () => {
    const b = book(LISTED);
    const forward = enumerateTriangles(["BTC", "ETH"], "USDT", b).map(cycleLabel);
    const reversed = enumerateTriangles(["ETH", "BTC"], "USDT", b).map(cycleLabel);

    expect(forward).toEqual(["USDT>BTC>ETH>USDT", "USDT>ETH>BTC>USDT"]);
    // Same set, order mirrors the universe.
    expect(reversed).toEqual(["USDT>ETH>BTC>USDT", "USDT>BTC>ETH>USDT"]);
    expect([...forward].sort()).toEqual([...reversed].sort());

    // Repeated calls with the same inputs are byte-identical.
    expect(enumerateTriangles(["BTC", "ETH"], "USDT", b).map(cycleLabel)).toEqual(forward);
  });

  it("does not emit duplicates when the universe repeats an asset", () => {
    const tris = enumerateTriangles(["BTC", "ETH", "BTC", "ETH"], "USDT", book(LISTED));
    expect(tris.map(cycleLabel)).toEqual(["USDT>BTC>ETH>USDT", "USDT>ETH>BTC>USDT"]);
  });
});
