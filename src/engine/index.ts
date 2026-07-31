/**
 * Public surface of the pure arbitrage engine.
 *
 * Phase 4 imports from `./engine` only; nothing here touches Workers, Hono, the
 * network or a clock, so the whole module is unit-testable in isolation.
 */
export type { Book, BookEntry, ExecutedLeg, Side } from "./types";
export {
  cycleLabel,
  enumerateTriangles,
  resolveLeg,
  type Leg,
  type Triangle,
} from "./triangles";
export {
  convert,
  evaluateTriangle,
  rankOpportunities,
  round8,
  simulateExecution,
  type ExecutedTrade,
  type TriangleQuote,
} from "./profit";
export {
  crossVenueBook,
  evaluateSpread,
  rankSpreads,
  simulateSpread,
  spreadHops,
  spreadLabel,
  spreadQuoteTax,
  spreadTax,
  type RankSpreadsOptions,
  type SpreadMarket,
  type SpreadQuote,
  type SpreadQuoteTax,
  type VenueBook,
} from "./crossExchange";
export {
  annualizedPct,
  DEFAULT_FUNDING_INTERVAL_MINUTES,
  feeDragAnnualPct,
  FUNDING_ROUND_TRIP_LEGS,
  MINUTES_PER_YEAR,
  netAnnualPct,
  periodsPerYear,
  rankFundingOpportunities,
  roundTripFeeFraction,
  type FundingInput,
  type FundingOpportunity,
} from "./funding";
export {
  computeChainTax,
  computeTradeTax,
  disposalValues,
  NO_TAX,
  priceChain,
  quoteTax,
  taxOnProfit,
  type ChainHop,
  type DisposalLeg,
  type QuoteTax,
  type TaxBreakdown,
  type TaxPolicy,
} from "./tax";
