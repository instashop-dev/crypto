/**
 * Scan orchestration + paper execution, against the in-memory D1 that
 * `test/apply-migrations.ts` has migrated. No network: the WebSocket source is
 * swapped via `setWsCollector` and MEXC is intercepted with `fetchMock`.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { DEFAULTS } from "../src/config";
import {
  ensureSeeded,
  getBalance,
  getBalances,
  getSettings,
  getTaxTotals,
  listOpportunities,
  listOpportunitiesForScan,
  listScans,
  listTrades,
  replacePairs,
  setRawSetting,
  SCAN_LOCK_KEY,
  SETTING_KEYS,
  updateSettings,
} from "../src/db";
import { runScan } from "../src/scan";
import type { BookTickerEntry } from "../src/types";

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  setWsCollector(null);
  fetchMock.assertNoPendingInterceptors();
});

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

function book(entries: Record<string, [number, number]>): Map<string, BookTickerEntry> {
  return new Map(
    Object.entries(entries).map(([symbol, [bid, ask]]) => [
      symbol,
      { symbol, bid, ask },
    ]),
  );
}

/**
 * A book with a real edge on USDT>BTC>ETH>USDT.
 *
 * Buy BTC at 60000, buy ETH at 0.05 BTC, sell ETH at 3060 USDT:
 *   3060 / (60000 x 0.05) = 1.02 gross, x (1 - 0.001)^3 = 1.01694305898 net,
 * i.e. +1.694305898% — comfortably above the 0.05% default threshold. The
 * mirror cycle USDT>ETH>BTC>USDT is deeply negative, so exactly one of the two
 * enumerated triangles is executable and ranking has an unambiguous winner.
 */
const PROFITABLE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
});

/** Same markets, ETH marked down so every cycle loses to fees. */
const UNPROFITABLE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [2990, 2991],
});

/** Net return of the winning cycle, in percent, and its profit on 100 USDT. */
const EXPECTED_NET_PCT = 1.694305898;
const EXPECTED_PROFIT = 1.694305898;

function stubWs(fn: WsCollector): void {
  setWsCollector(fn);
}

/** Serve `snapshot` for whatever symbols the scan asks for. */
function serveBook(snapshot: Map<string, BookTickerEntry>): void {
  stubWs(async (symbols) => {
    const out = new Map<string, BookTickerEntry>();
    for (const symbol of symbols) {
      const entry = snapshot.get(symbol);
      if (entry) out.set(symbol, entry);
    }
    return out;
  });
}

beforeEach(async () => {
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
});

describe("ensureSeeded", () => {
  it("is idempotent and does not double-credit the balance", async () => {
    await ensureSeeded(env.DB);
    await ensureSeeded(env.DB);

    const balances = await getBalances(env.DB);
    expect(balances).toEqual([{ asset: "USDT", amount: DEFAULTS.initial_usdt }]);
    await expect(getSettings(env.DB)).resolves.toEqual({ ...DEFAULTS });
  });

  it("leaves tuned settings alone", async () => {
    await updateSettings(env.DB, { min_profit_pct: -1 });
    await ensureSeeded(env.DB);

    const settings = await getSettings(env.DB);
    expect(settings.min_profit_pct).toBe(-1);
    expect(settings.fee_rate).toBe(DEFAULTS.fee_rate);
  });

  it("seeds a balance from the stored initial_usdt, not the compiled default", async () => {
    // Simulate a database whose settings were tuned before it ever traded.
    await env.DB.prepare("DELETE FROM balances").run();
    await updateSettings(env.DB, { initial_usdt: 500 });

    await ensureSeeded(env.DB);
    await expect(getBalance(env.DB, "USDT")).resolves.toBe(500);
  });
});

describe("runScan - profitable book", () => {
  it("records the scan, its opportunities and exactly one trade", async () => {
    serveBook(PROFITABLE);

    const result = await runScan(env, "manual");

    expect(result.error).toBeUndefined();
    expect(result.scanId).toBeTypeOf("number");
    expect(result.source).toBe("binance-ws");
    expect(result.pairsCount).toBe(3);
    // USDT>BTC>ETH>USDT and its mirror.
    expect(result.trianglesCount).toBe(2);
    expect(result.bestNetPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    expect(result.executed).toBe(true);
    expect(result.tradeId).toBeTypeOf("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const trades = await listTrades(env.DB, 50);
    expect(trades).toHaveLength(1);
    const [trade] = trades;
    expect(trade.cycle).toBe("USDT>BTC>ETH>USDT");
    expect(trade.startAmount).toBe(DEFAULTS.trade_size_usdt);
    expect(trade.endAmount).toBeCloseTo(101.694305898, 6);
    expect(trade.profit).toBeCloseTo(EXPECTED_PROFIT, 6);
    expect(trade.profitPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    expect(trade.endAmount - trade.startAmount).toBeCloseTo(trade.profit, 6);
    expect(trade.source).toBe("binance-ws");
    expect(trade.legs.map((l) => `${l.side} ${l.pair}`)).toEqual([
      "BUY BTCUSDT",
      "BUY ETHBTC",
      "SELL ETHUSDT",
    ]);
  });

  it("credits the USDT balance by exactly the trade profit", async () => {
    serveBook(PROFITABLE);

    const before = await getBalance(env.DB, "USDT");
    await runScan(env, "manual");
    const after = await getBalance(env.DB, "USDT");

    const [trade] = await listTrades(env.DB, 1);
    expect(after - before).toBeCloseTo(trade.profit, 8);
    expect(after).toBeCloseTo(DEFAULTS.initial_usdt + EXPECTED_PROFIT, 6);

    // The paper portfolio only ever holds the base asset between cycles.
    expect(await getBalances(env.DB)).toHaveLength(1);
  });

  it("marks only the executed opportunity and keeps the scan row consistent", async () => {
    serveBook(PROFITABLE);

    const result = await runScan(env, "manual");

    const opportunities = await listOpportunities(env.DB, 50);
    expect(opportunities).toHaveLength(2);
    expect(opportunities.every((o) => o.scanId === result.scanId)).toBe(true);
    expect(opportunities.filter((o) => o.executed)).toHaveLength(1);

    const executedOpp = opportunities.find((o) => o.executed);
    expect(executedOpp?.cycle).toBe("USDT>BTC>ETH>USDT");
    expect(executedOpp?.netPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    expect(executedOpp?.grossPct).toBeCloseTo(2, 6);
    expect(executedOpp?.legs).toHaveLength(3);

    const [trade] = await listTrades(env.DB, 1);
    expect(trade.opportunityId).toBe(executedOpp?.id);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.id).toBe(result.scanId);
    expect(scan.trigger).toBe("manual");
    expect(scan.source).toBe("binance-ws");
    expect(scan.pairs_count).toBe(3);
    expect(scan.triangles_count).toBe(2);
    expect(scan.best_net_pct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    expect(scan.executed_count).toBe(1);
    expect(scan.error).toBeNull();
  });

  it("executes at most one trade per scan", async () => {
    serveBook(PROFITABLE);

    await runScan(env, "manual");
    await runScan(env, "cron");

    // Two scans, two trades — but never two trades from one scan.
    const trades = await listTrades(env.DB, 50);
    expect(trades).toHaveLength(2);
    const scans = await listScans(env.DB, 10);
    expect(scans.map((s) => s.executed_count)).toEqual([1, 1]);
    expect(scans.map((s) => s.trigger)).toEqual(["cron", "manual"]);
  });
});

describe("runScan - no execution", () => {
  it("records opportunities but no trade when the best cycle is below threshold", async () => {
    serveBook(UNPROFITABLE);

    const result = await runScan(env, "cron");

    expect(result.error).toBeUndefined();
    expect(result.executed).toBe(false);
    expect(result.tradeId).toBeUndefined();
    expect(result.bestNetPct).toBeLessThan(DEFAULTS.min_profit_pct);

    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);
    await expect(listTrades(env.DB, 50)).resolves.toHaveLength(0);
    await expect(getBalance(env.DB, "USDT")).resolves.toBe(DEFAULTS.initial_usdt);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.executed_count).toBe(0);
  });

  it("skips a profitable cycle when the USDT balance cannot cover the trade size", async () => {
    serveBook(PROFITABLE);
    await updateSettings(env.DB, { trade_size_usdt: DEFAULTS.initial_usdt + 1 });

    const result = await runScan(env, "manual");

    expect(result.bestNetPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    expect(result.executed).toBe(false);
    await expect(listTrades(env.DB, 50)).resolves.toHaveLength(0);
    await expect(getBalance(env.DB, "USDT")).resolves.toBe(DEFAULTS.initial_usdt);
    // The opportunity is still recorded — it was real, just unaffordable.
    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);
  });

  it("honours a negative min_profit_pct so the demo can force a fill", async () => {
    serveBook(UNPROFITABLE);
    await updateSettings(env.DB, { min_profit_pct: -100 });

    const result = await runScan(env, "manual");

    expect(result.executed).toBe(true);
    const [trade] = await listTrades(env.DB, 1);
    expect(trade.profit).toBeLessThan(0);
    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + trade.profit,
      6,
    );
  });

  it("demo mode fills even when the best net is below the negative threshold", async () => {
    // UNPROFITABLE's best cycle nets about -0.63%. A user setting -0.1% has
    // asked for demo mode per the dashboard hint ("every scan fills its best
    // cycle"), so the fill must happen even though -0.63 < -0.1.
    serveBook(UNPROFITABLE);
    await updateSettings(env.DB, { min_profit_pct: -0.1 });

    const result = await runScan(env, "manual");

    expect(result.executed).toBe(true);
    const [trade] = await listTrades(env.DB, 1);
    expect(trade.profit).toBeLessThan(0);
    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + trade.profit,
      6,
    );
  });
});

describe("runScan - overlap guard", () => {
  it("skips when a fresh scan_lock is held and writes no scan row", async () => {
    serveBook(PROFITABLE);
    await setRawSetting(env.DB, SCAN_LOCK_KEY, String(Date.now()));

    const result = await runScan(env, "cron");

    expect(result.skipped).toBe(true);
    expect(result.scanId).toBeNull();
    expect(result.error).toBe("scan already in progress");
    await expect(listScans(env.DB, 10)).resolves.toHaveLength(0);
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
  });

  it("takes over a stale lock", async () => {
    serveBook(PROFITABLE);
    await setRawSetting(env.DB, SCAN_LOCK_KEY, String(Date.now() - 120_000));

    const result = await runScan(env, "manual");

    expect(result.skipped).toBeUndefined();
    expect(result.executed).toBe(true);
  });

  it("releases the lock so the next scan can run", async () => {
    serveBook(UNPROFITABLE);

    await runScan(env, "manual");
    const second = await runScan(env, "manual");

    expect(second.skipped).toBeUndefined();
    expect(second.scanId).toBeTypeOf("number");
    await expect(listScans(env.DB, 10)).resolves.toHaveLength(2);
  });
});

describe("runScan - failures", () => {
  it("writes a scan row carrying the error when no source can answer", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    const result = await runScan(env, "cron");

    expect(result.executed).toBe(false);
    expect(result.error).toContain("no market-data source available");
    expect(result.scanId).toBeTypeOf("number");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.id).toBe(result.scanId);
    expect(scan.error).toContain("no market-data source available");
    expect(scan.pairs_count).toBe(3);
    expect(scan.source).toBeNull();
    expect(scan.executed_count).toBe(0);
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
  });

  it("releases the lock after a failed scan", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    await runScan(env, "cron");
    serveBook(PROFITABLE);
    const second = await runScan(env, "cron");

    expect(second.skipped).toBeUndefined();
    expect(second.executed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// India mode
// ---------------------------------------------------------------------------
//
// The arithmetic is derived in test/tax.test.ts; only the persistence and the
// balance effects are re-checked here. On the PROFITABLE book at a 100 USDT
// notional, 1% TDS and 30% tax:
//
//   profit      +1.6943059     tdsBase   301.679452
//   tdsWithheld  3.01679452    taxDue      0.50829177
//   netProfit    1.18601413    cash effect profit - tds = -1.32248862
const TDS_WITHHELD = 3.01679452;
const TAX_DUE = 0.50829177;
const NET_PROFIT = 1.18601413;
const CASH_EFFECT = -1.32248862;

/** Raw trade row, so the stored columns are checked rather than the mapping. */
async function tradeRow(): Promise<Record<string, number | null>> {
  const row = await env.DB.prepare(
    "SELECT profit, net_profit, tds_base, tds_withheld, tax_due, tds_rate, tax_rate" +
      " FROM trades ORDER BY id DESC LIMIT 1",
  ).first<Record<string, number | null>>();
  if (!row) throw new Error("no trade row");
  return row;
}

describe("runScan - india mode off (regression)", () => {
  it("books exactly the pre-Phase-8 numbers and zeroed tax columns", async () => {
    serveBook(PROFITABLE);
    expect((await getSettings(env.DB)).india_mode).toBe(0);

    const result = await runScan(env, "manual");

    // Byte-identical to the untaxed assertions higher up this file.
    expect(result.executed).toBe(true);
    expect(result.tax).toBeUndefined();

    const [trade] = await listTrades(env.DB, 1);
    expect(trade.profit).toBeCloseTo(EXPECTED_PROFIT, 8);
    expect(trade.endAmount).toBeCloseTo(101.694305898, 6);
    expect(trade.profitPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + EXPECTED_PROFIT,
      8,
    );

    // No withholding, no charge, and net profit falls back to gross.
    const row = await tradeRow();
    expect(row.tds_base).toBe(0);
    expect(row.tds_withheld).toBe(0);
    expect(row.tax_due).toBe(0);
    expect(row.tds_rate).toBe(0);
    expect(row.tax_rate).toBe(0);
    expect(row.net_profit).toBe(row.profit);
    expect(trade.netProfit).toBe(trade.profit);
    expect(trade.netProfitPct).toBeCloseTo(trade.profitPct, 6);
  });
});

describe("runScan - india mode on", () => {
  beforeEach(async () => {
    await updateSettings(env.DB, { india_mode: 1 });
  });

  it("withholds TDS from the balance and stores the full breakdown", async () => {
    serveBook(PROFITABLE);

    const result = await runScan(env, "manual");

    expect(result.executed).toBe(true);
    expect(result.tax).toEqual({
      tdsWithheld: TDS_WITHHELD,
      taxDue: TAX_DUE,
      netProfit: NET_PROFIT,
    });

    // The trade itself is untouched: india mode is a reporting overlay, so the
    // chain still ends at 101.6943059 and still reports +1.694305898%.
    const [trade] = await listTrades(env.DB, 1);
    expect(trade.profit).toBeCloseTo(EXPECTED_PROFIT, 8);
    expect(trade.profitPct).toBeCloseTo(EXPECTED_NET_PCT, 6);

    expect(trade.tdsWithheld).toBe(TDS_WITHHELD);
    expect(trade.taxDue).toBe(TAX_DUE);
    expect(trade.netProfit).toBe(NET_PROFIT);
    expect(trade.tdsBase).toBeCloseTo(301.679452, 8);
    expect(trade.tdsRate).toBe(0.01);
    expect(trade.taxRate).toBe(0.3);

    // The headline: a +1.69% cycle *loses* cash once 1%/leg is withheld.
    const balance = await getBalance(env.DB, "USDT");
    expect(balance - DEFAULTS.initial_usdt).toBeCloseTo(CASH_EFFECT, 8);
    expect(balance).toBeLessThan(DEFAULTS.initial_usdt);
    expect(balance - DEFAULTS.initial_usdt).toBeCloseTo(trade.profit - TDS_WITHHELD, 8);
  });

  it("still withholds on a losing cycle, and charges no tax on it", async () => {
    serveBook(UNPROFITABLE);
    await updateSettings(env.DB, { min_profit_pct: -100 });

    const result = await runScan(env, "manual");
    expect(result.executed).toBe(true);

    const [trade] = await listTrades(env.DB, 1);
    expect(trade.profit).toBeLessThan(0);
    // 115BBH allows no loss offset, so a loss simply owes nothing.
    expect(trade.taxDue).toBe(0);
    expect(trade.netProfit).toBe(trade.profit);
    // ...but 194S is on turnover, so cash still leaves. Three legs of a ~100
    // USDT cycle are ~300 USDT of consideration, whatever the cycle did.
    expect(trade.tdsWithheld).toBeGreaterThan(0);
    expect(trade.tdsBase / trade.startAmount).toBeGreaterThan(2.99);
    expect(trade.tdsWithheld).toBeCloseTo(trade.tdsBase * 0.01, 8);
    // The withholding dwarfs the trading loss it sits on top of.
    expect(trade.tdsWithheld).toBeGreaterThan(Math.abs(trade.profit));

    const balance = await getBalance(env.DB, "USDT");
    expect(balance - DEFAULTS.initial_usdt).toBeCloseTo(
      trade.profit - trade.tdsWithheld,
      8,
    );
    expect(DEFAULTS.initial_usdt - balance).toBeCloseTo(
      Math.abs(trade.profit) + trade.tdsWithheld,
      8,
    );
  });

  it("snapshots the rates in force, so retuning cannot rewrite history", async () => {
    serveBook(PROFITABLE);
    await runScan(env, "manual");

    await updateSettings(env.DB, { tds_rate: 0.05, tax_rate: 0.5 });

    const row = await tradeRow();
    expect(row.tds_rate).toBe(0.01);
    expect(row.tax_rate).toBe(0.3);
    expect(row.tds_withheld).toBe(TDS_WITHHELD);
    expect(row.tax_due).toBe(TAX_DUE);
  });

  it("attaches per-opportunity figures, and leaves them NULL when off", async () => {
    serveBook(PROFITABLE);
    const on = await runScan(env, "manual");

    // Ordered by net_pct, so [0] is the cycle that was actually filled.
    const ranked = await listOpportunitiesForScan(env.DB, on.scanId!);
    expect(ranked).toHaveLength(2);
    const [best] = ranked;
    expect(best.cycle).toBe("USDT>BTC>ETH>USDT");
    expect(best.executed).toBe(true);

    // netPct x (1 - 0.3), and ~3.02% of notional withheld per cycle.
    expect(best.indiaNetPct).toBeCloseTo(best.netPct * 0.7, 8);
    expect(best.tdsPct).toBeCloseTo(3.01679452, 8);
    // The TDS drag alone is ~1.8x the whole edge, on the *best* cycle here.
    expect(best.tdsPct!).toBeGreaterThan(best.netPct);
    // Every persisted row carries the figures, not just the executed one.
    expect(ranked.every((o) => o.indiaNetPct !== null && o.tdsPct !== null)).toBe(true);
    // The transform is order-preserving: ranking did not move.
    expect(ranked[0].indiaNetPct!).toBeGreaterThan(ranked[1].indiaNetPct!);

    // Turn the mode off and the columns go back to "not measured".
    await updateSettings(env.DB, { india_mode: 0 });
    serveBook(PROFITABLE);
    const off = await runScan(env, "cron");

    const later = await listOpportunitiesForScan(env.DB, off.scanId!);
    expect(later).toHaveLength(2);
    expect(later.every((o) => o.indiaNetPct === null && o.tdsPct === null)).toBe(true);
    expect(later[0].netPct).toBeCloseTo(EXPECTED_NET_PCT, 6);
  });

  it("keeps the accounting identity across two scans", async () => {
    serveBook(PROFITABLE);
    await runScan(env, "manual");
    await runScan(env, "cron");

    const totals = await getTaxTotals(env.DB);
    expect(totals.trades).toBe(2);
    expect(totals.profitableTrades).toBe(2);

    const equity = await getBalance(env.DB, "USDT");
    // equity already has TDS withheld and no tax paid, so adding back the
    // receivable and deducting the liability must land on the economic result.
    expect(equity + totals.tdsWithheld - totals.taxDue).toBeCloseTo(
      DEFAULTS.initial_usdt + totals.netProfit,
      8,
    );
    expect(totals.netProfit).toBeCloseTo(NET_PROFIT * 2, 8);
    expect(totals.tdsWithheld).toBeCloseTo(TDS_WITHHELD * 2, 8);
    expect(totals.grossProfit).toBeCloseTo(EXPECTED_PROFIT * 2, 6);
  });

  it("does not move the execution gate", async () => {
    // The gate is `netPct >= min_profit_pct` on the pre-tax figure, exactly as
    // with the mode off: india mode reports on fills, it does not veto them.
    serveBook(PROFITABLE);
    const yes = await runScan(env, "manual");
    expect(yes.executed).toBe(true);

    serveBook(UNPROFITABLE);
    const no = await runScan(env, "cron");
    expect(no.executed).toBe(false);
    expect(no.tax).toBeUndefined();
    await expect(listTrades(env.DB, 50)).resolves.toHaveLength(1);
  });
});

describe("ensureSeeded - india-mode settings", () => {
  it("back-fills the new keys without disturbing the tuned ones", async () => {
    await updateSettings(env.DB, { min_profit_pct: -2 });
    for (const key of ["india_mode", "tds_rate", "tax_rate"]) {
      await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
    }

    await ensureSeeded(env.DB);

    const settings = await getSettings(env.DB);
    expect(settings.india_mode).toBe(DEFAULTS.india_mode);
    expect(settings.tds_rate).toBe(DEFAULTS.tds_rate);
    expect(settings.tax_rate).toBe(DEFAULTS.tax_rate);
    expect(settings.min_profit_pct).toBe(-2);

    // Every declared key is materialised, so a later reader never has to guess.
    const { results } = await env.DB.prepare(
      "SELECT key FROM settings ORDER BY key",
    ).all<{ key: string }>();
    const stored = new Set(results.map((r) => r.key));
    for (const key of SETTING_KEYS) expect(stored.has(key)).toBe(true);
  });
});

describe("runScan - first-run bootstrap", () => {
  it("discovers and persists pairs when the cache is empty", async () => {
    await env.DB.prepare("DELETE FROM pairs").run();
    serveBook(PROFITABLE);

    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(200, [
        { symbol: "BTCUSDT", bidPrice: "59990", askPrice: "60000" },
        { symbol: "ETHUSDT", bidPrice: "3060", askPrice: "3061" },
        { symbol: "ETHBTC", bidPrice: "0.0499", askPrice: "0.05" },
        { symbol: "NOTINUNIVERSEUSDT", bidPrice: "1", askPrice: "2" },
      ]);

    const result = await runScan(env, "cron");

    expect(result.pairsCount).toBe(3);
    expect(result.executed).toBe(true);

    const { results } = await env.DB.prepare(
      "SELECT symbol, source FROM pairs ORDER BY symbol",
    ).all<{ symbol: string; source: string }>();
    expect(results.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(results.every((r) => r.source === "mexc-rest")).toBe(true);
  });
});
