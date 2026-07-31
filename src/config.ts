/**
 * Static configuration for the paper-trading arbitrage MVP.
 *
 * Pure module: no Workers imports, no I/O. Safe to import from the engine,
 * the client, tests and throwaway scripts alike.
 */

/**
 * Assets the scanner is allowed to route through. Every triangle starts and
 * ends at {@link BASE_ASSET}; the remaining assets are the intermediate hops.
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

/** The settlement asset: paper balances and P&L are denominated in it. */
export const BASE_ASSET = "USDT";

/**
 * Tunable strategy defaults. Phase 4 seeds the D1 `settings` table from these
 * and thereafter reads the table, so this object is the fallback / first-run
 * source of truth only.
 */
export const DEFAULTS = {
  /** Taker fee charged per leg, as a fraction (0.001 = 0.1%). */
  fee_rate: 0.001,
  /** Minimum net profit, in percent, required before a cycle is executed. */
  min_profit_pct: 0.05,
  /** Notional committed to each simulated cycle, in USDT. */
  trade_size_usdt: 100,
  /** Starting paper balance, in USDT. */
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
   * Minimum net profit, in percent, required before a **spread** is executed.
   *
   * Separate from `min_profit_pct` because the two strategies have different
   * break-evens (2 legs of fees vs 3) and different noise floors — a cross-venue
   * spread is mostly timing skew, so an operator will usually want it stricter
   * than the triangular threshold, and one shared knob would force a compromise
   * that is wrong for both. Negative means demo mode, exactly as it does for
   * `min_profit_pct`.
   */
  xchg_min_profit_pct: 0.05,
  /**
   * Cross-exchange kill switch, `0` off / `1` on. Numeric for the same reason
   * `india_mode` is: the settings table is "TEXT parsed as a finite number".
   *
   * On by default — the feature is the point of this phase — but setting it to
   * `0` restores the pre-Phase-9 scan path exactly: one snapshot through the
   * usual primary/fallback chain, no second REST call, no spread rows.
   */
  xchg_enabled: 1,
} as const;

export type Defaults = typeof DEFAULTS;

/**
 * Which scanner produced a row. Persisted in `opportunities.strategy` and
 * `trades.strategy`, and accepted as the `?strategy=` filter on the history
 * routes.
 */
export type Strategy = "triangular" | "cross_exchange";

/** Triangular cycles within one venue's book: `USDT -> BTC -> ETH -> USDT`. */
export const STRATEGY_TRIANGULAR = "triangular";
/** The same market on two venues: buy on the cheaper, sell on the dearer. */
export const STRATEGY_CROSS_EXCHANGE = "cross_exchange";

/**
 * Every known strategy. The one place the vocabulary is enumerated — the D1
 * columns are plain TEXT with a default, so this list (not a CHECK constraint)
 * is what `?strategy=` validates against.
 */
export const STRATEGIES: readonly Strategy[] = [
  STRATEGY_TRIANGULAR,
  STRATEGY_CROSS_EXCHANGE,
] as const;

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
