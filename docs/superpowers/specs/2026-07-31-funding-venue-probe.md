# Funding-venue probe — 2026-07-31 (phase 10 E2E)

Empirical results from the phase-11 E2E pass, complementing the CF-egress
probe table in `2026-07-30-crypto-arb-design.md`.

## Bybit v5 (primary)

Verified live through `wrangler dev` (local workerd, real egress):

- `GET https://api.bybit.com/v5/market/tickers?category=linear` — one
  unauthenticated call returned the full linear board; all 11 universe
  perps present under spot-style symbols (`BTCUSDT`, …). `fundingRate`,
  `nextFundingTime`, `markPrice` populated as decimal strings.
- `GET https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000`
  — `fundingInterval` returned in minutes (480 for all 11 universe perps
  on probe day), cached 24 h in the `funding_intervals` settings row;
  every scanned row landed with `interval_source = 'api'`.
- Sample board (first scan, 2026-07-31): rates from `+0.0001` (ADA/AVAX/BNB,
  the venue default) down to `-0.000071` (LINK); best net annualised
  carry 6.08 % at fee 0.001 / 30 d hold; 3 of 11 rows qualified at the
  5 % threshold.

## OKX (fallback)

Exercised in tests only (fixture-driven, including the
`nextFundingTime − fundingTime` interval derivation and logical-error
codes). Not probed live — the primary answered on every attempt.
The design doc's 2026-07-30 probe already showed OKX REST reachable from
Cloudflare egress.

## Cloudflare-egress caveat

`wrangler dev` runs workerd on the local machine, so these probes prove
API shape and parser correctness, not Cloudflare-datacenter reachability.
The 2026-07-30 probe table showed Bybit and OKX REST both reachable from
CF; confirm on the first production scan after deploy by checking
`GET /api/funding` reports `venue: "bybit"` (fallback engaged or a thrown
funding error would surface as `venue: "okx"` / a stale board).

**Production result (2026-07-31, post-deploy):** `GET /api/funding`
reports `venue: "okx"` — Bybit joins Binance REST in the
blocked-from-Workers-egress column despite the 2026-07-30 probe, and the
fallback chain engaged on the first cron scan with a full 11-row board,
`interval_source: "api"` throughout (intervals derived from OKX
funding-time deltas). Treat OKX as the de-facto primary in production;
Bybit remains first in the chain in case reachability differs by colo or
returns. The same scan also recorded `xchg_error: "binance-ws: ...
(HTTP 451)"` with `scans.error` null and a clean `mexc-rest` triangular
pass — the per-strategy degradation isolation working live.

## Multi-instId OKX batching

Not attempted (primary sufficed). The per-instrument fan-out (11 calls
under `Promise.allSettled`, ≤13 subrequests total) stays comfortably
inside the 50-subrequest free-plan budget, so batching remains an
optimisation, not a requirement.
