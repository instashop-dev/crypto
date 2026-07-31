/**
 * Shared builders for stubbed funding boards.
 *
 * Not a test file — it exports helpers, `vitest` collects only `*.test.ts`.
 *
 * Every scan polls funding, so all four scan-flavoured suites need a
 * {@link FundingFetcher} seam whether or not they assert on funding. They used
 * to each carry their own copy of the same literal; Phase 14 changed the
 * snapshot shape and turned that duplication into four identical edits. One
 * builder, used everywhere, means the next shape change is one edit.
 *
 * {@link snapshotOf} derives `venues` and `served` from the quotes rather than
 * taking them, so a stub can never claim a venue served when it contributed no
 * rows — a state the real {@link import("../src/funding").getFundingSnapshot}
 * cannot produce either.
 */
import type { FundingQuote, FundingSnapshot } from "../src/funding";
import type { FundingVenue } from "../src/types";

/** One venue's quote for one asset, with the boring fields defaulted. */
export function fundingQuote(
  symbol: string,
  overrides: Partial<FundingQuote> = {},
): FundingQuote {
  const venue: FundingVenue = overrides.venue ?? "bybit";
  return {
    venue,
    symbol,
    instrument: `${symbol}USDT`,
    rate: 0.0001,
    intervalMinutes: 480,
    intervalSource: "api",
    nextFundingTs: null,
    markPrice: null,
    ...overrides,
  };
}

/** A snapshot whose venue outcomes match the quotes it carries. */
export function snapshotOf(quotes: FundingQuote[], ts: number): FundingSnapshot {
  const counts = new Map<FundingVenue, number>();
  for (const q of quotes) counts.set(q.venue, (counts.get(q.venue) ?? 0) + 1);

  const served = [...counts.keys()];
  return {
    ts,
    quotes,
    venues: served.map((venue) => ({ venue, count: counts.get(venue)!, error: null })),
    served,
  };
}

/**
 * The stub the orchestration suites install: one Bybit quote per requested
 * asset, all at the same rate. Nothing in those files asserts on funding; the
 * board exists so the poll does not reach for the network.
 */
export function serveFlatBoard(rate = 0.0001) {
  return async (assets: string[]): Promise<FundingSnapshot> =>
    snapshotOf(
      assets.map((symbol) => fundingQuote(symbol, { rate })),
      Date.now(),
    );
}
