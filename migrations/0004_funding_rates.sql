-- Phase 10: funding-rate (cash-and-carry) scanner.
--
-- Additive, like 0002 and 0003: not one existing table or column is touched.
-- In particular `scans` gains nothing — a funding failure lives only in the
-- in-memory `ScanResult.fundingError` and is never written to `scans.error`,
-- for the same reason a cross-exchange failure is not: a scan whose arbitrage
-- half ranked and filled normally did not fail because a perp venue was slow.
--
-- **Opportunities only.** There is deliberately no positions table here. The
-- paper-execution model in this repo is atomic — a cycle opens and closes
-- inside one snapshot — and a carry position is held for days, so booking one
-- against `balances` would report a P&L nobody could reconcile. The schema is
-- shaped so that a later `funding_positions` table is a pure addition rather
-- than a rewrite of these rows.

CREATE TABLE IF NOT EXISTS funding_rates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL for a manual POST /api/funding/refresh: that poll belongs to no scan,
  -- and inventing a scan row for it would put a scan in the history that never
  -- looked at a single market.
  scan_id         INTEGER,
  ts              INTEGER NOT NULL,
  -- 'bybit' or 'okx'. Free TEXT rather than a CHECK constraint, exactly as
  -- `strategy` is: src/types.ts owns the vocabulary, so a third venue needs no
  -- migration of a constraint.
  venue           TEXT NOT NULL,
  -- The asset ('BTC'), normalised across venues so history for one symbol is
  -- continuous even when the answering venue changed mid-week...
  symbol          TEXT NOT NULL,
  -- ...and the venue's own contract name ('BTCUSDT' / 'BTC-USDT-SWAP'), which
  -- is what someone reproducing the row has to paste into the venue's UI.
  instrument      TEXT NOT NULL,
  -- Per-interval funding fraction; positive means the short is paid.
  rate            REAL NOT NULL,
  interval_minutes INTEGER NOT NULL,
  -- 'api' or 'assumed'. Stored per row, not inferred at read time: the
  -- annualised figure scales linearly with the interval, so whether it was
  -- known or guessed is part of what the row means.
  interval_source TEXT NOT NULL,
  -- Both derived figures are snapshotted rather than recomputed on read: they
  -- depend on `fee_rate` and `funding_hold_days`, and re-deriving them from
  -- today's settings would rewrite history on the next retune. (The
  -- `qualifies` flag the API reports is the opposite case — it is a *current*
  -- judgement about a stored row, so it is computed at read time.)
  annualized_pct  REAL NOT NULL,
  net_annual_pct  REAL NOT NULL,
  next_funding_ts INTEGER,
  mark_price      REAL
);

-- The three reads this table has: "the newest board" (ts DESC, then a
-- MAX(ts) equality), "everything one poll wrote" and "one symbol's history".
CREATE INDEX IF NOT EXISTS idx_funding_rates_ts      ON funding_rates (ts DESC);
CREATE INDEX IF NOT EXISTS idx_funding_rates_scan_id ON funding_rates (scan_id);
CREATE INDEX IF NOT EXISTS idx_funding_rates_symbol_ts ON funding_rates (symbol, ts DESC);
