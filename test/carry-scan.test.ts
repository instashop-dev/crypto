/**
 * The paper carry lifecycle — open, accrue, close — driven through `runScan`
 * against the migrated in-memory D1, plus the two routes that read and end a
 * position.
 *
 * The same three seams `test/funding-scan.test.ts` stubs are stubbed here: the
 * spot venues via `setWsCollector` / `setRestFetcher` (so the spread half keeps
 * producing rows, which several tests below assert survive a carry failure), the
 * funding board via `deps.fetchFunding`, and the cadence lookup via
 * `deps.fetchFundingIntervals`. Nothing reaches the network.
 *
 * **The clock is injected and epoch-aligned.** `T0` is an exact multiple of the
 * 8-hour settlement interval, so with `nextFundingTs = null` on the stubbed
 * quotes the accrual grid falls on `T0`, `T0 + 8h`, `T0 + 16h`, … and every
 * expectation below is a boundary count anyone can do in their head. One test
 * deliberately publishes a `nextFundingTs` instead, to pin the other anchor.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBasisFetcher } from "../src/basis";
import { setRestFetcher, setWsCollector } from "../src/binance";
import { ASSET_UNIVERSE, BASE_ASSET, DEFAULTS, perpAssets } from "../src/config";
import {
  ensureSeeded,
  insertFundingRates,
  listOpportunities,
  listScans,
  replacePairs,
  resetAll,
  toFundingPosition,
  updateSettings,
  type FundingPosition,
  type FundingPositionRow,
} from "../src/db";
import { setFundingFetcher, type FundingFetcher } from "../src/funding";
import { app } from "../src/index";
import { buildReport } from "../src/report";
import { runScan } from "../src/scan";
import type { BookTickerEntry, Env, FundingVenue } from "../src/types";
import { fundingQuote, snapshotOf } from "./funding-stub";
import { serveMinimalBasisBoard } from "./basis-stub";

const ASSETS = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The 8-hour settlement period, in milliseconds. */
const PERIOD_MS = 8 * HOUR_MS;

/**
 * An exact multiple of the settlement period, so the epoch-aligned accrual grid
 * passes through it: 59028 x 8h.
 */
const T0 = 59_028 * PERIOD_MS;

/** The worked board: BTC at 0.0002 per 8h, each later asset a notch lower. */
const BEST_RATE = 0.0002;
/** 0.0002 x 1095 x 100. */
const BEST_ANNUAL = 21.9;
/** (2 x 0.001 + 2 x 0.0005) x (365/30) x 100. */
const DRAG_30D = 3.65;
const BEST_NET = BEST_ANNUAL - DRAG_30D;
/** The default position size, and the denominator of every realised percent. */
const NOTIONAL = DEFAULTS.funding_position_size_usdt;
/** One settlement of 0.0002 on 1000 USDT. */
const PER_SETTLEMENT = BEST_RATE * NOTIONAL;
/** 1000 x (2 x 0.001 + 2 x 0.0005). */
const ROUND_TRIP_FEE = 3;

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

let clock = T0;
const now = () => clock;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  clock = T0;
  await ensureSeeded(env.DB);
  await replacePairs(env.DB, PAIRS, "test");
  setWsCollector(serve(BINANCE));
  setRestFetcher(serve(MEXC));
  setBasisFetcher(serveMinimalBasisBoard());
});

afterEach(() => {
  setWsCollector(null);
  setRestFetcher(null);
  setFundingFetcher(null);
  setBasisFetcher(null);
});

/** The full major board on Bybit, rates descending so BTC always ranks first. */
function board(
  overrides: {
    intervalSource?: "api" | "assumed";
    nextFundingTs?: number | null;
    rateFor?: (symbol: string, index: number) => number;
  } = {},
): FundingFetcher {
  return async (assets) =>
    snapshotOf(
      assets.map((symbol, i) =>
        fundingQuote(symbol, {
          rate: overrides.rateFor
            ? overrides.rateFor(symbol, i)
            : BEST_RATE - i * 0.00001,
          intervalMinutes: 480,
          intervalSource: overrides.intervalSource ?? "api",
          nextFundingTs: overrides.nextFundingTs ?? null,
        }),
      ),
      clock,
    );
}

/** A board assembled by hand from `(venue, symbol, rate)` triples. */
function boardOf(
  quotes: Array<[FundingVenue, string, number]>,
  intervalSource: "api" | "assumed" = "api",
): FundingFetcher {
  return async () =>
    snapshotOf(
      quotes.map(([venue, symbol, rate]) =>
        fundingQuote(symbol, {
          venue,
          rate,
          intervalSource,
          instrument: `${symbol}-${venue}`,
          nextFundingTs: null,
        }),
      ),
      clock,
    );
}

/** Every scan in this file: injected clock, stubbed board, no poll gate. */
function deps(fetchFunding: FundingFetcher) {
  return {
    now,
    fetchFunding,
    // Every poll is due: the gate is `test/funding-scan.test.ts`'s subject, and
    // here it would only stand between the clock and the next accrual.
    fundingPollIntervalMs: 1,
    // Stubbed to an empty map so the cadence lookup never reaches Bybit; the
    // board stub sets `intervalSource` itself.
    fetchFundingIntervals: async () => ({}),
  };
}

async function positions(): Promise<FundingPosition[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM funding_positions ORDER BY id ASC",
  ).all<FundingPositionRow>();
  return (results ?? []).map(toFundingPosition);
}

async function openPositions(): Promise<FundingPosition[]> {
  return (await positions()).filter((p) => p.status === "open");
}

async function get(path: string): Promise<Response> {
  return app.request(path, undefined, env as unknown as Env);
}

async function post(path: string): Promise<Response> {
  return app.request(path, { method: "POST" }, env as unknown as Env);
}

async function put(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env as unknown as Env,
  );
}

describe("runScan - opening carry positions", () => {
  it("opens the best qualifying rows and snapshots every entry figure", async () => {
    const result = await runScan(env, "manual", deps(board()));

    // Three, because `funding_max_positions` defaults to 3 — every one of the
    // 11 majors clears the 5% bar on this board.
    expect(result.positionsOpened).toBe(3);
    expect(result.positionsClosed).toBe(0);
    expect(result.carryAccruedUsdt).toBe(0);
    expect(result.carryError).toBeUndefined();

    const open = await openPositions();
    expect(open.map((p) => p.symbol)).toEqual(["BTC", "ETH", "BNB"]);

    const [btc] = open;
    expect(btc.venue).toBe("bybit");
    expect(btc.instrument).toBe("BTCUSDT");
    expect(btc.openedScanId).toBe(result.scanId);
    expect(btc.notionalUsdt).toBe(NOTIONAL);
    // The board's timestamp, not the scan's: the position is entered on the
    // quote it was opened from, so its accrual grid lines up with the data.
    expect(btc.entryTs).toBe(clock);
    expect(btc.entryRate).toBe(BEST_RATE);
    expect(btc.entryAnnualizedPct).toBeCloseTo(BEST_ANNUAL, 8);
    expect(btc.predictedNetAnnualPct).toBeCloseTo(BEST_NET, 6);
    expect(btc.intervalMinutes).toBe(480);
    // The fees in force at entry, so a later retune cannot re-price a position
    // that is already running.
    expect(btc.spotFeeRate).toBe(DEFAULTS.fee_rate);
    expect(btc.perpFeeRate).toBe(DEFAULTS.perp_fee_rate);
    // Nothing has settled yet, and nothing has been realised.
    expect(btc.accruedFundingUsdt).toBe(0);
    expect(btc.accrualCount).toBe(0);
    expect(btc.lastAccrualTs).toBeNull();
    expect(btc.closeTs).toBeNull();
    expect(btc.closeReason).toBeNull();
    expect(btc.realizedPnlUsdt).toBeNull();
    expect(btc.realizedAnnualPct).toBeNull();
  });

  it("never opens on an assumed settlement interval", async () => {
    // The annualised figure scales linearly with the cadence, so a contract
    // that really settles hourly is under-reported 8x. Tolerable on a board
    // that is only read; not tolerable as a position's accrual grid.
    const result = await runScan(env, "manual", deps(board({ intervalSource: "assumed" })));

    expect(result.fundingCount).toBe(ASSETS.length);
    expect(result.positionsOpened).toBe(0);
    await expect(positions()).resolves.toHaveLength(0);
  });

  it("opens the published-cadence row and skips the guessed one beside it", async () => {
    const fetchFunding: FundingFetcher = async () =>
      snapshotOf(
        [
          // Pays far more, and is a guess.
          fundingQuote("BTC", { rate: 0.001, intervalSource: "assumed" }),
          fundingQuote("ETH", { rate: BEST_RATE, intervalSource: "api" }),
        ],
        clock,
      );

    await runScan(env, "manual", deps(fetchFunding));

    const open = await openPositions();
    expect(open.map((p) => p.symbol)).toEqual(["ETH"]);
  });

  it("honours funding_max_positions", async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });

    const result = await runScan(env, "manual", deps(board()));
    expect(result.positionsOpened).toBe(1);

    clock += 60_000;
    const second = await runScan(env, "manual", deps(board()));
    expect(second.positionsOpened).toBe(0);
    await expect(openPositions()).resolves.toHaveLength(1);
  });

  it("keys the dedupe on (venue, symbol), not on symbol alone", async () => {
    // Two venues disagreeing about BTC is two measurements, so both are held —
    // and neither is opened twice.
    const fetchFunding = boardOf([
      ["bybit", "BTC", BEST_RATE],
      ["okx", "BTC", BEST_RATE - 0.00001],
    ]);

    const first = await runScan(env, "manual", deps(fetchFunding));
    expect(first.positionsOpened).toBe(2);

    clock += 60_000;
    const second = await runScan(env, "manual", deps(fetchFunding));
    expect(second.positionsOpened).toBe(0);

    const open = await openPositions();
    expect(open.map((p) => `${p.venue} ${p.symbol}`)).toEqual([
      "bybit BTC",
      "okx BTC",
    ]);
  });

  it("opens nothing below funding_min_annual_pct", async () => {
    await updateSettings(env.DB, { funding_min_annual_pct: 500 });

    const result = await runScan(env, "manual", deps(board()));

    // The board still lands in full — the threshold has never been a write-time
    // gate, and Phase 15 does not make it one.
    expect(result.fundingCount).toBe(ASSETS.length);
    expect(result.positionsOpened).toBe(0);
  });

  it("opens nothing while funding_positions_enabled is 0", async () => {
    await updateSettings(env.DB, { funding_positions_enabled: 0 });

    const result = await runScan(env, "manual", deps(board()));

    expect(result.fundingCount).toBe(ASSETS.length);
    expect(result.positionsOpened).toBe(0);
    await expect(positions()).resolves.toHaveLength(0);
  });
});

describe("runScan - accrual", () => {
  beforeEach(async () => {
    // One position keeps every figure below a single arithmetic statement.
    await updateSettings(env.DB, { funding_max_positions: 1 });
  });

  it("accrues nothing before the first settlement boundary", async () => {
    await runScan(env, "manual", deps(board()));

    clock += PERIOD_MS - 1;
    const result = await runScan(env, "manual", deps(board()));

    expect(result.carryAccruedUsdt).toBe(0);
    const [btc] = await openPositions();
    expect(btc.accruedFundingUsdt).toBe(0);
    expect(btc.accrualCount).toBe(0);
    expect(btc.lastAccrualTs).toBeNull();
  });

  it("accrues one settlement per boundary crossed", async () => {
    await runScan(env, "manual", deps(board()));

    clock += PERIOD_MS;
    const first = await runScan(env, "manual", deps(board()));
    expect(first.carryAccruedUsdt).toBeCloseTo(PER_SETTLEMENT, 8);

    clock += PERIOD_MS;
    await runScan(env, "manual", deps(board()));

    const [btc] = await openPositions();
    expect(btc.accrualCount).toBe(2);
    expect(btc.accruedFundingUsdt).toBeCloseTo(2 * PER_SETTLEMENT, 8);
    expect(btc.lastAccrualTs).toBe(T0 + 2 * PERIOD_MS);
  });

  it("pays the short leg negatively when funding flips against it", async () => {
    // The exit rule is disarmed so the flip is observed as an accrual rather
    // than immediately closing the position; the close path has its own test.
    await updateSettings(env.DB, { funding_exit_annual_pct: -1000 });
    await runScan(env, "manual", deps(board()));

    // The rate that settles at a boundary is the one published at it.
    clock += PERIOD_MS;
    const flipped = await runScan(
      env,
      "manual",
      deps(board({ rateFor: () => -BEST_RATE })),
    );

    expect(flipped.carryAccruedUsdt).toBeCloseTo(-PER_SETTLEMENT, 8);
    const [btc] = await openPositions();
    expect(btc.accruedFundingUsdt).toBeCloseTo(-PER_SETTLEMENT, 8);
    // A cost is still an observed settlement: the count is a data-coverage
    // figure, not a profit one.
    expect(btc.accrualCount).toBe(1);
  });

  it("catches up several boundaries at once, skipping the unobserved ones", async () => {
    await runScan(env, "manual", deps(board()));

    // Three days later, with no poll in between: 9 boundaries elapsed, but the
    // only rates on disk are the entry board and this one. The three boundaries
    // within 24h of the entry board are priced by it; the five in the middle
    // have no observation within a day and are skipped outright rather than
    // estimated; the last is priced by the board this poll just wrote.
    clock += 3 * DAY_MS;
    const result = await runScan(env, "manual", deps(board()));

    expect(result.carryAccruedUsdt).toBeCloseTo(4 * PER_SETTLEMENT, 8);

    const [btc] = await openPositions();
    expect(btc.accrualCount).toBe(4);
    expect(btc.accruedFundingUsdt).toBeCloseTo(4 * PER_SETTLEMENT, 8);
    // The grid advanced past the skipped boundaries: the rows that would have
    // priced them do not exist, so they are never re-walked.
    expect(btc.lastAccrualTs).toBe(T0 + 3 * DAY_MS);
  });

  it("anchors the grid to the venue's next-funding timestamp when it has one", async () => {
    // A venue settling one hour off the epoch grid, quoting the *next* boundary
    // on that fixed grid each poll — as a real venue does. The first boundary
    // after entry is therefore T0 + 1h, not T0 + 8h.
    const anchor = T0 + HOUR_MS;
    const anchored = (): FundingFetcher =>
      board({
        nextFundingTs:
          anchor + Math.floor((clock - anchor) / PERIOD_MS + 1) * PERIOD_MS,
      });

    await runScan(env, "manual", deps(anchored()));

    clock += HOUR_MS;
    const result = await runScan(env, "manual", deps(anchored()));

    expect(result.carryAccruedUsdt).toBeCloseTo(PER_SETTLEMENT, 8);
    const [btc] = await openPositions();
    expect(btc.lastAccrualTs).toBe(T0 + HOUR_MS);
  });

  it("keeps one grid when the venue's published anchor flickers", async () => {
    // Regression. The anchor used to be re-read from the newest rate row on
    // every pass, so a venue that publishes `nextFundingTime`, omits it on the
    // next poll and then publishes a *shifted* one moved the grid's phase under
    // a running position — and a boundary the last pass stopped at is no longer
    // on the grid the next pass computes, so a settlement gets paid twice (or
    // dropped). The position's own `last_accrual_ts` is the anchor once it has
    // one, so the grid it has been accruing on is the grid it keeps.
    await updateSettings(env.DB, { funding_max_positions: 1 });

    // A venue settling an hour off the epoch grid: T0+1h, T0+9h, T0+17h. It
    // quotes the next boundary on that grid each poll, as a real venue does.
    const PHASE = T0 + HOUR_MS;
    const published = (shift = 0): FundingFetcher => {
      const base = PHASE + shift;
      return board({
        nextFundingTs:
          base + Math.floor((clock - base) / PERIOD_MS + 1) * PERIOD_MS,
      });
    };

    // Entry, with the anchor published.
    await runScan(env, "manual", deps(published()));

    // Still published: the first boundary, T0+1h, is accrued and becomes the
    // position's anchor.
    clock = T0 + 2 * HOUR_MS;
    await runScan(env, "manual", deps(published()));

    // The venue stops publishing. On the old anchor this fell back to the epoch
    // grid and paid T0+8h — an hour early, and off the position's own schedule.
    clock = T0 + 9 * HOUR_MS + 30 * 60_000;
    await runScan(env, "manual", deps(board()));

    // Published again, and 20 minutes later than before. On the old anchor this
    // grid no longer passed through what the last pass had booked, so it paid
    // *two* boundaries and the settlement around T0+9h was collected twice.
    clock = T0 + 17 * HOUR_MS + 30 * 60_000;
    await runScan(env, "manual", deps(published(20 * 60_000)));

    const [btc] = await openPositions();
    // Three settlements elapsed on the venue's schedule — T0+1h, T0+9h, T0+17h
    // — and each was paid exactly once.
    expect(btc.accrualCount).toBe(3);
    expect(btc.accruedFundingUsdt).toBeCloseTo(3 * PER_SETTLEMENT, 8);
    expect(btc.lastAccrualTs).toBe(T0 + 17 * HOUR_MS);
  });

  it("accrues each position independently", async () => {
    await updateSettings(env.DB, { funding_max_positions: 2 });
    await runScan(env, "manual", deps(board()));

    clock += PERIOD_MS;
    const result = await runScan(env, "manual", deps(board()));

    const open = await openPositions();
    expect(open.map((p) => p.symbol)).toEqual(["BTC", "ETH"]);
    expect(open[0].accruedFundingUsdt).toBeCloseTo(BEST_RATE * NOTIONAL, 8);
    expect(open[1].accruedFundingUsdt).toBeCloseTo(0.00019 * NOTIONAL, 8);
    expect(result.carryAccruedUsdt).toBeCloseTo(
      (BEST_RATE + 0.00019) * NOTIONAL,
      8,
    );
  });
});

describe("runScan - closing carry positions", () => {
  beforeEach(async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });
  });

  it("closes on max_hold and annualises over the actual hold", async () => {
    // A 7-day horizon still clears the 5% bar (21.9% less a 15.64% drag is
    // 6.26%), which a 1-day horizon would not — the drag is the reason the
    // holding period is part of the decision at all.
    await updateSettings(env.DB, { funding_hold_days: 7 });
    await runScan(env, "manual", deps(board()));

    clock += 7 * DAY_MS;
    const result = await runScan(env, "manual", deps(board()));

    expect(result.positionsClosed).toBe(1);

    const [btc] = await positions();
    expect(btc.status).toBe("closed");
    expect(btc.closeReason).toBe("max_hold");
    expect(btc.closeTs).toBe(T0 + 7 * DAY_MS);
    // 21 boundaries elapsed; four had an observed rate behind them.
    expect(btc.accrualCount).toBe(4);
    const accrued = 4 * PER_SETTLEMENT;
    expect(btc.accruedFundingUsdt).toBeCloseTo(accrued, 8);
    // 0.8 collected against a 3.00 round trip: this carry lost.
    expect(btc.realizedPnlUsdt).toBeCloseTo(accrued - ROUND_TRIP_FEE, 8);
    expect(btc.realizedAnnualPct).toBeCloseTo(
      ((accrued - ROUND_TRIP_FEE) / NOTIONAL) * (365 / 7) * 100,
      6,
    );
    // And the pair this whole table exists for: predicted 6.26%, realised
    // -11.47%. The gap is the extrapolation error, measured.
    expect(btc.predictedNetAnnualPct).toBeGreaterThan(0);
    expect(btc.realizedAnnualPct!).toBeLessThan(btc.predictedNetAnnualPct);
  });

  it("closes when the net carry falls below funding_exit_annual_pct", async () => {
    await runScan(env, "manual", deps(board()));

    // A day later the whole board has flipped negative: two boundaries priced
    // by the entry board, the third by this one.
    clock += DAY_MS;
    const result = await runScan(
      env,
      "manual",
      deps(board({ rateFor: () => -BEST_RATE })),
    );

    expect(result.positionsClosed).toBe(1);

    const [btc] = await positions();
    expect(btc.closeReason).toBe("rate_below_exit");
    const accrued = PER_SETTLEMENT;
    expect(btc.accrualCount).toBe(3);
    expect(btc.accruedFundingUsdt).toBeCloseTo(accrued, 8);
    expect(btc.realizedPnlUsdt).toBeCloseTo(accrued - ROUND_TRIP_FEE, 8);
    expect(btc.realizedAnnualPct).toBeCloseTo(
      ((accrued - ROUND_TRIP_FEE) / NOTIONAL) * 365 * 100,
      6,
    );
  });

  it("holds a position whose carry merely shrank, and closes it when it turns", async () => {
    await updateSettings(env.DB, { funding_exit_annual_pct: 0 });
    await runScan(env, "manual", deps(board()));

    // Still positive, well below the 5% opening bar: the bar to stay is
    // deliberately lower than the bar to enter, because the round trip is paid.
    clock += 60_000;
    const shrunk = await runScan(
      env,
      "manual",
      deps(board({ rateFor: () => 0.00004 })),
    );
    expect(shrunk.positionsClosed).toBe(0);
    // ...and nothing new opened either: 4.38% annual is below the 5% bar.
    expect(shrunk.positionsOpened).toBe(0);

    clock += 60_000;
    const turned = await runScan(
      env,
      "manual",
      deps(board({ rateFor: () => -0.00001 })),
    );
    expect(turned.positionsClosed).toBe(1);
    expect((await positions())[0].closeReason).toBe("rate_below_exit");
  });

  it("closes on stale data when the venue stops quoting the contract", async () => {
    await runScan(env, "manual", deps(board()));

    // BTC drops off every board. 25 hours later nothing fresh has been seen for
    // it, so the position is closed rather than left accruing an entry rate
    // with no evidence behind it.
    clock += 25 * HOUR_MS;
    const withoutBtc: FundingFetcher = async (assets) =>
      snapshotOf(
        assets
          .filter((symbol) => symbol !== "BTC")
          .map((symbol, i) =>
            fundingQuote(symbol, { rate: BEST_RATE - i * 0.00001 }),
          ),
        clock,
      );
    const result = await runScan(env, "manual", deps(withoutBtc));

    expect(result.positionsClosed).toBe(1);
    const [btc] = await positions();
    expect(btc.closeReason).toBe("stale_data");
    // The three boundaries inside the 24h window were still paid on the way
    // out: accrual runs before the close rules precisely so an exit never
    // forfeits settlements the scanner did observe.
    expect(btc.accrualCount).toBe(3);
    expect(btc.accruedFundingUsdt).toBeCloseTo(3 * PER_SETTLEMENT, 8);

    // The freed slot is refilled in the same pass — close runs before open.
    expect(result.positionsOpened).toBe(1);
    const open = await openPositions();
    expect(open).toHaveLength(1);
    expect(open[0].symbol).toBe("ETH");
  });

  it("keeps accruing and closing while funding_positions_enabled is 0", async () => {
    // The switch gates *opening*. Flipping it must not strand an open book with
    // a P&L frozen mid-flight.
    await runScan(env, "manual", deps(board()));
    await updateSettings(env.DB, { funding_positions_enabled: 0 });

    clock += PERIOD_MS;
    const accruing = await runScan(env, "manual", deps(board()));
    expect(accruing.carryAccruedUsdt).toBeCloseTo(PER_SETTLEMENT, 8);
    expect(accruing.positionsOpened).toBe(0);

    clock += 60_000;
    const closing = await runScan(
      env,
      "manual",
      deps(board({ rateFor: () => -BEST_RATE })),
    );
    expect(closing.positionsClosed).toBe(1);
    expect(closing.positionsOpened).toBe(0);
  });

  it("never moves a balance", async () => {
    // Migration 0005's whole premise: a position held for days cannot be booked
    // against a paper balance whose history is atomic round trips.
    const before = await env.DB.prepare("SELECT asset, amount FROM balances").all();

    await runScan(env, "manual", deps(board()));
    clock += DAY_MS;
    await runScan(env, "manual", deps(board({ rateFor: () => -BEST_RATE })));

    expect((await positions())[0].status).toBe("closed");
    const after = await env.DB.prepare("SELECT asset, amount FROM balances").all();
    expect(after.results).toEqual(before.results);
    // And nothing booked a trade either.
    const trades = await env.DB.prepare("SELECT COUNT(*) AS n FROM trades").first<{
      n: number;
    }>();
    expect(trades?.n).toBe(0);
  });
});

describe("runScan - carry degradation isolation", () => {
  it("keeps the board and the spreads when the carry pass throws", async () => {
    // The bluntest carry-layer failure there is. The board must still land:
    // carry runs after the rows are committed, in a catch of its own.
    await env.DB.exec("DROP TABLE funding_positions");

    const result = await runScan(env, "manual", deps(board()));

    expect(result.carryError).toBeTruthy();
    expect(result.positionsOpened).toBe(0);
    expect(result.positionsClosed).toBe(0);

    // Everything else is untouched.
    expect(result.fundingError).toBeUndefined();
    expect(result.fundingCount).toBe(ASSETS.length);
    expect(result.error).toBeUndefined();
    expect(result.xchgError).toBeUndefined();
    expect(result.spreadsCount).toBe(2);
    await expect(listOpportunities(env.DB, 50)).resolves.toHaveLength(2);

    const [scan] = await listScans(env.DB, 1);
    expect(scan.error).toBeNull();
    expect(scan.xchg_error).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM funding_rates",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(ASSETS.length);
  });

  it("runs no carry pass at all when the funding poll itself failed", async () => {
    const result = await runScan(env, "manual", {
      ...deps(board()),
      fetchFunding: async () => {
        throw new Error("no funding-rate source available (bybit: HTTP 403)");
      },
    });

    expect(result.fundingError).toContain("no funding-rate source available");
    expect(result.carryError).toBeUndefined();
    expect(result.positionsOpened).toBe(0);
    await expect(positions()).resolves.toHaveLength(0);
  });
});

/**
 * The full carry lifecycle on a **capped Gate board**, which is the shape the
 * production scanner actually persists and the one the rest of this file's
 * Bybit fixtures cannot produce: Bybit is polled per major and has no tail, so
 * nothing on its board can ever be capped away.
 *
 * The bug this pins: a position is opened on a tail contract *because* it paid,
 * the rate decays, the contract falls out of the 20-top/5-bottom cap, and its
 * rows stop being written. `getLatestFundingRateFor` then freezes on the last
 * row persisted — one that still clears the exit bar — so `rate_below_exit` can
 * never fire, the position idles for 24 hours and dies of `stale_data` with a
 * fee-only loss. That loss lands in `GET /api/report` looking like a prediction
 * error, which is the acceptance measurement, so a board artefact was arriving
 * dressed as a finding about the strategy.
 */
describe("runScan - a held tail contract decaying out of the capped board", () => {
  /** Gate's 30 non-major contracts; `TAIL00` is the one a position is opened on. */
  const TAILS = Array.from({ length: 30 }, (_, i) => `TAIL${String(i).padStart(2, "0")}`);

  /** The majors, priced under the 5% opening bar so nothing opens on them. */
  const MAJOR_RATE = 0.00005; // 5.475%/yr gross, 1.825% net — below the bar.

  /**
   * Phase 1: `TAIL00` is the best-paying contract on the board, so it is inside
   * the top 20 and a position opens on it.
   */
  function phaseOne(): Array<[FundingVenue, string, number]> {
    return [
      ...ASSETS.map((s) => ["gate", s, MAJOR_RATE] as [FundingVenue, string, number]),
      ["gate", "TAIL00", 0.0002],
      ...TAILS.slice(1).map(
        (s, i) => ["gate", s, 0.00015 - i * 0.000001] as [FundingVenue, string, number],
      ),
    ];
  }

  /**
   * Phase 2: `TAIL00` has collapsed to 0.1095%/yr gross (−3.54% net, below the
   * zero exit bar) and now ranks **25th** of Gate's 30 non-majors — outside the
   * best 20 and outside the worst 5, which are held by the five negative
   * contracts below it. Exactly the dead zone the cap discards.
   */
  function phaseTwo(): Array<[FundingVenue, string, number]> {
    return [
      ...ASSETS.map((s) => ["gate", s, MAJOR_RATE] as [FundingVenue, string, number]),
      // Ranks 1-20.
      ...TAILS.slice(1, 21).map(
        (s, i) => ["gate", s, 0.00015 - i * 0.000001] as [FundingVenue, string, number],
      ),
      // Ranks 21-24: the rows that prove the dead zone is real, because they
      // are dropped and `TAIL00` — identically placed — is not.
      ...TAILS.slice(21, 25).map(
        (s, i) => ["gate", s, 0.0001 - i * 0.000001] as [FundingVenue, string, number],
      ),
      // Rank 25: the held contract, decayed.
      ["gate", "TAIL00", 0.000001],
      // Ranks 26-30: the deepest negatives, which own the bottom-5 budget.
      ...TAILS.slice(25).map(
        (s, i) => ["gate", s, -0.0001 - i * 0.00001] as [FundingVenue, string, number],
      ),
    ];
  }

  /** The `(venue, symbol)` pairs persisted at the newest board timestamp. */
  async function latestBoard(): Promise<string[]> {
    const { results } = await env.DB.prepare(
      "SELECT venue, symbol FROM funding_rates" +
        " WHERE ts = (SELECT MAX(ts) FROM funding_rates)",
    ).all<{ venue: string; symbol: string }>();
    return (results ?? []).map((r) => `${r.venue}:${r.symbol}`);
  }

  beforeEach(async () => {
    // One slot, so the position under test is the only one on the book.
    await updateSettings(env.DB, { funding_max_positions: 1 });
  });

  it("keeps writing its rows, so rate_below_exit fires instead of stale_data", async () => {
    const first = await runScan(env, "manual", deps(boardOf(phaseOne())));
    expect(first.positionsOpened).toBe(1);

    const [held] = await openPositions();
    expect(held.venue).toBe("gate");
    expect(held.symbol).toBe("TAIL00");
    expect(held.entryTs).toBe(T0);

    // The cap is doing its job at this point: 11 majors + 25 of the 30 tails.
    expect(await latestBoard()).toHaveLength(ASSETS.length + 25);

    // One settlement later, on a board where the contract has decayed into the
    // dead zone between the two halves of the cap.
    clock = T0 + PERIOD_MS;
    const second = await runScan(env, "manual", deps(boardOf(phaseTwo())));

    const board = await latestBoard();
    // The dead zone is real: its four neighbours were all dropped...
    for (const dropped of ["TAIL21", "TAIL22", "TAIL23", "TAIL24"]) {
      expect(board, dropped).not.toContain(`gate:${dropped}`);
    }
    // ...and the held contract, which ranks below every one of them, was kept
    // anyway. That is the keep-set, and nothing else could have kept it.
    expect(board).toContain("gate:TAIL00");
    // Additive to the budget, not carved out of it: 25 tail rows plus the one
    // retained contract, plus the majors.
    expect(board).toHaveLength(ASSETS.length + 26);

    // ...so the position is closed by the *rate*, on the pass that saw it fall,
    // rather than idling for 24 hours and dying of a data outage that never
    // happened.
    expect(second.positionsClosed).toBe(1);
    const [closed] = (await positions()).filter((p) => p.status === "closed");
    expect(closed.symbol).toBe("TAIL00");
    expect(closed.closeReason).toBe("rate_below_exit");
    expect(closed.closeTs).toBe(clock);
    // One settlement was booked before it closed: accrue-then-close, so the
    // exit does not forfeit the funding the position actually saw. It is
    // priced at the row in force *at the boundary* — this poll's decayed one,
    // which lands on the boundary exactly — not at the entry rate.
    expect(closed.accrualCount).toBe(1);
    expect(closed.accruedFundingUsdt).toBeCloseTo(0.000001 * NOTIONAL, 8);
    expect(closed.realizedPnlUsdt).toBeCloseTo(0.000001 * NOTIONAL - ROUND_TRIP_FEE, 6);
    // Which is the finding, stated plainly: the fee-only loss is *real* here,
    // and it is attributed to a rate that collapsed rather than to a board that
    // stopped reporting. Under the old cap this same position would still be
    // open, accruing nothing, 23 hours from a `stale_data` close.
    expect(closed.realizedPnlUsdt).toBeLessThan(0);
  });

  it("reports the close under its own reason, not blended into the mean", async () => {
    await runScan(env, "manual", deps(boardOf(phaseOne())));
    clock = T0 + PERIOD_MS;
    await runScan(env, "manual", deps(boardOf(phaseTwo())));

    // `buildReport` rather than the route, because the route reads the wall
    // clock and this suite's clock is an epoch-aligned fiction.
    const body = await buildReport(env.DB, { requested: 7, days: 7 }, clock);

    // The acceptance answer names the population it is made of. A `max_hold`
    // close cannot appear inside a 7-day window against a 30-day planned hold,
    // and the absence is visible here rather than something a reader has to
    // know to look for.
    expect(body.answers.realizedVsPredictedCarry.closedCount).toBe(1);
    expect(body.answers.realizedVsPredictedCarry.closeReasons).toEqual({
      rate_below_exit: 1,
    });

    // And the accrual coverage behind it: one settlement spanned, one booked.
    // A close that had booked none of them would be a hole in the data rather
    // than a carry that paid nothing.
    const [reason] = body.carry.closeReasons;
    expect(reason.reason).toBe("rate_below_exit");
    expect(reason.count).toBe(1);
    expect(reason.avgAccrualCount).toBe(1);
    expect(reason.avgSpannedSettlements).toBe(1);
  });
});

describe("resetAll - carry positions", () => {
  beforeEach(async () => {
    await runScan(env, "manual", deps(board()));
    await expect(positions()).resolves.toHaveLength(3);
  });

  it("clears positions with the rates they were opened on", async () => {
    await resetAll(env.DB, { wipeHistory: true });
    await expect(positions()).resolves.toHaveLength(0);
  });

  it("keeps them when history is kept", async () => {
    await resetAll(env.DB, { wipeHistory: false });
    await expect(positions()).resolves.toHaveLength(3);
  });
});

interface PositionsBody {
  openCount: number;
  closedCount: number;
  limit: number;
  summary: {
    openCount: number;
    closedCount: number;
    openNotionalUsdt: number;
    accruedUsdt: number;
    realizedPnlUsdt: number;
    avgPredictionErrorPct: number | null;
  };
  settings: Record<string, number | boolean>;
  open: FundingPosition[];
  closed: FundingPosition[];
}

describe("GET /api/funding/positions", () => {
  it("answers 200 with an empty book before anything is opened", async () => {
    const res = await get("/api/funding/positions");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PositionsBody;
    expect(body.open).toEqual([]);
    expect(body.closed).toEqual([]);
    expect(body.summary.openCount).toBe(0);
    expect(body.summary.openNotionalUsdt).toBe(0);
    expect(body.summary.realizedPnlUsdt).toBe(0);
    // An average of no positions is not zero.
    expect(body.summary.avgPredictionErrorPct).toBeNull();
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.maxPositions).toBe(DEFAULTS.funding_max_positions);
  });

  it("reports the open book and its notional", async () => {
    await runScan(env, "manual", deps(board()));

    const body = (await (await get("/api/funding/positions")).json()) as PositionsBody;
    expect(body.openCount).toBe(3);
    expect(body.open.map((p) => p.symbol)).toEqual(["BTC", "ETH", "BNB"]);
    expect(body.summary.openNotionalUsdt).toBe(3 * NOTIONAL);
    expect(body.summary.accruedUsdt).toBe(0);
  });

  it("reports the realised figures and the prediction error once positions close", async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });
    await runScan(env, "manual", deps(board()));

    clock += DAY_MS;
    await runScan(env, "manual", deps(board({ rateFor: () => -BEST_RATE })));

    const body = (await (await get("/api/funding/positions")).json()) as PositionsBody;
    // Nothing replaced it: the whole board is negative, so no row qualifies.
    expect(body.openCount).toBe(0);
    expect(body.closedCount).toBe(1);

    const [closed] = body.closed;
    expect(closed.status).toBe("closed");
    expect(closed.closeReason).toBe("rate_below_exit");
    expect(closed.realizedPnlUsdt).toBeCloseTo(PER_SETTLEMENT - ROUND_TRIP_FEE, 8);

    // The headline of the whole feature: what the entry rate promised against
    // what the position actually paid.
    expect(body.summary.avgPredictionErrorPct).toBeCloseTo(
      closed.realizedAnnualPct! - closed.predictedNetAnnualPct,
      6,
    );
    expect(body.summary.avgPredictionErrorPct!).toBeLessThan(0);
    expect(body.summary.realizedPnlUsdt).toBeCloseTo(
      closed.realizedPnlUsdt!,
      8,
    );
  });
});

describe("POST /api/funding/positions/:id/close", () => {
  it("closes an open position with reason 'manual'", async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });
    await runScan(env, "manual", deps(board()));
    const [open] = await openPositions();

    const res = await post(`/api/funding/positions/${open.id}/close`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; position: FundingPosition };
    expect(body.ok).toBe(true);
    expect(body.position.status).toBe("closed");
    expect(body.position.closeReason).toBe("manual");
    // Nothing had settled, so the realised P&L is exactly the round trip.
    expect(body.position.realizedPnlUsdt).toBeCloseTo(-ROUND_TRIP_FEE, 8);

    await expect(openPositions()).resolves.toHaveLength(0);
  });

  it("answers 409 on a second close rather than rewriting the first", async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });
    await runScan(env, "manual", deps(board()));
    const [open] = await openPositions();

    await post(`/api/funding/positions/${open.id}/close`);
    const again = await post(`/api/funding/positions/${open.id}/close`);
    expect(again.status).toBe(409);

    // The original close survived untouched.
    const [row] = await positions();
    expect(row.closeReason).toBe("manual");
  });

  it("answers 404 for an unknown id and 400 for a junk one", async () => {
    expect((await post("/api/funding/positions/9999/close")).status).toBe(404);
    expect((await post("/api/funding/positions/abc/close")).status).toBe(400);
    expect((await post("/api/funding/positions/0/close")).status).toBe(400);
  });
});

describe("GET /api/portfolio - carry section", () => {
  it("reports carry beside the spot figures, never inside them", async () => {
    await updateSettings(env.DB, { funding_max_positions: 1 });
    await runScan(env, "manual", deps(board()));
    clock += PERIOD_MS;
    await runScan(env, "manual", deps(board()));

    const body = (await (await get("/api/portfolio")).json()) as {
      equityUsdt: number;
      initialUsdt: number;
      pnl: { absUsdt: number };
      carry: {
        openCount: number;
        openNotionalUsdt: number;
        accruedUsdt: number;
        realizedPnlUsdt: number;
      };
    };

    expect(body.carry.openCount).toBe(1);
    expect(body.carry.openNotionalUsdt).toBe(NOTIONAL);
    expect(body.carry.accruedUsdt).toBeCloseTo(PER_SETTLEMENT, 8);

    // The spot half is exactly what it was before Phase 15: a 1000 USDT
    // position and 0.20 of accrued funding have moved nothing.
    expect(body.equityUsdt).toBe(DEFAULTS.initial_usdt);
    expect(body.pnl.absUsdt).toBe(0);
  });
});

describe("PUT /api/settings - the carry tunables", () => {
  it("seeds all four with their defaults", async () => {
    const body = (await (await get("/api/settings")).json()) as Record<string, number>;
    expect(body.funding_positions_enabled).toBe(1);
    expect(body.funding_position_size_usdt).toBe(1000);
    expect(body.funding_max_positions).toBe(3);
    expect(body.funding_exit_annual_pct).toBe(0);
  });

  it("accepts sane values", async () => {
    const res = await put("/api/settings", {
      funding_positions_enabled: 0,
      funding_position_size_usdt: 250,
      funding_max_positions: 10,
      funding_exit_annual_pct: -5,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      funding_positions_enabled: 0,
      funding_position_size_usdt: 250,
      funding_max_positions: 10,
      funding_exit_annual_pct: -5,
    });
  });

  it("rejects a non-flag funding_positions_enabled", async () => {
    const res = await put("/api/settings", { funding_positions_enabled: 2 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive position size", async () => {
    expect((await put("/api/settings", { funding_position_size_usdt: 0 })).status).toBe(
      400,
    );
    expect((await put("/api/settings", { funding_position_size_usdt: -5 })).status).toBe(
      400,
    );
  });

  it("rejects a fractional or out-of-range funding_max_positions", async () => {
    for (const bad of [0, 2.5, 21, -1]) {
      expect(
        (await put("/api/settings", { funding_max_positions: bad })).status,
        String(bad),
      ).toBe(400);
    }
  });

  it("takes any finite funding_exit_annual_pct — it is a threshold, not a rate", async () => {
    expect((await put("/api/settings", { funding_exit_annual_pct: -1000 })).status).toBe(
      200,
    );
    expect(
      (await put("/api/settings", { funding_exit_annual_pct: Number.NaN })).status,
    ).toBe(400);
  });
});
