# crypto-arb — Cross-Exchange & Funding-Rate Observatory on Cloudflare

A fully serverless scanner that measures two things every minute and writes down
what it saw: **cross-exchange spot spreads** (the same market on Binance and
MEXC) and **perpetual funding rates** (Bybit, OKX, Gate and KuCoin, all four
polled on every board). Since Phase 15 it also **holds paper carry positions**,
so the one edge it measures as positive has a realised P&L to check its own
prediction against. **Nothing is traded** — no orders, no paper fills since
Phase 12, and a carry position never moves a balance.

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
      bybit · okx · gate · kucoin (all four)  ◄── perp funding rates, polled at
                              │                   most every 5 min (gated),
                              │                   concurrent + allSettled
        [funding]     annualise the next funding rate of every quoted perp, net
                      of 4 legs of fees over the assumed holding period → rank →
                      persist the majors + each venue's best 20 and worst 5
                              │
        [carry]       accrue every open paper position from the rows just
                      written → close on hold/exit/staleness → open up to
                      funding_max_positions from the fresh board (zero extra
                      subrequests; never touches balances)
                              │
                              ▼
        D1 (SQLite): pairs · scans · opportunities · funding_rates ·
                     funding_positions · settings
                     (+ balances · trades — historical, read-only)
                              │
                              ▼
        Dashboard (vanilla JS, Workers Assets) — 5s polling
```

Neither threshold (`xchg_min_profit_pct`, `funding_min_annual_pct`) is a
**write-time gate**: every priced row is persisted whatever they say, because a
threshold applied at write time throws away the measurement. Both are applied at
read time — and since Phase 15 `funding_min_annual_pct` additionally selects
which board rows a paper carry position may be opened on.

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
| `GET /api/funding` | Newest funding board across every venue, best net carry first, with `qualifies` judged against the current threshold. `venues` reports each venue's share; `venue` names the source of the top row |
| `GET /api/funding/history?symbol=BTC&limit=100` | One symbol's rate series, newest first (limit clamped to 500). `&venue=gate` narrows it to one venue — a symbol now has a row per venue per poll; an unknown venue is a 400 |
| `POST /api/funding/refresh` | Poll every perp venue now, bypassing the 5-minute gate. 200 with `venueErrors` when some venues fail; 502 only when they all do |
| `GET /api/funding/positions?limit=50` | The paper carry book: open positions, the newest closed ones, and the realised-vs-predicted summary |
| `POST /api/funding/positions/:id/close` | Close one position by hand (`close_reason = 'manual'`). 404 unknown, **409** already closed |
| `GET/PUT /api/settings` | See the settings table below |
| `POST /api/reset` | Restore balances; `{"wipeHistory": true}` also clears history |
| `POST /api/admin/refresh-pairs` | Rebuild the tradable-pair cache |

### Settings

| Key | Default | Range | Meaning |
|---|---|---|---|
| `fee_rate` | `0.001` | `0`–`0.01` | Spot taker fee per leg: both legs of a spread, and the two spot legs of a funding carry. |
| `perp_fee_rate` | `0.0005` | `0`–`0.01` | Perp taker fee per leg: the two perp legs of a funding carry. Roughly half the spot rate on OKX and Bybit. |
| `india_mode` | `0` | `0` or `1` | Annotate spreads with the Indian VDA tax overlay (see below). |
| `tds_rate` | `0.01` | `0`–`0.05` | Section 194S withholding per VDA transfer. |
| `tax_rate` | `0.3` | `0`–`0.5` | Section 115BBH rate on gains. Use `0.312` to include the 4% cess. |
| `xchg_min_profit_pct` | `0.05` | any | Net % a spread must clear to be flagged `qualifies`. **Display only** — every priced row is persisted regardless. |
| `xchg_enabled` | `1` | `0` or `1` | Scan cross-exchange spreads. `0` leaves the scan polling funding alone: no snapshot is fetched at all. |
| `funding_min_annual_pct` | `5` | any | Net annualised % a carry must clear to be flagged `qualifies` **and to have a paper position opened on it**. Never a write-time gate: every priced row is persisted regardless. |
| `funding_hold_days` | `30` | `0 < d ≤ 3650` | Days a carry is assumed held, used to amortise the 4 legs of fees (2 spot + 2 perp). Changing it re-prices future rows only, and is also the `max_hold` close rule. |
| `funding_positions_enabled` | `1` | `0` or `1` | Open new paper carry positions. `0` still accrues and closes the ones already open — see below. |
| `funding_position_size_usdt` | `1000` | `> 0` | Notional of each leg of a paper carry. Never drawn from `balances`. |
| `funding_max_positions` | `3` | `1`–`20`, whole | How many carry positions may be open at once. |
| `funding_exit_annual_pct` | `0` | any | Net annualised % below which an open carry is closed. Deliberately lower than `funding_min_annual_pct`. |

`initial_usdt` is immutable — it is the denominator of every P&L figure ever
reported, so moving it would rewrite history rather than change behaviour.

Phase 12 retired `min_profit_pct` and `trade_size_usdt` along with the fill
paths they gated. `PUT /api/settings` rejects them as unknown keys rather than
pretending to store them, and any rows an older release left in the `settings`
table are simply never read — no migration, destructive or otherwise.

## Development

```bash
npm install
npm test                                        # 382 tests: pure engine math +
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
fees       spotFee x 2 + perpFee x 2                buy spot, sell perp,
                                                    sell spot, buy perp back
drag       fees x (365 / holdingDays) x 100        [%, the round trip annualised]
net        annual - drag
```

The four legs are **not** charged the same rate: the two spot legs pay
`fee_rate` (~0.1%) and the two perp legs pay `perp_fee_rate` (~0.05%, the
standard linear-perp taker rate on OKX and Bybit). Charging the spot rate on all
four — as every phase before Phase 13 did — overstated the round trip by a third.

Worked example — rate `0.0001` per 8h, `fee_rate` 0.1%, `perp_fee_rate` 0.05%,
held 30 days:

```
periods    525600 / 480                  = 1095
annual     0.0001 x 1095 x 100           = 10.95%
fees       0.001 x 2 + 0.0005 x 2        =  0.003      (0.3% of notional)
drag       0.003 x (365 / 30) x 100      =  3.65%
net        10.95 - 3.65                  =  7.30%

sanity     over the 30 days actually held:
           10.95 x 30/365 - 0.3          =  0.6% earned
           0.6 x 365/30                  =  7.30%        ✓
```

Held for a year the same rate nets **10.65%**; held for a *day* it nets
**−98.55%**, because the 0.3% round trip is then paid 365 times over. Holding
period is not a detail of this trade, it is most of it: break-even here is
exactly 10 days.

The split is a **re-pricing, not a migration.** Rows already on disk keep the
`net_annual_pct` they were written with — the figure that was actually used at
poll time — so a board recorded before Phase 13 reads ~1.22%/yr lower at a
30-day hold than the same board would today.

**Every venue, every board** (Phase 14). There is no primary/fallback chain any
more: all four are polled concurrently under `Promise.allSettled` and each one's
failure costs exactly its own rows. A chain answers "which venue do we trust
most", which is the wrong question once the venues quote *different universes* —
and two venues disagreeing about BTC's funding is a measurement, not a conflict.
All four are unauthenticated and reached with a User-Agent and nothing else; the
header builder in `src/funding.ts` takes no `Env`, so a Binance credential
structurally cannot be attached to any of them.

1. **Bybit v5** `/v5/market/tickers?category=linear` — the whole linear board in
   one request, reduced to the 11 majors. It does not carry the settlement
   interval, so `/v5/market/instruments-info` supplies that separately and is
   cached for 24h in a `settings` row (same escape hatch as the scan lock). A
   missing cadence falls back to 8 hours and the row is tagged
   `interval_source = 'assumed'`, because the annualised figure scales
   *linearly* with it.
2. **OKX v5** `/api/v5/public/funding-rate?instId=…` — one request per
   instrument, so it stays capped at the 11 majors: pointing it at a full board
   would cost ~600 subrequests by itself. The cadence is derived from
   `nextFundingTime − fundingTime`, so it is not a second-class source.
3. **Gate v4** `/api/v4/futures/usdt/contracts` — one request, ~850 USDT-margined
   perps with `funding_rate` and `funding_interval` (seconds) included.
   Delisting, halted, pre-market and non-crypto contracts (Gate lists tokenised
   equities, indices, forex and metals on the same board) are skipped: a carry
   needs a spot leg.
4. **KuCoin futures** `/api/v1/contracts/active` — one request, ~660 perps with
   `fundingFeeRate` and `fundingRateGranularity` (milliseconds). `XBT` normalises
   to `BTC`; dated futures, non-USDT margin and perps with an `expireDate` set
   are skipped.

Worst case is 2 + 11 + 1 + 1 = **15 subrequests** for funding and 18 for a whole
scan, against Cloudflare's free-plan limit of 50. The arithmetic is asserted in
a comment beside `FUNDING_VENUES` in `src/funding.ts`, which is the only place
the list is defined.

> **Reachability is unknown until deploy.** Binance and Bybit REST answer 403
> from Cloudflare's egress in production and OKX does not; whether Gate and
> KuCoin are reachable is an open question until phase 18 deploys and looks.
> That is precisely why they are two more `allSettled` branches and not links in
> a chain: a blocked venue costs its own rows, a string in
> `ScanResult.fundingVenueErrors`, and nothing else. A poll fails only when *no*
> venue produced a single quote.

**Kraken futures is deliberately not here.** Its perps fund continuously and
accrue per hour against a different reference, so normalising it into the
per-settlement `rate` this schema stores would produce a number that looks
comparable to the other four and is not. Modelling it wrong is worse than
omitting it; adding it means modelling its semantics, not adding a URL. Future
work.

**Universe and cap.** Each full-board venue persists the 11 majors
unconditionally — they are the continuous series `/api/funding/history` serves,
and dropping BTC the day its funding went flat would put a hole in exactly the
chart someone reads to see funding go flat — plus a 25-row budget of its own
tail, split `FUNDING_BOARD_TOP_N = 20` best and `FUNDING_BOARD_BOTTOM_N = 5`
worst by net annual carry. The cap is per venue, not global, so one hot venue
cannot crowd every other one off the board and quietly end the cross-venue
comparison.

The budget is split because the ranking is signed. A deeply negative rate is a
headline result — the engine keeps negative rows on exactly those grounds — and
a pure "top 25" cap discarded every one of them, so the most extreme figure on
the board (a live Gate capture had `LA_USDT` at roughly -1548%/yr) was
systematically the one row that could never be persisted.

**Cadence and retention.** The board is polled at most every 5 minutes, gated on
`MAX(ts)` in `funding_rates` — funding settles every 8 hours, so a minutely scan
has nothing to learn by asking every minute. Rows are kept for **7 days**, and
the prune rides in the last `batch()` of the insert, after every row has landed.
Inserts are chunked at 50 statements per batch (D1 caps statements per batch, and
a four-venue board is ~144 rows), so a board is no longer written as one
transaction: a reader polling mid-write can see a *partial* board — never a
mixture of two polls, since every row of a poll shares one timestamp. A chunk
that *fails* part-way is worse than that: the chunks already written carry the
new `ts`, so the 5-minute poll gate declines to retry and `/api/funding` serves
the truncated board for the rest of the interval. The scan reports the failure
in `fundingError`; the board does not.
`POST /api/funding/refresh` bypasses the gate and writes rows with
`scan_id = NULL`.

**Positions are held on paper since Phase 15** — see the section below. They are
recorded in `funding_positions` (migration `0005`) and **never** booked against
`balances`: a carry is held for days, and the paper-execution model this repo
used to have was atomic — a round trip opened and closed inside one snapshot,
against one `balances` row. Booking a carry against that would have reported a
P&L nobody could reconcile, which is why migration `0004` deliberately added no
positions table and why `0005` adds one that touches nothing `0004` wrote.

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

## Paper carry positions (realised vs predicted)

Phase 15. The board above says what a carry *would* pay if the next published
rate repeated ~1095 times a year. This section holds positions so the repo can
say what one *did* pay — the same claim, measured. The pair to read is
`predicted_net_annual_pct` (what the entry quote promised) against
`realized_annual_pct` (what the position actually earned, net of one round trip,
annualised over the days it was really held). Their difference is the
extrapolation error `src/engine/funding.ts` names as its dominant unknown.

**Nothing is traded and nothing moves a balance.** `funding_positions` is a
ledger beside the portfolio, not inside it: `GET /api/portfolio` reports a
`carry` block of its own and the spot `equityUsdt` keeps the exact meaning it
has had since the fill era ended. Add them at your own risk; the repo does not.

### Lifecycle

One pass runs on every **scan's** funding poll, inside the funding `try` and in a
`catch` of its own, **after** the board has been persisted — so a bug in the
accrual costs the carry pass and never the board rows, and it lands in
`ScanResult.carryError` rather than in `fundingError` or `scans.error`. It costs
zero subrequests: it reads only rows the poll just wrote.
`POST /api/funding/refresh` deliberately does **not** advance the book — it is a
data refresh, and a lifecycle anyone could drive by POSTing repeatedly would let
a caller open and close positions at will. The order is accrue → close → open,
and each step is that way round for a reason:

1. **Accrue.** For every open position, every settlement boundary in
   `(last_accrual_ts, now]` is priced by the newest `funding_rates` row for its
   `(venue, symbol)` at or before that boundary and no more than 24h older. The
   grid is anchored to the venue's published `next_funding_ts` when there is one
   and to whole multiples of the interval since the epoch when there is not —
   never to the position's own entry time, which would give every position a
   private schedule. **A boundary with no observation is skipped, not
   estimated**, and `last_accrual_ts` advances past it: an unobserved settlement
   is missing data, and inventing a payment for it is the one error that would
   flatter the result without leaving a trace. `accrual_count` is stored so the
   hole stays visible.
2. **Close.** In precedence order: `max_hold` (`funding_hold_days` elapsed — the
   horizon the fee drag was amortised over), `stale_data` (nothing fresh for that
   contract in 24h), `rate_below_exit` (current net annual below
   `funding_exit_annual_pct`). Staleness outranks the threshold on purpose: a
   percentage carried by a two-day-old row is not a current judgement, and
   letting it fire `rate_below_exit` would label a data outage as a rate
   collapse. Accrual runs *first* so an exit never forfeits settlements the
   scanner did observe.
3. **Open.** Up to `funding_max_positions`, best net carry first, from the board
   just written: the row must clear `funding_min_annual_pct`, must not duplicate
   an open `(venue, symbol)`, and **must carry `interval_source = 'api'`.**
   Nothing is ever opened on an assumed cadence — the annualised figure scales
   linearly with the interval, so a contract that really settles hourly is
   under-reported 8x, which is tolerable for a board that is only read and not
   tolerable as a position's accrual grid.

`funding_positions_enabled = 0` gates **opening only**. Turning it off must not
strand an open book with a P&L frozen mid-flight, so existing positions go on
accruing and go on being closed.

Every entry figure is snapshotted — notional, both taker rates, the interval, the
rate and both percentages — so retuning a setting can never re-price a position
that is already running. Closing is idempotent at the database (`WHERE status =
'open'`), which is what makes a second `POST …/close` a 409 rather than a
silently rewritten realised P&L.

```
accrued    Σ over observed boundaries of  rate_at_boundary x notional
fees       notional x (2 x spot_fee_rate + 2 x perp_fee_rate)   [entry snapshot]
realised   accrued - fees                                        [USDT, signed]
realised%  (realised / notional) x (365 / actual_hold_days) x 100
```

Worked example — 1000 USDT a leg, 0.0001 per 8h collected for 30 days (90
settlements), 0.1% spot / 0.05% perp: `accrued 9.00 − fees 3.00 = 6.00 USDT`,
annualised `7.30%` — the same 7.30% the board predicts for that quote, arrived at
from the other end. `test/carry-math.test.ts` asserts both.

### Honest-model caveats

Everything the funding section disclaims still applies, plus:

- **Basis and mark-to-market are not modelled at all.** Entry and exit are
  assumed at the same spot price *and* the same perp price, so the legs cancel
  exactly and the whole P&L is the funding stream less fees. In reality basis
  convergence is where a carry makes or loses most of its non-funding P&L. **A
  realised figure here is the funding result, not the trade's.**
- **No margin, no collateral yield, no liquidation, no slippage.** The short perp
  leg needs collateral it never posts, and an adverse move large enough to
  liquidate it is not simulated.
- **Accrual is only as complete as the data.** A boundary crossed while the
  scanner was down pays nothing at all rather than an estimate, so a realised
  figure from a week with an outage is biased *low* — `accrual_count` against
  elapsed time is how you tell.
- **`realized_annual_pct` is not a forecast either.** A position closed after
  three days annualises a three-day result by a factor of 122; it says what
  happened over those days, scaled, not what a year would look like.
- **No taxes are applied to carry.** The India-mode overlay prices spread legs
  only. Four legs amortised over a multi-week hold is precisely the shape that
  survives a turnover-based withholding where the minute-scale strategies did
  not (`docs/profitability-recommendations.md`), but the arithmetic is not
  wired into these rows.

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
- Paper carry positions accrue funding and nothing else: no basis, no
  mark-to-market, no margin, and no balance is ever moved. See the section above.
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
