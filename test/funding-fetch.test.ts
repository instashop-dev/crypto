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
import { ASSET_UNIVERSE, BASE_ASSET, perpAssets } from "../src/config";
import { DEFAULT_FUNDING_INTERVAL_MINUTES } from "../src/engine";
import {
  BYBIT_BASE,
  bybitInstrument,
  fetchBybitFunding,
  fetchBybitIntervals,
  fetchOkxFunding,
  FUNDING_COVERAGE_THRESHOLD,
  getFundingFetcher,
  getFundingSnapshot,
  OKX_BASE,
  okxInstrument,
  parseBybitIntervals,
  parseBybitTickers,
  parseOkxFundingRate,
  setFundingFetcher,
  type FundingDeps,
  type FundingQuote,
} from "../src/funding";
import type { Env } from "../src/types";
import bybitTickers from "./fixtures/bybit-tickers.json";
import bybitInstruments from "./fixtures/bybit-instruments.json";
import okxFunding from "./fixtures/okx-funding-rate.json";

const TICKERS_PATH = "/v5/market/tickers?category=linear";
const INSTRUMENTS_PATH = "/v5/market/instruments-info?category=linear&limit=1000";
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

describe("getFundingSnapshot", () => {
  function board(...entries: Array<[string, number]>): Map<string, FundingQuote> {
    return new Map(
      entries.map(([symbol, rate]) => [
        symbol,
        {
          venue: "bybit" as const,
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

  const fullBoard = () => board(...ASSETS.map((a) => [a, 0.0001] as [string, number]));

  /** Run a snapshot expected to fail and hand back the error it threw. */
  async function failure(deps: FundingDeps): Promise<Error | null> {
    try {
      await getFundingSnapshot(ASSETS, mockEnv, deps);
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  it("prefers Bybit when it covers enough of the board", async () => {
    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      fetchBybit: async () => fullBoard(),
      fetchOkx: async () => {
        throw new Error("the fallback must not be reached");
      },
    });

    expect(snapshot.venue).toBe("bybit");
    expect(snapshot.quotes.size).toBe(11);
    expect(typeof snapshot.ts).toBe("number");
  });

  it("falls back to OKX when Bybit answers 403", async () => {
    fetchMock
      .get(BYBIT_BASE)
      .intercept({ path: TICKERS_PATH, method: "GET" })
      .reply(403, "forbidden");

    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      fetchOkx: async () => board(["BTC", 0.0002]),
    });

    expect(snapshot.venue).toBe("okx");
    expect(snapshot.quotes.get("BTC")!.rate).toBe(0.0002);
  });

  it("falls back when Bybit covers less than the threshold", async () => {
    // 3 of 11 = 27% < 60%. A board this sparse is not a cheaper snapshot, it is
    // a different and much worse scan.
    const sparse = board(["BTC", 0.0001], ["ETH", 0.0001], ["SOL", 0.0001]);
    expect(sparse.size / ASSETS.length).toBeLessThan(FUNDING_COVERAGE_THRESHOLD);

    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      fetchBybit: async () => sparse,
      fetchOkx: async () => fullBoard(),
    });

    expect(snapshot.venue).toBe("okx");
    expect(snapshot.quotes.size).toBe(11);
  });

  it("keeps a Bybit board exactly at the coverage threshold", async () => {
    const seven = board(...ASSETS.slice(0, 7).map((a) => [a, 0.0001] as [string, number]));
    expect(seven.size / ASSETS.length).toBeGreaterThanOrEqual(FUNDING_COVERAGE_THRESHOLD);

    const snapshot = await getFundingSnapshot(ASSETS, mockEnv, {
      fetchBybit: async () => seven,
    });
    expect(snapshot.venue).toBe("bybit");
  });

  it("throws naming both venues when neither answers", async () => {
    const err = await failure({
      fetchBybit: async () => {
        throw new Error("HTTP 403");
      },
      fetchOkx: async () => {
        throw new Error("HTTP 429");
      },
    });

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/no funding-rate source available/);
    expect(err!.message).toMatch(/bybit:.*403.*okx:.*429/s);
  });

  it("reports an empty OKX board as a failure, not an empty venue", async () => {
    const err = await failure({
      fetchBybit: async () => new Map(),
      fetchOkx: async () => new Map(),
    });

    expect(err!.message).toMatch(/covered only 0\/11/);
    expect(err!.message).toMatch(/okx: none of the requested symbols/);
  });

  it("passes the cached intervals through to the Bybit fetcher", async () => {
    let seen: Record<string, number> | undefined;
    await getFundingSnapshot(ASSETS, mockEnv, {
      intervals: { BTCUSDT: 240 },
      fetchBybit: async (_assets, _env, intervals) => {
        seen = intervals;
        return fullBoard();
      },
    });
    expect(seen).toEqual({ BTCUSDT: 240 });
  });
});

describe("the module seam", () => {
  it("swaps the fetcher and restores the real one", () => {
    const stub = async () => ({ venue: "okx" as const, ts: 1, quotes: new Map() });
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
});
