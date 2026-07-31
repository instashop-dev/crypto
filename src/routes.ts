/**
 * Every `/api/*` route.
 *
 * Handlers stay thin: they parse and validate input, call into `src/db.ts` or
 * `src/scan.ts`, and shape the response. All business rules (seeding, locking,
 * ranking, atomicity) live behind those modules so the cron path gets them for
 * free without going through HTTP.
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
import {
  ASSET_UNIVERSE,
  BASE_ASSET,
  FUNDING_POLL_INTERVAL_MS,
  perpAssets,
  STRATEGIES,
  type Strategy,
} from "./config";
import {
  CARRY_STATUS_OPEN,
  ensureSeeded,
  getBalances,
  getCarryTotals,
  getFundingPosition,
  getPairs,
  getSettings,
  getTaxTotals,
  listClosedFundingPositions,
  listFundingRatesForSymbol,
  listLatestFundingRates,
  listOpenFundingPositions,
  listOpportunities,
  listOpportunitiesForScan,
  listScans,
  listTrades,
  replacePairs,
  resetAll,
  updateSettings,
  type CarryTotals,
  type FundingRate,
  type Settings,
} from "./db";
import { rankVenueSpreads, round8, type VenueSpread } from "./engine";
import { FUNDING_VENUES } from "./funding";
import { closeCarryPosition, pollFundingRates, runScan } from "./scan";
import type { Env, FundingVenue } from "./types";

const MEXC_PING_PATH = "/api/v3/ping";
const MEXC_PROBE_TIMEOUT_MS = 8000;
/** Health probes get a longer WS budget than scans: a cold TLS handshake to
 *  Binance can eat most of the 4s scan deadline. */
const WS_PROBE_DEADLINE_MS = 5000;
const WS_PROBE_SYMBOL = "BTCUSDT";

/** Default markets for `/api/tickers` — a cheap, always-listed sample. */
const DEFAULT_TICKER_SYMBOLS = ["BTCUSDT", "ETHUSDT", "ETHBTC"];
/** Guard rail for the debug route so a stray query cannot build a huge stream URL. */
const MAX_TICKER_SYMBOLS = 100;

/** Per-collection pagination: `[default, max]`. */
const LIMITS = {
  opportunities: [50, 200],
  trades: [50, 200],
  scans: [20, 100],
  /** Funding history is one symbol's time series, so it is sampled far denser
   *  than the other collections: 100 rows is ~8 hours of 5-minute polls. */
  funding: [100, 500],
  /** Closed carry positions. Sparse by construction — a handful of slots each
   *  held for days — so a small default already covers months. */
  positions: [50, 200],
} as const;

/** Settings an operator may change at runtime. `initial_usdt` is not one of
 *  them: it is the denominator of every P&L figure ever reported, so moving it
 *  would silently rewrite history rather than change behaviour. */
const MUTABLE_SETTINGS = [
  "fee_rate",
  "perp_fee_rate",
  "india_mode",
  "tds_rate",
  "tax_rate",
  "xchg_min_profit_pct",
  "xchg_enabled",
  "funding_min_annual_pct",
  "funding_hold_days",
  "funding_positions_enabled",
  "funding_position_size_usdt",
  "funding_max_positions",
  "funding_exit_annual_pct",
] as const;
type MutableSetting = (typeof MUTABLE_SETTINGS)[number];

/**
 * Ceiling on how many paper carry positions may be open at once.
 *
 * Twenty is far past any concentration a three-slot default implies and still
 * bounded: the accrual pass walks every open position on every funding poll, so
 * an unbounded value would turn a fat-fingered digit into a D1 read loop.
 */
const MAX_FUNDING_POSITIONS = 20;

/**
 * Ceiling on the assumed carry holding period: 10 years.
 *
 * Not a market limit but an arithmetic one — `holdingDays` is a divisor in the
 * fee-drag term, so a fat-fingered `36500` would report an essentially fee-free
 * carry. Anything past a decade is a typo, not a strategy.
 */
const MAX_FUNDING_HOLD_DAYS = 3650;

/**
 * A funding board older than this is flagged stale to the client.
 *
 * Two poll intervals, not one: at exactly one interval every board is a
 * heartbeat away from "stale" and the badge would flicker on and off with
 * ordinary scheduling jitter. Missing *two* consecutive polls is a real signal.
 */
const FUNDING_STALE_MS = 2 * FUNDING_POLL_INTERVAL_MS;

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

/**
 * Parse a `?venue=` filter for the funding history. Absent means "every venue".
 *
 * Rejects an unknown name for the same reason {@link parseStrategy} does, and
 * validates against {@link FUNDING_VENUES} rather than against whatever strings
 * happen to be in the table: a venue retired tomorrow still has a week of rows
 * worth querying, and one added tomorrow should be queryable the moment it is
 * polled.
 */
function parseFundingVenue(
  raw: string | undefined,
): { ok: true; venue?: FundingVenue } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true };
  const venue = raw.trim().toLowerCase();
  if ((FUNDING_VENUES as readonly string[]).includes(venue)) {
    return { ok: true, venue: venue as FundingVenue };
  }
  return {
    ok: false,
    error: `unknown venue: ${raw} (expected one of ${FUNDING_VENUES.join(", ")})`,
  };
}

/**
 * Per-venue row counts for a board, in the order the venues first appear —
 * which, since the board is sorted by net carry, means best-paying venue first.
 *
 * Deliberately the same `{venue, count}` shape
 * {@link import("./scan").FundingPollResult.venues} carries, so the read
 * and the refresh endpoints describe a board identically.
 */
function summariseVenues(rates: FundingRate[]): Array<{ venue: string; count: number }> {
  const counts = new Map<string, number>();
  for (const rate of rates) {
    counts.set(rate.venue, (counts.get(rate.venue) ?? 0) + 1);
  }
  return [...counts.entries()].map(([venue, count]) => ({ venue, count }));
}

/**
 * Symbols whose identity is treated as verified across venues: the 11 majors.
 *
 * The rest of a multi-venue board is the fat tail — small caps, meme
 * contracts, tokens listed under a ticker somebody else also uses — and there
 * `BTC`-style confidence does not hold: two venues quoting `XYZ` are not
 * necessarily quoting the same project. A cross-venue *spread* is exactly the
 * figure that identity assumption makes or breaks, so the rows are still
 * reported and the assumption is labelled instead of being made silently.
 */
const VERIFIED_SPREAD_SYMBOLS: readonly string[] = perpAssets(
  ASSET_UNIVERSE,
  BASE_ASSET,
);

/** One side of a reported venue spread. */
export interface FundingSpreadLegBody {
  venue: string;
  /** The venue's own contract name — what to paste into its UI. */
  instrument: string;
  rate: number;
  intervalMinutes: number;
  /** `'api'` or `'assumed'`; an assumed cadence scales this leg's annual %. */
  intervalSource: string;
  annualizedPct: number;
}

/** One symbol's best venue pair, as `GET /api/funding` reports it. */
export interface FundingSpreadBody {
  symbol: string;
  /** See {@link VERIFIED_SPREAD_SYMBOLS}. */
  verifiedPair: boolean;
  /** The perp bought — the venue paying least. */
  long: FundingSpreadLegBody;
  /** The perp sold — the venue paying most. */
  short: FundingSpreadLegBody;
  grossAnnualPct: number;
  feeDragAnnualPct: number;
  netAnnualPct: number;
  /** Judged at read time against `funding_min_annual_pct`, as `rates` are. */
  qualifies: boolean;
}

function spreadLegBody(leg: VenueSpread<FundingRate>["long"]): FundingSpreadLegBody {
  return {
    venue: leg.venue,
    instrument: leg.quote.instrument,
    rate: leg.rate,
    intervalMinutes: leg.intervalMinutes,
    intervalSource: leg.quote.intervalSource,
    annualizedPct: leg.annualizedPct,
  };
}

/**
 * Cross-venue funding differentials for one board, best net first.
 *
 * Computed **at read time from the rows already fetched** — no schema, no write
 * path, no second query. A spread is a fact about one board, so deriving it when
 * the board is served means retuning `perp_fee_rate` or `funding_hold_days`
 * re-prices every differential immediately, exactly as `qualifies` is
 * re-judged, rather than freezing a stale answer into a table.
 *
 * The rows all share one `ts` ({@link listLatestFundingRates} selects a single
 * poll), which is what makes the comparison legitimate: two venues' rates from
 * different minutes would be a differential in time as much as in venue.
 */
function summariseSpreads(
  rates: FundingRate[],
  perpFeeRate: number,
  holdDays: number,
  minAnnualPct: number,
): FundingSpreadBody[] {
  return rankVenueSpreads(rates, perpFeeRate, holdDays, VERIFIED_SPREAD_SYMBOLS).map(
    (s) => ({
      symbol: s.symbol,
      verifiedPair: s.verifiedPair,
      long: spreadLegBody(s.long),
      short: spreadLegBody(s.short),
      grossAnnualPct: s.grossAnnualPct,
      feeDragAnnualPct: s.feeDragAnnualPct,
      netAnnualPct: s.netAnnualPct,
      qualifies: s.netAnnualPct >= minAnnualPct,
    }),
  );
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
  /**
   * Paper funding-carry positions, as a **section of its own**.
   *
   * Deliberately not folded into `equityUsdt`, `pnl` or `balances`. Migration
   * 0005's header is explicit about why: the spot figures are the frozen record
   * of an atomic fill era, a carry is held for days, and adding one to the other
   * would produce a number that reconciles against nothing. Read them side by
   * side; do not add them up.
   */
  carry: CarryTotals;
}

/**
 * Value the paper portfolio.
 *
 * Equity is the USDT balance alone. Nothing has moved a balance since Phase 12
 * removed the paper-fill paths, so this is a **frozen historical view**: the
 * cash the fill-era scanner left behind, TDS already gone, against the
 * `initial_usdt` it started from. Every field keeps the exact meaning it had,
 * which is the point — a portfolio that silently redefined its numbers when
 * fills stopped would make the old rows unreadable.
 */
async function buildPortfolio(db: D1Database): Promise<Portfolio> {
  const [balances, settings, totals, carry] = await Promise.all([
    getBalances(db),
    getSettings(db),
    getTaxTotals(db),
    getCarryTotals(db),
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
    carry,
  };
}

/**
 * Validate a `PUT /api/settings` body.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a
 * misspelled `xchg_min_profit` would leave the operator convinced they had
 * changed the threshold. Keys retired in Phase 12 (`min_profit_pct`,
 * `trade_size_usdt`) are unknown keys now and are rejected as such, which is
 * the honest answer — the behaviour they used to control no longer exists.
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
    // Both taker rates share one ceiling: the spot leg and the perp leg differ
    // in what they typically cost, not in what counts as a fat finger.
    if (
      (key === "fee_rate" || key === "perp_fee_rate") &&
      (value < 0 || value > MAX_FEE_RATE)
    ) {
      return { ok: false, error: `${key} must be between 0 and ${MAX_FEE_RATE}` };
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
    // `xchg_min_profit_pct` needs no range check at all: it is a display
    // threshold on a figure that is routinely negative, so any finite number is
    // meaningful and a negative one simply widens what qualifies.
    if (key === "xchg_enabled" && value !== 0 && value !== 1) {
      return { ok: false, error: "xchg_enabled must be 0 or 1" };
    }
    // `funding_min_annual_pct` is the same case, for the same reason.
    if (
      key === "funding_hold_days" &&
      (value <= 0 || value > MAX_FUNDING_HOLD_DAYS)
    ) {
      return {
        ok: false,
        error: `funding_hold_days must be between 0 and ${MAX_FUNDING_HOLD_DAYS}`,
      };
    }
    // A flag, as `india_mode` and `xchg_enabled` are, and rejected rather than
    // coerced for the same reason.
    if (key === "funding_positions_enabled" && value !== 0 && value !== 1) {
      return { ok: false, error: "funding_positions_enabled must be 0 or 1" };
    }
    // Strictly positive: it is the notional of both legs and the denominator of
    // every realised percentage, so a zero would make the whole position
    // unpriceable rather than small.
    if (key === "funding_position_size_usdt" && value <= 0) {
      return { ok: false, error: "funding_position_size_usdt must be greater than 0" };
    }
    // A count, so a fractional value is a caller error rather than something to
    // round: `2.5` positions is not a smaller book, it is a misunderstanding.
    if (
      key === "funding_max_positions" &&
      (!Number.isInteger(value) || value < 1 || value > MAX_FUNDING_POSITIONS)
    ) {
      return {
        ok: false,
        error: `funding_max_positions must be a whole number between 1 and ${MAX_FUNDING_POSITIONS}`,
      };
    }
    // `funding_exit_annual_pct` takes any finite number, exactly as
    // `funding_min_annual_pct` does: it is a threshold on a figure that is
    // routinely negative, and a negative bar simply holds a position longer.
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

  app.get("/api/version", (c) => c.json({ name: "crypto-arb", phase: 10 }));

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

  /**
   * Ranked opportunities, newest first.
   *
   * `qualifies` is computed **here**, against the current
   * `xchg_min_profit_pct`, exactly as `GET /api/funding` does with its own
   * threshold — and for the same reason: it is a judgement about a
   * measurement, not part of it, so raising the bar must re-classify yesterday's
   * rows rather than leave them answering a question nobody asks any more.
   *
   * It replaced an execution gate in Phase 12. When the threshold decided which
   * spread got filled it had to be applied at write time and the rows below it
   * were the ones nobody could learn anything from; as a display flag it costs
   * nothing and throws nothing away.
   *
   * Since Phase 16 every row also carries `skewMs`, `persistNetPct` and
   * `persistCheckedTs` — how far apart the two books were, and what the same
   * trade was worth on the next scan's books. `null` throughout means **not
   * measured**, and `persistCheckedTs` set with a null `persistNetPct` means
   * the row expired before any fresh snapshot could price it. Those three are
   * the whole of the evidence for whether this strategy is real; see the
   * decision rule in the README.
   */
  app.get("/api/opportunities", async (c) => {
    try {
      const [fallback, max] = LIMITS.opportunities;
      const limit = parseLimit(c.req.query("limit"), fallback, max);
      const filter = parseStrategy(c.req.query("strategy"));
      if (!filter.ok) return c.json({ error: filter.error }, 400);

      await ensureSeeded(c.env.DB);
      const [opportunities, settings] = await Promise.all([
        listOpportunities(c.env.DB, limit, filter.strategy),
        getSettings(c.env.DB),
      ]);

      const minProfitPct = settings.xchg_min_profit_pct;
      return c.json({
        count: opportunities.length,
        limit,
        strategy: filter.strategy ?? null,
        minProfitPct,
        opportunities: opportunities.map((o) => ({
          ...o,
          qualifies: o.netPct >= minProfitPct,
        })),
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  /**
   * The trade log — **historical only**. Nothing has written a row here since
   * Phase 12 removed the paper-fill paths; the route stays because the rows it
   * serves are the record of what the fill-era scanner did, and deleting the
   * reader would have been the destructive half of a migration nobody asked for.
   */
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

  // -- funding rates --------------------------------------------------------

  /**
   * The newest funding board, best net carry first.
   *
   * `qualifies` is computed **here**, against the current
   * `funding_min_annual_pct`, rather than stored on the row: it is a judgement
   * about a measurement, not part of it, and raising the threshold must
   * re-classify yesterday's rows rather than leave them claiming an answer to a
   * question nobody asks any more. The two percentages beside it are the
   * opposite case — they were computed from the fee rates in force at poll time
   * and are stored, so retuning `fee_rate` or `perp_fee_rate` re-prices future
   * boards only and does not rewrite history.
   *
   * `spreads` is the same board read a second way: per symbol quoted by two or
   * more venues, the widest differential available, priced as an all-perp pair
   * trade (long the venue paying least, short the one paying most). Derived
   * here rather than stored, for the reason `qualifies` is — see
   * {@link summariseSpreads}.
   *
   * An empty table answers 200, not 404: "no board yet" is the state of every
   * deployment for its first few seconds.
   */
  app.get("/api/funding", async (c) => {
    try {
      await ensureSeeded(c.env.DB);
      const [rates, settings] = await Promise.all([
        listLatestFundingRates(c.env.DB),
        getSettings(c.env.DB),
      ]);

      const minAnnualPct = settings.funding_min_annual_pct;
      const shared = {
        minAnnualPct,
        holdDays: settings.funding_hold_days,
        feeRate: settings.fee_rate,
        perpFeeRate: settings.perp_fee_rate,
        pollIntervalMs: FUNDING_POLL_INTERVAL_MS,
      };

      if (rates.length === 0) {
        return c.json({
          ts: null,
          ageMs: null,
          stale: false,
          venue: null,
          venues: [],
          count: 0,
          ...shared,
          rates: [],
          spreadCount: 0,
          spreads: [],
        });
      }

      const ts = rates[0].ts;
      const ageMs = Date.now() - ts;
      const spreads = summariseSpreads(
        rates,
        settings.perp_fee_rate,
        settings.funding_hold_days,
        minAnnualPct,
      );
      return c.json({
        ts,
        ageMs,
        stale: ageMs > FUNDING_STALE_MS,
        // The venue behind the best row, unchanged in meaning and kept for the
        // dashboard's one-line summary; `venues` is the full picture.
        venue: rates[0].venue,
        venues: summariseVenues(rates),
        count: rates.length,
        ...shared,
        rates: rates.map((r: FundingRate) => ({
          ...r,
          qualifies: r.netAnnualPct >= minAnnualPct,
        })),
        // A second, derived view of the same board: what the *differences*
        // between venues are worth as an all-perp pair trade. Its own section
        // rather than a column on `rates`, because a spread is a property of a
        // pair of rows and belongs to neither of them.
        spreadCount: spreads.length,
        spreads,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  /**
   * One symbol's funding history, newest first. Unknown symbols are empty.
   *
   * `?venue=` is optional and defaults to every venue. Since Phase 14 polls all
   * of them, one symbol has up to four rows per timestamp, and a series drawn
   * from the mixture would zig-zag between venues instead of showing either
   * one's rate. An unrecognised venue is **rejected** rather than ignored, for
   * the reason `?strategy=` is: a silently-ignored filter looks exactly like a
   * venue that never quotes.
   */
  app.get("/api/funding/history", async (c) => {
    try {
      const symbol = (c.req.query("symbol") ?? "").trim().toUpperCase();
      if (!symbol) return c.json({ error: "symbol is required" }, 400);

      const filter = parseFundingVenue(c.req.query("venue"));
      if (!filter.ok) return c.json({ error: filter.error }, 400);

      const [fallback, max] = LIMITS.funding;
      const limit = parseLimit(c.req.query("limit"), fallback, max);
      const rates = await listFundingRatesForSymbol(
        c.env.DB,
        symbol,
        limit,
        filter.venue,
      );
      return c.json({
        symbol,
        venue: filter.venue ?? null,
        count: rates.length,
        limit,
        rates,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  /**
   * Poll the board now, bypassing the scan's 5-minute gate.
   *
   * Rows land with `scan_id = NULL`: this poll belongs to no scan, and minting
   * a `scans` row for it would put a scan in the history that never looked at a
   * single market. 502 rather than 500 when *every* venue fails — the failure
   * is upstream, exactly as it is for `/api/tickers`. One venue failing is a
   * 200 with the survivors' board and the dead one named in `venueErrors`.
   *
   * `venues` is `[{venue, count}]`, the same shape `GET /api/funding` reports:
   * both describe one board, so a reader must not have to know which endpoint
   * produced the field in order to parse it.
   */
  app.post("/api/funding/refresh", async (c) => {
    try {
      await ensureSeeded(c.env.DB);
      const { count, venue, venues, venueErrors, ts } = await pollFundingRates(
        c.env,
        null,
      );
      return c.json({ count, venue, venues, venueErrors, ts });
    } catch (err) {
      return c.json({ error: message(err) }, 502);
    }
  });

  /**
   * The paper carry book: every open position, the most recently closed ones,
   * and the summary the dashboard's header line is built from.
   *
   * The pair worth reading is `predictedNetAnnualPct` against
   * `realizedAnnualPct` on a closed row. The first is what the rate observed at
   * entry said a year of it would pay; the second is what it actually paid over
   * the days it was actually held. Their difference is the extrapolation error
   * `src/engine/funding.ts` names as its dominant unknown — measured, not
   * asserted. `summary.avgPredictionErrorPct` is the mean of it, and is `null`
   * until something has closed, because an average of no positions is not zero.
   *
   * An empty book answers 200 with empty lists, exactly as `/api/funding` does
   * with an empty board: "nothing open" is the state of every deployment for its
   * first few hours.
   */
  app.get("/api/funding/positions", async (c) => {
    try {
      const [fallback, max] = LIMITS.positions;
      const limit = parseLimit(c.req.query("limit"), fallback, max);

      await ensureSeeded(c.env.DB);
      const [open, closed, summary, settings] = await Promise.all([
        listOpenFundingPositions(c.env.DB),
        listClosedFundingPositions(c.env.DB, limit),
        getCarryTotals(c.env.DB),
        getSettings(c.env.DB),
      ]);

      return c.json({
        openCount: open.length,
        closedCount: closed.length,
        limit,
        summary,
        // Echoed so the panel can say *why* the book looks the way it does —
        // an empty book under `enabled: 0` is a switch, not a market.
        settings: {
          enabled: settings.funding_positions_enabled !== 0,
          sizeUsdt: settings.funding_position_size_usdt,
          maxPositions: settings.funding_max_positions,
          minAnnualPct: settings.funding_min_annual_pct,
          exitAnnualPct: settings.funding_exit_annual_pct,
          holdDays: settings.funding_hold_days,
        },
        open,
        closed,
      });
    } catch (err) {
      return c.json({ error: message(err) }, 500);
    }
  });

  /**
   * Close one position by hand, with `close_reason = 'manual'`.
   *
   * 404 for an id that does not exist and **409** for one that is already
   * closed — not 200. A second close would overwrite a realised P&L the scanner
   * had already computed and silently rewrite the very series this table exists
   * to produce, so "already closed" is a conflict, not a no-op.
   */
  app.post("/api/funding/positions/:id/close", async (c) => {
    try {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: "id must be a positive integer" }, 400);
      }

      await ensureSeeded(c.env.DB);
      const position = await getFundingPosition(c.env.DB, id);
      if (!position) return c.json({ error: `no such position: ${id}` }, 404);
      if (position.status !== CARRY_STATUS_OPEN) {
        return c.json(
          { error: `position ${id} is already closed (${position.closeReason})` },
          409,
        );
      }

      const closed = await closeCarryPosition(
        c.env.DB,
        position,
        "manual",
        Date.now(),
      );
      if (!closed) {
        // Lost a race with the scanner's own close rules between the read and
        // the write. The position *is* closed, just not by this call.
        return c.json({ error: `position ${id} is already closed` }, 409);
      }
      return c.json({ ok: true, position: await getFundingPosition(c.env.DB, id) });
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
