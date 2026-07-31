-- Phase 17: OKX dated-futures basis board (R4), observation-only.
--
-- Additive, like 0002 through 0006: not one existing table or column is
-- touched. `scans` gains nothing — a basis failure lives only in the in-memory
-- `ScanResult.basisError` and is never written to `scans.error`, for exactly the
-- reason a funding or a carry failure is not: a scan whose spread board and
-- funding board both landed did not fail because a futures endpoint was slow.
--
-- **Observation only.** There is deliberately no positions table here, and the
-- symmetry with 0004 is intentional: funding was introduced as a board and only
-- grew paper positions two phases later, once there was a recorded series worth
-- holding against. The basis board starts in the same place. The schema is
-- shaped so a later `basis_positions` table would be a pure addition rather than
-- a rewrite of these rows.
--
-- **Why a table at all, when cross-venue funding spreads (Phase 16) are derived
-- at read time and stored nowhere.** A venue spread is a pure function of rows
-- already on disk, so storing it would freeze a stale answer. A basis is not: it
-- is a *pair of prices*, and the spot side of that pair is fetched from an
-- endpoint nothing else in this app reads and is kept nowhere. Re-deriving
-- tomorrow what today's futures curve looked like against today's spot is
-- impossible without recording both, so both are recorded.

CREATE TABLE IF NOT EXISTS basis_rates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL for a manual poll outside a scan, mirroring `funding_rates.scan_id`.
  scan_id         INTEGER,
  ts              INTEGER NOT NULL,
  -- 'okx'. Free TEXT rather than a CHECK constraint, exactly as `venue` on
  -- `funding_rates` is: src/basis.ts owns the vocabulary, so a second venue
  -- needs no migration of a constraint.
  venue           TEXT NOT NULL,
  -- The asset ('BTC'), normalised the same way `funding_rates.symbol` is, so a
  -- report can put the two strategies' rows side by side...
  symbol          TEXT NOT NULL,
  -- ...and the venue's own contract name ('BTC-USD_UM-260925'), which is what
  -- someone reproducing the row has to paste into OKX's UI. Unlike the funding
  -- board, one symbol has *several* live contracts at once — the whole curve —
  -- so (ts, symbol) is not unique here and the instrument is what distinguishes
  -- the rows.
  instrument      TEXT NOT NULL,
  -- Settlement, at 08:00 UTC on the date in the instId. Stored rather than
  -- re-parsed on read: the contract is delisted after it settles, so a row
  -- outliving its contract would otherwise become unreadable.
  expiry_ts       INTEGER NOT NULL,
  -- Remaining life at poll time, in days. Snapshotted because it is the divisor
  -- in both derived percentages below and it changes every minute; recomputing
  -- it on read would silently re-annualise history against today's clock.
  days_to_expiry  REAL NOT NULL,
  -- Both legs' marks, at the mid of the book (or the last trade when a side of
  -- the book was empty). Stored so a figure can be checked back to the prices it
  -- came from without re-fetching a board that no longer exists.
  spot_price      REAL NOT NULL,
  future_price    REAL NOT NULL,
  -- 'mid' when BOTH legs came from a two-sided book, 'last' when either fell
  -- back to the last trade. Stored per row for the same reason
  -- `funding_rates.interval_source` is: it is part of what the row *means*, not
  -- something inferable at read time. It matters most on exactly the contracts
  -- this board is worst at — a thin far-dated future can have one side of its
  -- book empty for minutes while an old trade still prints, and a stale mark is
  -- precisely what produces a spuriously fat basis that then sorts to the top.
  price_source    TEXT NOT NULL,
  -- future/spot - 1, in percent. Negative (backwardation) is a valid
  -- observation and is stored as-is, never clamped: the reverse carry is what
  -- harvests it.
  basis_pct       REAL NOT NULL,
  -- The two derived figures, snapshotted for the same reason `funding_rates`
  -- snapshots its own: they depend on `fee_rate` and `perp_fee_rate`, and
  -- re-deriving them from today's settings would rewrite history on the next
  -- retune. (The `qualifies` flag the API reports is the opposite case — a
  -- *current* judgement about a stored row, so it is computed at read time.)
  annualized_pct  REAL NOT NULL,
  net_annual_pct  REAL NOT NULL
);

-- The three reads this table has, mirroring `funding_rates`: "the newest board"
-- (a MAX(ts) equality), "everything one poll wrote" and the report's windowed
-- GROUP BY ts.
CREATE INDEX IF NOT EXISTS idx_basis_rates_ts      ON basis_rates (ts DESC);
CREATE INDEX IF NOT EXISTS idx_basis_rates_scan_id ON basis_rates (scan_id);
-- One contract's history: the series a later phase would need to see a basis
-- decay toward zero as its contract approaches settlement.
CREATE INDEX IF NOT EXISTS idx_basis_rates_instrument_ts
  ON basis_rates (instrument, ts DESC);

-- `GET /api/report` groups `funding_rates` by (venue, ts) over a 7-day window.
-- `idx_funding_rates_ts` from 0004 already bounds that scan to the window, which
-- is the expensive half; the per-venue grouping is then a sort over rows already
-- fetched. No new index is added for it, deliberately: the table takes ~2000
-- inserts an hour and every index is paid on every one of them, so an index that
-- serves one read a day would cost more than it saves.
