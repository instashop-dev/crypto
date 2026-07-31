/**
 * HTTP surface of Phase 4: portfolio, history listings, reset, settings and
 * pair refresh, all against the migrated in-memory D1.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { ASSET_UNIVERSE, BASE_ASSET, DEFAULTS, perpAssets } from "../src/config";
import {
  commitTrade,
  ensureSeeded,
  getBalance,
  getSettings,
  insertFundingRates,
  insertOpportunities,
  insertScan,
  replacePairs,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import { app } from "../src/index";
import type { BookTickerEntry, Env } from "../src/types";

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  setWsCollector(null);
  setFundingFetcher(null);
  fetchMock.assertNoPendingInterceptors();
});

/** 11 assets: the universe minus USDT. */
const PERP_ASSETS = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

/**
 * A stub funding board, so `POST /api/scan` never reaches a perp venue.
 *
 * Rates descend with the asset's position in the universe, giving the ranking
 * an unambiguous winner (BTC) without any test having to name a number twice.
 */
const serveFundingBoard: FundingFetcher = async (assets) => ({
  venue: "bybit",
  ts: Date.now(),
  quotes: new Map(
    assets.map((symbol, i) => [
      symbol,
      {
        venue: "bybit" as const,
        symbol,
        instrument: `${symbol}USDT`,
        rate: 0.0002 - i * 0.00002,
        intervalMinutes: 480,
        intervalSource: "api" as const,
        nextFundingTs: Date.now() + 3_600_000,
        markPrice: 100 + i,
      },
    ]),
  ),
});

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

/** See test/executor.test.ts for the arithmetic behind these numbers. */
const PROFITABLE: Map<string, BookTickerEntry> = new Map(
  Object.entries({
    BTCUSDT: [59990, 60000],
    ETHBTC: [0.0499, 0.05],
    ETHUSDT: [3060, 3061],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

const EXPECTED_PROFIT = 1.694305898;

function stubWs(fn: WsCollector): void {
  setWsCollector(fn);
}

function serveProfitableBook(): void {
  stubWs(async (symbols) => {
    const out = new Map<string, BookTickerEntry>();
    for (const symbol of symbols) {
      const entry = PROFITABLE.get(symbol);
      if (entry) out.set(symbol, entry);
    }
    return out;
  });
}

async function get(path: string): Promise<Response> {
  return app.request(path, undefined, env as unknown as Env);
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    },
    env as unknown as Env,
  );
}

beforeEach(async () => {
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  setFundingFetcher(serveFundingBoard);
});

/** Insert one synthetic trade + opportunity pair at a controlled timestamp. */
async function seedHistory(ts: number, profit: number): Promise<number> {
  const scanId = await insertScan(env.DB, "manual", ts);
  const [opportunityId] = await insertOpportunities(
    env.DB,
    scanId,
    [{ cycle: `USDT>BTC>ETH>USDT#${ts}`, grossPct: profit, netPct: profit, legs: [] }],
    ts,
  );
  await commitTrade(env.DB, {
    scanId,
    opportunityId,
    source: "binance-ws",
    ts,
    trade: {
      cycle: `USDT>BTC>ETH>USDT#${ts}`,
      startAmount: 100,
      endAmount: 100 + profit,
      profit,
      profitPct: profit,
      legs: [],
    },
  });
  return scanId;
}

interface PortfolioTaxBody {
  indiaMode: boolean;
  tdsRate: number;
  taxRate: number;
  grossProfitUsdt: number;
  tdsWithheldUsdt: number;
  taxDueUsdt: number;
  netProfitUsdt: number;
  tdsReceivableUsdt: number;
  taxLiabilityUsdt: number;
  netEquityUsdt: number;
  trades: number;
  profitableTrades: number;
}

interface PortfolioBody {
  balances: Array<{ asset: string; amount: number }>;
  equityUsdt: number;
  pnl: { absUsdt: number; pct: number };
  initialUsdt: number;
  tax: PortfolioTaxBody;
}

describe("GET /api/portfolio", () => {
  it("reports a flat portfolio before any trade", async () => {
    const res = await get("/api/portfolio");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PortfolioBody;
    expect(body.balances).toEqual([{ asset: "USDT", amount: DEFAULTS.initial_usdt }]);
    expect(body.equityUsdt).toBe(DEFAULTS.initial_usdt);
    expect(body.initialUsdt).toBe(DEFAULTS.initial_usdt);
    expect(body.pnl).toEqual({ absUsdt: 0, pct: 0 });
  });

  it("reflects the profit of an executed scan", async () => {
    serveProfitableBook();
    const scanRes = await send("/api/scan", "POST");
    expect(scanRes.status).toBe(200);

    const scan = (await scanRes.json()) as {
      executed: boolean;
      tradeId?: number;
      scanId: number;
      opportunities: Array<{ cycle: string; executed: boolean }>;
    };
    expect(scan.executed).toBe(true);
    expect(scan.tradeId).toBeTypeOf("number");
    expect(scan.opportunities).toHaveLength(2);
    expect(scan.opportunities[0].cycle).toBe("USDT>BTC>ETH>USDT");
    expect(scan.opportunities[0].executed).toBe(true);

    const body = (await (await get("/api/portfolio")).json()) as PortfolioBody;
    expect(body.equityUsdt).toBeCloseTo(DEFAULTS.initial_usdt + EXPECTED_PROFIT, 6);
    expect(body.pnl.absUsdt).toBeCloseTo(EXPECTED_PROFIT, 6);
    expect(body.pnl.pct).toBeCloseTo((EXPECTED_PROFIT / DEFAULTS.initial_usdt) * 100, 8);
  });
});

describe("history listings", () => {
  beforeEach(async () => {
    // Ascending timestamps so "newest first" is unambiguous.
    for (let i = 0; i < 5; i++) await seedHistory(1_000 + i, i + 1);
  });

  it("returns trades newest first and honours ?limit", async () => {
    const body = (await (await get("/api/trades?limit=2")).json()) as {
      count: number;
      limit: number;
      trades: Array<{ ts: number; profit: number; legs: unknown[] }>;
    };

    expect(body.limit).toBe(2);
    expect(body.count).toBe(2);
    expect(body.trades.map((t) => t.ts)).toEqual([1_004, 1_003]);
    expect(Array.isArray(body.trades[0].legs)).toBe(true);
  });

  it("returns opportunities newest first with legs parsed", async () => {
    const body = (await (await get("/api/opportunities?limit=3")).json()) as {
      count: number;
      opportunities: Array<{ ts: number; executed: boolean; legs: unknown[] }>;
    };

    expect(body.count).toBe(3);
    expect(body.opportunities.map((o) => o.ts)).toEqual([1_004, 1_003, 1_002]);
    expect(body.opportunities[0].executed).toBe(true);
    expect(body.opportunities[0].legs).toEqual([]);
  });

  it("returns scans newest first", async () => {
    const body = (await (await get("/api/scans")).json()) as {
      count: number;
      limit: number;
      scans: Array<{ ts: number; executed_count: number }>;
    };

    expect(body.limit).toBe(20);
    expect(body.count).toBe(5);
    expect(body.scans.map((s) => s.ts)).toEqual([1_004, 1_003, 1_002, 1_001, 1_000]);
    expect(body.scans.every((s) => s.executed_count === 1)).toBe(true);
  });

  it("clamps an over-large limit to the per-collection maximum", async () => {
    const trades = (await (await get("/api/trades?limit=9999")).json()) as {
      limit: number;
    };
    expect(trades.limit).toBe(200);

    const scans = (await (await get("/api/scans?limit=9999")).json()) as { limit: number };
    expect(scans.limit).toBe(100);
  });

  it("falls back to the default limit for a junk value", async () => {
    const body = (await (await get("/api/opportunities?limit=abc")).json()) as {
      limit: number;
    };
    expect(body.limit).toBe(50);
  });
});

describe("POST /api/reset", () => {
  beforeEach(async () => {
    await seedHistory(2_000, 5);
  });

  it("wipes history by default", async () => {
    const res = await send("/api/reset", "POST");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PortfolioBody & { wipeHistory: boolean };
    expect(body.wipeHistory).toBe(true);
    expect(body.equityUsdt).toBe(DEFAULTS.initial_usdt);
    expect(body.pnl.absUsdt).toBe(0);

    for (const path of ["/api/trades", "/api/opportunities", "/api/scans"]) {
      const listing = (await (await get(path)).json()) as { count: number };
      expect(listing.count, path).toBe(0);
    }
  });

  it("restores the balance but keeps history when wipeHistory is false", async () => {
    const res = await send("/api/reset", "POST", { wipeHistory: false });
    const body = (await res.json()) as PortfolioBody & { wipeHistory: boolean };

    expect(body.wipeHistory).toBe(false);
    expect(body.equityUsdt).toBe(DEFAULTS.initial_usdt);

    const trades = (await (await get("/api/trades")).json()) as { count: number };
    expect(trades.count).toBe(1);
    const scans = (await (await get("/api/scans")).json()) as { count: number };
    expect(scans.count).toBe(1);
  });

  it("rejects a non-boolean wipeHistory", async () => {
    const res = await send("/api/reset", "POST", { wipeHistory: "yes" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "wipeHistory must be a boolean" });
  });

  it("keeps tuned settings across a reset", async () => {
    await send("/api/settings", "PUT", { min_profit_pct: -0.5 });
    await send("/api/reset", "POST");

    const settings = (await (await get("/api/settings")).json()) as {
      min_profit_pct: number;
    };
    expect(settings.min_profit_pct).toBe(-0.5);
  });
});

describe("GET|PUT /api/settings", () => {
  it("returns the seeded defaults", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...DEFAULTS });
  });

  it("accepts a negative min_profit_pct (demo mode)", async () => {
    const res = await send("/api/settings", "PUT", { min_profit_pct: -0.25 });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { min_profit_pct: number; fee_rate: number };
    expect(body.min_profit_pct).toBe(-0.25);
    expect(body.fee_rate).toBe(DEFAULTS.fee_rate);
    await expect(getSettings(env.DB)).resolves.toMatchObject({ min_profit_pct: -0.25 });
  });

  it("accepts a valid fee_rate and trade size together", async () => {
    const res = await send("/api/settings", "PUT", {
      fee_rate: 0.002,
      trade_size_usdt: 250,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      fee_rate: 0.002,
      trade_size_usdt: 250,
    });
  });

  it("rejects an out-of-range fee_rate", async () => {
    const res = await send("/api/settings", "PUT", { fee_rate: 0.5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("fee_rate");
    // Nothing was persisted.
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      fee_rate: DEFAULTS.fee_rate,
    });
  });

  it("rejects a negative fee_rate and a non-positive trade size", async () => {
    await expect(
      send("/api/settings", "PUT", { fee_rate: -0.001 }).then((r) => r.status),
    ).resolves.toBe(400);
    await expect(
      send("/api/settings", "PUT", { trade_size_usdt: 0 }).then((r) => r.status),
    ).resolves.toBe(400);
  });

  it("rejects unknown keys with 400", async () => {
    const res = await send("/api/settings", "PUT", { min_profit: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("min_profit");
  });

  it("rejects initial_usdt, which is the P&L baseline rather than a tunable", async () => {
    const res = await send("/api/settings", "PUT", { initial_usdt: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const res = await send("/api/settings", "PUT", {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "no settings supplied" });
  });

  it("rejects a non-numeric value", async () => {
    const res = await send("/api/settings", "PUT", { trade_size_usdt: "100" });
    expect(res.status).toBe(400);
  });

  it("applies a changed trade size to the next scan", async () => {
    await send("/api/settings", "PUT", { trade_size_usdt: 200 });
    serveProfitableBook();

    await send("/api/scan", "POST");

    const body = (await (await get("/api/trades")).json()) as {
      trades: Array<{ startAmount: number; profit: number }>;
    };
    expect(body.trades[0].startAmount).toBe(200);
    expect(body.trades[0].profit).toBeCloseTo(EXPECTED_PROFIT * 2, 6);
    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + EXPECTED_PROFIT * 2,
      6,
    );
  });
});

// ---------------------------------------------------------------------------
// India mode over HTTP
// ---------------------------------------------------------------------------
//
// Figures derived in test/tax.test.ts; on the PROFITABLE book at 100 USDT:
//   gross +1.6943059  tds 3.01679452  tax 0.50829177  net 1.18601413
const TDS_WITHHELD = 3.01679452;
const TAX_DUE = 0.50829177;
const NET_PROFIT = 1.18601413;

async function portfolio(): Promise<PortfolioBody> {
  return (await (await get("/api/portfolio")).json()) as PortfolioBody;
}

describe("PUT /api/settings - india mode", () => {
  it("exposes the three new tunables among the seeded defaults", async () => {
    const body = (await (await get("/api/settings")).json()) as Record<string, number>;
    expect(body).toEqual({ ...DEFAULTS });
    expect(body.india_mode).toBe(0);
    expect(body.tds_rate).toBe(0.01);
    expect(body.tax_rate).toBe(0.3);
  });

  it("accepts india_mode 1 and india_mode 0", async () => {
    const on = await send("/api/settings", "PUT", { india_mode: 1 });
    expect(on.status).toBe(200);
    await expect(on.json()).resolves.toMatchObject({ india_mode: 1 });

    const off = await send("/api/settings", "PUT", { india_mode: 0 });
    expect(off.status).toBe(200);
    await expect(getSettings(env.DB)).resolves.toMatchObject({ india_mode: 0 });
  });

  it("rejects an india_mode that is not exactly 0 or 1", async () => {
    for (const value of [2, 0.5, -1]) {
      const res = await send("/api/settings", "PUT", { india_mode: value });
      expect(res.status, String(value)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("india_mode must be 0 or 1");
    }
    // Nothing was persisted by any of the rejected attempts.
    await expect(getSettings(env.DB)).resolves.toMatchObject({ india_mode: 0 });
  });

  it("clamps tds_rate to [0, 0.05]", async () => {
    await expect(
      send("/api/settings", "PUT", { tds_rate: 0.06 }).then((r) => r.status),
    ).resolves.toBe(400);
    await expect(
      send("/api/settings", "PUT", { tds_rate: -0.001 }).then((r) => r.status),
    ).resolves.toBe(400);
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      tds_rate: DEFAULTS.tds_rate,
    });

    const ok = await send("/api/settings", "PUT", { tds_rate: 0.05 });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ tds_rate: 0.05 });
  });

  it("clamps tax_rate to [0, 0.5] and allows the cess-inclusive 31.2%", async () => {
    const tooHigh = await send("/api/settings", "PUT", { tax_rate: 0.6 });
    expect(tooHigh.status).toBe(400);
    const body = (await tooHigh.json()) as { error: string };
    expect(body.error).toContain("tax_rate");

    const cess = await send("/api/settings", "PUT", { tax_rate: 0.312 });
    expect(cess.status).toBe(200);
    await expect(cess.json()).resolves.toMatchObject({ tax_rate: 0.312 });
  });
});

describe("GET /api/portfolio - tax block", () => {
  it("reports an inert tax block on a fresh portfolio", async () => {
    const body = await portfolio();

    expect(body.tax.indiaMode).toBe(false);
    expect(body.tax.tdsRate).toBe(DEFAULTS.tds_rate);
    expect(body.tax.taxRate).toBe(DEFAULTS.tax_rate);
    expect(body.tax.grossProfitUsdt).toBe(0);
    expect(body.tax.tdsWithheldUsdt).toBe(0);
    expect(body.tax.taxDueUsdt).toBe(0);
    expect(body.tax.netProfitUsdt).toBe(0);
    expect(body.tax.trades).toBe(0);
    expect(body.tax.profitableTrades).toBe(0);

    // With nothing withheld and nothing owed, net equity is just equity.
    expect(body.tax.netEquityUsdt).toBe(body.equityUsdt);
    // The pre-Phase-8 fields keep their exact meaning.
    expect(body.equityUsdt).toBe(DEFAULTS.initial_usdt);
    expect(body.pnl).toEqual({ absUsdt: 0, pct: 0 });
  });

  it("reports the worked figures after an india-mode scan", async () => {
    await send("/api/settings", "PUT", { india_mode: 1 });
    serveProfitableBook();
    await send("/api/scan", "POST");

    const body = await portfolio();

    expect(body.tax.indiaMode).toBe(true);
    expect(body.tax.trades).toBe(1);
    expect(body.tax.profitableTrades).toBe(1);
    expect(body.tax.grossProfitUsdt).toBeCloseTo(EXPECTED_PROFIT, 6);
    expect(body.tax.tdsWithheldUsdt).toBeCloseTo(TDS_WITHHELD, 8);
    expect(body.tax.taxDueUsdt).toBeCloseTo(TAX_DUE, 8);
    expect(body.tax.netProfitUsdt).toBeCloseTo(NET_PROFIT, 8);

    // Cash-flow names and balance-sheet names for the same two figures.
    expect(body.tax.tdsReceivableUsdt).toBe(body.tax.tdsWithheldUsdt);
    expect(body.tax.taxLiabilityUsdt).toBe(body.tax.taxDueUsdt);

    // Equity is the cash view: TDS already gone, so a winning cycle is down.
    expect(body.equityUsdt).toBeCloseTo(
      DEFAULTS.initial_usdt + EXPECTED_PROFIT - TDS_WITHHELD,
      8,
    );
    expect(body.pnl.absUsdt).toBeLessThan(0);

    // Net equity settles the receivable against the liability.
    expect(body.tax.netEquityUsdt).toBeCloseTo(
      body.equityUsdt + body.tax.tdsWithheldUsdt - body.tax.taxDueUsdt,
      8,
    );
    expect(body.tax.netEquityUsdt).toBeCloseTo(
      DEFAULTS.initial_usdt + NET_PROFIT,
      8,
    );
  });

  it("zeroes the tax totals on reset", async () => {
    await send("/api/settings", "PUT", { india_mode: 1 });
    serveProfitableBook();
    await send("/api/scan", "POST");
    expect((await portfolio()).tax.tdsWithheldUsdt).toBeGreaterThan(0);

    const res = await send("/api/reset", "POST");
    const body = (await res.json()) as PortfolioBody;

    expect(body.tax.trades).toBe(0);
    expect(body.tax.tdsWithheldUsdt).toBe(0);
    expect(body.tax.taxDueUsdt).toBe(0);
    expect(body.tax.netProfitUsdt).toBe(0);
    expect(body.tax.netEquityUsdt).toBe(DEFAULTS.initial_usdt);
    // The mode itself is a setting, and settings survive a reset.
    expect(body.tax.indiaMode).toBe(true);
  });
});

describe("history listings - tax fields", () => {
  it("exposes the tax columns on trades, falling back for untaxed rows", async () => {
    await send("/api/settings", "PUT", { india_mode: 1 });
    serveProfitableBook();
    await send("/api/scan", "POST");
    // An insert that carries no tax at all, as every pre-Phase-8 row does.
    await seedHistory(3_000, 5);

    const body = (await (await get("/api/trades")).json()) as {
      trades: Array<{
        ts: number;
        profit: number;
        netProfit: number;
        netProfitPct: number;
        tdsBase: number;
        tdsWithheld: number;
        taxDue: number;
        tdsRate: number;
        taxRate: number;
      }>;
    };
    expect(body.trades).toHaveLength(2);

    const untaxed = body.trades.find((t) => t.ts === 3_000)!;
    expect(untaxed).toBeDefined();
    expect(untaxed.tdsWithheld).toBe(0);
    expect(untaxed.taxDue).toBe(0);
    expect(untaxed.tdsRate).toBe(0);
    expect(untaxed.netProfit).toBe(untaxed.profit);

    const taxed = body.trades.find((t) => t.ts !== 3_000)!;
    expect(taxed.tdsWithheld).toBeCloseTo(TDS_WITHHELD, 8);
    expect(taxed.taxDue).toBeCloseTo(TAX_DUE, 8);
    expect(taxed.netProfit).toBeCloseTo(NET_PROFIT, 8);
    expect(taxed.netProfitPct).toBeCloseTo(NET_PROFIT, 8); // 100 USDT notional
    expect(taxed.tdsRate).toBe(0.01);
    expect(taxed.taxRate).toBe(0.3);
    expect(taxed.tdsBase).toBeCloseTo(301.679452, 6);
  });

  it("exposes indiaNetPct/tdsPct on opportunities, null when the mode is off", async () => {
    // Written with the mode off.
    await seedHistory(4_000, 5);
    serveProfitableBook();
    await send("/api/scan", "POST");

    const off = (await (await get("/api/opportunities")).json()) as {
      opportunities: Array<{
        cycle: string;
        indiaNetPct: number | null;
        tdsPct: number | null;
      }>;
    };
    expect(off.opportunities.every((o) => o.indiaNetPct === null)).toBe(true);
    expect(off.opportunities.every((o) => o.tdsPct === null)).toBe(true);

    await send("/api/settings", "PUT", { india_mode: 1 });
    serveProfitableBook();
    await send("/api/scan", "POST");

    const on = (await (await get("/api/opportunities")).json()) as {
      opportunities: Array<{
        cycle: string;
        netPct: number;
        indiaNetPct: number | null;
        tdsPct: number | null;
      }>;
    };
    const best = on.opportunities.find((o) => o.cycle === "USDT>BTC>ETH>USDT");
    expect(best).toBeDefined();
    expect(best!.indiaNetPct).toBeCloseTo(best!.netPct * 0.7, 8);
    expect(best!.tdsPct).toBeCloseTo(3.01679452, 8);
  });
});

describe("POST /api/scan - tax block", () => {
  it("carries the tax figures when india mode is on and omits them when off", async () => {
    serveProfitableBook();
    const plain = (await (await send("/api/scan", "POST")).json()) as {
      executed: boolean;
      tax?: unknown;
    };
    expect(plain.executed).toBe(true);
    expect(plain.tax).toBeUndefined();

    await send("/api/settings", "PUT", { india_mode: 1 });
    serveProfitableBook();
    const taxed = (await (await send("/api/scan", "POST")).json()) as {
      executed: boolean;
      tax?: { tdsWithheld: number; taxDue: number; netProfit: number };
    };
    expect(taxed.executed).toBe(true);
    expect(taxed.tax).toEqual({
      tdsWithheld: TDS_WITHHELD,
      taxDue: TAX_DUE,
      netProfit: NET_PROFIT,
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-exchange over HTTP
// ---------------------------------------------------------------------------

/** One synthetic cross-exchange opportunity + trade, at a controlled timestamp. */
async function seedSpreadHistory(ts: number, profit: number): Promise<number> {
  const scanId = await insertScan(env.DB, "manual", ts);
  const cycle = `BTCUSDT binance-ws>mexc-rest#${ts}`;
  const [opportunityId] = await insertOpportunities(
    env.DB,
    scanId,
    [{ cycle, grossPct: profit, netPct: profit, legs: [] }],
    ts,
    "cross_exchange",
  );
  await commitTrade(env.DB, {
    scanId,
    opportunityId,
    source: "binance-ws+mexc-rest",
    ts,
    strategy: "cross_exchange",
    trade: {
      cycle,
      startAmount: 100,
      endAmount: 100 + profit,
      profit,
      profitPct: profit,
      legs: [],
    },
  });
  return scanId;
}

describe("history listings - ?strategy filter", () => {
  beforeEach(async () => {
    await seedHistory(5_000, 1);
    await seedSpreadHistory(5_001, 2);
    await seedHistory(5_002, 3);
  });

  it("tags every row with the strategy that produced it", async () => {
    const opps = (await (await get("/api/opportunities")).json()) as {
      strategy: string | null;
      opportunities: Array<{ ts: number; strategy: string }>;
    };

    // No filter asked for, so the response says so and returns everything.
    expect(opps.strategy).toBeNull();
    expect(opps.opportunities.map((o) => o.strategy)).toEqual([
      "triangular",
      "cross_exchange",
      "triangular",
    ]);

    const trades = (await (await get("/api/trades")).json()) as {
      trades: Array<{ strategy: string; source: string | null }>;
    };
    expect(trades.trades.map((t) => t.strategy)).toEqual([
      "triangular",
      "cross_exchange",
      "triangular",
    ]);
    // A spread records both venues in `source`, not one of them.
    expect(trades.trades[1].source).toBe("binance-ws+mexc-rest");
  });

  it("narrows both listings to one strategy", async () => {
    for (const path of ["opportunities", "trades"]) {
      const body = (await (
        await get(`/api/${path}?strategy=cross_exchange`)
      ).json()) as {
        count: number;
        strategy: string;
        opportunities?: Array<{ ts: number; strategy: string }>;
        trades?: Array<{ ts: number; strategy: string }>;
      };
      const rows = body.opportunities ?? body.trades ?? [];

      expect(body.count, path).toBe(1);
      expect(body.strategy, path).toBe("cross_exchange");
      expect(rows.map((r) => r.ts), path).toEqual([5_001]);
      expect(rows.every((r) => r.strategy === "cross_exchange"), path).toBe(true);
    }

    const tri = (await (await get("/api/trades?strategy=triangular")).json()) as {
      count: number;
      trades: Array<{ ts: number }>;
    };
    expect(tri.count).toBe(2);
    expect(tri.trades.map((t) => t.ts)).toEqual([5_002, 5_000]);
  });

  it("applies the filter in SQL, so ?limit still means N of that strategy", async () => {
    const body = (await (
      await get("/api/trades?strategy=triangular&limit=1")
    ).json()) as { count: number; trades: Array<{ ts: number }> };

    // Newest overall is the spread at 5_001; asking for one triangle must not
    // return zero rows because the newest row happened to be filtered out.
    expect(body.count).toBe(1);
    expect(body.trades[0].ts).toBe(5_002);
  });

  it("rejects an unknown strategy with 400 rather than silently ignoring it", async () => {
    for (const path of ["/api/opportunities", "/api/trades"]) {
      const res = await get(`${path}?strategy=crossexchange`);
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, path).toContain("unknown strategy");
      expect(body.error, path).toContain("crossexchange");
    }

    // A misspelling that returns everything would look exactly like a strategy
    // that never fires, which is the failure mode this rules out.
    const empty = await get("/api/trades?strategy=");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ count: 3, strategy: null });
  });
});

describe("PUT /api/settings - cross-exchange", () => {
  it("exposes the two new tunables among the seeded defaults", async () => {
    const body = (await (await get("/api/settings")).json()) as Record<string, number>;

    expect(body).toEqual({ ...DEFAULTS });
    expect(body.xchg_min_profit_pct).toBe(0.05);
    expect(body.xchg_enabled).toBe(1);
  });

  it("accepts any finite xchg_min_profit_pct, negatives included", async () => {
    for (const value of [-0.25, 0, 2.5]) {
      const res = await send("/api/settings", "PUT", { xchg_min_profit_pct: value });
      expect(res.status, String(value)).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ xchg_min_profit_pct: value });
    }
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      xchg_min_profit_pct: 2.5,
    });

    const junk = await send("/api/settings", "PUT", { xchg_min_profit_pct: "0.1" });
    expect(junk.status).toBe(400);
  });

  it("accepts xchg_enabled 0 and 1 and rejects anything else", async () => {
    const off = await send("/api/settings", "PUT", { xchg_enabled: 0 });
    expect(off.status).toBe(200);
    await expect(getSettings(env.DB)).resolves.toMatchObject({ xchg_enabled: 0 });

    for (const value of [2, 0.5, -1]) {
      const res = await send("/api/settings", "PUT", { xchg_enabled: value });
      expect(res.status, String(value)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("xchg_enabled must be 0 or 1");
    }
    // Nothing was persisted by any of the rejected attempts.
    await expect(getSettings(env.DB)).resolves.toMatchObject({ xchg_enabled: 0 });

    const on = await send("/api/settings", "PUT", { xchg_enabled: 1 });
    expect(on.status).toBe(200);
    await expect(on.json()).resolves.toMatchObject({ xchg_enabled: 1 });
  });
});

describe("POST /api/scan - cross-exchange block", () => {
  it("reports the spread figures alongside the triangular ones", async () => {
    // No MEXC venue is reachable here (nothing is intercepted), so the spread
    // scanner degrades: the response still carries its fields, the scan itself
    // still succeeds, and `error` stays clean.
    serveProfitableBook();
    const body = (await (await send("/api/scan", "POST")).json()) as {
      executed: boolean;
      error?: string;
      spreadsCount: number;
      bestSpreadNetPct: number | null;
      xchgExecuted: boolean;
      xchgError?: string;
      opportunities: Array<{ strategy: string }>;
    };

    expect(body.error).toBeUndefined();
    expect(body.executed).toBe(true);
    expect(body.spreadsCount).toBe(0);
    expect(body.bestSpreadNetPct).toBeNull();
    expect(body.xchgExecuted).toBe(false);
    expect(body.xchgError).toContain("mexc-rest");
    expect(body.opportunities.every((o) => o.strategy === "triangular")).toBe(true);
  });

  it("exposes the new scan columns in the listing", async () => {
    serveProfitableBook();
    await send("/api/scan", "POST");

    const body = (await (await get("/api/scans")).json()) as {
      scans: Array<{
        spreads_count: number;
        best_spread_net_pct: number | null;
        xchg_error: string | null;
        error: string | null;
      }>;
    };
    const [scan] = body.scans;
    expect(scan.spreads_count).toBe(0);
    expect(scan.best_spread_net_pct).toBeNull();
    // A missing second venue is recorded, but it is not a scan failure.
    expect(scan.xchg_error).toContain("mexc-rest");
    expect(scan.error).toBeNull();
  });
});

describe("POST /api/admin/refresh-pairs", () => {
  it("rebuilds the pair cache from MEXC", async () => {
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(200, [
        { symbol: "BTCUSDT", bidPrice: "59990", askPrice: "60000" },
        { symbol: "ETHUSDT", bidPrice: "3060", askPrice: "3061" },
        { symbol: "ETHBTC", bidPrice: "0.0499", askPrice: "0.05" },
        { symbol: "SOLUSDT", bidPrice: "140", askPrice: "141" },
        { symbol: "SOMETHINGELSE", bidPrice: "1", askPrice: "2" },
      ]);

    const res = await send("/api/admin/refresh-pairs", "POST");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 4, source: "mexc-rest" });

    const pairs = (await (await get("/api/pairs")).json()) as {
      count: number;
      pairs: Array<{ symbol: string; base: string; quote: string; source: string }>;
    };
    expect(pairs.count).toBe(4);
    expect(pairs.pairs.map((p) => p.symbol)).toEqual([
      "BTCUSDT",
      "ETHBTC",
      "ETHUSDT",
      "SOLUSDT",
    ]);
    expect(pairs.pairs[1]).toMatchObject({ base: "ETH", quote: "BTC", source: "mexc-rest" });
  });

  it("returns 502 and leaves the cache intact when MEXC is unreachable", async () => {
    fetchMock
      .get(MEXC_BASE)
      .intercept({ path: BOOK_TICKER_PATH, method: "GET" })
      .reply(451, "restricted");

    const res = await send("/api/admin/refresh-pairs", "POST");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("451");

    const pairs = (await (await get("/api/pairs")).json()) as { count: number };
    expect(pairs.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Funding rates over HTTP
// ---------------------------------------------------------------------------

interface FundingRateBody {
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
  qualifies: boolean;
}

interface FundingBody {
  ts: number | null;
  ageMs: number | null;
  stale: boolean;
  venue: string | null;
  count: number;
  minAnnualPct: number;
  holdDays: number;
  feeRate: number;
  pollIntervalMs: number;
  rates: FundingRateBody[];
}

/** One synthetic funding row at a controlled timestamp. */
function fundingRow(symbol: string, netAnnualPct: number) {
  return {
    venue: "bybit",
    symbol,
    instrument: `${symbol}USDT`,
    rate: 0.0001,
    intervalMinutes: 480,
    intervalSource: "api",
    annualizedPct: netAnnualPct + 4.86666667,
    netAnnualPct,
    nextFundingTs: null,
    markPrice: null,
  };
}

async function funding(): Promise<FundingBody> {
  return (await (await get("/api/funding")).json()) as FundingBody;
}

async function fundingRowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM funding_rates").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("GET /api/funding", () => {
  it("answers 200 with an empty board before the first poll", async () => {
    const res = await get("/api/funding");
    expect(res.status).toBe(200);

    const body = (await res.json()) as FundingBody;
    // "No board yet" is the state of every deployment for its first few
    // seconds, not a 404.
    expect(body.ts).toBeNull();
    expect(body.count).toBe(0);
    expect(body.rates).toEqual([]);
    expect(body.venue).toBeNull();
    expect(body.stale).toBe(false);
    // The settings echo is present either way, so the panel can render its
    // header before any row exists.
    expect(body.minAnnualPct).toBe(DEFAULTS.funding_min_annual_pct);
    expect(body.holdDays).toBe(DEFAULTS.funding_hold_days);
    expect(body.feeRate).toBe(DEFAULTS.fee_rate);
  });

  it("returns the newest board, best net carry first", async () => {
    serveProfitableBook();
    await send("/api/scan", "POST");

    const body = await funding();
    expect(body.count).toBe(11);
    expect(body.venue).toBe("bybit");
    expect(body.rates).toHaveLength(11);
    expect(body.rates[0].symbol).toBe("BTC");
    expect(body.rates[0].instrument).toBe("BTCUSDT");
    expect(body.rates[0].annualizedPct).toBeCloseTo(21.9, 6);
    expect(body.rates[0].netAnnualPct).toBeCloseTo(17.03333333, 6);

    for (let i = 1; i < body.rates.length; i++) {
      expect(body.rates[i].netAnnualPct).toBeLessThanOrEqual(
        body.rates[i - 1].netAnnualPct,
      );
    }
    expect(body.rates.map((r) => r.symbol).sort()).toEqual([...PERP_ASSETS].sort());
    expect(body.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.stale).toBe(false);
  });

  it("recomputes qualifies against the current threshold, not the stored one", async () => {
    serveProfitableBook();
    await send("/api/scan", "POST");

    const before = await funding();
    expect(before.minAnnualPct).toBe(5);
    const qualifying = before.rates.filter((r) => r.qualifies);
    expect(qualifying.length).toBeGreaterThan(0);
    expect(qualifying.every((r) => r.netAnnualPct >= 5)).toBe(true);

    // Raising the bar must re-classify rows already on disk: qualifying is a
    // judgement about a measurement, not part of it.
    await send("/api/settings", "PUT", { funding_min_annual_pct: 1000 });
    const after = await funding();
    expect(after.minAnnualPct).toBe(1000);
    expect(after.rates.every((r) => !r.qualifies)).toBe(true);
    // The stored percentages themselves did not move.
    expect(after.rates[0].netAnnualPct).toBe(before.rates[0].netAnnualPct);

    await send("/api/settings", "PUT", { funding_min_annual_pct: -1000 });
    expect((await funding()).rates.every((r) => r.qualifies)).toBe(true);
  });

  it("flags a board older than two poll intervals as stale", async () => {
    const fresh = Date.now();
    await insertFundingRates(env.DB, null, [fundingRow("BTC", 6)], fresh);
    expect((await funding()).stale).toBe(false);

    await env.DB.prepare("DELETE FROM funding_rates").run();
    // Just past 2 x 5 minutes: one missed poll is jitter, two is a signal.
    await insertFundingRates(
      env.DB,
      null,
      [fundingRow("BTC", 6)],
      Date.now() - (2 * 300_000 + 1000),
    );

    const stale = await funding();
    expect(stale.stale).toBe(true);
    expect(stale.ageMs).toBeGreaterThan(600_000);
    expect(stale.count).toBe(1);
  });

  it("reads exactly one poll, never a mixture of two", async () => {
    const older = Date.now() - 600_000;
    await insertFundingRates(
      env.DB,
      null,
      [fundingRow("BTC", 6), fundingRow("ETH", 5)],
      older,
    );
    await insertFundingRates(env.DB, null, [fundingRow("BTC", 9)], Date.now());

    const body = await funding();
    expect(body.count).toBe(1);
    expect(body.rates[0].netAnnualPct).toBe(9);
  });
});

describe("GET /api/funding/history", () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) {
      await insertFundingRates(env.DB, null, [fundingRow("BTC", i)], 6_000 + i);
    }
    await insertFundingRates(env.DB, null, [fundingRow("ETH", 42)], 6_010);
  });

  it("returns one symbol's series, newest first", async () => {
    const body = (await (await get("/api/funding/history?symbol=BTC")).json()) as {
      symbol: string;
      count: number;
      limit: number;
      rates: FundingRateBody[];
    };

    expect(body.symbol).toBe("BTC");
    expect(body.count).toBe(3);
    expect(body.limit).toBe(100);
    expect(body.rates.map((r) => r.ts)).toEqual([6_002, 6_001, 6_000]);
    expect(body.rates.every((r) => r.symbol === "BTC")).toBe(true);
  });

  it("clamps the limit and upper-cases the symbol", async () => {
    const clamped = (await (
      await get("/api/funding/history?symbol=btc&limit=9999")
    ).json()) as { symbol: string; limit: number; count: number };
    expect(clamped.limit).toBe(500);
    expect(clamped.symbol).toBe("BTC");
    expect(clamped.count).toBe(3);

    const one = (await (
      await get("/api/funding/history?symbol=BTC&limit=1")
    ).json()) as { count: number; rates: FundingRateBody[] };
    expect(one.count).toBe(1);
    expect(one.rates[0].ts).toBe(6_002);
  });

  it("returns an empty series for a symbol nobody ever quoted", async () => {
    const body = (await (await get("/api/funding/history?symbol=NOPE")).json()) as {
      count: number;
      rates: unknown[];
    };
    expect(body.count).toBe(0);
    expect(body.rates).toEqual([]);
  });

  it("rejects a missing symbol rather than guessing one", async () => {
    const res = await get("/api/funding/history");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "symbol is required" });
  });
});

describe("POST /api/funding/refresh", () => {
  it("polls unconditionally and writes rows that belong to no scan", async () => {
    const res = await send("/api/funding/refresh", "POST");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { count: number; venue: string; ts: number };
    expect(body.count).toBe(11);
    expect(body.venue).toBe("bybit");
    expect(typeof body.ts).toBe("number");

    const { results } = await env.DB.prepare(
      "SELECT scan_id FROM funding_rates",
    ).all<{ scan_id: number | null }>();
    // Minting a scans row for this would put a scan in the history that never
    // looked at a single market.
    expect(results).toHaveLength(11);
    expect((results ?? []).every((r) => r.scan_id === null)).toBe(true);
    await expect(
      get("/api/scans").then((r) => r.json()),
    ).resolves.toMatchObject({ count: 0 });

    expect((await funding()).count).toBe(11);
  });

  it("bypasses the poll gate that throttles the scan path", async () => {
    await send("/api/funding/refresh", "POST");
    const again = await send("/api/funding/refresh", "POST");
    expect(again.status).toBe(200);
    // Two unconditional polls, and the retention delete never removed the
    // first: both are inside the 7-day window.
    expect(await fundingRowCount()).toBeGreaterThanOrEqual(11);
  });

  it("answers 502 when neither venue is reachable", async () => {
    setFundingFetcher(async () => {
      throw new Error(
        "no funding-rate source available (bybit: HTTP 403; okx: HTTP 429)",
      );
    });

    const res = await send("/api/funding/refresh", "POST");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no funding-rate source available");
    expect(body.error).toContain("bybit");
    await expect(fundingRowCount()).resolves.toBe(0);
  });
});

describe("PUT /api/settings - funding", () => {
  it("exposes the two new tunables among the seeded defaults", async () => {
    const body = (await (await get("/api/settings")).json()) as Record<string, number>;

    expect(body).toEqual({ ...DEFAULTS });
    expect(body.funding_min_annual_pct).toBe(5);
    expect(body.funding_hold_days).toBe(30);
  });

  it("accepts any finite funding_min_annual_pct, negatives included", async () => {
    for (const value of [12, 0, -3.5]) {
      const res = await send("/api/settings", "PUT", { funding_min_annual_pct: value });
      expect(res.status, String(value)).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        funding_min_annual_pct: value,
      });
    }

    const junk = await send("/api/settings", "PUT", { funding_min_annual_pct: "12" });
    expect(junk.status).toBe(400);
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      funding_min_annual_pct: -3.5,
    });
  });

  it("clamps funding_hold_days to (0, 3650]", async () => {
    for (const value of [0, -1, 3651]) {
      const res = await send("/api/settings", "PUT", { funding_hold_days: value });
      expect(res.status, String(value)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("funding_hold_days");
    }
    // Nothing was persisted by any of the rejected attempts.
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      funding_hold_days: DEFAULTS.funding_hold_days,
    });

    for (const value of [1, 90, 3650]) {
      const ok = await send("/api/settings", "PUT", { funding_hold_days: value });
      expect(ok.status, String(value)).toBe(200);
      await expect(ok.json()).resolves.toMatchObject({ funding_hold_days: value });
    }
  });

  it("rejects a misspelled funding key rather than ignoring it", async () => {
    const res = await send("/api/settings", "PUT", { funding_min_annual: 12 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("funding_min_annual");
  });
});

describe("POST /api/scan - funding block", () => {
  it("carries the funding figures alongside the arbitrage ones", async () => {
    serveProfitableBook();
    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      executed: boolean;
      fundingVenue: string | null;
      fundingCount: number;
      bestFundingNetAnnualPct: number | null;
      fundingError?: string;
      fundingSkipped?: boolean;
    };

    expect(body.error).toBeUndefined();
    expect(body.executed).toBe(true);
    expect(body.fundingVenue).toBe("bybit");
    expect(body.fundingCount).toBe(11);
    expect(body.bestFundingNetAnnualPct).toBeCloseTo(17.03333333, 6);
    expect(body.fundingError).toBeUndefined();
    expect(body.fundingSkipped).toBeUndefined();
  });

  it("reports the funding half as skipped on an immediate second scan", async () => {
    serveProfitableBook();
    await send("/api/scan", "POST");
    serveProfitableBook();

    const body = (await (await send("/api/scan", "POST")).json()) as {
      fundingSkipped?: boolean;
      fundingCount: number;
    };
    expect(body.fundingSkipped).toBe(true);
    expect(body.fundingCount).toBe(0);
    // Still exactly one board on disk.
    await expect(fundingRowCount()).resolves.toBe(11);
  });

  it("never lets a dead perp venue reach scans.error", async () => {
    serveProfitableBook();
    setFundingFetcher(async () => {
      throw new Error(
        "no funding-rate source available (bybit: HTTP 403; okx: HTTP 429)",
      );
    });

    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      executed: boolean;
      fundingError?: string;
    };
    expect(body.error).toBeUndefined();
    expect(body.executed).toBe(true);
    expect(body.fundingError).toContain("no funding-rate source available");

    const scans = (await (await get("/api/scans")).json()) as {
      scans: Array<{ error: string | null }>;
    };
    expect(scans.scans[0].error).toBeNull();
  });
});

describe("POST /api/reset - funding rows", () => {
  it("clears the board with the rest of the history, and keeps it otherwise", async () => {
    await send("/api/funding/refresh", "POST");
    expect((await funding()).count).toBe(11);

    await send("/api/reset", "POST", { wipeHistory: false });
    expect((await funding()).count).toBe(11);

    await send("/api/reset", "POST");
    const wiped = await funding();
    expect(wiped.count).toBe(0);
    expect(wiped.ts).toBeNull();
  });
});
