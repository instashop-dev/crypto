/**
 * Shared builders for stubbed dated-futures basis boards.
 *
 * Not a test file — it exports helpers, `vitest` collects only `*.test.ts`.
 *
 * The same reasoning that produced `./funding-stub.ts`: every scan polls the
 * basis board, so every scan-flavoured suite needs a {@link BasisFetcher} seam
 * whether or not it asserts on basis. Without one they would each reach for
 * `www.okx.com` and be saved only by `fetchMock.disableNetConnect()` — a test
 * that passes because the network was refused is a test that would behave
 * differently on the day somebody forgot to refuse it.
 */
import type { BasisFetcher, BasisQuote, BasisSnapshot } from "../src/basis";
import { BASIS_VENUE } from "../src/basis";

/** Days in milliseconds — every expiry here is expressed relative to a clock. */
const DAY_MS = 86_400_000;

/** One contract, with the boring fields defaulted. */
export function basisQuote(
  symbol: string,
  overrides: Partial<BasisQuote> = {},
): BasisQuote {
  const expiryTs = overrides.expiryTs ?? Date.now() + 90 * DAY_MS;
  return {
    venue: BASIS_VENUE,
    symbol,
    instrument: `${symbol}-USD_UM-TEST`,
    expiryTs,
    spotPrice: 100,
    futurePrice: 101,
    priceSource: "mid",
    ...overrides,
  };
}

/** A snapshot of the given quotes at `ts`. */
export function basisSnapshotOf(quotes: BasisQuote[], ts: number): BasisSnapshot {
  return { ts, quotes };
}

/**
 * The stub the orchestration suites install: one ordinary contango contract.
 *
 * One row rather than none. An empty board is a legitimate state and
 * `test/basis-scan.test.ts` covers it — but the scanner logs a warning for it,
 * and a stub that made every unrelated suite emit that warning on every scan
 * would train a reader to ignore it. Nothing in those files asserts on basis;
 * the stub exists so the poll does not reach for the network.
 */
export function serveMinimalBasisBoard(): BasisFetcher {
  return async () => basisSnapshotOf([basisQuote("BTC")], Date.now());
}

/** A board OKX served with nothing priceable on it. */
export function serveEmptyBasisBoard(): BasisFetcher {
  return async () => basisSnapshotOf([], Date.now());
}
