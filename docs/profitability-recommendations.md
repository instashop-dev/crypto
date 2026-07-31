# Profitability recommendations

*2026-07-31 · Based on live production data through phase 11. Suggestions only — no code changes accompany this document.*

This document answers one question: **given what this system has actually measured, where should effort go to make it profitable?** Every number below traces to code, tests, or recorded production scans in this repo. "Profitable" here means the paper model identifying edges that would credibly survive real-world costs — this repo does not execute real trades, and nothing here is investment or tax advice.

---

## 1. Where the edge actually is

Three strategies are live. The recorded data already settles their ranking.

### Triangular arb: structurally dead — keep as an observer, spend nothing further

- Break-even is **0.3006% gross** per cycle at 0.1%/leg taker (`1/(1-0.001)³ − 1`, asserted in `test/profit.test.ts:288-293`, documented in README).
- Live observation: *"real best nets hover around −0.3%"* (README:110-115, `src/scan.ts:406-407`). That means the best **gross** edge on the 19 scanned pairs is ~0.0006% — effectively zero. **Even at 0% fees this strategy earns nothing**; the spread itself is absent on major pairs. Cheaper fees, maker orders, or more spot pairs all attack the wrong term.
- The checked-in real Binance book fixture (`test/fixtures/bookTicker.json`) confirms it: 42 priceable triangles, zero positive net, best gross +0.013%.
- Under India mode the cash break-even is **≈3.02%/cycle** (3 legs × 1% TDS, `test/tax.test.ts:229-233`) — two orders of magnitude away.

### Cross-exchange spread: unproven — instrument before trusting

- Break-even **0.2002%** gross (`test/crossExchange.test.ts:142-149`). No live spread statistics have ever been recorded — the only worked numbers in the repo are synthetic fixtures.
- The dominant signal is a known artifact: the Binance WS book accumulates over up to ~4s while the MEXC REST book is one read at the end (`src/engine/crossExchange.ts:55-61` calls timing skew "the dominant false positive"). Reported spreads are "an upper bound on an upper bound."
- Verdict: neither promote nor kill until skew and spread persistence are measured (R6 below).

### Funding-rate carry: the only measured positive edge — lean into it

- First production scan (2026-07-31, `docs/superpowers/specs/2026-07-31-funding-venue-probe.md`): best net annualized carry **6.08%**, 3 of 11 perps clearing the 5% threshold, all on 8h intervals, venue = OKX.
- The current model **understates** this edge: it charges the spot taker rate (0.1%) on all 4 legs, but perp legs on OKX are ~0.05% taker. Honestly modeled, drag at a 30-day hold drops from 4.87%/yr to ~3.65%/yr and the measured best net rises to **~7.3%** (R3).
- It is also the only strategy whose India TDS drag amortizes: 4 legs per multi-week hold instead of 3 legs per minute (see §5).

---

## 2. The ceiling, stated up front

A 1-minute cron scanner reading top-of-book at retail taker fees **cannot win latency-sensitive spread arb**. That game is won by colocated makers; the −0.3% triangular floor is the proof that no exploitable gross edge survives to a 1-minute observer on major pairs. The realistic target for this architecture is **single-digit-to-low-double-digit annualized carry, credibly measured** — with the fat-tail exception in R1, where short-lived funding spikes on small-cap perps can print far higher for days at a time. Any proposal promising more from this codebase is not being honest with you.

---

## 3. Ranked recommendations

| # | Recommendation | Why it wins | Effort |
|---|---|---|---|
| R1 | Widen the funding universe to mid/small-cap perps via multi-venue boards | The fat tail of funding rates is not in the 11 majors | Small–Medium |
| R2 | Paper funding-carry positions with realized-vs-predicted tracking | Turns the one positive edge into a measured P&L series | Medium |
| R3 | Per-leg fee split (spot vs perp) | 6.08% → ~7.3% measured net; one small honest fix | Small |
| R4 | Dated-futures basis capture (OKX quarterlies) | Locked-in carry, no rate-persistence risk | Medium |
| R5 | Cross-venue funding spread | Venue differentials are often steadier than absolute rates | Small |
| R6 | Cross-exchange skew + persistence instrumentation | Decides whether strategy #2 lives or dies, at zero subrequest cost | Small |
| R7 | 7-day profitability report endpoint + dashboard card | The "would it have made money" acceptance test | Small |

### R1 — Widen the funding universe (the biggest expected payoff)

The current 11-perp universe (`perpAssets`, `src/config.ts:159`) is all majors — exactly where funding is thinnest (best observed: 6.08% net). The fat tail of funding lives in mid/small-cap perps: new listings and hype coins routinely print **50–500% annualized for days** before mean-reverting. Venues with full-board single-request endpoints make this nearly free on the subrequest budget:

- Gate: `api.gateio.ws/api/v4/futures/usdt/contracts` (one request, includes `funding_rate` and interval for every contract)
- KuCoin futures: `api-futures.kucoin.com/api/v1/contracts/active`
- Kraken futures tickers

**Gate first on reachability:** probe these from the *deployed* Worker, not local `wrangler dev` — the 2026-07-30 probe table was wrong about Bybit for exactly this reason (`docs/superpowers/specs/2026-07-31-funding-venue-probe.md:40-49`). Budget: +1 subrequest per venue board, worst case ~13 → ~16 of the free plan's 50. The `funding_rates` table is already venue-keyed; `FundingVenue` in `src/types.ts` extends without a migration.

### R2 — Paper funding-carry positions (migration 0005)

Funding currently observes and never holds (`migrations/0004_funding_rates.sql` deliberately has no positions table, reserved as "a pure addition"). Add:

- **`funding_positions` table** (0005): venue, symbol, notional, entry ts/rate/annualized, snapshotted per-leg fees, `accrued_funding_usdt`, `predicted_net_annual_pct`, close ts/reason, `realized_pnl_usdt`, `realized_annual_pct`.
- **`src/engine/carry.ts`** (pure math, mirrors `engine/funding.ts` style): settlement-boundary counting, per-settlement accrual (rate × notional), close rules, realized figures net of round-trip fees.
- **Scan integration** inside the existing funding try/catch in `src/scan.ts` (per-strategy degradation isolation preserved): accrue open positions from the fresh board, close on `funding_hold_days` elapsed or net annual below a new `funding_exit_annual_pct`, open when best net ≥ `funding_min_annual_pct` and open count < `funding_max_positions`.
- **Settings**: `funding_positions_enabled`, `funding_position_size_usdt`, `funding_max_positions`, `funding_exit_annual_pct`. **Do not** book against `balances` — carry P&L stays its own portfolio section (the 0004 header's atomic-snapshot argument).
- **Routes**: `GET /api/funding/positions`, `POST /api/funding/positions/:id/close`.

The point is the `entry_annualized_pct` vs `realized_annual_pct` pair: it directly measures the "predicted rate repeats 1095×/yr" extrapolation error that `src/engine/funding.ts`'s own docblock names as the dominant unknown — and, combined with R1, tells you how much of the small-cap fat tail survives mean reversion.

### R3 — Per-leg fee split (fold in before R2's math)

Add `perp_fee_rate` (default 0.0005, OKX taker) alongside `fee_rate`. Drag becomes `(2·spotFee + 2·perpFee) × (365/holdDays) × 100` in `src/engine/funding.ts` (overload alongside the existing single-fee signature for 0004 back-compat). At 30-day hold: drag 4.87% → 3.65%/yr; the recorded 6.08% best net becomes ~7.3%. Update the worked examples in `test/funding-math.test.ts`.

### R4 — Dated-futures basis capture (OKX quarterlies)

OKX — the one venue that reliably serves from CF egress — lists quarterly futures. Spot vs dated-future basis is the classic cash-and-carry with one decisive advantage over perp funding: **the annualized basis is locked in at entry** instead of re-rolled every 8 hours, so it has none of the rate-persistence risk R2 exists to measure. Same 4-leg fee structure, same India-friendly amortization over the hold. Start observation-only (a basis board next to the funding board), exactly as funding itself was introduced in phase 10, and let the recorded series justify positions later.

### R5 — Cross-venue funding spread

Once R1 lands multiple venue boards, compute per-symbol venue differentials at **read time** in `GET /api/funding` (no schema change, no write path): annualized(rateHigh − rateLow) minus an all-perp 4-leg round trip (≈0.2% at 0.05%/leg). Long the low-funding venue's perp, short the high — delta-neutral, no spot leg, and differentials are frequently steadier than the absolute rates. R2's position machinery can paper-trade these later with a paired-venue label.

### R6 — Cross-exchange honesty instrumentation

Cheap columns on `opportunities` (`skew_ms`, `persist_net_pct`, `persist_checked_ts`; NULL = not measured, matching the india-column convention):

- Timestamp the WS window end and the MEXC REST completion in `src/binance.ts`'s dual snapshot; persist the skew per spread row.
- Each scan, re-price the *previous* scan's top spreads against the fresh dual snapshot and record the surviving net — zero extra subrequests.
- Decision rule: if the surviving-net distribution never clears 0.2002%, the dashboard marks the strategy display-only and no further effort goes to it.

### R7 — 7-day profitability report

`GET /api/report?days=7` (7-day funding retention already supports it): per strategy — realized vs predicted carry error (R2), spread survival stats (R6), triangular best-net distribution (documents the −0.3% floor). One dashboard card. This is the acceptance test for everything above.

---

## 4. What deliberately not to do

- **Real-money execution** — out of scope for this repo; paper measurement first, and several model gaps (depth, filters, transfer costs) must close before real capital is even discussable.
- **Anything needing Binance REST or Bybit REST** — blocked from CF egress (451/403; only `wss://stream.binance.com` works).
- **Widening the spot triangular universe or maker-simulating spot arb** — the gross edge is zero; there is nothing to capture more cheaply.
- **Per-symbol order-book depth endpoints** — at 100 USDT notional, top-of-book is approximately correct; depth costs subrequests per symbol. Revisit only if `trade_size_usdt` grows.
- **Latency-sensitive spread arb generally** — unwinnable from a 1-minute cron; see §2.

## 5. India-mode note

Phase 8's finding stands and shapes everything above: with every leg a VDA disposal, 1% TDS withholds ≈3.02× notional per triangular cycle and ≈2.01× per spread — ~10× the fee break-even — so **any strategy that turns the book over in minutes is structurally cash-negative in India regardless of gross edge** (README:117-172, `test/tax.test.ts`). The exceptions are carry and basis (R2, R4): 4 legs amortized over a multi-week hold, with funding/basis accruing between them. That asymmetry, not raw edge size, is why this document concentrates on carry-family strategies. (System economics only — consult a professional for actual tax treatment.)

## 6. Acceptance criterion

After implementing R1–R3 + R6–R7 and a 3–7 day soak, `GET /api/report` must be able to answer:

1. **Realized vs predicted carry error** — including the widened universe's fat-tail rates (does a 200%-annualized print on a small cap survive even 3 days?).
2. **Spread survival rate** — what fraction of cross-exchange spreads outlive the ~4s skew and clear 0.2002%?
3. **Did any strategy clear its break-even over the window?** — the whole effort's yes/no.

If (3) is "no" across a few weeks of soak, that is itself the answer: the honest conclusion would be that this venue/fee/latency envelope offers carry-grade returns only, and the dashboard should say so.
