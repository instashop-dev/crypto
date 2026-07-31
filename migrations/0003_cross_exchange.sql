-- Phase 9: cross-exchange spread monitor + paper arb.
--
-- Purely additive, like 0002. Every existing row is a triangular one, so the
-- new `strategy` columns default to 'triangular' rather than being back-filled
-- or left NULL: a pre-feature row is not "unknown strategy", it is known to be
-- a triangle, and a NOT NULL default says so without a data migration.
--
-- SQLite only supports one ADD COLUMN per ALTER TABLE, hence the shape below.

-- Which scanner produced the row: 'triangular' or 'cross_exchange'. Kept as
-- free TEXT rather than a CHECK constraint so a future strategy needs no
-- migration of the constraint itself; src/config.ts owns the vocabulary.
ALTER TABLE opportunities ADD COLUMN strategy TEXT NOT NULL DEFAULT 'triangular';
ALTER TABLE trades        ADD COLUMN strategy TEXT NOT NULL DEFAULT 'triangular';

-- Per-scan cross-exchange outcome. Deliberately *separate* columns rather than
-- reuse of triangles_count / best_net_pct: the two strategies scan different
-- universes and a single "best" mixing them would be meaningless to compare
-- across scans, and would silently rewrite the meaning of every historical row.
ALTER TABLE scans ADD COLUMN spreads_count       INTEGER NOT NULL DEFAULT 0;
-- NULL when no spread could be priced -- "none found", not "found a zero".
ALTER TABLE scans ADD COLUMN best_spread_net_pct REAL;
-- Cross-exchange failures land here, never in `scans.error`. `error` keeps its
-- meaning of "the scan itself failed"; a missing second venue is a degraded
-- scan, not a failed one, and conflating them would make the dashboard's error
-- badge fire on every scan where MEXC was slow.
ALTER TABLE scans ADD COLUMN xchg_error          TEXT;

-- Both history tables are now read "newest first, filtered by strategy", which
-- these cover; the unfiltered idx_*_ts indexes stay for the unfiltered reads.
CREATE INDEX IF NOT EXISTS idx_opportunities_strategy_ts ON opportunities (strategy, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_strategy_ts        ON trades (strategy, ts DESC);
