import { Hono } from "hono";
import { getSnapshot, getWsCollector, MEXC_BASE, USER_AGENT, type WsCollector } from "./binance";
import type { Env } from "./types";

const MEXC_PING_PATH = "/api/v3/ping";
const MEXC_PROBE_TIMEOUT_MS = 8000;
/** Health probes get a longer WS budget than scans: a cold TLS handshake to
 *  Binance can eat most of the 4s scan deadline. */
const WS_PROBE_DEADLINE_MS = 5000;
const WS_PROBE_SYMBOL = "BTCUSDT";

/** Default markets for `/api/tickers` — one triangle's worth of legs. */
const DEFAULT_TICKER_SYMBOLS = ["BTCUSDT", "ETHUSDT", "ETHBTC"];
/** Guard rail for the debug route so a stray query cannot build a huge stream URL. */
const MAX_TICKER_SYMBOLS = 100;

export interface HealthSource {
  name: "binance-ws" | "mexc-rest";
  ok: boolean;
  ms: number;
  /** Symbols the probe actually received (WebSocket source only). */
  symbols?: string[];
}

/**
 * Probe the primary source by collecting a one-symbol snapshot. Takes the
 * collector as a parameter — defaulted at call time from the module seam — so
 * tests can drive the handler without opening a socket.
 *
 * Never throws: a dead source must not fail the whole report.
 */
export async function probeBinanceWs(
  env: Env,
  collect: WsCollector = getWsCollector(),
): Promise<HealthSource> {
  const started = Date.now();
  try {
    const book = await collect([WS_PROBE_SYMBOL], {
      deadlineMs: WS_PROBE_DEADLINE_MS,
      env,
    });
    return {
      name: "binance-ws",
      ok: book.has(WS_PROBE_SYMBOL),
      ms: Date.now() - started,
      symbols: [...book.keys()],
    };
  } catch {
    return { name: "binance-ws", ok: false, ms: Date.now() - started };
  }
}

/**
 * Probe the REST fallback with MEXC's cheap `/ping`. The API key is only ever
 * sent upstream as a header and is never echoed into the response.
 */
export async function probeMexcRest(_env: Env): Promise<HealthSource> {
  const started = Date.now();
  try {
    const res = await fetch(`${MEXC_BASE}${MEXC_PING_PATH}`, {
      method: "GET",
      // Workers' fetch sends no User-Agent by default and Binance-family WAFs
      // answer 403 to UA-less requests, so one is always set.
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(MEXC_PROBE_TIMEOUT_MS),
    });
    return { name: "mexc-rest", ok: res.ok, ms: Date.now() - started };
  } catch {
    return { name: "mexc-rest", ok: false, ms: Date.now() - started };
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", async (c) => {
  const env = c.env;
  const sources = await Promise.all([probeBinanceWs(env), probeMexcRest(env)]);
  // `ok` means "market data is obtainable": either source alone is enough.
  return c.json({ ok: sources.some((s) => s.ok), ts: Date.now(), sources });
});

app.get("/api/version", (c) => c.json({ name: "crypto-arb", phase: 2 }));

/**
 * Dev aid: resolve a snapshot for the given symbols through the real source
 * chain and report which source answered.
 */
app.get("/api/tickers", async (c) => {
  const raw = c.req.query("symbols");
  const requested = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, MAX_TICKER_SYMBOLS)
    : DEFAULT_TICKER_SYMBOLS;

  try {
    const snapshot = await getSnapshot(requested, c.env);
    const tickers = [...snapshot.book.values()].map(({ symbol, bid, ask }) => ({
      symbol,
      bid,
      ask,
    }));
    return c.json({
      source: snapshot.source,
      ts: snapshot.ts,
      count: tickers.length,
      tickers,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "snapshot failed" },
      502,
    );
  }
});

export default {
  fetch: app.fetch,
};

export { app };
