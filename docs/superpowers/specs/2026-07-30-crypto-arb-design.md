# Design: Paper-Trading Triangular-Arbitrage MVP on Cloudflare

Date: 2026-07-30 · Status: Approved by founder

## Goal

A paper-trading crypto arbitrage MVP, built and deployed end-to-end on Cloudflare with no founder input after planning. Strategy: **triangular arbitrage within Binance** (e.g., USDT→BTC→ETH→USDT) using public market data. No real orders are ever placed.

## Locked assumptions

- Starting paper balance 10,000 USDT; trade size 100 USDT/cycle; taker fee 0.1%/leg; min profit threshold 0.05% (tunable via settings API).
- Asset universe: USDT, BTC, ETH, BNB, SOL, XRP, DOGE, ADA, LTC, TRX, AVAX, LINK (~1,300 candidate cycles).
- Fills simulated at snapshot best bid/ask; book depth and exchange lot-size/notional filters are ignored (MVP simplification).
- Worker name `crypto-arb`, served from `*.workers.dev`.

## Architecture

One Cloudflare Worker (TypeScript + Hono) with three roles:

1. **JSON API** under `/api/*`.
2. **Static dashboard** via Workers Assets (`run_worker_first: ["/api/*"]`) — vanilla JS polling every 5s, no bundler.
3. **Cron scanner** — `crons: ["* * * * *"]`; `scheduled()` calls the same `runScan(env, 'cron')` as `POST /api/scan`.

**Storage: D1** (free tier, single writer, SQL fits history/P&L queries).

### Binance connectivity (empirical findings, 2026-07-30, from deployed Worker)

Probed from real Cloudflare egress in Phase 1:

| Endpoint | Result |
|---|---|
| `api.binance.com`, `api1/api4`, `fapi`, `www` | 403 (WAF) or 451 (geo) — blocked |
| `data-api.binance.vision` | 403 nginx — Cloudflare IPs blocked |
| `api.binance.us` | 403 Akamai — blocked |
| `api-gcp.binance.com` | `/ping` 200 but data endpoints 451 — blocked |
| `testnet.binance.vision` | 451 — blocked |
| **`wss://stream.binance.com` (WebSocket)** | **WORKS — live bookTicker received** |
| `api.mexc.com` (Binance-compatible REST schema) | 200 — works |
| Kraken / OKX / Bybit REST | 200 — work (unused) |

**Resulting source chain**: primary = Binance WebSocket combined stream (`wss://stream.binance.com/stream?streams=<sym>@bookTicker/...`) — per scan the Worker opens the socket, collects a bookTicker snapshot for the pair universe (until complete or ~3s timeout), and closes. Fallback = MEXC REST `GET /api/v3/ticker/bookTicker` (identical response schema to Binance, so typed client code is shared); scans record which source produced the snapshot. `X-MBX-APIKEY` is sent on Binance REST calls when the secret is present; the secret key is reserved for future signed-endpoint upgrades and unused in the MVP.

**CPU budget (10ms free plan):** steady-state scans fetch `bookTicker?symbols=[...]` for only the cached ~60 pairs. Full `exchangeInfo` (~17MB) is never fetched; a targeted `?symbols=[...]` variant is used by `POST /api/admin/refresh-pairs`, which rebuilds the pair cache in D1.

### D1 schema

- `balances(asset PK, amount)` — seeded USDT 10000
- `pairs(symbol PK, base, quote, source, updated_at)` — cached tradable pairs
- `opportunities(id, scan_id, ts, cycle, gross_pct, net_pct, executed, legs_json)`
- `trades(id, ts, cycle, start_amount, end_amount, profit, profit_pct, legs_json, source, opportunity_id)`
- `scans(id, ts, trigger, source, pairs_count, triangles_count, best_net_pct, executed_count, duration_ms, error)`
- `settings(key PK, value)` — fee_rate, min_profit_pct, trade_size_usdt, initial_usdt

P&L = current USDT − initial (every executed cycle returns to USDT).

### API

`GET /api/health` · `POST /api/scan` · `GET /api/portfolio` · `GET /api/opportunities` · `GET /api/trades` · `GET /api/scans` · `POST /api/reset` · `POST /api/admin/refresh-pairs` · `GET|PUT /api/settings`

### Arbitrage engine (pure TS, no Workers imports)

1. Snapshot bookTicker for cached pairs → `Map<symbol, {bid, ask}>`.
2. Enumerate ordered cycles USDT→A→B→USDT where every leg has a tradable pair.
3. Direction-aware `convert(from, to, amount)`: if pair `to+from` exists, buy base at ask (`amount / ask`); if `from+to` exists, sell base at bid (`amount × bid`); each leg × `(1 − fee)`.
4. `net_pct` computed on notional 1.0 (break-even ≈ 0.3006% gross at 0.1%/leg). Top 10 persisted per scan.
5. Execution: if best `net_pct ≥ threshold` and USDT balance ≥ trade size, simulate the 3 legs at snapshot prices and atomically apply balances + trade + opportunity flag via `D1.batch()`. Max 1 trade per scan.

## Testing

- **Pure unit** (plain Vitest): engine math — fee compounding, direction handling, missing pairs, ranking determinism against fixtures.
- **Integration** (`@cloudflare/vitest-pool-workers`): routes + D1 + scan orchestration in workerd, in-memory D1, `fetchMock` for Binance including 451-fallback paths. No network in tests.
- **Live smoke**: `wrangler dev` curls; post-deploy curls of `/api/health` and `/api/scan`; remote D1 queries; cron observed via `scans` table growth; dashboard browser walkthrough.

## Build phases

Seven phases, each on its own branch → commit → PR → squash-merge → branch delete: (1) scaffold + deploy + health probe, (2) Binance client, (3) pure engine, (4) D1 + execution + routes, (5) cron, (6) dashboard, (7) E2E test/fix + README.

## Out of scope (documented for later)

Cross-exchange arbitrage, order-book depth simulation, exchange filters (lot size/notional), Binance testnet order placement (secret key already provisioned), Durable Object alarm loops for sub-minute scanning, auth on the dashboard.
