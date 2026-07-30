/**
 * Shared value types for the pure arbitrage engine.
 *
 * The engine is deliberately self-contained: it imports nothing from `src/`
 * outside `src/engine/`, and nothing from Workers, Hono or the network. It is
 * plain functions over plain data, so it can be unit-tested in any runtime and
 * re-used unchanged by Phase 4's Worker routes (which adapt their own
 * `BookTickerEntry`/`Snapshot` shapes onto {@link Book}).
 */

/**
 * The top of an order book for one market.
 *
 * Structurally a subset of the client's `BookTickerEntry`, so a
 * `Map<string, BookTickerEntry>` can be handed straight to the engine without
 * conversion — while the engine keeps zero compile-time coupling to it.
 */
export interface BookEntry {
  /** Best bid: the price received when *selling* the base asset. */
  bid: number;
  /** Best ask: the price paid when *buying* the base asset. */
  ask: number;
}

/**
 * A point-in-time market snapshot, keyed by upper-case exchange symbol
 * (`"BTCUSDT"`). Read-only: the engine never mutates the book it is given.
 */
export type Book = ReadonlyMap<string, BookEntry>;

/** Which side of a market a conversion trades. */
export type Side = "BUY" | "SELL";

/**
 * One conversion, as actually priced against a snapshot.
 *
 * Amounts are rounded to 8 decimals (see `round8`); `price` is passed through
 * from the book untouched, because it is already at exchange tick precision and
 * rounding it would distort sub-satoshi markets.
 */
export interface ExecutedLeg {
  /** Exchange symbol traded, e.g. `"ETHBTC"`. */
  pair: string;
  side: Side;
  /** Ask for a BUY, bid for a SELL. */
  price: number;
  inAsset: string;
  inAmount: number;
  outAsset: string;
  outAmount: number;
}
