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
| `GET/PUT /api/settings` | See the settings table below |
| `POST /api/reset` | Restore balances; `{"wipeHistory": true}` also clears history |
| `POST /api/admin/refresh-pairs` | Rebuild the tradable-pair cache |

### Settings

| Key | Default | Range | Meaning |
|---|---|---|---|
| `min_profit_pct` | `0.05` | any | Net % a cycle must beat to fill. **Negative = demo mode**: every scan fills its best cycle. |
| `trade_size_usdt` | `100` | `> 0` | Notional simulated per cycle. |
| `fee_rate` | `0.001` | `0`–`0.01` | Taker fee per leg. |
| `india_mode` | `0` | `0` or `1` | Report Indian VDA tax on every fill (see below). |
| `tds_rate` | `0.01` | `0`–`0.05` | Section 194S withholding per VDA transfer. |
| `tax_rate` | `0.3` | `0`–`0.5` | Section 115BBH rate on gains. Use `0.312` to include the 4% cess. |

`initial_usdt` is immutable — it is the denominator of every P&L figure ever
reported, so moving it would rewrite history rather than change behaviour.

## Development

```bash
npm install
npm test                                        # 155 tests: pure engine math +
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

### India mode

Set `india_mode: 1` to overlay the Indian virtual-digital-asset tax regime on
every fill. Two levies, and they behave nothing alike:

- **Section 194S — 1% TDS**, withheld by the exchange on the *consideration* of
  every VDA transfer. Cash leaves immediately, but it is a **prepayment**
  creditable against the year's bill.
- **Section 115BBH — 30% on gains** (31.2% with cess), with **no loss set-off**
  and no deduction except cost of acquisition. Charged per trade on
  `max(profit, 0)`; a losing cycle does not shelter a winning one.

**Every leg is a disposal.** `BUY`/`SELL` here is an exchange-listing artefact —
`USDT → BTC` is only a "BUY" because the market is spelled `BTCUSDT`. What 194S
cares about is that a VDA changed hands, and **USDT is itself a VDA** under
Indian law. So all three legs of a triangle attract TDS, and the tax base is
~3× the notional rather than 1×.

Two P&L views, both reported:

| View | Formula | Where |
|---|---|---|
| **Economic** | `netProfit = profit − taxDue` | "Net P&L (post-tax)", `netEquityUsdt` |
| **Cash** | balance moves by `profit − tdsWithheld` | "Equity", `pnl` |

Subtracting both would double-count — TDS *is* a prepayment of the tax, not a
second charge.

Worked example, on the repo's own +1.694305898% fixture (100 USDT, 0.1%/leg,
`USDT>BTC>ETH>USDT`, TDS 1%, tax 30%):

```
legs      100 USDT -> 0.001665 BTC -> 0.0332667 ETH -> 101.694305898 USDT
gross     +1.694305898
disposals 100.000000 + 99.883350 + 101.796102  =  301.679452  (3.02x notional)
TDS       1% of 301.679452                     =    3.01679452
tax due   30% of 1.694305898                   =    0.50829177
net P&L   1.694305898 - 0.50829177             =    1.18601413   (economic)
cash      1.694305898 - 3.01679452             =   -1.32248862   (NEGATIVE)
```

**The conclusion is blunt: three legs × 1% TDS ≈ 3% of notional per cycle, an
order of magnitude above the ~0.3% fee break-even and far beyond any real
triangular edge.** A cycle needs a net return above ~3.02% just to break even on
cash flow. Nothing in this repo's live scans has ever come close. Round-tripping
capital through a jurisdiction that withholds on turnover rather than on gains
is structurally incompatible with high-frequency arbitrage — that is the
finding, not a limitation of the model.

Modelling simplifications (all documented in `src/engine/tax.ts`): no INR FX;
TDS is not compounded into the chain, so `endAmount` and `profitPct` stay
byte-identical with the mode on or off; the 194S de-minimis thresholds are
ignored (a minutely scanner clears them within the hour); cess is not
hard-coded (set `tax_rate: 0.312`); and 115BBH allows only cost of acquisition
as a deduction anyway, which for an atomic cycle is exactly the start notional.
**None of this is tax advice.**

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
