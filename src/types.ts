export interface Env {
  ASSETS: Fetcher;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
}

/**
 * One market's best quote, already parsed into numbers.
 *
 * Binance and MEXC both serve prices as decimal strings; everything downstream
 * (the arbitrage engine) works in numbers, so parsing happens once at the
 * client boundary and never again.
 */
export interface BookTickerEntry {
  /** Exchange symbol, upper-case, e.g. `BTCUSDT`. */
  symbol: string;
  /** Best bid: the price you receive when selling the base asset. */
  bid: number;
  /** Best ask: the price you pay when buying the base asset. */
  ask: number;
}

/** Which upstream produced a snapshot. Persisted per scan for diagnostics. */
export type SnapshotSource = "binance-ws" | "mexc-rest";

/** A point-in-time view of the order-book tops for a set of symbols. */
export interface Snapshot {
  source: SnapshotSource;
  /** Epoch millis at which the snapshot was completed. */
  ts: number;
  /** Keyed by upper-case symbol. */
  book: Map<string, BookTickerEntry>;
}

/** A tradable market decomposed into its two assets. */
export interface PairInfo {
  symbol: string;
  base: string;
  quote: string;
}
