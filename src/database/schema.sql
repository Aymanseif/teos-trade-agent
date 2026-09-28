-- ===========================================================================
-- TEOS TRADE AGENT - Phase 1 schema
--
-- Design notes
--  * Every table that belongs to an account carries a `mode` column whose
--    CHECK constraint permits only BACKTEST and PAPER. LIVE cannot be written
--    even if the application-level gate were bypassed.
--  * Audit tables (agent_decisions, risk_decisions, sentinel_decisions,
--    orders) are append-only from the application's point of view and carry
--    prev_hash / record_hash to form a tamper-evident SHA-256 chain.
--  * Executed decisions are immutable: they are written once and never
--    updated. Corrections are expressed as additional events.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id   TEXT NOT NULL,
  strategy_id   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('STARTING','RUNNING','STOPPING','STOPPED','FAILED')),
  starting_capital_egp REAL NOT NULL,
  config_json   TEXT NOT NULL,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS system_events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id  TEXT NOT NULL,
  ts           TEXT NOT NULL,
  ts_ms        INTEGER NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR','FATAL')),
  category     TEXT NOT NULL,
  message      TEXT NOT NULL,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_mode_ts ON system_events(mode, ts_ms DESC);
CREATE INDEX IF NOT EXISTS ix_events_level   ON system_events(mode, level, ts_ms DESC);

-- ---------------- market data ----------------
CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_id  TEXT PRIMARY KEY,
  run_id       TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  symbol       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  ts_ms        INTEGER NOT NULL,
  bid          REAL NOT NULL,
  ask          REAL NOT NULL,
  last         REAL NOT NULL,
  mid          REAL NOT NULL,
  spread_bps   REAL NOT NULL,
  source       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  is_stale     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_snapshots_sym_ts ON market_snapshots(mode, symbol, ts_ms DESC);

-- ---------------- agent ----------------
CREATE TABLE IF NOT EXISTS agent_decisions (
  decision_id              TEXT PRIMARY KEY,
  run_id                   TEXT,
  mode                     TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id              TEXT NOT NULL,
  ts                       TEXT NOT NULL,
  ts_ms                    INTEGER NOT NULL,
  symbol                   TEXT NOT NULL,
  strategy_id              TEXT NOT NULL,
  price                    REAL NOT NULL,
  signal                   TEXT NOT NULL CHECK (signal IN ('BUY','SELL','HOLD')),
  quantity                 REAL NOT NULL DEFAULT 0,
  notional_egp             REAL NOT NULL DEFAULT 0,
  confidence               REAL NOT NULL DEFAULT 0,
  max_loss_egp             REAL NOT NULL DEFAULT 0,
  stop_price               REAL,
  stop_distance_pct        REAL,
  risk_reward_ratio        REAL,
  reason                   TEXT NOT NULL,
  features_json            TEXT NOT NULL,
  expected_execution_price REAL,
  stop_condition           TEXT,
  action                   TEXT NOT NULL CHECK (action IN ('PLACE_ORDER','SKIP','QUARANTINE','REJECT','HALT')),
  agent_state              TEXT NOT NULL,
  prev_hash                TEXT,
  record_hash              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_mode_ts ON agent_decisions(mode, ts_ms DESC);
CREATE INDEX IF NOT EXISTS ix_decisions_symbol ON agent_decisions(mode, symbol, ts_ms DESC);

-- ---------------- risk ----------------
CREATE TABLE IF NOT EXISTS risk_decisions (
  risk_decision_id TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL,
  run_id           TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id      TEXT NOT NULL,
  ts               TEXT NOT NULL,
  ts_ms            INTEGER NOT NULL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('ALLOW','WARN','REVIEW','BLOCK')),
  blocked          INTEGER NOT NULL,
  reason           TEXT,
  failed_rule      TEXT,
  passed_count     INTEGER NOT NULL,
  failed_count     INTEGER NOT NULL,
  rules_json       TEXT NOT NULL,
  account_json     TEXT NOT NULL,
  limits_json      TEXT NOT NULL,
  prev_hash        TEXT,
  record_hash      TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES agent_decisions(decision_id)
);
CREATE INDEX IF NOT EXISTS ix_risk_mode_ts ON risk_decisions(mode, ts_ms DESC);
CREATE INDEX IF NOT EXISTS ix_risk_decision ON risk_decisions(decision_id);

-- ---------------- sentinel ----------------
CREATE TABLE IF NOT EXISTS sentinel_decisions (
  sentinel_decision_id TEXT PRIMARY KEY,
  decision_id          TEXT NOT NULL,
  risk_decision_id     TEXT,
  run_id               TEXT,
  mode                 TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id          TEXT NOT NULL,
  ts                   TEXT NOT NULL,
  ts_ms                INTEGER NOT NULL,
  verdict              TEXT NOT NULL CHECK (verdict IN ('ALLOW','WARN','REVIEW','BLOCK')),
  action_taken         TEXT NOT NULL CHECK (action_taken IN ('PASS','PASS_WITH_WARNING','QUARANTINE','REJECT')),
  reason               TEXT,
  trigger_rule         TEXT,
  policy_version       TEXT NOT NULL,
  rules_json           TEXT NOT NULL,
  threshold_json       TEXT NOT NULL,
  prev_hash            TEXT,
  record_hash          TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES agent_decisions(decision_id)
);
CREATE INDEX IF NOT EXISTS ix_sentinel_mode_ts ON sentinel_decisions(mode, ts_ms DESC);

-- ---------------- execution ----------------
CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,
  client_order_id     TEXT NOT NULL UNIQUE,
  decision_id         TEXT NOT NULL,
  risk_decision_id    TEXT,
  sentinel_decision_id TEXT,
  run_id              TEXT,
  mode                TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id         TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  side                TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  order_type          TEXT NOT NULL CHECK (order_type IN ('MARKET','LIMIT')),
  quantity            REAL NOT NULL,
  limit_price         REAL,
  expected_price      REAL NOT NULL,
  filled_quantity     REAL NOT NULL DEFAULT 0,
  avg_fill_price      REAL,
  status              TEXT NOT NULL CHECK (status IN
                        ('PENDING_NEW','NEW','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED','EXPIRED','UNKNOWN')),
  -- The status the order was submitted with. Immutable, and covered by the
  -- audit chain, so a later lifecycle update can never rewrite what was
  -- actually submitted.
  status_at_submit    TEXT NOT NULL,
  reduce_only         INTEGER NOT NULL DEFAULT 0,
  leverage_requested  INTEGER NOT NULL DEFAULT 0,
  submitted_at        TEXT NOT NULL,
  submitted_ms        INTEGER NOT NULL,
  updated_at          TEXT NOT NULL,
  terminal_at         TEXT,
  rejection_reason    TEXT,
  prev_hash           TEXT,
  record_hash         TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES agent_decisions(decision_id)
);
CREATE INDEX IF NOT EXISTS ix_orders_mode_ts  ON orders(mode, submitted_ms DESC);
CREATE INDEX IF NOT EXISTS ix_orders_status   ON orders(mode, status);
CREATE INDEX IF NOT EXISTS ix_orders_symbol   ON orders(mode, symbol, submitted_ms DESC);
CREATE INDEX IF NOT EXISTS ix_orders_decision ON orders(decision_id);

CREATE TABLE IF NOT EXISTS fills (
  fill_id        TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  decision_id    TEXT,
  run_id         TEXT,
  mode           TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity       REAL NOT NULL,
  price          REAL NOT NULL,
  reference_price REAL NOT NULL,
  notional_egp   REAL NOT NULL,
  fee_egp        REAL NOT NULL,
  slippage_bps   REAL NOT NULL,
  slippage_cost_egp REAL NOT NULL,
  liquidity      TEXT NOT NULL CHECK (liquidity IN ('MAKER','TAKER')),
  ts             TEXT NOT NULL,
  ts_ms          INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);
CREATE INDEX IF NOT EXISTS ix_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS ix_fills_mode_ts ON fills(mode, ts_ms DESC);

-- ---------------- portfolio state (append-only history + current projection) ----------------
CREATE TABLE IF NOT EXISTS positions (
  position_id       TEXT PRIMARY KEY,
  run_id            TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  symbol            TEXT NOT NULL,
  quantity          REAL NOT NULL,
  avg_entry_price   REAL NOT NULL,
  realized_pnl_egp  REAL NOT NULL DEFAULT 0,
  fees_paid_egp     REAL NOT NULL DEFAULT 0,
  slippage_cost_egp REAL NOT NULL DEFAULT 0,
  opened_at         TEXT NOT NULL,
  opened_ms         INTEGER NOT NULL,
  updated_at        TEXT NOT NULL,
  closed_at         TEXT,
  status            TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED'))
);
CREATE INDEX IF NOT EXISTS ix_positions_mode_status ON positions(mode, status);

CREATE TABLE IF NOT EXISTS balances (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT,
  mode               TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  ts                 TEXT NOT NULL,
  ts_ms              INTEGER NOT NULL,
  cash_egp           REAL NOT NULL,
  equity_egp         REAL NOT NULL,
  exposure_egp       REAL NOT NULL,
  realized_pnl_egp   REAL NOT NULL,
  unrealized_pnl_egp REAL NOT NULL,
  total_pnl_egp      REAL NOT NULL,
  open_positions     INTEGER NOT NULL,
  fees_paid_egp      REAL NOT NULL,
  slippage_cost_egp  REAL NOT NULL,
  reason             TEXT
);
CREATE INDEX IF NOT EXISTS ix_balances_mode_ts ON balances(mode, ts_ms DESC);

CREATE TABLE IF NOT EXISTS pnl_events (
  pnl_event_id TEXT PRIMARY KEY,
  run_id       TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  symbol       TEXT,
  position_id  TEXT,
  order_id     TEXT,
  fill_id      TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('REALIZED','UNREALIZED','FEE','SLIPPAGE')),
  amount_egp   REAL NOT NULL,
  ts           TEXT NOT NULL,
  ts_ms        INTEGER NOT NULL,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS ix_pnl_mode_ts ON pnl_events(mode, ts_ms DESC);

CREATE TABLE IF NOT EXISTS equity_curve (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  ts              TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  equity_egp      REAL NOT NULL,
  cash_egp        REAL NOT NULL,
  exposure_egp    REAL NOT NULL,
  peak_equity_egp REAL NOT NULL,
  drawdown_egp    REAL NOT NULL,
  drawdown_pct    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_equity_mode_ts ON equity_curve(mode, ts_ms);

-- ---------------- safety state ----------------
CREATE TABLE IF NOT EXISTS emergency_stops (
  stop_id     TEXT PRIMARY KEY,
  run_id      TEXT,
  mode        TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id TEXT NOT NULL,
  ts          TEXT NOT NULL,
  ts_ms       INTEGER NOT NULL,
  trigger     TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('WARNING','CRITICAL','CATASTROPHIC')),
  scope       TEXT NOT NULL CHECK (scope IN ('NEW_ORDERS','HALT_ALL')),
  reason      TEXT NOT NULL,
  details_json TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  cleared_at  TEXT,
  cleared_by  TEXT
);
CREATE INDEX IF NOT EXISTS ix_stops_active ON emergency_stops(mode, active);

CREATE TABLE IF NOT EXISTS control_flags (
  flag       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  reason     TEXT,
  PRIMARY KEY (flag, mode)
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id      TEXT NOT NULL,
  ts               TEXT NOT NULL,
  ts_ms            INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('STARTING','HEALTHY','DEGRADED','HALTED','STOPPED','FAILED')),
  agent_state      TEXT NOT NULL,
  pid              INTEGER NOT NULL,
  host             TEXT NOT NULL,
  version          TEXT NOT NULL,
  uptime_ms        INTEGER NOT NULL,
  tick_count       INTEGER NOT NULL,
  decision_count   INTEGER NOT NULL,
  order_count      INTEGER NOT NULL,
  error_count      INTEGER NOT NULL,
  last_decision_id TEXT,
  last_error       TEXT
);
CREATE INDEX IF NOT EXISTS ix_hb_instance ON worker_heartbeats(mode, instance_id, ts_ms DESC);

CREATE TABLE IF NOT EXISTS restarts (
  restart_id        TEXT PRIMARY KEY,
  run_id            TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  previous_instance TEXT,
  new_instance      TEXT NOT NULL,
  ts                TEXT NOT NULL,
  ts_ms             INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('COLD_START','RESUME','CRASH_RECOVERY')),
  reason            TEXT NOT NULL,
  orphaned_orders   INTEGER NOT NULL DEFAULT 0,
  recovery_json     TEXT,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS ix_restarts_mode_ts ON restarts(mode, ts_ms DESC);

-- ---------------- backtest ----------------
CREATE TABLE IF NOT EXISTS backtest_runs (
  backtest_id          TEXT PRIMARY KEY,
  run_id               TEXT,
  mode                 TEXT NOT NULL CHECK (mode = 'BACKTEST'),
  strategy_id          TEXT NOT NULL,
  strategy_json        TEXT NOT NULL,
  params_json          TEXT NOT NULL,
  from_ts              TEXT NOT NULL,
  to_ts                TEXT NOT NULL,
  bars                 INTEGER NOT NULL,
  initial_equity_egp   REAL NOT NULL,
  final_equity_egp     REAL NOT NULL,
  status               TEXT NOT NULL,
  metrics_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_id      TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL,
  entry_ts         TEXT NOT NULL,
  entry_price      REAL NOT NULL,
  exit_ts          TEXT,
  exit_price       REAL,
  quantity         REAL NOT NULL,
  pnl_egp          REAL,
  fees_egp         REAL NOT NULL DEFAULT 0,
  reason_in        TEXT,
  reason_out       TEXT,
  exit_reason      TEXT
);
CREATE INDEX IF NOT EXISTS ix_bt_trades ON backtest_trades(backtest_id);

-- ---------------- lifecycle / health ----------------
CREATE TABLE IF NOT EXISTS agent_state_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,
  mode        TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER')),
  instance_id TEXT NOT NULL,
  ts          TEXT NOT NULL,
  ts_ms       INTEGER NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS ix_state_log_mode_ts ON agent_state_log(mode, ts_ms DESC);
