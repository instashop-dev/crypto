import { describe, expect, it } from "vitest";
import { ASSET_UNIVERSE, BASE_ASSET, DEFAULTS } from "../src/config";
import { enumerateTriangles } from "../src/engine/triangles";
import { rankOpportunities, simulateExecution } from "../src/engine/profit";
import type { Book, BookEntry } from "../src/engine/types";
import fixture from "./fixtures/bookTicker.json";

/**
 * Load the captured real-market snapshot exactly the way the Worker will:
 * raw Binance/MEXC `bookTicker` schema in, `Map<symbol, {bid, ask}>` out, with
 * unquoted markets (0.00000000 on both sides — e.g. ADABNB, AVAXBNB in this
 * capture) skipped so they can never become a leg.
 */
function loadBook(): Book {
  const book = new Map<string, BookEntry>();
  for (const raw of fixture as { symbol: string; bidPrice: string; askPrice: string }[]) {
    const bid = Number.parseFloat(raw.bidPrice);
    const ask = Number.parseFloat(raw.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
    book.set(raw.symbol.toUpperCase(), { bid, ask });
  }
  return book;
}

const FEE = DEFAULTS.fee_rate; // 0.001

describe("engine over the captured bookTicker fixture", () => {
  const book = loadBook();

  it("skips the zero-priced markets when loading", () => {
    expect(book.size).toBeGreaterThan(0);
    expect(book.size).toBeLessThan(fixture.length);
    expect(book.has("ADABNB")).toBe(false); // 0.00000000 / 0.00000000
    expect(book.has("AVAXBNB")).toBe(false);
    expect(book.has("BTCUSDT")).toBe(true);
    for (const entry of book.values()) {
      expect(entry.bid).toBeGreaterThan(0);
      expect(entry.ask).toBeGreaterThan(0);
    }
  });

  it("ranks a non-empty list of well-formed USDT cycles", () => {
    const ranked = rankOpportunities(ASSET_UNIVERSE, BASE_ASSET, book, FEE);

    expect(ranked.length).toBeGreaterThan(0);
    // Every enumerated triangle is priceable, since the book is clean.
    expect(ranked.length).toBe(
      enumerateTriangles(ASSET_UNIVERSE, BASE_ASSET, book).length,
    );

    for (const q of ranked) {
      expect(q.cycle.startsWith(`${BASE_ASSET}>`)).toBe(true);
      expect(q.cycle.endsWith(`>${BASE_ASSET}`)).toBe(true);
      expect(q.triangle.assets[0]).toBe(BASE_ASSET);
      expect(q.triangle.assets[3]).toBe(BASE_ASSET);
      expect(Number.isFinite(q.netPct)).toBe(true);
      expect(Number.isFinite(q.grossPct)).toBe(true);
      // Fees can only reduce the round trip.
      expect(q.netPct).toBeLessThan(q.grossPct);
      expect(q.legs).toHaveLength(3);
      for (const leg of q.legs) {
        expect(book.has(leg.pair)).toBe(true);
        expect(Number.isFinite(leg.price)).toBe(true);
        expect(leg.price).toBeGreaterThan(0);
        expect(Number.isFinite(leg.outAmount)).toBe(true);
      }
    }

    // Sorted by netPct, descending.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].netPct).toBeGreaterThanOrEqual(ranked[i].netPct);
    }

    // Sanity on real data: a genuine top-of-book triangular edge on a liquid
    // venue is basis points, not percent. Anything >= 1% means the math (or the
    // capture) is broken, not that we found free money.
    expect(ranked[0].netPct).toBeLessThan(1);

    console.log(
      `[engine-fixture] ${book.size} markets, ${ranked.length} triangles, fee ${FEE}`,
    );
    for (const [i, q] of ranked.slice(0, 3).entries()) {
      const legs = q.legs.map((l) => `${l.side} ${l.pair}@${l.price}`).join(" | ");
      console.log(
        `[engine-fixture] #${i + 1} ${q.cycle}  gross ${q.grossPct.toFixed(6)}%  ` +
          `net ${q.netPct.toFixed(6)}%  ${legs}`,
      );
    }
  });

  it("simulates the top cycle at the configured trade size", () => {
    const ranked = rankOpportunities(ASSET_UNIVERSE, BASE_ASSET, book, FEE);
    const size = DEFAULTS.trade_size_usdt;
    const trade = simulateExecution(ranked[0], book, FEE, size)!;

    expect(trade).not.toBeNull();
    expect(trade.startAmount).toBe(size);
    expect(Number.isFinite(trade.endAmount)).toBe(true);
    expect(trade.profitPct).toBeCloseTo(ranked[0].netPct, 6);
    expect(trade.legs[0].inAsset).toBe(BASE_ASSET);
    expect(trade.legs[2].outAsset).toBe(BASE_ASSET);
    console.log(
      `[engine-fixture] simulated ${trade.cycle}: ${size} -> ` +
        `${trade.endAmount} USDT (${trade.profitPct.toFixed(6)}%)`,
    );
  });

  it("is deterministic: two runs over the same book are identical", () => {
    const a = rankOpportunities(ASSET_UNIVERSE, BASE_ASSET, book, FEE);
    const b = rankOpportunities(ASSET_UNIVERSE, BASE_ASSET, loadBook(), FEE);

    expect(b.map((q) => q.cycle)).toEqual(a.map((q) => q.cycle));
    expect(b.map((q) => q.netPct)).toEqual(a.map((q) => q.netPct));
    expect(b.map((q) => q.grossPct)).toEqual(a.map((q) => q.grossPct));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
