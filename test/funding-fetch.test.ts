/**
 * Funding-rate client: parsers, both venues, the fallback chain and the
 * credential boundary. No network — every upstream is either intercepted with
 * `fetchMock` or injected per call.
 *
 * The fixtures are captured response shapes, not minimal stubs, so a field the
 * parser reads by name is a field a real venue actually sends.
 */
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_UNIVERSE,
  BASE_ASSET,
  FUNDING_BOARD_BOTTOM_N,
  FUNDING_BOARD_TOP_N,
  perpAssets,
} from "../src/config";
import { DEFAULT_FUNDING_INTERVAL_MINUTES } from "../src/engine";
import {
  BYBIT_BASE,
  bybitInstrument,
  capFundingBoard,
  fetchBybitFunding,
  fetchBybitIntervals,
  fetchGateFunding,
  fetchKucoinFunding,
  fetchOkxFunding,
  FUNDING_VENUES,
  GATE_BASE,
  gateBaseAsset,
  getFundingFetcher,
  getFundingSnapshot,
  KUCOIN_BASE,
  kucoinBaseAsset,
  OKX_BASE,
  okxInstrument,
  parseBybitIntervals,
  parseBybitTickers,
  parseGateContracts,
  parseKucoinContracts,
  parseOkxFundingRate,
  setFundingFetcher,
  type FundingDeps,
  type FundingQuote,
} from "../src/funding";
import type { Env, FundingVenue } from "../src/types";
import bybitTickers from "./fixtures/bybit-tickers.json";
import bybitInstruments from "./fixtures/bybit-instruments.json";
import gateContracts from "./fixtures/gate-contracts.json";
import kucoinContracts from "./fixtures/kucoin-contracts.json";
import okxFunding from "./fixtures/okx-funding-rate.json";

const TICKERS_PATH = "/v5/market/tickers?category=linear";
const INSTRUMENTS_PATH = "/v5/market/instruments-info?category=linear&limit=1000";
const GATE_PATH = "/api/v4/futures/usdt/contracts";
const KUCOIN_PATH = "/api/v1/contracts/active";
const okxPath = (asset: string) =>
  `/api/v5/public/funding-rate?instId=${okxInstrument(asset)}`;

/** 11 assets: the universe minus USDT. */
const ASSETS = perpAssets(ASSET_UNIVERSE, BASE_ASSET);

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
  setFundingFetcher(null);
  fetchMock.assertNoPendingInterceptors();
});

describe("instrument naming", () => {
  it("maps an asset to each venue's contract name", () => {
    expect(bybitInstrument("BTC")).toBe("BTCUSDT");
    expect(okxInstrument("BTC")).toBe("BTC-USDT-SWAP");
    expect(ASSETS).toHaveLength(11);
    expect(ASSETS).not.toContain("USDT");
  });
});

describe("parseBybitTickers", () => {
  const intervals = parseBybitIntervals(bybitInstruments, ASSETS);

  it("keeps only the requested assets, keyed by asset rather than contract", () => {
    const quotes = parseBybitTickers(bybitTickers, ASSETS, intervals);

    // DOGE is listed but quotes an empty fundingRate, so 10 of the 11 parse.
    expect(quotes.size).toBe(10);
    expect(quotes.has("DOGE")).toBe(false);
    // Listed contracts outside the universe are ignored entirely.
    expect(quotes.has("WIF")).toBe(false);
    expect(quotes.has("1000PEPE")).toBe(false);

    const btc = quotes.get("BTC")!;
    expect(btc).toEqual({
      venue: "bybit",
      symbol: "BTC",
      instrument: "BTCUSDT",
      rate: 0.0001,
      intervalMinutes: 480,
      intervalSource: "api",
      nextFundingTs: 1672387200000,
      markPrice: 60251.4,
    });
  });

  it("carries the sign of a negative rate through unchanged", () => {
    const quotes = parseBybitTickers(bybitTickers, ASSETS, intervals);
    expect(quotes.get("SOL")!.rate).toBe(-0.001034);
    expect(quotes.get("ADA")!.rate).toBe(-0.00002);
  });

  it("marks an interval as 'api' or 'assumed' per symbol", () => {
    const quotes = parseBybitTickers(bybitTickers, ASSETS, intervals);

    // SOL genuinely settles every 4 hours in the fixture.
    expect(quotes.get("SOL")!.intervalMinutes).toBe(240);
    expect(quotes.get("SOL")!.intervalSource).toBe("api");
    // TRX's instrument row carries junk, so it is absent from the cache and
    // falls back to the assumed 8 hours — visibly, not silently.
    expect(quotes.get("TRX")!.intervalMinutes).toBe(DEFAULT_FUNDING_INTERVAL_MINUTES);
    expect(quotes.get("TRX")!.intervalSource).toBe("assumed");
  });

  it("assumes every interval when no cache is supplied at all", () => {
    const quotes = parseBybitTickers(bybitTickers, ASSETS);
    expect([...quotes.values()].every((q) => q.intervalSource === "assumed")).toBe(true);
    expect(quotes.get("SOL")!.intervalMinutes).toBe(480);
  });

  it("skips individual junk rows without poisoning the board", () => {
    const payload = {
      retCode: 0,
      retMsg: "OK",
      result: {
        list: [
          { symbol: "BTCUSDT", fundingRate: "0.0001", markPrice: "60000" },
          { symbol: "ETHUSDT", fundingRate: "n/a" },
          { symbol: "SOLUSDT", fundingRate: null },
          // A magnitude of 1 is a mis-decoded field, not a market.
          { symbol: "XRPUSDT", fundingRate: "1" },
          { symbol: 42, fundingRate: "0.0001" },
          { symbol: "LTCUSDT", fundingRate: "0.0002", markPrice: "0" },
        ],
      },
    };

    const quotes = parseBybitTickers(payload, ASSETS);
    expect([...quotes.keys()]).toEqual(["BTC", "LTC"]);
    // A zero mark price is unusable, but it is not what makes the row a quote.
    expect(quotes.get("LTC")!.markPrice).toBeNull();
    expect(quotes.get("LTC")!.rate).toBe(0.0002);
  });

  it("throws with the venue's own message when retCode is non-zero", () => {
    // Bybit answers HTTP 200 and puts the failure in the body, so an `res.ok`
    // check alone would parse an error as an empty board.
    expect(() =>
      parseBybitTickers(
        { retCode: 10001, retMsg: "params error: Category is invalid", result: null },
        ASSETS,
      ),
    ).toThrow(/10001/);
    expect(() =>
      parseBybitTickers({ retCode: 10001, retMsg: "params error" }, ASSETS),
    ).toThrow(/params error/);
    expect(() => parseBybitTickers({ retCode: 0 }, ASSETS)).toThrow(/list/);
    expect(() => parseBybitTickers(null, ASSETS)).toThrow();
  });
});

describe("parseBybitIntervals", () => {
  it("reduces instruments-info to instrument -> minutes, in minutes", () => {
    const intervals = parseBybitIntervals(bybitInstruments, ASSETS);

    expect(intervals.BTCUSDT).toBe(480);
    expect(intervals.SOLUSDT).toBe(240);
    // Outside the universe, junk value, and no symbol at all.
    expect(intervals.WIFUSDT).toBeUndefined();
    expect(intervals.TRXUSDT).toBeUndefined();
    expect(Object.keys(intervals)).toHaveLength(10);
  });

  it("ignores unusable cadences rather than storing them", () => {
    const payload = {
      retCode: 0,
      result: {
        list: [
          { symbol: "BTCUSDT", fundingInterval: 480 },
          { symbol: "ETHUSDT", fundingInterval: 0 },
          { symbol: "SOLUSDT", fundingInterval: -60 },
          { symbol: "XRPUSDT", fundingInterval: 10_080 },
          { symbol: "ADAUSDT", fundingInterval: null },
          { symbol: "LTCUSDT" },
          "not an object",
        ],
      },
    };

    expect(parseBybitIntervals(payload, ASSETS)).toEqual({ BTCUSDT: 480 });
  });
});

describe("parseOkxFundingRate", () => {
  it("derives the cadence from the two timestamps", () => {
    const quote = parseOkxFundingRate(okxFunding, "BTC")!;

    expect(quote).toEqual({
      venue: "okx",
      symbol: "BTC",
      instrument: "BTC-USDT-SWAP",
      rate: 0.0001515,
      // 1703088000000 - 1703059200000 = 8h, and OKX publishes both, so this
      // is 'api' — the fallback venue is not a second-class source.
      intervalMinutes: 480,
      intervalSource: "api",
      nextFundingTs: 1703088000000,
      markPrice: null,
    });
  });

  it("assumes the cadence when a timestamp is missing", () => {
    const quote = parseOkxFundingRate(
      { code: "0", data: [{ instId: "ETH-USDT-SWAP", fundingRate: "0.0001" }] },
      "ETH",
    )!;
    expect(quote.intervalMinutes).toBe(DEFAULT_FUNDING_INTERVAL_MINUTES);
    expect(quote.intervalSource).toBe("assumed");
    expect(quote.nextFundingTs).toBeNull();
  });

  it("returns null for a non-zero code, comparing it as a string", () => {
    // `code` is a *string*; a numeric comparison would accept every error.
    expect(
      parseOkxFundingRate({ code: "50011", msg: "Rate limit reached", data: [] }, "BTC"),
    ).toBeNull();
    expect(parseOkxFundingRate({ code: "51001", data: [] }, "BTC")).toBeNull();
    expect(parseOkxFundingRate({ code: "0", data: [] }, "BTC")).toBeNull();
    expect(parseOkxFundingRate(null, "BTC")).toBeNull();
  });

  it("refuses a reply about a different contract", () => {
    expect(
      parseOkxFundingRate(
        { code: "0", data: [{ instId: "ETH-USDT-SWAP", fundingRate: "0.0001" }] },
        "BTC",
      ),
    ).toBeNull();
  });

  it("returns null for an unusable rate", () => {
    for (const bad of ["", "n/a", null, "1", "-1"]) {
      expect(
        parseOkxFundingRate(
          { code: "0", data: [{ instId: "BTC-USDT-SWAP", fundingRate: bad }] },
          "BTC",
        ),
        String(bad),
      ).toBeNull();
    }
  });
});

describe("fetchBybitFunding", () => {
  it("fetches the whole linear board in one request", async () => {
    fetchMock
      .get(BYBIT_BASE)
      .intercept({ path: TICKERS_PATH, method: "GET" })
      .reply(200, bybitTickers);

    const quotes = await fetchBybitFunding(ASSETS, mockEnv, { BTCUSDT: 480 });
    expect(quotes.size).toBe(10);
    expect(quotes.get("BTC")!.intervalSource).toBe("api");
    expect(quotes.get("ETH")!.intervalSource).toBe("assumed");
  });

  it("throws on a non-200 response", async () => {
    fetchMock
      .get(BYBIT_BASE)
      .intercept({ path: TICKERS_PATH, method: "GET" })
      .reply(403, "forbidden");

    await expect(fetchBybitFunding(ASSETS, mockEnv)).rejects.toThrow("HTTP 403");
  });

  it("does not call upstream when no assets are requested", async () => {
    // Nothing is intercepted: any fetch would fail the disabled net connect.
    await expect(fetchBybitFunding([], mockEnv)).resolves.toEqual(new Map());
    await expect(fetchBybitIntervals([], mockEnv)).resolves.toEqual({});
  });
});

describe("fetchBybitIntervals", () => {
  it("fetches the cadence map from instruments-info", async () => {
    fetchMock
      .get(BYBIT_BASE)
      .intercept({ path: INSTRUMENTS_PATH, method: "GET" })
      .reply(200, bybitInstruments);

    const intervals = await fetchBybitIntervals(ASSETS, mockEnv);
    expect(intervals.BTCUSDT).toBe(480);
    expect(intervals.SOLUSDT).toBe(240);
  });
});

describe("fetchOkxFunding", () => {
  it("issues one request per instrument and tolerates individual failures", async () => {
    const pool = fetchMock.get(OKX_BASE);
    pool.intercept({ path: okxPath("BTC"), method: "GET" }).reply(200, okxFunding);
    pool
      .intercept({ path: okxPath("ETH"), method: "GET" })
      .reply(200, {
        code: "0",
        data: [
          {
            instId: "ETH-USDT-SWAP",
            fundingRate: "0.00025",
            fundingTime: "1703059200000",
            nextFundingTime: "1703088000000",
          },
        ],
      });
    // One dead instrument must cost one row, not the snapshot.
    pool.intercept({ path: okxPath("SOL"), method: "GET" }).reply(500, "boom");

    const quotes = await fetchOkxFunding(["BTC", "ETH", "SOL"], mockEnv);

    expect([...quotes.keys()].sort()).toEqual(["BTC", "ETH"]);
    expect(quotes.get("ETH")!.rate).toBe(0.00025);
    expect(quotes.get("ETH")!.venue).toBe("okx");
  });
});


describe("parseGateContracts", () => {
  it("normalises a real contract into a quote, cadence in minutes", () => {
    const quotes = parseGateContracts(gateContracts);

    expect(quotes.get("BTC")).toEqual({
      venue: "gate",
      symbol: "BTC",
      // The venue's own name is kept: it is what someone reproducing the row
      // has to paste into Gate's UI.
      instrument: "BTC_USDT",
      rate: 0.000011,
      // Gate publishes seconds; 28800 / 60 = 480.
      intervalMinutes: 480,
      intervalSource: "api",
      // ...and epoch *seconds* for the next settlement, unlike every other
      // venue here, so this is the one field that gets multiplied by 1000.
      nextFundingTs: 1785513600000,
      markPrice: 63799.3,
    });
  });

  it("reads a 4-hour and a 1-hour cadence off the API rather than assuming", () => {
    const quotes = parseGateContracts(gateContracts);

    expect(quotes.get("LA")!.intervalMinutes).toBe(240);
    expect(quotes.get("LA")!.intervalSource).toBe("api");
    expect(quotes.get("LA")!.rate).toBe(-0.00707);
    expect(quotes.get("T")!.intervalMinutes).toBe(60);
    expect(quotes.get("T")!.intervalSource).toBe("api");
  });

  it("skips the tokenised-equity, index, metal and pre-market contracts", () => {
    const quotes = parseGateContracts(gateContracts);

    // There is no spot leg for a synthetic equity or a gold contract on a
    // crypto exchange, so a fat rate on one is not a carry — it is a row that
    // would push a real one out of the per-venue top 25.
    expect(quotes.has("AAL")).toBe(false);
    expect(quotes.has("IAU")).toBe(false);
    expect(quotes.has("ANDURIL")).toBe(false);
    expect([...quotes.keys()].sort()).toEqual(["BTC", "DOGE", "ETH", "LA", "SOL", "T"]);
  });

  it("skips delisting, halted, inverse and unusable rows one at a time", () => {
    const payload = [
      { name: "BTC_USDT", funding_rate: "0.0001", funding_interval: 28800 },
      { name: "DEAD_USDT", funding_rate: "0.5", in_delisting: true },
      { name: "HALT_USDT", funding_rate: "0.5", status: "delisting" },
      { name: "INV_USDT", funding_rate: "0.5", type: "inverse" },
      // A magnitude of 1 is a mis-decoded field, not a market.
      { name: "BIG_USDT", funding_rate: "1" },
      { name: "BLANK_USDT", funding_rate: "" },
      { name: "NAN_USDT", funding_rate: "n/a" },
      { name: "BTC_USD", funding_rate: "0.0001" },
      { name: "_USDT", funding_rate: "0.0001" },
      { name: 42, funding_rate: "0.0001" },
      "not an object",
    ];

    const quotes = parseGateContracts(payload);
    expect([...quotes.keys()]).toEqual(["BTC"]);
  });

  it("falls back to the assumed cadence, visibly, when the interval is junk", () => {
    const quotes = parseGateContracts([
      { name: "AAA_USDT", funding_rate: "0.0001" },
      { name: "BBB_USDT", funding_rate: "0.0001", funding_interval: 0 },
      // A week is a parsing accident far more often than it is a product.
      { name: "CCC_USDT", funding_rate: "0.0001", funding_interval: 604800 },
    ]);

    for (const symbol of ["AAA", "BBB", "CCC"]) {
      expect(quotes.get(symbol)!.intervalMinutes, symbol).toBe(
        DEFAULT_FUNDING_INTERVAL_MINUTES,
      );
      expect(quotes.get(symbol)!.intervalSource, symbol).toBe("assumed");
    }
  });

  it("throws rather than reading a shape change as an empty board", () => {
    // Gate answers with a bare array and no status envelope, so anything else
    // here is a shape change — and an empty board is a much worse answer to it
    // than a failure the caller records against the venue.
    expect(() => parseGateContracts({ label: "not an array" })).toThrow(/array/);
    expect(() => parseGateContracts(null)).toThrow(/array/);
  });

  it("keeps a multiplier prefix, so the two full-board venues line up", () => {
    // Gate's `1000PEPE_USDT` and KuCoin's `1000PEPEUSDTM` are the same
    // contract; stripping the prefix on one and not the other would split one
    // asset's history in two.
    expect(gateBaseAsset("1000PEPE_USDT")).toBe("1000PEPE");
    expect(gateBaseAsset("btc_usdt")).toBe("BTC");
    expect(gateBaseAsset("BTC_USD")).toBeNull();
    expect(gateBaseAsset("_USDT")).toBeNull();
  });
});

describe("parseKucoinContracts", () => {
  it("normalises a real contract, mapping XBT to BTC", () => {
    const quotes = parseKucoinContracts(kucoinContracts);

    expect(quotes.get("BTC")).toEqual({
      venue: "kucoin",
      symbol: "BTC",
      // The alias applies to the *symbol* only: the instrument stays what
      // KuCoin's own UI calls it.
      instrument: "XBTUSDTM",
      rate: 0.0001,
      // Published in milliseconds; 28800000 / 60000 = 480.
      intervalMinutes: 480,
      intervalSource: "api",
      nextFundingTs: 1785513600000,
      markPrice: 63801.6,
    });
  });

  it("reads a 1-hour granularity off the API", () => {
    const quotes = parseKucoinContracts(kucoinContracts);
    expect(quotes.get("BANK")!.intervalMinutes).toBe(60);
    expect(quotes.get("BANK")!.intervalSource).toBe("api");
    expect(quotes.get("BANK")!.rate).toBe(-0.001783);
  });

  it("keeps only USDT-margined perps with no expiry", () => {
    const quotes = parseKucoinContracts(kucoinContracts);

    // XBTUSDCM is a USDC-margined board riding along in the same response;
    // XBTMU26 is a dated future; WLUSDTM is a perp KuCoin has scheduled for
    // delisting, which is a carry nobody can hold to the end.
    expect([...quotes.keys()].sort()).toEqual(["BANK", "BTC", "DOGE", "ETH", "LA", "SOL"]);
    expect(quotes.has("WL")).toBe(false);
  });

  it("throws on a non-200000 code, comparing it as a string", () => {
    // `code` is a *string*; a numeric comparison would accept every error.
    expect(() =>
      parseKucoinContracts({ code: "400100", msg: "Parameter error", data: [] }),
    ).toThrow(/400100.*Parameter error/);
    expect(() => parseKucoinContracts({ code: "200000" })).toThrow(/array/);
    expect(() => parseKucoinContracts(null)).toThrow();
  });

  it("skips unusable rows one at a time", () => {
    const quotes = parseKucoinContracts({
      code: "200000",
      data: [
        { symbol: "BTCUSDTM", type: "FFWCSX", status: "Open", fundingFeeRate: 0.0001 },
        { symbol: "PAUSEDUSDTM", status: "Paused", fundingFeeRate: 0.0001 },
        { symbol: "NULLUSDTM", fundingFeeRate: null },
        { symbol: "BIGUSDTM", fundingFeeRate: 1 },
        { symbol: "USDTM", fundingFeeRate: 0.0001 },
        { symbol: "ETHUSDM", fundingFeeRate: 0.0001 },
        { symbol: 42, fundingFeeRate: 0.0001 },
        "not an object",
      ],
    });

    expect([...quotes.keys()]).toEqual(["BTC"]);
    expect(quotes.get("BTC")!.intervalSource).toBe("assumed");
  });

  it("falls back to the current granularity before assuming one", () => {
    const quotes = parseKucoinContracts({
      code: "200000",
      data: [
        {
          symbol: "AAAUSDTM",
          fundingFeeRate: 0.0001,
          fundingRateGranularity: null,
          currentFundingRateGranularity: 14_400_000,
        },
      ],
    });
    expect(quotes.get("AAA")!.intervalMinutes).toBe(240);
    expect(quotes.get("AAA")!.intervalSource).toBe("api");
  });

  it("maps XBT to BTC and leaves every other base alone", () => {
    expect(kucoinBaseAsset("XBTUSDTM")).toBe("BTC");
    expect(kucoinBaseAsset("1000BONKUSDTM")).toBe("1000BONK");
    expect(kucoinBaseAsset("xbtusdtm")).toBe("BTC");
    expect(kucoinBaseAsset("XBTUSDCM")).toBeNull();
    expect(kucoinBaseAsset("USDTM")).toBeNull();
  });
});

describe("fetchGateFunding / fetchKucoinFunding", () => {
  it("fetches each whole board in exactly one request", async () => {
    fetchMock
      .get(GATE_BASE)
      .intercept({ path: GATE_PATH, method: "GET" })
      .reply(200, gateContracts);
    fetchMock
      .get(KUCOIN_BASE)
      .intercept({ path: KUCOIN_PATH, method: "GET" })
      .reply(200, kucoinContracts);

    const [gate, kucoin] = await Promise.all([
      fetchGateFunding(mockEnv),
      fetchKucoinFunding(mockEnv),
    ]);

    expect(gate.get("BTC")!.venue).toBe("gate");
    expect(kucoin.get("BTC")!.venue).toBe("kucoin");
  });

  it("throws on a non-200 response", async () => {
    fetchMock
      .get(GATE_BASE)
      .intercept({ path: GATE_PATH, method: "GET" })
      .reply(403, "forbidden");
    fetchMock
      .get(KUCOIN_BASE)
      .intercept({ path: KUCOIN_PATH, method: "GET" })
      .reply(429, "slow down");

    await expect(fetchGateFunding(mockEnv)).rejects.toThrow("HTTP 403");
    await expect(fetchKucoinFunding(mockEnv)).rejects.toThrow("HTTP 429");
  });
});

describe("getFundingSnapshot", () => {
  function board(
    venue: FundingVenue,
    ...entries: Array<[string, number]>
  ): Map<string, FundingQuote> {
    return new Map(
      entries.map(([symbol, rate]) => [
        symbol,
        {
          venue,
          symbol,
          instrument: bybitInstrument(symbol),
          rate,
          intervalMinutes: 480,
          intervalSource: "assumed" as const,
          nextFundingTs: null,
          markPrice: null,
        },
      ]),
    );
  }

  const fullBoard = (venue: FundingVenue) =>
    board(venue, ...ASSETS.map((a) => [a, 0.0001] as [string, number]));

  /** Every venue serving, so a test can override just the one it cares about. */
  function allServing(): FundingDeps {
    return {
      fetchBybit: async () => fullBoard("bybit"),
      fetchOkx: async () => fullBoard("okx"),
      fetchGate: async () => board("gate", ["BTC", 0.0003], ["PEPE", 0.0009]),
      fetchKucoin: async () => board("kucoin", ["BTC", 0.0004]),
    };
  }

  /** Run a snapshot expected to fail and hand back the error it threw. */
  async function failure(deps: FundingDeps): Promise<Error | null> {
    try {
      await getFundingSnapshot(ASSETS, mockEnv, deps);
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  it("polls every venue and keeps all of their quotes", async () => {
    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, allServing());

    // 11 + 11 + 2 + 1. The same symbol from four venues is four quotes, not a
    // collision: comparing venues is the whole feature.
    expect(snapshot.quotes).toHaveLength(25);
    expect(snapshot.served).toEqual([...FUNDING_VENUES]);
    expect(snapshot.venues.map((v) => v.count)).toEqual([11, 11, 2, 1]);
    expect(snapshot.venues.every((v) => v.error === null)).toBe(true);
    expect(typeof snapshot.ts).toBe("number");

    const btc = snapshot.quotes.filter((q) => q.symbol === "BTC");
    expect(btc.map((q) => q.venue).sort()).toEqual(["bybit", "gate", "kucoin", "okx"]);
  });

  it("loses only the failing venue's rows when one throws", async () => {
    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      ...allServing(),
      fetchGate: async () => {
        throw new Error("HTTP 403");
      },
    });

    expect(snapshot.served).toEqual(["bybit", "okx", "kucoin"]);
    expect(snapshot.quotes.some((q) => q.venue === "gate")).toBe(false);
    expect(snapshot.quotes).toHaveLength(23);

    const gate = snapshot.venues.find((v) => v.venue === "gate")!;
    expect(gate.count).toBe(0);
    expect(gate.error).toContain("403");
  });

  it("records a venue that answered with nothing as a failure of its own", async () => {
    // "Reachable but quoting nothing" is a distinct and equally interesting
    // state from "unreachable"; neither is a served venue.
    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      ...allServing(),
      fetchKucoin: async () => new Map(),
    });

    expect(snapshot.served).not.toContain("kucoin");
    const kucoin = snapshot.venues.find((v) => v.venue === "kucoin")!;
    expect(kucoin.error).toMatch(/no usable funding rates/);
  });

  it("polls only the venues it was asked for", async () => {
    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      ...allServing(),
      venues: ["gate"],
      fetchBybit: async () => {
        throw new Error("bybit must not be polled");
      },
    });

    expect(snapshot.served).toEqual(["gate"]);
    expect(snapshot.venues).toHaveLength(1);
  });

  it("throws naming every venue when not one of them answers", async () => {
    const err = await failure({
      fetchBybit: async () => {
        throw new Error("HTTP 403");
      },
      fetchOkx: async () => {
        throw new Error("HTTP 429");
      },
      fetchGate: async () => {
        throw new Error("HTTP 451");
      },
      fetchKucoin: async () => new Map(),
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/no funding-rate source available/);
    expect(err!.message).toMatch(
      /bybit:.*403.*okx:.*429.*gate:.*451.*kucoin:.*no usable/s,
    );
  });

  it("passes the cached intervals through to the Bybit fetcher", async () => {
    let seen: Record<string, number> | undefined;
    await getFundingSnapshot(ASSETS, mockEnv, {
      ...allServing(),
      intervals: { BTCUSDT: 240 },
      fetchBybit: async (_assets, _env, intervals) => {
        seen = intervals;
        return fullBoard("bybit");
      },
    });
    expect(seen).toEqual({ BTCUSDT: 240 });
  });
});

describe("capFundingBoard", () => {
  /** A priced row, in the shape `rankFundingOpportunities` hands over. */
  const row = (venue: string, symbol: string, netAnnualPct: number) => ({
    quote: { venue, symbol },
    netAnnualPct,
  });

  const MAJORS = ["BTC", "ETH"];

  it("keeps every major and each venue's best N of the rest", () => {
    const ranked = [
      row("gate", "AAA", 90),
      row("gate", "BBB", 80),
      row("gate", "CCC", 70),
      row("kucoin", "DDD", 60),
      row("kucoin", "EEE", 50),
      // Both majors rank below every tail row and are kept regardless: they are
      // the continuous series the history route serves.
      row("gate", "BTC", 4),
      row("kucoin", "ETH", 3),
      row("gate", "ETH", 2),
    ];

    // No negative-tail budget here, so this is the top half of the cap alone.
    const kept = capFundingBoard(ranked, MAJORS, 2, 0);

    expect(kept.map((r) => `${r.quote.venue}:${r.quote.symbol}`)).toEqual([
      "gate:AAA",
      "gate:BBB",
      // CCC is Gate's third non-major, so it goes...
      "kucoin:DDD",
      "kucoin:EEE",
      // ...and every major survives at the bottom of the board.
      "gate:BTC",
      "kucoin:ETH",
      "gate:ETH",
    ]);
  });

  it("keeps each venue's deepest negatives, which the top alone would discard", () => {
    // One venue, 30 non-majors: 20 positive, then a long slide into the sort of
    // rate the engine calls the headline result of the day it happens.
    const ranked = [
      ...Array.from({ length: 25 }, (_, i) => row("gate", `POS${i}`, 100 - i)),
      row("gate", "NEG1", -40),
      row("gate", "NEG2", -900),
      row("gate", "LA", -1548),
    ];

    const kept = capFundingBoard(ranked, MAJORS, 20, 5);
    const symbols = kept.map((r) => r.quote.symbol);

    // The whole point: -1548%/yr is persisted rather than capped away by 20
    // rows that pay less than 100% and are nowhere near as interesting.
    expect(symbols).toContain("LA");
    expect(symbols).toContain("NEG2");
    expect(symbols).toContain("NEG1");
    // Bottom 5 = LA, NEG2, NEG1 and the two worst positives above them.
    expect(symbols.slice(-5)).toEqual(["POS23", "POS24", "NEG1", "NEG2", "LA"]);
    // The budget did not grow to make room: still 25 non-major rows, 20 + 5.
    expect(kept).toHaveLength(FUNDING_BOARD_TOP_N + FUNDING_BOARD_BOTTOM_N);
    expect(symbols.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => `POS${i}`),
    );
    // The five rows between the two halves are what the budget cost.
    expect(symbols).not.toContain("POS20");
    expect(symbols).not.toContain("POS22");
  });

  it("splits the budget per venue, negatives included", () => {
    const ranked = [
      ...Array.from({ length: 6 }, (_, i) => row("gate", `G${i}`, 100 - i)),
      ...Array.from({ length: 6 }, (_, i) => row("kucoin", `K${i}`, 50 - i)),
      row("kucoin", "KWORST", -700),
      row("gate", "GWORST", -800),
    ];

    const kept = capFundingBoard(ranked, MAJORS, 2, 1);
    // Each venue: its best 2 and its single worst. Neither venue's deep
    // negative is crowded out by the other venue's better-paying rows.
    expect(kept.map((r) => r.quote.symbol)).toEqual([
      "G0",
      "G1",
      "K0",
      "K1",
      "KWORST",
      "GWORST",
    ]);
  });

  it("counts the cap per venue, so one hot venue cannot crowd the others out", () => {
    const ranked = [
      row("gate", "AAA", 99),
      row("gate", "BBB", 98),
      row("kucoin", "CCC", 1),
    ];

    // Gate fills its budget on the first two rows; KuCoin's much worse row is
    // still kept, because the cross-venue comparison is the product.
    const kept = capFundingBoard(ranked, MAJORS, 2, 0);
    expect(kept.map((r) => r.quote.venue)).toEqual(["gate", "gate", "kucoin"]);
  });

  it("preserves the input ranking and matches majors case-insensitively", () => {
    const kept = capFundingBoard(
      [row("gate", "zzz", 10), row("gate", "btc", 5), row("gate", "yyy", 1)],
      MAJORS,
      1,
      0,
    );
    expect(kept.map((r) => r.quote.symbol)).toEqual(["zzz", "btc"]);
  });

  it("handles the empty, the generous and the zero budget", () => {
    expect(capFundingBoard([], MAJORS, 25, 5)).toEqual([]);
    const ranked = [row("gate", "AAA", 1), row("gate", "BBB", 1)];
    expect(capFundingBoard(ranked, MAJORS, 25, 5)).toHaveLength(2);
    // A venue with fewer rows than the budget keeps each of them *once*: the
    // two halves overlap and are deduplicated, not concatenated.
    expect(capFundingBoard(ranked, MAJORS, 2, 2)).toHaveLength(2);
    // Zero is a real budget, not a missing one: majors only. Both halves have
    // to be zeroed, and `slice(-0)` must not read as "the whole board".
    expect(capFundingBoard(ranked, MAJORS, 0, 0)).toHaveLength(0);
    // Only the negative half: the worst row, not the best one.
    expect(capFundingBoard(ranked, MAJORS, 0, 1).map((r) => r.quote.symbol)).toEqual([
      "BBB",
    ]);
  });

  it("defaults to the shipped budget", () => {
    const ranked = Array.from({ length: 40 }, (_, i) => row("gate", `A${i}`, 40 - i));
    const kept = capFundingBoard(ranked, MAJORS);
    expect(kept).toHaveLength(FUNDING_BOARD_TOP_N + FUNDING_BOARD_BOTTOM_N);
    // The shipped default keeps the bottom of the board, not only the top.
    expect(kept.map((r) => r.quote.symbol).slice(-1)).toEqual(["A39"]);
  });
});

describe("the module seam", () => {
  it("swaps the fetcher and restores the real one", () => {
    const stub = async () => ({ ts: 1, quotes: [], venues: [], served: [] });
    setFundingFetcher(stub);
    expect(getFundingFetcher()).toBe(stub);

    setFundingFetcher(null);
    expect(getFundingFetcher()).toBe(getFundingSnapshot);
  });
});

describe("credential hygiene", () => {
  /** Lower-cased header map, whichever shape the mock agent hands back. */
  function seen(raw: Headers | Record<string, string> | undefined) {
    const entries =
      raw instanceof Headers ? [...raw.entries()] : Object.entries(raw ?? {});
    return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), String(v)]));
  }

  it("sends a UA and Accept to Bybit, and never a Binance key", async () => {
    let headers: Record<string, string> = {};
    fetchMock
      .get(BYBIT_BASE)
      .intercept({ path: TICKERS_PATH, method: "GET" })
      .reply(200, (opts) => {
        headers = seen(opts.headers);
        return bybitTickers;
      });

    // The env carries both secrets, and they still must not travel: the header
    // builder in src/funding.ts takes no `Env` at all, so there is no call site
    // that *could* attach one.
    await fetchBybitFunding(ASSETS, keyedEnv);

    expect(headers["user-agent"]).toBe("crypto-arb-paper-trader/1.0");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-mbx-apikey"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("super-secret");
  });

  it("sends the same headers to OKX, and no key either", async () => {
    let headers: Record<string, string> = {};
    fetchMock
      .get(OKX_BASE)
      .intercept({ path: okxPath("BTC"), method: "GET" })
      .reply(200, (opts) => {
        headers = seen(opts.headers);
        return okxFunding;
      });

    await fetchOkxFunding(["BTC"], keyedEnv);

    expect(headers["user-agent"]).toBe("crypto-arb-paper-trader/1.0");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-mbx-apikey"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("super-secret");
  });

  it("sends the same headers to Gate and KuCoin, and no key to either", async () => {
    // The two new venues inherit the guarantee structurally — they call the
    // same `fetchFundingJson`, which takes no `Env` — but the assertion is
    // cheap, and the day someone adds a signed endpoint it is the tripwire.
    const headers: Record<string, Record<string, string>> = {};
    fetchMock
      .get(GATE_BASE)
      .intercept({ path: GATE_PATH, method: "GET" })
      .reply(200, (opts) => {
        headers.gate = seen(opts.headers);
        return gateContracts;
      });
    fetchMock
      .get(KUCOIN_BASE)
      .intercept({ path: KUCOIN_PATH, method: "GET" })
      .reply(200, (opts) => {
        headers.kucoin = seen(opts.headers);
        return kucoinContracts;
      });

    await fetchGateFunding(keyedEnv);
    await fetchKucoinFunding(keyedEnv);

    for (const venue of ["gate", "kucoin"]) {
      expect(headers[venue]["user-agent"], venue).toBe("crypto-arb-paper-trader/1.0");
      expect(headers[venue]["accept"], venue).toBe("application/json");
      expect(headers[venue]["x-mbx-apikey"], venue).toBeUndefined();
      expect(JSON.stringify(headers[venue]), venue).not.toContain("super-secret");
    }
  });
});
