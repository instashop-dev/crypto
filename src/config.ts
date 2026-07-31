/**
 * Static configuration for the market-observation scanner.
 *
 * Pure module: no Workers imports, no I/O. Safe to import from the engine,
 * the client, tests and throwaway scripts alike.
 */

/**
 * Assets the scanner watches. Cross-exchange spreads are priced on the
 * `<asset>/{@link BASE_ASSET}` markets; funding carry is quoted on the
 * `<asset>USDT` perpetuals (see {@link perpAssets}).
 */
export const ASSET_UNIVERSE: string[] = [
  "USDT",
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "XRP",
  "DOGE",
  "ADA",
  "LTC",
  "TRX",
  "AVAX",
  "LINK",
];

/** The settlement asset: the historical paper balances and P&L are in it. */
export const BASE_ASSET = "USDT";

/**
 * Tunable defaults. `ensureSeeded` materialises the D1 `settings` table from
 * these and thereafter reads the table, so this object is the fallback /
 * first-run source of truth only.
 *
 * Keys removed here (Phase 12 dropped `min_profit_pct` and `trade_size_usdt`
 * with the paper-fill machinery) simply stop being read: `getSettings` ignores
 * rows whose key is not in `SETTING_KEYS`, so a database seeded by an older
 * release keeps working and its stale rows are inert.
 */
export const DEFAULTS = {
  /**
   * Spot taker fee charged per leg, as a fraction (0.001 = 0.1%). Used by the
   * cross-exchange spread math (both of whose legs are spot) and by the two
   * spot legs of a funding carry.
   */
  fee_rate: 0.001,
  /**
   * Perp taker fee charged per leg, as a fraction (0.0005 = 0.05%).
   *
   * Its own setting because a perp desk charges roughly half what a spot desk
   * does — 0.05% is OKX's and Bybit's standard linear-perp taker rate against
   * 0.1% spot. Charging the spot rate on the carry's two perp legs, as every
   * phase before this one did, overstated the round trip by a third (0.4% of
   * notional against 0.3%) and understated a 30-day carry by ~1.2%/yr.
   */
  perp_fee_rate: 0.0005,
  /** Starting paper balance, in USDT: the denominator of every P&L figure. */
  initial_usdt: 10000,
  /**
   * India-mode toggle, `0` off / `1` on. Numeric rather than boolean because
   * the whole settings table is "TEXT parsed as a finite number" — a lone
   * boolean would need its own parse path and its own failure mode.
   *
   * Off by default: it is a reporting overlay for one jurisdiction, and turning
   * it on must be a deliberate act, not something a fresh deployment inherits.
   */
  india_mode: 0,
  /** Section 194S withholding per VDA transfer, as a fraction (0.01 = 1%). */
  tds_rate: 0.01,
  /**
   * Section 115BBH rate on gains, as a fraction (0.3 = 30%). Set `0.312` to
   * include the 4% health-and-education cess.
   */
  tax_rate: 0.3,
  /**
   * Net percent a **spread** must clear to be flagged as an opportunity.
   *
   * Display-only, exactly like `funding_min_annual_pct`: every priced spread is
   * persisted regardless, and nothing is ever filled. Phase 12 demoted it from
   * an execution gate — a gate that dropped rows would have thrown away the
   * measurement this scanner exists to make.
   */
  xchg_min_profit_pct: 0.05,
  /**
   * Cross-exchange kill switch, `0` off / `1` on. Numeric for the same reason
   * `india_mode` is: the settings table is "TEXT parsed as a finite number".
   *
   * On by default. Setting it to `0` leaves the scan with nothing to do on the
   * spot side: no snapshots are fetched and no spread rows are written, while
   * the funding poll carries on untouched.
   */
  xchg_enabled: 1,
  /**
   * Net annualised percent a funding-rate carry must clear to be flagged as an
   * opportunity on the dashboard — **and, since Phase 15, the bar a board row
   * must clear for a paper position to be opened on it.**
   *
   * Still not a *write-time* gate on the board itself: every quote is persisted
   * regardless of this number, because a carry is held for days and the history
   * is the point — a row that was 4% yesterday and 12% today is the signal, and
   * dropping rows below the bar would have thrown the first half away. What
   * changed in Phase 15 is that the flag now also selects; raising it stops new
   * positions being opened and re-labels the board, and it never closes one
   * (`funding_exit_annual_pct` does that, deliberately from lower down).
   *
   * 5% is roughly the point above which the carry beats a T-bill, which is the
   * only honest benchmark for a delta-neutral trade.
   */
  funding_min_annual_pct: 5,
  /**
   * Assumed holding period, in days, used to amortise the round-trip fee.
   *
   * The funding stream accrues per interval while the 4 legs of fees (2 spot
   * at `fee_rate`, 2 perp at `perp_fee_rate`) are paid once, so the net figure
   * is meaningless without saying how long the position is held. 30 days is a
   * month of carry — long enough that fees are a minor drag, short enough to be
   * a decision someone would actually make.
   */
  funding_hold_days: 30,
  /**
   * Paper carry positions on/off, `0` off / `1` on. Numeric for the same reason
   * `india_mode` is: the settings table is "TEXT parsed as a finite number".
   *
   * **On by default**, unlike every other feature switch here, because these
   * positions are the measurement the funding board exists to enable — the
   * realized-vs-predicted pair in `funding_positions` is the only thing in the
   * repo that tests the "this rate repeats 1095 times" extrapolation rather
   * than restating it. Nothing they do touches `balances` or places an order,
   * so the cost of having them on is a few rows a week.
   */
  funding_positions_enabled: 1,
  /**
   * Notional of each leg of a paper carry, in USDT: long this much spot, short
   * this much perp.
   *
   * 1000 rather than a slice of `initial_usdt`, because these positions are
   * deliberately *not* booked against the paper balance (see the header of
   * migration 0005) — there is no pool for them to draw down, so a percentage
   * of one would be a fiction. The figure only scales the USDT columns; every
   * percentage the table reports is a ratio and is unaffected by it.
   */
  funding_position_size_usdt: 1000,
  /**
   * How many carry positions may be open at once.
   *
   * A concentration limit on a paper book, so it is about the *measurement*
   * rather than about risk: three contracts is enough that one venue dropping
   * a symbol does not empty the series, and few enough that the realised
   * figures stay attributable to particular contracts instead of averaging into
   * a portfolio nobody chose.
   */
  funding_max_positions: 3,
  /**
   * Net annualised % below which an open carry is closed.
   *
   * Zero — not `funding_min_annual_pct`. The bar to *open* is deliberately
   * higher than the bar to *stay*: the round trip of fees is already paid on an
   * open position, so a carry that has slipped from 12% to 4% is still earning
   * where a new one at 4% might not clear its own entry cost. Closing at zero
   * means "close when the funding has actually turned against us", which is the
   * event worth measuring.
   */
  funding_exit_annual_pct: 0,
} as const;

export type Defaults = typeof DEFAULTS;

/**
 * Which scanner produced a row. Persisted in `opportunities.strategy` and
 * `trades.strategy`, and accepted as the `?strategy=` filter on the history
 * routes.
 */
export type Strategy = "triangular" | "cross_exchange";

/**
 * Triangular cycles within one venue's book: `USDT -> BTC -> ETH -> USDT`.
 *
 * **Historical only.** Phase 12 deleted the strategy — no new row is ever
 * written with this value. It survives as the vocabulary for the rows already
 * on disk: it is what `toOpportunity`/`toTrade` fall back to for a row written
 * before the `strategy` column existed, and what `?strategy=triangular` reads
 * back. Removing it would make years of history unqueryable to save one line.
 */
export const STRATEGY_TRIANGULAR = "triangular";
/** The same market on two venues: buy on the cheaper, sell on the dearer. */
export const STRATEGY_CROSS_EXCHANGE = "cross_exchange";

/**
 * Every strategy the history may contain. The one place the vocabulary is
 * enumerated — the D1 columns are plain TEXT with a default, so this list (not
 * a CHECK constraint) is what `?strategy=` validates against. It is a superset
 * of what the scanner still writes; see {@link STRATEGY_TRIANGULAR}.
 */
export const STRATEGIES: readonly Strategy[] = [
  STRATEGY_TRIANGULAR,
  STRATEGY_CROSS_EXCHANGE,
] as const;

/**
 * How often the funding board is polled, in milliseconds.
 *
 * Not a setting: funding settles every 8 hours on almost every contract, so a
 * 5-minute refresh is already ~96x oversampled and there is nothing an operator
 * would gain by tuning it. It exists as a constant only so the minutely scan
 * does not make an upstream call it has no use for — see the poll gate in
 * `src/scan.ts`.
 */
export const FUNDING_POLL_INTERVAL_MS = 300_000;

/**
 * How far the basis poll is offset from the funding poll: 2.5 minutes, half of
 * {@link FUNDING_POLL_INTERVAL_MS}.
 *
 * The two polls run on the same interval and are both gated on a marker written
 * with the scan's `startedAt`, so left alone they align on the first scan that
 * fires both and then stay in lockstep forever. That co-firing scan pays them
 * **serially inside one scan lock**: the funding block's worst case is ~18s
 * (cadence fetch plus a venue timeout) and the basis block's is ~9s, and with
 * the spot snapshot on top that is ~35s of a `SCAN_LOCK_TTL_MS` of 45s. It fits,
 * but a single slow venue on either side is enough to lose the margin — and a
 * scan that runs past its lock TTL can be overlapped by the next one.
 *
 * So the basis gate seeds its marker on a **cold start** rather than polling
 * (`src/scan.ts`), placing its first poll half an interval after funding's.
 * Thereafter the two alternate: worst case per scan becomes the larger of the
 * two blocks rather than their sum.
 *
 * Half the interval rather than a smaller nudge because it is the only offset
 * that is equally far from the poll before and the poll after, so neither drifts
 * back into the other under jitter.
 */
export const BASIS_POLL_STAGGER_MS = 150_000;

/**
 * How many *best-paying* non-major contracts each venue contributes to a
 * persisted board.
 *
 * Gate and KuCoin quote 850+ and 660+ USDT perps respectively, and the whole
 * point of Phase 14 is that the fat tail of funding lives out there — but
 * persisting every contract of every venue on every 5-minute poll would write
 * ~1.5M rows a week for a table nothing reads past its first page. So each
 * venue keeps the {@link ASSET_UNIVERSE} majors unconditionally (they are the
 * continuous series the history charts are built on, and dropping one the day
 * its funding goes flat would put a hole in it) plus a budget of its own tail:
 * this many from the top, {@link FUNDING_BOARD_BOTTOM_N} from the bottom.
 *
 * 20 + 5 = 25 is a display budget, not a market judgement: the dashboard shows
 * one board and nobody scrolls past the top few dozen rows. Raising either half
 * costs rows linearly and nothing else.
 */
export const FUNDING_BOARD_TOP_N = 20;

/**
 * How many *deeply negative* non-major contracts each venue contributes.
 *
 * A one-sided "top N by net annual" cap threw these away, and they are not
 * noise: `rankFundingOpportunities` in `src/engine/funding.ts` keeps them on
 * the stated grounds that "a deeply negative rate is the headline result of the
 * scan on the day it happens". A live Gate board quoted `LA_USDT` at roughly
 * **-1548%/yr**; under a pure top-25 cap that row could never have been
 * persisted, so the most extreme figure on the board was systematically the one
 * nobody could ever see. Keeping the rows and then capping them away undid the
 * decision the engine had already made.
 *
 * Five rather than more because the negative tail is thin: on a real board a
 * handful of contracts sit far below zero and the rest cluster near it, so the
 * sixth-worst row is rarely telling anyone anything the fifth did not.
 */
export const FUNDING_BOARD_BOTTOM_N = 5;

/**
 * How long a cached funding-interval map is trusted, in milliseconds.
 *
 * A contract's settlement cadence changes on the order of never; when a venue
 * does change one it announces it weeks ahead. A day of staleness costs at most
 * one day of rows tagged with the old interval, against one saved request on
 * every one of the ~288 daily polls.
 */
export const FUNDING_INTERVAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The universe minus the settlement asset: the assets with a `<X>USDT` perp
 * worth quoting. 11 of the 12 for the shipped universe.
 *
 * `USDT` is excluded because there is no `USDTUSDT` perpetual — the base asset
 * is the thing the contract is *quoted in*, not something one carries against
 * itself.
 */
export function perpAssets(universe: string[], base: string): string[] {
  return universe.filter((asset) => asset !== base);
}

/**
 * Every ordered concatenation `A + B` with `A !== B` for the given universe.
 *
 * Exchanges name a market by base+quote with no separator and only list one
 * direction (BTCUSDT exists, USDTBTC does not), but which direction is listed
 * is not knowable a priori. So both orderings are emitted and the result is
 * intersected with the exchange's actual symbol list by
 * {@link import("./binance").discoverPairs}.
 *
 * For the 12-asset universe this yields 12 x 11 = 132 candidates.
 */
export function candidateSymbols(universe: string[]): string[] {
  const out: string[] = [];
  for (const a of universe) {
    for (const b of universe) {
      if (a === b) continue;
      out.push(a + b);
    }
  }
  return out;
}
