/**
 * Scan orchestration: the one code path that turns market data into persisted
 * observations. `POST /api/scan` and the cron handler both call {@link runScan},
 * so manual and scheduled scans can never drift apart.
 *
 * **Nothing here executes.** Phase 12 removed the paper-fill machinery along
 * with the triangular strategy: a scan now ranks cross-exchange spreads, polls
 * the funding board, and writes both down. No balance moves, no trade row is
 * inserted, and `scans.executed_count` keeps whatever the schema default gives
 * it. The reasoning is recorded in `docs/profitability-recommendations.md` —
 * the measured edges never survived fees, and in india mode never survived the
 * withholding either.
 */
import { getDualSnapshot, discoverPairs, type DualSnapshot } from "./binance";
import {
  ASSET_UNIVERSE,
  BASE_ASSET,
  FUNDING_BOARD_TOP_N,
  FUNDING_INTERVAL_CACHE_TTL_MS,
  FUNDING_POLL_INTERVAL_MS,
  perpAssets,
  STRATEGY_CROSS_EXCHANGE,
} from "./config";
import {
  ensureSeeded,
  finalizeScan,
  getFundingIntervals,
  getLatestFundingTs,
  getPairs,
  getRawSetting,
  getSettings,
  insertFundingRates,
  insertOpportunities,
  insertScan,
  replacePairs,
  SCAN_LOCK_KEY,
  setFundingIntervals,
  setRawSetting,
  deleteRawSetting,
  toTaxPolicy,
  type FundingRateInput,
  type OpportunityInput,
  type PairRow,
} from "./db";
import {
  rankFundingOpportunities,
  rankSpreads,
  spreadQuoteTax,
  type VenueBook,
} from "./engine";
import {
  capFundingBoard,
  fetchBybitIntervals,
  getFundingFetcher,
  type FundingFetcher,
} from "./funding";
import type { Env, FundingVenue, PairInfo, SnapshotSource } from "./types";

/**
 * How many ranked spreads are kept per scan.
 *
 * A budget rather than "everything": the whole universe is priced and ranked,
 * but only the head of the list is a measurement anybody reads back, and a
 * minutely scanner writing every market would fill D1 with rows nothing queries.
 */
export const SPREADS_PER_SCAN = 10;

/**
 * A lock older than this is treated as abandoned.
 *
 * Sized just under the 1-minute cron interval: long enough that a slow scan
 * (WebSocket deadline 4s + REST fallback 8s + D1 round-trips) is never lapped
 * by the next tick, short enough that a Worker killed mid-scan cannot wedge the
 * scanner for more than one cycle.
 */
export const SCAN_LOCK_TTL_MS = 45_000;

/** Source recorded for the pairs discovered during first-run bootstrap. */
const DISCOVERY_SOURCE = "mexc-rest";

export type ScanTrigger = "cron" | "manual";

export interface ScanResult {
  /** `null` only when the scan was skipped before a row was opened. */
  scanId: number | null;
  source: SnapshotSource | null;
  pairsCount: number;
  durationMs: number;
  error?: string;
  /** Set when an overlapping scan held the lock. */
  skipped?: boolean;
  /** Cross-exchange spreads priced; `0` when the strategy is off or degraded. */
  spreadsCount: number;
  bestSpreadNetPct: number | null;
  /** Why cross-exchange produced nothing. Never sets {@link error}. */
  xchgError?: string;
  /**
   * The best-paying venue that answered this scan's funding poll; `null` if
   * none did.
   *
   * Kept alongside {@link fundingVenues} — which is the honest answer since
   * Phase 14 polls every venue — because the dashboard's one-line scan toast
   * has always named a single source, and "bybit" reading as "the venue behind
   * the headline carry figure beside it" is still true.
   */
  fundingVenue: FundingVenue | null;
  /** Every venue that contributed rows this poll, best-paying first. */
  fundingVenues: FundingVenue[];
  /** `venue: reason` for each venue that contributed nothing. Never fails a scan. */
  fundingVenueErrors?: string[];
  /** Funding rows persisted this scan; `0` when the poll was skipped. */
  fundingCount: number;
  bestFundingNetAnnualPct: number | null;
  /** Why the funding poll produced nothing *at all*. Never sets {@link error}. */
  fundingError?: string;
  /** Set when the poll gate declined: the board is younger than the interval. */
  fundingSkipped?: boolean;
}

/** Injection seams. Production passes nothing; tests override the clock. */
export interface ScanDeps {
  now?: () => number;
  discover?: (universe: string[], env: Env) => Promise<PairInfo[]>;
  /** Dual-venue snapshot seam; defaults to the real two-source fetch. */
  getSnapshots?: (symbols: string[], env: Env) => Promise<DualSnapshot>;
  /** Funding-board seam; defaults to the module-level fetcher in `./funding`. */
  fetchFunding?: FundingFetcher;
  /** Funding-interval seam; defaults to the real Bybit instruments-info call. */
  fetchFundingIntervals?: (
    assets: string[],
    env: Env,
  ) => Promise<Record<string, number>>;
  /** Override the funding poll gate. Tests use it to force a second poll. */
  fundingPollIntervalMs?: number;
  /** Override the funding-interval cache TTL. */
  fundingIntervalTtlMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load the pair cache, bootstrapping it on first run.
 *
 * A brand-new deployment has an empty `pairs` table and would otherwise scan
 * nothing forever until someone remembered to POST /api/admin/refresh-pairs, so
 * the first scan discovers and persists the catalogue itself.
 */
async function loadPairs(
  env: Env,
  deps: ScanDeps,
): Promise<PairRow[]> {
  const existing = await getPairs(env.DB);
  if (existing.length > 0) return existing;

  const discover = deps.discover ?? discoverPairs;
  const discovered = await discover(ASSET_UNIVERSE, env);
  if (discovered.length === 0) return [];

  await replacePairs(env.DB, discovered, DISCOVERY_SOURCE, deps.now?.() ?? Date.now());
  return getPairs(env.DB);
}

/**
 * Acquire the best-effort scan lock.
 *
 * Read-then-write is not atomic, but D1 has a single writer and scans are
 * minutely, so the only realistic contention is a manual scan racing the cron
 * tick — where losing the race means one skipped scan, not corrupted state.
 * Serialising also keeps two concurrent scans from writing two overlapping
 * funding boards under the same retention window.
 */
async function acquireLock(db: D1Database, now: number): Promise<boolean> {
  const raw = await getRawSetting(db, SCAN_LOCK_KEY);
  if (raw !== null) {
    const heldAt = Number(raw);
    if (Number.isFinite(heldAt) && now - heldAt < SCAN_LOCK_TTL_MS) return false;
  }
  await setRawSetting(db, SCAN_LOCK_KEY, String(now));
  return true;
}

/**
 * Load the funding-interval cache, refreshing it from Bybit when stale.
 *
 * Every failure mode — cold cache, corrupt JSON, unreachable venue, refused
 * write — degrades to "use whatever we have, possibly nothing", which the
 * pricing layer turns into `interval_source = 'assumed'`. A cadence lookup must
 * never be able to fail a poll: an assumed 8 hours is wrong at worst by a
 * factor, a missing board is wrong by everything.
 */
async function loadFundingIntervals(
  env: Env,
  assets: string[],
  now: number,
  deps: ScanDeps,
): Promise<Record<string, number>> {
  const cached = await getFundingIntervals(env.DB);
  const ttl = deps.fundingIntervalTtlMs ?? FUNDING_INTERVAL_CACHE_TTL_MS;
  if (cached && now - cached.ts < ttl) return cached.intervals;

  try {
    const fresh = await (deps.fetchFundingIntervals ?? fetchBybitIntervals)(assets, env);
    // An empty answer is not worth caching: it would pin `assumed` in place for
    // a whole day over what is most likely a transient upstream hiccup.
    if (Object.keys(fresh).length > 0) {
      await setFundingIntervals(env.DB, fresh, now);
      return fresh;
    }
  } catch {
    /* stale or absent cadences only cost interval_source='assumed' */
  }

  return cached?.intervals ?? {};
}

/** What one funding poll produced. */
export interface FundingPollResult {
  /** The venue behind the best-paying persisted row; `null` if none. */
  venue: FundingVenue | null;
  /** Venues that contributed at least one row, best-paying first. */
  venues: FundingVenue[];
  /** `venue: reason`, one per venue that contributed nothing. */
  venueErrors: string[];
  ts: number;
  count: number;
  bestNetAnnualPct: number | null;
}

/**
 * Poll the funding board once and persist it. **Unconditional** — the caller
 * owns the "is it time yet" decision (see the gate in {@link runScan} and the
 * deliberate absence of one on `POST /api/funding/refresh`).
 *
 * Throws when no venue answered, so the scan can record it in `fundingError`
 * and the route can answer 502. Every priced row is stored, including negative
 * ones and ones below `funding_min_annual_pct`: the threshold is a display
 * judgement made at read time, and a carry position is held for days, so the
 * series is the product.
 */
export async function pollFundingRates(
  env: Env,
  scanId: number | null,
  deps: ScanDeps = {},
  now: number = Date.now(),
): Promise<FundingPollResult> {
  const db = env.DB;
  const settings = await getSettings(db);
  const assets = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

  const intervals = await loadFundingIntervals(env, assets, now, deps);
  const snapshot = await (deps.fetchFunding ?? getFundingFetcher())(assets, env, {
    intervals,
  });

  // Priced across all venues at once, so the ranking answers "the best carry
  // available anywhere" rather than "the best carry on each venue separately".
  // The per-venue cap is applied *after* pricing, because which of a venue's
  // 850 contracts are its best 25 is not knowable before the fee drag is.
  const ranked = rankFundingOpportunities(
    snapshot.quotes,
    settings.fee_rate,
    settings.perp_fee_rate,
    settings.funding_hold_days,
  );
  const kept = capFundingBoard(ranked, assets, FUNDING_BOARD_TOP_N);

  const rows: FundingRateInput[] = kept.map((r) => ({
    venue: r.quote.venue,
    symbol: r.symbol,
    instrument: r.quote.instrument,
    rate: r.quote.rate,
    intervalMinutes: r.quote.intervalMinutes,
    intervalSource: r.quote.intervalSource,
    annualizedPct: r.annualizedPct,
    netAnnualPct: r.netAnnualPct,
    nextFundingTs: r.quote.nextFundingTs,
    markPrice: r.quote.markPrice,
  }));
  await insertFundingRates(db, scanId, rows, snapshot.ts);

  // Ordered by what each venue actually pays rather than by the order they were
  // polled in: the first name is the one the dashboard shows beside the best
  // carry figure, so it has to be the venue that produced it.
  const venues: FundingVenue[] = [];
  for (const row of kept) {
    const venue = row.quote.venue;
    if (!venues.includes(venue)) venues.push(venue);
  }

  return {
    venue: venues[0] ?? null,
    venues,
    venueErrors: snapshot.venues
      .filter((v) => v.error !== null)
      .map((v) => `${v.venue}: ${v.error}`),
    ts: snapshot.ts,
    count: rows.length,
    bestNetAnnualPct: kept.length > 0 ? kept[0].netAnnualPct : null,
  };
}

/**
 * One full scan: snapshot -> rank -> persist. Nothing is filled.
 *
 * Never throws. Any failure is caught, recorded on the scan row and returned in
 * `error`, because the caller is a cron tick or a dashboard poll — neither can
 * do anything useful with an exception, and a scan that vanished without a row
 * is indistinguishable from a scan that never ran.
 */
export async function runScan(
  env: Env,
  trigger: ScanTrigger,
  deps: ScanDeps = {},
): Promise<ScanResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const db = env.DB;

  await ensureSeeded(db);

  if (!(await acquireLock(db, startedAt))) {
    return {
      scanId: null,
      source: null,
      pairsCount: 0,
      durationMs: now() - startedAt,
      skipped: true,
      error: "scan already in progress",
      spreadsCount: 0,
      bestSpreadNetPct: null,
      fundingVenue: null,
      fundingVenues: [],
      fundingCount: 0,
      bestFundingNetAnnualPct: null,
    };
  }

  const scanId = await insertScan(db, trigger, startedAt);

  let source: SnapshotSource | null = null;
  let pairsCount = 0;
  let error: string | null = null;
  let spreadsCount = 0;
  let bestSpreadNetPct: number | null = null;
  let xchgError: string | null = null;
  let fundingVenue: FundingVenue | null = null;
  let fundingVenues: FundingVenue[] = [];
  let fundingVenueErrors: string[] = [];
  let fundingCount = 0;
  let bestFundingNetAnnualPct: number | null = null;
  let fundingError: string | null = null;
  let fundingSkipped = false;

  try {
    const settings = await getSettings(db);
    const policy = toTaxPolicy(settings);

    const pairs = await loadPairs(env, deps);
    pairsCount = pairs.length;

    // With the switch off there is nothing left on the spot side to fetch a
    // book for, so no snapshot is taken at all and the scan is a funding poll
    // with a `pairs` refresh attached.
    if (settings.xchg_enabled !== 0) {
      if (pairsCount === 0) throw new Error("no tradable pairs available");

      const symbols = pairs.map((p) => p.symbol);
      const dual = await (deps.getSnapshots ?? getDualSnapshot)(symbols, env);
      // `primary` is whichever venue qualified first; it is what the scan row
      // records as its source, and it is non-null or the call above threw.
      source = dual.primary.source;

      // Its own try/catch: a spread needs two venues, and one of them being
      // unreachable is a *degraded* scan, not a failed one. Anything raised
      // here lands in `xchgError` (a column of its own) and never in `error`,
      // so the funding board below is still reported.
      try {
        if (!dual.binance || !dual.mexc) {
          // A spread needs two opinions by definition; one venue is not a
          // degraded spread, it is no spread at all.
          xchgError =
            dual.failures.join("; ") || "cross-exchange needs both venues";
        } else {
          const venues: [VenueBook, VenueBook] = [
            { venue: dual.binance.source, book: dual.binance.book },
            { venue: dual.mexc.source, book: dual.mexc.book },
          ];
          // Only markets that settle in the base asset: an ETH/BTC spread is
          // not a round trip back to USDT, so its percentage would not be
          // comparable with the rest of the board.
          const markets = pairs.filter((p) => p.quote === BASE_ASSET);

          const spreads = rankSpreads(
            markets,
            venues[0],
            venues[1],
            settings.fee_rate,
            BASE_ASSET,
          );
          spreadsCount = spreads.length;
          bestSpreadNetPct = spreads.length > 0 ? spreads[0].netPct : null;

          const topSpreads = spreads.slice(0, SPREADS_PER_SCAN);
          // Mapped explicitly rather than passing the quotes through: the
          // persisted shape carries india-mode columns the engine knows nothing
          // about, and a structural pass-through would silently stop persisting
          // them the moment either shape moved. When the mode is off the columns
          // stay SQL NULL, so "not measured" never masquerades as "measured as
          // zero".
          const spreadRows: OpportunityInput[] = topSpreads.map((q) => {
            const figures = policy.enabled
              ? spreadQuoteTax(q, settings.fee_rate, BASE_ASSET, policy)
              : null;
            return {
              cycle: q.label,
              grossPct: q.grossPct,
              netPct: q.netPct,
              legs: q.legs,
              indiaNetPct: figures?.indiaNetPct ?? null,
              tdsPct: figures?.tdsPct ?? null,
            };
          });
          await insertOpportunities(
            db,
            scanId,
            spreadRows,
            dual.primary.ts,
            STRATEGY_CROSS_EXCHANGE,
          );
        }
      } catch (err) {
        xchgError = errorMessage(err);
      }
    }
  } catch (err) {
    error = errorMessage(err);
  }

  // -- funding rates --------------------------------------------------------
  //
  // Last, still inside the lock, and in a `catch` of its own — the same
  // contract the cross-exchange block has, one level stricter. It sits *outside*
  // the spot try/catch rather than at the end of it because funding needs no
  // pairs and no spot book: a scan that failed for want of market data can
  // still report a perfectly good funding board, and there is no reason to lose
  // it. Nothing here can ever reach `scans.error`; the funding tables are not
  // even referenced by the `scans` row.
  try {
    const pollMs = deps.fundingPollIntervalMs ?? FUNDING_POLL_INTERVAL_MS;
    const lastTs = await getLatestFundingTs(db);
    // Funding settles every 8 hours, so a minutely scan has nothing to learn by
    // asking every minute. `lastTs === null` forces the first poll: a cold
    // database must fill the board immediately rather than wait out an interval
    // it has no baseline for.
    if (lastTs !== null && startedAt - lastTs < pollMs) {
      fundingSkipped = true;
    } else {
      const poll = await pollFundingRates(env, scanId, deps, startedAt);
      fundingVenue = poll.venue;
      fundingVenues = poll.venues;
      fundingVenueErrors = poll.venueErrors;
      fundingCount = poll.count;
      bestFundingNetAnnualPct = poll.bestNetAnnualPct;
      // A venue that failed while others served is *not* a failed poll: the
      // board landed. It is logged and reported so a venue that has been dead
      // for a week is visible before someone wonders where its rows went.
      if (fundingVenueErrors.length > 0) {
        console.warn(`funding venues degraded: ${fundingVenueErrors.join("; ")}`);
      }
    }
  } catch (err) {
    fundingError = errorMessage(err);
    // Logged rather than persisted: `scans` has no column for it by design, and
    // an operator watching `wrangler tail` should still see a dead perp venue.
    console.warn(`funding poll failed: ${fundingError}`);
  }

  // Best-effort cleanup: a failed unlock must not mask the scan's own error,
  // and the TTL is the backstop if it does fail.
  try {
    await deleteRawSetting(db, SCAN_LOCK_KEY);
  } catch {
    /* lock expires on its own via SCAN_LOCK_TTL_MS */
  }

  const durationMs = now() - startedAt;
  try {
    await finalizeScan(db, scanId, {
      source,
      pairsCount,
      durationMs,
      error,
      spreadsCount,
      bestSpreadNetPct,
      xchgError,
    });
  } catch (err) {
    error = error ?? errorMessage(err);
  }

  return {
    scanId,
    source,
    pairsCount,
    durationMs,
    ...(error != null ? { error } : {}),
    spreadsCount,
    bestSpreadNetPct,
    ...(xchgError != null ? { xchgError } : {}),
    fundingVenue,
    fundingVenues,
    ...(fundingVenueErrors.length > 0 ? { fundingVenueErrors } : {}),
    fundingCount,
    bestFundingNetAnnualPct,
    ...(fundingError != null ? { fundingError } : {}),
    ...(fundingSkipped ? { fundingSkipped } : {}),
  };
}
