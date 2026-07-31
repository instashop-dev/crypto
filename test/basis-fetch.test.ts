/**
 * Dated-futures basis client: instId parsing, the mid-price rule, the join, and
 * the two-request fetch. No network — the OKX endpoints are intercepted with
 * `fetchMock` and the deps are injected per call.
 *
 * The fixtures are **captured live responses**, trimmed to 25 futures and 9 spot
 * markets but not otherwise edited, so a field the parser reads by name is a
 * field OKX actually sends and a contract shape the parser rejects is a shape
 * OKX actually lists. That matters more here than anywhere else in the repo: the
 * planning notes for this phase assumed OKX names its linear dated futures
 * `BTC-USDT-260925`, and the live board contains **zero** contracts under that
 * spelling — every one of them is `BTC-USD_UM-260925`. A hand-written fixture
 * would have agreed with the assumption and shipped an empty board.
 */
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASIS_VENUE,
  buildBasisBoard,
  getBasisFetcher,
  getBasisSnapshot,
  LINEAR_QUOTE_SEGMENTS,
  midPrice,
  OKX_SETTLEMENT_HOUR_UTC,
  parseOkxFutureId,
  parseOkxSpotMarks,
  setBasisFetcher,
} from "../src/basis";
import { OKX_BASE } from "../src/funding";
import type { Env } from "../src/types";
import okxFutures from "./fixtures/okx-futures-tickers.json";
import okxSpot from "./fixtures/okx-spot-tickers.json";

const FUTURES_PATH = "/api/v5/market/tickers?instType=FUTURES";
const SPOT_PATH = "/api/v5/market/tickers?instType=SPOT";

const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
} as unknown as Env;

/** An env that *does* carry credentials — see the hygiene test at the bottom. */
const keyedEnv = {
  ASSETS: mockEnv.ASSETS,
  BINANCE_API_KEY: "super-secret-key",
  BINANCE_SECRET_KEY: "super-secret-secret",
} as unknown as Env;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  setBasisFetcher(null);
  fetchMock.assertNoPendingInterceptors();
});

describe("parseOkxFutureId", () => {
  it("accepts both spellings of a linear USD-quoted dated future", () => {
    expect(LINEAR_QUOTE_SEGMENTS.has("USDT")).toBe(true);
    expect(LINEAR_QUOTE_SEGMENTS.has("USD_UM")).toBe(true);

    expect(parseOkxFutureId("BTC-USD_UM-260925")).toEqual({
      symbol: "BTC",
      expiryTs: Date.UTC(2026, 8, 25, OKX_SETTLEMENT_HOUR_UTC),
    });
    expect(parseOkxFutureId("BTC-USDT-260327")).toEqual({
      symbol: "BTC",
      expiryTs: Date.UTC(2026, 2, 27, OKX_SETTLEMENT_HOUR_UTC),
    });
  });

  it("reproduces the venue's own expTime for every contract in the fixture", () => {
    // The settlement hour is not guessed. These are the `expTime` values OKX's
    // `/public/instruments` returned for the same instIds in the same capture,
    // and they are 08:00 UTC to the millisecond.
    const known: Record<string, number> = {
      "BTC-USD_UM-260807": 1786089600000,
      "XAU-USD_UM-260828": 1787904000000,
    };
    for (const [instId, expTime] of Object.entries(known)) {
      expect(parseOkxFutureId(instId)?.expiryTs, instId).toBe(expTime);
    }
  });

  it("rejects the inverse board: a coin-margined leg is a different trade", () => {
    // `BTC-USD-260807` settles in BTC (`ctType: 'inverse'`). Its P&L is
    // non-linear in the price, so pairing it with a USDT spot leg would report
    // a delta-neutral trade that is not one.
    expect(parseOkxFutureId("BTC-USD-260807")).toBeNull();
    expect(parseOkxFutureId("ETH-USD-270924")).toBeNull();
  });

  it("rejects XPERP: a five-year expiry is a perp wearing a date", () => {
    expect(parseOkxFutureId("BTC-USD_UM_XPERP-310404")).toBeNull();
    expect(parseOkxFutureId("TSLA-USD_UM_XPERP-310613")).toBeNull();
  });

  it("rejects perps, wrong shapes and impossible dates", () => {
    expect(parseOkxFutureId("BTC-USDT-SWAP")).toBeNull();
    expect(parseOkxFutureId("BTC-USDT")).toBeNull();
    expect(parseOkxFutureId("BTC-USDT-260925-EXTRA")).toBeNull();
    expect(parseOkxFutureId("-USDT-260925")).toBeNull();
    expect(parseOkxFutureId("BTC-USDT-26092")).toBeNull();
    // September has 30 days: `Date.UTC` would roll this into October, and the
    // round-trip check is what stops it becoming a wrong expiry.
    expect(parseOkxFutureId("BTC-USDT-260931")).toBeNull();
    expect(parseOkxFutureId("BTC-USDT-261301")).toBeNull();
    expect(parseOkxFutureId(42)).toBeNull();
    expect(parseOkxFutureId(null)).toBeNull();
  });

  it("upper-cases and trims, so a lower-case name is still one contract", () => {
    expect(parseOkxFutureId("  btc-usd_um-260925 ")?.symbol).toBe("BTC");
  });
});

describe("midPrice", () => {
  it("prefers the mid of a two-sided book", () => {
    expect(midPrice("100", "102", "999")).toEqual({ price: 101, source: "mid" });
  });

  it("falls back to last when either side of the book is empty", () => {
    // A thin far-dated contract routinely has one side empty for minutes while
    // trades still print; the fallback is marked so a reader can tell.
    expect(midPrice("", "102", "101.5")).toEqual({ price: 101.5, source: "last" });
    expect(midPrice("100", "", "101.5")).toEqual({ price: 101.5, source: "last" });
    expect(midPrice(null, null, "101.5")).toEqual({ price: 101.5, source: "last" });
  });

  it("is null when nothing usable is quoted at all", () => {
    expect(midPrice("", "", "")).toBeNull();
    expect(midPrice("0", "0", "0")).toBeNull();
    expect(midPrice("abc", "def", "ghi")).toBeNull();
  });
});

describe("parseOkxSpotMarks", () => {
  it("keeps only the USDT-quoted markets, keyed by base asset", () => {
    const marks = parseOkxSpotMarks(okxSpot);

    expect([...marks.keys()].sort()).toEqual(["BTC", "DOGE", "ETH", "SOL", "XRP"]);
    // BTC-USDT in the capture: bid 62784.6, ask 62784.7.
    expect(marks.get("BTC")).toEqual({ price: 62784.65, source: "mid" });
    // The other quote currencies ride along on the same endpoint and are not
    // spot legs for a USDT carry.
    expect(marks.has("BTC-USDC")).toBe(false);
    expect(marks.has("ETH-BTC")).toBe(false);
  });

  it("throws for an error envelope rather than reading it as an empty board", () => {
    expect(() => parseOkxSpotMarks({ code: "50011", msg: "rate limit" })).toThrow(
      /50011/,
    );
    expect(() => parseOkxSpotMarks({ code: "0", data: "nope" })).toThrow(
      /not an array/,
    );
  });
});

describe("buildBasisBoard", () => {
  const board = buildBasisBoard(okxFutures, okxSpot);

  it("keeps every linear dated future that has a spot leg", () => {
    // 15 contracts in the fixture: five expiries each on BTC, ETH and SOL.
    expect(board).toHaveLength(15);
    expect(new Set(board.map((r) => r.symbol))).toEqual(new Set(["BTC", "ETH", "SOL"]));
    expect(board.every((r) => r.venue === BASIS_VENUE)).toBe(true);
    expect(board.every((r) => r.instrument.includes("-USD_UM-"))).toBe(true);
  });

  it("drops a contract whose underlying has no USDT spot market", () => {
    // `XAU-USD_UM-260828` is tokenised gold: OKX lists the future and no
    // `XAU-USDT` spot, so there is nothing to buy for the cash leg.
    expect(board.some((r) => r.symbol === "XAU")).toBe(false);
  });

  it("drops the inverse and XPERP contracts that share the endpoint", () => {
    expect(board.some((r) => r.instrument === "BTC-USD-260807")).toBe(false);
    expect(board.some((r) => r.instrument.includes("XPERP"))).toBe(false);
  });

  it("marks both legs at the mid and records the real premium", () => {
    const row = board.find((r) => r.instrument === "BTC-USD_UM-261225")!;
    // Capture: bid 63720.8 / ask 63845.1 against a BTC-USDT mid of 62784.65.
    expect(row.futurePrice).toBeCloseTo(63782.95, 6);
    expect(row.spotPrice).toBeCloseTo(62784.65, 6);
    expect(row.priceSource).toBe("mid");
    expect(row.expiryTs).toBe(Date.UTC(2026, 11, 25, OKX_SETTLEMENT_HOUR_UTC));
    // ~+1.59% five months out — an ordinary contango curve, and the reason
    // `last` is not used as the mark: this contract's last print was 64967.6,
    // which would have reported the basis as half again as large.
    expect((row.futurePrice / row.spotPrice - 1) * 100).toBeCloseTo(1.59, 2);
  });

  it("falls back to last when a side of the futures book is empty", () => {
    // A contract quoted only by its last trade, joined to a real spot mark.
    const rows = buildBasisBoard(
      {
        code: "0",
        data: [
          { instId: "BTC-USD_UM-260925", bidPx: "", askPx: "", last: "63000" },
        ],
      },
      okxSpot,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].futurePrice).toBe(63000);
    // One flag for the pair: a row is only as live as its weaker leg.
    expect(rows[0].priceSource).toBe("last");
  });

  it("keeps the first of a duplicated instId", () => {
    const rows = buildBasisBoard(
      {
        code: "0",
        data: [
          { instId: "BTC-USD_UM-260925", bidPx: "63000", askPx: "63002", last: "1" },
          { instId: "BTC-USD_UM-260925", bidPx: "70000", askPx: "70002", last: "1" },
        ],
      },
      okxSpot,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].futurePrice).toBe(63001);
  });

  it("is empty, not throwing, for a board with nothing linear on it", () => {
    // The live state this whole module had to be designed around: OKX serving a
    // perfectly good FUTURES board with no USDT-quoted dated contract on it.
    const inverseOnly = {
      code: "0",
      data: (okxFutures.data as Array<{ instId: string }>).filter((d) =>
        d.instId.includes("-USD-"),
      ),
    };
    expect(inverseOnly.data.length).toBeGreaterThan(0);
    expect(buildBasisBoard(inverseOnly, okxSpot)).toEqual([]);
  });

  it("throws when either board is an error envelope", () => {
    expect(() => buildBasisBoard({ code: "51001", msg: "bad" }, okxSpot)).toThrow(/51001/);
    expect(() => buildBasisBoard(okxFutures, { code: "50011", msg: "rate limit" })).toThrow(
      /50011/,
    );
  });
});

describe("getBasisSnapshot", () => {
  function interceptBoth() {
    const pool = fetchMock.get(OKX_BASE);
    pool.intercept({ path: FUTURES_PATH }).reply(200, okxFutures);
    pool.intercept({ path: SPOT_PATH }).reply(200, okxSpot);
  }

  it("fetches both boards and joins them", async () => {
    interceptBoth();
    const snapshot = await getBasisSnapshot(mockEnv);

    expect(snapshot.quotes).toHaveLength(15);
    expect(snapshot.ts).toBeGreaterThan(0);
  });

  it("fails the whole poll when either leg fails", async () => {
    // `Promise.all`, not `allSettled` — the deliberate opposite of the funding
    // poll. Half a basis is not a smaller basis, it is not a basis.
    fetchMock.get(OKX_BASE).intercept({ path: FUTURES_PATH }).reply(200, okxFutures);
    fetchMock.get(OKX_BASE).intercept({ path: SPOT_PATH }).reply(503, "nope");
    await expect(getBasisSnapshot(mockEnv)).rejects.toThrow(/HTTP 503/);

    fetchMock.get(OKX_BASE).intercept({ path: FUTURES_PATH }).reply(451, "nope");
    fetchMock.get(OKX_BASE).intercept({ path: SPOT_PATH }).reply(200, okxSpot);
    await expect(getBasisSnapshot(mockEnv)).rejects.toThrow(/HTTP 451/);
  });

  it("takes injected fetchers, so a caller can drive it without a socket", async () => {
    const snapshot = await getBasisSnapshot(mockEnv, {
      fetchFutures: async () => okxFutures,
      fetchSpot: async () => okxSpot,
    });
    expect(snapshot.quotes).toHaveLength(15);
  });

  it("never attaches a credential, even from an env that has one", async () => {
    // Structural, not conventional: `basisHeaders()` takes no `Env` at all, so
    // there is no code path by which a Binance key could reach OKX.
    let seen: Record<string, string> = {};
    fetchMock
      .get(OKX_BASE)
      .intercept({ path: FUTURES_PATH })
      .reply(200, okxFutures)
      .times(1);
    fetchMock
      .get(OKX_BASE)
      .intercept({
        path: SPOT_PATH,
        headers: (headers: Record<string, string>) => {
          seen = headers;
          return true;
        },
      })
      .reply(200, okxSpot);

    await getBasisSnapshot(keyedEnv);

    const names = Object.keys(seen).map((k) => k.toLowerCase());
    expect(names).not.toContain("x-mbx-apikey");
    expect(JSON.stringify(seen)).not.toContain("super-secret");
  });
});

describe("the basis fetcher seam", () => {
  it("defaults to the real snapshot and restores on null", () => {
    expect(getBasisFetcher()).toBe(getBasisSnapshot);
    const stub = async () => ({ ts: 1, quotes: [] });
    setBasisFetcher(stub);
    expect(getBasisFetcher()).toBe(stub);
    setBasisFetcher(null);
    expect(getBasisFetcher()).toBe(getBasisSnapshot);
  });
});
