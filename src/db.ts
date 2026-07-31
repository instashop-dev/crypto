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
 *   as one implicit transaction. That is why {@link commitTrade} exists as a
 *   single call rather than four helpers the caller sequences itself: a paper
 *   balance credited without its trade row (or vice versa) would corrupt P&L
 *   with no way to reconstruct the truth.
 */
import { BASE_ASSET, DEFAULTS, STRATEGY_TRIANGULAR, type Strategy } from "./config";
import {
  round8,
  type ExecutedLeg,
  type ExecutedTrade,
  type TaxBreakdown,
  type TaxPolicy,
} from "./engine";
import type { PairInfo, SnapshotSource } from "./types";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The strategy tunables, always fully populated (DEFAULTS fill any gap). */
export interface Settings {
  fee_rate: number;
  min_profit_pct: number;
  trade_size_usdt: number;
  initial_usdt: number;
  india_mode: number;
  tds_rate: number;
  tax_rate: number;
  xchg_min_profit_pct: number;
  xchg_enabled: number;
}

export type SettingKey = keyof Settings;

/**
 * Numeric setting keys, in a stable order. New keys are **appended**: the order
 * is what `ensureSeeded` batches in, and keeping it append-only means a
 * back-fill of a new tunable can never reorder the writes of the old ones.
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  "fee_rate",
  "min_profit_pct",
  "trade_size_usdt",
  "initial_usdt",
  "india_mode",
  "tds_rate",
  "tax_rate",
  "xchg_min_profit_pct",
  "xchg_enabled",
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
 * tunable in a later release back-fills it without clobbering the three the
 * operator already tuned. Balances are seeded only when the table is entirely
 * empty — a deliberately zeroed balance is real state, not an absence.
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
// Balances
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

/** Balance of one asset; `0` when the asset has never been held. */
export async function getBalance(db: D1Database, asset: string): Promise<number> {
  const row = await db
    .prepare("SELECT amount FROM balances WHERE asset = ?1")
    .bind(asset)
    .first<{ amount: number }>();
  return row?.amount ?? 0;
}

function balanceDeltaStmt(
  db: D1Database,
  asset: string,
  delta: number,
): D1PreparedStatement {
  // Upsert rather than UPDATE: the first credit of a non-base asset would
  // otherwise silently affect zero rows.
  return db
    .prepare(
      "INSERT INTO balances (asset, amount) VALUES (?1, ?2)" +
        " ON CONFLICT(asset) DO UPDATE SET amount = amount + ?2",
    )
    .bind(asset, delta);
}

/** Apply a signed delta to one asset's balance. */
export async function applyBalanceDelta(
  db: D1Database,
  asset: string,
  delta: number,
): Promise<void> {
  await balanceDeltaStmt(db, asset, delta).run();
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
  trianglesCount: number;
  bestNetPct: number | null;
  durationMs: number;
  error: string | null;
  /**
   * Cross-exchange figures. Optional so that a caller which knows nothing about
   * the strategy writes the same row it always did (0 / NULL / NULL) rather
   * than having to name fields it does not own.
   */
  spreadsCount?: number;
  bestSpreadNetPct?: number | null;
  /**
   * A cross-exchange failure. Kept out of {@link error} on purpose: `error`
   * means "this scan failed", and a scan whose triangular half ranked and
   * filled normally did not fail because one of two venues was unreachable.
   */
  xchgError?: string | null;
}

/**
 * Record a scan's outcome. Deliberately does **not** touch `executed_count`:
 * that column is owned by {@link commitTrade}'s batch, so the trade and its
 * count can never disagree.
 */
export async function finalizeScan(
  db: D1Database,
  scanId: number,
  outcome: ScanOutcome,
): Promise<void> {
  await db
    .prepare(
      "UPDATE scans SET source = ?2, pairs_count = ?3, triangles_count = ?4," +
        " best_net_pct = ?5, duration_ms = ?6, error = ?7, spreads_count = ?8," +
        " best_spread_net_pct = ?9, xchg_error = ?10 WHERE id = ?1",
    )
    .bind(
      scanId,
      outcome.source,
      outcome.pairsCount,
      outcome.trianglesCount,
      outcome.bestNetPct,
      outcome.durationMs,
      outcome.error,
      outcome.spreadsCount ?? 0,
      outcome.bestSpreadNetPct ?? null,
      outcome.xchgError ?? null,
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
 * Persist a scan's ranked cycles and return their ids **in the same order**,
 * so the caller can mark the executed one without a second query.
 *
 * `strategy` is a trailing parameter with the pre-Phase-9 value as its default:
 * every existing call site keeps writing triangles without being edited, and a
 * new one has to name the strategy deliberately.
 */
export async function insertOpportunities(
  db: D1Database,
  scanId: number,
  quotes: OpportunityInput[],
  ts: number = Date.now(),
  strategy: Strategy = STRATEGY_TRIANGULAR,
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

export async function markOpportunityExecuted(
  db: D1Database,
  opportunityId: number,
): Promise<void> {
  await db
    .prepare("UPDATE opportunities SET executed = 1 WHERE id = ?1")
    .bind(opportunityId)
    .run();
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
// Trades
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

/** Lifetime tax aggregates over every booked trade. */
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

export interface CommitTradeInput {
  scanId: number;
  opportunityId: number | null;
  trade: ExecutedTrade;
  /**
   * Which upstream priced the fill. Widened from `SnapshotSource` to a plain
   * string in Phase 9: a cross-exchange fill is priced by *two* venues at once
   * and records `"binance-ws+mexc-rest"`, which is not one of the two enum
   * members and should not be forced to pick one of them.
   */
  source: SnapshotSource | string | null;
  ts?: number;
  /** India-mode figures. Absent means "no tax regime applied to this fill". */
  tax?: TaxBreakdown;
  /** Defaults to `triangular`, so pre-Phase-9 call sites are unchanged. */
  strategy?: Strategy;
}

/**
 * Book a simulated fill: balance, trade row, opportunity flag and the scan's
 * `executed_count`, all in one `batch()` so they land together or not at all.
 *
 * Called **at most once per strategy per scan**, so `executed_count` is 0, 1 or
 * 2 — one triangular fill and one cross-exchange fill. The two are deliberately
 * independent: they are different books, different notionals of the same
 * balance, and one being unaffordable or below threshold says nothing about the
 * other.
 *
 * The balance moves by the profit **less any TDS withheld**. The start notional
 * is debited and the end notional credited within the same instant, so
 * `end - start` is the whole of the trading effect — modelling it as two writes
 * would only create a window in which the paper portfolio looks 100 USDT
 * poorer. On top of that, `tds_withheld` genuinely leaves the account at
 * settlement, which is why it is netted here and `tax_due` is not: the 115BBH
 * charge is assessed annually and is carried as a liability, not a debit. See
 * the `tax` block of `GET /api/portfolio` for the two views side by side.
 */
export async function commitTrade(
  db: D1Database,
  input: CommitTradeInput,
): Promise<number> {
  const { trade, tax } = input;
  const ts = input.ts ?? Date.now();
  const legsJson = JSON.stringify(trade.legs);
  const delta = round8(trade.endAmount - trade.startAmount - (tax?.tdsWithheld ?? 0));

  const statements: D1PreparedStatement[] = [
    balanceDeltaStmt(db, BASE_ASSET, delta),
    db
      .prepare(
        "INSERT INTO trades (ts, cycle, start_amount, end_amount, profit, profit_pct," +
          " legs_json, source, opportunity_id, tds_base, tds_withheld, tax_due," +
          " net_profit, tds_rate, tax_rate, strategy)" +
          " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)" +
          " RETURNING id",
      )
      .bind(
        ts,
        trade.cycle,
        trade.startAmount,
        trade.endAmount,
        trade.profit,
        trade.profitPct,
        legsJson,
        input.source,
        input.opportunityId,
        tax?.tdsBase ?? 0,
        tax?.tdsWithheld ?? 0,
        tax?.taxDue ?? 0,
        tax?.netProfit ?? trade.profit,
        // The rates in force at fill time, snapshotted: re-deriving them from
        // today's settings would rewrite history on the next retune.
        tax?.tdsRate ?? 0,
        tax?.taxRate ?? 0,
        input.strategy ?? STRATEGY_TRIANGULAR,
      ),
    db
      .prepare("UPDATE scans SET executed_count = executed_count + 1 WHERE id = ?1")
      .bind(input.scanId),
  ];

  if (input.opportunityId != null) {
    statements.push(
      db
        .prepare("UPDATE opportunities SET executed = 1 WHERE id = ?1")
        .bind(input.opportunityId),
    );
  }

  const results = await db.batch<{ id: number }>(statements);
  const id = results[1]?.results?.[0]?.id;
  if (id == null) throw new Error("trade insert returned no id");
  return id;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetOptions {
  /** Also drop trades, opportunities and scans. Defaults to `true` at the API. */
  wipeHistory: boolean;
}

/**
 * Restore the paper portfolio to a single `initial_usdt` USDT balance.
 *
 * Settings survive a reset — an operator who tuned the threshold to demo a
 * negative-edge fill does not want that undone by "start over". The scan lock
 * is dropped, because a reset is also the escape hatch for a lock left behind
 * by a Worker that was evicted mid-scan.
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
    );
  }

  await db.batch(statements);
}
