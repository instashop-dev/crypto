-- Phase 8: India-mode P&L (VDA tax: 1% TDS u/s 194S + 30% u/s 115BBH).
--
-- Purely additive. Every column has a default (or is nullable) so the rows
-- written before this migration stay valid and readable: a pre-feature trade
-- simply carries zero tax and a NULL `net_profit`, which `toTrade` reads back
-- as "net profit == gross profit". Nothing is back-filled, because the rates in
-- force at the time of a historical fill are not knowable after the fact.
--
-- SQLite only supports one ADD COLUMN per ALTER TABLE, hence the one-per-line
-- shape below.

-- The USDT value of every asset disposed of by the cycle -- the 194S tax base.
-- All three legs are disposals of a VDA (USDT is itself a VDA), so this is
-- roughly 3x the notional, not 1x.
ALTER TABLE trades ADD COLUMN tds_base     REAL NOT NULL DEFAULT 0;
-- tds_rate * tds_base: cash withheld at source. A prepayment, not an expense.
ALTER TABLE trades ADD COLUMN tds_withheld REAL NOT NULL DEFAULT 0;
-- tax_rate * max(profit, 0): 115BBH allows no loss offset, so a losing cycle
-- still owes nothing and a winning one cannot be netted against it.
ALTER TABLE trades ADD COLUMN tax_due      REAL NOT NULL DEFAULT 0;
-- profit - tax_due. NULL for rows written before this migration; readers fall
-- back to `profit`, which is exactly right for a zero-tax world.
ALTER TABLE trades ADD COLUMN net_profit   REAL;
-- The rates actually applied, snapshotted per trade. Re-deriving them from the
-- current settings would silently rewrite history the moment an operator
-- retunes the rate, so they are stored with the fill.
ALTER TABLE trades ADD COLUMN tds_rate     REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN tax_rate     REAL NOT NULL DEFAULT 0;

-- Opportunity-level, per unit of notional. NULL (not 0) when india mode was off
-- for the scan, so "not measured" stays distinguishable from "measured as zero".
ALTER TABLE opportunities ADD COLUMN india_net_pct REAL;
ALTER TABLE opportunities ADD COLUMN tds_pct       REAL;
