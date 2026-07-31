/**
 * Market-data client.
 *
 * Source chain (see docs/superpowers/specs/2026-07-30-crypto-arb-design.md):
 *
 * - **Primary — Binance WebSocket.** Every Binance REST host is blocked from
 *   Cloudflare egress (403 WAF / 451 geo), but `stream.binance.com` accepts a
 *   WebSocket upgrade and streams live data. Per snapshot the Worker opens one
 *   combined stream for the whole symbol set, collects the first bookTicker
 *   frame per symbol, and closes.
 * - **Fallback — MEXC REST.** `api.mexc.com` is reachable from Workers and
 *   serves the *identical* Binance API schema, so the parsing code is shared.
 *
 * Every upstream request must carry a User-Agent: Binance's WAF answers 403 to
 * UA-less requests, and Workers' fetch sends none by default.
 */
import { candidateSymbols } from "./config";
import type { BookTickerEntry, Env, PairInfo, Snapshot } from "./types";

export const USER_AGENT = "crypto-arb-paper-trader/1.0";

/** Binance combined-stream host. Public market data; no auth required. */
export const BINANCE_WS_HOST = "stream.binance.com";
/** MEXC REST base — Binance-compatible schema, reachable from CF egress. */
export const MEXC_BASE = "https://api.mexc.com";
const MEXC_BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

/** Default WebSocket collection budget, well inside the 10ms-CPU free plan. */
export const WS_DEADLINE_MS = 4000;
/** Fallback REST timeout. The full MEXC list is ~1-2MB, so allow headroom. */
export const MEXC_TIMEOUT_MS = 8000;
/**
 * Fraction of requested symbols a WebSocket snapshot must cover to be used.
 * Below this the snapshot is too sparse to enumerate triangles from, so the
 * REST fallback (which always returns the complete list) is preferred.
 */
export const WS_COVERAGE_THRESHOLD = 0.6;

/**
 * Headers for every upstream call.
 *
 * `X-MBX-APIKEY` is opt-in per call site rather than automatic: the key is a
 * Binance credential and must never be sent to MEXC (or any other third party).
 * The value is only ever placed in a request header — never logged, never
 * returned in a response body.
 */
function uaHeaders(env?: Env, sendApiKey = false): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (sendApiKey && env?.BINANCE_API_KEY) {
    headers["X-MBX-APIKEY"] = env.BINANCE_API_KEY;
  }
  return headers;
}

/** Parse a decimal-string price, rejecting garbage and non-positive values. */
function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Unique, upper-cased view of a caller-supplied symbol list. */
function normaliseSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** Give up (and return whatever arrived) after this many ms. */
  deadlineMs?: number;
  /** Override the stream host. Tests and diagnostics only. */
  host?: string;
  env?: Env;
}

/** Signature of {@link collectWsSnapshot}; the seam tests substitute. */
export type WsCollector = (
  symbols: string[],
  opts?: CollectOptions,
) => Promise<Map<string, BookTickerEntry>>;

/**
 * Build the combined-stream URL. `https:` (not `wss:`) because Workers open
 * sockets through `fetch()` with an `Upgrade: websocket` header.
 */
export function buildStreamUrl(symbols: string[], host = BINANCE_WS_HOST): string {
  const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
  return `https://${host}/stream?streams=${streams}`;
}

/**
 * Fold one raw stream frame into `book`. Pure and side-effect free apart from
 * the mutation of the map it is handed, which is what makes the socket loop
 * testable without a socket.
 *
 * Accepts both combined-stream envelopes (`{stream, data}`) and bare
 * single-stream payloads. Anything else — malformed JSON, subscription acks
 * (`{result: null, id: 1}`), other stream types, zero or unparseable prices —
 * is ignored, leaving the previous quote (if any) in place. Later frames for a
 * symbol overwrite earlier ones, so the map always holds the latest quote.
 */
export function applyBookTickerMessage(
  book: Map<string, BookTickerEntry>,
  raw: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  const envelope = parsed as { stream?: unknown; data?: unknown };
  const payload = (
    typeof envelope.stream === "string" &&
    envelope.data !== null &&
    typeof envelope.data === "object"
      ? envelope.data
      : parsed
  ) as Record<string, unknown>;

  const symbol = payload.s;
  if (typeof symbol !== "string" || symbol.length === 0) return;

  const bid = parsePrice(payload.b);
  const ask = parsePrice(payload.a);
  if (bid === null || ask === null) return;

  const upper = symbol.toUpperCase();
  book.set(upper, { symbol: upper, bid, ask });
}

/**
 * Open ONE combined bookTicker stream for `symbols`, accumulate the latest
 * quote per symbol, and resolve as soon as every requested symbol has been
 * seen — or when the deadline elapses, whichever comes first. The socket is
 * always closed before returning.
 *
 * Resolves with a partial (possibly empty) map rather than throwing on stream
 * errors; the caller judges usability by coverage. Only a failed upgrade
 * throws, since that means no socket exists at all.
 */
export async function collectWsSnapshot(
  symbols: string[],
  opts: CollectOptions = {},
): Promise<Map<string, BookTickerEntry>> {
  const book = new Map<string, BookTickerEntry>();
  const wanted = normaliseSymbols(symbols);
  if (wanted.length === 0) return book;

  const deadlineMs = opts.deadlineMs ?? WS_DEADLINE_MS;
  const resp = await fetch(buildStreamUrl(wanted, opts.host), {
    headers: { ...uaHeaders(opts.env, true), Upgrade: "websocket" },
  });

  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`websocket upgrade rejected (HTTP ${resp.status})`);
  }
  ws.accept();

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, deadlineMs);

      ws.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        applyBookTickerMessage(book, typeof data === "string" ? data : String(data));
        if (wanted.every((symbol) => book.has(symbol))) finish();
      });
      // A closed or broken stream ends collection; partial data still counts.
      ws.addEventListener("close", finish);
      ws.addEventListener("error", finish);
    });
  } finally {
    try {
      ws.close();
    } catch {
      // Already closed by the peer — nothing to clean up.
    }
  }

  return book;
}

/**
 * Module-level seam so route handlers can be exercised without a real socket.
 * Production code never calls the setter; tests swap in a stub and restore the
 * default afterwards.
 */
let activeWsCollector: WsCollector = collectWsSnapshot;

/** Replace the default WebSocket collector. Pass `null` to restore it. */
export function setWsCollector(collector: WsCollector | null): void {
  activeWsCollector = collector ?? collectWsSnapshot;
}

/** The collector currently in effect. */
export function getWsCollector(): WsCollector {
  return activeWsCollector;
}

// ---------------------------------------------------------------------------
// REST fallback (MEXC)
// ---------------------------------------------------------------------------

/** One raw `bookTicker` array element, in the shared Binance/MEXC schema. */
interface RawBookTicker {
  symbol?: unknown;
  bidPrice?: unknown;
  askPrice?: unknown;
}

async function fetchMexcBookTickers(env?: Env): Promise<RawBookTicker[]> {
  // MEXC does not support the `?symbols=[...]` filter Binance offers, so the
  // full list is fetched and filtered locally. It is ~1-2MB of JSON, which is
  // acceptable on a fallback path that only runs when the WebSocket is down.
  const res = await fetch(`${MEXC_BASE}${MEXC_BOOK_TICKER_PATH}`, {
    method: "GET",
    headers: uaHeaders(env),
    signal: AbortSignal.timeout(MEXC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = await res.json();
  if (!Array.isArray(payload)) throw new Error("expected a JSON array");
  return payload as RawBookTicker[];
}

/**
 * Fetch the full MEXC bookTicker list and reduce it to `symbols`.
 *
 * Entries with a zero, missing or unparseable bid/ask are skipped rather than
 * poisoning the engine with a 0-price leg.
 */
export async function fetchMexcSnapshot(
  symbols: string[],
  env?: Env,
): Promise<Map<string, BookTickerEntry>> {
  const book = new Map<string, BookTickerEntry>();
  const wanted = new Set(normaliseSymbols(symbols));
  if (wanted.size === 0) return book;

  for (const entry of await fetchMexcBookTickers(env)) {
    if (typeof entry?.symbol !== "string") continue;
    const symbol = entry.symbol.toUpperCase();
    if (!wanted.has(symbol)) continue;

    const bid = parsePrice(entry.bidPrice);
    const ask = parsePrice(entry.askPrice);
    if (bid === null || ask === null) continue;

    book.set(symbol, { symbol, bid, ask });
  }
  return book;
}

/** Signature of {@link fetchMexcSnapshot}; the seam tests substitute. */
export type RestFetcher = (
  symbols: string[],
  env?: Env,
) => Promise<Map<string, BookTickerEntry>>;

/**
 * Module-level REST seam, mirroring {@link setWsCollector}.
 *
 * Phase 9 gave the REST source a second role — it is no longer only a fallback
 * but a venue in its own right, quoted alongside Binance — so it needs the same
 * substitutability the WebSocket collector has had. Tests that need *both*
 * venues up can override this instead of hand-building a MEXC payload for
 * `fetchMock`, which is a lot of JSON to say "this venue quotes BTC at 60500".
 *
 * Production never calls the setter; tests restore the default in `afterEach`.
 */
let activeRestFetcher: RestFetcher = fetchMexcSnapshot;

/** Replace the default REST fetcher. Pass `null` to restore it. */
export function setRestFetcher(fetcher: RestFetcher | null): void {
  activeRestFetcher = fetcher ?? fetchMexcSnapshot;
}

/** The REST fetcher currently in effect. */
export function getRestFetcher(): RestFetcher {
  return activeRestFetcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SnapshotDeps {
  /** Injectable WebSocket collector; defaults to the module-level seam. */
  collectWs?: WsCollector;
  /** Injectable REST fallback; defaults to {@link fetchMexcSnapshot}. */
  fetchRest?: (symbols: string[], env?: Env) => Promise<Map<string, BookTickerEntry>>;
  /** Override the WebSocket deadline. */
  wsDeadlineMs?: number;
}

/**
 * Best-effort snapshot for `symbols`: Binance WebSocket first, MEXC REST as
 * fallback. The WebSocket result is accepted only if it covered at least
 * {@link WS_COVERAGE_THRESHOLD} of the requested symbols. Throws — with the
 * reason from each source — only when both fail.
 */
export async function getSnapshot(
  symbols: string[],
  env: Env,
  deps: SnapshotDeps = {},
): Promise<Snapshot> {
  const wanted = normaliseSymbols(symbols);
  const collectWs = deps.collectWs ?? getWsCollector();
  const fetchRest = deps.fetchRest ?? fetchMexcSnapshot;
  const failures: string[] = [];

  if (wanted.length > 0) {
    try {
      const book = await collectWs(wanted, {
        deadlineMs: deps.wsDeadlineMs ?? WS_DEADLINE_MS,
        env,
      });
      if (book.size / wanted.length >= WS_COVERAGE_THRESHOLD) {
        return { source: "binance-ws", ts: Date.now(), book };
      }
      failures.push(`binance-ws: covered only ${book.size}/${wanted.length} symbols`);
    } catch (err) {
      failures.push(`binance-ws: ${errorMessage(err)}`);
    }
  }

  try {
    const book = await fetchRest(wanted, env);
    if (book.size > 0 || wanted.length === 0) {
      return { source: "mexc-rest", ts: Date.now(), book };
    }
    failures.push("mexc-rest: none of the requested symbols were listed");
  } catch (err) {
    failures.push(`mexc-rest: ${errorMessage(err)}`);
  }

  throw new Error(`no market-data source available (${failures.join("; ")})`);
}

/** Both venues' books plus whichever of them the rest of the app should use. */
export interface DualSnapshot {
  /** `null` when the WebSocket failed or came back below the coverage bar. */
  binance: Snapshot | null;
  /** `null` when the REST call failed or matched none of the symbols. */
  mexc: Snapshot | null;
  /**
   * `binance ?? mexc` — the snapshot every pre-Phase-9 consumer reads.
   *
   * Identical to what {@link getSnapshot} would have returned for the same
   * symbols and the same upstream behaviour, which is the whole point: the
   * triangular scanner must not be able to tell that a second venue was
   * fetched alongside it.
   */
  primary: Snapshot;
  /** One human-readable line per source that did not qualify. Possibly empty. */
  failures: string[];
}

/**
 * Fetch **both** venues concurrently, for cross-exchange spreads.
 *
 * The acceptance rules are deliberately identical to {@link getSnapshot}'s — a
 * WebSocket book must cover {@link WS_COVERAGE_THRESHOLD} of the requested
 * symbols, a REST book must match at least one — so that `primary` is exactly
 * the snapshot the sequential path would have produced. The two differences are
 * mechanical:
 *
 * - **Concurrent, not sequential.** `getSnapshot` only calls MEXC when Binance
 *   failed; here MEXC is always wanted, so both run under `Promise.allSettled`
 *   and the scan pays one latency rather than two. `allSettled` (not `all`) is
 *   what makes a dead venue a `null` field instead of a thrown scan.
 * - **Nothing short-circuits.** A perfectly good WebSocket book no longer
 *   cancels the REST call, because the REST book is a second opinion now, not a
 *   fallback.
 *
 * Throws the same message as `getSnapshot` when neither venue qualifies, so the
 * scan-row error text does not change depending on which path produced it.
 * {@link getSnapshot} itself is untouched: `GET /api/tickers` and the
 * `xchg_enabled: 0` scan path keep their exact sequential semantics.
 */
export async function getDualSnapshot(
  symbols: string[],
  env: Env,
  deps: SnapshotDeps = {},
): Promise<DualSnapshot> {
  const wanted = normaliseSymbols(symbols);
  const collectWs = deps.collectWs ?? getWsCollector();
  const fetchRest = deps.fetchRest ?? getRestFetcher();
  const failures: string[] = [];

  const [wsResult, restResult] = await Promise.allSettled([
    // An empty request has nothing to stream, and opening a socket for zero
    // symbols would be a guaranteed timeout — `getSnapshot` skips it for the
    // same reason.
    wanted.length > 0
      ? collectWs(wanted, { deadlineMs: deps.wsDeadlineMs ?? WS_DEADLINE_MS, env })
      : Promise.resolve(new Map<string, BookTickerEntry>()),
    fetchRest(wanted, env),
  ]);

  let binance: Snapshot | null = null;
  if (wanted.length === 0) {
    failures.push("binance-ws: no symbols requested");
  } else if (wsResult.status === "fulfilled") {
    const book = wsResult.value;
    if (book.size / wanted.length >= WS_COVERAGE_THRESHOLD) {
      binance = { source: "binance-ws", ts: Date.now(), book };
    } else {
      failures.push(`binance-ws: covered only ${book.size}/${wanted.length} symbols`);
    }
  } else {
    failures.push(`binance-ws: ${errorMessage(wsResult.reason)}`);
  }

  let mexc: Snapshot | null = null;
  if (restResult.status === "fulfilled") {
    const book = restResult.value;
    if (book.size > 0 || wanted.length === 0) {
      mexc = { source: "mexc-rest", ts: Date.now(), book };
    } else {
      failures.push("mexc-rest: none of the requested symbols were listed");
    }
  } else {
    failures.push(`mexc-rest: ${errorMessage(restResult.reason)}`);
  }

  const primary = binance ?? mexc;
  if (!primary) {
    throw new Error(`no market-data source available (${failures.join("; ")})`);
  }

  return { binance, mexc, primary, failures };
}

/**
 * Discover which of the universe's candidate markets the exchange actually
 * lists, decomposed into base/quote.
 *
 * MEXC is used as the catalogue because it is reachable from Workers and uses
 * the same symbol naming as Binance, so the result is valid for the Binance
 * WebSocket streams too. Backs Phase 4's `POST /api/admin/refresh-pairs`.
 */
export async function discoverPairs(
  universe: string[],
  env?: Env,
): Promise<PairInfo[]> {
  const candidates = new Set(candidateSymbols(universe));
  // Longest asset first so a symbol is split at its longest valid suffix
  // (e.g. BTCUSDT -> BTC/USDT, never a shorter accidental match).
  const quotes = [...universe].sort((a, b) => b.length - a.length);
  const bases = new Set(universe);

  const pairs: PairInfo[] = [];
  const seen = new Set<string>();

  for (const entry of await fetchMexcBookTickers(env)) {
    if (typeof entry?.symbol !== "string") continue;
    const symbol = entry.symbol.toUpperCase();
    if (!candidates.has(symbol) || seen.has(symbol)) continue;

    for (const quote of quotes) {
      if (!symbol.endsWith(quote)) continue;
      const base = symbol.slice(0, symbol.length - quote.length);
      if (!bases.has(base)) continue;
      seen.add(symbol);
      pairs.push({ symbol, base, quote });
      break;
    }
  }
  return pairs;
}
