/**
 * HTTP surface: portfolio, history listings, reset, settings, spreads, funding
 * and pair refresh, all against the migrated in-memory D1.
 *
 * Since Phase 12 nothing the app can do writes a `trades` row or moves a
 * balance, so the history fixtures below are inserted with raw SQL — which is
 * exactly what they represent: rows the fill-era scanner left behind, which
 * `GET /api/trades` and `GET /api/portfolio` must go on serving unchanged.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MEXC_BASE,
  setRestFetcher,
  setWsCollector,
  type WsCollector,
} from "../src/binance";
import { ASSET_UNIVERSE, BASE_ASSET, DEFAULTS, perpAssets } from "../src/config";
import {
  ensureSeeded,
  getSettings,
  insertFundingRates,
  insertOpportunities,
  insertScan,
  replacePairs,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import { fundingQuote, snapshotOf } from "./funding-stub";
import { app } from "../src/index";
import type { BookTickerEntry, Env } from "../src/types";

const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
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
const serveFundingBoard: FundingFetcher = async (assets) =>
  snapshotOf(
    assets.map((symbol, i) =>
      fundingQuote(symbol, {
        rate: 0.0002 - i * 0.00002,
        nextFundingTs: Date.now() + 3_600_000,
        markPrice: 100 + i,
      }),
    ),
    Date.now(),
  );

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

/**
 * A well-formed Binance book. MEXC is never intercepted in this file, so every
 * `POST /api/scan` here has exactly one venue and its spread half degrades —
 * which is itself asserted below.
 */
const BOOK: Map<string, BookTickerEntry> = new Map(
  Object.entries({
    BTCUSDT: [59990, 60000],
    ETHBTC: [0.0499, 0.05],
    ETHUSDT: [3060, 3061],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

function stubWs(fn: WsCollector): void {
  setWsCollector(fn);
}

/** The MEXC side, quoting BTC dearer — the spread the tests below observe. */
const MEXC_BOOK: Map<string, BookTickerEntry> = new Map(
  Object.entries({
    BTCUSDT: [60500, 60510],
    ETHUSDT: [3050, 3051],
  }).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
);

/** `BTCUSDT binance-ws>mexc-rest` on the two books above, at 0.1%/leg. */
const SPREAD_LABEL = "BTCUSDT binance-ws>mexc-rest";
const SPREAD_NET_PCT = 0.6317675;
const SPREAD_TDS_PCT = 2.007325;

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

function serveBook(): void {
  stubWs(serve(BOOK));
}

/** Both venues, so a scan over HTTP actually produces spread rows. */
function serveBothVenues(): void {
  stubWs(serve(BOOK));
  setRestFetcher(serve(MEXC_BOOK));
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

/** India-mode figures a historical row may carry. All zero means "untaxed". */
interface SeedTax {
  tdsBase: number;
  tdsWithheld: number;
  taxDue: number;
  netProfit: number;
  tdsRate: number;
  taxRate: number;
}

const NO_SEED_TAX: SeedTax = {
  tdsBase: 0,
  tdsWithheld: 0,
  taxDue: 0,
  netProfit: 0,
  tdsRate: 0,
  taxRate: 0,
};

/**
 * Insert one historical scan + opportunity + trade at a controlled timestamp,
 * and move the balance the way the fill-era executor would have: by the profit
 * less any TDS withheld.
 *
 * Raw SQL rather than a helper, because there is no longer a helper — this is a
 * fixture reproducing what the database already contains in production, not a
 * code path anything can still take.
 */
async function seedTrade(
  ts: number,
  profit: number,
  options: {
    strategy?: string;
    source?: string;
    cycle?: string;
    tax?: SeedTax;
    indiaNetPct?: number | null;
    tdsPct?: number | null;
  } = {},
): Promise<number> {
  const strategy = options.strategy ?? "triangular";
  const source = options.source ?? "binance-ws";
  const cycle = options.cycle ?? `USDT>BTC>ETH>USDT#${ts}`;
  const tax = options.tax ?? { ...NO_SEED_TAX, netProfit: profit };

  const scanId = await insertScan(env.DB, "manual", ts);
  const [opportunityId] = await insertOpportunities(
    env.DB,
    scanId,
    [
      {
        cycle,
        grossPct: profit,
        netPct: profit,
        legs: [],
        indiaNetPct: options.indiaNetPct ?? null,
        tdsPct: options.tdsPct ?? null,
      },
    ],
    ts,
    strategy as "triangular" | "cross_exchange",
  );

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO trades (ts, cycle, start_amount, end_amount, profit, profit_pct," +
        " legs_json, source, opportunity_id, tds_base, tds_withheld, tax_due," +
        " net_profit, tds_rate, tax_rate, strategy)" +
        " VALUES (?1, ?2, 100, ?3, ?4, ?4, '[]', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    ).bind(
      ts,
      cycle,
      100 + profit,
      profit,
      source,
      opportunityId,
      tax.tdsBase,
      tax.tdsWithheld,
      tax.taxDue,
      tax.netProfit,
      tax.tdsRate,
      tax.taxRate,
      strategy,
    ),
    env.DB.prepare("UPDATE opportunities SET executed = 1 WHERE id = ?1").bind(
      opportunityId,
    ),
    env.DB.prepare("UPDATE scans SET executed_count = 1 WHERE id = ?1").bind(scanId),
    env.DB.prepare("UPDATE balances SET amount = amount + ?1 WHERE asset = 'USDT'").bind(
      profit - tax.tdsWithheld,
    ),
  ]);

  return scanId;
}

/** The common case: an untaxed triangular row, as most of the history is. */
async function seedHistory(ts: number, profit: number): Promise<number> {
  return seedTrade(ts, profit);
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

  it("reflects the historical trades still on disk", async () => {
    await seedHistory(1_000, 1.694305898);

    const body = (await (await get("/api/portfolio")).json()) as PortfolioBody;
    expect(body.equityUsdt).toBeCloseTo(DEFAULTS.initial_usdt + 1.694305898, 6);
    expect(body.pnl.absUsdt).toBeCloseTo(1.694305898, 6);
    expect(body.pnl.pct).toBeCloseTo((1.694305898 / DEFAULTS.initial_usdt) * 100, 8);
  });

  it("is unmoved by a scan, because a scan no longer fills anything", async () => {
    serveBook();

    const before = (await (await get("/api/portfolio")).json()) as PortfolioBody;
    const scanRes = await send("/api/scan", "POST");
    expect(scanRes.status).toBe(200);

    const scan = (await scanRes.json()) as {
      scanId: number;
      opportunities: Array<{ executed: boolean }>;
    };
    expect(scan.scanId).toBeTypeOf("number");
    expect(scan.opportunities.every((o) => !o.executed)).toBe(true);

    const after = (await (await get("/api/portfolio")).json()) as PortfolioBody;
    expect(after.equityUsdt).toBe(before.equityUsdt);
    expect(after.pnl).toEqual(before.pnl);
    await expect(get("/api/trades").then((r) => r.json())).resolves.toMatchObject({
      count: 0,
    });
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
    // Historical rows keep their `executed` flag; nothing sets it any more.
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
    await send("/api/settings", "PUT", { xchg_min_profit_pct: -0.5 });
    await send("/api/reset", "POST");

    const settings = (await (await get("/api/settings")).json()) as {
      xchg_min_profit_pct: number;
    };
    expect(settings.xchg_min_profit_pct).toBe(-0.5);
  });
});

describe("GET|PUT /api/settings", () => {
  it("returns the seeded defaults", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...DEFAULTS });
  });

  it("accepts a valid fee_rate", async () => {
    const res = await send("/api/settings", "PUT", { fee_rate: 0.002 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ fee_rate: 0.002 });
    await expect(getSettings(env.DB)).resolves.toMatchObject({ fee_rate: 0.002 });
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

  it("rejects a negative fee_rate", async () => {
    await expect(
      send("/api/settings", "PUT", { fee_rate: -0.001 }).then((r) => r.status),
    ).resolves.toBe(400);
  });

  it("accepts a valid perp_fee_rate", async () => {
    const res = await send("/api/settings", "PUT", { perp_fee_rate: 0.0002 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ perp_fee_rate: 0.0002 });
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      perp_fee_rate: 0.0002,
    });
  });

  it("holds perp_fee_rate to the same 0-0.01 range as fee_rate", async () => {
    // The two rates differ in what they typically cost, not in what counts as
    // a fat finger.
    for (const value of [0.5, -0.0005]) {
      const res = await send("/api/settings", "PUT", { perp_fee_rate: value });
      expect(res.status, String(value)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("perp_fee_rate");
    }
    await expect(getSettings(env.DB)).resolves.toMatchObject({
      perp_fee_rate: DEFAULTS.perp_fee_rate,
    });
  });

  it("rejects unknown keys with 400", async () => {
    const res = await send("/api/settings", "PUT", { xchg_min_profit: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("xchg_min_profit");
  });

  it("rejects the settings Phase 12 retired, rather than silently accepting them", async () => {
    // The behaviour they controlled no longer exists, so pretending to store
    // them would be the dishonest answer.
    for (const key of ["min_profit_pct", "trade_size_usdt"]) {
      const res = await send("/api/settings", "PUT", { [key]: 1 });
      expect(res.status, key).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, key).toContain(key);
    }
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
    const res = await send("/api/settings", "PUT", { fee_rate: "0.001" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// India mode over HTTP
// ---------------------------------------------------------------------------
//
// Figures derived in test/tax.test.ts, for a 100 USDT three-hop cycle:
//   gross +1.6943059  tds 3.01679452  tax 0.50829177  net 1.18601413
//
// They belong to a fill that happened before Phase 12, which is exactly what
// these tests cover: the portfolio and trade routes must go on reporting the
// history correctly now that nothing adds to it.
const GROSS_PROFIT = 1.694305898;
const TDS_WITHHELD = 3.01679452;
const TAX_DUE = 0.50829177;
const NET_PROFIT = 1.18601413;

/** A historical india-mode fill, with the rates that were in force. */
const TAXED = {
  tdsBase: 301.679452,
  tdsWithheld: TDS_WITHHELD,
  taxDue: TAX_DUE,
  netProfit: NET_PROFIT,
  tdsRate: 0.01,
  taxRate: 0.3,
};

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

  it("reports the worked figures for a historical india-mode fill", async () => {
    await send("/api/settings", "PUT", { india_mode: 1 });
    await seedTrade(7_000, GROSS_PROFIT, { tax: TAXED });

    const body = await portfolio();

    expect(body.tax.indiaMode).toBe(true);
    expect(body.tax.trades).toBe(1);
    expect(body.tax.profitableTrades).toBe(1);
    expect(body.tax.grossProfitUsdt).toBeCloseTo(GROSS_PROFIT, 6);
    expect(body.tax.tdsWithheldUsdt).toBeCloseTo(TDS_WITHHELD, 8);
    expect(body.tax.taxDueUsdt).toBeCloseTo(TAX_DUE, 8);
    expect(body.tax.netProfitUsdt).toBeCloseTo(NET_PROFIT, 8);

    // Cash-flow names and balance-sheet names for the same two figures.
    expect(body.tax.tdsReceivableUsdt).toBe(body.tax.tdsWithheldUsdt);
    expect(body.tax.taxLiabilityUsdt).toBe(body.tax.taxDueUsdt);

    // Equity is the cash view: TDS already gone, so a winning cycle is down.
    expect(body.equityUsdt).toBeCloseTo(
      DEFAULTS.initial_usdt + GROSS_PROFIT - TDS_WITHHELD,
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
    await seedTrade(7_100, GROSS_PROFIT, { tax: TAXED });
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
    await seedTrade(2_500, GROSS_PROFIT, { tax: TAXED });
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

  it("exposes indiaNetPct/tdsPct on spreads, null when the mode is off", async () => {
    serveBothVenues();
    await send("/api/scan", "POST");

    const off = (await (await get("/api/opportunities")).json()) as {
      opportunities: Array<{
        cycle: string;
        indiaNetPct: number | null;
        tdsPct: number | null;
      }>;
    };
    expect(off.opportunities.length).toBeGreaterThan(0);
    expect(off.opportunities.every((o) => o.indiaNetPct === null)).toBe(true);
    expect(off.opportunities.every((o) => o.tdsPct === null)).toBe(true);

    await send("/api/settings", "PUT", { india_mode: 1 });
    serveBothVenues();
    await send("/api/scan", "POST");

    const on = (await (await get("/api/opportunities")).json()) as {
      opportunities: Array<{
        cycle: string;
        netPct: number;
        indiaNetPct: number | null;
        tdsPct: number | null;
      }>;
    };
    const best = on.opportunities.find((o) => o.cycle === SPREAD_LABEL);
    expect(best).toBeDefined();
    expect(best!.netPct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(best!.indiaNetPct).toBeCloseTo(best!.netPct * 0.7, 8);
    // Two legs, so ~2% of notional withheld — against an edge of ~0.63%.
    expect(best!.tdsPct).toBeCloseTo(SPREAD_TDS_PCT, 6);
  });
});

// ---------------------------------------------------------------------------
// Cross-exchange over HTTP
// ---------------------------------------------------------------------------

/** One synthetic cross-exchange opportunity + trade, at a controlled timestamp. */
async function seedSpreadHistory(ts: number, profit: number): Promise<number> {
  return seedTrade(ts, profit, {
    strategy: "cross_exchange",
    source: "binance-ws+mexc-rest",
    cycle: `BTCUSDT binance-ws>mexc-rest#${ts}`,
  });
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
  it("reports the spread figures and records them as opportunities", async () => {
    serveBothVenues();
    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      source: string;
      spreadsCount: number;
      bestSpreadNetPct: number | null;
      xchgError?: string;
      opportunities: Array<{ strategy: string; cycle: string; executed: boolean }>;
    };

    expect(body.error).toBeUndefined();
    expect(body.xchgError).toBeUndefined();
    expect(body.source).toBe("binance-ws");
    expect(body.spreadsCount).toBe(2);
    expect(body.bestSpreadNetPct).toBeCloseTo(SPREAD_NET_PCT, 8);
    // Only spreads are written now, and none of them is filled.
    expect(body.opportunities.every((o) => o.strategy === "cross_exchange")).toBe(true);
    expect(body.opportunities.every((o) => !o.executed)).toBe(true);
    expect(body.opportunities.map((o) => o.cycle)).toContain(SPREAD_LABEL);
  });

  it("degrades to xchgError when only one venue answers", async () => {
    // No MEXC venue is reachable here (nothing is intercepted), so the spread
    // scanner degrades: the response still carries its fields, the scan itself
    // still succeeds, and `error` stays clean.
    serveBook();
    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      spreadsCount: number;
      bestSpreadNetPct: number | null;
      xchgError?: string;
      opportunities: unknown[];
    };

    expect(body.error).toBeUndefined();
    expect(body.spreadsCount).toBe(0);
    expect(body.bestSpreadNetPct).toBeNull();
    expect(body.xchgError).toContain("mexc-rest");
    expect(body.opportunities).toEqual([]);
  });

  it("exposes the spread columns in the scan listing", async () => {
    serveBothVenues();
    await send("/api/scan", "POST");

    const body = (await (await get("/api/scans")).json()) as {
      scans: Array<{
        spreads_count: number;
        best_spread_net_pct: number | null;
        triangles_count: number;
        best_net_pct: number | null;
        executed_count: number;
        xchg_error: string | null;
        error: string | null;
      }>;
    };
    const [scan] = body.scans;
    expect(scan.spreads_count).toBe(2);
    expect(scan.best_spread_net_pct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(scan.xchg_error).toBeNull();
    expect(scan.error).toBeNull();
    // The retired triangular columns are still served, at their defaults.
    expect(scan.triangles_count).toBe(0);
    expect(scan.best_net_pct).toBeNull();
    expect(scan.executed_count).toBe(0);
  });
});

describe("GET /api/opportunities - the qualifies flag", () => {
  it("judges every row against the current threshold, not a stored one", async () => {
    serveBothVenues();
    await send("/api/scan", "POST");

    type Body = {
      minProfitPct: number;
      opportunities: Array<{ cycle: string; netPct: number; qualifies: boolean }>;
    };
    const read = async () =>
      (await (await get("/api/opportunities")).json()) as Body;

    const before = await read();
    expect(before.minProfitPct).toBe(DEFAULTS.xchg_min_profit_pct);
    const qualifying = before.opportunities.filter((o) => o.qualifies);
    expect(qualifying.length).toBeGreaterThan(0);
    expect(
      qualifying.every((o) => o.netPct >= DEFAULTS.xchg_min_profit_pct),
    ).toBe(true);

    // Raising the bar must re-classify rows already on disk: qualifying is a
    // judgement about a measurement, not part of it.
    await send("/api/settings", "PUT", { xchg_min_profit_pct: 1000 });
    const after = await read();
    expect(after.minProfitPct).toBe(1000);
    expect(after.opportunities.every((o) => !o.qualifies)).toBe(true);
    // The stored percentages themselves did not move.
    expect(after.opportunities[0].netPct).toBe(before.opportunities[0].netPct);

    await send("/api/settings", "PUT", { xchg_min_profit_pct: -1000 });
    expect((await read()).opportunities.every((o) => o.qualifies)).toBe(true);
  });

  it("nothing is ever marked executed, however good the spread looks", async () => {
    serveBothVenues();
    await send("/api/scan", "POST");

    const body = (await (await get("/api/opportunities")).json()) as {
      opportunities: Array<{ qualifies: boolean; executed: boolean }>;
    };
    expect(body.opportunities.some((o) => o.qualifies)).toBe(true);
    expect(body.opportunities.every((o) => !o.executed)).toBe(true);
    await expect(get("/api/trades").then((r) => r.json())).resolves.toMatchObject({
      count: 0,
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
  venues: Array<{ venue: string; count: number }>;
  count: number;
  minAnnualPct: number;
  holdDays: number;
  feeRate: number;
  perpFeeRate: number;
  pollIntervalMs: number;
  rates: FundingRateBody[];
}

/** One synthetic funding row at a controlled timestamp. */
function fundingRow(symbol: string, netAnnualPct: number, venue = "bybit") {
  return {
    venue,
    symbol,
    instrument: `${symbol}USDT`,
    rate: 0.0001,
    intervalMinutes: 480,
    intervalSource: "api",
    // The 30-day drag at the default fees: 2 x 0.1% spot + 2 x 0.05% perp.
    annualizedPct: netAnnualPct + 3.65,
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
    expect(body.venues).toEqual([]);
    expect(body.stale).toBe(false);
    // The settings echo is present either way, so the panel can render its
    // header before any row exists.
    expect(body.minAnnualPct).toBe(DEFAULTS.funding_min_annual_pct);
    expect(body.holdDays).toBe(DEFAULTS.funding_hold_days);
    // Both taker rates are echoed: the panel explains a drag the operator
    // cannot check without knowing what each pair of legs was charged.
    expect(body.feeRate).toBe(DEFAULTS.fee_rate);
    expect(body.perpFeeRate).toBe(DEFAULTS.perp_fee_rate);
  });

  it("returns the newest board, best net carry first", async () => {
    serveBook();
    await send("/api/scan", "POST");

    const body = await funding();
    expect(body.count).toBe(11);
    expect(body.venue).toBe("bybit");
    expect(body.rates).toHaveLength(11);
    expect(body.rates[0].symbol).toBe("BTC");
    expect(body.rates[0].instrument).toBe("BTCUSDT");
    expect(body.rates[0].annualizedPct).toBeCloseTo(21.9, 6);
    expect(body.rates[0].netAnnualPct).toBeCloseTo(18.25, 6);

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
    serveBook();
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

  it("ranks a multi-venue board by net carry, whichever venue quoted it", async () => {
    const ts = Date.now();
    await insertFundingRates(
      env.DB,
      null,
      [
        fundingRow("BTC", 4, "bybit"),
        fundingRow("BTC", 19, "gate"),
        fundingRow("PEPE", 31, "kucoin"),
        fundingRow("ETH", 12, "okx"),
      ],
      ts,
    );

    const body = await funding();
    expect(body.count).toBe(4);
    expect(body.rates.map((r) => `${r.venue}:${r.symbol}`)).toEqual([
      "kucoin:PEPE",
      "gate:BTC",
      "okx:ETH",
      "bybit:BTC",
    ]);
    // The single `venue` still names the source of the headline row, and
    // `venues` is the honest full answer beside it.
    expect(body.venue).toBe("kucoin");
    expect(body.venues).toEqual([
      { venue: "kucoin", count: 1 },
      { venue: "gate", count: 1 },
      { venue: "okx", count: 1 },
      { venue: "bybit", count: 1 },
    ]);
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

  it("narrows one symbol's series to a single venue", async () => {
    // Four venues quoting BTC means four rows per timestamp; a chart drawn from
    // the mixture would zig-zag between venues rather than show either series.
    await insertFundingRates(env.DB, null, [fundingRow("BTC", 30, "gate")], 6_003);
    await insertFundingRates(env.DB, null, [fundingRow("BTC", 31, "gate")], 6_004);

    const all = (await (await get("/api/funding/history?symbol=BTC")).json()) as {
      venue: string | null;
      count: number;
    };
    expect(all.count).toBe(5);
    expect(all.venue).toBeNull();

    const gate = (await (
      await get("/api/funding/history?symbol=BTC&venue=gate")
    ).json()) as { venue: string; count: number; rates: FundingRateBody[] };
    expect(gate.venue).toBe("gate");
    expect(gate.count).toBe(2);
    expect(gate.rates.every((r) => r.venue === "gate")).toBe(true);
    expect(gate.rates.map((r) => r.ts)).toEqual([6_004, 6_003]);

    // The filter is applied in SQL, so a narrowed request still returns `limit`
    // rows of the venue asked for rather than however many survive a slice.
    const one = (await (
      await get("/api/funding/history?symbol=BTC&venue=GATE&limit=1")
    ).json()) as { count: number; rates: FundingRateBody[] };
    expect(one.count).toBe(1);
    expect(one.rates[0].ts).toBe(6_004);
  });

  it("rejects an unknown venue rather than silently ignoring the filter", async () => {
    // A silently-ignored filter looks exactly like a venue that never quotes.
    const res = await get("/api/funding/history?symbol=BTC&venue=binance");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown venue: binance");
    expect(body.error).toContain("kucoin");
  });
});

describe("POST /api/funding/refresh", () => {
  it("polls unconditionally and writes rows that belong to no scan", async () => {
    const res = await send("/api/funding/refresh", "POST");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      count: number;
      venue: string;
      venues: string[];
      venueErrors: string[];
      ts: number;
    };
    expect(body.count).toBe(11);
    expect(body.venue).toBe("bybit");
    expect(body.venues).toEqual(["bybit"]);
    expect(body.venueErrors).toEqual([]);
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
  it("carries the funding figures alongside the spread ones", async () => {
    serveBook();
    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      fundingVenue: string | null;
      fundingVenues: string[];
      fundingVenueErrors?: string[];
      fundingCount: number;
      bestFundingNetAnnualPct: number | null;
      fundingError?: string;
      fundingSkipped?: boolean;
    };

    expect(body.error).toBeUndefined();
    expect(body.fundingVenue).toBe("bybit");
    expect(body.fundingVenues).toEqual(["bybit"]);
    expect(body.fundingVenueErrors).toBeUndefined();
    expect(body.fundingCount).toBe(11);
    expect(body.bestFundingNetAnnualPct).toBeCloseTo(18.25, 6);
    expect(body.fundingError).toBeUndefined();
    expect(body.fundingSkipped).toBeUndefined();
  });

  it("reports a half-dead venue list without failing anything", async () => {
    serveBook();
    setFundingFetcher(async (assets) => ({
      ...snapshotOf(
        assets.map((symbol) => fundingQuote(symbol, { venue: "gate" })),
        Date.now(),
      ),
      venues: [
        { venue: "bybit", count: 0, error: "HTTP 403" },
        { venue: "gate", count: assets.length, error: null },
      ],
    }));

    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      fundingVenue: string | null;
      fundingVenues: string[];
      fundingVenueErrors?: string[];
      fundingError?: string;
    };

    // One venue blocked from Cloudflare's egress is the *expected* production
    // state, not a failure: the board that landed is still a board.
    expect(body.fundingVenue).toBe("gate");
    expect(body.fundingVenues).toEqual(["gate"]);
    expect(body.fundingVenueErrors).toEqual(["bybit: HTTP 403"]);
    expect(body.fundingError).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  it("reports the funding half as skipped on an immediate second scan", async () => {
    serveBook();
    await send("/api/scan", "POST");
    serveBook();

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
    serveBook();
    setFundingFetcher(async () => {
      throw new Error(
        "no funding-rate source available (bybit: HTTP 403; okx: HTTP 429)",
      );
    });

    const body = (await (await send("/api/scan", "POST")).json()) as {
      error?: string;
      fundingError?: string;
    };
    expect(body.error).toBeUndefined();
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
