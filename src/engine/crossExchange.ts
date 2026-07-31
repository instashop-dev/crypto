/**
 * Cross-exchange spread math: buy an asset on one venue, sell it on another.
 *
 * **Observation only.** Nothing here simulates a fill, and nothing downstream
 * books one: Phase 12 removed every paper-execution path in the repo because
 * the measured edge never survived fees, withholding, or the timing skew
 * documented below. This module prices, ranks and labels spreads so the scanner
 * can persist what it saw; that record is the product.
 *
 * Pure module in the same sense as `./pricing` and `./tax` — plain functions
 * over snapshot `Book`s, no I/O, no clock, no Workers imports, no dependency on
 * `src/` outside `src/engine/`. Everything is deterministic given
 * `(markets, venueA, venueB, feeRate, baseAsset)`.
 *
 * ## The trade being measured
 *
 * For a market `X/USDT` listed on both venues, on a notional of 1 base unit and
 * a taker fee `f` charged on the output of each leg:
 *
 * ```
 * leg 1  BUY  X on venue A at askA:  base = (1 / askA) * (1 - f)
 * leg 2  SELL X on venue B at bidB:  out  = base * bidB * (1 - f)
 *
 * grossPct = (bidB / askA - 1) * 100
 * netPct   = ((bidB / askA) * (1 - f)^2 - 1) * 100
 * ```
 *
 * Both legs trade the *same* market — the edge comes from the two venues
 * disagreeing about its price, not from a routing loop.
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
 * - **Instant top-of-book fills.** Both legs are priced entirely at the quoted
 *   best bid/ask regardless of size. Real fills walk the book and are strictly
 *   worse, so reported spreads are an upper bound.
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
import { round8 } from "./pricing";
import { computeChainTax, type ChainHop, type TaxBreakdown, type TaxPolicy } from "./tax";
import type { Book, BookEntry, ExecutedLeg } from "./types";

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
 * Run the two conversions at full precision, on a notional of 1 base unit.
 * `null` — never a `NaN` — when the arithmetic would produce a non-finite or
 * non-positive amount.
 *
 * The intermediate `base` amount is deliberately **unrounded**: on a unit
 * notional a BTC leg holds ~1.7e-5, where 8-decimal quantisation is a ~1e-3
 * relative error against an edge measured in ~1e-4. `round8` is applied once, to
 * the reported leg amounts.
 */
function priceSpread(
  askA: number,
  bidB: number,
  feeRate: number,
): { base: number; out: number } | null {
  const base = (1 / askA) * (1 - feeRate);
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
  priced: { base: number; out: number },
): ExecutedLeg[] {
  return [
    {
      pair: market.symbol,
      side: "BUY",
      price: buyPrice,
      inAsset: market.quote,
      inAmount: 1,
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

/** The three fields {@link spreadLabel} encodes. */
export interface ParsedSpreadLabel {
  symbol: string;
  buyVenue: string;
  sellVenue: string;
}

/**
 * The exact inverse of {@link spreadLabel}. `null` for anything that is not one.
 *
 * It exists because a persisted spread row stores its direction *only* in the
 * label — `opportunities.cycle` — and Phase 16 re-prices yesterday's rows against
 * today's books to measure whether the edge survived. Re-pricing the wrong
 * direction would report the mirror trade, which is provably a loss, as the
 * survival of the one that was recorded.
 *
 * Strict on purpose: exactly one space, exactly one `>`, and all three fields
 * non-empty. A row whose label does not round-trip is left unmeasured rather
 * than guessed at, because a mis-parsed direction is worse than a missing one —
 * see the survival notes in `src/scan.ts`.
 */
export function parseSpreadLabel(label: string): ParsedSpreadLabel | null {
  if (typeof label !== "string") return null;

  const space = label.indexOf(" ");
  if (space <= 0) return null;
  const symbol = label.slice(0, space);
  const direction = label.slice(space + 1);
  // A second space means this is not a label this module wrote.
  if (direction.includes(" ")) return null;

  const arrow = direction.indexOf(">");
  if (arrow <= 0) return null;
  const buyVenue = direction.slice(0, arrow);
  const sellVenue = direction.slice(arrow + 1);
  if (!buyVenue || !sellVenue || sellVenue.includes(">")) return null;

  return { symbol, buyVenue, sellVenue };
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

  const net = priceSpread(buyEntry.ask, sellEntry.bid, feeRate);
  if (!net) return null;
  // Re-run at fee rate 0 rather than algebraically un-feeing the net figure:
  // the two agree only while both legs charge the same rate, and re-running
  // keeps the number honest if that stops being true.
  const gross = priceSpread(buyEntry.ask, sellEntry.bid, 0);
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
    legs: spreadLegs(market, buy.venue, sell.venue, buyEntry.ask, sellEntry.bid, net),
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

// ---------------------------------------------------------------------------
// India mode
// ---------------------------------------------------------------------------

/**
 * The two hops of a spread, as the tax core sees them: `USDT -> X -> USDT`.
 *
 * A spread is a **two-disposal** chain. Leg 1 disposes of USDT on the buy venue,
 * leg 2 disposes of X on the sell venue — and USDT is itself a VDA under Indian
 * law, so both attract TDS (see the long argument in `./tax`). Two legs rather
 * than the three of the deleted triangular strategy is the one structural
 * advantage here: ~2% of notional withheld rather than ~3%. It is still an
 * order of magnitude above the edge, which is why nothing is ever filled.
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
 * Tax one spread at a hypothetical notional — "what would this have cost".
 * `null` when the chain cannot be priced.
 *
 * Re-priced from the quote rather than read off the reported `legs`, so no
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
