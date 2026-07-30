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
} as const;

export type Defaults = typeof DEFAULTS;

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
