/**
 * The basis block of `runScan`, plus `GET /api/basis`, against the migrated
 * in-memory D1.
 *
 * Four seams are stubbed and no request leaves the worker: the spot venues via
 * `setWsCollector` / `setRestFetcher`, the funding board via `deps.fetchFunding`
 * and the basis board via `deps.fetchBasis`. The other three exist so the
 * isolation assertions mean something — half the point of this file is that a
 * dead futures endpoint costs the basis board and nothing else.
 *
 * The clock is injected. Every assertion about the poll gate and the retention
 * window is a statement about elapsed time, and a real clock would make them
 * either slow or flaky.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBasisFetcher, BASIS_VENUE } from "../src/basis";
import { setRestFetcher, setWsCollector } from "../src/binance";
import {
  BASIS_POLL_TS_KEY,
  ensureSeeded,
  FUNDING_POLL_TS_KEY,
  getRawSetting,
  insertBasisRates,
  listLatestBasisRates,
  listOpportunities,
  replacePairs,
  resetAll,
  updateSettings,
} from "../src/db";
import { setFundingFetcher } from "../src/funding";
import { app } from "../src/index";
import { runScan } from "../src/scan";
import type { BookTickerEntry, Env } from "../src/types";
import type { BasisFetcher } from "../src/basis";
import { basisQuote, basisSnapshotOf, serveEmptyBasisBoard } from "./basis-stub";
import { serveFlatBoard } from "./funding-stub";

const DAY_MS = 86_400_000;
const POLL_MS = 300_000;

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

const BINANCE = new Map<string, BookTickerEntry>(
  Object.entries({
    BTCUSDT: [59990, 60000],
    ETHBTC: [0.0499, 0.05],
    ETHUSDT: [3060, 3061],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

const MEXC = new Map<string, BookTickerEntry>(
  Object.entries({
    BTCUSDT: [60500, 60510],
    ETHUSDT: [3050, 3051],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

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

/** A frozen clock the scan and every stub share. */
let clock = 1_700_000_000_000;
const now = () => clock;

/**
 * A three-contract OKX curve at the current clock: 30, 90 and 180 days out at
 * 0.6%, 2% and 3% over spot.
 *
 * The numbers are chosen so ranking by **net** is not the same as ranking by
 * gross. Gross annualised: M3 8.30% > M1 7.30% > M6 6.08%. Net, once each row
 * pays its round trip over its own remaining life: M3 6.89% > M6 5.48% >
 * M1 3.65%. M1 and M6 swap, which is the property this board's sort is supposed
 * to have and would silently lose if it ranked on gross.
 */
function board(): BasisFetcher {
  return async () =>
    basisSnapshotOf(
      [
        basisQuote("BTC", {
          instrument: "BTC-USD_UM-M1",
          expiryTs: clock + 30 * DAY_MS,
          spotPrice: 60_000,
          futurePrice: 60_360,
        }),
        basisQuote("BTC", {
          instrument: "BTC-USD_UM-M3",
          expiryTs: clock + 90 * DAY_MS,
          spotPrice: 60_000,
          futurePrice: 61_200,
        }),
        basisQuote("ETH", {
          instrument: "ETH-USD_UM-M6",
          expiryTs: clock + 180 * DAY_MS,
          spotPrice: 3_000,
          futurePrice: 3_090,
        }),
      ],
      clock,
    );
}

async function basisRows(): Promise<
  Array<{ scan_id: number | null; ts: number; instrument: string; symbol: string }>
> {
  const { results } = await env.DB.prepare(
    "SELECT scan_id, ts, instrument, symbol FROM basis_rates ORDER BY id ASC",
  ).all<{ scan_id: number | null; ts: number; instrument: string; symbol: string }>();
  return results ?? [];
}

function api(path: string) {
  return app.request(path, {}, env as unknown as Env);
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  clock = 1_700_000_000_000;
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  setWsCollector(serve(BINANCE));
  setRestFetcher(serve(MEXC));
  setFundingFetcher(serveFlatBoard());
  setBasisFetcher(serveEmptyBasisBoard());
});

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
  setFundingFetcher(null);
  setBasisFetcher(null);
});

describe("runScan - the basis poll", () => {
  it("persists the whole board and reports it on the result", async () => {
    const result = await runScan(env, "manual", { now, fetchBasis: board() });

    expect(result.basisError).toBeUndefined();
    expect(result.basisSkipped).toBeUndefined();
    expect(result.basisCount).toBe(3);
    // 2% over 90 days: 8.11111111% gross, less a 1.21666667% drag.
    expect(result.bestBasisNetAnnualPct).toBeCloseTo(6.89444444, 6);

    const rows = await basisRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scan_id === result.scanId)).toBe(true);
    expect(rows.every((r) => r.ts === clock)).toBe(true);
  });

  it("stores every derived figure, best net first on read", async () => {
    await runScan(env, "manual", { now, fetchBasis: board() });

    const rates = await listLatestBasisRates(env.DB);
    expect(rates.map((r) => r.instrument)).toEqual([
      "BTC-USD_UM-M3",
      "ETH-USD_UM-M6",
      "BTC-USD_UM-M1",
    ]);

    const [best] = rates;
    expect(best.venue).toBe(BASIS_VENUE);
    expect(best.symbol).toBe("BTC");
    expect(best.daysToExpiry).toBe(90);
    expect(best.expiryTs).toBe(clock + 90 * DAY_MS);
    expect(best.spotPrice).toBe(60_000);
    expect(best.futurePrice).toBe(61_200);
    expect(best.basisPct).toBeCloseTo(2, 8);
    expect(best.annualizedPct).toBeCloseTo(8.11111111, 6);
    expect(best.netAnnualPct).toBeCloseTo(6.89444444, 6);

    // The 30-day contract out-grosses the 180-day one and still ranks below it:
    // its 0.3% round trip is amortised over a month rather than half a year.
    const near = rates.find((r) => r.instrument === "BTC-USD_UM-M1")!;
    const far = rates.find((r) => r.instrument === "ETH-USD_UM-M6")!;
    expect(near.basisPct).toBeCloseTo(0.6, 8);
    expect(near.annualizedPct).toBeCloseTo(7.3, 6);
    // The drag is not a column: it is exactly `annualized − net`, and storing a
    // third figure derivable from the other two would be one more thing to keep
    // consistent. 0.3% of notional over 30 days is 3.65%/yr.
    expect(near.annualizedPct - near.netAnnualPct).toBeCloseTo(3.65, 6);
    expect(near.netAnnualPct).toBeCloseTo(3.65, 6);
    expect(near.annualizedPct).toBeGreaterThan(far.annualizedPct);
    expect(near.netAnnualPct).toBeLessThan(far.netAnnualPct);
  });

  it("persists whether either leg was marked off a last trade", async () => {
    // The staleness signal. A thin far-dated contract with one side of its book
    // empty marks off an old print, and a stale mark is exactly what produces a
    // spuriously fat basis that then sorts to the top — so the row has to carry
    // the fact, and it cannot be recovered from the prices later.
    const mixed: BasisFetcher = async () =>
      basisSnapshotOf(
        [
          basisQuote("BTC", {
            instrument: "BTC-USD_UM-LIVE",
            expiryTs: clock + 90 * DAY_MS,
            spotPrice: 60_000,
            futurePrice: 61_200,
            priceSource: "mid",
          }),
          basisQuote("ETH", {
            instrument: "ETH-USD_UM-STALE",
            expiryTs: clock + 90 * DAY_MS,
            spotPrice: 3_000,
            futurePrice: 3_090,
            priceSource: "last",
          }),
        ],
        clock,
      );

    await runScan(env, "manual", { now, fetchBasis: mixed });

    const rates = await listLatestBasisRates(env.DB);
    const source = (instrument: string) =>
      rates.find((r) => r.instrument === instrument)!.priceSource;
    expect(source("BTC-USD_UM-LIVE")).toBe("mid");
    expect(source("ETH-USD_UM-STALE")).toBe("last");

    const body = (await (await api("/api/basis")).json()) as {
      summary: { lastMarked: number };
      rates: Array<{ instrument: string; priceSource: string }>;
    };
    expect(body.summary.lastMarked).toBe(1);
    expect(body.rates.find((r) => r.instrument === "ETH-USD_UM-STALE")!.priceSource).toBe(
      "last",
    );
  });

  it("keeps a backwardated contract rather than clamping it away", async () => {
    const backwardated: BasisFetcher = async () =>
      basisSnapshotOf(
        [
          basisQuote("BTC", {
            instrument: "BTC-USD_UM-BACK",
            expiryTs: clock + 90 * DAY_MS,
            spotPrice: 60_000,
            futurePrice: 59_400,
          }),
        ],
        clock,
      );

    const result = await runScan(env, "manual", { now, fetchBasis: backwardated });
    expect(result.basisCount).toBe(1);

    const [row] = await listLatestBasisRates(env.DB);
    expect(row.basisPct).toBeCloseTo(-1, 8);
    expect(row.netAnnualPct).toBeLessThan(0);
  });

  it("persists rows below the display threshold - it is not a write-time gate", async () => {
    await updateSettings(env.DB, { funding_min_annual_pct: 500 });

    const result = await runScan(env, "manual", { now, fetchBasis: board() });

    expect(result.basisCount).toBe(3);
    await expect(basisRows()).resolves.toHaveLength(3);
  });

  it("re-prices when the fee rates change, without touching the prices", async () => {
    // A basis row's drag is amortised over the contract's own life, so doubling
    // the spot fee costs the 90-day row 0.81%/yr and nothing else moves.
    await updateSettings(env.DB, { fee_rate: 0.002 });

    await runScan(env, "manual", { now, fetchBasis: board() });

    const [best] = await listLatestBasisRates(env.DB);
    expect(best.futurePrice).toBe(61_200);
    expect(best.annualizedPct).toBeCloseTo(8.11111111, 6);
    // (0.002 x 2 + 0.0005 x 2) x (365/90) x 100 = 2.02777778%.
    expect(best.netAnnualPct).toBeCloseTo(6.08333333, 6);
  });

  it("records an empty board as zero rows and no error", async () => {
    // OKX serving a perfectly good FUTURES board with nothing linear on it is a
    // real state of the world, and it must not read as an outage.
    const result = await runScan(env, "manual", { now, fetchBasis: serveEmptyBasisBoard() });

    expect(result.basisError).toBeUndefined();
    expect(result.basisCount).toBe(0);
    expect(result.bestBasisNetAnnualPct).toBeNull();
    await expect(basisRows()).resolves.toHaveLength(0);
    // The marker still advanced: the venue answered, so the gate has a baseline.
    await expect(getRawSetting(env.DB, BASIS_POLL_TS_KEY)).resolves.toBe(String(clock));
  });
});

describe("runScan - the basis poll gate", () => {
  it("skips a second scan inside the poll interval", async () => {
    const first = await runScan(env, "manual", { now, fetchBasis: board() });
    expect(first.basisCount).toBe(3);

    clock += POLL_MS - 1;
    let calls = 0;
    const counting: BasisFetcher = async (...args) => {
      calls++;
      return board()(...args);
    };
    const second = await runScan(env, "manual", { now, fetchBasis: counting });

    expect(calls).toBe(0);
    expect(second.basisSkipped).toBe(true);
    expect(second.basisCount).toBe(0);
    expect(second.bestBasisNetAnnualPct).toBeNull();
    expect(second.basisError).toBeUndefined();
    await expect(basisRows()).resolves.toHaveLength(3);
  });

  it("polls again once the interval has elapsed", async () => {
    await runScan(env, "manual", { now, fetchBasis: board() });

    clock += POLL_MS;
    const second = await runScan(env, "manual", { now, fetchBasis: board() });

    expect(second.basisSkipped).toBeUndefined();
    expect(second.basisCount).toBe(3);

    const rows = await basisRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.ts)).size).toBe(2);
    // The newest board is exactly one poll, never a mixture of two.
    await expect(listLatestBasisRates(env.DB)).resolves.toHaveLength(3);
  });

  it("polls on the very first scan, with no baseline to wait out", async () => {
    const result = await runScan(env, "manual", {
      now,
      fetchBasis: board(),
      basisPollIntervalMs: DAY_MS,
    });
    expect(result.basisCount).toBe(3);
  });

  it("leaves the marker alone when the poll failed, so the next scan retries", async () => {
    const dead = await runScan(env, "manual", {
      now,
      fetchBasis: async () => {
        throw new Error("HTTP 451");
      },
    });
    expect(dead.basisError).toContain("HTTP 451");
    await expect(getRawSetting(env.DB, BASIS_POLL_TS_KEY)).resolves.toBeNull();

    clock += 60_000;
    const retry = await runScan(env, "manual", { now, fetchBasis: board() });
    expect(retry.basisSkipped).toBeUndefined();
    expect(retry.basisCount).toBe(3);
  });

  it("keeps its own marker, so the two polls cannot gate each other", async () => {
    // Separate keys, not one shared clock: a funding poll that failed must not
    // drag the basis board's cadence with it, nor the reverse.
    await runScan(env, "manual", {
      now,
      fetchBasis: board(),
      fetchFunding: async () => {
        throw new Error("no funding-rate source available");
      },
    });

    await expect(getRawSetting(env.DB, BASIS_POLL_TS_KEY)).resolves.toBe(String(clock));
    await expect(getRawSetting(env.DB, FUNDING_POLL_TS_KEY)).resolves.toBeNull();
  });
});

describe("runScan - basis isolation", () => {
  it("degrades the basis block alone and never touches scans.error", async () => {
    const result = await runScan(env, "manual", {
      now,
      fetchBasis: async () => {
        throw new Error("HTTP 403");
      },
    });

    expect(result.basisError).toContain("HTTP 403");
    expect(result.basisCount).toBe(0);

    // Everything else completed: the basis block runs last and in a catch of
    // its own precisely so a dead futures endpoint costs nothing but itself.
    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.fundingError).toBeUndefined();
    expect(result.carryError).toBeUndefined();
    expect(result.spreadsCount).toBe(2);
    expect(result.fundingCount).toBe(11);
    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);
  });

  it("polls basis even when funding and both spot venues are down", async () => {
    setWsCollector(async () => {
      throw new Error("websocket upgrade rejected (HTTP 403)");
    });
    setRestFetcher(async () => {
      throw new Error("HTTP 451");
    });

    const result = await runScan(env, "manual", {
      now,
      fetchBasis: board(),
      fetchFunding: async () => {
        throw new Error("no funding-rate source available");
      },
    });

    expect(result.error).toContain("no market-data source available");
    expect(result.fundingError).toContain("no funding-rate source available");
    expect(result.basisError).toBeUndefined();
    expect(result.basisCount).toBe(3);
  });

  it("leaves the lock released after a basis failure", async () => {
    await runScan(env, "manual", {
      now,
      fetchBasis: async () => {
        throw new Error("boom");
      },
    });

    clock += POLL_MS;
    const second = await runScan(env, "manual", { now, fetchBasis: board() });
    expect(second.skipped).toBeUndefined();
    expect(second.basisCount).toBe(3);
  });
});

describe("runScan - basis retention", () => {
  it("prunes rows past the 7-day window as part of the insert batch", async () => {
    const stale = clock - 8 * DAY_MS;
    const recent = clock - 1 * DAY_MS;
    const row = {
      venue: BASIS_VENUE,
      symbol: "BTC",
      instrument: "BTC-USD_UM-OLD",
      expiryTs: clock + 90 * DAY_MS,
      daysToExpiry: 90,
      spotPrice: 60_000,
      futurePrice: 61_200,
      priceSource: "mid",
      basisPct: 2,
      annualizedPct: 8.11111111,
      netAnnualPct: 6.89444444,
    };
    await insertBasisRates(env.DB, null, [row], stale);
    await insertBasisRates(env.DB, null, [row], recent);
    await expect(basisRows()).resolves.toHaveLength(2);

    await runScan(env, "manual", { now, fetchBasis: board() });

    const rows = await basisRows();
    const timestamps = rows.map((r) => r.ts);
    expect(timestamps).not.toContain(stale);
    expect(timestamps).toContain(recent);
    expect(rows).toHaveLength(4);
  });
});

describe("resetAll - basis rows", () => {
  beforeEach(async () => {
    await runScan(env, "manual", { now, fetchBasis: board() });
    await expect(basisRows()).resolves.toHaveLength(3);
  });

  it("clears the board and its marker when history is wiped", async () => {
    await resetAll(env.DB, { wipeHistory: true });
    await expect(basisRows()).resolves.toHaveLength(0);
    await expect(getRawSetting(env.DB, BASIS_POLL_TS_KEY)).resolves.toBeNull();
  });

  it("keeps the board when history is kept", async () => {
    await resetAll(env.DB, { wipeHistory: false });
    await expect(basisRows()).resolves.toHaveLength(3);
  });
});

describe("GET /api/basis", () => {
  it("answers 200 with an empty board before any poll", async () => {
    const res = await api("/api/basis");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ts).toBeNull();
    expect(body.count).toBe(0);
    expect(body.rates).toEqual([]);
    expect(body.stale).toBe(false);
    expect(body.venue).toBe(BASIS_VENUE);
    expect(body.summary).toEqual({
      best: null,
      qualifying: 0,
      contango: 0,
      backwardation: 0,
      symbols: 0,
      lastMarked: 0,
      nearestDays: null,
      furthestDays: null,
    });
  });

  it("serves the newest board, best net first, with qualifies judged now", async () => {
    await runScan(env, "manual", { now, fetchBasis: board() });

    const body = (await (await api("/api/basis")).json()) as {
      ts: number;
      count: number;
      minAnnualPct: number;
      summary: Record<string, unknown>;
      rates: Array<Record<string, unknown>>;
    };

    expect(body.ts).toBe(clock);
    expect(body.count).toBe(3);
    expect(body.minAnnualPct).toBe(5);
    expect(body.rates.map((r) => r.instrument)).toEqual([
      "BTC-USD_UM-M3",
      "ETH-USD_UM-M6",
      "BTC-USD_UM-M1",
    ]);
    // Two of the three clear 5%/yr net; the 30-day row's 3.65% does not.
    expect(body.rates.filter((r) => r.qualifies).map((r) => r.instrument)).toEqual([
      "BTC-USD_UM-M3",
      "ETH-USD_UM-M6",
    ]);

    expect(body.summary.qualifying).toBe(2);
    expect(body.summary.contango).toBe(3);
    expect(body.summary.backwardation).toBe(0);
    expect(body.summary.symbols).toBe(2);
    expect(body.summary.nearestDays).toBe(30);
    expect(body.summary.furthestDays).toBe(180);
    expect((body.summary.best as Record<string, unknown>).instrument).toBe(
      "BTC-USD_UM-M3",
    );
  });

  it("re-judges qualifies against the current threshold, not the stored row", async () => {
    await runScan(env, "manual", { now, fetchBasis: board() });
    await updateSettings(env.DB, { funding_min_annual_pct: 6 });

    const body = (await (await api("/api/basis")).json()) as {
      summary: { qualifying: number };
      rates: Array<{ instrument: string; qualifies: boolean; netAnnualPct: number }>;
    };

    // Only the 90-day row's 6.89% clears a 6% bar now. The stored percentages
    // are untouched — they were priced with the fees in force at poll time —
    // and only the judgement about them moved.
    expect(body.summary.qualifying).toBe(1);
    expect(body.rates.filter((r) => r.qualifies).map((r) => r.instrument)).toEqual([
      "BTC-USD_UM-M3",
    ]);
    expect(body.rates.find((r) => r.instrument === "BTC-USD_UM-M3")!.netAnnualPct)
      .toBeCloseTo(6.89444444, 6);
  });

  it("counts backwardation apart from contango", async () => {
    const mixed: BasisFetcher = async () =>
      basisSnapshotOf(
        [
          basisQuote("BTC", {
            instrument: "BTC-USD_UM-UP",
            expiryTs: clock + 90 * DAY_MS,
            spotPrice: 60_000,
            futurePrice: 61_200,
          }),
          basisQuote("ETH", {
            instrument: "ETH-USD_UM-DOWN",
            expiryTs: clock + 90 * DAY_MS,
            spotPrice: 3_000,
            futurePrice: 2_970,
          }),
        ],
        clock,
      );

    await runScan(env, "manual", { now, fetchBasis: mixed });

    const body = (await (await api("/api/basis")).json()) as {
      summary: { contango: number; backwardation: number };
    };
    expect(body.summary.contango).toBe(1);
    expect(body.summary.backwardation).toBe(1);
  });
});
