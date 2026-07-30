/**
 * Scan orchestration: the one code path that turns market data into paper
 * trades. `POST /api/scan` and (from Phase 5) the cron handler both call
 * {@link runScan}, so manual and scheduled scans can never drift apart.
 */
import { discoverPairs, getSnapshot } from "./binance";
import { ASSET_UNIVERSE, BASE_ASSET } from "./config";
import {
  commitTrade,
  ensureSeeded,
  finalizeScan,
  getBalance,
  getPairs,
  getRawSetting,
  getSettings,
  insertOpportunities,
  insertScan,
  replacePairs,
  SCAN_LOCK_KEY,
  setRawSetting,
  deleteRawSetting,
  type PairRow,
} from "./db";
import { rankOpportunities, simulateExecution } from "./engine";
import type { Env, PairInfo, SnapshotSource } from "./types";

/** How many ranked cycles are kept per scan. */
export const OPPORTUNITIES_PER_SCAN = 10;

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
  trianglesCount: number;
  /** Net percent of the best cycle, or `null` when none could be priced. */
  bestNetPct: number | null;
  executed: boolean;
  tradeId?: number;
  durationMs: number;
  error?: string;
  /** Set when an overlapping scan held the lock. */
  skipped?: boolean;
}

/** Injection seams. Production passes nothing; tests override the clock. */
export interface ScanDeps {
  now?: () => number;
  discover?: (universe: string[], env: Env) => Promise<PairInfo[]>;
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
 * Refusing to serialise here would instead mean two snapshots racing the same
 * balance, which is the failure that actually matters.
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
 * One full scan: snapshot -> rank -> persist -> (maybe) one simulated trade.
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
      trianglesCount: 0,
      bestNetPct: null,
      executed: false,
      durationMs: now() - startedAt,
      skipped: true,
      error: "scan already in progress",
    };
  }

  const scanId = await insertScan(db, trigger, startedAt);

  let source: SnapshotSource | null = null;
  let pairsCount = 0;
  let trianglesCount = 0;
  let bestNetPct: number | null = null;
  let executed = false;
  let tradeId: number | undefined;
  let error: string | null = null;

  try {
    const settings = await getSettings(db);

    const pairs = await loadPairs(env, deps);
    pairsCount = pairs.length;
    if (pairsCount === 0) throw new Error("no tradable pairs available");

    const snapshot = await getSnapshot(
      pairs.map((p) => p.symbol),
      env,
    );
    source = snapshot.source;

    const quotes = rankOpportunities(
      ASSET_UNIVERSE,
      BASE_ASSET,
      snapshot.book,
      settings.fee_rate,
    );
    trianglesCount = quotes.length;
    bestNetPct = quotes.length > 0 ? quotes[0].netPct : null;

    const top = quotes.slice(0, OPPORTUNITIES_PER_SCAN);
    const opportunityIds = await insertOpportunities(db, scanId, top, snapshot.ts);

    const best = top[0];
    if (best && best.netPct >= settings.min_profit_pct) {
      const balance = await getBalance(db, BASE_ASSET);
      if (balance >= settings.trade_size_usdt) {
        // Re-price against the same snapshot at the real notional; `null` means
        // the quote is no longer executable, which is a skip, not an error.
        const simulated = simulateExecution(
          best,
          snapshot.book,
          settings.fee_rate,
          settings.trade_size_usdt,
        );
        if (simulated) {
          tradeId = await commitTrade(db, {
            scanId,
            opportunityId: opportunityIds[0] ?? null,
            trade: simulated,
            source: snapshot.source,
            ts: snapshot.ts,
          });
          executed = true;
        }
      }
    }
  } catch (err) {
    error = errorMessage(err);
  } finally {
    // Best-effort cleanup: a failed unlock must not mask the scan's own error,
    // and the TTL is the backstop if it does fail.
    try {
      await deleteRawSetting(db, SCAN_LOCK_KEY);
    } catch {
      /* lock expires on its own via SCAN_LOCK_TTL_MS */
    }
  }

  const durationMs = now() - startedAt;
  try {
    await finalizeScan(db, scanId, {
      source,
      pairsCount,
      trianglesCount,
      bestNetPct,
      durationMs,
      error,
    });
  } catch (err) {
    error = error ?? errorMessage(err);
  }

  return {
    scanId,
    source,
    pairsCount,
    trianglesCount,
    bestNetPct,
    executed,
    ...(tradeId != null ? { tradeId } : {}),
    durationMs,
    ...(error != null ? { error } : {}),
  };
}
