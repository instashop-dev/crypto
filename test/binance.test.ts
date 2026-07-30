import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyBookTickerMessage,
  buildStreamUrl,
  discoverPairs,
  fetchMexcSnapshot,
  getSnapshot,
  MEXC_BASE,
} from "../src/binance";
import { ASSET_UNIVERSE, candidateSymbols } from "../src/config";
import type { BookTickerEntry, Env } from "../src/types";
import fixture from "./fixtures/bookTicker.json";

const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
} as unknown as Env;

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  // Route all outbound fetch through the mock agent and hard-fail anything not
  // explicitly intercepted, so tests can never reach the real network.
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/** Queue one MEXC full-list response built from arbitrary raw entries. */
function mockMexcList(entries: unknown[]): void {
  fetchMock
    .get(MEXC_BASE)
    .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
    .reply(200, entries);
}

/** Combined-stream frame, exactly as Binance sends it. */
function frame(symbol: string, bid: string, ask: string): string {
  return JSON.stringify({
    stream: `${symbol.toLowerCase()}@bookTicker`,
    data: { u: 400900217, s: symbol, b: bid, B: "31.21", a: ask, A: "40.66" },
  });
}

describe("applyBookTickerMessage", () => {
  it("accumulates combined-stream frames", () => {
    const book = new Map<string, BookTickerEntry>();

    applyBookTickerMessage(book, frame("BTCUSDT", "62000.10", "62000.20"));
    applyBookTickerMessage(book, frame("ETHUSDT", "3000.55", "3000.66"));

    expect([...book.keys()]).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(book.get("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      bid: 62000.1,
      ask: 62000.2,
    });
  });

  it("accepts a bare single-stream payload", () => {
    const book = new Map<string, BookTickerEntry>();

    applyBookTickerMessage(
      book,
      JSON.stringify({ u: 1, s: "ETHBTC", b: "0.05", B: "1", a: "0.051", A: "2" }),
    );

    expect(book.get("ETHBTC")).toEqual({ symbol: "ETHBTC", bid: 0.05, ask: 0.051 });
  });

  it("keeps the latest quote for a symbol", () => {
    const book = new Map<string, BookTickerEntry>();

    applyBookTickerMessage(book, frame("BTCUSDT", "62000.10", "62000.20"));
    applyBookTickerMessage(book, frame("BTCUSDT", "62100.30", "62100.40"));

    expect(book.size).toBe(1);
    expect(book.get("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      bid: 62100.3,
      ask: 62100.4,
    });
  });

  it("ignores malformed JSON and non-bookTicker frames without dropping state", () => {
    const book = new Map<string, BookTickerEntry>();
    applyBookTickerMessage(book, frame("BTCUSDT", "62000.10", "62000.20"));

    const noise = [
      "not json at all",
      "{",
      "null",
      '"just a string"',
      // subscription acknowledgement
      JSON.stringify({ result: null, id: 1 }),
      // error envelope
      JSON.stringify({ error: { code: 2, msg: "Invalid request" } }),
      // a different stream type on the same combined socket
      JSON.stringify({
        stream: "btcusdt@depth",
        data: { e: "depthUpdate", s: "BTCUSDT", bids: [], asks: [] },
      }),
      // bookTicker shape but unusable prices
      frame("XRPUSDT", "0.00000000", "0.00000000"),
      frame("ADAUSDT", "abc", "0.5"),
      JSON.stringify({ stream: "x@bookTicker", data: { s: "", b: "1", a: "2" } }),
    ];
    for (const raw of noise) applyBookTickerMessage(book, raw);

    expect([...book.keys()]).toEqual(["BTCUSDT"]);
    expect(book.get("BTCUSDT")?.bid).toBe(62000.1);
  });
});

describe("buildStreamUrl", () => {
  it("builds one combined stream for all symbols", () => {
    expect(buildStreamUrl(["BTCUSDT", "ETHBTC"])).toBe(
      "https://stream.binance.com/stream?streams=btcusdt@bookTicker/ethbtc@bookTicker",
    );
  });
});

describe("fetchMexcSnapshot", () => {
  it("filters the full list to the requested symbols and parses prices", async () => {
    mockMexcList(fixture);

    const book = await fetchMexcSnapshot(["BTCUSDT", "ETHBTC", "NOTLISTED"], mockEnv);

    expect([...book.keys()].sort()).toEqual(["BTCUSDT", "ETHBTC"]);
    const raw = fixture.find((e) => e.symbol === "BTCUSDT")!;
    expect(book.get("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      bid: Number(raw.bidPrice),
      ask: Number(raw.askPrice),
    });
    expect(typeof book.get("ETHBTC")!.ask).toBe("number");
  });

  it("skips entries with a zero or unparseable bid/ask", async () => {
    mockMexcList([
      // ADABNB is genuinely quoted at 0/0 in the captured fixture.
      ...fixture.filter((e) => e.symbol === "ADABNB" || e.symbol === "ETHUSDT"),
      { symbol: "LTCUSDT", bidPrice: "n/a", askPrice: "100.5" },
      { symbol: "TRXUSDT", bidPrice: "0.30", askPrice: null },
      { symbol: 42, bidPrice: "1", askPrice: "2" },
    ]);

    const book = await fetchMexcSnapshot(
      ["ADABNB", "ETHUSDT", "LTCUSDT", "TRXUSDT"],
      mockEnv,
    );

    expect([...book.keys()]).toEqual(["ETHUSDT"]);
  });

  it("throws on a non-200 response", async () => {
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(503, "upstream down");

    await expect(fetchMexcSnapshot(["BTCUSDT"], mockEnv)).rejects.toThrow("HTTP 503");
  });

  it("does not call upstream when no symbols are requested", async () => {
    // No interceptor is queued: any fetch would fail the disabled net connect.
    await expect(fetchMexcSnapshot([], mockEnv)).resolves.toEqual(new Map());
  });
});

describe("getSnapshot", () => {
  const symbols = ["BTCUSDT", "ETHUSDT", "ETHBTC"];

  function bookOf(...entries: Array<[string, number, number]>) {
    return new Map<string, BookTickerEntry>(
      entries.map(([symbol, bid, ask]) => [symbol, { symbol, bid, ask }]),
    );
  }

  it("uses the WebSocket when coverage is sufficient", async () => {
    const snapshot = await getSnapshot(symbols, mockEnv, {
      collectWs: async () =>
        bookOf(["BTCUSDT", 1, 2], ["ETHUSDT", 3, 4], ["ETHBTC", 5, 6]),
    });

    expect(snapshot.source).toBe("binance-ws");
    expect(snapshot.book.size).toBe(3);
    expect(typeof snapshot.ts).toBe("number");
  });

  it("falls back to MEXC REST when the WebSocket fails", async () => {
    mockMexcList(fixture);

    const snapshot = await getSnapshot(symbols, mockEnv, {
      collectWs: async () => {
        throw new Error("websocket upgrade rejected (HTTP 403)");
      },
    });

    expect(snapshot.source).toBe("mexc-rest");
    expect([...snapshot.book.keys()].sort()).toEqual([
      "BTCUSDT",
      "ETHBTC",
      "ETHUSDT",
    ]);
  });

  it("falls back when the WebSocket covers less than 60% of the symbols", async () => {
    mockMexcList(fixture);

    const snapshot = await getSnapshot(symbols, mockEnv, {
      // 1 of 3 = 33% < 60%
      collectWs: async () => bookOf(["BTCUSDT", 1, 2]),
    });

    expect(snapshot.source).toBe("mexc-rest");
  });

  it("keeps a WebSocket result that is exactly at the coverage threshold", async () => {
    const snapshot = await getSnapshot(["BTCUSDT", "ETHUSDT"], mockEnv, {
      // 2 of 2 requested after dedupe; 3 of 5 would also pass
      collectWs: async () => bookOf(["BTCUSDT", 1, 2], ["ETHUSDT", 3, 4]),
    });

    expect(snapshot.source).toBe("binance-ws");
  });

  it("throws a descriptive error when both sources fail", async () => {
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    await expect(
      getSnapshot(symbols, mockEnv, {
        collectWs: async () => {
          throw new Error("websocket upgrade rejected (HTTP 403)");
        },
      }),
    ).rejects.toThrow(/binance-ws:.*HTTP 403.*mexc-rest:.*451/s);
  });

  it("reports partial WebSocket coverage in the failure message", async () => {
    mockMexcList([]);

    await expect(
      getSnapshot(symbols, mockEnv, { collectWs: async () => bookOf(["BTCUSDT", 1, 2]) }),
    ).rejects.toThrow(/covered only 1\/3 symbols/);
  });
});

describe("discoverPairs", () => {
  it("intersects the exchange catalogue with the candidate universe", async () => {
    mockMexcList([
      ...fixture,
      // Listed markets outside the universe must be ignored.
      { symbol: "PEPEUSDT", bidPrice: "0.000012", askPrice: "0.000013" },
      { symbol: "BTCUSDC", bidPrice: "62000", askPrice: "62001" },
    ]);

    const pairs = await discoverPairs(ASSET_UNIVERSE, mockEnv);
    const symbols = pairs.map((p) => p.symbol);

    expect(symbols).toHaveLength(fixture.length);
    expect(symbols).not.toContain("PEPEUSDT");
    expect(symbols).not.toContain("BTCUSDC");

    const candidates = new Set(candidateSymbols(ASSET_UNIVERSE));
    for (const pair of pairs) {
      expect(candidates.has(pair.symbol)).toBe(true);
      expect(pair.base + pair.quote).toBe(pair.symbol);
      expect(ASSET_UNIVERSE).toContain(pair.base);
      expect(ASSET_UNIVERSE).toContain(pair.quote);
    }
  });

  it("decomposes symbols at their longest valid suffix", async () => {
    mockMexcList([
      { symbol: "BTCUSDT", bidPrice: "62000", askPrice: "62001" },
      { symbol: "ETHBTC", bidPrice: "0.05", askPrice: "0.051" },
      // A base that is itself a suffix of another asset name.
      { symbol: "TRXXRP", bidPrice: "0.12", askPrice: "0.13" },
      { symbol: "LINKETH", bidPrice: "0.004", askPrice: "0.0041" },
    ]);

    const pairs = await discoverPairs(ASSET_UNIVERSE, mockEnv);

    expect(pairs).toEqual([
      { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
      { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
      { symbol: "TRXXRP", base: "TRX", quote: "XRP" },
      { symbol: "LINKETH", base: "LINK", quote: "ETH" },
    ]);
  });
});

describe("candidateSymbols", () => {
  it("emits every ordered pair of distinct assets", () => {
    expect(candidateSymbols(["A", "B", "C"])).toEqual([
      "AB",
      "AC",
      "BA",
      "BC",
      "CA",
      "CB",
    ]);
    expect(candidateSymbols(ASSET_UNIVERSE)).toHaveLength(
      ASSET_UNIVERSE.length * (ASSET_UNIVERSE.length - 1),
    );
  });
});
