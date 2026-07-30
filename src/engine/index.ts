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
