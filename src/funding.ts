/**
 * Funding-rate client for the cash-and-carry scanner.
 *
 * Mirrors `src/binance.ts` in shape — module seam, per-call dependency
 * injection, pure exported parsers — so there is one way to reason about every
 * upstream in this app. It differs in one deliberate way: there is **no
 * fallback chain**. Every configured venue is polled on every board, under
 * `Promise.allSettled`, and each one's failure costs exactly its own rows.
 *
 * Phase 14 made that switch. A primary/fallback chain answers "which venue do
 * we trust most", which is the wrong question once the venues quote *different
 * universes*: Bybit's board covers the majors, Gate's and KuCoin's cover 850+
 * and 660+ contracts, and the fat tail of funding is precisely what the
 * majors-only board could not see. Two venues disagreeing about BTC's funding
 * is also a measurement, not a conflict — `funding_rates` is keyed by
 * `(venue, symbol)` and always was.
 *
 * The sources:
 *
 * - **Bybit v5 `/v5/market/tickers?category=linear`.** One unauthenticated
 *   request returns the funding rate of every linear perp; the response carries
 *   no settlement interval, which is why {@link fetchBybitIntervals} exists as a
 *   separate, day-cached call. Reduced to the majors — the cadence cache is
 *   keyed on them.
 * - **OKX `/api/v5/public/funding-rate?instId=…`.** One request *per
 *   instrument*, so it stays capped at the majors: widening OKX to a full board
 *   would cost one subrequest per contract and blow the plan limit on its own.
 * - **Gate `/api/v4/futures/usdt/contracts`.** One request, every USDT-margined
 *   perp, funding rate and interval included.
 * - **KuCoin futures `/api/v1/contracts/active`.** One request, same deal.
 *
 * Gate and KuCoin are new here and **unverified from Cloudflare's egress**:
 * Binance and Bybit REST answer 403 to it in production and OKX does not, and
 * which way these two fall is not knowable until phase 18 deploys. That is
 * exactly why they are added as two more `allSettled` branches rather than as
 * links in a chain — a venue that turns out to be blocked costs its own rows
 * and a string in `ScanResult.fundingVenueErrors`, and nothing else.
 *
 * **No credential ever leaves for these hosts.** {@link fundingHeaders} takes no
 * `Env` at all, so there is no code path — not even a mistaken `true` at a call
 * site — by which a Binance API key could be attached to a perp-venue request.
 * That is a structural guarantee, not a convention.
 */
import { USER_AGENT } from "./binance";
import { FUNDING_BOARD_BOTTOM_N, FUNDING_BOARD_TOP_N } from "./config";
import { DEFAULT_FUNDING_INTERVAL_MINUTES } from "./engine";
import type { Env, FundingVenue } from "./types";

/** Bybit v5 public market data. No auth, no key, no signature. */
export const BYBIT_BASE = "https://api.bybit.com";
const BYBIT_TICKERS_PATH = "/v5/market/tickers";
const BYBIT_INSTRUMENTS_PATH = "/v5/market/instruments-info";

/** OKX v5 public market data, same terms. */
export const OKX_BASE = "https://www.okx.com";
const OKX_FUNDING_PATH = "/api/v5/public/funding-rate";

/** Gate v4 public futures metadata. No auth, no key, no signature. */
export const GATE_BASE = "https://api.gateio.ws";
const GATE_CONTRACTS_PATH = "/api/v4/futures/usdt/contracts";

/** KuCoin futures public contract list, same terms. */
export const KUCOIN_BASE = "https://api-futures.kucoin.com";
const KUCOIN_CONTRACTS_PATH = "/api/v1/contracts/active";

/**
 * Every venue polled on a board, in report order.
 *
 * **Subrequest budget** (Cloudflare's free plan allows 50 per invocation, and
 * one scan is one invocation):
 *
 * ```
 * spot   Binance WS 1 + MEXC REST 1 (+1 discovery on a cold pairs table) <= 3
 * perp   bybit tickers        1
 *        bybit instruments    1   (day-cached; usually 0)
 *        okx funding-rate    11   (one per major — the only per-instrument leg)
 *        gate contracts       1
 *        kucoin contracts     1
 *                           ---
 *        funding worst case  15
 * basis  okx tickers FUTURES  1   (Phase 17; see `src/basis.ts`)
 *        okx tickers SPOT     1
 *                           ---
 *        basis worst case     2
 * total worst case            20  <= 50
 * ```
 *
 * The margin is what pays for a future venue: every full-board venue costs one
 * subrequest, so this list can roughly triple before the budget is the binding
 * constraint. What must *not* grow is the OKX leg — it is priced per contract,
 * so pointing it at a full board would cost ~600 subrequests by itself. That is
 * why the universe widening in Phase 14 goes through Gate and KuCoin only.
 *
 * The basis pair is counted here rather than in `src/basis.ts` because the
 * budget is a property of the *invocation*, and one scan is one invocation: a
 * table split across two modules would be two tables that disagree. Both of its
 * legs are full-board single requests and neither scales with the universe, so
 * a second basis venue would cost exactly two more.
 *
 * **Kraken futures is deliberately absent.** Its perps fund continuously and
 * accrue per hour against a different reference, so normalising it into the
 * per-settlement `rate` this module stores would produce a number that looks
 * comparable and is not. Modelling it wrong is worse than omitting it; it is
 * noted as future work in the README.
 */
export const FUNDING_VENUES: readonly FundingVenue[] = [
  "bybit",
  "okx",
  "gate",
  "kucoin",
] as const;

/**
 * Per-call timeout.
 *
 * Raised from 6s in Phase 14: the Gate and KuCoin boards are ~1.1MB and ~1.3MB
 * of JSON against Bybit's few hundred KB, and a timeout tight enough to clip a
 * cold TLS handshake plus a megabyte of transfer would read as "venue down"
 * every time the link was slow. Still well inside the scan's budget — the four
 * venues run concurrently, so the funding block costs one timeout, not four,
 * and {@link import("./scan").SCAN_LOCK_TTL_MS} (45s) is untouched.
 */
export const FUNDING_TIMEOUT_MS = 9000;

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

/** How one venue's leg of a poll turned out. Recorded whether it worked or not. */
export interface VenueOutcome {
  venue: FundingVenue;
  /** Quotes this venue contributed. `0` on failure, and on an empty board. */
  count: number;
  /** `null` when the venue answered; the reason, prefixed, when it did not. */
  error: string | null;
}

/**
 * A point-in-time view of **every** venue's funding board.
 *
 * `quotes` is a flat array rather than the `Map` keyed by symbol this used to
 * be: with four venues polled at once the same symbol appears up to four times,
 * and a symbol-keyed map would silently keep whichever venue happened to be
 * last. Comparing venues *is* the feature.
 */
export interface FundingSnapshot {
  /** Epoch millis at which the snapshot was completed. */
  ts: number;
  /** Every venue's quotes, flat. Symbols repeat across venues. */
  quotes: FundingQuote[];
  /** One entry per venue attempted, in {@link FUNDING_VENUES} order. */
  venues: VenueOutcome[];
  /** The venues that contributed at least one quote, in the same order. */
  served: FundingVenue[];
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

/**
 * Parse a positive, finite duration in whatever unit the venue publishes it.
 *
 * Deliberately unit-blind: Gate quotes its funding interval in seconds and
 * KuCoin in milliseconds, and the conversion to the minutes this app stores
 * happens once, visibly, at each call site. A helper that guessed the unit
 * would be a factor-of-1000 bug waiting for its first venue.
 */
function parseDuration(value: unknown): number | null {
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
// Gate
// ---------------------------------------------------------------------------

/**
 * Contract types Gate lists on its USDT futures board that are **not crypto
 * perps**: tokenised equities, index, commodity, forex and metal contracts.
 *
 * They are excluded because the strategy this scanner prices is *cash and
 * carry*: long the spot asset, short its perp. There is no spot leg for a
 * synthetic Tesla or gold contract on a crypto exchange, so a fat funding rate
 * on one is not an opportunity — it is a row that would push a real one out of
 * the per-venue top 25.
 *
 * A **deny** list rather than an allow list on purpose: crypto perps carry an
 * empty `contract_type`, and an allow list of `""` would silently empty the
 * whole board the day Gate starts labelling them `"crypto"`.
 *
 * KuCoin has no equivalent list because its board carried no non-crypto perps
 * when it was captured — an observed asymmetry, not a principled one, so the
 * day KuCoin lists tokenised equities it needs a list of its own.
 */
const GATE_NON_CRYPTO_TYPES = new Set([
  "stocks",
  "indices",
  "commodities",
  "forex",
  "metals",
]);

/** Gate's USDT board names every contract `<BASE>_USDT`. */
const GATE_SUFFIX = "_USDT";

/**
 * `BTC_USDT` -> `BTC`. `null` for anything not a USDT-margined contract.
 *
 * The multiplier prefix is **kept**: `1000PEPE_USDT` normalises to `1000PEPE`,
 * not `PEPE`. KuCoin names the same contract `1000PEPEUSDTM`, so keeping it is
 * what makes the two venues' rows line up — and the row's whole purpose is to
 * be reproducible on the venue's own UI.
 */
export function gateBaseAsset(name: string): string | null {
  const upper = name.trim().toUpperCase();
  if (!upper.endsWith(GATE_SUFFIX)) return null;
  const base = upper.slice(0, -GATE_SUFFIX.length);
  return base.length > 0 ? base : null;
}

/**
 * Reduce a `/futures/usdt/contracts` payload to a board keyed by base asset.
 *
 * Gate answers with a bare array — no envelope, no status field — so a failed
 * request is an HTTP status, which {@link fetchFundingJson} already turns into
 * a throw. Anything that is not an array here is therefore a shape change, and
 * it throws rather than reading as an empty board.
 *
 * Skipped, per contract and silently: non-USDT names, delisting or non-trading
 * contracts, pre-market listings (no spot leg exists yet), the non-crypto
 * contract types above, and any unusable rate. `funding_interval` is published
 * in **seconds**, so every row is `'api'` unless the field is junk.
 */
export function parseGateContracts(payload: unknown): Map<string, FundingQuote> {
  const quotes = new Map<string, FundingQuote>();
  if (!Array.isArray(payload)) {
    throw new Error("gate contracts: payload was not an array");
  }

  for (const raw of payload) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (typeof entry.name !== "string") continue;

    const symbol = gateBaseAsset(entry.name);
    if (symbol === null || quotes.has(symbol)) continue;

    if (entry.in_delisting === true) continue;
    if (entry.is_pre_market === true) continue;
    if (typeof entry.status === "string" && entry.status !== "trading") continue;
    if (typeof entry.type === "string" && entry.type !== "direct") continue;
    if (
      typeof entry.contract_type === "string" &&
      GATE_NON_CRYPTO_TYPES.has(entry.contract_type)
    ) {
      continue;
    }

    const rate = parseRate(entry.funding_rate);
    if (rate === null) continue;

    // Gate publishes the cadence in seconds: 28800 -> 480 minutes.
    const seconds = parseDuration(entry.funding_interval);
    const minutes = seconds === null ? null : parseInterval(seconds / 60);
    // Published in seconds since the epoch, unlike every other venue here.
    const nextSeconds = parseTs(entry.funding_next_apply);

    quotes.set(symbol, {
      venue: "gate",
      symbol,
      instrument: entry.name.trim().toUpperCase(),
      rate,
      intervalMinutes: minutes ?? DEFAULT_FUNDING_INTERVAL_MINUTES,
      intervalSource: minutes === null ? "assumed" : "api",
      nextFundingTs: nextSeconds === null ? null : nextSeconds * 1000,
      markPrice: parsePrice(entry.mark_price),
    });
  }

  return quotes;
}

/**
 * The whole Gate USDT perp board in one request.
 *
 * Takes no asset list: the board *is* the point, and narrowing it here would
 * undo the widening. The caller caps what gets persisted — see
 * {@link capFundingBoard}.
 */
export async function fetchGateFunding(_env?: Env): Promise<Map<string, FundingQuote>> {
  const payload = await fetchFundingJson(`${GATE_BASE}${GATE_CONTRACTS_PATH}`);
  return parseGateContracts(payload);
}

// ---------------------------------------------------------------------------
// KuCoin futures
// ---------------------------------------------------------------------------

/** KuCoin's linear USDT-margined perpetuals all end in `USDTM`. */
const KUCOIN_SUFFIX = "USDTM";

/** KuCoin's contract type for a perpetual swap. `FFICSX` is a dated future. */
const KUCOIN_PERPETUAL_TYPE = "FFWCSX";

/**
 * KuCoin still calls Bitcoin `XBT`, the old ISO-style ticker.
 *
 * Mapped to `BTC` so one symbol means one asset across the whole table; the
 * `instrument` column keeps `XBTUSDTM`, which is what someone reproducing the
 * row has to paste into KuCoin's own UI.
 */
const KUCOIN_ASSET_ALIASES: Record<string, string> = { XBT: "BTC" };

/** `XBTUSDTM` -> `BTC`. `null` for anything not a USDT-margined perp. */
export function kucoinBaseAsset(symbol: string): string | null {
  const upper = symbol.trim().toUpperCase();
  if (!upper.endsWith(KUCOIN_SUFFIX)) return null;
  const base = upper.slice(0, -KUCOIN_SUFFIX.length);
  if (base.length === 0) return null;
  return KUCOIN_ASSET_ALIASES[base] ?? base;
}

/**
 * Reduce a `/contracts/active` payload to a board keyed by base asset.
 *
 * KuCoin wraps everything in `{ code, data }` where `code` is the *string*
 * `"200000"` on success, so — exactly as with OKX's `"0"` — the comparison is
 * made as a string. A numeric one would accept every error code.
 *
 * Skipped, per contract: anything not `<BASE>USDTM` (the USDC- and
 * inverse-margined boards ride along in the same response), dated futures,
 * contracts with an `expireDate` (KuCoin sets one on a perp scheduled for
 * delisting — a carry you cannot hold to the end is not one worth ranking),
 * anything not `Open`, and any unusable rate. `fundingRateGranularity` is
 * published in **milliseconds**.
 */
export function parseKucoinContracts(payload: unknown): Map<string, FundingQuote> {
  const quotes = new Map<string, FundingQuote>();
  const envelope = (payload ?? {}) as { code?: unknown; msg?: unknown; data?: unknown };

  if (String(envelope.code) !== "200000") {
    const msg = typeof envelope.msg === "string" ? envelope.msg : "unknown error";
    throw new Error(`kucoin code ${String(envelope.code)}: ${msg}`);
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error("kucoin contracts: data was not an array");
  }

  for (const raw of envelope.data) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (typeof entry.symbol !== "string") continue;

    const symbol = kucoinBaseAsset(entry.symbol);
    if (symbol === null || quotes.has(symbol)) continue;

    if (typeof entry.type === "string" && entry.type !== KUCOIN_PERPETUAL_TYPE) continue;
    if (typeof entry.status === "string" && entry.status !== "Open") continue;
    if (entry.expireDate !== null && entry.expireDate !== undefined) continue;

    const rate = parseRate(entry.fundingFeeRate);
    if (rate === null) continue;

    // KuCoin publishes the cadence in milliseconds: 28800000 -> 480 minutes.
    const granularityMs =
      parseDuration(entry.fundingRateGranularity) ??
      parseDuration(entry.currentFundingRateGranularity);
    const minutes = granularityMs === null ? null : parseInterval(granularityMs / 60_000);

    quotes.set(symbol, {
      venue: "kucoin",
      symbol,
      instrument: entry.symbol.trim().toUpperCase(),
      rate,
      intervalMinutes: minutes ?? DEFAULT_FUNDING_INTERVAL_MINUTES,
      intervalSource: minutes === null ? "assumed" : "api",
      nextFundingTs: parseTs(entry.nextFundingRateDateTime),
      markPrice: parsePrice(entry.markPrice),
    });
  }

  return quotes;
}

/** The whole KuCoin USDT perp board in one request. See {@link fetchGateFunding}. */
export async function fetchKucoinFunding(
  _env?: Env,
): Promise<Map<string, FundingQuote>> {
  const payload = await fetchFundingJson(`${KUCOIN_BASE}${KUCOIN_CONTRACTS_PATH}`);
  return parseKucoinContracts(payload);
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
  /** Full-board venues take no asset list: the board is the point. */
  fetchGate?: (env?: Env) => Promise<Map<string, FundingQuote>>;
  fetchKucoin?: (env?: Env) => Promise<Map<string, FundingQuote>>;
  /** Narrow the poll to a subset of {@link FUNDING_VENUES}. Tests use it. */
  venues?: readonly FundingVenue[];
}

/**
 * Poll **every** configured venue concurrently and return all of their quotes.
 *
 * `Promise.allSettled`, not `all`: a venue that 403s from Cloudflare's egress —
 * which is the observed production state of Bybit and Binance, and an open
 * question for Gate and KuCoin until phase 18 — costs its own rows and a string
 * in {@link VenueOutcome.error}, and nothing more. An empty board from a venue
 * that answered is recorded the same way, because "reachable but quoting
 * nothing" is a distinct and equally interesting failure.
 *
 * `assets` bounds the two per-major venues only: Bybit's board is reduced to
 * them (its cadence cache is keyed on them) and OKX is priced per instrument.
 * Gate and KuCoin ignore it and return their whole boards.
 *
 * Throws — naming every venue's failure, in the same shape as
 * {@link import("./binance").getSnapshot} — only when *no* venue produced a
 * single quote. That is the one case the caller cannot report as a board.
 */
export async function getFundingSnapshot(
  assets: string[],
  env: Env,
  deps: FundingDeps = {},
): Promise<FundingSnapshot> {
  const wanted = normaliseAssets(assets);
  const intervals = deps.intervals ?? {};
  const venues = deps.venues ?? FUNDING_VENUES;

  const fetchers: Record<FundingVenue, () => Promise<Map<string, FundingQuote>>> = {
    bybit: () => (deps.fetchBybit ?? fetchBybitFunding)(wanted, env, intervals),
    okx: () => (deps.fetchOkx ?? fetchOkxFunding)(wanted, env),
    gate: () => (deps.fetchGate ?? fetchGateFunding)(env),
    kucoin: () => (deps.fetchKucoin ?? fetchKucoinFunding)(env),
  };

  const settled = await Promise.allSettled(
    venues.map(async (venue) => ({ venue, quotes: await fetchers[venue]() })),
  );

  const quotes: FundingQuote[] = [];
  const outcomes: VenueOutcome[] = [];
  const served: FundingVenue[] = [];

  settled.forEach((result, i) => {
    const venue = venues[i];
    if (result.status === "rejected") {
      outcomes.push({ venue, count: 0, error: errorMessage(result.reason) });
      return;
    }

    const board = [...result.value.quotes.values()];
    if (board.length === 0) {
      outcomes.push({ venue, count: 0, error: "returned no usable funding rates" });
      return;
    }

    quotes.push(...board);
    outcomes.push({ venue, count: board.length, error: null });
    served.push(venue);
  });

  if (served.length === 0) {
    const failures = outcomes.map((o) => `${o.venue}: ${o.error}`);
    throw new Error(`no funding-rate source available (${failures.join("; ")})`);
  }

  return { ts: Date.now(), quotes, venues: outcomes, served };
}

/**
 * Trim a ranked board to what is worth persisting, **per venue**.
 *
 * Three rules, and the reason for each:
 *
 * - **Every major is kept**, whatever it pays. They are the continuous series
 *   the history route serves, and dropping BTC on the day its funding went flat
 *   would put a hole in exactly the chart someone reads to see funding go flat.
 * - **Plus that venue's best `topN` of everything else.** The tail is the point
 *   of polling a full board, but a 850-contract venue writing its whole board
 *   every 5 minutes is ~1.7M rows a week for nothing.
 * - **Plus that venue's *worst* `bottomN`.** The budget is split rather than
 *   spent entirely on the top because the ranking is signed: the engine keeps
 *   negative rows on purpose ("a deeply negative rate is the headline result of
 *   the scan on the day it happens"), and a one-sided cap then discarded every
 *   one of them. A -1548%/yr contract is not a row worth less than the 20th
 *   best positive one; it is the most interesting row on the board.
 *
 * Per venue, not globally: a venue whose whole board happens to pay less than
 * another's must still contribute its own top rows, or a single hot venue would
 * crowd every other one out of the board entirely and the cross-venue
 * comparison would quietly stop existing.
 *
 * The two halves are **deduplicated**, so a venue with fewer than
 * `topN + bottomN` non-majors keeps all of them once rather than twice. The
 * per-venue non-major budget is therefore `topN + bottomN` at most.
 *
 * **Precondition:** `ranked` is sorted by net annual carry, best first — which
 * is exactly what {@link import("./engine").rankFundingOpportunities} returns.
 * It is what makes "the last `bottomN` of a venue's rows" mean "its worst".
 * Input order is preserved in the output, so the caller's ranking survives.
 */
export function capFundingBoard<
  T extends { quote: { venue: string; symbol: string } },
>(
  ranked: readonly T[],
  majors: Iterable<string>,
  topN: number = FUNDING_BOARD_TOP_N,
  bottomN: number = FUNDING_BOARD_BOTTOM_N,
): T[] {
  const majorSet = new Set(normaliseAssets([...majors]));
  const isMajor = (row: T) => majorSet.has(row.quote.symbol.toUpperCase());

  // Where each venue's non-major rows sit in `ranked`, in ranked order — so the
  // head of the list is that venue's best-paying tail and the end is its worst.
  const positions = new Map<string, number[]>();
  ranked.forEach((row, i) => {
    if (isMajor(row)) return;
    const venue = row.quote.venue;
    const seen = positions.get(venue);
    if (seen) seen.push(i);
    else positions.set(venue, [i]);
  });

  const top = Math.max(0, topN);
  const bottom = Math.max(0, bottomN);
  const keep = new Set<number>();
  for (const indices of positions.values()) {
    for (const i of indices.slice(0, top)) keep.add(i);
    // Guarded: `slice(-0)` is `slice(0)`, i.e. the whole board.
    if (bottom > 0) for (const i of indices.slice(-bottom)) keep.add(i);
  }

  return ranked.filter((row, i) => isMajor(row) || keep.has(i));
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
