import { Hono } from "hono";
import type { Env } from "./types";

/**
 * Binance REST base URLs probed by the health endpoint, in preference order.
 * `data-api.binance.vision` is the public market-data mirror (no auth, no geo
 * restrictions); the other two are the primary global / US clusters.
 */
export const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api.binance.us",
] as const;

const PING_PATH = "/api/v3/ping";
const PROBE_TIMEOUT_MS = 8000;

export interface HealthSource {
  base: string;
  /** HTTP status code, or "timeout" / "error" when the request never completed. */
  status: number | "timeout" | "error";
  ok: boolean;
  ms: number;
}

/**
 * Probe a single Binance base URL. Never throws: transport failures are folded
 * into the returned record so one dead endpoint cannot fail the whole report.
 *
 * The API key is only ever sent upstream as a request header. It is never
 * echoed into the response body and never logged.
 */
async function probeBase(base: string, apiKey?: string): Promise<HealthSource> {
  const started = Date.now();
  // Workers fetch sends no User-Agent by default; Binance's WAF rejects
  // UA-less requests with 403, so a UA is required for every upstream call.
  const headers: Record<string, string> = {
    "User-Agent": "crypto-arb-paper-trader/1.0",
    Accept: "application/json",
  };
  if (apiKey) headers["X-MBX-APIKEY"] = apiKey;

  try {
    const res = await fetch(`${base}${PING_PATH}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      base,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      base,
      status: timedOut ? "timeout" : "error",
      ok: false,
      ms: Date.now() - started,
    };
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", async (c) => {
  const apiKey = c.env?.BINANCE_API_KEY;

  const settled = await Promise.allSettled(
    BINANCE_BASES.map((base) => probeBase(base, apiKey)),
  );

  const sources: HealthSource[] = settled.map((result, i) =>
    result.status === "fulfilled"
      ? result.value
      : { base: BINANCE_BASES[i], status: "error", ok: false, ms: 0 },
  );

  return c.json({ ok: true, ts: Date.now(), sources });
});

app.get("/api/version", (c) => c.json({ name: "crypto-arb", phase: 1 }));

// Temporary Phase-1 diagnostic: probe an arbitrary base/path with a chosen
// User-Agent so reachability experiments don't require a redeploy each time.
// Removed once the source chain is settled.
app.get("/api/debug-probe", async (c) => {
  const base = c.req.query("base") ?? "https://data-api.binance.vision";
  const path = c.req.query("path") ?? PING_PATH;
  const ua = c.req.query("ua") ?? "crypto-arb-paper-trader/1.0";
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "User-Agent": ua, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = (await res.text()).slice(0, 300);
    return c.json({ base, path, ua, status: res.status, ms: Date.now() - started, body });
  } catch (err) {
    return c.json({ base, path, ua, error: String(err), ms: Date.now() - started });
  }
});

// Temporary Phase-1 diagnostic: open a WebSocket to Binance's market-data
// stream host and return the first bookTicker message received. Proves whether
// WS market data is viable from Workers egress. Removed once settled.
app.get("/api/debug-ws", async (c) => {
  const host = c.req.query("host") ?? "data-stream.binance.vision";
  const stream = c.req.query("stream") ?? "btcusdt@bookTicker";
  const started = Date.now();
  try {
    const resp = await fetch(`https://${host}/ws/${stream}`, {
      headers: { Upgrade: "websocket" },
    });
    const ws = resp.webSocket;
    if (!ws) {
      const body = (await resp.text()).slice(0, 200);
      return c.json({ host, stream, status: resp.status, ms: Date.now() - started, body });
    }
    ws.accept();
    const first = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws-timeout")), 8000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(t);
        resolve(String(ev.data).slice(0, 300));
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("ws-error"));
      });
    });
    ws.close();
    return c.json({ host, stream, ok: true, ms: Date.now() - started, first });
  } catch (err) {
    return c.json({ host, stream, error: String(err), ms: Date.now() - started });
  }
});

export default {
  fetch: app.fetch,
};

export { app };
