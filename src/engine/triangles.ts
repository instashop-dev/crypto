/**
 * Triangle enumeration.
 *
 * A "triangle" is an ordered cycle `base -> A -> B -> base` whose three legs
 * are all tradable in the snapshot we hold. Enumeration is driven entirely by
 * the book's actual keys: exchanges list a market in exactly one direction
 * (`ETHBTC` exists, `BTCETH` does not) and which direction that is cannot be
 * derived from the asset names, so each leg is resolved by probing both
 * spellings against the book.
 */
import type { Book, Side } from "./types";

/**
 * One hop of a cycle: convert `from` into `to` on market `pair`.
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
 * A closed conversion cycle.
 *
 * `assets` has four entries because the base asset appears at both ends:
 * `["USDT", "BTC", "ETH", "USDT"]` pairs up with `legs[0..2]` as
 * `assets[i] -> assets[i + 1]`.
 */
export interface Triangle {
  assets: [string, string, string, string];
  legs: [Leg, Leg, Leg];
}

/**
 * Resolve the market that converts `from` into `to`, or `null` when the
 * exchange lists neither direction.
 *
 * `to + from` is probed first so that a hypothetical exchange listing both
 * spellings resolves deterministically (BUY wins).
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

/** Unique, order-preserving view of the universe. */
function dedupe(universe: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const asset of universe) {
    if (!asset || seen.has(asset)) continue;
    seen.add(asset);
    out.push(asset);
  }
  return out;
}

/**
 * Every ordered cycle `baseAsset -> A -> B -> baseAsset` whose three legs are
 * all listed in `book`.
 *
 * `A` and `B` range over `universe` minus `baseAsset`, with `A !== B`.
 * Direction matters: `USDT>BTC>ETH>USDT` and `USDT>ETH>BTC>USDT` are distinct
 * triangles (they trade the same three markets on opposite sides and generally
 * have different profitability), so both are emitted.
 *
 * Output order is a pure function of `universe` order — outer loop `A`, inner
 * loop `B` — which makes ranking ties break deterministically across scans.
 */
export function enumerateTriangles(
  universe: string[],
  baseAsset: string,
  book: Book,
): Triangle[] {
  const assets = dedupe(universe).filter((asset) => asset !== baseAsset);
  const triangles: Triangle[] = [];

  for (const a of assets) {
    const leg1 = resolveLeg(baseAsset, a, book);
    if (!leg1) continue;

    for (const b of assets) {
      if (b === a) continue;

      const leg2 = resolveLeg(a, b, book);
      if (!leg2) continue;

      const leg3 = resolveLeg(b, baseAsset, book);
      if (!leg3) continue;

      triangles.push({
        assets: [baseAsset, a, b, baseAsset],
        legs: [leg1, leg2, leg3],
      });
    }
  }

  return triangles;
}

/** Human-readable cycle label, e.g. `"USDT>BTC>ETH>USDT"`. */
export function cycleLabel(tri: Triangle): string {
  return tri.assets.join(">");
}
