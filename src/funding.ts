/**
 * Funding-rate client for the cash-and-carry scanner.
 *
 * Mirrors `src/binance.ts` in shape — module seam, per-call dependency
 * injection, pure exported parsers, a fallback chain judged by coverage — so
 * there is one way to reason about every upstream in this app.
 *
 * Source chain:
 *
 * - **Primary — Bybit v5 `/v5/market/tickers?category=linear`.** One
 *   unauthenticated request returns the funding rate of *every* linear perp, so
 *   the whole board costs a single subrequest no matter how large the universe
 *   grows. The response does not carry the settlement interval, which is why
 *   {@link fetchBybitIntervals} exists as a separate, day-cached call.
 * - **Fallback — OKX `/api/v5/public/funding-rate?instId=…`.** One request per
 *   instrument (11 for the shipped universe), run under `Promise.allSettled` so
 *   a single dead instrument costs one row rather than the snapshot. Total
 *   worst case is 1 + 1 + 11 = 13 subrequests, inside the free plan's 50.
 *
 * **No credential ever leaves for these hosts.** {@link fundingHeaders} takes no
 * `Env` at all, so there is no code path — not even a mistaken `true` at a call
 * site — by which a Binance API key could be attached to a Bybit or OKX
 * request. That is a structural guarantee, not a convention.
 */
import { USER_AGENT } from "./binance";
import { DEFAULT_FUNDING_INTERVAL_MINUTES } from "./engine";
import type { Env, FundingVenue } from "./types";

/** Bybit v5 public market data. No auth, no key, no signature. */
export const BYBIT_BASE = "https://api.bybit.com";
const BYBIT_TICKERS_PATH = "/v5/market/tickers";
const BYBIT_INSTRUMENTS_PATH = "/v5/market/instruments-info";

/** OKX v5 public market data, same terms. */
export const OKX_BASE = "https://www.okx.com";
const OKX_FUNDING_PATH = "/api/v5/public/funding-rate";

/**
 * Per-call timeout. Shorter than {@link import("./binance").MEXC_TIMEOUT_MS}
 * because these payloads are small (a few hundred KB at most) and the funding
 * block runs *after* the arbitrage half of a scan — it must not be able to push
 * a scan past the cron interval.
 */
export const FUNDING_TIMEOUT_MS = 6000;

/**
 * Fraction of the requested assets Bybit must quote for its board to be used.
 *
 * Same rule and same number as the WebSocket's
 * {@link import("./binance").WS_COVERAGE_THRESHOLD}: a board covering three of
 * eleven assets is not a cheaper snapshot, it is a different (and much worse)
 * scan, so the per-instrument fallback is preferred over it.
 */
export const FUNDING_COVERAGE_THRESHOLD = 0.6;

/** Longest cadence accepted from an upstream; see `src/engine/funding.ts`. */
const MAX_FUNDING_INTERVAL_MINUTES = 1440;

/** Bybit names its USDT-margined linear perp after the spot symbol. */
export function bybitInstrument(asset: string): string {
  return `${asset}USDT`;
}

/** OKX names the same contract `<ASSET>-USDT-SWAP`. */
export function okxInstrument(asset: string): string {
  return `${asset}-USDT-SWAP`;
}

/**
 * One venue's funding quote for one asset.
 *
 * Keyed on the plain asset (`BTC`), not the venue's contract name, so a Bybit
 * snapshot and an OKX snapshot are directly comparable and the persisted
 * `symbol` column means the same thing whichever venue answered. `instrument`
 * keeps the venue's own name, because that is what someone reproducing the
 * number has to paste into the venue's own UI.
 */
export interface FundingQuote {
  venue: FundingVenue;
  /** Asset symbol, upper-case, e.g. `BTC`. */
  symbol: string;
  /** The venue's contract name, e.g. `BTCUSDT` or `BTC-USDT-SWAP`. */
  instrument: string;
  /** Per-interval funding fraction; positive means the short is paid. */
  rate: number;
  intervalMinutes: number;
  /**
   * `'api'` when the venue told us the cadence, `'assumed'` when
   * {@link DEFAULT_FUNDING_INTERVAL_MINUTES} was used instead. Carried all the
   * way to the dashboard: the annualised figure scales linearly with it.
   */
  intervalSource: "api" | "assumed";
  /** Epoch millis of the next settlement; `null` when the venue omitted it. */
  nextFundingTs: number | null;
  markPrice: number | null;
}

/** A point-in-time view of one venue's funding board. */
export interface FundingSnapshot {
  venue: FundingVenue;
  /** Epoch millis at which the snapshot was completed. */
  ts: number;
  /** Keyed by upper-case asset symbol. */
  quotes: Map<string, FundingQuote>;
}

/**
 * Headers for every funding request.
 *
 * Takes no `Env`, on purpose — see the module docblock. Workers' `fetch` sends
 * no User-Agent by default and exchange WAFs answer 403 to UA-less requests.
 */
function fundingHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Unique, upper-cased view of a caller-supplied asset list. */
function normaliseAssets(assets: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of assets) {
    const asset = raw.trim().toUpperCase();
    if (!asset || seen.has(asset)) continue;
    seen.add(asset);
    out.push(asset);
  }
  return out;
}

/**
 * Parse a decimal-string funding rate.
 *
 * Rejects the empty string Bybit sends for contracts that do not fund, and any
 * magnitude of 1 or more — a 100%-per-settlement rate is a mis-decoded field,
 * not a market. `null` is per-symbol: one bad row never poisons the board.
 */
function parseRate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || Math.abs(n) >= 1) return null;
  return n;
}

/** Parse a decimal-string epoch-millis timestamp. */
function parseTs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Parse a decimal-string price, rejecting garbage and non-positive values. */
function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Parse a settlement cadence in minutes. */
function parseInterval(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_FUNDING_INTERVAL_MINUTES) return null;
  return n;
}

/** `instrument -> asset` for the assets we asked about. */
function bybitWanted(assets: string[]): Map<string, string> {
  return new Map(assets.map((asset) => [bybitInstrument(asset), asset]));
}

// ---------------------------------------------------------------------------
// Bybit
// ---------------------------------------------------------------------------

/**
 * Bybit's v5 envelope. `retCode` is the real status: the transport answers 200
 * and puts the failure in the body, so an `res.ok` check alone would happily
 * parse an error as an empty board.
 */
interface BybitEnvelope {
  retCode?: unknown;
  retMsg?: unknown;
  result?: { list?: unknown } | null;
}

function bybitList(payload: unknown, what: string): unknown[] {
  const envelope = (payload ?? {}) as BybitEnvelope;
  const retCode = Number(envelope.retCode);
  if (!Number.isFinite(retCode) || retCode !== 0) {
    const msg = typeof envelope.retMsg === "string" ? envelope.retMsg : "unknown error";
    throw new Error(`retCode ${String(envelope.retCode)}: ${msg}`);
  }
  const list = envelope.result?.list;
  if (!Array.isArray(list)) throw new Error(`${what}: result.list was not an array`);
  return list;
}

/**
 * Reduce a `/v5/market/tickers` payload to the requested assets.
 *
 * `intervals` is the day-cached `instrument -> minutes` map from
 * {@link parseBybitIntervals}; an instrument missing from it falls back to
 * {@link DEFAULT_FUNDING_INTERVAL_MINUTES} and is tagged `'assumed'` rather
 * than being dropped — an 8-hour guess is far more useful than a hole, as long
 * as the guess is visible.
 *
 * Throws only for a failed envelope. A single unusable entry (blank rate,
 * unparseable number, symbol outside the universe) is skipped.
 */
export function parseBybitTickers(
  payload: unknown,
  assets: string[],
  intervals: Record<string, number> = {},
): Map<string, FundingQuote> {
  const quotes = new Map<string, FundingQuote>();
  const wanted = bybitWanted(normaliseAssets(assets));
  const list = bybitList(payload, "tickers");

  for (const raw of list) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry?.symbol !== "string") continue;
    const instrument = entry.symbol.toUpperCase();
    const symbol = wanted.get(instrument);
    if (!symbol || quotes.has(symbol)) continue;

    const rate = parseRate(entry.fundingRate);
    if (rate === null) continue;

    const cached = parseInterval(intervals[instrument]);
    quotes.set(symbol, {
      venue: "bybit",
      symbol,
      instrument,
      rate,
      intervalMinutes: cached ?? DEFAULT_FUNDING_INTERVAL_MINUTES,
      intervalSource: cached === null ? "assumed" : "api",
      nextFundingTs: parseTs(entry.nextFundingTime),
      markPrice: parsePrice(entry.markPrice),
    });
  }

  return quotes;
}

/**
 * Reduce an `/v5/market/instruments-info` payload to `instrument -> minutes`.
 *
 * Bybit reports `fundingInterval` in **minutes** (480 for the usual 8 hours),
 * which is what the whole feature stores; no unit conversion happens anywhere
 * else, precisely so there is only one place to get it wrong.
 */
export function parseBybitIntervals(
  payload: unknown,
  assets: string[],
): Record<string, number> {
  const wanted = bybitWanted(normaliseAssets(assets));
  const out: Record<string, number> = {};

  for (const raw of bybitList(payload, "instruments-info")) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry?.symbol !== "string") continue;
    const instrument = entry.symbol.toUpperCase();
    if (!wanted.has(instrument) || instrument in out) continue;

    const minutes = parseInterval(entry.fundingInterval);
    if (minutes === null) continue;
    out[instrument] = minutes;
  }

  return out;
}

/** GET a JSON body with the shared headers and timeout. Never sends a key. */
async function fetchFundingJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: fundingHeaders(),
    signal: AbortSignal.timeout(FUNDING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The whole linear-perp board in one request, reduced to `assets`.
 *
 * `_env` is accepted for symmetry with every other fetcher in the app and is
 * deliberately unused: see the credential note in the module docblock.
 */
export async function fetchBybitFunding(
  assets: string[],
  _env?: Env,
  intervals: Record<string, number> = {},
): Promise<Map<string, FundingQuote>> {
  const wanted = normaliseAssets(assets);
  if (wanted.length === 0) return new Map();

  const payload = await fetchFundingJson(
    `${BYBIT_BASE}${BYBIT_TICKERS_PATH}?category=linear`,
  );
  return parseBybitTickers(payload, wanted, intervals);
}

/**
 * Fetch the settlement cadence of every requested instrument.
 *
 * Split from {@link fetchBybitFunding} because the answer is near-static: the
 * scan caches it for a day (see `FUNDING_INTERVAL_CACHE_TTL_MS`) and only pays
 * for this request when the cache is cold or stale.
 */
export async function fetchBybitIntervals(
  assets: string[],
  _env?: Env,
): Promise<Record<string, number>> {
  const wanted = normaliseAssets(assets);
  if (wanted.length === 0) return {};

  const payload = await fetchFundingJson(
    `${BYBIT_BASE}${BYBIT_INSTRUMENTS_PATH}?category=linear&limit=1000`,
  );
  return parseBybitIntervals(payload, wanted);
}

// ---------------------------------------------------------------------------
// OKX
// ---------------------------------------------------------------------------

/**
 * Parse one `/api/v5/public/funding-rate` response for `symbol`.
 *
 * OKX signals failure with a string `code` (`"0"` is success), so a numeric
 * comparison would silently accept every error. Returns `null` for anything
 * unusable — this is a per-instrument call and one bad instrument must cost one
 * row, not the snapshot.
 *
 * The cadence is **derived**, not published: `nextFundingTime - fundingTime` is
 * the length of one settlement period, so an 8-hour contract yields exactly
 * 480 minutes and is tagged `'api'`, not `'assumed'`.
 */
export function parseOkxFundingRate(
  payload: unknown,
  symbol: string,
): FundingQuote | null {
  const envelope = (payload ?? {}) as { code?: unknown; data?: unknown };
  if (String(envelope.code) !== "0") return null;

  const row = Array.isArray(envelope.data) ? envelope.data[0] : null;
  if (!row || typeof row !== "object") return null;
  const entry = row as Record<string, unknown>;

  const asset = symbol.trim().toUpperCase();
  const instrument = okxInstrument(asset);
  // A reply for a different contract is a bug or a mixed-up retry, and
  // recording it under this symbol would be worse than recording nothing.
  if (typeof entry.instId === "string" && entry.instId.toUpperCase() !== instrument) {
    return null;
  }

  const rate = parseRate(entry.fundingRate);
  if (rate === null) return null;

  const fundingTs = parseTs(entry.fundingTime);
  const nextFundingTs = parseTs(entry.nextFundingTime);
  const derived =
    fundingTs !== null && nextFundingTs !== null
      ? parseInterval((nextFundingTs - fundingTs) / 60_000)
      : null;

  return {
    venue: "okx",
    symbol: asset,
    instrument,
    rate,
    intervalMinutes: derived ?? DEFAULT_FUNDING_INTERVAL_MINUTES,
    intervalSource: derived === null ? "assumed" : "api",
    nextFundingTs,
    // The funding-rate endpoint carries no mark price, and fetching one per
    // instrument would double an already per-instrument fallback's cost.
    markPrice: null,
  };
}

/**
 * One request per instrument, concurrently.
 *
 * `Promise.allSettled` rather than `all`: this is already the fallback path, so
 * a partial board is strictly better than none, and the caller judges the
 * result by size.
 */
export async function fetchOkxFunding(
  assets: string[],
  _env?: Env,
): Promise<Map<string, FundingQuote>> {
  const quotes = new Map<string, FundingQuote>();
  const wanted = normaliseAssets(assets);
  if (wanted.length === 0) return quotes;

  const settled = await Promise.allSettled(
    wanted.map(async (asset) => {
      const payload = await fetchFundingJson(
        `${OKX_BASE}${OKX_FUNDING_PATH}?instId=${okxInstrument(asset)}`,
      );
      return parseOkxFundingRate(payload, asset);
    }),
  );

  for (const result of settled) {
    if (result.status !== "fulfilled" || result.value === null) continue;
    quotes.set(result.value.symbol, result.value);
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FundingDeps {
  /** Day-cached `instrument -> minutes` map; see `src/db.ts`. */
  intervals?: Record<string, number>;
  fetchBybit?: (
    assets: string[],
    env?: Env,
    intervals?: Record<string, number>,
  ) => Promise<Map<string, FundingQuote>>;
  fetchOkx?: (assets: string[], env?: Env) => Promise<Map<string, FundingQuote>>;
}

/**
 * Best-effort funding board for `assets`: Bybit first, OKX as fallback.
 *
 * The Bybit board is accepted only if it covered at least
 * {@link FUNDING_COVERAGE_THRESHOLD} of the requested assets. Throws — naming
 * both failures, in the same shape as
 * {@link import("./binance").getSnapshot} — only when neither venue answered.
 */
export async function getFundingSnapshot(
  assets: string[],
  env: Env,
  deps: FundingDeps = {},
): Promise<FundingSnapshot> {
  const wanted = normaliseAssets(assets);
  const intervals = deps.intervals ?? {};
  const fetchBybit = deps.fetchBybit ?? fetchBybitFunding;
  const fetchOkx = deps.fetchOkx ?? fetchOkxFunding;
  const failures: string[] = [];

  if (wanted.length > 0) {
    try {
      const quotes = await fetchBybit(wanted, env, intervals);
      if (quotes.size / wanted.length >= FUNDING_COVERAGE_THRESHOLD) {
        return { venue: "bybit", ts: Date.now(), quotes };
      }
      failures.push(`bybit: covered only ${quotes.size}/${wanted.length} symbols`);
    } catch (err) {
      failures.push(`bybit: ${errorMessage(err)}`);
    }
  }

  try {
    const quotes = await fetchOkx(wanted, env);
    if (quotes.size > 0 || wanted.length === 0) {
      return { venue: "okx", ts: Date.now(), quotes };
    }
    failures.push("okx: none of the requested symbols returned a funding rate");
  } catch (err) {
    failures.push(`okx: ${errorMessage(err)}`);
  }

  throw new Error(`no funding-rate source available (${failures.join("; ")})`);
}

/** Signature of {@link getFundingSnapshot}; the seam tests substitute. */
export type FundingFetcher = (
  assets: string[],
  env: Env,
  deps?: FundingDeps,
) => Promise<FundingSnapshot>;

/**
 * Module-level seam, exactly like
 * {@link import("./binance").setWsCollector}. Production never calls the
 * setter; tests swap in a stub and restore the default afterwards.
 */
let activeFundingFetcher: FundingFetcher = getFundingSnapshot;

/** Replace the default funding fetcher. Pass `null` to restore it. */
export function setFundingFetcher(fetcher: FundingFetcher | null): void {
  activeFundingFetcher = fetcher ?? getFundingSnapshot;
}

/** The funding fetcher currently in effect. */
export function getFundingFetcher(): FundingFetcher {
  return activeFundingFetcher;
}
