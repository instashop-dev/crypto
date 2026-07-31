# Phase 18 production verification — 2026-07-31

Deployed `crypto-arb` version `823382ec` (main `6298b31`, `/api/version` → `phase: 18`) to
`https://crypto-arb.thapi.workers.dev`. This records what production actually did on day one,
in the tradition of `2026-07-31-funding-venue-probe.md`.

## Venue reachability from Cloudflare egress (measured, not assumed)

| Venue | Endpoint | Result |
|---|---|---|
| **Gate** | `api.gateio.ws` futures contracts board | **SERVES** — 36 rows/poll (11 majors + 25 tail) |
| **OKX** | funding per-instrument + FUTURES/SPOT tickers | **SERVES** — 11 majors funding; basis pending migration |
| KuCoin | `api-futures.kucoin.com` contracts board | **BLOCKED** (absent from served venues) |
| Bybit | v5 tickers | **BLOCKED** (unchanged since the 2026-07-31 probe) |
| Binance WS | `wss://stream.binance.com` | **NOW BLOCKED — HTTP 451 on upgrade.** Worked on 2026-07-30; regressed. |
| MEXC | REST bookTicker | SERVES |

Consequences:

- The funding board runs on **Gate + OKX** (47 rows/poll). The R1 fat tail is real in production:
  first board's best nets were `BROCCOLIF3B +497.5%/yr`, `ESPORTS +444.9%/yr`, `SIREN +372.6%/yr`
  (Gate, api-sourced intervals). Whether any of it survives mean reversion is exactly what the
  carry book (R2) exists to measure.
- **11 cross-venue funding spreads** computed on the first board (Gate↔OKX pairs on the majors).
- **Cross-exchange spot is dead in production**: with Binance WS 451-blocked there is no dual
  book, so no spread rows and nothing for the R6 instrumentation to measure. The strategy's
  scan slot degrades cleanly (`xchg_error` recorded, `error: null`, scan healthy). Locally
  (residential egress) the loop was fully verified pre-deploy: 10 spreads measured at a ~65s
  horizon, 0 survived, median surviving net −0.23%, verdict "display-only" — consistent with
  the recommendation doc's prediction that the reported edges were timing-skew artifacts.
- Scans remain green throughout: scan 1620 (first on new code) `error: null`, mexc-rest
  triangular vocabulary retired (`triangles_count: 0`).

## Outstanding: one manual step

`wrangler d1 migrations apply crypto-arb --remote` (applies 0005–0007: `funding_positions`,
xchg instrumentation columns, `basis_rates`) was **not run** — the operator must run it once.
Until then, production behaves exactly as the isolation design intends: funding board + venue
spreads live; `/api/basis`, `/api/funding/positions`, `/api/report` and the portfolio panel
return clean errors; scans never fail. The moment the migration lands, carry opens on the next
scan (max 3 positions, api-interval rows only), basis fills on the next staggered poll, and
`GET /api/report?days=7` starts accumulating the acceptance answers.

## Local E2E (pre-deploy, residential egress)

Full loop verified on `wrangler dev`: 4/4 venues served (94 rows), 3 carry positions opened and
accruing (+4.83 USDT across the first boundaries), 17-contract OKX basis board (best
+3.67%/yr — below the 5% bar), spread survival measured, report answers populated. Dashboard
DOM verified panel-by-panel; `wrangler dev` process itself is unstable on this Windows box
(proxy-controller crash, upstream issue) — not an app defect; all app requests were 200 up to
each crash.
