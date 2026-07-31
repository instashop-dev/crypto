import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { app } from "../src/index";
import type { BookTickerEntry, Env } from "../src/types";

// Minimal stand-in for the worker Env. These routes never touch ASSETS, and no
// API key is configured unless a test supplies one.
const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
} as unknown as Env;

const PING_PATH = "/api/v3/ping";
const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  // Route all outbound fetch through the mock agent and hard-fail any request
  // that is not explicitly intercepted, so tests can never hit the network.
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  // Always restore the real collector so one test cannot leak into the next.
  setWsCollector(null);
  fetchMock.assertNoPendingInterceptors();
});

/**
 * Replace the WebSocket collector with a stub. This is the seam that lets the
 * health probe and /api/tickers run in workerd without opening a socket:
 * `probeBinanceWs`/`getSnapshot` resolve their collector at call time from the
 * module-level default that `setWsCollector` swaps.
 */
function stubWs(fn: WsCollector): void {
  setWsCollector(fn);
}

function bookOf(...symbols: string[]): Map<string, BookTickerEntry> {
  return new Map(symbols.map((s) => [s, { symbol: s, bid: 1, ask: 2 }]));
}

function mockMexcPing(status: number): void {
  fetchMock
    .get(MEXC_BASE)
    .intercept({ path: PING_PATH, method: "GET" })
    .reply(status, status === 200 ? {} : { code: 0, msg: "restricted" });
}

interface HealthBody {
  ok: boolean;
  ts: number;
  sources: Array<{ name: string; ok: boolean; ms: number; symbols?: string[] }>;
}

describe("GET /api/version", () => {
  it("reports the app name and phase", async () => {
    const res = await app.request("/api/version", undefined, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: "crypto-arb", phase: 18 });
  });
});

describe("GET /api/health", () => {
  it("reports both sources as healthy", async () => {
    stubWs(async () => bookOf("BTCUSDT"));
    mockMexcPing(200);

    const res = await app.request("/api/health", undefined, mockEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;

    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
    expect(body.sources.map((s) => s.name)).toEqual(["binance-ws", "mexc-rest"]);
    expect(body.sources.map((s) => s.ok)).toEqual([true, true]);
    expect(body.sources[0].symbols).toEqual(["BTCUSDT"]);

    for (const source of body.sources) {
      expect(typeof source.ms).toBe("number");
      expect(source.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("marks the WebSocket source down when the probe symbol never arrives", async () => {
    // Deadline elapsed with an empty book — the collector resolves, it does
    // not throw.
    stubWs(async () => bookOf());
    mockMexcPing(200);

    const body = (await (
      await app.request("/api/health", undefined, mockEnv)
    ).json()) as HealthBody;

    expect(body.sources[0]).toMatchObject({ name: "binance-ws", ok: false });
    expect(body.sources[0].symbols).toEqual([]);
    // The REST fallback is still up, so market data is obtainable.
    expect(body.ok).toBe(true);
  });

  it("marks the WebSocket source down when the upgrade throws", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    mockMexcPing(200);

    const body = (await (
      await app.request("/api/health", undefined, mockEnv)
    ).json()) as HealthBody;

    expect(body.sources[0].ok).toBe(false);
    expect(body.ok).toBe(true);
  });

  it("marks the REST source down on a non-200 ping and reports ok:false when both fail", async () => {
    stubWs(async () => bookOf());
    mockMexcPing(451);

    const body = (await (
      await app.request("/api/health", undefined, mockEnv)
    ).json()) as HealthBody;

    expect(body.sources.map((s) => s.ok)).toEqual([false, false]);
    expect(body.ok).toBe(false);
  });

  it("marks the REST source down when the request fails outright", async () => {
    stubWs(async () => bookOf("BTCUSDT"));
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: PING_PATH, method: "GET" })
      .replyWithError(new Error("connection refused"));

    const body = (await (
      await app.request("/api/health", undefined, mockEnv)
    ).json()) as HealthBody;

    expect(body.sources.map((s) => s.ok)).toEqual([true, false]);
  });

  it("never leaks the API key into the response body", async () => {
    stubWs(async () => bookOf("BTCUSDT"));
    mockMexcPing(200);

    const secret = "super-secret-key";
    const res = await app.request("/api/health", undefined, {
      ...mockEnv,
      BINANCE_API_KEY: secret,
    } as Env);

    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("X-MBX-APIKEY");
  });
});

describe("GET /api/tickers", () => {
  it("returns the default triangle from the WebSocket source", async () => {
    stubWs(async (symbols) => bookOf(...symbols));

    const res = await app.request("/api/tickers", undefined, mockEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      source: string;
      ts: number;
      count: number;
      tickers: Array<{ symbol: string; bid: number; ask: number }>;
    };

    expect(body.source).toBe("binance-ws");
    expect(body.count).toBe(3);
    expect(body.tickers.map((t) => t.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "ETHBTC",
    ]);
    expect(body.tickers[0]).toEqual({ symbol: "BTCUSDT", bid: 1, ask: 2 });
  });

  it("honours the symbols query and falls back to MEXC when the socket is down", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(200, [
        { symbol: "LTCUSDT", bidPrice: "95.10", askPrice: "95.20" },
        { symbol: "BTCUSDT", bidPrice: "62000.10", askPrice: "62000.20" },
      ]);

    const res = await app.request(
      "/api/tickers?symbols=ltcusdt, btcusdt",
      undefined,
      mockEnv,
    );

    const body = (await res.json()) as {
      source: string;
      count: number;
      tickers: Array<{ symbol: string; bid: number }>;
    };

    expect(body.source).toBe("mexc-rest");
    expect(body.count).toBe(2);
    expect(body.tickers.find((t) => t.symbol === "LTCUSDT")?.bid).toBe(95.1);
  });

  it("returns 502 when no source can answer", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    const res = await app.request("/api/tickers", undefined, mockEnv);
    expect(res.status).toBe(502);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no market-data source available");
  });
});
