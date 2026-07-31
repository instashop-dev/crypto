# crypto-arb — Paper-Trading Triangular Arbitrage on Cloudflare

A fully serverless paper-trading bot that scans Binance for triangular-arbitrage
opportunities (e.g. `USDT → BTC → ETH → USDT`) every minute, simulates fills at
live best bid/ask, and tracks a virtual portfolio. It also monitors
cross-exchange spreads and perpetual funding rates. **No real orders are ever
placed.**

**Live**: https://crypto-arb.thapi.workers.dev

## How it works

```
Cloudflare cron (1/min) ──► runScan()
POST /api/scan ──────────►    │
                              ▼
              wss://stream.binance.com  ◄── venue 1: Binance WS combined
                              │              bookTicker stream (one snapshot
                              │              per scan, then socket closed)
                 api.mexc.com REST      ◄── venue 2 + fallback (same schema),
                              │              fetched concurrently
                              ▼
        [triangular]  enumerate triangles over the 12-asset universe on the
                      primary book → net after 0.1%/leg → top 10 → fill best
        [cross-exch]  price every X/USDT market on BOTH books, both ways →
                      keep the better → top 10 → fill best
                      → one paper trade per strategy, if net ≥ its threshold
                      (atomic D1 batch: balance + trade + flags)
                              │
              api.bybit.com / www.okx.com  ◄── perp funding rates, polled at
                              │                most every 5 min (gated)
        [funding]     annualise the next funding rate of all 11 perps, net of
                      4 legs of fees over the assumed holding period →
                      persist the whole board (no positions — see below)
                              │
                              ▼
        D1 (SQLite): balances · pairs · scans · opportunities · trades ·
                     funding_rates · settings
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
| `GET /api/opportunities?limit=50` | Ranked cycles and spreads per scan, with per-leg detail. `&strategy=triangular\|cross_exchange` filters; an unknown value is a 400 |
| `GET /api/trades?limit=50` | Simulated fills. Same `&strategy=` filter |
| `GET /api/scans?limit=20` | Scan log (trigger, source, duration, errors, spread counts) |
| `GET /api/funding` | Newest funding board, best net carry first, with `qualifies` judged against the current threshold |
| `GET /api/funding/history?symbol=BTC&limit=100` | One symbol's rate series, newest first (limit clamped to 500) |
| `POST /api/funding/refresh` | Poll the perp venues now, bypassing the 5-minute gate. 502 if both venues fail |
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
| `xchg_min_profit_pct` | `0.05` | any | Net % a **spread** must beat to fill. **Negative = demo mode**, same as above. Separate from `min_profit_pct` because two legs of fees is a different break-even from three. |
| `xchg_enabled` | `1` | `0` or `1` | Scan cross-exchange spreads. `0` restores the exact triangles-only scan path (one snapshot, no second REST call). |
| `funding_min_annual_pct` | `5` | any | Net annualised % a carry must clear to be flagged `qualifies`. **Display only** — every priced row is persisted regardless, and nothing is ever filled. |
| `funding_hold_days` | `30` | `0 < d ≤ 3650` | Days a carry is assumed held, used to amortise the 4 legs of fees. Changing it re-prices future rows only. |

`initial_usdt` is immutable — it is the denominator of every P&L figure ever
reported, so moving it would rewrite history rather than change behaviour.

## Development

```bash
npm install
npm test                                        # 313 tests: pure engine math +
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

## Cross-exchange spreads

The scanner runs a second strategy alongside the triangles: the *same* market on
two venues at once. Binance (WebSocket) and MEXC (REST) are fetched
concurrently per scan; where both list a `X/USDT` market, the pair of books is
priced in both directions and the better one is kept.

```
leg 1  BUY  X on venue A at askA:  base = (N / askA) x (1 - f)
leg 2  SELL X on venue B at bidB:  out  = base x bidB x (1 - f)

grossPct = (bidB / askA - 1) x 100
netPct   = ((bidB / askA) x (1 - f)^2 - 1) x 100
```

Only one direction can ever pay: `(bidB/askA)(bidA/askB) = (bidA/askA)(bidB/askB)
<= 1`, because `bid <= ask` on each venue. So the mirror is priced, proven a
loss, and dropped rather than persisted.

Worked example, at 0.1%/leg:

```
binance-ws  BTCUSDT  bid 60000 / ask 60010
mexc-rest   BTCUSDT  bid 60500 / ask 60510

buy Binance @60010, sell MEXC @60500
  gross  (60500 / 60010 - 1) x 100              = +0.8165305782%
  net    x (1 - 0.001)^2                        = +0.6149983335%
  on 100 USDT: 100 -> 0.00166472 BTC -> 100.61499833 USDT   (+0.61499833)

mirror (buy MEXC @60510, sell Binance @60000)   =  -1.0410510700%
```

Persisted rows carry a `strategy` column (`triangular` / `cross_exchange`) and
a label instead of a cycle — `BTCUSDT binance-ws>mexc-rest`. Each strategy has
its own threshold and fills **at most one trade per scan**, so a scan books 0, 1
or 2 trades.

**Simplifications**, all documented in `src/engine/crossExchange.ts`:

- **Instant top-of-book fills**, as with triangles — depth and slippage ignored.
- **No transfer is simulated.** No withdrawal, no confirmation wait, no transfer
  fee: a real desk pre-positions inventory on both venues and rebalances out of
  band rather than moving coins per trade. Modelling a per-trade transfer would
  price a workflow nobody uses. The funding cost of that standing inventory is
  not modelled either.
- **One fee rate for both venues** — `fee_rate` is a single setting.
- **Timing skew is the dominant false positive.** The Binance book is a
  WebSocket snapshot accumulated over up to ~4s; the MEXC book is one REST
  response read at the end of it. The two are *not* simultaneous, so a market
  that moved during the collection window shows up as a spread that was never
  fillable. This — not fees, not depth — is why a scanner like this reports far
  more "opportunities" than any desk could fill, and why nothing here places an
  order. Treat a reported spread as an upper bound on an upper bound.

A missing second venue is recorded in `scans.xchg_error`, never in `scans.error`:
a scan whose triangular half ranked and filled normally did not fail because
MEXC was slow.

**India mode applies to spreads too**, and they fare slightly better: a spread is
a **two-disposal** chain (USDT on the buy venue, then the asset on the sell
venue) against a triangle's three, so ~2% of notional is withheld rather than
~3%. Each disposal is valued on the book of the venue where that leg actually
executes. On the worked example above, at 100 USDT: base `200.7325`, TDS
`2.007325`, tax due `0.18953025`, net `0.44223725` — still a ~2% drag on a
~0.6% edge, so the conclusion of the India-mode section holds with one leg less.

## Funding-rate carry (cash-and-carry)

The third strategy, and the only one that is **observed rather than simulated**.

A perpetual future has no expiry, so it is tethered to spot by a *funding
payment* exchanged between longs and shorts every settlement interval (8 hours
on almost every contract). When the rate is positive, longs pay shorts. Buy the
asset on the spot market, sell the same size of its perp, and the two price
exposures cancel: what is left is the funding stream, less the cost of getting
in and out.

```
periods    525600 / intervalMinutes                (8h -> 1095 a year)
annual     rate x periods x 100                     [%, simple, not compounded]
fees       feeRate x 4                              buy spot, sell perp,
                                                    sell spot, buy perp back
drag       fees x (365 / holdingDays) x 100        [%, the round trip annualised]
net        annual - drag
```

Worked example — rate `0.0001` per 8h, `fee_rate` 0.1%, held 30 days:

```
periods    525600 / 480                  = 1095
annual     0.0001 x 1095 x 100           = 10.95%
fees       0.001 x 4                     =  0.004      (0.4% of notional)
drag       0.004 x (365 / 30) x 100      =  4.86666667%
net        10.95 - 4.86666667            =  6.08333333%

sanity     over the 30 days actually held:
           10.95 x 30/365 - 0.4          =  0.5% earned
           0.5 x 365/30                  =  6.08333333%   ✓
```

Held for a year the same rate nets **10.55%**; held for a *day* it nets
**−135.05%**, because the 0.4% round trip is then paid 365 times over. Holding
period is not a detail of this trade, it is most of it.

**Venue chain**, both unauthenticated and both reached with a User-Agent and
nothing else — the header builder in `src/funding.ts` takes no `Env`, so a
Binance credential structurally cannot be attached to either:

1. **Bybit v5** `/v5/market/tickers?category=linear` — the whole linear board in
   one request. It does not carry the settlement interval, so
   `/v5/market/instruments-info` supplies that separately and is cached for 24h
   in a `settings` row (same escape hatch as the scan lock). A missing cadence
   falls back to 8 hours and the row is tagged `interval_source = 'assumed'`,
   because the annualised figure scales *linearly* with it.
2. **OKX v5** `/api/v5/public/funding-rate?instId=…` — one request per
   instrument (11), under `Promise.allSettled`. The cadence is derived from
   `nextFundingTime − fundingTime`, so the fallback is not a second-class
   source. Used when Bybit fails or covers under 60% of the universe; if both
   fail the error names both, exactly as the spot chain's does.

**Cadence and retention.** The board is polled at most every 5 minutes, gated on
`MAX(ts)` in `funding_rates` — funding settles every 8 hours, so a minutely scan
has nothing to learn by asking every minute. Rows are kept for **7 days** and
pruned inside the same `batch()` that writes the new board, so the prune can
never run without its insert. `POST /api/funding/refresh` bypasses the gate and
writes rows with `scan_id = NULL`.

**No positions are opened**, on purpose. This repo's paper-execution model is
atomic — a cycle opens and closes inside one snapshot, against one `balances`
row — and a carry is held for days. Booking one against that model would report
a P&L nobody could reconcile, so migration `0004` deliberately adds no positions
table; the schema is shaped so one can be added later without rewriting these
rows.

**Disclaimers**, all documented in `src/engine/funding.ts`:

- **The predicted next rate is the dominant error source.** A venue publishes
  the rate for the *next* settlement only. Annualising it assumes that rate
  repeats ~1095 times, which it does not: funding mean-reverts, flips sign with
  sentiment, and the eye-catching numbers are precisely the ones least likely to
  persist. Treat every percentage here as "what the last observation would pay
  if it never changed".
- **Only long-spot / short-perp is modelled.** The mirror needs borrow, and
  borrow cost is not modelled — negative rows are ranked and reported (they are
  the finding on the day they happen) but never presented as tradable from the
  other side.
- **Basis is ignored** — entry and exit are assumed at the same spot/perp
  spread, which is where a real carry makes or loses most of its non-funding
  P&L.
- **Margin and liquidation are ignored.** The short perp needs collateral, that
  collateral earns nothing here, and an adverse move large enough to liquidate
  it is not simulated at all. Slippage and depth are ignored as everywhere else.
- **Simple returns, 365-day year.** Funding is assumed withdrawn, not
  reinvested; compounding would raise every figure above.

## Simplifications (MVP)

- Fills at snapshot best bid/ask; order-book depth, lot-size/notional filters,
  and slippage are ignored.
- Equity = USDT balance (every cycle and every spread returns to USDT).
- Pair discovery uses MEXC's listing (REST-reachable), which covers 19 of the
  ~38 Binance-listed pairs in the universe — fewer triangles than the full set.
- Max one paper trade **per strategy** per scan (so at most two — funding opens
  no positions at all).
- Cross-exchange spreads assume pre-positioned inventory: no transfer, no
  withdrawal fee, no latency between the two legs. See the section above.
- Funding carry is scanned and recorded, never simulated; its annualisation
  extrapolates a single published rate. See the section above.

## Architecture decisions

- **One Worker, three roles** (API + static dashboard + cron) — no build step,
  free-plan compatible.
- **D1 over Durable Objects** — single writer, SQL fits trade history/P&L,
  free tier ample. A 45s scan lock (settings row) prevents cron/manual overlap.
- **Pure engine** (`src/engine/`) — zero Workers imports; profit math is
  unit-tested against closed-form hand-derived values.
- **Atomic execution** — balance delta + trade insert + opportunity flag +
  scan counter in a single `D1.batch()`; no partial-write window.
