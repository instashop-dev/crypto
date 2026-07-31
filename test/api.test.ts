/**
 * HTTP surface of Phase 4: portfolio, history listings, reset, settings and
 * pair refresh, all against the migrated in-memory D1.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEXC_BASE, setWsCollector, type WsCollector } from "../src/binance";
import { DEFAULTS } from "../src/config";
import {
  commitTrade,
  ensureSeeded,
  getBalance,
  getSettings,
  insertOpportunities,
  insertScan,
  replacePairs,
} from "../src/db";
import { app } from "../src/index";
import type { BookTickerEntry, Env } from "../src/types";

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
