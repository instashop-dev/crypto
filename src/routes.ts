/**
 * Every `/api/*` route.
 *
 * Handlers stay thin: they parse and validate input, call into `src/db.ts` or
 * `src/scan.ts`, and shape the response. All business rules (seeding, locking,
 * execution, atomicity) live behind those modules so the cron path in Phase 5
 * gets them for free without going through HTTP.
 *
 * Errors always come back as `{ error: string }` with a meaningful status, so
 * the dashboard has exactly one failure shape to render.
 */
import { Hono } from "hono";
import {
  discoverPairs,
  getSnapshot,
  getWsCollector,
  MEXC_BASE,
  USER_AGENT,
  type WsCollector,
} from "./binance";
import { ASSET_UNIVERSE, BASE_ASSET, STRATEGIES, type Strategy } from "./config";
import {
  ensureSeeded,
  getBalances,
  getPairs,
  getSettings,
  getTaxTotals,
  listOpportunities,
  listOpportunitiesForScan,
  listScans,
  listTrades,
  replacePairs,
  resetAll,
  updateSettings,
  type Settings,
} from "./db";
import { round8 } from "./engine";
import { runScan } from "./scan";
import type { Env } from "./types";

const MEXC_PING_PATH = "/api/v3/ping";
const MEXC_PROBE_TIMEOUT_MS = 8000;
/** Health probes get a longer WS budget than scans: a cold TLS handshake to
 *  Binance can eat most of the 4s scan deadline. */
const WS_PROBE_DEADLINE_MS = 5000;
const WS_PROBE_SYMBOL = "BTCUSDT";

/** Default markets for `/api/tickers` — one triangle's worth of legs. */
const DEFAULT_TICKER_SYMBOLS = ["BTCUSDT", "ETHUSDT", "ETHBTC"];
/** Guard rail for the debug route so a stray query cannot build a huge stream URL. */
const MAX_TICKER_SYMBOLS = 100;

/** Per-collection pagination: `[default, max]`. */
const LIMITS = {
  opportunities: [50, 200],
  trades: [50, 200],
  scans: [20, 100],
} as const;

/** Settings an operator may change at runtime. `initial_usdt` is not one of
 *  them: it is the denominator of every P&L figure ever reported, so moving it
 *  would silently rewrite history rather than change behaviour. */
const MUTABLE_SETTINGS = [
  "min_profit_pct",
  "trade_size_usdt",
  "fee_rate",
  "india_mode",
  "tds_rate",
  "tax_rate",
  "xchg_min_profit_pct",
  "xchg_enabled",
] as const;
type MutableSetting = (typeof MUTABLE_SETTINGS)[number];

/** Sanity ceiling on the fee rate: 1% per leg is already an absurd taker fee,
 *  and a fat-fingered 0.1 (10%) would make every cycle unprofitable forever. */
const MAX_FEE_RATE = 0.01;

/** Ceiling on the 194S withholding. The statutory rate is 1%; 5% leaves room
 *  for a stress test without letting a typo withhold the whole notional. */
const MAX_TDS_RATE = 0.05;

/** Ceiling on the 115BBH rate. The statutory rate is 30% (31.2% with cess);
 *  50% is generous headroom and still short of confiscating every gain. */
const MAX_TAX_RATE = 0.5;

export interface HealthSource {
  name: "binance-ws" | "mexc-rest";
  ok: boolean;
  ms: number;
  /** Symbols the probe actually received (WebSocket source only). */
  symbols?: string[];
}

/**
 * Probe the primary source by collecting a one-symbol snapshot. Takes the
 * collector as a parameter — defaulted at call time from the module seam — so
 * tests can drive the handler without opening a socket.
 *
 * Never throws: a dead source must not fail the whole report.
 */
export async function probeBinanceWs(
  env: Env,
  collect: WsCollector = getWsCollector(),
): Promise<HealthSource> {
  const started = Date.now();
  try {
    const book = await collect([WS_PROBE_SYMBOL], {
      deadlineMs: WS_PROBE_DEADLINE_MS,
      env,
    });
    return {
      name: "binance-ws",
      ok: book.has(WS_PROBE_SYMBOL),
      ms: Date.now() - started,
      symbols: [...book.keys()],
    };
  } catch {
    return { name: "binance-ws", ok: false, ms: Date.now() - started };
  }
}

/**
 * Probe the REST fallback with MEXC's cheap `/ping`. The API key is only ever
 * sent upstream as a header and is never echoed into the response.
 */
export async function probeMexcRest(_env: Env): Promise<HealthSource> {
  const started = Date.now();
  try {
    const res = await fetch(`${MEXC_BASE}${MEXC_PING_PATH}`, {
      method: "GET",
      // Workers' fetch sends no User-Agent by default and Binance-family WAFs
      // answer 403 to UA-less requests, so one is always set.
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(MEXC_PROBE_TIMEOUT_MS),
    });
    return { name: "mexc-rest", ok: res.ok, ms: Date.now() - started };
  } catch {
    return { name: "mexc-rest", ok: false, ms: Date.now() - started };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Clamp a `?limit=` query into `[1, max]`, falling back to `fallback` for
 * anything missing or unparseable. Never rejects: a bad limit is a caller typo,
 * not a reason to fail a read-only listing.
 */
function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/**
 * Parse a `?strategy=` filter. Absent (or empty) means "every strategy".
 *
 * Unlike {@link parseLimit} this **rejects** an unrecognised value rather than
 * falling back: a bad limit still answers the question that was asked, but
 * `?strategy=crossexchange` silently returning triangles too would look exactly
 * like a strategy that never fires. A misspelling has to be visible.
 */
function parseStrategy(
  raw: string | undefined,
): { ok: true; strategy?: Strategy } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true };
  if ((STRATEGIES as readonly string[]).includes(raw)) {
    return { ok: true, strategy: raw as Strategy };
  }
  return {
    ok: false,
    error: `unknown strategy: ${raw} (expected ${STRATEGIES.join(" or ")})`,
  };
}

/** Parse a JSON body, treating an absent or malformed body as `{}`. */
async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The India-mode view of the same portfolio.
 *
 * Three of these are the same two numbers under different names, deliberately:
 * `tdsWithheldUsdt` / `tdsReceivableUsdt` and `taxDueUsdt` / `taxLiabilityUsdt`
 * are the cash-flow name and the balance-sheet name for one figure each. The
 * dashboard shows them in different places and conflating them is exactly the
 * mistake this feature exists to prevent.
 */
export interface PortfolioTax {
  indiaMode: boolean;
  tdsRate: number;
  taxRate: number;
  grossProfitUsdt: number;
  tdsWithheldUsdt: number;
  taxDueUsdt: number;
  /** Σ(gross − tax): the economic result, ignoring when the cash moves. */
  netProfitUsdt: number;
  /** Cash already withheld and creditable against the year's bill. */
  tdsReceivableUsdt: number;
  /** Tax assessed but not yet paid. */
  taxLiabilityUsdt: number;
  /** `equity + receivable − liability` — equity once the tax year settles. */
  netEquityUsdt: number;
  trades: number;
  profitableTrades: number;
}

export interface Portfolio {
  balances: Array<{ asset: string; amount: number }>;
  equityUsdt: number;
  pnl: { absUsdt: number; pct: number };
  initialUsdt: number;
  tax: PortfolioTax;
}

/**
 * Value the paper portfolio.
 *
 * Equity is the USDT balance alone. Every cycle is atomic and round-trips to
 * USDT, so no other asset is ever held between scans; marking non-USDT dust to
 * market would mean pricing assets we cannot have, using a snapshot we would
 * have to fetch, on the app's most-polled route.
 *
 * `equityUsdt` and `pnl` keep their pre-Phase-8 meaning exactly: the cash in
 * the account, TDS already gone. The `tax` block is strictly additive, so a
 * client that ignores it sees the same portfolio it always did.
 */
async function buildPortfolio(db: D1Database): Promise<Portfolio> {
  const [balances, settings, totals] = await Promise.all([
    getBalances(db),
    getSettings(db),
    getTaxTotals(db),
  ]);
  const equityUsdt = balances.find((b) => b.asset === BASE_ASSET)?.amount ?? 0;
  const initialUsdt = settings.initial_usdt;
  const absUsdt = equityUsdt - initialUsdt;

  return {
    balances,
    equityUsdt,
    pnl: {
      absUsdt,
      // A zero starting balance has no meaningful percentage return.
      pct: initialUsdt > 0 ? (absUsdt / initialUsdt) * 100 : 0,
    },
    initialUsdt,
    tax: {
      indiaMode: settings.india_mode !== 0,
      tdsRate: settings.tds_rate,
      taxRate: settings.tax_rate,
      grossProfitUsdt: totals.grossProfit,
      tdsWithheldUsdt: totals.tdsWithheld,
      taxDueUsdt: totals.taxDue,
      netProfitUsdt: totals.netProfit,
      tdsReceivableUsdt: totals.tdsWithheld,
      taxLiabilityUsdt: totals.taxDue,
      netEquityUsdt: round8(equityUsdt + totals.tdsWithheld - totals.taxDue),
      trades: totals.trades,
      profitableTrades: totals.profitableTrades,
    },
  };
}

/**
 * Validate a `PUT /api/settings` body.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a
 * misspelled `min_profit` would leave the operator convinced they had changed
 * the threshold. Negative `min_profit_pct` is explicitly allowed — it is how
 * the demo forces fills in a market with no real edge.
 */
export function validateSettingsPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<Settings> } | { ok: false; error: string } {
  const allowed = new Set<string>(MUTABLE_SETTINGS);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown setting(s): ${unknown.join(", ")}` };
  }

  const patch: Partial<Settings> = {};
  for (const key of MUTABLE_SETTINGS) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `${key} must be a finite number` };
    }
    if (key === "trade_size_usdt" && value <= 0) {
      return { ok: false, error: "trade_size_usdt must be greater than 0" };
    }
    if (key === "fee_rate" && (value < 0 || value > MAX_FEE_RATE)) {
      return { ok: false, error: `fee_rate must be between 0 and ${MAX_FEE_RATE}` };
    }
    // A flag, not a rate: `1.5` or `2` almost certainly means the caller thinks
    // this field means something else, so it is rejected rather than coerced.
    if (key === "india_mode" && value !== 0 && value !== 1) {
      return { ok: false, error: "india_mode must be 0 or 1" };
    }
    if (key === "tds_rate" && (value < 0 || value > MAX_TDS_RATE)) {
      return { ok: false, error: `tds_rate must be between 0 and ${MAX_TDS_RATE}` };
    }
    if (key === "tax_rate" && (value < 0 || value > MAX_TAX_RATE)) {
      return { ok: false, error: `tax_rate must be between 0 and ${MAX_TAX_RATE}` };
    }
    // `xchg_min_profit_pct` needs no range check at all: like `min_profit_pct`
    // it is a threshold in percent, and a negative value is the documented way
    // to force demo fills. Any finite number is meaningful.
    if (key === "xchg_enabled" && value !== 0 && value !== 1) {
      return { ok: false, error: "xchg_enabled must be 0 or 1" };
    }
    patch[key as MutableSetting] = value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "no settings supplied" };
  }
  return { ok: true, patch };
}

/**
 * Build the Hono app. A factory rather than a module-level singleton so tests
 * can mount a fresh instance, and so `src/index.ts` stays a pure assembly file.
 */
export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // -- diagnostics ----------------------------------------------------------

  app.get("/api/health", async (c) => {
    const env = c.env;
    const sources = await Promise.all([probeBinanceWs(env), probeMexcRest(env)]);
    // `ok` means "market data is obtainable": either source alone is enough.
    return c.json({ ok: sources.some((s) => s.ok), ts: Date.now(), sources });
  });

  app.get("/api/version", (c) => c.json({ name: "crypto-arb", phase: 7 }));

  /**
   * Dev aid: resolve a snapshot for the given symbols through the real source
   * chain and report which source answered.
   */
  app.get("/api/tickers", async (c) => {
    const raw = c.req.query("symbols");
    const requested = raw
      ? raw
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, MAX_TICKER_SYMBOLS)
      : DEFAULT_TICKER_SYMBOLS;

    try {
      const snapshot = await getSnapshot(requested, c.env);
      const tickers = [...snapshot.book.values()].map(({ symbol, bid, ask }) => ({
        symbol,
        bid,
        ask,
      }));
      return c.json({
        source: snapshot.source,
        ts: snapshot.ts,
        count: tickers.length,
        tickers,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 502);
    }
  });

  // -- scanning -------------------------------------------------------------

  app.post("/api/scan", async (c) => {
    try {
      const result = await runScan(c.env, "manual");
      const opportunities =
        result.scanId != null
          ? await listOpportunitiesForScan(c.env.DB, result.scanId)
          : [];
      return c.json({ ...result, opportunities });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  // -- portfolio & history --------------------------------------------------

  app.get("/api/portfolio", async (c) => {
    try {
      await ensureSeeded(c.env.DB);
      return c.json(await buildPortfolio(c.env.DB));
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  app.get("/api/opportunities", async (c) => {
    try {
      const [fallback, max] = LIMITS.opportunities;
      const limit = parseLimit(c.req.query("limit"), fallback, max);
      const filter = parseStrategy(c.req.query("strategy"));
      if (!filter.ok) return c.json({ error: filter.error }, 400);

      const opportunities = await listOpportunities(c.env.DB, limit, filter.strategy);
      return c.json({
        count: opportunities.length,
        limit,
        strategy: filter.strategy ?? null,
        opportunities,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  app.get("/api/trades", async (c) => {
    try {
      const [fallback, max] = LIMITS.trades;
      const limit = parseLimit(c.req.query("limit"), fallback, max);
      const filter = parseStrategy(c.req.query("strategy"));
      if (!filter.ok) return c.json({ error: filter.error }, 400);

      const trades = await listTrades(c.env.DB, limit, filter.strategy);
      return c.json({
        count: trades.length,
        limit,
        strategy: filter.strategy ?? null,
        trades,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  app.get("/api/scans", async (c) => {
    try {
      const [fallback, max] = LIMITS.scans;
      const limit = parseLimit(c.req.query("limit"), fallback, max);
      const scans = await listScans(c.env.DB, limit);
      return c.json({ count: scans.length, limit, scans });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  // -- administration -------------------------------------------------------

  app.post("/api/reset", async (c) => {
    try {
      const body = await readJsonBody(c);
      if ("wipeHistory" in body && typeof body.wipeHistory !== "boolean") {
        return c.json({ error: "wipeHistory must be a boolean" }, 400);
      }
      // Default true: "reset" without qualification means start over.
      const wipeHistory = body.wipeHistory !== false;

      await ensureSeeded(c.env.DB);
      await resetAll(c.env.DB, { wipeHistory });
      return c.json({ ok: true, wipeHistory, ...(await buildPortfolio(c.env.DB)) });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  app.post("/api/admin/refresh-pairs", async (c) => {
    try {
      const pairs = await discoverPairs(ASSET_UNIVERSE, c.env);
      if (pairs.length === 0) {
        return c.json({ error: "pair discovery returned no markets" }, 502);
      }
      const source = "mexc-rest";
      const count = await replacePairs(c.env.DB, pairs, source);
      return c.json({ count, source });
    } catch (err) {
      return c.json({ error: message(err) }, 502);
    }
  });

  app.get("/api/pairs", async (c) => {
    try {
      const pairs = await getPairs(c.env.DB);
      return c.json({ count: pairs.length, pairs });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  // -- settings -------------------------------------------------------------

  app.get("/api/settings", async (c) => {
    try {
      await ensureSeeded(c.env.DB);
      return c.json(await getSettings(c.env.DB));
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  app.put("/api/settings", async (c) => {
    try {
      const body = await readJsonBody(c);
      const parsed = validateSettingsPatch(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      await ensureSeeded(c.env.DB);
      return c.json(await updateSettings(c.env.DB, parsed.patch));
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  return app;
}
