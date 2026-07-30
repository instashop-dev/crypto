import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app, BINANCE_BASES } from "../src/index";
import type { Env } from "../src/types";

// Minimal stand-in for the worker Env. Phase 1 routes never touch ASSETS, and
// no API key is configured so no X-MBX-APIKEY header is sent.
const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
} as unknown as Env;

beforeAll(() => {
  // Route all outbound fetch through the mock agent and hard-fail any request
  // that is not explicitly intercepted, so tests can never hit the network.
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("GET /api/version", () => {
  it("reports the app name and phase", async () => {
    const res = await app.request("/api/version", undefined, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: "crypto-arb", phase: 1 });
  });
});

describe("GET /api/health", () => {
  it("reports per-source reachability without hitting the network", async () => {
    // data-api.binance.vision -> 200, api.binance.com -> 451, api.binance.us -> 200
    const replies: Array<[string, number]> = [
      [BINANCE_BASES[0], 200],
      [BINANCE_BASES[1], 451],
      [BINANCE_BASES[2], 200],
    ];

    for (const [base, status] of replies) {
      fetchMock
        .get(base)
        .intercept({ path: "/api/v3/ping", method: "GET" })
        .reply(status, status === 200 ? {} : { code: 0, msg: "restricted" });
    }

    const res = await app.request("/api/health", undefined, mockEnv);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      ts: number;
      sources: Array<{
        base: string;
        status: number | string;
        ok: boolean;
        ms: number;
      }>;
    };

    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
    expect(body.sources).toHaveLength(3);

    expect(body.sources.map((s) => s.base)).toEqual([...BINANCE_BASES]);
    expect(body.sources.map((s) => s.status)).toEqual([200, 451, 200]);
    expect(body.sources.map((s) => s.ok)).toEqual([true, false, true]);

    for (const source of body.sources) {
      expect(typeof source.ms).toBe("number");
      expect(source.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("marks a source as errored when the request fails", async () => {
    fetchMock
      .get(BINANCE_BASES[0])
      .intercept({ path: "/api/v3/ping", method: "GET" })
      .reply(200, {});
    fetchMock
      .get(BINANCE_BASES[1])
      .intercept({ path: "/api/v3/ping", method: "GET" })
      .replyWithError(new Error("connection refused"));
    fetchMock
      .get(BINANCE_BASES[2])
      .intercept({ path: "/api/v3/ping", method: "GET" })
      .reply(200, {});

    const res = await app.request("/api/health", undefined, mockEnv);
    const body = (await res.json()) as {
      sources: Array<{ status: number | string; ok: boolean }>;
    };

    expect(body.sources.map((s) => s.ok)).toEqual([true, false, true]);
    expect(body.sources[1].status).toBe("error");
  });

  it("never leaks the API key into the response body", async () => {
    for (const base of BINANCE_BASES) {
      fetchMock
        .get(base)
        .intercept({ path: "/api/v3/ping", method: "GET" })
        .reply(200, {});
    }

    const secret = "super-secret-key";
    const res = await app.request("/api/health", undefined, {
      ...mockEnv,
      BINANCE_API_KEY: secret,
    } as Env);

    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("X-MBX-APIKEY");
  });
});
