/**
 * Cross-exchange spreads through the real scan path, against the in-memory D1.
 *
 * Both market-data seams are stubbed: the Binance venue via `setWsCollector`,
 * the MEXC venue via `setRestFetcher`. No network.
 *
 * The two books throughout:
 *
 *   binance-ws  BTCUSDT 59990/60000  ETHBTC 0.0499/0.05  ETHUSDT 3060/3061
 *   mexc-rest   BTCUSDT 60500/60510                      ETHUSDT 3050/3051
 *
 * which give, at the default 0.1%/leg fee:
 *
 *   spread      BTCUSDT binance-ws>mexc-rest   net +0.6317675%    (the winner)
 *   spread      ETHUSDT mexc-rest>binance-ws   net +0.09449558%
 *
 * Note the second spread runs the *other* way round: MEXC is the cheaper venue
 * for ETH and the dearer one for BTC, so a scanner that assumed a fixed
 * direction would misprice one of the two.
 *
 * Nothing here is ever filled — Phase 12 removed the execution paths — so every
 * assertion below is about what was *recorded*.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setRestFetcher,
  setWsCollector,
  type RestFetcher,
} from "../src/binance";
import {
  ensureSeeded,
  listOpportunities,
  listScans,
  listTrades,
  replacePairs,
  updateSettings,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import { serveFlatBoard } from "./funding-stub";
import { runScan } from "../src/scan";
import type { BookTickerEntry } from "../src/types";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

/**
 * A minimal funding board, so the funding poll every scan performs stays off
 * the network. Nothing here asserts on it; see test/funding-scan.test.ts.
 */
const serveFundingBoard: FundingFetcher = serveFlatBoard();

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
  setFundingFetcher(null);
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

const BINANCE = book({
  BTCUSDT: [59990, 60000],
  ETHBTC: [0.0499, 0.05],
  ETHUSDT: [3060, 3061],
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

const SPREAD_LABEL = "BTCUSDT binance-ws>mexc-rest";
const SPREAD_NET_PCT = 0.6317675;
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

/** Only the cross-exchange rows, which after Phase 12 is all of them. */
async function spreadRows() {
  return (await listOpportunities(env.DB, 50)).filter(
    (o) => o.strategy === "cross_exchange",
  );
}

beforeEach(async () => {
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  setFundingFetcher(serveFundingBoard);
});

describe("runScan - spread observation", () => {
  it("persists the ranked spreads, tagged and venue-labelled", async () => {
    serveBoth();

    const result = await runScan(env, "manual");

    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.source).toBe("binance-ws");
    // Two spreads (BTC and ETH, best direction only). ETHBTC is excluded: it
    // does not settle in USDT.
    expect(result.spreadsCount).toBe(2);

    const opportunities = await listOpportunities(env.DB, 50);
    expect(opportunities).toHaveLength(2);
    // Every persisted row is a spread now; nothing else writes to the table.
    expect(opportunities.every((o) => o.strategy === "cross_exchange")).toBe(true);
    expect(opportunities.map((o) => o.cycle).sort()).toEqual(
      [SPREAD_LABEL, ETH_SPREAD_LABEL].sort(),
    );
    expect(opportunities.every((o) => o.scanId === result.scanId)).toBe(true);

    for (const spread of opportunities) {
      expect(spread.legs).toHaveLength(2);
      expect(spread.legs.map((l) => l.venue).sort()).toEqual([
        "binance-ws",
        "mexc-rest",
      ]);
      // A notional of 1 base unit: the row is a percentage, not a position.
      expect(spread.legs[0].inAmount).toBe(1);
    }
  });

  it("books no trade and moves no balance, whatever the edge", async () => {
    serveBoth();

    const result = await runScan(env, "manual");

    expect(result.bestSpreadNetPct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(result.bestSpreadNetPct).toBeGreaterThan(0);

    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
    expect((await spreadRows()).every((o) => !o.executed)).toBe(true);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.executed_count).toBe(0);
  });

  it("records the spread count and the best spread on the scan row", async () => {
    serveBoth();

    const result = await runScan(env, "manual");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.spreads_count).toBe(2);
    expect(scan.best_spread_net_pct).toBeCloseTo(SPREAD_NET_PCT, 8);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toBeNull();
    expect(result.spreadsCount).toBe(scan.spreads_count);
  });

  it("ranks the better direction of each market, whichever way it points", async () => {
    serveBoth();

    const result = await runScan(env, "manual");
    const spreads = await spreadRows();

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

  it("persists a losing board in full — the threshold is not a write-time gate", async () => {
    // Every direction of every market loses on these books.
    serveWs(BINANCE);
    serveRest(MEXC_NO_EDGE);
    await updateSettings(env.DB, { xchg_min_profit_pct: 5 });

    const result = await runScan(env, "manual");

    expect(result.bestSpreadNetPct).toBeLessThan(0);
    expect(result.spreadsCount).toBe(2);
    // Below the threshold and negative outright, and still recorded: the row is
    // the measurement, and dropping it would throw the finding away.
    await expect(spreadRows()).resolves.toHaveLength(2);
    await expect(listTrades(env.DB, 10)).resolves.toHaveLength(0);
  });
});

describe("runScan - degraded venues", () => {
  it("records a missing MEXC in xchg_error and never in scans.error", async () => {
    serveWs(BINANCE);
    failRest("HTTP 451");

    const result = await runScan(env, "manual");

    // The scan did not fail: one venue is missing, which is a degraded spread
    // scanner, not a broken one.
    expect(result.error).toBeUndefined();
    expect(result.source).toBe("binance-ws");
    expect(result.spreadsCount).toBe(0);
    expect(result.bestSpreadNetPct).toBeNull();
    expect(result.xchgError).toContain("mexc-rest");
    expect(result.xchgError).toContain("451");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toContain("mexc-rest");
    expect(scan.spreads_count).toBe(0);
    expect(scan.best_spread_net_pct).toBeNull();

    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(0);
    // ...and the funding half is entirely unaffected by a dead spot venue.
    expect(result.fundingCount).toBe(11);
  });

  it("falls back to MEXC for the snapshot when the WebSocket is down", async () => {
    failWs();
    serveRest(BINANCE);

    const result = await runScan(env, "manual");

    // The fallback still works, and it is still the only book in play — a
    // one-venue snapshot cannot produce a spread.
    expect(result.error).toBeUndefined();
    expect(result.source).toBe("mexc-rest");
    expect(result.spreadsCount).toBe(0);
    expect(result.xchgError).toContain("binance-ws");
    expect(result.xchgError).toContain("403");

    const [scan] = await listScans(env.DB, 10);
    expect(scan.source).toBe("mexc-rest");
    expect(scan.error).toBeNull();
  });

  it("still reports a hard failure as a scan error when both venues are down", async () => {
    failWs();
    failRest();

    const result = await runScan(env, "manual");

    // No data at all *is* a failed scan.
    expect(result.error).toContain("no market-data source available");
    expect(result.xchgError).toBeUndefined();
    expect(result.spreadsCount).toBe(0);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.error).toContain("no market-data source available");
    expect(scan.xchg_error).toBeNull();
  });
});

describe("runScan - xchg_enabled kill switch", () => {
  it("fetches no book at all with the switch off", async () => {
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

    // With the only spot strategy switched off there is nothing to fetch a book
    // for, so the scan is a funding poll with a pair-cache read attached.
    expect(dualCalls).toBe(0);
    expect(restCalls).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.source).toBeNull();
    expect(result.spreadsCount).toBe(0);
    expect(result.bestSpreadNetPct).toBeNull();
    expect(result.pairsCount).toBe(3);
    // The funding half runs regardless — that is the whole product now.
    expect(result.fundingCount).toBe(11);

    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(0);

    const [scan] = await listScans(env.DB, 10);
    expect(scan.spreads_count).toBe(0);
    expect(scan.xchg_error).toBeNull();
    expect(scan.source).toBeNull();
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
  });
});

// ---------------------------------------------------------------------------
// India mode
// ---------------------------------------------------------------------------
//
// A spread disposes of two VDAs. On a notional of 1 USDT: 1 USDT at face on the
// buy venue, and 0.00001665 BTC marked at MEXC's 60500 bid on the sell venue.
//
//   tds base    1 + 1.007325 = 2.007325   (2.0073x notional, vs a triangle's 3.02x)
//   tdsPct      1% of 2.007325 x 100     =   2.007325   % of notional
const SPREAD_TDS_PCT = 2.007325;

describe("runScan - india mode on a spread", () => {
  beforeEach(async () => {
    await updateSettings(env.DB, { india_mode: 1 });
  });

  it("annotates every persisted spread with both figures", async () => {
    serveBoth();

    await runScan(env, "manual");

    const spreads = await spreadRows();
    expect(spreads).toHaveLength(2);
    expect(spreads.every((o) => o.indiaNetPct !== null && o.tdsPct !== null)).toBe(true);

    const btc = spreads.find((o) => o.cycle === SPREAD_LABEL)!;
    expect(btc.indiaNetPct).toBeCloseTo(btc.netPct * 0.7, 8);
    expect(btc.tdsPct).toBeCloseTo(SPREAD_TDS_PCT, 6);
    // The verdict this whole overlay exists to state: the withholding is over
    // three times the edge it sits on, and it is charged on turnover.
    expect(btc.tdsPct!).toBeGreaterThan(btc.netPct);
  });

  it("leaves the ranking untouched — the overlay is a display column", async () => {
    serveBoth();

    await runScan(env, "manual");

    const spreads = await spreadRows();
    const byNet = [...spreads].sort((a, b) => b.netPct - a.netPct);
    const byIndia = [...spreads].sort((a, b) => b.indiaNetPct! - a.indiaNetPct!);
    expect(byIndia.map((o) => o.cycle)).toEqual(byNet.map((o) => o.cycle));
    // ...and the pre-tax figures are byte-identical to the mode-off ones.
    const btc = spreads.find((o) => o.cycle === SPREAD_LABEL)!;
    expect(btc.netPct).toBeCloseTo(SPREAD_NET_PCT, 8);
  });

  it("leaves the spread columns NULL when the mode is off", async () => {
    await updateSettings(env.DB, { india_mode: 0 });
    serveBoth();

    await runScan(env, "manual");

    const spreads = await spreadRows();
    expect(spreads).toHaveLength(2);
    // NULL is "not measured", which is not the same claim as "measured as zero".
    expect(spreads.every((o) => o.indiaNetPct === null && o.tdsPct === null)).toBe(true);
  });
});
