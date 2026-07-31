/**
 * The funding block of `runScan`, against the migrated in-memory D1.
 *
 * Three seams are stubbed and no request leaves the worker: the spot venues via
 * `setWsCollector` / `setRestFetcher` (the spread half has to keep working,
 * because half the point of these tests is that funding cannot break it), and
 * the funding board via `deps.fetchFunding`.
 *
 * The clock is injected too. Every assertion about the poll gate, the retention
 * window and the interval-cache TTL is a statement about elapsed time, and a
 * real clock would make them either slow or flaky.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setRestFetcher, setWsCollector } from "../src/binance";
import { ASSET_UNIVERSE, BASE_ASSET, perpAssets } from "../src/config";
import {
  ensureSeeded,
  FUNDING_INTERVALS_KEY,
  getFundingIntervals,
  getRawSetting,
  insertFundingRates,
  listLatestFundingRates,
  listOpportunities,
  listScans,
  replacePairs,
  resetAll,
  setRawSetting,
  updateSettings,
} from "../src/db";
import { setFundingFetcher } from "../src/funding";
import { runScan } from "../src/scan";
import type { BookTickerEntry } from "../src/types";
import type { FundingFetcher, FundingQuote } from "../src/funding";

const ASSETS = perpAssets(ASSET_UNIVERSE, BASE_ASSET);
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 300_000;

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

/** The Binance side of the spread half, which must keep working throughout. */
const BINANCE = new Map<string, BookTickerEntry>(
  Object.entries({
    BTCUSDT: [59990, 60000],
    ETHBTC: [0.0499, 0.05],
    ETHUSDT: [3060, 3061],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

/** The MEXC side, quoting BTC dearer so two spreads are always priceable. */
const MEXC = new Map<string, BookTickerEntry>(
  Object.entries({
    BTCUSDT: [60500, 60510],
    ETHUSDT: [3050, 3051],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

/** Serve `snapshot` for whatever symbols the scan asks for. */
function serve(snapshot: Map<string, BookTickerEntry>) {
  return async (symbols: string[]) => {
    const out = new Map<string, BookTickerEntry>();
    for (const symbol of symbols) {
      const entry = snapshot.get(symbol);
      if (entry) out.set(symbol, entry);
    }
    return out;
  };
}

/** A frozen clock the scan and the stubs share. */
let clock = 1_700_000_000_000;
const now = () => clock;

beforeAll(() => {
  // Belt and braces: every seam here is stubbed, so nothing should reach the
  // network — and if something does, it fails loudly instead of dialling out.
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  clock = 1_700_000_000_000;
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  // Both spot venues are served so the spread half genuinely produces rows:
  // several tests below assert that a funding failure leaves them intact.
  setWsCollector(serve(BINANCE));
  setRestFetcher(serve(MEXC));
});

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
  setFundingFetcher(null);
});

/** A full Bybit-shaped board at the current clock, one quote per asset. */
function board(intervals: Record<string, number> = {}): FundingFetcher {
  return async (assets) => ({
    venue: "bybit",
    ts: clock,
    quotes: new Map<string, FundingQuote>(
      assets.map((symbol, i) => {
        const instrument = `${symbol}USDT`;
        const known = intervals[instrument];
        return [
          symbol,
          {
            venue: "bybit",
            symbol,
            instrument,
            // Descending, so ranking has an unambiguous winner: BTC first.
            rate: 0.0002 - i * 0.00001,
            intervalMinutes: known ?? 480,
            intervalSource: known ? "api" : "assumed",
            nextFundingTs: clock + 3_600_000,
            markPrice: 100 + i,
          },
        ];
      }),
    ),
  });
}

/** A funding fetcher whose interval handling mirrors the real parser's. */
function boardUsingCache(): FundingFetcher {
  return async (assets, _env, deps) => board(deps?.intervals ?? {})(assets, _env, deps);
}

async function fundingRows(): Promise<
  Array<{ scan_id: number | null; ts: number; symbol: string; interval_source: string }>
> {
  const { results } = await env.DB.prepare(
    "SELECT scan_id, ts, symbol, interval_source FROM funding_rates ORDER BY id ASC",
  ).all<{ scan_id: number | null; ts: number; symbol: string; interval_source: string }>();
  return results ?? [];
}

describe("runScan - funding poll", () => {
  it("persists the whole board and reports it on the result", async () => {
    const result = await runScan(env, "manual", { now, fetchFunding: board() });

    expect(result.fundingError).toBeUndefined();
    expect(result.fundingSkipped).toBeUndefined();
    expect(result.fundingVenue).toBe("bybit");
    expect(result.fundingCount).toBe(11);
    // 0.0002 per 8h = 21.9% annual, less the 3.65% drag at 30 days
    // (2 x 0.1% spot + 2 x 0.05% perp, annualised).
    expect(result.bestFundingNetAnnualPct).toBeCloseTo(18.25, 6);

    const rows = await fundingRows();
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.scan_id === result.scanId)).toBe(true);
    expect(rows.every((r) => r.ts === clock)).toBe(true);
    expect(rows.map((r) => r.symbol).sort()).toEqual([...ASSETS].sort());
  });

  it("stores the derived percentages, best net carry first on read", async () => {
    await runScan(env, "manual", { now, fetchFunding: board() });

    const rates = await listLatestFundingRates(env.DB);
    expect(rates).toHaveLength(11);
    expect(rates[0].symbol).toBe("BTC");
    expect(rates[0].rate).toBe(0.0002);
    expect(rates[0].annualizedPct).toBeCloseTo(21.9, 8);
    expect(rates[0].netAnnualPct).toBeCloseTo(18.25, 6);
    expect(rates[0].instrument).toBe("BTCUSDT");
    expect(rates[0].venue).toBe("bybit");
    expect(rates[0].nextFundingTs).toBe(clock + 3_600_000);
    // Sorted descending, and every row priced at the same fee drag.
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i].netAnnualPct).toBeLessThanOrEqual(rates[i - 1].netAnnualPct);
      expect(rates[i].annualizedPct - rates[i].netAnnualPct).toBeCloseTo(3.65, 6);
    }
  });

  it("persists rows below the display threshold — it is not a write-time gate", async () => {
    // A carry position is held for days, so the series is the product; a
    // threshold applied at write time would throw away the half of the history
    // that shows a rate on its way up.
    await updateSettings(env.DB, { funding_min_annual_pct: 500 });

    const result = await runScan(env, "manual", { now, fetchFunding: board() });

    expect(result.fundingCount).toBe(11);
    await expect(fundingRows()).resolves.toHaveLength(11);
  });

  it("re-prices when funding_hold_days changes, without touching the rate", async () => {
    await updateSettings(env.DB, { funding_hold_days: 365 });

    await runScan(env, "manual", { now, fetchFunding: board() });

    const [best] = await listLatestFundingRates(env.DB);
    expect(best.rate).toBe(0.0002);
    expect(best.annualizedPct).toBeCloseTo(21.9, 8);
    // Held a year, the 0.3% round trip is a 0.3% drag rather than 3.65%.
    expect(best.netAnnualPct).toBeCloseTo(21.6, 6);
  });

  it("charges the perp legs at perp_fee_rate, not the spot rate", async () => {
    // Raising the perp rate to the spot one reproduces the pre-Phase-13
    // figure exactly: 21.9% less a 4.86666667% drag. That is the whole size of
    // the correction, and it is worth 1.21666667%/yr at a 30-day hold.
    await updateSettings(env.DB, { perp_fee_rate: 0.001 });

    await runScan(env, "manual", { now, fetchFunding: board() });

    const [best] = await listLatestFundingRates(env.DB);
    expect(best.annualizedPct).toBeCloseTo(21.9, 8);
    expect(best.netAnnualPct).toBeCloseTo(17.03333333, 6);
  });

  it("prices the perp legs free when perp_fee_rate is zero", async () => {
    await updateSettings(env.DB, { perp_fee_rate: 0 });

    await runScan(env, "manual", { now, fetchFunding: board() });

    const [best] = await listLatestFundingRates(env.DB);
    // Only the two spot legs are left: 0.002 x (365/30) x 100 = 2.43333333%.
    expect(best.netAnnualPct).toBeCloseTo(21.9 - 2.43333333, 6);
  });
});

describe("runScan - the poll gate", () => {
  it("skips a second scan inside the poll interval", async () => {
    const first = await runScan(env, "manual", { now, fetchFunding: board() });
    expect(first.fundingCount).toBe(11);

    clock += POLL_MS - 1;
    let calls = 0;
    const counting: FundingFetcher = async (...args) => {
      calls++;
      return board()(...args);
    };
    const second = await runScan(env, "manual", { now, fetchFunding: counting });

    expect(calls).toBe(0);
    expect(second.fundingSkipped).toBe(true);
    expect(second.fundingCount).toBe(0);
    expect(second.fundingVenue).toBeNull();
    expect(second.bestFundingNetAnnualPct).toBeNull();
    expect(second.fundingError).toBeUndefined();
    // The spread half is unaffected: it runs every scan, funding does not.
    expect(second.error).toBeUndefined();
    await expect(fundingRows()).resolves.toHaveLength(11);
  });

  it("polls again once the interval has elapsed", async () => {
    await runScan(env, "manual", { now, fetchFunding: board() });

    clock += POLL_MS;
    const second = await runScan(env, "manual", { now, fetchFunding: board() });

    expect(second.fundingSkipped).toBeUndefined();
    expect(second.fundingCount).toBe(11);

    const rows = await fundingRows();
    expect(rows).toHaveLength(22);
    expect(new Set(rows.map((r) => r.ts)).size).toBe(2);
    // The newest board is exactly one poll, never a mixture of two.
    await expect(listLatestFundingRates(env.DB)).resolves.toHaveLength(11);
  });

  it("polls on the very first scan, with no baseline to wait out", async () => {
    // A cold database must fill the board immediately: `lastTs === null` is not
    // "polled at time zero", it is "never polled".
    const result = await runScan(env, "manual", {
      now,
      fetchFunding: board(),
      fundingPollIntervalMs: DAY_MS,
    });
    expect(result.fundingCount).toBe(11);
  });

  it("honours an overridden poll interval", async () => {
    await runScan(env, "manual", { now, fetchFunding: board() });
    clock += 60_000;

    const tight = await runScan(env, "manual", {
      now,
      fetchFunding: board(),
      fundingPollIntervalMs: 1000,
    });
    expect(tight.fundingSkipped).toBeUndefined();
    expect(tight.fundingCount).toBe(11);
  });
});

describe("runScan - a dead funding venue", () => {
  it("degrades the funding block alone and never touches scans.error", async () => {
    const result = await runScan(env, "manual", {
      now,
      fetchFunding: async () => {
        throw new Error("no funding-rate source available (bybit: HTTP 403; okx: HTTP 429)");
      },
    });

    expect(result.fundingError).toContain("no funding-rate source available");
    expect(result.fundingError).toContain("bybit");
    expect(result.fundingError).toContain("okx");
    expect(result.fundingCount).toBe(0);
    expect(result.fundingVenue).toBeNull();

    // The scan itself succeeded, and the spread half completed its persistence
    // regardless — the funding block runs last and in a catch of its own
    // precisely so a dead perp venue cannot cost the spot half its rows.
    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.spreadsCount).toBe(2);
    expect(result.bestSpreadNetPct).toBeCloseTo(0.6317675, 8);
    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toBeNull();
    expect(scan.spreads_count).toBe(2);
    await expect(fundingRows()).resolves.toHaveLength(0);
  });

  it("polls funding even when the spot venues are all down", async () => {
    // Funding needs no pairs and no spot book, so a scan that failed for want
    // of market data can still report a perfectly good board.
    setWsCollector(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    setRestFetcher(async () => {
      throw new Error("HTTP 451");
    });

    const result = await runScan(env, "manual", { now, fetchFunding: board() });

    expect(result.error).toContain("no market-data source available");
    expect(result.fundingCount).toBe(11);
    expect(result.fundingError).toBeUndefined();
    await expect(fundingRows()).resolves.toHaveLength(11);
  });

  it("leaves the lock released after a funding failure", async () => {
    await runScan(env, "manual", {
      now,
      fetchFunding: async () => {
        throw new Error("boom");
      },
    });

    clock += POLL_MS;
    const second = await runScan(env, "manual", { now, fetchFunding: board() });
    expect(second.skipped).toBeUndefined();
    expect(second.fundingCount).toBe(11);
  });
});

describe("runScan - retention", () => {
  it("prunes rows past the 7-day window as part of the insert batch", async () => {
    const stale = clock - 8 * DAY_MS;
    const recent = clock - 1 * DAY_MS;
    const row = (symbol: string) => ({
      venue: "bybit",
      symbol,
      instrument: `${symbol}USDT`,
      rate: 0.0001,
      intervalMinutes: 480,
      intervalSource: "api",
      annualizedPct: 10.95,
      netAnnualPct: 7.3,
      nextFundingTs: null,
      markPrice: null,
    });
    await insertFundingRates(env.DB, null, [row("BTC")], stale);
    await insertFundingRates(env.DB, null, [row("BTC")], recent);

    await expect(fundingRows()).resolves.toHaveLength(2);

    await runScan(env, "manual", { now, fetchFunding: board() });

    const rows = await fundingRows();
    const timestamps = rows.map((r) => r.ts);
    expect(timestamps).not.toContain(stale);
    expect(timestamps).toContain(recent);
    expect(rows).toHaveLength(12);
  });
});

describe("runScan - the funding-interval cache", () => {
  it("fetches the cadences on the first poll and caches them", async () => {
    let calls = 0;
    const result = await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => {
        calls++;
        return { BTCUSDT: 240, ETHUSDT: 480 };
      },
    });

    expect(calls).toBe(1);
    expect(result.fundingCount).toBe(11);

    const cached = await getFundingIntervals(env.DB);
    expect(cached).toEqual({ ts: clock, intervals: { BTCUSDT: 240, ETHUSDT: 480 } });

    const rows = await fundingRows();
    const source = (symbol: string) => rows.find((r) => r.symbol === symbol)!.interval_source;
    expect(source("BTC")).toBe("api");
    expect(source("SOL")).toBe("assumed");
  });

  it("reuses the cache inside the TTL and refreshes past it", async () => {
    let calls = 0;
    const deps = {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => {
        calls++;
        return { BTCUSDT: 480 };
      },
    };

    await runScan(env, "manual", deps);
    expect(calls).toBe(1);

    // A day minus a minute: still fresh, so no second instruments-info request.
    clock += DAY_MS - 60_000;
    await runScan(env, "manual", deps);
    expect(calls).toBe(1);

    // Past the TTL (and past the poll gate, which would otherwise skip the
    // whole funding block and never consult the cache at all).
    clock += POLL_MS + 60_000;
    await runScan(env, "manual", deps);
    expect(calls).toBe(2);
  });

  it("degrades to 'assumed' when the cadence lookup fails, without failing the poll", async () => {
    const result = await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => {
        throw new Error("HTTP 403");
      },
    });

    // An assumed 8 hours is wrong at worst by a factor; a missing board is
    // wrong by everything.
    expect(result.fundingError).toBeUndefined();
    expect(result.fundingCount).toBe(11);
    const rows = await fundingRows();
    expect(rows.every((r) => r.interval_source === "assumed")).toBe(true);
    // Nothing was cached, so the next poll tries again rather than pinning the
    // guess in place for a day.
    await expect(getFundingIntervals(env.DB)).resolves.toBeNull();
  });

  it("does not cache an empty cadence map", async () => {
    await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => ({}),
    });
    await expect(getFundingIntervals(env.DB)).resolves.toBeNull();
  });

  it("survives a corrupt cache row and re-populates it", async () => {
    await setRawSetting(env.DB, FUNDING_INTERVALS_KEY, "{not json at all");

    let calls = 0;
    const result = await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => {
        calls++;
        return { BTCUSDT: 240 };
      },
    });

    expect(result.fundingError).toBeUndefined();
    expect(result.fundingCount).toBe(11);
    expect(calls).toBe(1);
    await expect(getFundingIntervals(env.DB)).resolves.toEqual({
      ts: clock,
      intervals: { BTCUSDT: 240 },
    });
  });

  it("degrades a corrupt cache to 'assumed' when the refresh also fails", async () => {
    await setRawSetting(env.DB, FUNDING_INTERVALS_KEY, JSON.stringify({ ts: "soon" }));

    const result = await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => {
        throw new Error("HTTP 500");
      },
    });

    expect(result.fundingError).toBeUndefined();
    const rows = await fundingRows();
    expect(rows.every((r) => r.interval_source === "assumed")).toBe(true);
  });

  it("ignores a cached cadence that is not a usable number", async () => {
    await setRawSetting(
      env.DB,
      FUNDING_INTERVALS_KEY,
      JSON.stringify({ ts: clock, intervals: { BTCUSDT: "480", ETHUSDT: 240 } }),
    );

    await runScan(env, "manual", { now, fetchFunding: boardUsingCache() });

    const rows = await fundingRows();
    const source = (symbol: string) => rows.find((r) => r.symbol === symbol)!.interval_source;
    expect(source("BTC")).toBe("assumed");
    expect(source("ETH")).toBe("api");
  });

  it("keeps the settings row out of the typed tunables", async () => {
    await runScan(env, "manual", {
      now,
      fetchFunding: boardUsingCache(),
      fetchFundingIntervals: async () => ({ BTCUSDT: 480 }),
    });

    // The cache lives in `settings` for the same reason `scan_lock` does, and
    // `getSettings` ignores unknown keys — a JSON blob here can never become a
    // NaN tunable.
    await expect(getRawSetting(env.DB, FUNDING_INTERVALS_KEY)).resolves.toContain("BTCUSDT");
    const settings = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = ?1",
    )
      .bind(FUNDING_INTERVALS_KEY)
      .first<{ value: string }>();
    expect(settings).not.toBeNull();
  });
});

describe("resetAll - funding rows", () => {
  beforeEach(async () => {
    await runScan(env, "manual", { now, fetchFunding: board() });
    await expect(fundingRows()).resolves.toHaveLength(11);
  });

  it("clears the board when history is wiped", async () => {
    await resetAll(env.DB, { wipeHistory: true });
    await expect(fundingRows()).resolves.toHaveLength(0);
  });

  it("keeps the board when history is kept", async () => {
    await resetAll(env.DB, { wipeHistory: false });
    await expect(fundingRows()).resolves.toHaveLength(11);
  });

  it("keeps the interval cache either way: it describes the exchanges, not us", async () => {
    await setRawSetting(
      env.DB,
      FUNDING_INTERVALS_KEY,
      JSON.stringify({ ts: clock, intervals: { BTCUSDT: 480 } }),
    );
    await resetAll(env.DB, { wipeHistory: true });
    await expect(getFundingIntervals(env.DB)).resolves.toEqual({
      ts: clock,
      intervals: { BTCUSDT: 480 },
    });
  });
});
