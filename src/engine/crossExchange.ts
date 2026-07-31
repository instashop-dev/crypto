/**
 * Cross-exchange spread math: buy an asset on one venue, sell it on another.
 *
 * Pure module in the same sense as `./profit` and `./tax` — plain functions over
 * snapshot `Book`s, no I/O, no clock, no Workers imports, no dependency on
 * `src/` outside `src/engine/`. Everything is deterministic given
 * `(markets, venueA, venueB, feeRate, baseAsset)`.
 *
 * ## The trade
 *
 * For a market `X/USDT` listed on both venues, with notional `N` and a taker fee
 * `f` charged on the output of each leg:
 *
 * ```
 * leg 1  BUY  X on venue A at askA:  base = (N / askA) * (1 - f)
 * leg 2  SELL X on venue B at bidB:  out  = base * bidB * (1 - f)
 *
 * grossPct = (bidB / askA - 1) * 100
 * netPct   = ((bidB / askA) * (1 - f)^2 - 1) * 100
 * ```
 *
 * Unlike a triangle, the two legs trade the *same* market — the edge comes from
 * the two venues disagreeing about its price, not from a routing loop.
 *
 * ## Why only one direction is ever emitted
 *
 * Both directions are priced per symbol, but at most one of them can be
 * profitable, so `rankSpreads` keeps only the better by default. The proof is
 * one line: on any single venue `bid <= ask`, so
 *
 * ```
 * (bidB / askA) * (bidA / askB) = (bidA / askA) * (bidB / askB) <= 1
 * ```
 *
 * and the product of the two directions' gross factors cannot exceed 1. If one
 * direction is above 1 the other is strictly below it; if both venues are
 * crossed with each other they are equal to 1 only in the degenerate
 * zero-spread case. Emitting both would therefore double the row count of every
 * scan to persist a number that is provably a loss. `{bothDirections: true}`
 * exists so tests can assert exactly that property.
 *
 * ## Modelling simplifications
 *
 * - **Instant top-of-book fills.** Both legs fill entirely at the quoted best
 *   bid/ask regardless of size, exactly as `./profit` does. Real fills walk the
 *   book and are strictly worse, so reported spreads are an upper bound.
 * - **No transfer is simulated.** There is no withdrawal, no on-chain confirm-
 *   ation wait and no transfer fee, because a real desk running this strategy
 *   does not move coins per trade — it pre-positions inventory on both venues
 *   and rebalances out of band. Modelling a per-trade transfer would be *more*
 *   wrong, not less: it would price a workflow nobody uses. The corollary is
 *   that the reported edge ignores the funding cost of that standing inventory.
 * - **One fee rate for both venues.** `fee_rate` is a single setting; venues in
 *   fact differ, and a per-venue fee would change which direction wins.
 * - **Timing skew is the dominant false positive.** The Binance side is a
 *   WebSocket snapshot accumulated over up to ~4s while the MEXC side is a
 *   single REST response read at the end of it, so the two books are not
 *   simultaneous. A market that moved during the collection window shows up as
 *   a spread that never existed. This — not fees, not depth — is the reason a
 *   scanner like this reports far more "opportunities" than a real desk could
 *   ever fill, and it is why nothing here places an order.
 */
import { round8 } from "./profit";
import { computeChainTax, type ChainHop, type TaxBreakdown, type TaxPolicy } from "./tax";
import type { Book, BookEntry, ExecutedLeg } from "./types";
import type { ExecutedTrade } from "./profit";

/** One venue's snapshot, tagged with the name the label and legs carry. */
export interface VenueBook {
  /** e.g. `"binance-ws"`. Free-form; the engine only compares and echoes it. */
  venue: string;
  book: Book;
}

/**
 * A market as the pair cache describes it. Structurally a subset of
 * `PairRow`/`PairInfo`, so `src/` rows pass straight in while the engine keeps
 * zero compile-time coupling to them.
 */
export interface SpreadMarket {
  symbol: string;
  base: string;
  quote: string;
}

/** One market's spread between two venues, priced on a notional of 1 base unit. */
export interface SpreadQuote {
  /** Exchange symbol, identical on both venues, e.g. `"BTCUSDT"`. */
  symbol: string;
  /** The asset bought and sold, e.g. `"BTC"`. */
  base: string;
  /** The settlement asset, e.g. `"USDT"`. Always the caller's `baseAsset`. */
  quote: string;
  buyVenue: string;
  sellVenue: string;
  /** Ask on the buy venue — the price paid for `base`. */
  buyPrice: number;
  /** Bid on the sell venue — the price received for `base`. */
  sellPrice: number;
  /** e.g. `"BTCUSDT binance-ws>mexc-rest"`. Persisted in the `cycle` column. */
  label: string;
  /** Round-trip return in percent **before** fees. */
  grossPct: number;
  /** Round-trip return in percent **after** the per-leg fee. */
  netPct: number;
  /** The two legs as priced at the net fee rate, on notional 1. */
  legs: ExecutedLeg[];
}

/** A usable amount or price: a real, strictly positive number. */
function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A usable fee rate: real, non-negative, and less than 100%. */
function isValidFee(feeRate: number): boolean {
  return Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1;
}

/** Both sides of a quote are validated: half a broken entry is a corrupt quote. */
function isUsable(entry: BookEntry | undefined): entry is BookEntry {
  return !!entry && isPositive(entry.bid) && isPositive(entry.ask);
}

/**
 * Run the two conversions at full precision. `null` — never a `NaN` — when the
 * arithmetic would produce a non-finite or non-positive amount.
 *
 * The intermediate `base` amount is deliberately **unrounded**: on a 100 USDT
 * notional a BTC leg holds ~1.7e-3, where 8-decimal quantisation is a ~1e-6
 * relative error against an edge measured in ~1e-4. `round8` is applied once, to
 * the reported leg amounts.
 */
function priceSpread(
  askA: number,
  bidB: number,
  feeRate: number,
  startAmount: number,
): { base: number; out: number } | null {
  if (!isPositive(startAmount)) return null;

  const base = (startAmount / askA) * (1 - feeRate);
  if (!isPositive(base)) return null;

  const out = base * bidB * (1 - feeRate);
  if (!isPositive(out)) return null;

  return { base, out };
}

/** The two `ExecutedLeg`s of a priced spread, quantised for reporting. */
function spreadLegs(
  market: SpreadMarket,
  buyVenue: string,
  sellVenue: string,
  buyPrice: number,
  sellPrice: number,
  startAmount: number,
  priced: { base: number; out: number },
): ExecutedLeg[] {
  return [
    {
      pair: market.symbol,
      side: "BUY",
      price: buyPrice,
      inAsset: market.quote,
      inAmount: round8(startAmount),
      outAsset: market.base,
      outAmount: round8(priced.base),
      venue: buyVenue,
    },
    {
      pair: market.symbol,
      side: "SELL",
      price: sellPrice,
      inAsset: market.base,
      inAmount: round8(priced.base),
      outAsset: market.quote,
      outAmount: round8(priced.out),
      venue: sellVenue,
    },
  ];
}

/** `"BTCUSDT binance-ws>mexc-rest"` — symbol plus the direction actually traded. */
export function spreadLabel(symbol: string, buyVenue: string, sellVenue: string): string {
  return `${symbol} ${buyVenue}>${sellVenue}`;
}

/**
 * Price one direction of one market: buy on `buy`, sell on `sell`.
 *
 * Returns `null` — never a quote carrying a `NaN` percentage — when:
 *
 * - the symbol is absent from either venue's book;
 * - `market.quote` is not `baseAsset` (the paper portfolio settles in one asset,
 *   so a `ETH/BTC` spread would be an unhedged BTC position, not an arbitrage);
 * - either venue's bid *or* ask is non-finite or non-positive;
 * - `feeRate` is outside `[0, 1)`;
 * - the arithmetic would produce a non-finite output.
 *
 * A spread between a venue and itself is also rejected: `bid <= ask` makes it a
 * guaranteed loss, and the label would claim a cross-venue trade that is not one.
 */
export function evaluateSpread(
  market: SpreadMarket,
  buy: VenueBook,
  sell: VenueBook,
  feeRate: number,
  baseAsset: string,
): SpreadQuote | null {
  if (!isValidFee(feeRate)) return null;
  if (!market?.symbol || !market.base || !market.quote) return null;
  if (market.quote !== baseAsset || market.base === market.quote) return null;
  if (!buy?.venue || !sell?.venue || buy.venue === sell.venue) return null;

  const buyEntry = buy.book.get(market.symbol);
  const sellEntry = sell.book.get(market.symbol);
  if (!isUsable(buyEntry) || !isUsable(sellEntry)) return null;

  const net = priceSpread(buyEntry.ask, sellEntry.bid, feeRate, 1);
  if (!net) return null;
  // Re-run at fee rate 0 rather than algebraically un-feeing the net figure, for
  // the same reason `evaluateTriangle` does: the two agree only while both legs
  // charge the same rate, and re-running keeps the number honest if that stops
  // being true.
  const gross = priceSpread(buyEntry.ask, sellEntry.bid, 0, 1);
  if (!gross) return null;

  return {
    symbol: market.symbol,
    base: market.base,
    quote: market.quote,
    buyVenue: buy.venue,
    sellVenue: sell.venue,
    buyPrice: buyEntry.ask,
    sellPrice: sellEntry.bid,
    label: spreadLabel(market.symbol, buy.venue, sell.venue),
    grossPct: round8((gross.out - 1) * 100),
    netPct: round8((net.out - 1) * 100),
    legs: spreadLegs(
      market,
      buy.venue,
      sell.venue,
      buyEntry.ask,
      sellEntry.bid,
      1,
      net,
    ),
  };
}

export interface RankSpreadsOptions {
  /**
   * Emit both directions of every market instead of the better one. Off in
   * production (the mirror is provably a loss — see the module header); tests
   * use it to assert that property directly.
   */
  bothDirections?: boolean;
}

/**
 * Every priceable spread across `markets`, best net return first.
 *
 * Ties keep enumeration order (`Array.prototype.sort` is stable), which is a
 * pure function of `markets` order — so two scans of the same books produce
 * byte-identical rankings.
 */
export function rankSpreads(
  markets: readonly SpreadMarket[],
  a: VenueBook,
  b: VenueBook,
  feeRate: number,
  baseAsset: string,
  opts: RankSpreadsOptions = {},
): SpreadQuote[] {
  const quotes: SpreadQuote[] = [];

  for (const market of markets) {
    const forward = evaluateSpread(market, a, b, feeRate, baseAsset);
    const reverse = evaluateSpread(market, b, a, feeRate, baseAsset);

    if (opts.bothDirections) {
      if (forward) quotes.push(forward);
      if (reverse) quotes.push(reverse);
      continue;
    }

    if (forward && reverse) {
      // `>=` keeps the forward direction on an exact tie, so the emitted
      // direction is a pure function of the `(a, b)` argument order.
      quotes.push(forward.netPct >= reverse.netPct ? forward : reverse);
    } else if (forward) {
      quotes.push(forward);
    } else if (reverse) {
      quotes.push(reverse);
    }
  }

  return quotes.sort((x, y) => y.netPct - x.netPct);
}

/**
 * Re-price a quoted spread at a real notional against the venues' current books.
 *
 * Returns the same {@link ExecutedTrade} shape a triangle produces, so
 * `commitTrade` books both strategies through one code path. `cycle` carries the
 * quote's label rather than an asset chain — a spread has no cycle, and forcing
 * `USDT>BTC>USDT` on it would be indistinguishable from a degenerate triangle.
 *
 * The venues are resolved **by name from the quote**, not by argument position:
 * `rankSpreads` may have emitted either direction, so passing `(a, b)` in a
 * fixed order and assuming `a` is the buy side would silently invert half the
 * fills. `null` when either named venue is absent or the book has moved out from
 * under the quote.
 */
export function simulateSpread(
  quote: SpreadQuote,
  a: VenueBook,
  b: VenueBook,
  feeRate: number,
  startAmount: number,
): ExecutedTrade | null {
  if (!isValidFee(feeRate) || !isPositive(startAmount)) return null;

  const venues = [a, b].filter(Boolean);
  const buy = venues.find((v) => v.venue === quote.buyVenue);
  const sell = venues.find((v) => v.venue === quote.sellVenue);
  if (!buy || !sell || buy.venue === sell.venue) return null;

  const buyEntry = buy.book.get(quote.symbol);
  const sellEntry = sell.book.get(quote.symbol);
  if (!isUsable(buyEntry) || !isUsable(sellEntry)) return null;

  const priced = priceSpread(buyEntry.ask, sellEntry.bid, feeRate, startAmount);
  if (!priced) return null;

  const profit = priced.out - startAmount;

  return {
    cycle: quote.label,
    startAmount: round8(startAmount),
    endAmount: round8(priced.out),
    profit: round8(profit),
    profitPct: round8((profit / startAmount) * 100),
    legs: spreadLegs(
      { symbol: quote.symbol, base: quote.base, quote: quote.quote },
      buy.venue,
      sell.venue,
      buyEntry.ask,
      sellEntry.bid,
      startAmount,
      priced,
    ),
  };
}

// ---------------------------------------------------------------------------
// India mode
// ---------------------------------------------------------------------------

/**
 * The two hops of a spread, as the tax core sees them: `USDT -> X -> USDT`.
 *
 * A spread is a **two-disposal** chain. Leg 1 disposes of USDT on the buy venue,
 * leg 2 disposes of X on the sell venue — and USDT is itself a VDA under Indian
 * law, so both attract TDS (see the long argument in `./tax`). Two legs instead
 * of three is the one structural advantage a spread has over a triangle here:
 * ~2% of notional withheld rather than ~3%.
 */
export function spreadHops(quote: SpreadQuote): ChainHop[] {
  return [
    { from: quote.quote, to: quote.base },
    { from: quote.base, to: quote.quote },
  ];
}

/**
 * The synthetic one-market book that prices a spread's two legs correctly.
 *
 * The tax core takes a single `Book`, but a spread's legs execute on two
 * different venues, and each disposal must be valued against the book of the
 * venue where **that** leg trades. The two are reconciled exactly rather than
 * approximately: a `BookEntry` carrying `{ask: buyVenue.ask, bid: sellVenue.bid}`
 * feeds each side to precisely the leg that reads it —
 *
 * - hop 1 (`USDT -> X`) resolves to a BUY and reads the **ask**, i.e. the buy
 *   venue's price;
 * - hop 2 (`X -> USDT`) resolves to a SELL and reads the **bid**, i.e. the sell
 *   venue's price;
 * - the 194S valuation of the X disposal is a fee-free `X -> USDT` convert,
 *   which is also the **bid**, i.e. the sell venue — where the asset is in fact
 *   disposed of.
 *
 * No path reads the half that belongs to the other venue, so this is the real
 * cross-venue pricing and not a merged mid-market fiction. The USDT disposal is
 * valued at face by the tax core, needing no book at all.
 */
export function crossVenueBook(quote: SpreadQuote): Book {
  return new Map([[quote.symbol, { bid: quote.sellPrice, ask: quote.buyPrice }]]);
}

/**
 * Tax one executed spread at a real notional. The two-leg analogue of
 * `computeTradeTax`; `null` when the chain cannot be priced.
 *
 * Re-priced from the quote rather than read off an `ExecutedTrade`, so no
 * `round8`-quantised amount can leak into the TDS base.
 */
export function spreadTax(
  quote: SpreadQuote,
  feeRate: number,
  startAmount: number,
  baseAsset: string,
  policy: TaxPolicy,
): TaxBreakdown | null {
  return computeChainTax(
    spreadHops(quote),
    crossVenueBook(quote),
    feeRate,
    startAmount,
    baseAsset,
    policy,
  );
}

/** Opportunity-level tax figures for a spread, per unit of notional. */
export interface SpreadQuoteTax {
  /** `netPct` after the 115BBH charge; losses pass through untouched. */
  indiaNetPct: number;
  /** TDS withheld as a percent of notional. ~2% for a 2-leg spread at 1%/leg. */
  tdsPct: number;
}

/**
 * Tax figures for a ranked spread, on a notional of 1 base unit.
 *
 * Same construction as `quoteTax` for triangles, and for the same reasons:
 * `indiaNetPct` is a strictly increasing transform of the reported `netPct`, so
 * ranking is provably unchanged and these stay a display column; `tdsPct` is
 * derived from `tdsBase * tdsRate` rather than from the notional-1 `tdsWithheld`,
 * which `round8` would strip two significant digits from.
 */
export function spreadQuoteTax(
  quote: SpreadQuote,
  feeRate: number,
  baseAsset: string,
  policy: TaxPolicy,
): SpreadQuoteTax | null {
  if (!policy.enabled) return { indiaNetPct: quote.netPct, tdsPct: 0 };

  const breakdown = spreadTax(quote, feeRate, 1, baseAsset, policy);
  if (!breakdown) return null;

  return {
    indiaNetPct:
      quote.netPct > 0
        ? round8(quote.netPct * (1 - breakdown.taxRate))
        : quote.netPct,
    tdsPct: round8(breakdown.tdsBase * breakdown.tdsRate * 100),
  };
}
