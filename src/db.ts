/**
 * Typed D1 access layer.
 *
 * Every SQL string in the app lives here; `src/scan.ts` and `src/routes.ts`
 * only ever call these helpers. Two rules the callers depend on:
 *
 * - **Nothing here throws for "missing" state.** A fresh database, a wiped
 *   database and a seeded one all answer the same reads; `ensureSeeded` is the
 *   single place that materialises defaults, and it is idempotent.
 * - **Anything that must not half-apply goes through `D1.batch()`**, which runs
 *   as one implicit transaction — a board of funding rows landing without its
 *   retention prune, or the reverse, would leave a gap no reader could explain.
 *
 * ## `trades` and `balances` no longer move with the market
 *
 * Phase 12 deleted every paper-fill path, so nothing in this module writes a
 * trade or *moves* a balance any more. Two writers are left, and both set the
 * balance rather than adjust it: `ensureSeeded` materialises the starting
 * balance on a cold table, and `resetAll` re-establishes it on an explicit
 * `POST /api/reset`. The tables, their columns and their readers all stay: the
 * rows already on disk are the record of what the fill-era scanner did, and
 * `GET /api/trades` and `GET /api/portfolio` still serve them. There is no
 * destructive migration.
 */
import { BASE_ASSET, DEFAULTS, STRATEGY_TRIANGULAR, type Strategy } from "./config";
import { round8, type ExecutedLeg, type TaxPolicy } from "./engine";
import type { PairInfo } from "./types";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The tunables, always fully populated (DEFAULTS fill any gap). */
export interface Settings {
  fee_rate: number;
  perp_fee_rate: number;
  initial_usdt: number;
  india_mode: number;
  tds_rate: number;
  tax_rate: number;
  xchg_min_profit_pct: number;
  xchg_enabled: number;
  funding_min_annual_pct: number;
  funding_hold_days: number;
  funding_positions_enabled: number;
  funding_position_size_usdt: number;
  funding_max_positions: number;
  funding_exit_annual_pct: number;
}

export type SettingKey = keyof Settings;

/**
 * Numeric setting keys, in a stable order. New keys are **appended**: the order
 * is what `ensureSeeded` batches in, and keeping it append-only means a
 * back-fill of a new tunable can never reorder the writes of the old ones.
 *
 * Retiring a key (Phase 12 dropped `min_profit_pct` and `trade_size_usdt`)
 * needs no migration: {@link getSettings} ignores any stored row whose key is
 * not listed here, so the orphaned rows are simply never read again.
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  "fee_rate",
  "initial_usdt",
  "india_mode",
  "tds_rate",
  "tax_rate",
  "xchg_min_profit_pct",
  "xchg_enabled",
  "funding_min_annual_pct",
  "funding_hold_days",
  "perp_fee_rate",
  "funding_positions_enabled",
  "funding_position_size_usdt",
  "funding_max_positions",
  "funding_exit_annual_pct",
] as const;

/**
 * Read the stored settings as a {@link TaxPolicy}.
 *
 * `india_mode !== 0` rather than `=== 1`: the column is a number parsed out of
 * a TEXT settings row, and an operator (or a future UI) who writes `2`, `-1` or
 * `0.5` plainly means "on". Only an explicit zero means off, which is also the
 * value `DEFAULTS` seeds, so the fail-safe direction is preserved.
 */
export function toTaxPolicy(s: Settings): TaxPolicy {
  return {
    enabled: s.india_mode !== 0,
    tdsRate: s.tds_rate,
    taxRate: s.tax_rate,
  };
}

/**
 * Key of the best-effort scan mutex. It lives in `settings` rather than a table
 * of its own because it is exactly a single mutable string, and D1's single
 * writer makes the read-then-write race acceptable (see `src/scan.ts`).
 */
export const SCAN_LOCK_KEY = "scan_lock";

/**
 * Settings from D1 merged over {@link DEFAULTS}.
 *
 * Unknown keys (including `scan_lock`) and values that do not parse as finite
 * numbers are ignored, so a hand-edited row can never inject a `NaN` fee rate
 * into the engine.
 */
export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings")
    .all<{ key: string; value: string }>();

  const settings: Settings = { ...DEFAULTS };
  const known = new Set<string>(SETTING_KEYS);

  for (const row of results ?? []) {
    if (!known.has(row.key)) continue;
    const n = Number(row.value);
    if (!Number.isFinite(n)) continue;
    settings[row.key as SettingKey] = n;
  }
  return settings;
}

/** Write a subset of the numeric settings and return the merged result. */
export async function updateSettings(
  db: D1Database,
  patch: Partial<Settings>,
): Promise<Settings> {
  const statements = Object.entries(patch)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([key, value]) => upsertSettingStmt(db, key, String(value)));

  if (statements.length > 0) await db.batch(statements);
  return getSettings(db);
}

function upsertSettingStmt(
  db: D1Database,
  key: string,
  value: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?1, ?2)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);
}

/** Raw (untyped) settings read — used for `scan_lock`. */
export async function getRawSetting(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Raw settings write — used for `scan_lock`. */
export async function setRawSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await upsertSettingStmt(db, key, value).run();
}

export async function deleteRawSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
}

/**
 * Key of the cached perp funding-interval map.
 *
 * Lives in `settings` for exactly the reason {@link SCAN_LOCK_KEY} does: it is
 * one mutable blob with no relational content, no history worth keeping and no
 * query beyond "give me the whole thing". A table for it would be four columns
 * of ceremony around a single row. {@link getSettings} already ignores unknown
 * keys, so a JSON value here can never leak into a numeric tunable.
 */
export const FUNDING_INTERVALS_KEY = "funding_intervals";

/**
 * Key of the scan's own funding-poll marker: the clock of the last funding poll
 * **the scan performed**, as a decimal string.
 *
 * A settings row for the same reason {@link SCAN_LOCK_KEY} is one — a single
 * mutable scalar with no history worth keeping — and it exists because the
 * obvious alternative is wrong. The gate used to read `MAX(ts)` from
 * `funding_rates`, but `POST /api/funding/refresh` writes that table too, so a
 * refresh hit more often than `FUNDING_POLL_INTERVAL_MS` moved the gate forward
 * for ever and the scheduled poll never came due again — and with it the carry
 * pass, which only runs behind a scan's own poll, starved indefinitely. A
 * marker only the scan writes cannot be pushed around by an unauthenticated
 * POST: refresh goes on writing boards, and the scan's cadence is its own.
 *
 * Written **after** a poll succeeds, so a poll that threw part-way (a board
 * chunk that failed, a venue outage) is retried by the next scan rather than
 * waiting out an interval it never completed.
 */
export const FUNDING_POLL_TS_KEY = "funding_last_poll_ts";

/** The cached map plus the moment it was written, for TTL comparison. */
export interface FundingIntervalCache {
  ts: number;
  /** Venue instrument (`BTCUSDT`) to settlement cadence in minutes. */
  intervals: Record<string, number>;
}

/**
 * Read the funding-interval cache.
 *
 * Returns `null` for a missing row, a corrupt JSON value, a wrong-shaped
 * object *or* a read that threw. Every one of those means the same thing to the
 * caller — "no cadences known" — and the scanner's answer to it is to tag its
 * rows `interval_source = 'assumed'` and carry on. A cache is never worth
 * failing a poll over.
 */
export async function getFundingIntervals(
  db: D1Database,
): Promise<FundingIntervalCache | null> {
  let raw: string | null = null;
  try {
    raw = await getRawSetting(db, FUNDING_INTERVALS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<FundingIntervalCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Number.isFinite(parsed.ts)) return null;
    const intervals = parsed.intervals;
    if (!intervals || typeof intervals !== "object" || Array.isArray(intervals)) {
      return null;
    }

    // Re-validated on the way out, not trusted because it is ours: this row is
    // hand-editable, and a string where a number belongs would otherwise reach
    // the annualisation math.
    const clean: Record<string, number> = {};
    for (const [instrument, minutes] of Object.entries(intervals)) {
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
        clean[instrument] = minutes;
      }
    }
    return { ts: parsed.ts as number, intervals: clean };
  } catch {
    return null;
  }
}

/** Write the funding-interval cache. Failures are swallowed, as above. */
export async function setFundingIntervals(
  db: D1Database,
  intervals: Record<string, number>,
  ts: number = Date.now(),
): Promise<void> {
  try {
    await setRawSetting(db, FUNDING_INTERVALS_KEY, JSON.stringify({ ts, intervals }));
  } catch {
    /* the next poll re-fetches; a cold cache only costs one request */
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function countRows(db: D1Database, table: string): Promise<number> {
  // `table` is never caller-supplied — every call site passes a literal.
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Materialise first-run state. Safe to call on every request.
 *
 * Settings are inserted with `INSERT OR IGNORE` per key, so adding a new
 * tunable in a later release back-fills it without clobbering the ones the
 * operator already tuned. Balances are seeded only when the table is entirely
 * empty — a deliberately zeroed balance is real state, not an absence — so
 * this is the only write to that table the app makes on its own; the only
 * other one is {@link resetAll}, which an operator has to ask for.
 */
export async function ensureSeeded(db: D1Database): Promise<void> {
  await db.batch(
    SETTING_KEYS.map((key) =>
      db
        .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(key, String(DEFAULTS[key])),
    ),
  );

  if ((await countRows(db, "balances")) === 0) {
    const { initial_usdt } = await getSettings(db);
    await db
      .prepare("INSERT OR IGNORE INTO balances (asset, amount) VALUES (?1, ?2)")
      .bind(BASE_ASSET, initial_usdt)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Balances (read-only; see the module header)
// ---------------------------------------------------------------------------

export interface BalanceRow {
  asset: string;
  amount: number;
}

export async function getBalances(db: D1Database): Promise<BalanceRow[]> {
  const { results } = await db
    .prepare("SELECT asset, amount FROM balances ORDER BY asset")
    .all<BalanceRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

export interface PairRow extends PairInfo {
  source: string;
  updated_at: number;
}

export async function getPairs(db: D1Database): Promise<PairRow[]> {
  const { results } = await db
    .prepare("SELECT symbol, base, quote, source, updated_at FROM pairs ORDER BY symbol")
    .all<PairRow>();
  return results ?? [];
}

/**
 * Swap the whole pair cache atomically. Delete + insert in one batch so a
 * concurrent scan never observes an empty catalogue and re-triggers discovery.
 */
export async function replacePairs(
  db: D1Database,
  pairs: PairInfo[],
  source: string,
  ts: number = Date.now(),
): Promise<number> {
  const statements: D1PreparedStatement[] = [db.prepare("DELETE FROM pairs")];
  for (const p of pairs) {
    statements.push(
      db
        .prepare(
          "INSERT INTO pairs (symbol, base, quote, source, updated_at)" +
            " VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(p.symbol, p.base, p.quote, source, ts),
    );
  }
  await db.batch(statements);
  return pairs.length;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export interface ScanRow {
  id: number;
  ts: number;
  trigger: string;
  source: string | null;
  pairs_count: number;
  /**
   * Triangular figures, **historical**. Phase 12 deleted that strategy and
   * `finalizeScan` no longer writes these three, so every new row carries the
   * column defaults (`0` / `NULL` / `0`). They are still selected and still
   * served, because on the rows written before Phase 12 they are real data.
   */
  triangles_count: number;
  best_net_pct: number | null;
  executed_count: number;
  duration_ms: number;
  error: string | null;
  /** Cross-exchange spreads priced this scan; `0` when the strategy was off. */
  spreads_count: number;
  best_spread_net_pct: number | null;
  /** Why cross-exchange produced nothing. Never populates {@link error}. */
  xchg_error: string | null;
}

/**
 * Open a scan row up front and return its id.
 *
 * The row is created *before* any network work so that opportunities have a
 * `scan_id` to hang off and so that a scan which dies mid-flight still leaves a
 * trace; {@link finalizeScan} fills in the outcome.
 */
export async function insertScan(
  db: D1Database,
  trigger: string,
  ts: number = Date.now(),
): Promise<number> {
  const row = await db
    .prepare("INSERT INTO scans (ts, trigger) VALUES (?1, ?2) RETURNING id")
    .bind(ts, trigger)
    .first<{ id: number }>();
  if (!row) throw new Error("failed to create scan row");
  return row.id;
}

export interface ScanOutcome {
  source: string | null;
  pairsCount: number;
  durationMs: number;
  error: string | null;
  spreadsCount: number;
  bestSpreadNetPct: number | null;
  /**
   * A cross-exchange failure. Kept out of {@link error} on purpose: `error`
   * means "this scan failed", and a scan whose funding poll landed a full board
   * did not fail because one of two spot venues was unreachable.
   */
  xchgError: string | null;
}

/**
 * Record a scan's outcome.
 *
 * The three triangular columns are deliberately left out of the `UPDATE`
 * rather than written as zeros: the strategy is gone, and the schema default
 * (`0` / `NULL` / `0`) already says "not measured". `executed_count` is in the
 * same position for the same reason — nothing books a trade any more, and the
 * column stays only so the pre-Phase-12 rows keep their meaning.
 */
export async function finalizeScan(
  db: D1Database,
  scanId: number,
  outcome: ScanOutcome,
): Promise<void> {
  await db
    .prepare(
      "UPDATE scans SET source = ?2, pairs_count = ?3, duration_ms = ?4," +
        " error = ?5, spreads_count = ?6, best_spread_net_pct = ?7," +
        " xchg_error = ?8 WHERE id = ?1",
    )
    .bind(
      scanId,
      outcome.source,
      outcome.pairsCount,
      outcome.durationMs,
      outcome.error,
      outcome.spreadsCount,
      outcome.bestSpreadNetPct,
      outcome.xchgError,
    )
    .run();
}

export async function getScan(db: D1Database, id: number): Promise<ScanRow | null> {
  return db.prepare("SELECT * FROM scans WHERE id = ?1").bind(id).first<ScanRow>();
}

export async function listScans(db: D1Database, limit: number): Promise<ScanRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM scans ORDER BY ts DESC, id DESC LIMIT ?1")
    .bind(limit)
    .all<ScanRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface OpportunityRow {
  id: number;
  scan_id: number;
  ts: number;
  cycle: string;
  gross_pct: number;
  net_pct: number;
  /** Historical: `1` only on rows the pre-Phase-12 executor filled. */
  executed: number;
  legs_json: string;
  /** `NULL` when india mode was off for the scan that produced the row. */
  india_net_pct: number | null;
  tds_pct: number | null;
  /** `'triangular'` or `'cross_exchange'`; defaulted, never NULL. */
  strategy: string;
  /**
   * Phase 16 instrumentation; `NULL` is **not measured** throughout (migration
   * 0006). `skew_ms` is the distance between the two books the row was priced
   * from; `persist_net_pct` is the same trade re-priced against the next scan's
   * snapshot, and is `NULL` even after `persist_checked_ts` when the row expired
   * before any fresh snapshot could price it.
   */
  skew_ms: number | null;
  persist_net_pct: number | null;
  persist_checked_ts: number | null;
}

/** The shape the API hands out: `legs_json` parsed, `executed` as a boolean. */
export interface Opportunity {
  id: number;
  scanId: number;
  ts: number;
  cycle: string;
  grossPct: number;
  netPct: number;
  executed: boolean;
  legs: ExecutedLeg[];
  /** `null` when india mode was off — "not measured", not "measured as zero". */
  indiaNetPct: number | null;
  tdsPct: number | null;
  strategy: string;
  /** Milliseconds between the two books this row was priced from; `null` when
   *  the row predates the measurement or only one venue answered. */
  skewMs: number | null;
  /** This spread re-priced against the next scan's books; `null` when it was
   *  never re-priced *or* expired unmeasured. `persistCheckedTs` tells the two
   *  apart: set-with-null is expired, null is not yet looked at. */
  persistNetPct: number | null;
  persistCheckedTs: number | null;
}

/** Tolerant parse: a corrupt `legs_json` degrades to `[]` rather than a 500. */
function parseLegs(json: string): ExecutedLeg[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ExecutedLeg[]) : [];
  } catch {
    return [];
  }
}

export function toOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    scanId: row.scan_id,
    ts: row.ts,
    cycle: row.cycle,
    grossPct: row.gross_pct,
    netPct: row.net_pct,
    executed: row.executed !== 0,
    legs: parseLegs(row.legs_json),
    indiaNetPct: row.india_net_pct ?? null,
    tdsPct: row.tds_pct ?? null,
    // A row written before migration 0003 has no column at all; it was a
    // triangle, so that is what it reads back as rather than an empty string.
    strategy: row.strategy ?? STRATEGY_TRIANGULAR,
    skewMs: row.skew_ms ?? null,
    persistNetPct: row.persist_net_pct ?? null,
    persistCheckedTs: row.persist_checked_ts ?? null,
  };
}

/** What the engine hands us, narrowed to just what is persisted. */
export interface OpportunityInput {
  cycle: string;
  grossPct: number;
  netPct: number;
  legs: ExecutedLeg[];
  /** Omitted (or null) when india mode is off; persisted as SQL NULL. */
  indiaNetPct?: number | null;
  tdsPct?: number | null;
  /**
   * Distance in ms between the two books this quote was priced from. Omitted
   * (or null) when only one venue answered, or for a strategy that is not
   * priced from two snapshots at all — SQL NULL then means "not measured",
   * exactly as it does for the india columns above.
   */
  skewMs?: number | null;
}

/**
 * Persist a scan's ranked opportunities and return their ids **in the same
 * order**, so the caller can correlate a row with the quote it came from.
 *
 * `executed` is written as a literal `0`: nothing fills any more, and the
 * column is kept only so the pre-Phase-12 rows keep their meaning.
 *
 * `strategy` is required rather than defaulted. It used to default to
 * `triangular` so that pre-Phase-9 call sites needed no edit; with that
 * strategy deleted, a default would be a wrong answer waiting to be inherited.
 */
export async function insertOpportunities(
  db: D1Database,
  scanId: number,
  quotes: OpportunityInput[],
  ts: number,
  strategy: Strategy,
): Promise<number[]> {
  if (quotes.length === 0) return [];

  const results = await db.batch<{ id: number }>(
    quotes.map((q) =>
      db
        .prepare(
          "INSERT INTO opportunities (scan_id, ts, cycle, gross_pct, net_pct, executed," +
            " legs_json, india_net_pct, tds_pct, strategy, skew_ms)" +
            " VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10) RETURNING id",
        )
        .bind(
          scanId,
          ts,
          q.cycle,
          q.grossPct,
          q.netPct,
          JSON.stringify(q.legs),
          q.indiaNetPct ?? null,
          q.tdsPct ?? null,
          strategy,
          q.skewMs ?? null,
        ),
    ),
  );

  return results.map((r) => r.results[0]?.id).filter((id): id is number => id != null);
}

/**
 * Newest opportunities first, optionally narrowed to one strategy.
 *
 * The filter is applied in SQL rather than by slicing the result, so a
 * `?strategy=` request still returns `limit` rows of the strategy asked for
 * instead of however many happen to survive in the newest `limit` overall.
 */
export async function listOpportunities(
  db: D1Database,
  limit: number,
  strategy?: Strategy,
): Promise<Opportunity[]> {
  const { results } = strategy
    ? await db
        .prepare(
          "SELECT * FROM opportunities WHERE strategy = ?2" +
            " ORDER BY ts DESC, id DESC LIMIT ?1",
        )
        .bind(limit, strategy)
        .all<OpportunityRow>()
    : await db
        .prepare("SELECT * FROM opportunities ORDER BY ts DESC, id DESC LIMIT ?1")
        .bind(limit)
        .all<OpportunityRow>();
  return (results ?? []).map(toOpportunity);
}

export async function listOpportunitiesForScan(
  db: D1Database,
  scanId: number,
): Promise<Opportunity[]> {
  const { results } = await db
    .prepare("SELECT * FROM opportunities WHERE scan_id = ?1 ORDER BY net_pct DESC, id ASC")
    .bind(scanId)
    .all<OpportunityRow>();
  return (results ?? []).map(toOpportunity);
}

/**
 * Rows of one strategy that have never been re-priced, newest first, no older
 * than `sinceTs`.
 *
 * The age floor is not an optimisation. Without it the first scan after
 * migration 0006 would find every spread row ever written — none of them has a
 * `persist_checked_ts` — and would mark each one "expired, unmeasured" a
 * batch at a time for as long as the backlog lasted. Those rows are unmeasured,
 * and NULL already says so; stamping them would replace a true statement with a
 * noisier one. So the window is bounded and anything outside it keeps its
 * honest NULL for ever. See {@link import("./scan").SPREAD_PERSIST_LOOKBACK_MS}.
 *
 * `strategy` is required rather than defaulted for the reason
 * {@link insertOpportunities}'s is: this measurement is meaningful only for a
 * two-venue spread, and letting it default would let it walk the pre-Phase-12
 * triangular history.
 *
 * Newest first, so a `limit` smaller than the backlog spends itself on the rows
 * that can still be *priced* rather than on the ones already past their
 * measurement window. The starved older rows fall out of `sinceTs` in due
 * course and keep the NULL that has been true of them all along.
 */
export async function listUnmeasuredOpportunities(
  db: D1Database,
  strategy: Strategy,
  sinceTs: number,
  limit: number,
): Promise<Opportunity[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM opportunities WHERE strategy = ?1 AND persist_checked_ts IS NULL" +
        " AND ts >= ?2 ORDER BY ts DESC, id DESC LIMIT ?3",
    )
    .bind(strategy, sinceTs, limit)
    .all<OpportunityRow>();
  return (results ?? []).map(toOpportunity);
}

/** One row's survival measurement: the re-priced net, or `null` for expired. */
export interface OpportunityPersistence {
  id: number;
  /** The same trade's net % on a later snapshot; `null` = never priced. */
  persistNetPct: number | null;
  checkedTs: number;
}

/**
 * Stamp the survival measurement onto rows, in one batch.
 *
 * `WHERE persist_checked_ts IS NULL` makes the write **idempotent per row**: a
 * second scan racing the first (a manual scan against the cron tick) cannot
 * overwrite a figure with its own, so a row is measured exactly once and the
 * distribution the report reads is not silently weighted towards whichever rows
 * happened to be re-priced twice.
 *
 * Returns how many rows this call actually stamped, which is what the caller
 * reports — never the length of the input.
 */
export async function markOpportunityPersistence(
  db: D1Database,
  marks: OpportunityPersistence[],
): Promise<number> {
  if (marks.length === 0) return 0;

  const results = await db.batch(
    marks.map((m) =>
      db
        .prepare(
          "UPDATE opportunities SET persist_net_pct = ?2, persist_checked_ts = ?3" +
            " WHERE id = ?1 AND persist_checked_ts IS NULL",
        )
        .bind(m.id, m.persistNetPct, m.checkedTs),
    ),
  );

  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Trades (read-only; see the module header)
// ---------------------------------------------------------------------------

export interface TradeRow {
  id: number;
  ts: number;
  cycle: string;
  start_amount: number;
  end_amount: number;
  profit: number;
  profit_pct: number;
  legs_json: string;
  source: string | null;
  opportunity_id: number | null;
  tds_base: number;
  tds_withheld: number;
  tax_due: number;
  /** `NULL` on rows written before migration 0002; readers fall back to `profit`. */
  net_profit: number | null;
  tds_rate: number;
  tax_rate: number;
  /** `'triangular'` or `'cross_exchange'`; defaulted, never NULL. */
  strategy: string;
}

export interface Trade {
  id: number;
  ts: number;
  cycle: string;
  startAmount: number;
  endAmount: number;
  profit: number;
  profitPct: number;
  source: string | null;
  opportunityId: number | null;
  legs: ExecutedLeg[];
  tdsBase: number;
  tdsWithheld: number;
  taxDue: number;
  /** `profit - taxDue`; equals `profit` for a pre-feature or untaxed row. */
  netProfit: number;
  netProfitPct: number;
  tdsRate: number;
  taxRate: number;
  strategy: string;
}

export function toTrade(row: TradeRow): Trade {
  // A pre-Phase-8 row has no `net_profit`, and in a world with no tax the net
  // profit *is* the gross profit — so the fallback is the right answer, not a
  // placeholder. `?? 0` on the NOT NULL columns only guards a hand-built row.
  const netProfit = row.net_profit ?? row.profit;
  const startAmount = row.start_amount;

  return {
    id: row.id,
    ts: row.ts,
    cycle: row.cycle,
    startAmount,
    endAmount: row.end_amount,
    profit: row.profit,
    profitPct: row.profit_pct,
    source: row.source,
    opportunityId: row.opportunity_id,
    legs: parseLegs(row.legs_json),
    tdsBase: row.tds_base ?? 0,
    tdsWithheld: row.tds_withheld ?? 0,
    taxDue: row.tax_due ?? 0,
    netProfit,
    // A zero (or absent) notional has no meaningful percentage return; guarding
    // here rather than at the call sites keeps `NaN` out of the API entirely.
    netProfitPct: startAmount > 0 ? round8((netProfit / startAmount) * 100) : 0,
    tdsRate: row.tds_rate ?? 0,
    taxRate: row.tax_rate ?? 0,
    strategy: row.strategy ?? STRATEGY_TRIANGULAR,
  };
}

/** Newest trades first, optionally narrowed to one strategy (see
 *  {@link listOpportunities} for why the filter is in SQL). */
export async function listTrades(
  db: D1Database,
  limit: number,
  strategy?: Strategy,
): Promise<Trade[]> {
  const { results } = strategy
    ? await db
        .prepare(
          "SELECT * FROM trades WHERE strategy = ?2 ORDER BY ts DESC, id DESC LIMIT ?1",
        )
        .bind(limit, strategy)
        .all<TradeRow>()
    : await db
        .prepare("SELECT * FROM trades ORDER BY ts DESC, id DESC LIMIT ?1")
        .bind(limit)
        .all<TradeRow>();
  return (results ?? []).map(toTrade);
}

/** Lifetime tax aggregates over every trade ever booked. */
export interface TaxTotals {
  trades: number;
  /** Trades with a positive gross profit — the only ones that owe 115BBH tax. */
  profitableTrades: number;
  grossProfit: number;
  tdsWithheld: number;
  taxDue: number;
  netProfit: number;
}

/**
 * Aggregate the tax columns in one round trip.
 *
 * `SUM` over zero rows is `NULL`, not `0`, so every total is wrapped in
 * `COALESCE` — a fresh database must report zeros, not nulls the dashboard
 * would render as `—`. `net_profit` gets a second, inner `COALESCE` because
 * rows written before migration 0002 have none, and for them the gross profit
 * *is* the net profit.
 */
export async function getTaxTotals(db: D1Database): Promise<TaxTotals> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS trades," +
        " COALESCE(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END), 0) AS profitable_trades," +
        " COALESCE(SUM(profit), 0) AS gross_profit," +
        " COALESCE(SUM(tds_withheld), 0) AS tds_withheld," +
        " COALESCE(SUM(tax_due), 0) AS tax_due," +
        " COALESCE(SUM(COALESCE(net_profit, profit)), 0) AS net_profit" +
        " FROM trades",
    )
    .first<{
      trades: number;
      profitable_trades: number;
      gross_profit: number;
      tds_withheld: number;
      tax_due: number;
      net_profit: number;
    }>();

  return {
    trades: row?.trades ?? 0,
    profitableTrades: row?.profitable_trades ?? 0,
    grossProfit: round8(row?.gross_profit ?? 0),
    tdsWithheld: round8(row?.tds_withheld ?? 0),
    taxDue: round8(row?.tax_due ?? 0),
    netProfit: round8(row?.net_profit ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Funding rates
// ---------------------------------------------------------------------------

/**
 * How long a funding row is kept: 7 days.
 *
 * Unlike trades and opportunities — which are the permanent record of what the
 * paper portfolio did — funding rows are a *sampled time series*, written every
 * 5 minutes whether anything changed or not. A week is enough to see a rate
 * regime shift (funding turns over on the scale of days) and bounds the table
 * at ~22k rows for an 11-asset universe, which keeps the free-tier D1 read
 * budget uneventful. Pruning is amortised into the insert batch rather than run
 * as a separate job: there is no scheduler here that could own it, and a
 * retention pass that only runs when rows are added can never fall behind.
 */
export const FUNDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface FundingRateRow {
  id: number;
  /** `NULL` for a manual refresh — that poll belongs to no scan. */
  scan_id: number | null;
  ts: number;
  venue: string;
  symbol: string;
  instrument: string;
  rate: number;
  interval_minutes: number;
  interval_source: string;
  annualized_pct: number;
  net_annual_pct: number;
  next_funding_ts: number | null;
  mark_price: number | null;
}

/** The shape the API hands out: camel-cased, nulls preserved. */
export interface FundingRate {
  id: number;
  scanId: number | null;
  ts: number;
  venue: string;
  symbol: string;
  instrument: string;
  rate: number;
  intervalMinutes: number;
  intervalSource: string;
  annualizedPct: number;
  netAnnualPct: number;
  nextFundingTs: number | null;
  markPrice: number | null;
}

export function toFundingRate(row: FundingRateRow): FundingRate {
  return {
    id: row.id,
    scanId: row.scan_id ?? null,
    ts: row.ts,
    venue: row.venue,
    symbol: row.symbol,
    instrument: row.instrument,
    rate: row.rate,
    intervalMinutes: row.interval_minutes,
    intervalSource: row.interval_source,
    annualizedPct: row.annualized_pct,
    netAnnualPct: row.net_annual_pct,
    nextFundingTs: row.next_funding_ts ?? null,
    markPrice: row.mark_price ?? null,
  };
}

/** What the scanner hands us, narrowed to just what is persisted. */
export interface FundingRateInput {
  venue: string;
  symbol: string;
  instrument: string;
  rate: number;
  intervalMinutes: number;
  intervalSource: string;
  annualizedPct: number;
  netAnnualPct: number;
  nextFundingTs: number | null;
  markPrice: number | null;
}

/**
 * Statements per `batch()` call when writing a board.
 *
 * D1 caps how many statements one batch may carry, and Phase 14's multi-venue
 * board is the first thing here that can plausibly approach it. The ceiling is
 * **94**, not the `4 x 36 = 144` an earlier revision of this comment claimed:
 * only the two full-board venues contribute a tail, because Bybit and OKX are
 * polled per major and cannot quote anything else.
 *
 * ```
 * gate     11 majors + 25 tail  = 36
 * kucoin   11 majors + 25 tail  = 36
 * bybit    11 majors            = 11
 * okx      11 majors            = 11
 *                               ---
 *                                94   (+1 per open carry position retained
 *                                      through the cap; see capFundingBoard)
 * ```
 *
 * 50 is a defensive fraction of the documented limit, chosen so the chunking is
 * exercised by every real poll rather than only by the day the board grows.
 */
export const FUNDING_INSERT_CHUNK = 50;

/**
 * Persist one poll's board and prune everything older than the retention
 * window.
 *
 * The `DELETE` is relative to *this poll's* `ts` rather than to `Date.now()` so
 * a back-dated poll (a test, a replay) prunes against its own clock, and it
 * rides in the **last** chunk: pruning only after every insert has landed means
 * a failure part-way through costs rows nobody had yet, never rows somebody
 * already had.
 *
 * **The board is no longer one transaction.** It was, while it fit in a single
 * `batch()`; a multi-venue board does not, and D1 has no cross-batch
 * transaction. So a reader can observe a *partial* board — fewer rows at the
 * newest `ts`, never a mixture of two polls, since every row of a poll shares
 * one timestamp.
 *
 * **A chunk that fails part-way leaves that truncated board in place until the
 * next scan.** The chunks that already landed carry the new `ts`, so
 * `/api/funding` serves the truncated board as if it were complete and the
 * venues whose rows were in the lost chunks look like venues that quoted
 * nothing. The throw does reach `ScanResult.fundingError`, so the failure is
 * visible in the scan toast and in `wrangler tail`; the board itself carries no
 * mark of being short.
 *
 * The window is one scan rather than one poll interval because the gate reads
 * {@link FUNDING_POLL_TS_KEY}, which is written only *after* a poll returns: a
 * poll that threw here never advanced it, so the next scan polls again
 * immediately instead of waiting out `FUNDING_POLL_INTERVAL_MS`.
 *
 * That is the accepted cost of the alternative — exceeding D1's statement limit
 * and writing no board at all.
 */
export async function insertFundingRates(
  db: D1Database,
  scanId: number | null,
  rows: FundingRateInput[],
  ts: number = Date.now(),
): Promise<number> {
  if (rows.length === 0) return 0;

  const inserts: D1PreparedStatement[] = rows.map((r) =>
    db
      .prepare(
        "INSERT INTO funding_rates (scan_id, ts, venue, symbol, instrument, rate," +
          " interval_minutes, interval_source, annualized_pct, net_annual_pct," +
          " next_funding_ts, mark_price)" +
          " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      )
      .bind(
        scanId,
        ts,
        r.venue,
        r.symbol,
        r.instrument,
        r.rate,
        r.intervalMinutes,
        r.intervalSource,
        r.annualizedPct,
        r.netAnnualPct,
        r.nextFundingTs,
        r.markPrice,
      ),
  );

  const chunks: D1PreparedStatement[][] = [];
  for (let i = 0; i < inserts.length; i += FUNDING_INSERT_CHUNK) {
    chunks.push(inserts.slice(i, i + FUNDING_INSERT_CHUNK));
  }

  const prune = db
    .prepare("DELETE FROM funding_rates WHERE ts < ?1")
    .bind(ts - FUNDING_RETENTION_MS);
  const last = chunks[chunks.length - 1];
  if (last.length < FUNDING_INSERT_CHUNK) last.push(prune);
  else chunks.push([prune]);

  for (const chunk of chunks) {
    await db.batch(chunk);
  }
  return rows.length;
}

/**
 * The newest complete board, best net carry first.
 *
 * Selected by `ts = (SELECT MAX(ts) …)` rather than by `ORDER BY ts DESC LIMIT
 * n`: one poll writes one timestamp for all of its rows, so this returns
 * exactly one board and never a mixture of two — which is what a `LIMIT` would
 * silently produce if the universe size ever changed between polls.
 *
 * Ranked by net carry across **all** venues, which is the question the board
 * answers since Phase 14: the best carry available anywhere, not the best carry
 * on whichever venue happened to answer. `venue` joins the tie-break so two
 * venues quoting one symbol at one rate still come back in a stable order.
 */
export async function listLatestFundingRates(db: D1Database): Promise<FundingRate[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM funding_rates WHERE ts = (SELECT MAX(ts) FROM funding_rates)" +
        " ORDER BY net_annual_pct DESC, symbol ASC, venue ASC",
    )
    .all<FundingRateRow>();
  return (results ?? []).map(toFundingRate);
}

/**
 * One symbol's history, newest first. An unknown symbol is simply empty.
 *
 * `venue` is optional and defaults to "every venue". It exists because a
 * multi-venue board makes `?symbol=BTC` ambiguous in a way it never was under
 * the old fallback chain: up to four rows now share a timestamp, and a chart
 * drawn from the mixture would zig-zag between venues rather than show either
 * one's series. Filtering in SQL, not by slicing the result, so a narrowed
 * request still returns `limit` rows of the venue asked for.
 */
export async function listFundingRatesForSymbol(
  db: D1Database,
  symbol: string,
  limit: number,
  venue?: string,
): Promise<FundingRate[]> {
  const { results } = venue
    ? await db
        .prepare(
          "SELECT * FROM funding_rates WHERE symbol = ?1 AND venue = ?3" +
            " ORDER BY ts DESC, id DESC LIMIT ?2",
        )
        .bind(symbol, limit, venue)
        .all<FundingRateRow>()
    : await db
        .prepare(
          "SELECT * FROM funding_rates WHERE symbol = ?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )
        .bind(symbol, limit)
        .all<FundingRateRow>();
  return (results ?? []).map(toFundingRate);
}

/**
 * The newest rate row for one `(venue, symbol)`, whatever board it came from.
 *
 * Not `listLatestFundingRates` filtered: the board is capped per venue, so a
 * tail contract can drop off the newest poll and still be the position someone
 * is holding. This answers "what is the last thing we know about this
 * contract", which is what both the close rules and the staleness clock need.
 */
export async function getLatestFundingRateFor(
  db: D1Database,
  venue: string,
  symbol: string,
): Promise<FundingRate | null> {
  const row = await db
    .prepare(
      "SELECT * FROM funding_rates WHERE venue = ?1 AND symbol = ?2" +
        " ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .bind(venue, symbol)
    .first<FundingRateRow>();
  return row ? toFundingRate(row) : null;
}

/**
 * The rate that was in force at `atTs` for one `(venue, symbol)`: the newest row
 * at or before it, but no older than `minTs`.
 *
 * The floor is not optional. Without it a settlement boundary in the middle of
 * an outage would be priced off whatever row happened to survive from days
 * earlier, and the accrual would look complete when it was invented. With it,
 * an unobserved boundary answers `null` and the caller skips it — see the
 * accrual notes in `src/engine/carry.ts`.
 */
export async function getFundingRateAt(
  db: D1Database,
  venue: string,
  symbol: string,
  atTs: number,
  minTs: number,
): Promise<FundingRate | null> {
  const row = await db
    .prepare(
      "SELECT * FROM funding_rates WHERE venue = ?1 AND symbol = ?2" +
        " AND ts <= ?3 AND ts >= ?4 ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .bind(venue, symbol, atTs, minTs)
    .first<FundingRateRow>();
  return row ? toFundingRate(row) : null;
}

// ---------------------------------------------------------------------------
// Basis rates (OKX dated futures)
// ---------------------------------------------------------------------------

/**
 * Key of the scan's own basis-poll marker, exactly parallel to
 * {@link FUNDING_POLL_TS_KEY} and for the same reasons: a single mutable scalar
 * with no history worth keeping, written only *after* a poll returns so a poll
 * that threw part-way is retried by the next scan rather than holding the gate
 * shut for a full interval.
 *
 * Its own key rather than sharing the funding one, because the two polls fail
 * independently by design: a basis outage must not stop the funding board being
 * polled on its own cadence, nor the reverse.
 */
export const BASIS_POLL_TS_KEY = "basis_last_poll_ts";

/**
 * How long a basis row is kept: 7 days, the same window
 * {@link FUNDING_RETENTION_MS} gives a funding row.
 *
 * Deliberately identical rather than merely similar. `GET /api/report` reports
 * both strategies over one window and clamps its `?days=` to this retention, so
 * two different windows would mean the report's own header could only ever
 * describe one of the two tables honestly.
 */
export const BASIS_RETENTION_MS = FUNDING_RETENTION_MS;

/** Statements per `batch()` when writing a basis board. See
 *  {@link FUNDING_INSERT_CHUNK}; a live OKX board is ~20 rows, so this has
 *  headroom of an order of magnitude and chunks anyway. */
export const BASIS_INSERT_CHUNK = FUNDING_INSERT_CHUNK;

export interface BasisRateRow {
  id: number;
  /** `NULL` for a poll that belongs to no scan. */
  scan_id: number | null;
  ts: number;
  venue: string;
  symbol: string;
  instrument: string;
  expiry_ts: number;
  days_to_expiry: number;
  spot_price: number;
  future_price: number;
  price_source: string;
  basis_pct: number;
  annualized_pct: number;
  net_annual_pct: number;
}

/** The shape the API hands out: camel-cased, nulls preserved. */
export interface BasisRate {
  id: number;
  scanId: number | null;
  ts: number;
  venue: string;
  symbol: string;
  instrument: string;
  expiryTs: number;
  daysToExpiry: number;
  spotPrice: number;
  futurePrice: number;
  /** `'mid'` or `'last'`; a row is only as live as its weaker leg. */
  priceSource: string;
  basisPct: number;
  annualizedPct: number;
  netAnnualPct: number;
}

export function toBasisRate(row: BasisRateRow): BasisRate {
  return {
    id: row.id,
    scanId: row.scan_id ?? null,
    ts: row.ts,
    venue: row.venue,
    symbol: row.symbol,
    instrument: row.instrument,
    expiryTs: row.expiry_ts,
    daysToExpiry: row.days_to_expiry,
    spotPrice: row.spot_price,
    futurePrice: row.future_price,
    priceSource: row.price_source,
    basisPct: row.basis_pct,
    annualizedPct: row.annualized_pct,
    netAnnualPct: row.net_annual_pct,
  };
}

/** What the scanner hands us, narrowed to just what is persisted. */
export interface BasisRateInput {
  venue: string;
  symbol: string;
  instrument: string;
  expiryTs: number;
  daysToExpiry: number;
  spotPrice: number;
  futurePrice: number;
  priceSource: string;
  basisPct: number;
  annualizedPct: number;
  netAnnualPct: number;
}

/**
 * Persist one poll's basis board and prune past the retention window.
 *
 * A structural copy of {@link insertFundingRates}, chunking and all, and the
 * duplication is on purpose: the two tables have different columns and sharing
 * an insert path would mean a generic row-shape abstraction sitting between the
 * scanner and its SQL. The `DELETE` is relative to *this poll's* `ts` rather
 * than to `Date.now()` so a back-dated poll prunes against its own clock, and it
 * rides in the **last** chunk, so a failure part-way costs rows nobody had yet
 * rather than rows somebody already had.
 */
export async function insertBasisRates(
  db: D1Database,
  scanId: number | null,
  rows: BasisRateInput[],
  ts: number = Date.now(),
): Promise<number> {
  if (rows.length === 0) return 0;

  const inserts: D1PreparedStatement[] = rows.map((r) =>
    db
      .prepare(
        "INSERT INTO basis_rates (scan_id, ts, venue, symbol, instrument, expiry_ts," +
          " days_to_expiry, spot_price, future_price, price_source, basis_pct," +
          " annualized_pct, net_annual_pct)" +
          " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      )
      .bind(
        scanId,
        ts,
        r.venue,
        r.symbol,
        r.instrument,
        r.expiryTs,
        r.daysToExpiry,
        r.spotPrice,
        r.futurePrice,
        r.priceSource,
        r.basisPct,
        r.annualizedPct,
        r.netAnnualPct,
      ),
  );

  const chunks: D1PreparedStatement[][] = [];
  for (let i = 0; i < inserts.length; i += BASIS_INSERT_CHUNK) {
    chunks.push(inserts.slice(i, i + BASIS_INSERT_CHUNK));
  }

  const prune = db
    .prepare("DELETE FROM basis_rates WHERE ts < ?1")
    .bind(ts - BASIS_RETENTION_MS);
  const last = chunks[chunks.length - 1];
  if (last.length < BASIS_INSERT_CHUNK) last.push(prune);
  else chunks.push([prune]);

  for (const chunk of chunks) {
    await db.batch(chunk);
  }
  return rows.length;
}

/**
 * The newest complete basis board, best net annual first.
 *
 * Selected by `ts = (SELECT MAX(ts) …)` for the reason
 * {@link listLatestFundingRates} is: one poll writes one timestamp for all of
 * its rows, so this returns exactly one board and never a mixture of two.
 * `instrument` joins the tie-break — one symbol has several contracts on this
 * board at once, so the symbol alone is not a stable ordering key here.
 */
export async function listLatestBasisRates(db: D1Database): Promise<BasisRate[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM basis_rates WHERE ts = (SELECT MAX(ts) FROM basis_rates)" +
        " ORDER BY net_annual_pct DESC, symbol ASC, instrument ASC",
    )
    .all<BasisRateRow>();
  return (results ?? []).map(toBasisRate);
}

// ---------------------------------------------------------------------------
// Funding positions (paper carry)
// ---------------------------------------------------------------------------

/** The two `funding_positions.status` values. Free TEXT in SQL; owned here. */
export const CARRY_STATUS_OPEN = "open";
export const CARRY_STATUS_CLOSED = "closed";

export interface FundingPositionRow {
  id: number;
  opened_scan_id: number | null;
  status: string;
  venue: string;
  symbol: string;
  instrument: string;
  notional_usdt: number;
  entry_ts: number;
  entry_rate: number;
  entry_annualized_pct: number;
  interval_minutes: number;
  spot_fee_rate: number;
  perp_fee_rate: number;
  accrued_funding_usdt: number;
  accrual_count: number;
  last_accrual_ts: number | null;
  predicted_net_annual_pct: number;
  close_ts: number | null;
  close_reason: string | null;
  realized_pnl_usdt: number | null;
  realized_annual_pct: number | null;
}

/** The shape the API hands out: camel-cased, nulls preserved. */
export interface FundingPosition {
  id: number;
  openedScanId: number | null;
  status: string;
  venue: string;
  symbol: string;
  instrument: string;
  notionalUsdt: number;
  entryTs: number;
  entryRate: number;
  entryAnnualizedPct: number;
  intervalMinutes: number;
  spotFeeRate: number;
  perpFeeRate: number;
  accruedFundingUsdt: number;
  accrualCount: number;
  lastAccrualTs: number | null;
  predictedNetAnnualPct: number;
  closeTs: number | null;
  closeReason: string | null;
  realizedPnlUsdt: number | null;
  realizedAnnualPct: number | null;
}

export function toFundingPosition(row: FundingPositionRow): FundingPosition {
  return {
    id: row.id,
    openedScanId: row.opened_scan_id ?? null,
    status: row.status,
    venue: row.venue,
    symbol: row.symbol,
    instrument: row.instrument,
    notionalUsdt: row.notional_usdt,
    entryTs: row.entry_ts,
    entryRate: row.entry_rate,
    entryAnnualizedPct: row.entry_annualized_pct,
    intervalMinutes: row.interval_minutes,
    spotFeeRate: row.spot_fee_rate,
    perpFeeRate: row.perp_fee_rate,
    accruedFundingUsdt: row.accrued_funding_usdt ?? 0,
    accrualCount: row.accrual_count ?? 0,
    lastAccrualTs: row.last_accrual_ts ?? null,
    predictedNetAnnualPct: row.predicted_net_annual_pct,
    closeTs: row.close_ts ?? null,
    closeReason: row.close_reason ?? null,
    realizedPnlUsdt: row.realized_pnl_usdt ?? null,
    realizedAnnualPct: row.realized_annual_pct ?? null,
  };
}

/** What the scanner supplies to open a position. */
export interface FundingPositionInput {
  venue: string;
  symbol: string;
  instrument: string;
  notionalUsdt: number;
  entryTs: number;
  entryRate: number;
  entryAnnualizedPct: number;
  intervalMinutes: number;
  spotFeeRate: number;
  perpFeeRate: number;
  predictedNetAnnualPct: number;
}

/**
 * Open a position and return its id.
 *
 * `accrued_funding_usdt`, `accrual_count` and the four close columns are left
 * to their schema defaults: a brand-new position has collected nothing and has
 * no realised anything, and NULL there means "still running" rather than "closed
 * at zero". `last_accrual_ts` stays NULL too — the accrual grid falls back to
 * `entry_ts` until the first boundary crosses.
 */
export async function insertFundingPosition(
  db: D1Database,
  scanId: number | null,
  input: FundingPositionInput,
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO funding_positions (opened_scan_id, status, venue, symbol," +
        " instrument, notional_usdt, entry_ts, entry_rate, entry_annualized_pct," +
        " interval_minutes, spot_fee_rate, perp_fee_rate, predicted_net_annual_pct)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id",
    )
    .bind(
      scanId,
      CARRY_STATUS_OPEN,
      input.venue,
      input.symbol,
      input.instrument,
      input.notionalUsdt,
      input.entryTs,
      input.entryRate,
      input.entryAnnualizedPct,
      input.intervalMinutes,
      input.spotFeeRate,
      input.perpFeeRate,
      input.predictedNetAnnualPct,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("failed to create funding position");
  return row.id;
}

/** Every open position, oldest entry first — the order they are accrued in. */
export async function listOpenFundingPositions(
  db: D1Database,
): Promise<FundingPosition[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM funding_positions WHERE status = ?1 ORDER BY entry_ts ASC, id ASC",
    )
    .bind(CARRY_STATUS_OPEN)
    .all<FundingPositionRow>();
  return (results ?? []).map(toFundingPosition);
}

/** The most recently closed positions, newest close first. */
export async function listClosedFundingPositions(
  db: D1Database,
  limit: number,
): Promise<FundingPosition[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM funding_positions WHERE status = ?1" +
        " ORDER BY close_ts DESC, id DESC LIMIT ?2",
    )
    .bind(CARRY_STATUS_CLOSED, limit)
    .all<FundingPositionRow>();
  return (results ?? []).map(toFundingPosition);
}

export async function getFundingPosition(
  db: D1Database,
  id: number,
): Promise<FundingPosition | null> {
  const row = await db
    .prepare("SELECT * FROM funding_positions WHERE id = ?1")
    .bind(id)
    .first<FundingPositionRow>();
  return row ? toFundingPosition(row) : null;
}

/**
 * Record one accrual pass: the new running totals and the newest boundary they
 * cover.
 *
 * Absolute values rather than `accrued = accrued + ?`, because the caller has
 * already rounded the sum through `round8` and a SQL-side addition would
 * accumulate float noise the API then reports to eight decimals. The read and
 * the write are not one transaction, which is safe here for the reason the scan
 * lock exists: accrual only ever runs inside a scan, and D1 has one writer.
 *
 * `WHERE status = 'open'` so a position closed by the manual route between the
 * read and this write is not silently resurrected with new figures.
 *
 * Returns whether the row was actually updated, exactly as
 * {@link closeFundingPosition} does. A no-op means the position was closed
 * underneath this pass, and the caller must not report the funding it computed
 * in memory: that USDT is held by no row anywhere.
 */
export async function accrueFundingPosition(
  db: D1Database,
  id: number,
  accruedFundingUsdt: number,
  accrualCount: number,
  lastAccrualTs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE funding_positions SET accrued_funding_usdt = ?2, accrual_count = ?3," +
        " last_accrual_ts = ?4 WHERE id = ?1 AND status = ?5",
    )
    .bind(id, accruedFundingUsdt, accrualCount, lastAccrualTs, CARRY_STATUS_OPEN)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** The four figures a close writes. */
export interface FundingPositionClose {
  closeTs: number;
  closeReason: string;
  realizedPnlUsdt: number | null;
  realizedAnnualPct: number | null;
}

/**
 * Close a position, if it is still open.
 *
 * Returns whether this call is the one that closed it. The guard is what makes
 * `POST /api/funding/positions/:id/close` answer 409 rather than overwriting a
 * realised P&L the scanner already computed — two different close reasons for
 * one position would make the series unreadable.
 */
export async function closeFundingPosition(
  db: D1Database,
  id: number,
  close: FundingPositionClose,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE funding_positions SET status = ?2, close_ts = ?3, close_reason = ?4," +
        " realized_pnl_usdt = ?5, realized_annual_pct = ?6" +
        " WHERE id = ?1 AND status = ?7",
    )
    .bind(
      id,
      CARRY_STATUS_CLOSED,
      close.closeTs,
      close.closeReason,
      close.realizedPnlUsdt,
      close.realizedAnnualPct,
      CARRY_STATUS_OPEN,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Lifetime carry aggregates, as its **own** section of the portfolio.
 *
 * Never mixed into `equityUsdt` or the `balances` rows: migration 0005's header
 * is explicit that a position held for days cannot be booked against a paper
 * balance whose whole history is atomic round trips. So this is reported beside
 * that figure and never inside it.
 */
export interface CarryTotals {
  openCount: number;
  closedCount: number;
  /** Notional of the open book: Σ of one leg per position. */
  openNotionalUsdt: number;
  /** Funding collected across every position, open and closed. */
  accruedUsdt: number;
  /** Σ realised P&L over closed positions — accrual net of round-trip fees. */
  realizedPnlUsdt: number;
  /**
   * Mean of `realized_annual_pct − predicted_net_annual_pct` over the closed
   * positions that have both. Negative means the entry figure over-promised,
   * which is the direction `src/engine/funding.ts` predicts it will. `null`
   * when nothing has closed yet — an average of no positions is not zero.
   */
  avgPredictionErrorPct: number | null;
}

/**
 * Aggregate the position columns in two round trips (open and closed differ in
 * every aggregate they want, and a single query with `CASE` over both would be
 * harder to read than it is cheap).
 *
 * `SUM` over zero rows is `NULL`, so every total is wrapped in `COALESCE` — a
 * fresh database reports zeros, not nulls the dashboard renders as `—`. The
 * prediction-error mean is the one exception and is deliberately left `NULL`
 * when nothing has closed.
 */
export async function getCarryTotals(db: D1Database): Promise<CarryTotals> {
  const open = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(notional_usdt), 0) AS notional," +
        " COALESCE(SUM(accrued_funding_usdt), 0) AS accrued" +
        " FROM funding_positions WHERE status = ?1",
    )
    .bind(CARRY_STATUS_OPEN)
    .first<{ n: number; notional: number; accrued: number }>();

  const closed = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(accrued_funding_usdt), 0) AS accrued," +
        " COALESCE(SUM(realized_pnl_usdt), 0) AS realized," +
        " AVG(realized_annual_pct - predicted_net_annual_pct) AS err" +
        " FROM funding_positions WHERE status = ?1",
    )
    .bind(CARRY_STATUS_CLOSED)
    .first<{ n: number; accrued: number; realized: number; err: number | null }>();

  const err = closed?.err;
  return {
    openCount: open?.n ?? 0,
    closedCount: closed?.n ?? 0,
    openNotionalUsdt: round8(open?.notional ?? 0),
    accruedUsdt: round8((open?.accrued ?? 0) + (closed?.accrued ?? 0)),
    realizedPnlUsdt: round8(closed?.realized ?? 0),
    avgPredictionErrorPct:
      err === null || err === undefined || !Number.isFinite(err)
        ? null
        : round8(err),
  };
}

// ---------------------------------------------------------------------------
// Report aggregates (GET /api/report)
// ---------------------------------------------------------------------------
//
// Every query below is an **aggregate over a bounded time window**, and that is
// the whole design rule of this section. A week of funding rows is ~150k and a
// week of spread rows is ~100k; a report that pulled either into JS to reduce it
// would be the one read in this app able to exhaust a Worker's memory and its
// D1 row budget at once. So the reduction happens in SQL and what crosses the
// boundary is one row per group.
//
// The figures are deliberately *not* the stored `net_annual_pct` columns. Those
// were computed against whatever fee settings were in force at poll time, and
// rows written before Phase 13 used a materially different fee model (the spot
// taker rate on all four legs, which overstated the drag by a third). Averaging
// across that boundary would produce a number describing no fee schedule that
// ever existed. So the report reads the *gross* `annualized_pct` — which no fee
// change has ever touched — and subtracts the drag implied by today's settings,
// passed in by the caller. One fee basis across the whole window, stated in the
// response's `meta.settings`. `basis_rates` is recomputed the same way, per row
// rather than per board, because a dated contract amortises the round trip over
// its own remaining life; see {@link reportBasis}.
//
// The one column that is read as stored is `opportunities.persist_net_pct`, and
// that is the same rule rather than an exception to it: it is not a gross figure
// awaiting a drag, it is `evaluateSpread`'s output *after* the drag, so the
// honest thing to do with it is nothing. See {@link reportXchg}.
//
// A drag that cannot be priced from the stored fee rates is passed as `null`,
// never as `0`: zero is the claim that trading is free, and every count taken
// against it would be inflated by rows that only clear a bar nobody charged
// them for. The affected counts come back `null` — "not measured".

/** A helper's view of how much of a window a table actually covers. */
export interface ReportWindow {
  /** Oldest and newest row inside the window; `null` when there are none. */
  firstTs: number | null;
  lastTs: number | null;
  rows: number;
}

/**
 * How much of `[fromTs, toTs]` one table actually has rows for.
 *
 * `table` and `tsColumn` are never caller-supplied — every call site passes a
 * literal, exactly as {@link countRows} requires — because they are interpolated
 * rather than bound. SQLite will not bind an identifier, and the alternative
 * (four near-identical copies of this query) hides the one thing that differs.
 * `strategy`, which *is* data, is bound like everything else.
 */
export async function reportWindow(
  db: D1Database,
  table: string,
  tsColumn: string,
  fromTs: number,
  toTs: number,
  strategy?: Strategy,
): Promise<ReportWindow> {
  const statement = db
    .prepare(
      `SELECT COUNT(*) AS rows_in, MIN(${tsColumn}) AS first_ts, MAX(${tsColumn}) AS last_ts` +
        ` FROM ${table} WHERE ${tsColumn} >= ?1 AND ${tsColumn} <= ?2` +
        (strategy === undefined ? "" : " AND strategy = ?3"),
    );
  const row = await (strategy === undefined
    ? statement.bind(fromTs, toTs)
    : statement.bind(fromTs, toTs, strategy)
  ).first<{ rows_in: number; first_ts: number | null; last_ts: number | null }>();

  return {
    firstTs: row?.first_ts ?? null,
    lastTs: row?.last_ts ?? null,
    rows: row?.rows_in ?? 0,
  };
}

/** One venue's funding record over the window. Percentages are **gross**. */
export interface ReportFundingVenue {
  venue: string;
  /** Rows this venue wrote in the window. */
  observations: number;
  /** Distinct polls it contributed to. */
  polls: number;
  /** Mean, over polls, of this venue's best annualised rate that poll. */
  avgBestAnnualPct: number | null;
  /** The single best annualised rate this venue quoted in the window. */
  maxBestAnnualPct: number | null;
  /**
   * Polls whose best row cleared the bar *net of the current drag*.
   *
   * `null` — not `0` — when the drag itself could not be priced from the stored
   * fee settings: the comparison was never made, and a zero would read as "no
   * poll cleared" against a fee schedule of nothing.
   */
  qualifyingPolls: number | null;
}

/**
 * Per venue: how much it observed, and what its best row was worth per poll.
 *
 * "Best row per poll" rather than "average row per poll" on purpose. The board
 * is capped at each venue's best 20 and worst 5 non-majors, so its *mean* is an
 * artefact of that cap — widen the budget and the mean moves without the market
 * having done anything. The best row is the figure a reader would have acted on,
 * and it is invariant to how much of the tail was kept.
 *
 * `dragAnnualPct` is the current fee drag over `funding_hold_days`, subtracted
 * only in the `qualifyingPolls` comparison; the returned percentages stay gross
 * so the caller can show both, and so the one place the fee basis is applied is
 * visible. See the section header for why the stored net column is not used.
 *
 * Pass `null` for a drag that cannot be priced from the stored fee rates, and
 * the comparison is skipped: `qualifyingPolls` comes back `null` rather than
 * counting rows against a drag of zero, which would inflate the count with polls
 * that only clear the bar because their fees went unpaid. Same discipline as
 * {@link reportXchg}'s unpriceable bar, and the same reason.
 */
export async function reportFundingByVenue(
  db: D1Database,
  fromTs: number,
  toTs: number,
  dragAnnualPct: number | null,
  minAnnualPct: number,
): Promise<ReportFundingVenue[]> {
  const { results } = await db
    .prepare(
      "SELECT venue, SUM(n) AS observations, COUNT(*) AS polls," +
        " AVG(best) AS avg_best, MAX(best) AS max_best," +
        // `?3` is NULL for an unpriceable drag, and `best - NULL` is NULL, which
        // is never `>=` anything — so the CASE falls to its ELSE and the count
        // comes back 0 for every venue. That 0 is discarded below in favour of
        // `null`; the branch is here so one query serves both cases.
        " SUM(CASE WHEN best - ?3 >= ?4 THEN 1 ELSE 0 END) AS qualifying_polls" +
        " FROM (SELECT venue, ts, COUNT(*) AS n, MAX(annualized_pct) AS best" +
        "       FROM funding_rates WHERE ts >= ?1 AND ts <= ?2 GROUP BY venue, ts)" +
        " GROUP BY venue ORDER BY venue ASC",
    )
    .bind(fromTs, toTs, dragAnnualPct, minAnnualPct)
    .all<{
      venue: string;
      observations: number;
      polls: number;
      avg_best: number | null;
      max_best: number | null;
      qualifying_polls: number;
    }>();

  return (results ?? []).map((r) => ({
    venue: r.venue,
    observations: r.observations ?? 0,
    polls: r.polls ?? 0,
    avgBestAnnualPct: finiteOrNull(r.avg_best),
    maxBestAnnualPct: finiteOrNull(r.max_best),
    qualifyingPolls: dragAnnualPct === null ? null : (r.qualifying_polls ?? 0),
  }));
}

/** `AVG`/`MAX` over zero rows is SQL NULL; so is a column that was all NULL. */
function finiteOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? round8(value) : null;
}

/**
 * One `close_reason`'s share of the window's closes.
 *
 * The grouping exists because the reasons are **not** an interchangeable
 * population. Inside a report window shorter than `funding_hold_days`,
 * `max_hold` cannot fire at all, so every close is either `rate_below_exit`
 * (the carry collapsed), `stale_data` (the board stopped quoting it) or
 * `manual` — the three adverse endings. A mean taken across them and reported
 * as "the" prediction error is a mean over the losers only. See
 * {@link reportCarry}.
 */
export interface ReportCarryCloseReason {
  /** `max_hold` | `rate_below_exit` | `stale_data` | `manual`. */
  reason: string;
  count: number;
  /** Mean `realized − predicted` for this reason alone. */
  avgErrorPct: number | null;
  /** Mean `accrual_count`: settlements actually booked, not merely elapsed. */
  avgAccrualCount: number | null;
  /**
   * Mean number of settlement periods the hold *spanned*, from
   * `(close_ts − entry_ts) / interval`. The upper bound on what could have been
   * accrued (±1 for where the venue's grid falls relative to entry), so
   * `avgAccrualCount / avgSpannedSettlements` is the accrual coverage: a
   * position that booked 2 of 9 settlements did not earn a low return, it was
   * measured through a hole. Skipped settlements are not stored per position —
   * `ScanResult.skippedSettlements` counts them per *pass* — so this is the
   * cheapest honest proxy rather than an exact count.
   */
  avgSpannedSettlements: number | null;
}

/**
 * One open position, marked to date.
 *
 * **This is not a realised figure and must never be compared to one.**
 * {@link accruedAnnualPct} charges **no fees at all**: the round trip is paid
 * on the way out and this position has not been out. Amortising the exit fee
 * over a hold that is still running would invent a cost that has not been
 * incurred, over a denominator that is still moving, and would read as a loss
 * on every position in its first days. So the fair comparison is
 * gross-accrual-so-far against the *gross* expectation, and the field is
 * labelled rather than silently folded into a net.
 */
export interface ReportCarryOpenMark {
  id: number;
  venue: string;
  symbol: string;
  notionalUsdt: number;
  entryTs: number;
  /** How long it has been running, at the report's clock. */
  holdDays: number;
  accruedFundingUsdt: number;
  accrualCount: number;
  /**
   * `accrued / notional`, annualised over the hold so far, **fees excluded**.
   * `null` for a position younger than a moment or with no usable notional.
   */
  accruedAnnualPct: number | null;
  /** What the entry row promised, net of the drag amortised over the plan. */
  predictedNetAnnualPct: number;
  /** {@link accruedAnnualPct} − {@link predictedNetAnnualPct}; `null` if the first is. */
  accruedVsPredictedPct: number | null;
}

/** The paper carry book's record over the window. */
export interface ReportCarry {
  /** Positions open **now** — a position is not "in" a window, it is running. */
  openCount: number;
  openNotionalUsdt: number;
  openAccruedUsdt: number;
  /**
   * Mean {@link ReportCarryOpenMark.accruedVsPredictedPct} over the **whole**
   * open book (not just the marks listed below), or `null` when no open
   * position can be marked yet. Fee-free by construction — see
   * {@link ReportCarryOpenMark}.
   */
  openAvgAccruedVsPredictedPct: number | null;
  /**
   * Per-position marks, newest entry last, capped at
   * {@link REPORT_OPEN_MARKS_LIMIT}. The average above is over every open
   * position regardless of this cap.
   */
  openMarks: ReportCarryOpenMark[];
  /** Positions whose `close_ts` fell inside the window. */
  closedCount: number;
  realizedPnlUsdt: number;
  /** Mean realised annual %, over the closed positions that have one. */
  avgRealizedAnnualPct: number | null;
  /**
   * Mean of `realized − predicted` over the window's closes; negative means
   * entry over-promised. **Read it beside {@link closeReasons}**: over a window
   * shorter than the planned hold this population is adverse-selected.
   */
  avgPredictionErrorPct: number | null;
  /** The window's closes grouped by why they closed, commonest first. */
  closeReasons: ReportCarryCloseReason[];
  best: FundingPosition | null;
  worst: FundingPosition | null;
}

/**
 * Most open positions {@link reportCarry} marks individually: 50.
 *
 * The open book is bounded by `funding_max_positions` and is in practice a
 * handful, so this is a guard rather than a page size — it stops a book left
 * over from a much larger setting from turning one report field into an
 * unbounded array. The aggregate beside it is computed in SQL over every open
 * position, so the cap can never move the reported average.
 */
export const REPORT_OPEN_MARKS_LIMIT = 50;

/** Days in the year every annualisation in this app shares (`src/engine`). */
const REPORT_DAYS_PER_YEAR = 365;

/** Milliseconds in a day. */
const REPORT_MS_PER_DAY = 86_400_000;

/**
 * Carry aggregates for the window.
 *
 * **Open positions are not windowed, and closed ones are.** A closed position
 * has an event in time (`close_ts`) that either falls inside the window or does
 * not; an open one has no such event — it is simply running, and reporting "the
 * positions that were open during this window" would mean reconstructing a book
 * from an entry timestamp and a close that has not happened. So the open half is
 * the book as it stands, and the response labels it that way.
 *
 * ## Why the open book is marked at all, and why the mark is fee-free
 *
 * The closed half alone is a **biased** estimator of "did entry over-promise",
 * and biased in a knowable direction. `funding_hold_days` defaults to 30 while
 * this report's window can be at most 7, so `max_hold` — the *planned* ending,
 * the one a position that worked reaches — cannot fire inside any window this
 * endpoint serves. Everything that closes inside 7 days closed because
 * something went wrong: the rate fell through `funding_exit_annual_pct`, or the
 * board stopped quoting it. The healthy positions are all still open and
 * contribute nothing. Averaging only the closes therefore prints a confidently
 * negative prediction error *by construction*, and would do so even if every
 * position on the book were paying exactly what it promised.
 *
 * So the open book is marked to date beside it: accrued-so-far, annualised over
 * the hold so far, **with no fees charged**, because the round trip is paid on
 * exit and these have not exited (see {@link ReportCarryOpenMark}). The two
 * populations are reported separately and labelled — never blended into one
 * scalar, which is the thing that hid the bias in the first place.
 *
 * `nowTs` defaults to `toTs`, which is the report's own clock: the open marks
 * are "as of the end of the window", the same instant everything else is
 * measured at.
 */
export async function reportCarry(
  db: D1Database,
  fromTs: number,
  toTs: number,
  nowTs: number = toTs,
): Promise<ReportCarry> {
  // The mark, in SQL, once — reused by the aggregate and by the per-position
  // list so the two can never disagree about what "accrued annual %" means.
  // Guarded on both denominators: a zero notional or a position entered at (or
  // after) `nowTs` yields NULL, which AVG then skips rather than poisoning.
  const accruedAnnualSql =
    "CASE WHEN notional_usdt > 0 AND ?2 > entry_ts" +
    `  THEN (accrued_funding_usdt / notional_usdt) * (${REPORT_DAYS_PER_YEAR}.0 /` +
    `       ((?2 - entry_ts) / ${REPORT_MS_PER_DAY}.0)) * 100.0` +
    "  ELSE NULL END";

  const open = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(notional_usdt), 0) AS notional," +
        " COALESCE(SUM(accrued_funding_usdt), 0) AS accrued," +
        ` AVG(${accruedAnnualSql} - predicted_net_annual_pct) AS avg_mark_err` +
        " FROM funding_positions WHERE status = ?1",
    )
    .bind(CARRY_STATUS_OPEN, nowTs)
    .first<{ n: number; notional: number; accrued: number; avg_mark_err: number | null }>();

  const { results: openRows } = await db
    .prepare(
      "SELECT id, venue, symbol, notional_usdt, entry_ts, accrued_funding_usdt," +
        " accrual_count, predicted_net_annual_pct," +
        ` ${accruedAnnualSql} AS accrued_annual_pct` +
        " FROM funding_positions WHERE status = ?1" +
        " ORDER BY entry_ts ASC, id ASC LIMIT ?3",
    )
    .bind(CARRY_STATUS_OPEN, nowTs, REPORT_OPEN_MARKS_LIMIT)
    .all<{
      id: number;
      venue: string;
      symbol: string;
      notional_usdt: number;
      entry_ts: number;
      accrued_funding_usdt: number;
      accrual_count: number;
      predicted_net_annual_pct: number;
      accrued_annual_pct: number | null;
    }>();

  const openMarks: ReportCarryOpenMark[] = (openRows ?? []).map((r) => {
    const accruedAnnualPct = finiteOrNull(r.accrued_annual_pct);
    return {
      id: r.id,
      venue: r.venue,
      symbol: r.symbol,
      notionalUsdt: r.notional_usdt,
      entryTs: r.entry_ts,
      holdDays: round8((nowTs - r.entry_ts) / REPORT_MS_PER_DAY),
      accruedFundingUsdt: round8(r.accrued_funding_usdt ?? 0),
      accrualCount: r.accrual_count ?? 0,
      accruedAnnualPct,
      predictedNetAnnualPct: r.predicted_net_annual_pct,
      accruedVsPredictedPct:
        accruedAnnualPct === null
          ? null
          : round8(accruedAnnualPct - r.predicted_net_annual_pct),
    };
  });

  const closed = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_usdt), 0) AS realized," +
        " AVG(realized_annual_pct) AS avg_realized," +
        " AVG(realized_annual_pct - predicted_net_annual_pct) AS avg_err" +
        " FROM funding_positions WHERE status = ?1 AND close_ts >= ?2 AND close_ts <= ?3",
    )
    .bind(CARRY_STATUS_CLOSED, fromTs, toTs)
    .first<{ n: number; realized: number; avg_realized: number | null; avg_err: number | null }>();

  // Grouped in SQL and bounded by the number of close reasons that exist (4),
  // so this is a fixed-size result however large the book gets.
  const { results: reasonRows } = await db
    .prepare(
      "SELECT COALESCE(close_reason, 'unknown') AS reason, COUNT(*) AS n," +
        " AVG(realized_annual_pct - predicted_net_annual_pct) AS avg_err," +
        " AVG(accrual_count) AS avg_accruals," +
        " AVG(CASE WHEN interval_minutes > 0" +
        "     THEN CAST((close_ts - entry_ts) / (interval_minutes * 60000.0) AS INTEGER)" +
        "     ELSE NULL END) AS avg_spanned" +
        " FROM funding_positions WHERE status = ?1 AND close_ts >= ?2 AND close_ts <= ?3" +
        " GROUP BY reason ORDER BY n DESC, reason ASC",
    )
    .bind(CARRY_STATUS_CLOSED, fromTs, toTs)
    .all<{
      reason: string;
      n: number;
      avg_err: number | null;
      avg_accruals: number | null;
      avg_spanned: number | null;
    }>();

  const extreme = async (direction: "DESC" | "ASC") => {
    const row = await db
      .prepare(
        "SELECT * FROM funding_positions WHERE status = ?1 AND close_ts >= ?2" +
          " AND close_ts <= ?3 AND realized_annual_pct IS NOT NULL" +
          ` ORDER BY realized_annual_pct ${direction}, id ASC LIMIT 1`,
      )
      .bind(CARRY_STATUS_CLOSED, fromTs, toTs)
      .first<FundingPositionRow>();
    return row ? toFundingPosition(row) : null;
  };

  return {
    openCount: open?.n ?? 0,
    openNotionalUsdt: round8(open?.notional ?? 0),
    openAccruedUsdt: round8(open?.accrued ?? 0),
    openAvgAccruedVsPredictedPct: finiteOrNull(open?.avg_mark_err),
    openMarks,
    closedCount: closed?.n ?? 0,
    realizedPnlUsdt: round8(closed?.realized ?? 0),
    avgRealizedAnnualPct: finiteOrNull(closed?.avg_realized),
    avgPredictionErrorPct: finiteOrNull(closed?.avg_err),
    closeReasons: (reasonRows ?? []).map((r) => ({
      reason: r.reason,
      count: r.n ?? 0,
      avgErrorPct: finiteOrNull(r.avg_err),
      avgAccrualCount: finiteOrNull(r.avg_accruals),
      avgSpannedSettlements: finiteOrNull(r.avg_spanned),
    })),
    best: await extreme("DESC"),
    worst: await extreme("ASC"),
  };
}

/** The cross-exchange survival record over the window. */
export interface ReportXchg {
  /** Spread rows written in the window, measured or not. */
  rows: number;
  /** Rows re-priced against a later snapshot and given a figure. */
  measured: number;
  /** Rows stamped as checked but with no figure — expired before re-pricing. */
  expiredUnmeasured: number;
  /**
   * Measured rows whose re-priced net was above zero.
   *
   * **This is the break-even count**, not a softer version of one.
   * `persist_net_pct` is what `evaluateSpread` returned for the same trade on a
   * later book, and that figure is already net of both legs' taker fees — so
   * zero is the point at which the round trip paid for itself, and comparing it
   * against the *gross* two-leg bar would charge the same fees twice.
   */
  survived: number;
  /**
   * Measured rows whose re-priced net cleared `xchg_min_profit_pct`.
   *
   * A display preference rather than an economic one: it is the same threshold
   * the dashboard's `qualifies` badge uses, so the report and the board agree
   * about which rows are worth looking at.
   *
   * A *higher* bar than {@link survived} only while `xchg_min_profit_pct` is
   * positive. The setting may legitimately be zero or negative (`src/routes.ts`
   * documents why a negative bar is meaningful here), and at or below zero this
   * is the **wider** count of the two: `survived` is a strict `> 0` where this
   * one is `>= minProfitPct`.
   */
  qualifying: number;
  avgPersistNetPct: number | null;
  maxPersistNetPct: number | null;
  avgSkewMs: number | null;
  maxSkewMs: number | null;
}

/**
 * Cross-exchange aggregates in one pass over `idx_opportunities_strategy_ts`.
 *
 * **Both counts are taken against `persist_net_pct`, which is already net of
 * both legs' fees.** This section is the one that does *not* recompute anything
 * against current settings, and it is not an oversight: `persist_net_pct` is not
 * a gross edge waiting to have a drag subtracted from it, it is what
 * `evaluateSpread` returned after charging the round trip. Subtracting a fee bar
 * from it — or comparing it against the gross `(1/(1−fee)² − 1) × 100` figure —
 * charges the same two legs a second time, and would understate survival by
 * roughly a whole break-even.
 *
 * So the two bars are:
 *
 * - **zero** ({@link ReportXchg.survived}) — the trade paid for itself. The
 *   economic question, and the one `answers.anyStrategyClearedBreakEven.xchg`
 *   is derived from.
 * - **`minProfitPct`** ({@link ReportXchg.qualifying}) — the same
 *   `xchg_min_profit_pct` the dashboard flags rows against. A display
 *   preference, reported beside the first so the two are never confused.
 */
export async function reportXchg(
  db: D1Database,
  strategy: Strategy,
  fromTs: number,
  toTs: number,
  minProfitPct: number,
): Promise<ReportXchg> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS rows_in," +
        " SUM(CASE WHEN persist_net_pct IS NOT NULL THEN 1 ELSE 0 END) AS measured," +
        " SUM(CASE WHEN persist_checked_ts IS NOT NULL AND persist_net_pct IS NULL" +
        "          THEN 1 ELSE 0 END) AS expired," +
        " SUM(CASE WHEN persist_net_pct > 0 THEN 1 ELSE 0 END) AS survived," +
        " SUM(CASE WHEN persist_net_pct >= ?4 THEN 1 ELSE 0 END) AS qualifying," +
        " AVG(persist_net_pct) AS avg_persist, MAX(persist_net_pct) AS max_persist," +
        " AVG(skew_ms) AS avg_skew, MAX(skew_ms) AS max_skew" +
        " FROM opportunities WHERE strategy = ?1 AND ts >= ?2 AND ts <= ?3",
    )
    .bind(strategy, fromTs, toTs, minProfitPct)
    .first<{
      rows_in: number;
      measured: number | null;
      expired: number | null;
      survived: number | null;
      qualifying: number | null;
      avg_persist: number | null;
      max_persist: number | null;
      avg_skew: number | null;
      max_skew: number | null;
    }>();

  return {
    rows: row?.rows_in ?? 0,
    measured: row?.measured ?? 0,
    expiredUnmeasured: row?.expired ?? 0,
    survived: row?.survived ?? 0,
    qualifying: row?.qualifying ?? 0,
    avgPersistNetPct: finiteOrNull(row?.avg_persist),
    maxPersistNetPct: finiteOrNull(row?.max_persist),
    avgSkewMs: finiteOrNull(row?.avg_skew),
    maxSkewMs: finiteOrNull(row?.max_skew),
  };
}

/**
 * The median measured `persist_net_pct` over the window.
 *
 * Computed with an `OFFSET`, not by fetching the distribution: at ~10 measured
 * rows a scan a week is ~100k values, and the median is the one order statistic
 * that says more about a skewed distribution than its mean — so it is worth a
 * query rather than worth skipping. One row comes back for an odd `count`, two
 * for an even one, and the even case is averaged, which is the textbook
 * definition rather than a convenient approximation.
 *
 * `count` is the measured-row count the caller already has from
 * {@link reportXchg}; passing it avoids a second `COUNT(*)` over the same
 * window. It does **not** guarantee the two queries see the same rows: they are
 * two statements, and a scan committing a measurement between them changes the
 * set under this one. The consequence is bounded and benign — the offset is off
 * by one against a set that grew by one, so the "median" is the value beside the
 * true one — and the alternative (a transaction, or the distribution in JS) buys
 * a precision this figure does not have. `null` for an empty set: the median of
 * nothing is not zero.
 */
export async function reportXchgMedianPersist(
  db: D1Database,
  strategy: Strategy,
  fromTs: number,
  toTs: number,
  count: number,
): Promise<number | null> {
  if (!Number.isInteger(count) || count <= 0) return null;

  const offset = Math.floor((count - 1) / 2);
  const limit = count % 2 === 1 ? 1 : 2;
  const { results } = await db
    .prepare(
      "SELECT persist_net_pct AS v FROM opportunities" +
        " WHERE strategy = ?1 AND ts >= ?2 AND ts <= ?3 AND persist_net_pct IS NOT NULL" +
        " ORDER BY persist_net_pct ASC LIMIT ?4 OFFSET ?5",
    )
    .bind(strategy, fromTs, toTs, limit, offset)
    .all<{ v: number }>();

  const values = (results ?? []).map((r) => r.v).filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;
  return round8(values.reduce((a, b) => a + b, 0) / values.length);
}

/** The cross-venue funding differential's record over the window. */
export interface ReportVenueSpreads {
  /** Polls that had at least one symbol quoted by two or more venues. */
  polls: number;
  /** Mean, over those polls, of the widest differential available that poll. */
  avgGrossAnnualPct: number | null;
  maxGrossAnnualPct: number | null;
  /**
   * Polls whose widest differential cleared the bar net of the current drag.
   * `null` when the drag could not be priced — see
   * {@link ReportFundingVenue.qualifyingPolls}.
   */
  qualifyingPolls: number | null;
}

/**
 * Recompute the best cross-venue funding differential per poll, in SQL.
 *
 * This is `rankVenueSpreads` (`src/engine/funding.ts`) evaluated over a week of
 * boards, and it produces the same gross figure by the same rule: **annualise
 * first, then difference**. That equivalence is what makes the SQL legitimate —
 * `funding_rates.annualized_pct` is each venue's rate already annualised on
 * *its own* settlement cadence, so `MAX(annualized_pct) − MIN(annualized_pct)`
 * within one `(ts, symbol)` group is exactly the widest pair that function
 * picks. `test/report.test.ts` pins the two against each other on a seeded
 * board rather than leaving the claim to this comment.
 *
 * It is done in SQL and not by calling the function because a week of boards is
 * ~150k rows: the pure engine is the right shape for one board and the wrong
 * shape for two thousand of them.
 *
 * **Bounded to `symbols`**, which the caller passes as the verified major set.
 * The full board's tail is ~1500 rows a poll and, worse, a shared ticker outside
 * the majors is not a shared asset — `rankVenueSpreads` reports those rows and
 * marks them `verifiedPair: false`, which a single aggregate number has no way
 * to do. So the report answers the question it can answer honestly.
 *
 * One assumption, shared with the carry pass and held by the poll rather than by
 * the schema: a board carries **at most one row per `(venue, symbol)`**. Where
 * that held, `COUNT(DISTINCT venue) >= 2` means the max and the min are two
 * different venues.
 */
export async function reportVenueSpreads(
  db: D1Database,
  fromTs: number,
  toTs: number,
  symbols: readonly string[],
  dragAnnualPct: number | null,
  minAnnualPct: number,
): Promise<ReportVenueSpreads> {
  if (symbols.length === 0) {
    return {
      polls: 0,
      avgGrossAnnualPct: null,
      maxGrossAnnualPct: null,
      qualifyingPolls: dragAnnualPct === null ? null : 0,
    };
  }

  // Bound parameters, never interpolation: the symbol list is app-owned today
  // and a placeholder list keeps it safe the day it is not.
  const placeholders = symbols.map((_, i) => `?${i + 5}`).join(", ");
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS polls, AVG(gross) AS avg_gross, MAX(gross) AS max_gross," +
        // NULL drag -> NULL comparison -> ELSE -> 0, discarded below for `null`.
        " SUM(CASE WHEN gross - ?3 >= ?4 THEN 1 ELSE 0 END) AS qualifying_polls" +
        " FROM (SELECT ts, MAX(spread) AS gross FROM (" +
        "   SELECT ts, symbol, MAX(annualized_pct) - MIN(annualized_pct) AS spread" +
        "   FROM funding_rates" +
        `   WHERE ts >= ?1 AND ts <= ?2 AND symbol IN (${placeholders})` +
        "   GROUP BY ts, symbol HAVING COUNT(DISTINCT venue) >= 2" +
        " ) GROUP BY ts)",
    )
    .bind(fromTs, toTs, dragAnnualPct, minAnnualPct, ...symbols)
    .first<{
      polls: number;
      avg_gross: number | null;
      max_gross: number | null;
      qualifying_polls: number;
    }>();

  return {
    polls: row?.polls ?? 0,
    avgGrossAnnualPct: finiteOrNull(row?.avg_gross),
    maxGrossAnnualPct: finiteOrNull(row?.max_gross),
    qualifyingPolls: dragAnnualPct === null ? null : (row?.qualifying_polls ?? 0),
  };
}

/** The dated-futures basis board's record over the window. */
export interface ReportBasis {
  observations: number;
  polls: number;
  /**
   * Mean, over polls, of the best net annual basis available that poll,
   * recomputed at the current fee rates. `null` when those rates are unusable.
   */
  avgBestNetAnnualPct: number | null;
  maxBestNetAnnualPct: number | null;
  /** Polls whose best net cleared the bar. `null` when the fees are unusable. */
  qualifyingPolls: number | null;
}

/**
 * Basis aggregates for the window, on **one fee basis** like every other
 * section: the stored `net_annual_pct` column is not read.
 *
 * A basis row's drag is not the funding board's single scalar — it is amortised
 * over each contract's own remaining life — but that does not make it
 * unrecomputable, only per row. `days_to_expiry` is stored on the row beside the
 * gross `annualized_pct`, so the whole drag is
 *
 * ```
 * roundTripFeeFraction x (365 / days_to_expiry) x 100
 * ```
 *
 * which is exactly `feeDragAnnualPct` (`src/engine/funding.ts`) written in SQL,
 * evaluated inside the existing `GROUP BY` rather than by pulling rows into JS.
 * The cost is an expression per row in a query that was already visiting every
 * one of them; there is no extra scan.
 *
 * The rationale is the funding section's, unchanged: a stored net was priced at
 * whatever `fee_rate` and `perp_fee_rate` were in force at poll time, and
 * averaging across a retune describes a fee schedule that never existed. It has
 * not happened to `basis_rates` yet — the table is one phase old — but a report
 * whose correctness depends on nobody having touched the settings is one edit
 * away from being wrong, and silently.
 *
 * `feeFraction` is `roundTripFeeFraction(fee_rate, perp_fee_rate)`, or `null`
 * when those rates cannot price a round trip at all; `null` propagates to every
 * net figure rather than pricing the legs at zero.
 */
export async function reportBasis(
  db: D1Database,
  fromTs: number,
  toTs: number,
  feeFraction: number | null,
  minAnnualPct: number,
): Promise<ReportBasis> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(n), 0) AS observations, COUNT(*) AS polls," +
        " AVG(best) AS avg_best, MAX(best) AS max_best," +
        " SUM(CASE WHEN best >= ?4 THEN 1 ELSE 0 END) AS qualifying_polls" +
        " FROM (SELECT ts, COUNT(*) AS n," +
        // The CASE guards the divisor: a row with a non-positive
        // `days_to_expiry` cannot be annualised, so its net is NULL and the
        // aggregate MAX steps over it rather than the whole poll becoming
        // unpriceable. `?3` is NULL for an unusable fee schedule, which makes
        // every net NULL — the section then reports "not measured", the truth.
        "        MAX(CASE WHEN days_to_expiry > 0 THEN" +
        "              annualized_pct - ?3 * (365.0 / days_to_expiry) * 100" +
        "            END) AS best" +
        "       FROM basis_rates WHERE ts >= ?1 AND ts <= ?2 GROUP BY ts)",
    )
    .bind(fromTs, toTs, feeFraction, minAnnualPct)
    .first<{
      observations: number;
      polls: number;
      avg_best: number | null;
      max_best: number | null;
      qualifying_polls: number;
    }>();

  return {
    observations: row?.observations ?? 0,
    polls: row?.polls ?? 0,
    avgBestNetAnnualPct: finiteOrNull(row?.avg_best),
    maxBestNetAnnualPct: finiteOrNull(row?.max_best),
    qualifyingPolls: feeFraction === null ? null : (row?.qualifying_polls ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetOptions {
  /**
   * Also drop trades, opportunities, scans, funding rows and carry positions.
   * **Opt-in at the API** (`{"wipeHistory": true}`): the recorded series is the
   * product, and a bodyless `POST /api/reset` must not be able to destroy a
   * week of soak data that the acceptance report is the only consumer of.
   */
  wipeHistory: boolean;
}

/**
 * Restore the paper portfolio to a single `initial_usdt` USDT balance.
 *
 * Settings survive a reset — an operator who tuned a threshold does not want
 * that undone by "start over". The scan lock is dropped, because a reset is
 * also the escape hatch for a lock left behind by a Worker that was evicted
 * mid-scan.
 */
export async function resetAll(
  db: D1Database,
  options: ResetOptions,
): Promise<void> {
  const { initial_usdt } = await getSettings(db);

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM balances"),
    db.prepare("INSERT INTO balances (asset, amount) VALUES (?1, ?2)").bind(
      BASE_ASSET,
      initial_usdt,
    ),
    db.prepare("DELETE FROM settings WHERE key = ?1").bind(SCAN_LOCK_KEY),
  ];

  if (options.wipeHistory) {
    statements.push(
      db.prepare("DELETE FROM trades"),
      db.prepare("DELETE FROM opportunities"),
      db.prepare("DELETE FROM scans"),
      // Funding rows reference `scan_id`, so leaving them behind would strand
      // them against scans that no longer exist. The interval cache is *not*
      // dropped: it is a property of the exchanges, not of this portfolio.
      db.prepare("DELETE FROM funding_rates"),
      // …and so does the scan's poll marker: with the board gone, the next
      // scan must refill it immediately rather than sit out the rest of an
      // interval measured against rows that no longer exist.
      db.prepare("DELETE FROM settings WHERE key = ?1").bind(FUNDING_POLL_TS_KEY),
      // Carry positions go with the rates they were opened on and accrued
      // from: keeping a position whose whole rate history has just been
      // deleted would leave it unable to accrue, unable to price a close, and
      // 24 hours from being closed as stale.
      db.prepare("DELETE FROM funding_positions"),
      // The basis board and its own poll marker. The rows go for the same
      // reason the funding ones do — they reference `scan_id`, and a marker
      // left behind would make the next scan sit out an interval measured
      // against rows that no longer exist. **What a missing marker then means
      // is not the same on the two boards**, and the difference is deliberate:
      // an absent `funding_last_poll_ts` forces a poll on the next scan, while
      // an absent basis marker is *seeded* to `startedAt − interval + stagger`
      // and the first basis poll is skipped, landing ~150s later so the two
      // boards alternate instead of polling in the same invocation. So a reset
      // costs the funding board nothing and the basis board one skipped poll —
      // see the cold-start note in `src/scan.ts`.
      db.prepare("DELETE FROM basis_rates"),
      db.prepare("DELETE FROM settings WHERE key = ?1").bind(BASIS_POLL_TS_KEY),
    );
  }

  await db.batch(statements);
}
