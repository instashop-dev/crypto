/**
 * Public surface of the pure market-observation engine.
 *
 * `src/` imports from `./engine` only; nothing here touches Workers, Hono, the
 * network or a clock, so the whole module is unit-testable in isolation.
 *
 * Nothing here simulates a fill — Phase 12 deleted the triangular strategy and
 * every paper-execution path with it. What remains prices, ranks and taxes what
 * was observed.
 */
export type { Book, BookEntry, ExecutedLeg, Side } from "./types";
// Only `round8` is re-exported: `convert`/`resolveLeg` are chain-pricing
// internals that `./tax` imports directly, and nothing outside `src/engine/`
// has any business resolving a leg for itself.
export { round8 } from "./pricing";
export {
  crossVenueBook,
  evaluateSpread,
  rankSpreads,
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
  accrueAmount,
  CARRY_STALE_CLOSE_MS,
  DAYS_PER_YEAR,
  MAX_CATCHUP_SETTLEMENTS,
  MS_PER_DAY,
  realizedFigures,
  settlementBoundaries,
  settlementsCrossed,
  shouldClose,
  type CarryCloseInput,
  type CarryCloseReason,
  type CarryCloseSettings,
  type CarryRealized,
  type CarryRealizedInput,
} from "./carry";
export {
  annualizedPct,
  DEFAULT_FUNDING_INTERVAL_MINUTES,
  feeDragAnnualPct,
  FUNDING_PERP_LEGS,
  FUNDING_ROUND_TRIP_LEGS,
  FUNDING_SPOT_LEGS,
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
  disposalValues,
  NO_TAX,
  priceChain,
  taxOnProfit,
  type ChainHop,
  type DisposalLeg,
  type TaxBreakdown,
  type TaxPolicy,
} from "./tax";
