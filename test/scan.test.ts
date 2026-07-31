/**
 * Scan orchestration — seeding, the overlap lock, hard failures and first-run
 * bootstrap — against the in-memory D1 that `test/apply-migrations.ts` has
 * migrated. No network: the WebSocket source is swapped via `setWsCollector`
 * and MEXC is intercepted with `fetchMock`.
 *
 * The *spread* half of a scan (ranking, persistence, degradation, india-mode
 * annotation) lives in `test/cross-exchange-scan.test.ts`; the funding half in
 * `test/funding-scan.test.ts`. Nothing here asserts on a fill, because Phase 12
 * removed every path that could produce one.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBasisFetcher } from "../src/basis";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { DEFAULTS } from "../src/config";
import {
  ensureSeeded,
  getBalances,
  getSettings,
  listOpportunities,
  listScans,
  listTrades,
  replacePairs,
  setRawSetting,
  SCAN_LOCK_KEY,
  SETTING_KEYS,
  updateSettings,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import { serveFlatBoard } from "./funding-stub";
import { serveMinimalBasisBoard } from "./basis-stub";
import { runScan } from "../src/scan";
import type { BookTickerEntry } from "../src/types";

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

/**
 * A minimal funding board.
 *
 * Every scan polls funding as well as spreads, so the perp venues need a seam
 * here for exactly the reason the spot venues do: without one the poll would
 * reach for the network. Nothing in this file asserts on funding — the stub
 * exists so that the assertions below stay about orchestration.
 */
const serveFundingBoard: FundingFetcher = serveFlatBoard();

afterEach(() => {
  setWsCollector(null);
  setFundingFetcher(null);
  setBasisFetcher(null);
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
 * A plain, well-formed book. MEXC is never intercepted in this file, so the
 * spread scanner always degrades to `xchgError` — which is the point: an
 * unreachable second venue must not disturb anything asserted here.
 */
const BOOK = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
});

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
  setFundingFetcher(serveFundingBoard);
  setBasisFetcher(serveMinimalBasisBoard());
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
    await updateSettings(env.DB, { xchg_min_profit_pct: -1 });
    await ensureSeeded(env.DB);

    const settings = await getSettings(env.DB);
    expect(settings.xchg_min_profit_pct).toBe(-1);
    expect(settings.fee_rate).toBe(DEFAULTS.fee_rate);
  });

  it("seeds a balance from the stored initial_usdt, not the compiled default", async () => {
    // Simulate a database whose settings were tuned before it ever scanned.
    // `initial_usdt` is not a mutable setting, so it is written directly.
    await env.DB.prepare("DELETE FROM balances").run();
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('initial_usdt', '500')" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();

    await ensureSeeded(env.DB);
    await expect(getBalances(env.DB)).resolves.toEqual([
      { asset: "USDT", amount: 500 },
    ]);
  });

  it("back-fills a missing key without disturbing the tuned ones", async () => {
    await updateSettings(env.DB, { xchg_min_profit_pct: -2 });
    for (const key of ["india_mode", "tds_rate", "tax_rate"]) {
      await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
    }

    await ensureSeeded(env.DB);

    const settings = await getSettings(env.DB);
    expect(settings.india_mode).toBe(DEFAULTS.india_mode);
    expect(settings.tds_rate).toBe(DEFAULTS.tds_rate);
    expect(settings.tax_rate).toBe(DEFAULTS.tax_rate);
    expect(settings.xchg_min_profit_pct).toBe(-2);

    // Every declared key is materialised, so a later reader never has to guess.
    const { results } = await env.DB.prepare(
      "SELECT key FROM settings ORDER BY key",
    ).all<{ key: string }>();
    const stored = new Set(results.map((r) => r.key));
    for (const key of SETTING_KEYS) expect(stored.has(key)).toBe(true);
  });

  it("ignores a stored row for a setting that no longer exists", async () => {
    // A database seeded by a pre-Phase-12 release still carries these two.
    // Retiring a key needs no migration precisely because they are inert.
    for (const key of ["min_profit_pct", "trade_size_usdt"]) {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(key, "-999")
        .run();
    }

    await expect(getSettings(env.DB)).resolves.toEqual({ ...DEFAULTS });
  });
});

describe("runScan - a healthy scan", () => {
  it("records the scan row and books no trade at all", async () => {
    serveBook(BOOK);

    const result = await runScan(env, "manual");

    expect(result.error).toBeUndefined();
    expect(result.scanId).toBeTypeOf("number");
    expect(result.source).toBe("binance-ws");
    expect(result.pairsCount).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Nothing fills, ever: no trade row, and the balance is exactly the seed.
    await expect(listTrades(env.DB, 50)).resolves.toHaveLength(0);
    await expect(getBalances(env.DB)).resolves.toEqual([
      { asset: "USDT", amount: DEFAULTS.initial_usdt },
    ]);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.id).toBe(result.scanId);
    expect(scan.trigger).toBe("manual");
    expect(scan.source).toBe("binance-ws");
    expect(scan.pairs_count).toBe(3);
    expect(scan.error).toBeNull();
    // The triangular columns keep their schema defaults — the strategy is gone,
    // and `finalizeScan` deliberately does not write them.
    expect(scan.triangles_count).toBe(0);
    expect(scan.best_net_pct).toBeNull();
    expect(scan.executed_count).toBe(0);
  });

  it("never marks an opportunity executed", async () => {
    serveBook(BOOK);
    await runScan(env, "manual");
    await runScan(env, "cron");

    const opportunities = await listOpportunities(env.DB, 50);
    expect(opportunities.every((o) => !o.executed)).toBe(true);

    const scans = await listScans(env.DB, 10);
    expect(scans).toHaveLength(2);
    expect(scans.every((s) => s.executed_count === 0)).toBe(true);
  });
});

describe("runScan - overlap guard", () => {
  it("skips when a fresh scan_lock is held and writes no scan row", async () => {
    serveBook(BOOK);
    await setRawSetting(env.DB, SCAN_LOCK_KEY, String(Date.now()));

    const result = await runScan(env, "cron");

    expect(result.skipped).toBe(true);
    expect(result.scanId).toBeNull();
    expect(result.error).toBe("scan already in progress");
    await expect(listScans(env.DB, 10)).resolves.toHaveLength(0);
  });

  it("takes over a stale lock", async () => {
    serveBook(BOOK);
    await setRawSetting(env.DB, SCAN_LOCK_KEY, String(Date.now() - 120_000));

    const result = await runScan(env, "manual");

    expect(result.skipped).toBeUndefined();
    expect(result.source).toBe("binance-ws");
  });

  it("releases the lock so the next scan can run", async () => {
    serveBook(BOOK);

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

    expect(result.error).toContain("no market-data source available");
    expect(result.scanId).toBeTypeOf("number");
    // A total outage is a failed scan, not a degraded strategy, so it lands in
    // `error` and never in `xchgError`.
    expect(result.xchgError).toBeUndefined();
    expect(result.spreadsCount).toBe(0);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.id).toBe(result.scanId);
    expect(scan.error).toContain("no market-data source available");
    expect(scan.pairs_count).toBe(3);
    expect(scan.source).toBeNull();
    expect(scan.xchg_error).toBeNull();
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
    serveBook(BOOK);
    const second = await runScan(env, "cron");

    expect(second.skipped).toBeUndefined();
    expect(second.source).toBe("binance-ws");
  });

  it("fails the scan when the pair cache cannot be filled", async () => {
    await env.DB.prepare("DELETE FROM pairs").run();
    serveBook(BOOK);

    const result = await runScan(env, "cron", { discover: async () => [] });

    expect(result.error).toBe("no tradable pairs available");
    expect(result.pairsCount).toBe(0);
    // Funding needs no pairs and no spot book, so it still ran.
    expect(result.fundingCount).toBe(11);
  });
});

describe("runScan - first-run bootstrap", () => {
  it("discovers and persists pairs when the cache is empty", async () => {
    await env.DB.prepare("DELETE FROM pairs").run();
    serveBook(BOOK);

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

    const { results } = await env.DB.prepare(
      "SELECT symbol, source FROM pairs ORDER BY symbol",
    ).all<{ symbol: string; source: string }>();
    expect(results.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(results.every((r) => r.source === "mexc-rest")).toBe(true);
  });
});
