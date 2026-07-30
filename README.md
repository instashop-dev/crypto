# crypto-arb — Paper-Trading Triangular Arbitrage on Cloudflare

A fully serverless paper-trading bot that scans Binance for triangular-arbitrage
opportunities (e.g. `USDT → BTC → ETH → USDT`) every minute, simulates fills at
live best bid/ask, and tracks a virtual portfolio. **No real orders are ever
placed.**

**Live**: https://crypto-arb.thapi.workers.dev

## How it works

```
Cloudflare cron (1/min) ──► runScan()
POST /api/scan ──────────►    │
                              ▼
              wss://stream.binance.com  ◄── primary: Binance WS combined
                              │              bookTicker stream (one snapshot
                              │              per scan, then socket closed)
                 api.mexc.com REST      ◄── fallback (identical Binance schema)
                              │
                              ▼
        enumerate triangles over 12-asset universe → net profit after
        0.1%/leg taker fees → persist top 10 → paper-execute best cycle
        if net ≥ threshold (atomic D1 batch: balance + trade + flags)
                              │
                              ▼
        D1 (SQLite): balances · pairs · scans · opportunities · trades · settings
                              │
                              ▼
        Dashboard (vanilla JS, Workers Assets) — 5s polling
```

### Why WebSocket?

All Binance REST endpoints are blocked from Cloudflare Workers egress
(403 WAF / 451 geo — verified empirically for `api.binance.com`, mirrors,
`data-api.binance.vision`, `api-gcp`, `binance.us`, and the spot testnet).
The WebSocket stream host `stream.binance.com` is **not** blocked, so each scan
opens one combined `<symbol>@bookTicker` stream, collects a snapshot (~1s,
4s deadline), and closes. MEXC's REST API (a Binance API-schema clone that
allows Workers egress) is the automatic fallback; every scan records which
source produced its data. Full findings: [docs/superpowers/specs/2026-07-30-crypto-arb-design.md](docs/superpowers/specs/2026-07-30-crypto-arb-design.md).

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Probe both market-data sources from the Worker |
| `POST /api/scan` | Run a scan now (also runs via cron every minute) |
| `GET /api/portfolio` | Balances, equity, P&L vs 10,000 USDT initial |
| `GET /api/opportunities?limit=50` | Ranked cycles per scan, with per-leg detail |
| `GET /api/trades?limit=50` | Simulated fills |
| `GET /api/scans?limit=20` | Scan log (trigger, source, duration, errors) |
| `GET/PUT /api/settings` | `min_profit_pct` (negative = demo mode: forces fills), `trade_size_usdt`, `fee_rate` |
| `POST /api/reset` | Restore balances; `{"wipeHistory": true}` also clears history |
| `POST /api/admin/refresh-pairs` | Rebuild the tradable-pair cache |

## Development

```bash
npm install
npm test                                        # 110 tests: pure engine math +
                                                # workerd integration (in-memory D1,
                                                # mocked network)
npx wrangler d1 migrations apply crypto-arb --local
npx wrangler dev                                # http://localhost:8787
npx wrangler deploy
```

Secrets (optional — public market data needs no auth): `.dev.vars` locally,
`wrangler secret put BINANCE_API_KEY` in production. The secret key is unused
by the MVP (reserved for a future testnet upgrade).

Known local quirk: `wrangler dev`'s proxy can crash under concurrent browser
polling on Windows (`Error in ProxyController`); production and tests are
unaffected.

## Honest-market disclaimer

With real fees (0.1%/leg → ~0.3006% break-even) genuine triangular edges on a
1-minute scan are rare — expect the bot to observe, rank, and decline. That is
the correct behavior, not a bug. Set `min_profit_pct` negative to watch the
execution pipeline fire on demand.

## Simplifications (MVP)

- Fills at snapshot best bid/ask; order-book depth, lot-size/notional filters,
  and slippage are ignored.
- Equity = USDT balance (every cycle returns to USDT).
- Pair discovery uses MEXC's listing (REST-reachable), which covers 19 of the
  ~38 Binance-listed pairs in the universe — fewer triangles than the full set.
- Max one paper trade per scan.

## Architecture decisions

- **One Worker, three roles** (API + static dashboard + cron) — no build step,
  free-plan compatible.
- **D1 over Durable Objects** — single writer, SQL fits trade history/P&L,
  free tier ample. A 45s scan lock (settings row) prevents cron/manual overlap.
- **Pure engine** (`src/engine/`) — zero Workers imports; profit math is
  unit-tested against closed-form hand-derived values.
- **Atomic execution** — balance delta + trade insert + opportunity flag +
  scan counter in a single `D1.batch()`; no partial-write window.
