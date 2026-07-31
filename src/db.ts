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
 * ## `trades` and `balances` are read-only now
 *
 * Phase 12 deleted every paper-fill path, so nothing in this module writes a
 * trade or moves a balance any more; `ensureSeeded` materialises the one
 * starting balance and that is the last word on it. The tables, their columns
 * and their readers all stay: the rows already on disk are the record of what
 * the fill-era scanner did, and `GET /api/trades` and `GET /api/portfolio`
 * still serve them. There is no destructive migration.
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
 * empty — a deliberately zeroed balance is real state, not an absence — and
 * this is now the only write the app ever makes to that table.
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
            " legs_json, india_net_pct, tds_pct, strategy)" +
            " VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9) RETURNING id",
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
 * board is the first thing here that can plausibly approach it: four venues x
 * (11 majors + 25 tail) is ~144 inserts where the single-venue board was 11. 50
 * is a defensive fraction of the documented limit, chosen so the chunking is
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
 * transaction. So a reader polling mid-write can now observe a *partial* board
 * — fewer rows at the newest `ts`, never a mixture of two polls, since every
 * row of a poll shares one timestamp. That is a two-second cosmetic
 * undercount on a table read every five seconds, against the alternative of
 * exceeding D1's statement limit and writing no board at all.
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

/** Timestamp of the newest funding row; `null` when the table is empty. */
export async function getLatestFundingTs(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(ts) AS ts FROM funding_rates")
    .first<{ ts: number | null }>();
  return row?.ts ?? null;
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

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetOptions {
  /** Also drop trades, opportunities, scans and funding rows. Defaults to
   *  `true` at the API. */
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
    );
  }

  await db.batch(statements);
}
