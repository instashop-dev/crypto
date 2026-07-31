/**
 * Scan orchestration: the one code path that turns market data into persisted
 * observations. `POST /api/scan` and the cron handler both call {@link runScan},
 * so manual and scheduled scans can never drift apart.
 *
 * **Nothing here executes.** Phase 12 removed the paper-fill machinery along
 * with the triangular strategy: a scan ranks cross-exchange spreads, polls the
 * funding board, and writes both down. No balance moves, no trade row is
 * inserted, and `scans.executed_count` keeps whatever the schema default gives
 * it. The reasoning is recorded in `docs/profitability-recommendations.md` —
 * the measured edges never survived fees, and in india mode never survived the
 * withholding either.
 *
 * Phase 15 adds a fourth step, and it does not change that sentence. The carry
 * pass at the end of the funding block opens, accrues and closes *paper*
 * positions in `funding_positions`; it places no order, moves no balance and
 * writes no trade. It is a ledger of what the funding board would have paid,
 * kept so the extrapolation the board reports can be checked against an
 * outcome. See {@link runCarryCycle}.
 *
 * Phase 16 adds one more pass, and it changes even less: before the new spread
 * board is written, the *previous* scan's rows are re-priced against the
 * snapshot already in hand, so the repo finally measures whether a reported
 * spread outlives the timing skew that may have invented it. It fetches nothing
 * and writes only to columns that were NULL. See
 * {@link measureSpreadPersistence}.
 */
import { getBasisFetcher, type BasisFetcher } from "./basis";
import { getDualSnapshot, discoverPairs, type DualSnapshot } from "./binance";
import {
  ASSET_UNIVERSE,
  BASE_ASSET,
  FUNDING_BOARD_BOTTOM_N,
  FUNDING_BOARD_TOP_N,
  FUNDING_INTERVAL_CACHE_TTL_MS,
  FUNDING_POLL_INTERVAL_MS,
  perpAssets,
  STRATEGY_CROSS_EXCHANGE,
} from "./config";
import {
  accrueFundingPosition,
  BASIS_POLL_TS_KEY,
  closeFundingPosition,
  ensureSeeded,
  finalizeScan,
  getFundingIntervals,
  FUNDING_POLL_TS_KEY,
  getFundingRateAt,
  getLatestFundingRateFor,
  getPairs,
  getRawSetting,
  getSettings,
  insertBasisRates,
  insertFundingPosition,
  insertFundingRates,
  insertOpportunities,
  insertScan,
  listLatestFundingRates,
  listOpenFundingPositions,
  listUnmeasuredOpportunities,
  markOpportunityPersistence,
  replacePairs,
  SCAN_LOCK_KEY,
  setFundingIntervals,
  setRawSetting,
  deleteRawSetting,
  toTaxPolicy,
  type BasisRateInput,
  type FundingPosition,
  type FundingRate,
  type FundingRateInput,
  type OpportunityInput,
  type OpportunityPersistence,
  type PairRow,
  type Settings,
} from "./db";
import {
  accrueAmount,
  CARRY_STALE_CLOSE_MS,
  evaluateSpread,
  parseSpreadLabel,
  rankBasisOpportunities,
  rankFundingOpportunities,
  rankSpreads,
  realizedFigures,
  round8,
  settlementBoundaries,
  shouldClose,
  spreadQuoteTax,
  type CarryCloseReason,
  type SpreadMarket,
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

/**
 * How old a spread row may be and still be re-priced: two minutes.
 *
 * The question the measurement asks is "did this edge outlive the ~4s skew that
 * may have invented it", so the answer has to be taken while the row is still
 * about the same market state. Two minutes is one or two cron ticks — long
 * enough that an ordinary skipped scan does not orphan the row, short enough
 * that a "surviving" spread is not just the same asset at a different price an
 * hour later. Past it the row is stamped checked with a NULL figure: expired
 * unmeasured, which is a fact worth being able to count.
 */
export const SPREAD_PERSIST_MAX_AGE_MS = 120_000;

/**
 * How *young* a spread row may be and still be re-priced: 30 seconds.
 *
 * The floor at the other end of {@link SPREAD_PERSIST_MAX_AGE_MS}, and it exists
 * because scans are not evenly spaced. The cron ticks minutely, but a manual
 * `POST /api/scan` can land seconds after one — and would then measure rows at a
 * survival horizon of near zero, where nothing has had time to move and almost
 * everything "survives". Those measurements are not wrong so much as answering a
 * different question, and mixed into the same column they bias the survival
 * distribution upward.
 *
 * A row younger than this is therefore left completely untouched — NULL
 * `persist_checked_ts`, still eligible — for whichever later scan finds it
 * inside the window. Since the window runs to two minutes, an ordinary minutely
 * cadence still gives every row at least one qualifying scan.
 */
export const SPREAD_PERSIST_MIN_AGE_MS = 30_000;

/**
 * How far back the survival pass will look for unmeasured rows: one hour.
 *
 * Rows older than this are never even selected, so they keep the NULL that
 * truthfully says "not measured" — see {@link listUnmeasuredOpportunities}. It
 * bounds two things at once: the backlog the first scan after migration 0006
 * would otherwise walk (every spread row ever written), and the catch-up after
 * an outage. Comfortably more than {@link SPREAD_PERSIST_MAX_AGE_MS}, so a row
 * that expired unmeasured still gets stamped as such rather than being
 * abandoned in the same state as the pre-feature history.
 */
export const SPREAD_PERSIST_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * Most rows one scan will measure. A scan writes {@link SPREADS_PER_SCAN}, so
 * this is several scans of backlog and still a bounded D1 batch — the pass must
 * never be able to grow into the write budget of the scan it rides on.
 */
export const SPREAD_PERSIST_LIMIT = 50;

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
   * Earlier spread rows whose survival was stamped this scan — re-priced
   * against this snapshot, or marked expired unmeasured. `0` when there was
   * nothing to measure, which is the steady state of a fresh deployment.
   */
  spreadsRechecked: number;
  /**
   * Why the survival pass produced nothing. Its own field, never
   * {@link error} and never {@link xchgError}: this is instrumentation *about*
   * the spread board, and a bug in it must not read as the spread scanner being
   * degraded — the board it is measuring was written perfectly well.
   */
  persistError?: string;
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
  /** Paper carry positions opened this scan; `0` when the strategy is off. */
  positionsOpened: number;
  /** Paper carry positions closed this scan, for any reason. */
  positionsClosed: number;
  /** Funding accrued to open positions this scan, in USDT. Signed. */
  carryAccruedUsdt: number;
  /**
   * Why the carry pass produced nothing. Its own field, never {@link error} and
   * never {@link fundingError}: the board had already landed by the time carry
   * ran, and reporting a bug in the accrual as a dead perp venue would send
   * whoever reads it to the wrong upstream.
   */
  carryError?: string;
  /** Dated-futures basis rows persisted this scan; `0` when the poll was
   *  skipped or the board was empty. */
  basisCount: number;
  bestBasisNetAnnualPct: number | null;
  /**
   * Why the basis poll produced nothing. Its own field for the same reason
   * every other strategy has one: a dead OKX futures endpoint is not a failed
   * scan, a failed funding poll, or a failed carry pass, and reporting it as
   * any of those would send whoever reads it to the wrong upstream.
   */
  basisError?: string;
  /** Set when the basis poll gate declined: the board is younger than the
   *  interval. */
  basisSkipped?: boolean;
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
  /** Basis-board seam; defaults to the module-level fetcher in `./basis`. */
  fetchBasis?: BasisFetcher;
  /** Override the basis poll gate. Its own knob, not a reuse of the funding
   *  one, so a test can hold one poll's cadence still while moving the other's. */
  basisPollIntervalMs?: number;
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

// ---------------------------------------------------------------------------
// Cross-exchange spread survival
// ---------------------------------------------------------------------------

/**
 * Re-price earlier spread rows against **this** scan's books and record what
 * was left of them.
 *
 * This is the measurement `src/engine/crossExchange.ts` has been asking for
 * since Phase 9. Its module header names the ~4s Binance-WS/MEXC-REST timing
 * skew as the dominant false positive — a market that moved during the
 * collection window shows up as a spread that never existed — and nothing in
 * the repo has ever checked. A spread that was real is still there a minute
 * later; one that was an artefact of two non-simultaneous books is not. So each
 * scan asks the previous scan's rows that question, and `persist_net_pct`
 * accumulates the distribution a later report reads.
 *
 * Three rules:
 *
 * - **Zero new subrequests.** It prices against the snapshot the scan already
 *   fetched, and reads only D1. That is why it takes books rather than an `Env`.
 * - **Same trade, same direction.** The direction lives only in the row's label,
 *   so it is parsed back out ({@link parseSpreadLabel}); re-pricing the mirror
 *   would report a provable loss as the survival of the trade that was
 *   recorded. A row whose label, market or venue cannot be resolved is left
 *   untouched for a later scan rather than guessed at — and expires on its own
 *   if no scan ever manages it.
 * - **Priced at the caller's current `feeRate`**, not the rate in force when the
 *   row was written. The question is "what is this trade worth now", and the
 *   answer has to be quoted at today's fees to be comparable with today's board.
 *
 * Runs **before** the new board is persisted, so a scan can never measure its
 * own rows: a survival horizon of zero seconds would be a tautology, not a
 * measurement. {@link SPREAD_PERSIST_MIN_AGE_MS} extends the same argument to
 * rows the *previous* scan wrote seconds ago — a manual scan chasing a cron
 * tick — which are skipped rather than stamped, and taken by a later scan.
 *
 * Returns how many rows were actually stamped.
 */
export async function measureSpreadPersistence(
  db: D1Database,
  venues: readonly VenueBook[],
  markets: readonly SpreadMarket[],
  feeRate: number,
  nowTs: number,
): Promise<number> {
  const rows = await listUnmeasuredOpportunities(
    db,
    STRATEGY_CROSS_EXCHANGE,
    nowTs - SPREAD_PERSIST_LOOKBACK_MS,
    SPREAD_PERSIST_LIMIT,
  );
  if (rows.length === 0) return 0;

  const byVenue = new Map(venues.map((v) => [v.venue, v]));
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const marks: OpportunityPersistence[] = [];

  for (const row of rows) {
    // Expiry is decided first and unconditionally: a two-minute-old row is out
    // of scope even on a scan that could have priced it, or the horizon of the
    // measurement would vary with how lucky the row got.
    if (nowTs - row.ts >= SPREAD_PERSIST_MAX_AGE_MS) {
      marks.push({ id: row.id, persistNetPct: null, checkedTs: nowTs });
      continue;
    }

    // ...and rows that are too *young* are not stamped at all, only skipped:
    // measuring one now would quote a near-zero survival horizon into a column
    // whose whole meaning is "~1 minute later". It stays eligible, and a later
    // scan inside the window takes it.
    if (nowTs - row.ts < SPREAD_PERSIST_MIN_AGE_MS) continue;

    const label = parseSpreadLabel(row.cycle);
    if (!label) continue;
    const market = bySymbol.get(label.symbol);
    const buy = byVenue.get(label.buyVenue);
    const sell = byVenue.get(label.sellVenue);
    if (!market || !buy || !sell) continue;

    const quote = evaluateSpread(market, buy, sell, feeRate, BASE_ASSET);
    if (!quote) continue;

    marks.push({ id: row.id, persistNetPct: quote.netPct, checkedTs: nowTs });
  }

  return markOpportunityPersistence(db, marks);
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

/** One venue's share of a persisted board. */
export interface FundingVenueCount {
  venue: FundingVenue;
  count: number;
}

/** What one funding poll produced. */
export interface FundingPollResult {
  /** The venue behind the best-paying persisted row; `null` if none. */
  venue: FundingVenue | null;
  /**
   * Venues that contributed at least one row, with their share of the board,
   * best-paying first.
   *
   * Objects rather than bare names so `POST /api/funding/refresh` reports the
   * *same* `venues` shape `GET /api/funding` does — the two describe the same
   * board, and a caller that had to know which endpoint it asked in order to
   * read the field was a trap. {@link ScanResult.fundingVenues} stays a name
   * list: the scan toast names sources, it does not tabulate them.
   */
  venues: FundingVenueCount[];
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
  // 850 contracts are its best 20 and worst 5 is not knowable before the fee
  // drag is.
  const ranked = rankFundingOpportunities(
    snapshot.quotes,
    settings.fee_rate,
    settings.perp_fee_rate,
    settings.funding_hold_days,
  );
  const kept = capFundingBoard(
    ranked,
    assets,
    FUNDING_BOARD_TOP_N,
    FUNDING_BOARD_BOTTOM_N,
  );

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
  const venues: FundingVenueCount[] = [];
  const byVenue = new Map<FundingVenue, FundingVenueCount>();
  for (const row of kept) {
    const venue = row.quote.venue;
    const seen = byVenue.get(venue);
    if (seen) {
      seen.count++;
      continue;
    }
    const entry = { venue, count: 1 };
    byVenue.set(venue, entry);
    venues.push(entry);
  }

  return {
    venue: venues[0]?.venue ?? null,
    venues,
    venueErrors: snapshot.venues
      .filter((v) => v.error !== null)
      .map((v) => `${v.venue}: ${v.error}`),
    ts: snapshot.ts,
    count: rows.length,
    bestNetAnnualPct: kept.length > 0 ? kept[0].netAnnualPct : null,
  };
}

// ---------------------------------------------------------------------------
// Dated-futures basis
// ---------------------------------------------------------------------------

/** What one basis poll produced. */
export interface BasisPollResult {
  ts: number;
  /** Rows persisted. `0` for a board OKX served with nothing priceable on it. */
  count: number;
  /** Contracts the venue quoted, before pricing dropped any of them. */
  quoted: number;
  bestNetAnnualPct: number | null;
}

/**
 * Poll the dated-futures basis board once and persist it. **Unconditional** —
 * the caller owns the "is it time yet" decision, exactly as
 * {@link pollFundingRates} does.
 *
 * Throws when the venue could not be reached or answered an error envelope, so
 * the scan can record it in `basisError` and a route can answer 502. An *empty*
 * board is not a throw: OKX listing no linear dated futures at all is a real
 * state of the world (see the instId table in `src/basis.ts`), and it has to be
 * distinguishable from an outage.
 *
 * Every priced contract is stored, including backwardation and rows below
 * `funding_min_annual_pct`: the threshold is a display judgement made at read
 * time, and the whole point of an observation-only board is the series.
 *
 * **No holding-period setting is consulted.** A basis position ends when its
 * contract settles, so the fee drag is amortised over each row's own
 * `daysToExpiry` — see `src/engine/basis.ts`. `funding_hold_days` is a perp-carry
 * assumption and would be a wrong answer here.
 *
 * Takes no clock parameter, unlike {@link pollFundingRates}: everything here is
 * timed off the snapshot's own `ts`, and there is no cache with a TTL for the
 * scan's clock to be compared against.
 */
export async function pollBasisRates(
  env: Env,
  scanId: number | null,
  deps: ScanDeps = {},
): Promise<BasisPollResult> {
  const db = env.DB;
  const settings = await getSettings(db);

  const snapshot = await (deps.fetchBasis ?? getBasisFetcher())(env);
  const ranked = rankBasisOpportunities(
    snapshot.quotes,
    settings.fee_rate,
    settings.perp_fee_rate,
    // The snapshot's own clock, not the scan's: `daysToExpiry` is measured from
    // the moment the prices were taken, so the row's divisor and its numerator
    // sit on one timeline.
    snapshot.ts,
  );

  const rows: BasisRateInput[] = ranked.map((r) => ({
    venue: r.quote.venue,
    symbol: r.symbol,
    instrument: r.instrument,
    expiryTs: r.expiryTs,
    daysToExpiry: r.daysToExpiry,
    spotPrice: r.spotPrice,
    futurePrice: r.futurePrice,
    // Carried from the venue quote, not derived: whether either leg fell back
    // to a last trade is a fact about the observation and cannot be recovered
    // from the prices once the board is gone.
    priceSource: r.quote.priceSource,
    basisPct: r.basisPct,
    annualizedPct: r.annualizedPct,
    netAnnualPct: r.netAnnualPct,
  }));
  await insertBasisRates(db, scanId, rows, snapshot.ts);

  return {
    ts: snapshot.ts,
    count: rows.length,
    quoted: snapshot.quotes.length,
    bestNetAnnualPct: ranked.length > 0 ? ranked[0].netAnnualPct : null,
  };
}

// ---------------------------------------------------------------------------
// Paper carry positions
// ---------------------------------------------------------------------------

/** What one carry pass did. Every field is additive on {@link ScanResult}. */
export interface CarryCycleResult {
  positionsOpened: number;
  positionsClosed: number;
  /** Funding accrued to open positions this pass, in USDT. Signed. */
  accruedUsdt: number;
  /**
   * Settlement boundaries that crossed without being paid, for any reason —
   * the sum of the two counts below, kept because "how complete is this
   * position's accrual" is one question.
   */
  skippedSettlements: number;
  /**
   * Boundaries with **no rate row at all** within
   * {@link CARRY_STALE_CLOSE_MS} before them: the scanner was down, the venue
   * was unreachable, or the contract fell off a capped board. A coverage gap.
   */
  skippedNoRate: number;
  /**
   * Boundaries that *had* a row which could not price a payment — a rate whose
   * magnitude is 1 or more, i.e. a mis-decoded field (see {@link accrueAmount}).
   * Counted apart from the gap above because it is a different failure: the
   * observation exists and is wrong, which is a parser bug to chase rather than
   * an outage to wait out.
   */
  skippedUnusableRate: number;
}

/**
 * Close one position and write its realised figures.
 *
 * Shared by the scanner's close rules and by
 * `POST /api/funding/positions/:id/close`, so a manual close and an automatic
 * one produce the same arithmetic and differ only in `close_reason`.
 *
 * Returns `false` when the position was already closed — the `WHERE status =
 * 'open'` guard in {@link closeFundingPosition} — so the route can answer 409
 * instead of overwriting a realised P&L.
 *
 * A position whose figures cannot be computed at all (an unusable stored fee
 * rate, a zero notional) is still **closed**, with NULL realised columns: the
 * alternative is a position that can never be closed by any means, and NULL
 * here already means "no realised figure", which is the truth.
 */
export async function closeCarryPosition(
  db: D1Database,
  position: FundingPosition,
  reason: CarryCloseReason,
  closeTs: number,
): Promise<boolean> {
  const figures = realizedFigures(
    {
      entryTs: position.entryTs,
      notionalUsdt: position.notionalUsdt,
      accruedFundingUsdt: position.accruedFundingUsdt,
      spotFeeRate: position.spotFeeRate,
      perpFeeRate: position.perpFeeRate,
    },
    closeTs,
  );

  return closeFundingPosition(db, position.id, {
    closeTs,
    closeReason: reason,
    realizedPnlUsdt: figures?.realizedPnlUsdt ?? null,
    realizedAnnualPct: figures?.realizedAnnualPct ?? null,
  });
}

/**
 * Accrue one position from the rate rows already on disk.
 *
 * Every settlement boundary in `(lastAccrual, now]` is priced by the newest
 * persisted row for the position's `(venue, symbol)` at or before it, and no
 * older than {@link CARRY_STALE_CLOSE_MS}. A boundary with no such row is
 * **skipped**, not estimated: an unobserved settlement is missing data, and the
 * hole stays visible as the gap between `accrual_count` and elapsed time.
 *
 * `last_accrual_ts` advances to the newest boundary crossed even when some of
 * them were skipped, so a hole is never re-walked on the next poll — the rows
 * that would have priced it are exactly the rows that do not exist.
 *
 * **The grid's anchor is the position's own `last_accrual_ts` once it has one**,
 * and only falls back to the venue's published `next_funding_ts` (and then to
 * the epoch) for a position that has never accrued. That order matters because
 * the anchor is re-read on every pass: a venue that publishes `nextFundingTime`
 * on one poll, omits it on the next and publishes a shifted one after that would
 * otherwise move the grid's *phase* under a running position, which double-counts
 * a settlement or drops one — the boundary the last pass stopped at is no longer
 * on the grid the next pass computes. `last_accrual_ts` is itself always a grid
 * point once set, so anchoring to it reproduces whichever grid the position has
 * been accruing on and the phase can no longer drift. A first pass still adopts
 * the venue's published schedule, which is the one thing that anchor is for.
 *
 * Zero D1 writes and zero network calls when nothing crossed, which is the
 * common case: boundaries are 8 hours apart and this runs every 5 minutes.
 */
async function accruePosition(
  db: D1Database,
  position: FundingPosition,
  latest: { ts: number; nextFundingTs: number | null } | null,
  nowTs: number,
): Promise<{
  position: FundingPosition;
  accrued: number;
  skippedNoRate: number;
  skippedUnusableRate: number;
  /**
   * Whether the accrual was actually written. `false` means the guarded
   * `UPDATE … WHERE status = 'open'` matched nothing — the position was closed
   * between the read at the top of the pass and this write — so nothing was
   * booked and nothing may be counted.
   */
  applied: boolean;
}> {
  const idle = {
    position,
    accrued: 0,
    skippedNoRate: 0,
    skippedUnusableRate: 0,
    applied: true,
  };

  const from = position.lastAccrualTs ?? position.entryTs;
  const boundaries = settlementBoundaries(
    from,
    nowTs,
    position.intervalMinutes,
    position.lastAccrualTs ?? latest?.nextFundingTs ?? null,
  );
  if (boundaries.length === 0) return idle;

  let accrued = 0;
  let counted = 0;
  let skippedNoRate = 0;
  let skippedUnusableRate = 0;

  for (const boundary of boundaries) {
    const row = await getFundingRateAt(
      db,
      position.venue,
      position.symbol,
      boundary,
      boundary - CARRY_STALE_CLOSE_MS,
    );
    if (row === null) {
      skippedNoRate++;
      continue;
    }
    const amount = accrueAmount(row.rate, position.notionalUsdt, 1);
    if (amount === null) {
      // A row exists and cannot price a payment: a rate of 100% or more per
      // settlement is a mis-decoded field, not a market. Counted apart from the
      // no-row case so the warn line can say which of the two happened.
      skippedUnusableRate++;
      continue;
    }
    accrued += amount;
    counted++;
  }

  const lastBoundary = boundaries[boundaries.length - 1];
  const updated: FundingPosition = {
    ...position,
    accruedFundingUsdt: round8(position.accruedFundingUsdt + accrued),
    accrualCount: position.accrualCount + counted,
    lastAccrualTs: lastBoundary,
  };
  const applied = await accrueFundingPosition(
    db,
    updated.id,
    updated.accruedFundingUsdt,
    updated.accrualCount,
    lastBoundary,
  );
  // The write is guarded on `status = 'open'`, so a position closed by the
  // manual route mid-pass books nothing at all. Reporting the in-memory sum
  // anyway would put USDT in `carryAccruedUsdt` that no row anywhere holds.
  if (!applied) return { ...idle, applied: false };

  return {
    position: updated,
    accrued: round8(accrued),
    skippedNoRate,
    skippedUnusableRate,
    applied: true,
  };
}

/**
 * Decide which board rows are worth opening a position on.
 *
 * Three filters, and the third is the one worth reading twice:
 *
 * - the net annual carry clears `funding_min_annual_pct` (the same threshold the
 *   dashboard flags rows with — a position is opened on exactly what the board
 *   said qualified);
 * - no position is already open on that `(venue, symbol)`, so the book measures
 *   several contracts rather than one contract several times;
 * - **the settlement cadence was published, not assumed.** A row tagged
 *   `interval_source = 'assumed'` has an annualised figure derived from a
 *   guessed 8 hours, and a contract that really settles hourly is under-reported
 *   by 8x — the guess is tolerable for a board that is only ever *read*, and not
 *   tolerable as the basis for a position whose accrual grid is that same
 *   interval. Nothing is ever opened on a guess.
 */
function carryCandidates(
  board: FundingRate[],
  openPositions: FundingPosition[],
  minAnnualPct: number,
): FundingRate[] {
  const held = new Set(openPositions.map((p) => `${p.venue}\u0000${p.symbol}`));
  return board.filter(
    (row) =>
      row.intervalSource === "api" &&
      Number.isFinite(row.netAnnualPct) &&
      row.netAnnualPct >= minAnnualPct &&
      !held.has(`${row.venue}\u0000${row.symbol}`),
  );
}

/**
 * One carry pass: accrue, then close, then open. In that order, and the order is
 * load-bearing.
 *
 * - **Accrue first** so a position that is about to be closed is paid for the
 *   settlements it actually saw. Closing first would silently forfeit up to a
 *   whole interval of funding on every exit and bias every realised figure
 *   downwards.
 * - **Close before opening** so a slot freed this poll can be refilled this
 *   poll, rather than leaving the book a position short until the next one.
 * - **Open last** so the board rows a position is opened on are the ones just
 *   persisted, and so a position opened now cannot be accrued or closed in the
 *   same pass it was created in.
 *
 * Reads only what the funding poll has already written — no new subrequests and
 * no upstream call of any kind, which is why it takes a `D1Database` rather than
 * the `Env` every other orchestration function here does: there is nothing else
 * in the environment it could reach for.
 */
export async function runCarryCycle(
  db: D1Database,
  scanId: number | null,
  settings: Settings,
  nowTs: number,
): Promise<CarryCycleResult> {
  let positionsOpened = 0;
  let positionsClosed = 0;
  let accruedUsdt = 0;
  let skippedNoRate = 0;
  let skippedUnusableRate = 0;

  const open = await listOpenFundingPositions(db);
  const survivors: FundingPosition[] = [];

  for (const position of open) {
    const latest = await getLatestFundingRateFor(db, position.venue, position.symbol);

    const accrual = await accruePosition(db, position, latest, nowTs);
    // A position closed by the manual route between the read above and the
    // accrual write is gone: nothing was booked, it is not a survivor holding a
    // slot, and there is no close left to evaluate.
    if (!accrual.applied) continue;
    accruedUsdt = round8(accruedUsdt + accrual.accrued);
    skippedNoRate += accrual.skippedNoRate;
    skippedUnusableRate += accrual.skippedUnusableRate;

    const reason = shouldClose(
      { entryTs: position.entryTs, lastRateTs: latest?.ts ?? null },
      latest?.netAnnualPct ?? null,
      {
        holdDays: settings.funding_hold_days,
        exitAnnualPct: settings.funding_exit_annual_pct,
      },
      nowTs,
    );
    if (reason === null) {
      survivors.push(accrual.position);
      continue;
    }

    // Closed from the *accrued* copy, not the one read at the top of the loop:
    // the realised P&L is the funding this pass just booked less the fees, and
    // closing off the stale copy would forfeit the final settlement.
    if (await closeCarryPosition(db, accrual.position, reason, nowTs)) {
      positionsClosed++;
    }
  }

  // The switch gates *opening* only. An operator turning the strategy off wants
  // no new positions, not an open book that silently stops accruing and stops
  // being closed — that would strand positions with a P&L frozen mid-flight.
  if (settings.funding_positions_enabled !== 0) {
    const slots = Math.max(
      0,
      Math.trunc(settings.funding_max_positions) - survivors.length,
    );
    if (slots > 0) {
      // One board, i.e. one `ts`, and {@link carryCandidates} dedupes only
      // against positions that are *already* open — so it relies on the board
      // carrying at most **one row per `(venue, symbol)`**, or two rows for one
      // contract could both be opened in this single pass. That invariant is
      // held by the poll, not by the schema: a venue quotes each asset once, so
      // `pollFundingRates` writes one row per `(venue, symbol)` per timestamp.
      // `funding_rates` has no unique index saying so.
      const board = await listLatestFundingRates(db);
      const candidates = carryCandidates(
        board,
        survivors,
        settings.funding_min_annual_pct,
      );

      // The board arrives sorted by net carry, so `slice` is "the best ones".
      for (const row of candidates.slice(0, slots)) {
        await insertFundingPosition(db, scanId, {
          venue: row.venue,
          symbol: row.symbol,
          instrument: row.instrument,
          notionalUsdt: settings.funding_position_size_usdt,
          // The board's timestamp, not the scan's: the position is entered on
          // the quote it was opened from, so its accrual grid and its first
          // settlement line up with the data rather than with the clock.
          entryTs: row.ts,
          entryRate: row.rate,
          entryAnnualizedPct: row.annualizedPct,
          intervalMinutes: row.intervalMinutes,
          spotFeeRate: settings.fee_rate,
          perpFeeRate: settings.perp_fee_rate,
          predictedNetAnnualPct: row.netAnnualPct,
        });
        positionsOpened++;
      }
    }
  }

  return {
    positionsOpened,
    positionsClosed,
    accruedUsdt,
    skippedSettlements: skippedNoRate + skippedUnusableRate,
    skippedNoRate,
    skippedUnusableRate,
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
      spreadsRechecked: 0,
      fundingVenue: null,
      fundingVenues: [],
      fundingCount: 0,
      bestFundingNetAnnualPct: null,
      positionsOpened: 0,
      positionsClosed: 0,
      carryAccruedUsdt: 0,
      basisCount: 0,
      bestBasisNetAnnualPct: null,
    };
  }

  const scanId = await insertScan(db, trigger, startedAt);

  let source: SnapshotSource | null = null;
  let pairsCount = 0;
  let error: string | null = null;
  let spreadsCount = 0;
  let bestSpreadNetPct: number | null = null;
  let xchgError: string | null = null;
  let spreadsRechecked = 0;
  let persistError: string | null = null;
  let fundingVenue: FundingVenue | null = null;
  let fundingVenues: FundingVenue[] = [];
  let fundingVenueErrors: string[] = [];
  let fundingCount = 0;
  let bestFundingNetAnnualPct: number | null = null;
  let fundingError: string | null = null;
  let fundingSkipped = false;
  let positionsOpened = 0;
  let positionsClosed = 0;
  let carryAccruedUsdt = 0;
  let carryError: string | null = null;
  let basisCount = 0;
  let bestBasisNetAnnualPct: number | null = null;
  let basisError: string | null = null;
  let basisSkipped = false;

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

          // Instrumentation, in a `catch` of its own *inside* the
          // cross-exchange one, and deliberately ahead of this scan's own
          // writes. The nesting is the contract: a bug in the survival
          // measurement costs the measurement, and the board it measures is
          // still priced and persisted below. Ahead, because a row must never
          // be re-priced by the scan that wrote it.
          try {
            spreadsRechecked = await measureSpreadPersistence(
              db,
              venues,
              markets,
              settings.fee_rate,
              // The books' own clock, so a row's age is measured against the
              // snapshot it is being re-priced with rather than against the
              // wall clock of the worker.
              dual.primary.ts,
            );
          } catch (err) {
            persistError = errorMessage(err);
            console.warn(`spread persistence pass failed: ${persistError}`);
          }

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
              // The same figure on every row of a scan — they were all priced
              // from the same pair of books — and stored per row anyway,
              // because the row is what a later report reads and a join back to
              // a scan-level column would break the moment a scan ever priced
              // two snapshots.
              skewMs: dual.skewMs,
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
    // Funding settles every 8 hours, so a minutely scan has nothing to learn by
    // asking every minute.
    //
    // Gated on the scan's **own** marker rather than on `MAX(ts)` in
    // `funding_rates`: that table is also written by
    // `POST /api/funding/refresh`, so a refresh hit more often than `pollMs`
    // kept the gate permanently satisfied and the scheduled poll never came due
    // — starving the carry pass, which runs only behind a scan's poll, for as
    // long as someone kept refreshing. Refresh still writes boards; it no longer
    // has a say in when the scanner polls. See {@link FUNDING_POLL_TS_KEY}.
    //
    // A missing or unparseable marker forces the poll: a cold database must fill
    // the board immediately rather than wait out an interval it has no baseline
    // for.
    const marker = await getRawSetting(db, FUNDING_POLL_TS_KEY);
    // `Number(null)` is `0`, which is a perfectly finite timestamp, so the
    // absent case is separated before the parse rather than after it.
    const parsed = marker === null ? Number.NaN : Number(marker);
    const lastPollTs = Number.isFinite(parsed) ? parsed : null;
    if (lastPollTs !== null && startedAt - lastPollTs < pollMs) {
      fundingSkipped = true;
    } else {
      const poll = await pollFundingRates(env, scanId, deps, startedAt);
      // Written only once the poll has returned, so a poll that threw is retried
      // by the next scan instead of holding the gate shut for a full interval.
      await setRawSetting(db, FUNDING_POLL_TS_KEY, String(startedAt));
      fundingVenue = poll.venue;
      // Names only: the scan toast lists sources, and the per-venue counts the
      // poll returns are what `/api/funding` is for.
      fundingVenues = poll.venues.map((v) => v.venue);
      fundingVenueErrors = poll.venueErrors;
      fundingCount = poll.count;
      bestFundingNetAnnualPct = poll.bestNetAnnualPct;
      // A venue that failed while others served is *not* a failed poll: the
      // board landed. It is logged and reported so a venue that has been dead
      // for a week is visible before someone wonders where its rows went.
      if (fundingVenueErrors.length > 0) {
        console.warn(`funding venues degraded: ${fundingVenueErrors.join("; ")}`);
      }

      // -- paper carry positions ------------------------------------------
      //
      // After the board has landed, and in a `catch` of its own *inside* the
      // funding one. The nesting is the whole contract: whatever happens here,
      // the rows `pollFundingRates` just wrote are already committed and
      // reported, so a bug in the accrual costs the carry pass and nothing
      // else. It reads only what that poll persisted, so it costs zero
      // subrequests.
      try {
        const carry = await runCarryCycle(
          db,
          scanId,
          await getSettings(db),
          // The board's own timestamp, so a position's entry, its accrual grid
          // and the rows behind them all sit on one clock.
          poll.ts,
        );
        positionsOpened = carry.positionsOpened;
        positionsClosed = carry.positionsClosed;
        carryAccruedUsdt = carry.accruedUsdt;
        if (carry.skippedSettlements > 0) {
          // The two reasons are named apart because they call for different
          // reactions: a missing row is a coverage gap (the scanner or the
          // venue was down), an unusable one is a row that exists and cannot be
          // priced, which is a decoding bug worth chasing.
          console.warn(
            `carry: ${carry.skippedSettlements} settlement(s) not accrued` +
              ` (${carry.skippedNoRate} with no rate row,` +
              ` ${carry.skippedUnusableRate} with an unusable rate)`,
          );
        }
      } catch (err) {
        carryError = errorMessage(err);
        console.warn(`carry cycle failed: ${carryError}`);
      }
    }
  } catch (err) {
    fundingError = errorMessage(err);
    // Logged rather than persisted: `scans` has no column for it by design, and
    // an operator watching `wrangler tail` should still see a dead perp venue.
    console.warn(`funding poll failed: ${fundingError}`);
  }

  // -- dated-futures basis --------------------------------------------------
  //
  // A fourth strategy in a fourth `catch`, on exactly the terms the three above
  // it have. It sits *outside* the funding try/catch, not at the end of it,
  // because it shares nothing with the funding poll but a venue: it needs no
  // funding board, no cadence cache and no pairs, so a scan whose funding poll
  // died can still record a perfectly good basis board — and a basis outage
  // cannot cost the funding board, the carry pass or the spread half a single
  // row. Nothing here can ever reach `scans.error`; migration 0007 gives the
  // `scans` row no column for it, deliberately.
  try {
    const pollMs = deps.basisPollIntervalMs ?? FUNDING_POLL_INTERVAL_MS;
    // Its own marker, read exactly as the funding gate reads its own, and for
    // the same reasons: a missing or unparseable value forces the poll (a cold
    // database must fill the board immediately rather than wait out an interval
    // it has no baseline for), and the marker is written only *after* the poll
    // returns, so a poll that threw is retried by the next scan instead of
    // holding the gate shut for a full interval.
    //
    // Separate from `funding_last_poll_ts` because the two polls fail
    // independently: sharing one marker would mean a failed funding poll
    // silently re-polling the basis board a minute later, or the reverse.
    const marker = await getRawSetting(db, BASIS_POLL_TS_KEY);
    const parsed = marker === null ? Number.NaN : Number(marker);
    const lastPollTs = Number.isFinite(parsed) ? parsed : null;
    if (lastPollTs !== null && startedAt - lastPollTs < pollMs) {
      basisSkipped = true;
    } else {
      const poll = await pollBasisRates(env, scanId, deps);
      await setRawSetting(db, BASIS_POLL_TS_KEY, String(startedAt));
      basisCount = poll.count;
      bestBasisNetAnnualPct = poll.bestNetAnnualPct;
      // A board the venue served with nothing on it is not an error, and it is
      // not silence either: it is the state of the world the day OKX lists no
      // linear dated futures. Logged so it is visible in `wrangler tail`
      // without having to notice a zero in a JSON body.
      if (poll.quoted === 0) {
        console.warn("basis: okx quoted no priceable linear dated futures");
      }
    }
  } catch (err) {
    basisError = errorMessage(err);
    console.warn(`basis poll failed: ${basisError}`);
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
    spreadsRechecked,
    ...(persistError != null ? { persistError } : {}),
    fundingVenue,
    fundingVenues,
    ...(fundingVenueErrors.length > 0 ? { fundingVenueErrors } : {}),
    fundingCount,
    bestFundingNetAnnualPct,
    ...(fundingError != null ? { fundingError } : {}),
    ...(fundingSkipped ? { fundingSkipped } : {}),
    positionsOpened,
    positionsClosed,
    carryAccruedUsdt,
    ...(carryError != null ? { carryError } : {}),
    basisCount,
    bestBasisNetAnnualPct,
    ...(basisError != null ? { basisError } : {}),
    ...(basisSkipped ? { basisSkipped } : {}),
  };
}
