# crypto-arb — Cross-Exchange & Funding-Rate Observatory on Cloudflare

A fully serverless scanner that measures two things every minute and writes down
what it saw: **cross-exchange spot spreads** (the same market on Binance and
MEXC) and **perpetual funding rates** (Bybit / OKX). **Nothing is traded, and
nothing is simulated as traded** — no orders, and since Phase 12 no paper fills
either.

Phase 12 deleted the triangular-arbitrage strategy and every paper-execution
path in the repo. Recorded production data showed the triangular edge was
structurally dead (best live net ≈ −0.3% against a 0.3006% break-even) and the
spread edge unmeasurable through a known dominant false positive (WS/REST timing
skew, below). Booking fills against numbers like those produced a P&L that
described nothing. The `trades`, `balances` and `opportunities` rows written
before that decision are still on disk and still served — see
[docs/profitability-recommendations.md](docs/profitability-recommendations.md).

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
        [cross-exch]  price every X/USDT market on BOTH books, both ways →
                      keep the better → rank → persist the top 10
                              │
              api.bybit.com / www.okx.com  ◄── perp funding rates, polled at
                              │                most every 5 min (gated)
        [funding]     annualise the next funding rate of all 11 perps, net of
                      4 legs of fees over the assumed holding period →
                      persist the whole board
                              │
                              ▼
        D1 (SQLite): pairs · scans · opportunities · funding_rates · settings
                     (+ balances · trades — historical, read-only)
                              │
                              ▼
        Dashboard (vanilla JS, Workers Assets) — 5s polling
```

Both thresholds (`xchg_min_profit_pct`, `funding_min_annual_pct`) are **display
flags**, applied at read time. Every priced row is persisted whatever they say,
because a threshold applied at write time throws away the measurement.

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
| `GET /api/portfolio` | **Historical.** Balances, equity, P&L vs 10,000 USDT initial, frozen where the fill era left them |
| `GET /api/opportunities?limit=50` | Ranked spreads per scan, with per-leg detail and a `qualifies` flag judged against the current `xchg_min_profit_pct`. `&strategy=cross_exchange\|triangular` filters (the latter reads history only); an unknown value is a 400 |
| `GET /api/trades?limit=50` | **Historical.** Fills booked before Phase 12. Same `&strategy=` filter |
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
| `fee_rate` | `0.001` | `0`–`0.01` | Taker fee per leg, used by the spread net math and the funding fee drag. |
| `india_mode` | `0` | `0` or `1` | Annotate spreads with the Indian VDA tax overlay (see below). |
| `tds_rate` | `0.01` | `0`–`0.05` | Section 194S withholding per VDA transfer. |
| `tax_rate` | `0.3` | `0`–`0.5` | Section 115BBH rate on gains. Use `0.312` to include the 4% cess. |
| `xchg_min_profit_pct` | `0.05` | any | Net % a spread must clear to be flagged `qualifies`. **Display only** — every priced row is persisted regardless. |
| `xchg_enabled` | `1` | `0` or `1` | Scan cross-exchange spreads. `0` leaves the scan polling funding alone: no snapshot is fetched at all. |
| `funding_min_annual_pct` | `5` | any | Net annualised % a carry must clear to be flagged `qualifies`. **Display only**, same as above. |
| `funding_hold_days` | `30` | `0 < d ≤ 3650` | Days a carry is assumed held, used to amortise the 4 legs of fees. Changing it re-prices future rows only. |

`initial_usdt` is immutable — it is the denominator of every P&L figure ever
reported, so moving it would rewrite history rather than change behaviour.

Phase 12 retired `min_profit_pct` and `trade_size_usdt` along with the fill
paths they gated. `PUT /api/settings` rejects them as unknown keys rather than
pretending to store them, and any rows an older release left in the `settings`
table are simply never read — no migration, destructive or otherwise.

## Development

```bash
npm install
npm test                                        # 271 tests: pure engine math +
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

With real fees (0.1%/leg → ~0.2003% break-even on two legs, ~0.3006% on three)
genuine top-of-book edges on a 1-minute scan are rare, and the ones this scanner
*reports* are dominated by the timing skew documented below rather than by real
mispricing. Expect it to observe, rank, and decline to claim anything more. That
is the finding, not a bug — and it is why nothing here fills.

### India mode

Set `india_mode: 1` to overlay the Indian virtual-digital-asset tax regime on
each priced spread. Two levies, and they behave nothing alike:

- **Section 194S — 1% TDS**, withheld by the exchange on the *consideration* of
  every VDA transfer. Cash leaves immediately, but it is a **prepayment**
  creditable against the year's bill.
- **Section 115BBH — 30% on gains** (31.2% with cess), with **no loss set-off**
  and no deduction except cost of acquisition. Charged per trade on
  `max(profit, 0)`; a losing round trip does not shelter a winning one.

**Every leg is a disposal.** `BUY`/`SELL` here is an exchange-listing artefact —
`USDT → BTC` is only a "BUY" because the market is spelled `BTCUSDT`. What 194S
cares about is that a VDA changed hands, and **USDT is itself a VDA** under
Indian law. So both legs of a spread attract TDS (tax base ~2× the notional),
and all three legs of the deleted triangular cycle did (~3×) — never 1×.

Two P&L views, both reported on the historical rows:

| View | Formula | Where |
|---|---|---|
| **Economic** | `netProfit = profit − taxDue` | "Net P&L (post-tax)", `netEquityUsdt` |
| **Cash** | balance moved by `profit − tdsWithheld` | "Equity", `pnl` |

Subtracting both would double-count — TDS *is* a prepayment of the tax, not a
second charge.

Worked example on the repo's +1.694305898% three-hop fixture (100 USDT,
0.1%/leg, `USDT>BTC>ETH>USDT`, TDS 1%, tax 30%) — the arithmetic that ended the
triangular strategy, kept here because it is the evidence:

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
triangular edge.** A cycle needed a net return above ~3.02% just to break even on
cash flow. Nothing in this repo's live scans ever came close. A two-leg spread
fares one leg better (~2%) and still loses by the same order of magnitude — see
the section below. Round-tripping capital through a jurisdiction that withholds
on turnover rather than on gains is structurally incompatible with
high-frequency arbitrage: that is the finding, not a limitation of the model,
and it is half of why this repo stopped booking fills at all.

Modelling simplifications (all documented in `src/engine/tax.ts`): no INR FX;
TDS is not compounded into the chain, so `endAmount` and `profitPct` stay
byte-identical with the mode on or off; the 194S de-minimis thresholds are
ignored (a minutely scanner clears them within the hour); cess is not
hard-coded (set `tax_rate: 0.312`); and 115BBH allows only cost of acquisition
as a deduction anyway, which for an atomic round trip is exactly the start
notional. **None of this is tax advice.**

## Cross-exchange spreads

The one live spot strategy: the *same* market on two venues at once. Binance
(WebSocket) and MEXC (REST) are fetched concurrently per scan; where both list a
`X/USDT` market, the pair of books is priced in both directions and the better
one is kept. Priced on a notional of 1 base unit, ranked, persisted — never
filled.

```
leg 1  BUY  X on venue A at askA:  base = (1 / askA) x (1 - f)
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
  per 1 USDT:  1 -> 0.00001665 BTC -> 1.00614998 USDT

mirror (buy MEXC @60510, sell Binance @60000)   =  -1.0410510700%
```

Persisted rows carry a `strategy` column (`cross_exchange` for everything the
scanner writes now; `triangular` survives on the pre-Phase-12 rows) and a label
instead of a cycle — `BTCUSDT binance-ws>mexc-rest`. The top 10 of each scan are
kept, whatever `xchg_min_profit_pct` says about them.

**Simplifications**, all documented in `src/engine/crossExchange.ts`:

- **Instant top-of-book pricing** — depth and slippage ignored, so every
  reported edge is an upper bound.
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
  more "opportunities" than any desk could fill, why nothing here places an
  order, and why Phase 12 stopped booking paper fills against these numbers too.
  Treat a reported spread as an upper bound on an upper bound.

A missing second venue is recorded in `scans.xchg_error`, never in `scans.error`:
a scan whose funding poll landed a full board did not fail because MEXC was slow.

**India mode applies to spreads too**, and they fare slightly better: a spread
is a **two-disposal** chain (USDT on the buy venue, then the asset on the sell
venue) against the deleted triangle's three, so ~2% of notional is withheld
rather than ~3%. Each disposal is valued on the book of the venue where that leg
would actually execute. On the worked example above, at 100 USDT: base
`200.7325`, TDS `2.007325`, tax due `0.18953025`, net `0.44223725` — still a ~2%
drag on a ~0.6% edge, so the conclusion of the India-mode section holds with one
leg less. That is the other half of why nothing fills.

## Funding-rate carry (cash-and-carry)

The go-forward core, and the strategy the next phases build on.

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

**No positions are opened**, on purpose. A carry is held for days, and the
paper-execution model this repo used to have was atomic — a round trip opened
and closed inside one snapshot, against one `balances` row. Booking a carry
against that would have reported a P&L nobody could reconcile, so migration
`0004` deliberately adds no positions table. That model is gone now (Phase 12),
and a later phase will add paper carry positions with a P&L of their own; the
schema is shaped so that needs no rewrite of these rows.

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

## Simplifications

- Prices at snapshot best bid/ask; order-book depth, lot-size/notional filters,
  and slippage are ignored.
- **Nothing is executed or simulated as executed.** Every percentage is a
  measurement of what the books said, not a claim that it was obtainable.
- Pair discovery uses MEXC's listing (REST-reachable), which covers 19 of the
  ~38 Binance-listed pairs in the universe.
- Cross-exchange spreads assume pre-positioned inventory: no transfer, no
  withdrawal fee, no latency between the two legs. See the section above.
- Funding carry is scanned and recorded; its annualisation extrapolates a single
  published rate. See the section above.
- `balances`, `trades` and the `triangular` rows in `opportunities`/`scans` are
  a **frozen historical record** of the fill era. They are served unchanged and
  never added to.

## Architecture decisions

- **One Worker, three roles** (API + static dashboard + cron) — no build step,
  free-plan compatible.
- **D1 over Durable Objects** — single writer, SQL fits a time series and its
  history, free tier ample. A 45s scan lock (settings row) prevents cron/manual
  overlap.
- **Pure engine** (`src/engine/`) — zero Workers imports; the spread, tax and
  funding math is unit-tested against closed-form hand-derived values.
- **Thresholds are read-time judgements**, never write-time gates: a scanner
  whose job is to record what happened cannot afford to drop the rows that
  disagree with today's setting.
- **No destructive migrations.** Retiring a strategy retires the code that
  writes its rows, not the rows.
