-- Phase 15: paper funding-carry positions.
--
-- The addition 0004 said it was leaving room for. Its header argued that a
-- positions table did not belong beside the rate rows *yet*, because the paper
-- model of the day was atomic — a cycle opened and closed inside one snapshot,
-- against one `balances` row — and a carry is held for days. That model is gone
-- (Phase 12), so the table lands here on the terms 0004 set: purely additive,
-- and **nothing here is ever booked against `balances`**. Carry P&L is its own
-- section of `/api/portfolio`; the spot equity figure keeps the exact meaning it
-- has had since the fill era ended, which is the only way the old rows stay
-- readable.
--
-- Not one existing table or column is touched, and `scans` gains nothing: a
-- carry failure lives in the in-memory `ScanResult.carryError` and never in
-- `scans.error`, for the same reason a funding failure does not — a scan whose
-- board landed did not fail because the accrual pass hit a bug.

CREATE TABLE IF NOT EXISTS funding_positions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL when the position was opened outside a scan. Nothing does that today,
  -- but the column mirrors `funding_rates.scan_id`, which is nullable for the
  -- manual-refresh case, and a NOT NULL here would be the one thing standing in
  -- the way of ever opening one from a route.
  opened_scan_id        INTEGER,
  -- 'open' or 'closed'. Free TEXT rather than a CHECK constraint, exactly as
  -- `strategy` and `venue` are: src/db.ts owns the vocabulary, so a third state
  -- (say 'liquidated', once margin is modelled) needs no constraint migration.
  status                TEXT    NOT NULL,
  -- Venue, normalised asset and the venue's own contract name, all copied from
  -- the `funding_rates` row the position was opened on. Copied rather than
  -- joined by id: the rate rows are pruned after 7 days and a position outlives
  -- them, so a foreign key would dangle by design.
  venue                 TEXT    NOT NULL,
  symbol                TEXT    NOT NULL,
  instrument            TEXT    NOT NULL,
  -- Size of *each* leg: long this much spot, short this much perp. Snapshotted
  -- from `funding_position_size_usdt` so retuning the setting cannot rewrite the
  -- P&L of a position already open.
  notional_usdt         REAL    NOT NULL,
  entry_ts              INTEGER NOT NULL,
  -- The per-interval rate and its annualisation, exactly as observed at entry.
  -- `entry_annualized_pct` is half of the measurement this whole table exists to
  -- make: against `realized_annual_pct` it is the extrapolation error that
  -- src/engine/funding.ts names as its dominant unknown.
  entry_rate            REAL    NOT NULL,
  entry_annualized_pct  REAL    NOT NULL,
  -- The settlement cadence in force at entry; it decides where the accrual
  -- boundaries fall. Only positions opened on a published cadence
  -- (`interval_source = 'api'`) exist at all — see src/scan.ts.
  interval_minutes      INTEGER NOT NULL,
  -- The two taker rates, snapshotted for the same reason `notional_usdt` is:
  -- the realised P&L is computed at close, potentially weeks later, and it must
  -- be charged the fees the position was priced with, not today's.
  spot_fee_rate         REAL    NOT NULL,
  perp_fee_rate         REAL    NOT NULL,
  -- Funding collected so far by the short perp leg, and how many settlements
  -- contributed to it. The count is stored rather than derived from elapsed time
  -- because boundaries with no observed rate are *skipped*, so the two disagree
  -- exactly when the data had a hole — which is worth being able to see.
  accrued_funding_usdt  REAL    NOT NULL DEFAULT 0,
  accrual_count         INTEGER NOT NULL DEFAULT 0,
  -- The newest settlement boundary already accrued; NULL until the first one
  -- crosses, when `entry_ts` is the anchor instead.
  last_accrual_ts       INTEGER,
  -- Net annual % predicted at entry (`entry_annualized_pct` less the fee drag
  -- over `funding_hold_days`). The number the position was opened *because of*.
  predicted_net_annual_pct REAL NOT NULL,
  -- All four NULL while the position is open. NULL is "still running", never
  -- "closed at zero" — the distinction the whole realized-vs-predicted series
  -- depends on.
  close_ts              INTEGER,
  -- 'max_hold' | 'rate_below_exit' | 'stale_data' | 'manual'.
  close_reason          TEXT,
  realized_pnl_usdt     REAL,
  realized_annual_pct   REAL
);

-- The two reads this table has: "every open position" (every funding poll, to
-- accrue and to evaluate closes) and "the newest closed ones" (the dashboard and
-- the realized-vs-predicted summary). Both are `status` first, then recency.
CREATE INDEX IF NOT EXISTS idx_funding_positions_status_ts
  ON funding_positions (status, entry_ts DESC);
