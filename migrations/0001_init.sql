-- Phase 4 schema for the paper-trading triangular-arbitrage MVP.
-- See docs/superpowers/specs/2026-07-30-crypto-arb-design.md ("D1 schema").
--
-- No seed rows live here on purpose: seeding is code-driven (`ensureSeeded` in
-- src/db.ts) so that a fresh database and `POST /api/reset` converge on exactly
-- the same state through exactly the same path.

-- Paper balances. Only USDT is ever held between cycles (every triangle starts
-- and ends at the base asset), but the table is per-asset so partial-fill
-- modelling can be added later without a migration.
CREATE TABLE IF NOT EXISTS balances (
  asset  TEXT PRIMARY KEY,
  amount REAL NOT NULL DEFAULT 0
);

-- Cached tradable markets, rebuilt by POST /api/admin/refresh-pairs. Avoids
-- fetching Binance's ~17MB exchangeInfo on the scan path.
CREATE TABLE IF NOT EXISTS pairs (
  symbol     TEXT PRIMARY KEY,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  source     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Scans. One row per runScan() invocation, written even when the scan fails so
-- that outages are visible in the history rather than silently absent.
CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  trigger         TEXT NOT NULL,
  source          TEXT,
  pairs_count     INTEGER NOT NULL DEFAULT 0,
  triangles_count INTEGER NOT NULL DEFAULT 0,
  best_net_pct    REAL,
  executed_count  INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

-- Top-ranked cycles of each scan (top 10 persisted).
CREATE TABLE IF NOT EXISTS opportunities (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id   INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  cycle     TEXT NOT NULL,
  gross_pct REAL NOT NULL,
  net_pct   REAL NOT NULL,
  executed  INTEGER NOT NULL DEFAULT 0,
  legs_json TEXT NOT NULL
);

-- Simulated executions. At most one per scan.
CREATE TABLE IF NOT EXISTS trades (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  cycle          TEXT NOT NULL,
  start_amount   REAL NOT NULL,
  end_amount     REAL NOT NULL,
  profit         REAL NOT NULL,
  profit_pct     REAL NOT NULL,
  legs_json      TEXT NOT NULL,
  source         TEXT,
  opportunity_id INTEGER
);

-- Tunables (fee_rate, min_profit_pct, trade_size_usdt, initial_usdt) plus the
-- best-effort `scan_lock` marker. Values are TEXT; src/db.ts parses and merges
-- them over the compiled-in DEFAULTS.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- History reads are always "newest first, bounded" or "everything for one
-- scan", which is exactly what these cover.
CREATE INDEX IF NOT EXISTS idx_opportunities_scan_id ON opportunities (scan_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_ts ON opportunities (ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades (ts DESC);
CREATE INDEX IF NOT EXISTS idx_scans_ts ON scans (ts DESC);
