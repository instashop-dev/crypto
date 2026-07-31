/**
 * Cross-exchange spreads through the real scan path, against the in-memory D1.
 *
 * Both market-data seams are stubbed: the Binance venue via `setWsCollector`,
 * the MEXC venue via `setRestFetcher` (Phase 9's mirror of it). No network.
 *
 * The two books throughout:
 *
 *   binance-ws  BTCUSDT 59990/60000  ETHBTC 0.0499/0.05  ETHUSDT 3060/3061
 *   mexc-rest   BTCUSDT 60500/60510                      ETHUSDT 3050/3051
 *
 * which give, at the default 0.1%/leg fee:
 *
 *   triangular  USDT>BTC>ETH>USDT              net +1.694305898%  (binance only)
 *   spread      BTCUSDT binance-ws>mexc-rest   net +0.6317675%    (the winner)
 *   spread      ETHUSDT mexc-rest>binance-ws   net +0.09449558%
 *
 * Note the second spread runs the *other* way round: MEXC is the cheaper venue
 * for ETH and the dearer one for BTC, so a scanner that assumed a fixed
 * direction would misprice one of the two.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setRestFetcher,
  setWsCollector,
  type RestFetcher,
  type WsCollector,
} from "../src/binance";
import { DEFAULTS } from "../src/config";
import {
  applyBalanceDelta,
  ensureSeeded,
  getBalance,
  listOpportunities,
  listScans,
  listTrades,
  replacePairs,
  updateSettings,
} from "../src/db";
import { runScan } from "../src/scan";
import type { BookTickerEntry } from "../src/types";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
  fetchMock.assertNoPendingInterceptors();
});

const PAIRS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHBTC", base: "ETH", quote: "BTC" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
];

function book(entries: Record<string, [number, number]>): Map<string, BookTickerEntry> {
  return new Map(
    Object.entries(entries).map(([symbol, [bid, ask]]) => [symbol, { symbol, bid, ask }]),
  );
}

/** Binance side: the +1.694% triangle from test/executor.test.ts. */
const BINANCE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
});

/** Same three markets, ETH marked down so every triangle loses to fees. */
const BINANCE_FLAT_TRIANGLE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [2990, 2991],
});

/** MEXC side: BTC quoted higher, ETH quoted lower. */
const MEXC = book({
  BTCUSDT: [60500, 60510],
  ETHUSDT: [3050, 3051],
});

/** MEXC quoting inside Binance's spread, so no direction of any market pays. */
const MEXC_NO_EDGE = book({
  BTCUSDT: [59995, 60005],
  ETHUSDT: [3060.2, 3060.8],
});

const TRI_PROFIT = 1.694305898;
const TRI_NET_PCT = 1.694305898;
const SPREAD_LABEL = "BTCUSDT binance-ws>mexc-rest";
const SPREAD_NET_PCT = 0.6317675;
const SPREAD_PROFIT = 0.6317675;
const SPREAD_END = 100.6317675;
/** The runner-up, and it points the other way. */
const ETH_SPREAD_LABEL = "ETHUSDT mexc-rest>binance-ws";
const ETH_SPREAD_NET_PCT = 0.09449558;

/** Serve `snapshot` for whatever symbols the scan asks for. */
function serveWs(snapshot: Map<string, BookTickerEntry>): void {
  setWsCollector(async (symbols) => {
    const out = new Map<string, BookTickerEntry>();
    for (const symbol of symbols) {
      const entry = snapshot.get(symbol);
      if (entry) out.set(symbol, entry);
    }
    return out;
  });
}

function serveRest(snapshot: Map<string, BookTickerEntry>): void {
  setRestFetcher(async (symbols) => {
    const out = new Map<string, BookTickerEntry>();
    for (const symbol of symbols) {
      const entry = snapshot.get(symbol);
      if (entry) out.set(symbol, entry);
    }
    return out;
  });
}

/** Both venues up, with the books above. */
function serveBoth(): void {
  serveWs(BINANCE);
  serveRest(MEXC);
}

function failWs(message = "websocket upgrade rejected (HTTP 403)"): void {
  setWsCollector(async () => {
    throw new Error(message);
  });
}

function failRest(message = "HTTP 451"): void {
  setRestFetcher(async () => {
    throw new Error(message);
  });
}

/** Raw trade rows, so the stored columns are checked, not the mapping. */
async function tradeRows(): Promise<
  Array<{ strategy: string; source: string | null; cycle: string; profit: number }>
> {
  const { results } = await env.DB.prepare(
    "SELECT strategy, source, cycle, profit FROM trades ORDER BY id ASC",
  ).all<{ strategy: string; source: string | null; cycle: string; profit: number }>();
  return results ?? [];
}

beforeEach(async () => {
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
});

describe("runScan - both strategies", () => {
  it("persists triangles and spreads side by side, each tagged", async () => {
    serveBoth();

    const result = await runScan(env, "manual");

    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.source).toBe("binance-ws");
    // Two triangles (the cycle and its mirror) + two spreads (BTC and ETH,
    // best direction only). ETHBTC is excluded: it does not settle in USDT.
    expect(result.trianglesCount).toBe(2);
    expect(result.spreadsCount).toBe(2);

    const opportunities = await listOpportunities(env.DB, 50);
    expect(opportunities).toHaveLength(4);

    const byStrategy = (s: string) => opportunities.filter((o) => o.strategy === s);
    expect(byStrategy("triangular").map((o) => o.cycle).sort()).toEqual([
      "USDT>BTC>ETH>USDT",
      "USDT>ETH>BTC>USDT",
    ]);
    expect(byStrategy("cross_exchange").map((o) => o.cycle).sort()).toEqual([
      SPREAD_LABEL,
      ETH_SPREAD_LABEL,
    ]);
    // Every row belongs to this scan, and every spread carries venue-tagged legs.
    expect(opportunities.every((o) => o.scanId === result.scanId)).toBe(true);
    for (const spread of byStrategy("cross_exchange")) {
      expect(spread.legs).toHaveLength(2);
      expect(spread.legs.map((l) => l.venue).sort()).toEqual([
        "binance-ws",
        "mexc-rest",
      ]);
    }
  });

  it("books exactly one trade per strategy", async () => {
    serveBoth();

    const result = await runScan(env, "manual");

    expect(result.executed).toBe(true);
    expect(result.tradeId).toBeTypeOf("number");
    expect(result.xchgExecuted).toBe(true);
    expect(result.xchgTradeId).toBeTypeOf("number");
    expect(result.xchgTradeId).not.toBe(result.tradeId);

    const rows = await tradeRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.strategy)).toEqual(["triangular", "cross_exchange"]);
    expect(rows[0].cycle).toBe("USDT>BTC>ETH>USDT");
    expect(rows[0].source).toBe("binance-ws");
    // A spread is priced by two venues at once, so it records both.
    expect(rows[1].cycle).toBe(SPREAD_LABEL);
    expect(rows[1].source).toBe("binance-ws+mexc-rest");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.executed_count).toBe(2);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toBeNull();

    // One fill per strategy, not one fill per scan: two spreads were ranked and
    // only the best was taken.
    const executed = (await listOpportunities(env.DB, 50)).filter((o) => o.executed);
    expect(executed).toHaveLength(2);
    expect(executed.map((o) => o.cycle).sort()).toEqual([
      SPREAD_LABEL,
      "USDT>BTC>ETH>USDT",
    ]);
  });

  it("credits the balance with the sum of both profits", async () => {
    serveBoth();

    await runScan(env, "manual");

    const trades = await listTrades(env.DB, 10);
    const spread = trades.find((t) => t.strategy === "cross_exchange")!;
    const triangle = trades.find((t) => t.strategy === "triangular")!;

    expect(triangle.profit).toBeCloseTo(TRI_PROFIT, 6);
    expect(spread.startAmount).toBe(DEFAULTS.trade_size_usdt);
    expect(spread.endAmount).toBeCloseTo(SPREAD_END, 6);
    expect(spread.profit).toBeCloseTo(SPREAD_PROFIT, 8);
    expect(spread.profitPct).toBeCloseTo(SPREAD_NET_PCT, 8);

    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + TRI_PROFIT + SPREAD_PROFIT,
      6,
    );
  });

  it("records the spread count and the best spread on the scan row", async () => {
    serveBoth();

    const result = await runScan(env, "manual");
    expect(result.bestSpreadNetPct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(result.bestNetPct).toBeCloseTo(TRI_NET_PCT, 6);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.spreads_count).toBe(2);
    expect(scan.best_spread_net_pct).toBeCloseTo(SPREAD_NET_PCT, 8);
    // The triangular columns keep their old meaning exactly.
    expect(scan.triangles_count).toBe(2);
    expect(scan.best_net_pct).toBeCloseTo(TRI_NET_PCT, 6);
  });

  it("ranks the better direction of each market, whichever way it points", async () => {
    serveBoth();

    const result = await runScan(env, "manual");
    const spreads = (await listOpportunities(env.DB, 50)).filter(
      (o) => o.strategy === "cross_exchange",
    );

    const btc = spreads.find((o) => o.cycle.startsWith("BTCUSDT"))!;
    const eth = spreads.find((o) => o.cycle.startsWith("ETHUSDT"))!;

    // BTC is dearer on MEXC, ETH is cheaper there — opposite directions.
    expect(btc.cycle).toBe(SPREAD_LABEL);
    expect(eth.cycle).toBe(ETH_SPREAD_LABEL);
    expect(btc.netPct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(eth.netPct).toBeCloseTo(ETH_SPREAD_NET_PCT, 8);
    expect(btc.netPct).toBeLessThan(btc.grossPct);
    // Only the better direction of each is kept: 2 markets, 2 rows.
    expect(spreads).toHaveLength(2);
    expect(result.spreadsCount).toBe(2);
  });
});

describe("runScan - the spread execution gate", () => {
  it("records a spread below the threshold without filling it", async () => {
    serveBoth();
    await updateSettings(env.DB, { xchg_min_profit_pct: 5 });

    const result = await runScan(env, "manual");

    expect(result.spreadsCount).toBe(2);
    expect(result.xchgExecuted).toBe(false);
    expect(result.xchgTradeId).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    // The triangular gate is a separate knob and still fired.
    expect(result.executed).toBe(true);

    const rows = await tradeRows();
    expect(rows.map((r) => r.strategy)).toEqual(["triangular"]);
    // The opportunity is still on the record — it was real, just not good enough.
    const spreads = (await listOpportunities(env.DB, 50)).filter(
      (o) => o.strategy === "cross_exchange",
    );
    expect(spreads).toHaveLength(2);
    expect(spreads.every((o) => !o.executed)).toBe(true);
  });

  it("fills unconditionally when xchg_min_profit_pct is negative", async () => {
    // Every direction of every market loses on these books.
    serveWs(BINANCE);
    serveRest(MEXC_NO_EDGE);
    await updateSettings(env.DB, { xchg_min_profit_pct: -0.1 });

    const result = await runScan(env, "manual");

    expect(result.bestSpreadNetPct).toBeLessThan(0);
    expect(result.xchgExecuted).toBe(true);

    const trades = await listTrades(env.DB, 10);
    const spread = trades.find((t) => t.strategy === "cross_exchange")!;
    // Demo mode means "fill the best spread whatever it is" — as with
    // min_profit_pct, and not "fill anything above -0.1".
    expect(spread.profit).toBeLessThan(0);
    expect(spread.profitPct).toBeCloseTo(result.bestSpreadNetPct!, 8);
  });

  it("skips the spread when the triangular fill has drained the balance", async () => {
    serveWs(BINANCE_FLAT_TRIANGLE);
    serveRest(MEXC);
    // Just enough for one 100 USDT fill, and the triangular one loses ~0.22%
    // of it — which is more than the 0.1 USDT of headroom.
    await env.DB.prepare("DELETE FROM balances").run();
    await applyBalanceDelta(env.DB, "USDT", 100.1);
    await updateSettings(env.DB, { min_profit_pct: -100 });

    const result = await runScan(env, "manual");

    expect(result.executed).toBe(true);
    expect(result.xchgExecuted).toBe(false);
    expect(result.xchgError).toBeUndefined();

    const balance = await getBalance(env.DB, "USDT");
    expect(balance).toBeLessThan(DEFAULTS.trade_size_usdt);
    // The balance is re-read after the triangular fill precisely so this
    // happens: a stale read would have booked a fill the portfolio cannot fund.
    const rows = await tradeRows();
    expect(rows.map((r) => r.strategy)).toEqual(["triangular"]);
    // Still recorded as an opportunity, and still ranked.
    expect(result.spreadsCount).toBe(2);
    const spreads = (await listOpportunities(env.DB, 50)).filter(
      (o) => o.strategy === "cross_exchange",
    );
    expect(spreads).toHaveLength(2);
    expect(spreads.every((o) => !o.executed)).toBe(true);
  });
});

describe("runScan - degraded venues", () => {
  it("keeps scanning triangles when MEXC is down, and never sets scans.error", async () => {
    serveWs(BINANCE);
    failRest("HTTP 451");

    const result = await runScan(env, "manual");

    // The scan did not fail: one venue is missing, which is a degraded spread
    // scanner and a perfectly healthy triangular one.
    expect(result.error).toBeUndefined();
    expect(result.source).toBe("binance-ws");
    expect(result.executed).toBe(true);
    expect(result.spreadsCount).toBe(0);
    expect(result.bestSpreadNetPct).toBeNull();
    expect(result.xchgExecuted).toBe(false);
    expect(result.xchgError).toContain("mexc-rest");
    expect(result.xchgError).toContain("451");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toContain("mexc-rest");
    expect(scan.spreads_count).toBe(0);
    expect(scan.best_spread_net_pct).toBeNull();
    expect(scan.executed_count).toBe(1);

    const rows = await tradeRows();
    expect(rows.map((r) => r.strategy)).toEqual(["triangular"]);
    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);
  });

  it("falls back to MEXC for triangles when the WebSocket is down", async () => {
    failWs();
    serveRest(BINANCE);

    const result = await runScan(env, "manual");

    // The fallback still works, and it is still the only book in play — a
    // one-venue snapshot cannot produce a spread.
    expect(result.error).toBeUndefined();
    expect(result.source).toBe("mexc-rest");
    expect(result.executed).toBe(true);
    expect(result.spreadsCount).toBe(0);
    expect(result.xchgExecuted).toBe(false);
    expect(result.xchgError).toContain("binance-ws");
    expect(result.xchgError).toContain("403");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.source).toBe("mexc-rest");
    expect(scan.error).toBeNull();
    const rows = await tradeRows();
    expect(rows.map((r) => r.strategy)).toEqual(["triangular"]);
  });

  it("still reports a hard failure as a scan error when both venues are down", async () => {
    failWs();
    failRest();

    const result = await runScan(env, "manual");

    // No data at all *is* a failed scan, and it keeps its pre-Phase-9 shape.
    expect(result.error).toContain("no market-data source available");
    expect(result.xchgError).toBeUndefined();
    expect(result.spreadsCount).toBe(0);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.error).toContain("no market-data source available");
    expect(scan.xchg_error).toBeNull();
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
  });
});

describe("runScan - xchg_enabled kill switch", () => {
  it("restores the pre-Phase-9 scan exactly, with no second venue fetched", async () => {
    serveBoth();
    let dualCalls = 0;
    let restCalls = 0;
    const counting: RestFetcher = async () => {
      restCalls++;
      return MEXC;
    };
    setRestFetcher(counting);
    await updateSettings(env.DB, { xchg_enabled: 0 });

    const result = await runScan(env, "manual", {
      getSnapshots: async () => {
        dualCalls++;
        throw new Error("the dual path must not be entered");
      },
    });

    // The dual-snapshot path is never entered and no REST call is made: with
    // the switch off the scan is byte-for-byte the one that shipped in Phase 8.
    expect(dualCalls).toBe(0);
    expect(restCalls).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.source).toBe("binance-ws");
    expect(result.executed).toBe(true);
    expect(result.trianglesCount).toBe(2);
    expect(result.bestNetPct).toBeCloseTo(TRI_NET_PCT, 6);
    expect(result.spreadsCount).toBe(0);
    expect(result.bestSpreadNetPct).toBeNull();
    expect(result.xchgExecuted).toBe(false);

    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);
    const rows = await tradeRows();
    expect(rows.map((r) => r.strategy)).toEqual(["triangular"]);
    await expect(getBalance(env.DB, "USDT")).resolves.toBeCloseTo(
      DEFAULTS.initial_usdt + TRI_PROFIT,
      6,
    );

    const [scan] = await listScans(env.DB, 10);
    expect(scan.spreads_count).toBe(0);
    expect(scan.xchg_error).toBeNull();
    expect(scan.executed_count).toBe(1);
  });

  it("uses the dual path exactly once when enabled", async () => {
    serveBoth();
    let dualCalls = 0;

    const result = await runScan(env, "manual", {
      getSnapshots: async (symbols, e) => {
        dualCalls++;
        const binance = { source: "binance-ws" as const, ts: 1, book: BINANCE };
        const mexc = { source: "mexc-rest" as const, ts: 1, book: MEXC };
        expect(symbols.sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
        expect(e.DB).toBeDefined();
        return { binance, mexc, primary: binance, failures: [] };
      },
    });

    expect(dualCalls).toBe(1);
    expect(result.spreadsCount).toBe(2);
    expect(result.xchgExecuted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// India mode
// ---------------------------------------------------------------------------
//
// A spread disposes of two VDAs, not three: 100 USDT on the buy venue and
// 0.00166472 BTC marked at MEXC's 60500 bid on the sell venue.
//
//   tds base    100 + 100.7325 = 200.7325   (2.0073x notional, vs 3.02x)
//   TDS         1% of 200.7325             =   2.007325
//   tax due     30% of 0.6317675           =   0.18953025
//   net profit  0.6317675 - 0.18953025     =   0.44223725
const SPREAD_TDS_BASE = 200.7325;
const SPREAD_TDS = 2.007325;
const SPREAD_TAX_DUE = 0.18953025;
const SPREAD_NET_PROFIT = 0.44223725;

describe("runScan - india mode on a spread", () => {
  beforeEach(async () => {
    await updateSettings(env.DB, { india_mode: 1 });
  });

  it("withholds on both disposals and stores the breakdown", async () => {
    serveBoth();

    await runScan(env, "manual");

    const spread = (await listTrades(env.DB, 10)).find(
      (t) => t.strategy === "cross_exchange",
    )!;
    expect(spread).toBeDefined();

    // The fill itself is untouched: india mode is a reporting overlay.
    expect(spread.profit).toBeCloseTo(SPREAD_PROFIT, 8);
    expect(spread.profitPct).toBeCloseTo(SPREAD_NET_PCT, 8);

    expect(spread.tdsBase).toBeCloseTo(SPREAD_TDS_BASE, 6);
    expect(spread.tdsWithheld).toBe(SPREAD_TDS);
    expect(spread.taxDue).toBe(SPREAD_TAX_DUE);
    expect(spread.netProfit).toBe(SPREAD_NET_PROFIT);
    expect(spread.tdsRate).toBe(0.01);
    expect(spread.taxRate).toBe(0.3);

    // Two legs, so ~2x notional withheld against a triangle's ~3x — the one
    // structural advantage a spread has under this regime.
    expect(spread.tdsBase / spread.startAmount).toBeCloseTo(2.007, 3);
    const triangle = (await listTrades(env.DB, 10)).find(
      (t) => t.strategy === "triangular",
    )!;
    expect(triangle.tdsBase / triangle.startAmount).toBeGreaterThan(3);
    expect(spread.tdsWithheld).toBeLessThan(triangle.tdsWithheld);

    // ...and it is still a losing proposition: 2% withheld on a 0.63% edge.
    expect(spread.tdsWithheld).toBeGreaterThan(spread.profit);
  });

  it("debits the TDS of both fills from the balance", async () => {
    serveBoth();

    await runScan(env, "manual");

    const trades = await listTrades(env.DB, 10);
    const withheld = trades.reduce((sum, t) => sum + t.tdsWithheld, 0);
    const gross = trades.reduce((sum, t) => sum + t.profit, 0);

    const balance = await getBalance(env.DB, "USDT");
    expect(balance - DEFAULTS.initial_usdt).toBeCloseTo(gross - withheld, 8);
    // Two profitable fills, and the account is still down on the day.
    expect(gross).toBeGreaterThan(0);
    expect(balance).toBeLessThan(DEFAULTS.initial_usdt);
  });

  it("attaches per-opportunity figures to spreads too", async () => {
    serveBoth();

    await runScan(env, "manual");

    const spreads = (await listOpportunities(env.DB, 50)).filter(
      (o) => o.strategy === "cross_exchange",
    );
    expect(spreads).toHaveLength(2);
    expect(spreads.every((o) => o.indiaNetPct !== null && o.tdsPct !== null)).toBe(true);

    const btc = spreads.find((o) => o.cycle === SPREAD_LABEL)!;
    expect(btc.indiaNetPct).toBeCloseTo(btc.netPct * 0.7, 8);
    expect(btc.tdsPct).toBeCloseTo(SPREAD_TDS, 6);
    // ~2% for a spread against ~3% for a triangle, on the same scan.
    const triangle = (await listOpportunities(env.DB, 50)).find(
      (o) => o.strategy === "triangular" && o.cycle === "USDT>BTC>ETH>USDT",
    )!;
    expect(triangle.tdsPct!).toBeGreaterThan(3);
    expect(btc.tdsPct!).toBeLessThan(triangle.tdsPct!);
    // Either way the withholding dwarfs the edge it sits on.
    expect(btc.tdsPct!).toBeGreaterThan(btc.netPct);
  });

  it("leaves the spread columns NULL when the mode is off", async () => {
    await updateSettings(env.DB, { india_mode: 0 });
    serveBoth();

    await runScan(env, "manual");

    const spreads = (await listOpportunities(env.DB, 50)).filter(
      (o) => o.strategy === "cross_exchange",
    );
    expect(spreads).toHaveLength(2);
    expect(spreads.every((o) => o.indiaNetPct === null && o.tdsPct === null)).toBe(true);

    const trade = (await listTrades(env.DB, 10)).find(
      (t) => t.strategy === "cross_exchange",
    )!;
    expect(trade.tdsWithheld).toBe(0);
    expect(trade.taxDue).toBe(0);
    expect(trade.netProfit).toBe(trade.profit);
  });
});
