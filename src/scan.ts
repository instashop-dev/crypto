/**
 * Scan orchestration: the one code path that turns market data into paper
 * trades. `POST /api/scan` and (from Phase 5) the cron handler both call
 * {@link runScan}, so manual and scheduled scans can never drift apart.
 */
import { discoverPairs, getDualSnapshot, getSnapshot, type DualSnapshot } from "./binance";
import {
  ASSET_UNIVERSE,
  BASE_ASSET,
  STRATEGY_CROSS_EXCHANGE,
  STRATEGY_TRIANGULAR,
} from "./config";
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
  toTaxPolicy,
  type OpportunityInput,
  type PairRow,
} from "./db";
import {
  computeTradeTax,
  quoteTax,
  rankOpportunities,
  rankSpreads,
  simulateExecution,
  simulateSpread,
  spreadQuoteTax,
  spreadTax,
  type VenueBook,
} from "./engine";
import type { Env, PairInfo, SnapshotSource } from "./types";

/** How many ranked cycles are kept per scan. */
export const OPPORTUNITIES_PER_SCAN = 10;

/**
 * How many ranked spreads are kept per scan.
 *
 * A separate budget from {@link OPPORTUNITIES_PER_SCAN} rather than a shared
 * one: the two strategies rank on incomparable universes, so a shared top-10
 * would let a day of wide spreads evict every triangle from the history (or the
 * reverse) and silently change what the dashboard is a record of.
 */
export const SPREADS_PER_SCAN = 10;

/** Recorded as the `source` of a cross-exchange fill: it took both venues. */
const XCHG_SOURCE = "binance-ws+mexc-rest";

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
  /** Triangular execution only; cross-exchange has its own flag below. */
  executed: boolean;
  tradeId?: number;
  durationMs: number;
  error?: string;
  /** Set when an overlapping scan held the lock. */
  skipped?: boolean;
  /** India-mode figures for the executed trade; absent when the mode is off. */
  tax?: { tdsWithheld: number; taxDue: number; netProfit: number };
  /** Cross-exchange spreads priced; `0` when the strategy is off or degraded. */
  spreadsCount: number;
  bestSpreadNetPct: number | null;
  xchgExecuted: boolean;
  xchgTradeId?: number;
  /** Why cross-exchange produced nothing. Never sets {@link error}. */
  xchgError?: string;
}

/** Injection seams. Production passes nothing; tests override the clock. */
export interface ScanDeps {
  now?: () => number;
  discover?: (universe: string[], env: Env) => Promise<PairInfo[]>;
  /** Dual-venue snapshot seam; defaults to the real two-source fetch. */
  getSnapshots?: (symbols: string[], env: Env) => Promise<DualSnapshot>;
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
      spreadsCount: 0,
      bestSpreadNetPct: null,
      xchgExecuted: false,
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
  let tax: ScanResult["tax"];
  let spreadsCount = 0;
  let bestSpreadNetPct: number | null = null;
  let xchgExecuted = false;
  let xchgTradeId: number | undefined;
  let xchgError: string | null = null;

  try {
    const settings = await getSettings(db);
    const policy = toTaxPolicy(settings);

    const pairs = await loadPairs(env, deps);
    pairsCount = pairs.length;
    if (pairsCount === 0) throw new Error("no tradable pairs available");

    const symbols = pairs.map((p) => p.symbol);
    // With the strategy on, both venues are wanted, so they are fetched
    // concurrently and the triangular scanner reads `primary` — which is
    // exactly the snapshot the sequential chain would have produced. With it
    // off, nothing changes at all: the same single call, the same fallback
    // order, no second REST request.
    const dual =
      settings.xchg_enabled !== 0
        ? await (deps.getSnapshots ?? getDualSnapshot)(symbols, env)
        : null;
    const snapshot = dual ? dual.primary : await getSnapshot(symbols, env);
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
    // Mapped explicitly rather than passing the quotes through: the persisted
    // shape now carries india-mode columns the engine knows nothing about, and
    // a structural pass-through would silently stop persisting them the moment
    // either shape moved. When the mode is off the columns stay SQL NULL, so
    // "not measured" never masquerades as "measured as zero".
    const rows: OpportunityInput[] = top.map((q) => {
      const figures = policy.enabled
        ? quoteTax(q, snapshot.book, settings.fee_rate, BASE_ASSET, policy)
        : null;
      return {
        cycle: q.cycle,
        grossPct: q.grossPct,
        netPct: q.netPct,
        legs: q.legs,
        indiaNetPct: figures?.indiaNetPct ?? null,
        tdsPct: figures?.tdsPct ?? null,
      };
    });
    // Tagged explicitly rather than leaning on the default: with two strategies
    // writing to one table, "which one wrote this row" should be visible at the
    // call site rather than inherited from a signature.
    const opportunityIds = await insertOpportunities(
      db,
      scanId,
      rows,
      snapshot.ts,
      STRATEGY_TRIANGULAR,
    );

    const best = top[0];
    // A negative threshold means demo mode: fill the best cycle uncondition-
    // ally, as the dashboard documents — real best nets hover around -0.3%,
    // so a plain ">= threshold" would make modest negatives (e.g. -0.1) dead.
    const demoMode = settings.min_profit_pct < 0;
    if (best && (demoMode || best.netPct >= settings.min_profit_pct)) {
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
          // Re-priced from the triangle, never from `simulated.legs`: those
          // amounts are round8-quantised for reporting and would poison the
          // TDS base (see the precision note in src/engine/tax.ts).
          const breakdown = policy.enabled
            ? computeTradeTax(
                best.triangle,
                snapshot.book,
                settings.fee_rate,
                settings.trade_size_usdt,
                BASE_ASSET,
                policy,
              )
            : null;
          // Unpriceable tax under an enabled policy is a skip, exactly like an
          // unpriceable re-simulation: booking a fill whose withholding we
          // could not compute would corrupt the very P&L this mode reports.
          if (breakdown || !policy.enabled) {
            tradeId = await commitTrade(db, {
              scanId,
              opportunityId: opportunityIds[0] ?? null,
              trade: simulated,
              source: snapshot.source,
              ts: snapshot.ts,
              strategy: STRATEGY_TRIANGULAR,
              ...(breakdown ? { tax: breakdown } : {}),
            });
            executed = true;
            if (breakdown) {
              tax = {
                tdsWithheld: breakdown.tdsWithheld,
                taxDue: breakdown.taxDue,
                netProfit: breakdown.netProfit,
              };
            }
          }
        }
      }
    }

    // -- cross-exchange spreads ---------------------------------------------
    //
    // Deliberately last, and deliberately inside its own try/catch. The
    // triangular half is the product's original promise and must not be able to
    // fail because a second venue was unreachable or a new engine path threw,
    // so anything raised here lands in `xchgError` (a column of its own) and
    // never in `error`. The scan is degraded, not failed.
    if (dual && settings.xchg_enabled !== 0) {
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
          // Only markets that settle in the base asset: an ETH/BTC spread
          // would leave the paper portfolio holding a directional BTC position
          // rather than closing back to USDT.
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
          const spreadIds = await insertOpportunities(
            db,
            scanId,
            spreadRows,
            snapshot.ts,
            STRATEGY_CROSS_EXCHANGE,
          );

          const bestSpread = topSpreads[0];
          // Same demo-mode convention as the triangular threshold.
          const xchgDemo = settings.xchg_min_profit_pct < 0;
          if (
            bestSpread &&
            (xchgDemo || bestSpread.netPct >= settings.xchg_min_profit_pct)
          ) {
            // Re-read: the triangular fill above may already have moved the
            // balance (up, or down by its TDS), and a stale read here could
            // book a fill the portfolio cannot fund.
            const balance = await getBalance(db, BASE_ASSET);
            if (balance >= settings.trade_size_usdt) {
              const simulated = simulateSpread(
                bestSpread,
                venues[0],
                venues[1],
                settings.fee_rate,
                settings.trade_size_usdt,
              );
              if (simulated) {
                // A spread is a two-disposal chain, and both disposals are of a
                // VDA — see src/engine/crossExchange.ts. Re-priced from the
                // quote, never from `simulated.legs`, whose amounts are
                // round8-quantised for reporting.
                const breakdown = policy.enabled
                  ? spreadTax(
                      bestSpread,
                      settings.fee_rate,
                      settings.trade_size_usdt,
                      BASE_ASSET,
                      policy,
                    )
                  : null;
                if (breakdown || !policy.enabled) {
                  xchgTradeId = await commitTrade(db, {
                    scanId,
                    opportunityId: spreadIds[0] ?? null,
                    trade: simulated,
                    source: XCHG_SOURCE,
                    ts: snapshot.ts,
                    strategy: STRATEGY_CROSS_EXCHANGE,
                    ...(breakdown ? { tax: breakdown } : {}),
                  });
                  xchgExecuted = true;
                }
              }
            }
          }
        }
      } catch (err) {
        xchgError = errorMessage(err);
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
    trianglesCount,
    bestNetPct,
    executed,
    ...(tradeId != null ? { tradeId } : {}),
    durationMs,
    ...(error != null ? { error } : {}),
    ...(tax != null ? { tax } : {}),
    spreadsCount,
    bestSpreadNetPct,
    xchgExecuted,
    ...(xchgTradeId != null ? { xchgTradeId } : {}),
    ...(xchgError != null ? { xchgError } : {}),
  };
}
