/**
 * Dated-futures basis client (OKX).
 *
 * Mirrors `src/funding.ts` in shape — module seam, per-call dependency
 * injection, pure exported parsers, a header builder that takes no `Env` — so
 * there is one way to reason about every upstream in this app. It differs in
 * two ways, both deliberate:
 *
 * - **One venue.** OKX is the only perp/futures venue observed to serve from
 *   Cloudflare's egress (Binance and Bybit REST answer 403/451 to it in
 *   production; see the funding module's header and
 *   `docs/superpowers/specs/2026-07-31-funding-venue-probe.md`). A one-venue
 *   board needs no `allSettled` fan-out and no per-venue outcome vocabulary: it
 *   either answered or it did not.
 * - **Two subrequests that are useless apart.** A basis is a *pair* of prices,
 *   so the futures board and the spot board are fetched together and the whole
 *   poll fails if either does. There is no partial answer to degrade to — half a
 *   basis is not a smaller basis, it is not a basis.
 *
 * The sources, both unauthenticated and both one request for the whole board:
 *
 * - `GET /api/v5/market/tickers?instType=FUTURES` — every dated future OKX
 *   lists, with top-of-book and last.
 * - `GET /api/v5/market/tickers?instType=SPOT` — every spot market, same shape.
 *
 * ## What counts as a contract this board can price
 *
 * OKX names a dated future `<BASE>-<QUOTE>-<YYMMDD>` and settles it at **08:00
 * UTC** on that date (verified against `expTime` from `/public/instruments` for
 * the captured fixture — see `test/basis-fetch.test.ts`). Three shapes ride
 * along on the same endpoint and only one of them is wanted:
 *
 * | instId | What it is | Kept? |
 * |---|---|---|
 * | `BTC-USDT-260925`, `BTC-USD_UM-260925` | linear, quoted and margined in the USD unit | **yes** |
 * | `BTC-USD-260925` | *inverse*, coin-margined (settle currency BTC) | no |
 * | `BTC-USD_UM_XPERP-310404` | a perpetual-style contract with a nominal 5-year expiry | no |
 *
 * The inverse board is excluded because it is a different product: its P&L is
 * non-linear in the price and its margin is the coin itself, so pairing it
 * against a USDT spot leg would report a delta-neutral trade that is not one.
 * The `XPERP` board is excluded because a "dated" future five years out with a
 * funding-style tether is a perp wearing an expiry, and the whole premise of
 * this strategy is convergence you can actually wait for — those contracts
 * belong to the funding board, which already prices that trade properly.
 *
 * **Both linear quote spellings are accepted, and that is not future-proofing.**
 * The live OKX board captured for this phase's fixtures carries *only*
 * `USD_UM`-quoted linear dated futures — the classic `-USDT-` spelling the
 * planning notes assumed returned zero rows. Rather than pick one and be wrong
 * on some other day or in some other region, {@link LINEAR_QUOTE_SEGMENTS} lists
 * both, and anything outside that set is skipped rather than guessed at.
 *
 * **No credential ever leaves for this host.** {@link basisHeaders} takes no
 * `Env` at all, so there is no code path — not even a mistaken `true` at a call
 * site — by which a Binance API key could be attached to an OKX request. That is
 * a structural guarantee, not a convention.
 */
import { USER_AGENT } from "./binance";
import { BASE_ASSET } from "./config";
import { round8 } from "./engine";
import { OKX_BASE } from "./funding";
import type { Env } from "./types";

/** The one venue this board is quoted from. Stored on every row. */
export const BASIS_VENUE = "okx";

const OKX_TICKERS_PATH = "/api/v5/market/tickers";

/**
 * Per-call timeout, matching `FUNDING_TIMEOUT_MS`.
 *
 * The spot board is ~420KB of JSON — the largest single response this app
 * fetches — so the budget has to cover a cold TLS handshake plus that transfer
 * on a slow link. The two requests run concurrently, so the poll costs one
 * timeout rather than two, and `SCAN_LOCK_TTL_MS` (45s) is untouched.
 */
export const BASIS_TIMEOUT_MS = 9000;

/**
 * The quote segments of an instId that mean "linear, quoted in the USD unit".
 *
 * `USDT` is the classic spelling; `USD_UM` is what OKX's live board uses for its
 * USD-margined (`ctType: 'linear'`, `settleCcy: 'USD'`) dated futures. Both are
 * joined against the `<BASE>-USDT` spot market, which is the approximation this
 * whole board rests on: the USD unit an OKX linear future is quoted in is taken
 * to be worth one USDT. At any stablecoin peg worth trading that is true to a
 * few basis points; if the peg ever breaks, every figure on this board is wrong
 * by the size of the break, and it is worth knowing that is where it would come
 * from.
 */
export const LINEAR_QUOTE_SEGMENTS: ReadonlySet<string> = new Set([
  "USDT",
  "USD_UM",
]);

/** OKX settles its dated futures at 08:00 UTC on the date in the instId. */
export const OKX_SETTLEMENT_HOUR_UTC = 8;

/** Headers for every basis request. Takes no `Env`; see the module docblock. */
function basisHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
}

/** Parse a decimal-string price, rejecting garbage and non-positive values. */
function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * The price a leg is marked at: the mid of the book, falling back to `last`.
 *
 * **Mid on both legs, always.** The alternative — marking the spot leg at the
 * ask (what a buyer pays) and the futures leg at the bid (what a seller
 * receives) — would be the *executable* basis and is strictly more honest about
 * entry. It is not used, for one reason: it charges the bid/ask spread on entry
 * and nothing on exit, and this trade's exit is a settlement at a converged
 * price rather than a second round trip. Half a spread charged asymmetrically is
 * a worse model than none charged at all, and the fee drag is already the term
 * that carries the cost of trading. So both legs are mid, the figure is quoted
 * as an upper bound, and the README says so.
 *
 * `last` is the fallback rather than a skip because a thin far-dated contract
 * routinely has one side of its book empty for minutes at a time while trades
 * still print. It is marked as a fallback on the row (`priceSource`) so a reader
 * can tell a live two-sided quote from a stale print.
 *
 * The mid is quantised through {@link round8} for the reason every derived
 * figure in this repo is: `(62784.6 + 62784.7) / 2` is `62784.649999999994` in
 * IEEE-754, and that noise would be persisted, served, and shown to someone
 * checking the row back against the venue's own book.
 */
export function midPrice(
  bid: unknown,
  ask: unknown,
  last: unknown,
): { price: number; source: "mid" | "last" } | null {
  const b = parsePrice(bid);
  const a = parsePrice(ask);
  if (b !== null && a !== null) return { price: round8((b + a) / 2), source: "mid" };
  const l = parsePrice(last);
  if (l !== null) return { price: l, source: "last" };
  return null;
}

/** A dated future's identity, recovered from its instId. */
export interface OkxFutureId {
  /** Canonical asset symbol, e.g. `BTC`. */
  symbol: string;
  /** Epoch millis of settlement: 08:00 UTC on the date in the name. */
  expiryTs: number;
}

/**
 * `BTC-USD_UM-260925` -> `{ symbol: 'BTC', expiryTs: … }`.
 *
 * `null` for anything that is not a **linear, USD-quoted, genuinely dated**
 * contract: an inverse `BTC-USD-260925`, a perpetual `BTC-USDT-SWAP`, an
 * `XPERP`, a name with the wrong number of segments, or a date that is not a
 * real calendar date. The date is validated by round-tripping it through
 * `Date.UTC`, so `260931` (September has 30 days) is rejected rather than
 * silently rolling into October.
 */
export function parseOkxFutureId(instId: unknown): OkxFutureId | null {
  if (typeof instId !== "string") return null;
  const parts = instId.trim().toUpperCase().split("-");
  if (parts.length !== 3) return null;

  const [symbol, quote, expiry] = parts;
  if (symbol.length === 0) return null;
  if (!LINEAR_QUOTE_SEGMENTS.has(quote)) return null;
  if (!/^\d{6}$/.test(expiry)) return null;

  // OKX writes the year with two digits; the contract board has never listed
  // anything before 2000 and nothing on it runs past 2099.
  const year = 2000 + Number(expiry.slice(0, 2));
  const month = Number(expiry.slice(2, 4));
  const day = Number(expiry.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const ts = Date.UTC(year, month - 1, day, OKX_SETTLEMENT_HOUR_UTC);
  const back = new Date(ts);
  // `Date.UTC(2026, 8, 31)` silently becomes 1 October; the round trip catches
  // it, so an impossible date is a skipped row rather than a wrong expiry.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }

  return { symbol, expiryTs: ts };
}

/**
 * OKX's v5 envelope. `code` is the *string* `"0"` on success — a numeric
 * comparison would silently accept every error — and the transport answers 200
 * with the failure in the body, so an `res.ok` check alone would read an error
 * as an empty board.
 */
function okxRows(payload: unknown, what: string): Record<string, unknown>[] {
  const envelope = (payload ?? {}) as { code?: unknown; msg?: unknown; data?: unknown };
  if (String(envelope.code) !== "0") {
    const msg = typeof envelope.msg === "string" && envelope.msg ? envelope.msg : "unknown error";
    throw new Error(`okx ${what} code ${String(envelope.code)}: ${msg}`);
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error(`okx ${what}: data was not an array`);
  }
  return envelope.data as Record<string, unknown>[];
}

/**
 * Reduce a `?instType=SPOT` payload to `instId -> mark`, keeping only the
 * markets quoted in {@link BASE_ASSET}.
 *
 * Narrowed here rather than at the join because the spot board is ~1300 markets
 * across a dozen quote currencies and only the USDT ones can settle the cash leg
 * of this trade. `ETH-BTC` is a market, not a spot leg for a USDT carry.
 */
export function parseOkxSpotMarks(
  payload: unknown,
): Map<string, { price: number; source: "mid" | "last" }> {
  const marks = new Map<string, { price: number; source: "mid" | "last" }>();
  const suffix = `-${BASE_ASSET}`;

  for (const entry of okxRows(payload, "spot tickers")) {
    if (typeof entry.instId !== "string") continue;
    const instId = entry.instId.trim().toUpperCase();
    if (!instId.endsWith(suffix)) continue;

    const symbol = instId.slice(0, -suffix.length);
    if (symbol.length === 0 || marks.has(symbol)) continue;

    const mark = midPrice(entry.bidPx, entry.askPx, entry.last);
    if (mark === null) continue;
    marks.set(symbol, mark);
  }

  return marks;
}

/** One dated future joined to its spot leg. The row {@link src/engine/basis} prices. */
export interface BasisQuote {
  venue: string;
  /** Canonical asset symbol, e.g. `BTC`. */
  symbol: string;
  /** The venue's own contract name — what to paste into OKX's own UI. */
  instrument: string;
  /** Epoch millis of settlement. */
  expiryTs: number;
  spotPrice: number;
  futurePrice: number;
  /**
   * `'mid'` when **both** legs came from a two-sided book, `'last'` when either
   * fell back to the last trade. One flag rather than two because a reader only
   * ever asks "is this quote live", and a row is only as live as its weaker leg.
   */
  priceSource: "mid" | "last";
}

/**
 * Join a futures board to a spot board, best-effort per contract.
 *
 * Skipped, per contract and silently: anything {@link parseOkxFutureId} rejects,
 * a contract whose `<BASE>-USDT` spot market OKX does not list (tokenised gold
 * futures such as `XAU-USD_UM-260828` are the live example — there is no spot
 * leg to buy, so there is no carry), and either leg being unpriceable.
 *
 * Duplicate instIds keep the first: the board carries each contract once, and
 * where it does not, first-seen is the venue's own order.
 *
 * Throws only for a failed envelope on either board — which is what makes "the
 * poll failed" distinguishable from "the poll found nothing to price".
 */
export function buildBasisBoard(
  futuresPayload: unknown,
  spotPayload: unknown,
): BasisQuote[] {
  const marks = parseOkxSpotMarks(spotPayload);
  const rows = okxRows(futuresPayload, "futures tickers");

  const quotes: BasisQuote[] = [];
  const seen = new Set<string>();

  for (const entry of rows) {
    const id = parseOkxFutureId(entry.instId);
    if (id === null) continue;

    const instrument = String(entry.instId).trim().toUpperCase();
    if (seen.has(instrument)) continue;

    const spot = marks.get(id.symbol);
    if (!spot) continue;

    const future = midPrice(entry.bidPx, entry.askPx, entry.last);
    if (future === null) continue;

    seen.add(instrument);
    quotes.push({
      venue: BASIS_VENUE,
      symbol: id.symbol,
      instrument,
      expiryTs: id.expiryTs,
      spotPrice: spot.price,
      futurePrice: future.price,
      priceSource: spot.source === "mid" && future.source === "mid" ? "mid" : "last",
    });
  }

  return quotes;
}

/** A point-in-time view of the whole dated-futures board. */
export interface BasisSnapshot {
  /** Epoch millis at which the snapshot was completed. */
  ts: number;
  quotes: BasisQuote[];
}

/** GET a JSON body with the shared headers and timeout. Never sends a key. */
async function fetchBasisJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: basisHeaders(),
    signal: AbortSignal.timeout(BASIS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface BasisDeps {
  fetchFutures?: (env?: Env) => Promise<unknown>;
  fetchSpot?: (env?: Env) => Promise<unknown>;
}

/** The whole OKX dated-futures ticker board in one request. */
export async function fetchOkxFuturesTickers(_env?: Env): Promise<unknown> {
  return fetchBasisJson(`${OKX_BASE}${OKX_TICKERS_PATH}?instType=FUTURES`);
}

/** The whole OKX spot ticker board in one request. */
export async function fetchOkxSpotTickers(_env?: Env): Promise<unknown> {
  return fetchBasisJson(`${OKX_BASE}${OKX_TICKERS_PATH}?instType=SPOT`);
}

/**
 * Fetch both boards concurrently and join them.
 *
 * `Promise.all`, **not** `allSettled` — the deliberate opposite of the funding
 * poll. There, each venue's failure costs its own rows and a partial board is
 * strictly better than none. Here the two responses are two halves of one
 * measurement: without the spot board there is nothing to compare the futures
 * board *to*, so a half-answer is no answer and the caller is told so by a throw.
 *
 * An empty board is **not** a throw. OKX delisting every dated future, or
 * listing only inverse ones, is a real and reportable state of the world — see
 * the table in the module docblock, where the live capture for this phase had
 * exactly zero contracts under the spelling the planning notes assumed.
 */
export async function getBasisSnapshot(
  env: Env,
  deps: BasisDeps = {},
): Promise<BasisSnapshot> {
  const [futures, spot] = await Promise.all([
    (deps.fetchFutures ?? fetchOkxFuturesTickers)(env),
    (deps.fetchSpot ?? fetchOkxSpotTickers)(env),
  ]);
  return { ts: Date.now(), quotes: buildBasisBoard(futures, spot) };
}

/** Signature of {@link getBasisSnapshot}; the seam tests substitute. */
export type BasisFetcher = (env: Env, deps?: BasisDeps) => Promise<BasisSnapshot>;

/**
 * Module-level seam, exactly like
 * {@link import("./funding").setFundingFetcher}. Production never calls the
 * setter; tests swap in a stub and restore the default afterwards.
 */
let activeBasisFetcher: BasisFetcher = getBasisSnapshot;

/** Replace the default basis fetcher. Pass `null` to restore it. */
export function setBasisFetcher(fetcher: BasisFetcher | null): void {
  activeBasisFetcher = fetcher ?? getBasisSnapshot;
}

/** The basis fetcher currently in effect. */
export function getBasisFetcher(): BasisFetcher {
  return activeBasisFetcher;
}
