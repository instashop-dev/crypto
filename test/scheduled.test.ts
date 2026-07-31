/**
 * Cron entry point: the `scheduled()` export in `src/index.ts`.
 *
 * The handler is invoked directly with the pool's `createScheduledController`
 * and `createExecutionContext`, so this exercises the real export shape a Cron
 * Trigger would hit — including the `waitUntil` hand-off, which
 * `waitOnExecutionContext` drains before assertions run.
 *
 * Same seams as `test/scan.test.ts`: in-memory D1 migrated by
 * `test/apply-migrations.ts`, WebSocket source swapped via `setWsCollector`,
 * MEXC intercepted with `fetchMock`. No network.
 */
import {
  createExecutionContext,
  createScheduledController,
  env,
  fetchMock,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { ASSET_UNIVERSE, BASE_ASSET, perpAssets } from "../src/config";
import {
  ensureSeeded,
  listLatestFundingRates,
  listScans,
  listTrades,
  replacePairs,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import worker from "../src/index";
import type { BookTickerEntry } from "../src/types";

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";
const CRON = "* * * * *";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

/** A minimal funding board, keeping the cron tick's funding poll off the wire. */
const serveFundingBoard: FundingFetcher = async (assets) => ({
  venue: "bybit",
  ts: Date.now(),
  quotes: new Map(
    assets.map((symbol) => [
      symbol,
      {
        venue: "bybit" as const,
        symbol,
        instrument: `${symbol}USDT`,
        rate: 0.0001,
        intervalMinutes: 480,
        intervalSource: "api" as const,
        nextFundingTs: null,
        markPrice: null,
      },
    ]),
  ),
});

afterEach(() => {
  setWsCollector(null);
  setFundingFetcher(null);
  fetchMock.assertNoPendingInterceptors();
});

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

/** A plain, well-formed book. MEXC is never intercepted here, so the spread
 *  half degrades to `xchg_error` — which no assertion below depends on. */
const BOOK = new Map<string, BookTickerEntry>(
  Object.entries({
    BTCUSDT: [59990, 60000],
    ETHBTC: [0.0499, 0.05],
    ETHUSDT: [3060, 3061],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

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

/**
 * Fire one cron tick and wait for the `waitUntil`ed scan to settle, exactly as
 * the runtime would before tearing the invocation down.
 */
async function tick(): Promise<void> {
  const controller = createScheduledController({
    scheduledTime: new Date(),
    cron: CRON,
  });
  const ctx = createExecutionContext();

  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  setFundingFetcher(serveFundingBoard);
});

describe("scheduled()", () => {
  it("is exported alongside fetch", () => {
    expect(typeof worker.scheduled).toBe("function");
    expect(typeof worker.fetch).toBe("function");
  });

  it("records a cron-triggered scan and books nothing", async () => {
    serveBook(BOOK);

    await tick();

    const scans = await listScans(env.DB, 10);
    expect(scans).toHaveLength(1);
    const [scan] = scans;
    expect(scan.trigger).toBe("cron");
    expect(scan.source).toBe("binance-ws");
    expect(scan.pairs_count).toBe(3);
    expect(scan.error).toBeNull();

    // The cron path shares runScan with POST /api/scan, so it inherits the
    // observation-only contract rather than restating it.
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
    expect(scan.executed_count).toBe(0);
  });

  it("returns while the scan is still in flight and settles it via waitUntil", async () => {
    // Hold the collector open so the scan is provably unfinished at the moment
    // `scheduled()` resolves — that is the whole point of the waitUntil hand-off.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let collectorEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      collectorEntered = resolve;
    });

    stubWs(async (symbols) => {
      collectorEntered();
      await gate;
      const out = new Map<string, BookTickerEntry>();
      for (const symbol of symbols) {
        const entry = BOOK.get(symbol);
        if (entry) out.set(symbol, entry);
      }
      return out;
    });

    const controller = createScheduledController({
      scheduledTime: new Date(),
      cron: CRON,
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await entered;

    // Handler already returned, gate still shut: the scan row is open and its
    // outcome columns are unwritten.
    const [open] = await listScans(env.DB, 10);
    expect(open.trigger).toBe("cron");
    expect(open.source).toBeNull();
    expect(open.duration_ms).toBe(0);

    release();
    await waitOnExecutionContext(ctx);

    const [done] = await listScans(env.DB, 10);
    expect(done.id).toBe(open.id);
    expect(done.source).toBe("binance-ws");
    expect(done.error).toBeNull();
  });

  it("does not throw when every market-data source is down, and logs the error", async () => {
    stubWs(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    await expect(tick()).resolves.toBeUndefined();

    const [scan] = await listScans(env.DB, 10);
    expect(scan.trigger).toBe("cron");
    expect(scan.error).toContain("no market-data source available");
    expect(scan.source).toBeNull();
  });

  it("lands a funding board on the same tick as the spread scan", async () => {
    serveBook(BOOK);

    await tick();

    // The funding poll runs inside the cron path too, so a deployment nobody
    // ever opens the dashboard on still builds the rate history.
    const rates = await listLatestFundingRates(env.DB);
    expect(rates).toHaveLength(perpAssets(ASSET_UNIVERSE, BASE_ASSET).length);
    expect(rates.every((r) => r.venue === "bybit")).toBe(true);
    expect(rates[0].annualizedPct).toBeCloseTo(10.95, 8);
    expect(rates[0].netAnnualPct).toBeCloseTo(7.3, 6);

    const [scan] = await listScans(env.DB, 10);
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT scan_id FROM funding_rates",
    ).all<{ scan_id: number | null }>();
    expect(results).toEqual([{ scan_id: scan.id }]);
  });

  it("releases the lock so the next tick scans again", async () => {
    serveBook(BOOK);

    await tick();
    await tick();

    // Each tick drains its own waitUntil before the next one fires, so the lock
    // is free again and neither tick is skipped.
    const scans = await listScans(env.DB, 10);
    expect(scans).toHaveLength(2);
    expect(scans.map((s) => s.trigger)).toEqual(["cron", "cron"]);
    expect(scans.every((s) => s.error === null)).toBe(true);
    // Two scans, and still not one trade: the cron path fills nothing either.
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
  });
});
