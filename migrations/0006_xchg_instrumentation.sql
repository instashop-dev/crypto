-- Phase 16: cross-exchange honesty instrumentation.
--
-- Additive, like 0002 and 0003, and for the same reason: every column below is
-- a *measurement of* the spread rows, never a change to how one is priced. The
-- `net_pct` on a row written yesterday means exactly what it meant yesterday.
--
-- All three are NULLable with no default, which is the india-column convention
-- (0002) rather than an oversight: **NULL means "not measured"**, and that is a
-- different claim from "measured as zero". Every row written before this
-- migration is genuinely unmeasured, and a `DEFAULT 0` here would have asserted
-- a perfectly-simultaneous snapshot and a perfectly-dead spread for the entire
-- history.
--
-- SQLite only supports one ADD COLUMN per ALTER TABLE, hence the shape below.
-- No index is added: the one new read (`strategy = 'cross_exchange' AND
-- persist_checked_ts IS NULL` over a short recent window) is served by
-- `idx_opportunities_strategy_ts` from 0003, and it touches a handful of rows
-- per scan.

-- Distance in milliseconds between the two books a spread was priced from:
-- |mexcRestCompletedAt - wsWindowEndedAt|. The Binance side is a WebSocket
-- snapshot accumulated over up to ~4s and the MEXC side is one REST response,
-- so the two are never simultaneous — and `src/engine/crossExchange.ts` has
-- named that skew the dominant false positive since Phase 9 without anyone ever
-- putting a number on it. This column is that number. It cannot be reconstructed
-- after the fact, which is why it is stored rather than derived.
ALTER TABLE opportunities ADD COLUMN skew_ms INTEGER;

-- The same trade, same direction, re-priced against the *next* scan's snapshot:
-- did the edge outlive the skew that may have invented it? NULL after
-- `persist_checked_ts` is set means the row expired before any fresh snapshot
-- could price it (the scanner was down, or a venue was), which is deliberately
-- distinguishable from "re-priced and found to be -0.4%".
ALTER TABLE opportunities ADD COLUMN persist_net_pct REAL;

-- When the re-price above was attempted. Written exactly once per row, whether
-- or not a figure came out of it, so a row is only ever measured once and the
-- query that finds work to do is `persist_checked_ts IS NULL`.
ALTER TABLE opportunities ADD COLUMN persist_checked_ts INTEGER;
