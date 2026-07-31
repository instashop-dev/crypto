/**
 * Shared leg-pricing primitives.
 *
 * Pure module: no I/O, no clock, no Workers or Hono imports, no dependency on
 * `src/` outside `src/engine/`. Everything is deterministic given its arguments.
 *
 * These three functions were the reusable core of the triangular engine that
 * Phase 12 deleted. They survive it because two things that are *not*
 * triangular still need them:
 *
 * - `./crossExchange` and `./funding` quantise every reported figure with
 *   {@link round8};
 * - `./tax` prices an arbitrary chain of hops through {@link convert}, and a
 *   spread is such a chain (`USDT -> X -> USDT`).
 *
 * They live here rather than in either caller so that neither strategy module
 * has to import the other's internals.
 *
 * ## Modelling simplifications (unchanged from the MVP)
 *
 * - **Depth is ignored.** Every leg fills entirely at the top-of-book quote,
 *   regardless of size. Real fills would walk the book and be strictly worse,
 *   so reported profits are an upper bound.
 * - **Exchange filters are ignored** — no lot-size, tick-size or min-notional
 *   rounding is applied to leg amounts.
 * - **Fees are taker fees taken from the output asset** of each leg, which is
 *   how an exchange charges a market order settling in the received asset.
 */
import type { Book, ExecutedLeg, Side } from "./types";

/**
 * One hop of a conversion chain: convert `from` into `to` on market `pair`.
 *
 * The side follows from how the exchange lists the market:
 *
 * - listed as `to + from` (base = `to`, quote = `from`) — we spend the quote to
 *   acquire the base, i.e. **BUY** the base, filled at the **ask**;
 * - listed as `from + to` (base = `from`, quote = `to`) — we give up the base to
 *   receive the quote, i.e. **SELL** the base, filled at the **bid**.
 */
export interface Leg {
  pair: string;
  side: Side;
  from: string;
  to: string;
}

/**
 * Resolve the market that converts `from` into `to`, or `null` when the
 * exchange lists neither direction.
 *
 * Exchanges list a market in exactly one direction (`ETHBTC` exists, `BTCETH`
 * does not) and which direction that is cannot be derived from the asset names,
 * so each leg is resolved by probing both spellings against the book. `to +
 * from` is probed first so that a hypothetical exchange listing both spellings
 * resolves deterministically (BUY wins).
 */
export function resolveLeg(from: string, to: string, book: Book): Leg | null {
  if (!from || !to || from === to) return null;

  const buyPair = to + from;
  if (book.has(buyPair)) {
    return { pair: buyPair, side: "BUY", from, to };
  }

  const sellPair = from + to;
  if (book.has(sellPair)) {
    return { pair: sellPair, side: "SELL", from, to };
  }

  return null;
}

/**
 * Round to 8 decimals — the precision every amount we hand out or store is
 * quantised to, so that D1 rows, API responses and test expectations all agree
 * instead of drifting by float dust.
 *
 * Applied to *reported* amounts only. A conversion chain itself carries full
 * double precision (see {@link convert}): quantising mid-chain would be
 * catastrophic on a notional of 1, where a BTC leg holds ~2e-5 and 8-decimal
 * rounding is a ~0.1% error — the same order of magnitude as the edge being
 * measured.
 */
export function round8(n: number): number {
  if (!Number.isFinite(n)) return Number.NaN;
  const scaled = n * 1e8;
  // Beyond 2^53 the multiply has already lost more than the rounding would
  // remove, so pass the value through rather than corrupt it.
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    return n;
  }
  return Math.round(scaled) / 1e8;
}

/** A usable amount or price: a real, strictly positive number. */
function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A usable fee rate: real, non-negative, and less than 100%. */
function isValidFee(feeRate: number): boolean {
  return Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1;
}

/**
 * Convert `amount` of `from` into `to` at the snapshot's best quote.
 *
 * Direction is resolved from the book's own keys (see {@link resolveLeg}):
 *
 * - book lists `to + from` — BUY the base at the **ask**:
 *   `out = amount / ask * (1 - feeRate)`
 * - book lists `from + to` — SELL the base at the **bid**:
 *   `out = amount * bid * (1 - feeRate)`
 *
 * Returns `null` — never a `NaN`/`Infinity` result — when neither direction is
 * listed, when the quote is poisoned (non-finite or non-positive bid *or* ask),
 * when `amount` is not a positive real, when `feeRate` is out of range, or when
 * the arithmetic would produce a non-finite output.
 *
 * The returned `out` is **unrounded** and is what callers must chain into the
 * next leg; `leg.outAmount` is the same value quantised by {@link round8} for
 * reporting.
 */
export function convert(
  from: string,
  to: string,
  amount: number,
  book: Book,
  feeRate: number,
): { out: number; leg: ExecutedLeg } | null {
  if (!isPositive(amount) || !isValidFee(feeRate)) return null;

  const leg = resolveLeg(from, to, book);
  if (!leg) return null;

  const entry = book.get(leg.pair);
  if (!entry) return null;
  // Both sides are validated even though only one is used: an entry with a
  // broken half is a corrupt quote, and silently trading the other half of it
  // would launder bad data into the P&L.
  if (!isPositive(entry.bid) || !isPositive(entry.ask)) return null;

  const price = leg.side === "BUY" ? entry.ask : entry.bid;
  const converted = leg.side === "BUY" ? amount / price : amount * price;
  const out = converted * (1 - feeRate);
  if (!isPositive(out)) return null;

  return {
    out,
    leg: {
      pair: leg.pair,
      side: leg.side,
      price,
      inAsset: from,
      inAmount: round8(amount),
      outAsset: to,
      outAmount: round8(out),
    },
  };
}
