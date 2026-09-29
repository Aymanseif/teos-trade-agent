/**
 * TEOS Trade Agent - database/repositories/index.js
 *
 * Single place where SQL touches tables. Everything takes an explicit `mode`
 * so a BACKTEST process physically cannot read or write PAPER rows.
 *
 * Append-only tables (agent_decisions, risk_decisions, sentinel_decisions,
 * orders, fills, pnl_events) expose insert/query only. There is deliberately
 * no update or delete function for them.
 */

import { newId } from '../../core/ids.js';
import { STREAMS } from '../audit-chain.js';

const J = (v) => (v === undefined ? null : JSON.stringify(v));
const P = (v) => {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch { return null; }
};

export class Repos {
  constructor(db, chain, { mode, runId = null, instanceId = 'unknown' }) {
    this.db = db;
    this.chain = chain;
    this.mode = mode;
    this.runId = runId;
    this.instanceId = instanceId;
  }

  setRun(runId, instanceId) {
    this.runId = runId;
    if (instanceId) this.instanceId = instanceId;
    return this;
  }

  /**
   * Write a sealed row, and re-synchronise the audit chain if the write fails.
   *
   * `chain.seal()` advances an in-memory cursor BEFORE the row reaches the
   * database, because the hash has to exist before the row that carries it. A
   * write that is then refused - a duplicate primary key, a foreign key, a
   * full disk - therefore leaves the cursor pointing at a hash that was never
   * stored, and every later record links to that phantom. The database is
   * untouched and completely intact, yet `verify()` reports
   * "prev_hash mismatch (record removed or reordered)" from then on, for the
   * rest of the process.
   *
   * That is the one failure mode a tamper-evident log must never produce: a
   * chain that always reports "broken" is worse than no chain at all, because
   * it trains the operator to ignore it. Dropping the cursor cache makes the
   * next `seal()` re-read the last genuinely stored hash, which is what a fresh
   * process would do anyway. Correctness wins over the saved query.
   */
  #writeSealed(sql, ...params) {
    try {
      return this.db.run(sql, ...params);
    } catch (err) {
      this.chain.reset();
      throw err;
    }
  }

  // ------------------------------------------------------------------ runs
  createRun({ runId = newId('run'), mode = this.mode, instanceId = this.instanceId, strategyId, startingCapitalEgp, config, clock, notes = null }) {
    this.db.run(
      `INSERT INTO runs (run_id, mode, instance_id, strategy_id, started_at, status, starting_capital_egp, config_json, notes)
       VALUES (?,?,?,?,?,'RUNNING',?,?,?)`,
      runId, mode, instanceId, strategyId, clock.nowIso(), startingCapitalEgp, J(config), notes,
    );
    return runId;
  }

  updateRunStatus(runId, status, clock) {
    this.db.run('UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?', status, clock.nowIso(), runId);
  }

  latestRun(mode = this.mode) {
    return this.db.get(
      `SELECT * FROM runs WHERE mode = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`, mode,
    );
  }

  // --------------------------------------------------------- system events
  logEvent({ level = 'INFO', category, message, details = null, clock, instanceId = this.instanceId, mode = this.mode }) {
    const id = newId('evt');
    this.db.run(
      `INSERT INTO system_events (event_id, run_id, mode, instance_id, ts, ts_ms, level, category, message, details_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, this.runId, mode, instanceId, clock.nowIso(), clock.now(), level, category, message, J(details),
    );
    return id;
  }

  listEvents({ limit = 200, level = null, category = null, mode = this.mode } = {}) {
    let sql = `SELECT * FROM system_events WHERE mode = ?`;
    const p = [mode];
    if (level) { sql += ' AND level = ?'; p.push(level); }
    if (category) { sql += ' AND category = ?'; p.push(category); }
    sql += ' ORDER BY ts_ms DESC, rowid DESC LIMIT ?';
    p.push(limit);
    return this.db.all(sql, ...p).map((r) => ({ ...r, details: P(r.details_json) }));
  }

  countErrors(mode = this.mode) {
    return this.db.count(
      `SELECT COUNT(*) AS c FROM system_events WHERE mode = ? AND level IN ('ERROR','FATAL')`, mode,
    );
  }

  // ----------------------------------------------------- market snapshots
  recordSnapshot({ symbol, bid, ask, last, mid, spreadBps, source, seq, isStale = false, clock, mode = this.mode }) {
    const id = newId('snap');
    this.db.run(
      `INSERT INTO market_snapshots (snapshot_id, run_id, mode, symbol, ts, ts_ms, bid, ask, last, mid, spread_bps, source, seq, is_stale)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, this.runId, mode, symbol, clock.nowIso(), clock.now(), bid, ask, last, mid, spreadBps, source, seq, isStale,
    );
    return id;
  }

  latestSnapshots(mode = this.mode) {
    return this.db.all(
      `SELECT s.* FROM market_snapshots s
       JOIN (SELECT symbol, MAX(rowid) AS r FROM market_snapshots WHERE mode = ? GROUP BY symbol) t
         ON s.rowid = t.r
       WHERE s.mode = ?
       ORDER BY s.symbol`,
      mode, mode,
    );
  }

  /**
   * The previous stored price for a symbol, used to prove price sanity.
   *
   * `runId` must be supplied in BACKTEST. Every run replays from the same
   * fixed epoch, so an unscoped query returns the *previous run's* price at the
   * identical timestamp - the same seed then produced two different results
   * depending on what had been run before it, which defeats the entire point of
   * a seeded replay.
   */
  lastSnapshotBefore(symbol, tsMs, mode = this.mode, runId = null) {
    if (runId) {
      return this.db.get(
        `SELECT * FROM market_snapshots WHERE mode = ? AND run_id = ? AND symbol = ? AND ts_ms <= ?
         ORDER BY ts_ms DESC, rowid DESC LIMIT 1`,
        mode, runId, symbol, tsMs,
      );
    }
    return this.db.get(
      `SELECT * FROM market_snapshots WHERE mode = ? AND symbol = ? AND ts_ms <= ? ORDER BY ts_ms DESC, rowid DESC LIMIT 1`,
      mode, symbol, tsMs,
    );
  }

  /**
   * The run scope a BACKTEST read must use, or null in PAPER.
   *
   * PAPER deliberately shares one database across restarts, so its reads span
   * every run of the mode: a resumed worker needs to see the whole history. A
   * BACKTEST run is an isolated experiment sharing a file with other backtests,
   * and must see only its own rows or it is not reproducible.
   */
  get decisionScopeRunId() {
    return this.mode === 'BACKTEST' ? this.runId : null;
  }

  // ------------------------------------------------- agent decisions
  /** IMMUTABLE append. Returns the sealed record. */
  insertDecision(d, clock) {
    const record = {
      decision_id: d.decisionId, run_id: this.runId, mode: this.mode, instance_id: this.instanceId,
      ts: clock.nowIso(), ts_ms: clock.now(), symbol: d.symbol, strategy_id: d.strategyId,
      price: d.price, signal: d.signal, quantity: d.quantity, notional_egp: d.notionalEgp,
      confidence: d.confidence, max_loss_egp: d.maxLossEgp, stop_price: d.stopPrice,
      stop_distance_pct: d.stopDistancePct, risk_reward_ratio: d.riskRewardRatio,
      reason: d.reason, features_json: J(d.features), expected_execution_price: d.expectedExecutionPrice,
      stop_condition: d.stopCondition, action: d.action, agent_state: d.agentState,
    };
    const sealed = this.chain.seal(STREAMS.DECISION, this.mode, record);
    this.#writeSealed(
      `INSERT INTO agent_decisions
        (decision_id, run_id, mode, instance_id, ts, ts_ms, symbol, strategy_id, price, signal, quantity,
         notional_egp, confidence, max_loss_egp, stop_price, stop_distance_pct, risk_reward_ratio, reason,
         features_json, expected_execution_price, stop_condition, action, agent_state, prev_hash, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sealed.decision_id, sealed.run_id, sealed.mode, sealed.instance_id, sealed.ts, sealed.ts_ms,
      sealed.symbol, sealed.strategy_id, sealed.price, sealed.signal, sealed.quantity, sealed.notional_egp,
      sealed.confidence, sealed.max_loss_egp, sealed.stop_price, sealed.stop_distance_pct, sealed.risk_reward_ratio,
      sealed.reason, sealed.features_json, sealed.expected_execution_price, sealed.stop_condition,
      sealed.action, sealed.agent_state, sealed.prev_hash, sealed.record_hash,
    );
    return sealed;
  }

  getDecision(decisionId) {
    const r = this.db.get('SELECT * FROM agent_decisions WHERE decision_id = ?', decisionId);
    return r ? { ...r, features: P(r.features_json) } : null;
  }

  listDecisions({ limit = 200, symbol = null, mode = this.mode } = {}) {
    let sql = `SELECT decision_id, run_id, ts, ts_ms, symbol, strategy_id, price, signal, quantity, notional_egp,
                      confidence, max_loss_egp, stop_price, stop_distance_pct, risk_reward_ratio, reason,
                      expected_execution_price, stop_condition, action, agent_state
               FROM agent_decisions WHERE mode = ?`;
    const p = [mode];
    if (symbol) { sql += ' AND symbol = ?'; p.push(symbol); }
    sql += ' ORDER BY ts_ms DESC, rowid DESC LIMIT ?';
    p.push(limit);
    return this.db.all(sql, ...p);
  }

  /** `runId` narrows the count to one run; omit it for a whole-mode total. */
  countDecisions(mode = this.mode, runId = null) {
    if (runId) {
      return this.db.count('SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ? AND run_id = ?', mode, runId);
    }
    return this.db.count('SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ?', mode);
  }

  // ------------------------------------------------- risk decisions
  insertRiskDecision(r, clock) {
    const record = {
      risk_decision_id: r.riskDecisionId, decision_id: r.decisionId, run_id: this.runId, mode: this.mode,
      instance_id: this.instanceId, ts: clock.nowIso(), ts_ms: clock.now(), verdict: r.verdict,
      // Coerced to 0/1 BEFORE sealing. `node:sqlite` stores a bound boolean as
      // an integer, so a raw `true` would hash as `true` and read back as `1` -
      // and the chain would then report tampering on a record nobody touched.
      blocked: r.blocked ? 1 : 0,
      reason: r.reason, failed_rule: r.failedRule, passed_count: r.passedCount,
      failed_count: r.failedCount, rules_json: J(r.rules), account_json: J(r.account), limits_json: J(r.limits),
    };
    const sealed = this.chain.seal(STREAMS.RISK, this.mode, record);
    this.#writeSealed(
      `INSERT INTO risk_decisions
        (risk_decision_id, decision_id, run_id, mode, instance_id, ts, ts_ms, verdict, blocked, reason,
         failed_rule, passed_count, failed_count, rules_json, account_json, limits_json, prev_hash, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sealed.risk_decision_id, sealed.decision_id, sealed.run_id, sealed.mode, sealed.instance_id,
      sealed.ts, sealed.ts_ms, sealed.verdict, sealed.blocked, sealed.reason, sealed.failed_rule,
      sealed.passed_count, sealed.failed_count, sealed.rules_json, sealed.account_json, sealed.limits_json,
      sealed.prev_hash, sealed.record_hash,
    );
    return sealed;
  }

  getRiskDecision(id) {
    const r = this.db.get('SELECT * FROM risk_decisions WHERE risk_decision_id = ?', id);
    return r ? { ...r, rules: P(r.rules_json), account: P(r.account_json), limits: P(r.limits_json) } : null;
  }

  listRiskDecisions({ limit = 200, mode = this.mode } = {}) {
    return this.db.all(
      `SELECT risk_decision_id, decision_id, ts, ts_ms, verdict, blocked, reason, failed_rule, passed_count, failed_count
       FROM risk_decisions WHERE mode = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?`,
      mode, limit,
    );
  }

  // ---------------------------------------------- sentinel decisions
  insertSentinelDecision(s, clock) {
    const record = {
      sentinel_decision_id: s.sentinelDecisionId, decision_id: s.decisionId, risk_decision_id: s.riskDecisionId,
      run_id: this.runId, mode: this.mode, instance_id: this.instanceId, ts: clock.nowIso(), ts_ms: clock.now(),
      verdict: s.verdict, action_taken: s.actionTaken, reason: s.reason, trigger_rule: s.triggerRule,
      policy_version: s.policyVersion, rules_json: J(s.rules), threshold_json: J(s.thresholds),
    };
    const sealed = this.chain.seal(STREAMS.SENTINEL, this.mode, record);
    this.#writeSealed(
      `INSERT INTO sentinel_decisions
        (sentinel_decision_id, decision_id, risk_decision_id, run_id, mode, instance_id, ts, ts_ms, verdict,
         action_taken, reason, trigger_rule, policy_version, rules_json, threshold_json, prev_hash, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sealed.sentinel_decision_id, sealed.decision_id, sealed.risk_decision_id, sealed.run_id, sealed.mode,
      sealed.instance_id, sealed.ts, sealed.ts_ms, sealed.verdict, sealed.action_taken, sealed.reason,
      sealed.trigger_rule, sealed.policy_version, sealed.rules_json, sealed.threshold_json,
      sealed.prev_hash, sealed.record_hash,
    );
    return sealed;
  }

  listSentinelDecisions({ limit = 200, mode = this.mode } = {}) {
    return this.db.all(
      `SELECT sentinel_decision_id, decision_id, risk_decision_id, ts, ts_ms, verdict, action_taken, reason,
              trigger_rule, policy_version
       FROM sentinel_decisions WHERE mode = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?`,
      mode, limit,
    );
  }

  // --------------------------------------------------------- orders
  /**
   * Record the order INTENT. This is the point at which the order becomes
   * immutable and enters the audit chain.
   *
   * What is hashed is the intent only: which decision produced it, and the
   * side, symbol, quantity and price it asked for. The lifecycle columns
   * (`status` after submission, `filled_quantity`, `avg_fill_price`,
   * `updated_at`, `terminal_at`, `rejection_reason`) are NOT hashed - they
   * change legitimately as the order works, and a hash that changes with them
   * proves nothing. See STREAM_COLUMNS in audit-chain.js for the full argument.
   */
  insertOrder(o, clock) {
    const submittedMs = clock.now();
    const submittedAt = clock.nowIso();
    const record = {
      order_id: o.orderId, client_order_id: o.clientOrderId, decision_id: o.decisionId,
      risk_decision_id: o.riskDecisionId, sentinel_decision_id: o.sentinelDecisionId, run_id: this.runId,
      mode: this.mode, instance_id: this.instanceId, symbol: o.symbol, side: o.side, order_type: o.orderType,
      quantity: o.quantity, limit_price: o.limitPrice, expected_price: o.expectedPrice,
      reduce_only: o.reduceOnly ? 1 : 0, leverage_requested: 0,
      submitted_at: submittedAt, submitted_ms: submittedMs,
      status_at_submit: o.status,
    };
    const sealed = this.chain.seal(STREAMS.ORDER, this.mode, record);
    this.#writeSealed(
      `INSERT INTO orders
        (order_id, client_order_id, decision_id, risk_decision_id, sentinel_decision_id, run_id, mode, instance_id,
         symbol, side, order_type, quantity, limit_price, expected_price, filled_quantity, avg_fill_price, status,
         status_at_submit, reduce_only, leverage_requested, submitted_at, submitted_ms, updated_at, terminal_at,
         rejection_reason, prev_hash, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?,0,?,?,?,NULL,?,?,?)`,
      sealed.order_id, sealed.client_order_id, sealed.decision_id, sealed.risk_decision_id,
      sealed.sentinel_decision_id, sealed.run_id, sealed.mode, sealed.instance_id, sealed.symbol, sealed.side,
      sealed.order_type, sealed.quantity, sealed.limit_price, sealed.expected_price, o.status,
      sealed.status_at_submit, sealed.reduce_only, sealed.submitted_at, sealed.submitted_ms, submittedAt,
      o.rejectionReason ?? null, sealed.prev_hash, sealed.record_hash,
    );
    return sealed;
  }

  /**
   * Lifecycle transition for an order. Allowed transitions are enforced here so
   * a bug cannot move an order backwards (e.g. FILLED -> NEW) or resurrect a
   * terminal order. The audit chain link is preserved.
   */
  updateOrderStatus(orderId, { status, filledQuantity = null, avgFillPrice = null, rejectionReason = null, terminal = false, clock }) {
    const cur = this.db.get('SELECT * FROM orders WHERE order_id = ?', orderId);
    if (!cur) throw new Error(`order not found: ${orderId}`);
    const allowed = {
      PENDING_NEW: ['NEW', 'REJECTED', 'CANCELED', 'EXPIRED'],
      NEW: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'],
      PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'UNKNOWN'],
      FILLED: [],
      CANCELED: [],
      REJECTED: [],
      EXPIRED: [],
      UNKNOWN: ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'],
    }[cur.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(`illegal order transition ${cur.status} -> ${status} for ${orderId}`);
    }
    this.db.run(
      `UPDATE orders SET status = ?, filled_quantity = COALESCE(?, filled_quantity),
        avg_fill_price = COALESCE(?, avg_fill_price), updated_at = ?,
        terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END,
        rejection_reason = COALESCE(?, rejection_reason)
       WHERE order_id = ?`,
      status, filledQuantity, avgFillPrice, clock.nowIso(), terminal ? 1 : 0, clock.nowIso(),
      rejectionReason, orderId,
    );
    // The lifecycle is outside the audit hash, so every transition is written
    // to the event log. Without this, a status change would be a change no
    // recorded artefact accounts for.
    this.logEvent({
      level: 'INFO', category: 'order_status', clock,
      message: `Order ${orderId} (${cur.side} ${cur.quantity} ${cur.symbol}) ${cur.status} -> ${status}.`,
      details: {
        orderId, clientOrderId: cur.client_order_id, decisionId: cur.decision_id, symbol: cur.symbol,
        from: cur.status, to: status, orderQuantity: cur.quantity,
        filledBefore: cur.filled_quantity, filledAfter: filledQuantity ?? cur.filled_quantity,
        rejectionReason: rejectionReason ?? null,
      },
    });
    return this.getOrder(orderId);
  }

  getOrder(orderId) {
    return this.db.get('SELECT * FROM orders WHERE order_id = ?', orderId);
  }

  getOrderByClientId(clientOrderId) {
    return this.db.get('SELECT * FROM orders WHERE client_order_id = ?', clientOrderId);
  }

  listOrders({ limit = 200, status = null, symbol = null, mode = this.mode } = {}) {
    let sql = `SELECT order_id, client_order_id, decision_id, risk_decision_id, sentinel_decision_id, symbol, side,
                      order_type, quantity, filled_quantity, avg_fill_price, expected_price, limit_price, status,
                      rejection_reason, submitted_at, updated_at, terminal_at
               FROM orders WHERE mode = ?`;
    const p = [mode];
    if (status) { sql += ' AND status = ?'; p.push(status); }
    if (symbol) { sql += ' AND symbol = ?'; p.push(symbol); }
    sql += ' ORDER BY submitted_ms DESC, rowid DESC LIMIT ?';
    p.push(limit);
    return this.db.all(sql, ...p);
  }

  /** `runId` narrows the count to one run; omit it for a whole-mode total. */
  countOrders(mode = this.mode, runId = null) {
    if (runId) {
      return this.db.count('SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND run_id = ?', mode, runId);
    }
    return this.db.count('SELECT COUNT(*) AS c FROM orders WHERE mode = ?', mode);
  }

  countOrdersToday(dateKey, mode = this.mode, runId = null) {
    if (runId) {
      return this.db.count(
        `SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND run_id = ? AND status NOT IN ('REJECTED') AND substr(submitted_at,1,10) = ?`,
        mode, runId, dateKey,
      );
    }
    return this.db.count(
      `SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND status NOT IN ('REJECTED') AND substr(submitted_at,1,10) = ?`,
      mode, dateKey,
    );
  }

  countOrdersForSymbolToday(symbol, dateKey, mode = this.mode, runId = null) {
    if (runId) {
      return this.db.count(
        `SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND run_id = ? AND status NOT IN ('REJECTED') AND symbol = ? AND substr(submitted_at,1,10) = ?`,
        mode, runId, symbol, dateKey,
      );
    }
    return this.db.count(
      `SELECT COUNT(*) AS c FROM orders WHERE mode = ? AND status NOT IN ('REJECTED') AND symbol = ? AND substr(submitted_at,1,10) = ?`,
      mode, symbol, dateKey,
    );
  }

  /** Orders that were in flight when the process died. Recovered, never resent. */
  orphanOrders(mode = this.mode) {
    return this.db.all(
      `SELECT * FROM orders WHERE mode = ? AND status IN ('PENDING_NEW','NEW','PARTIALLY_FILLED') ORDER BY submitted_ms ASC`,
      mode,
    );
  }

  /**
   * Reconcile every order's lifecycle columns against the append-only `fills`
   * table.
   *
   * The order lifecycle is deliberately NOT in the audit hash (see
   * STREAM_COLUMNS), so this is the check that stands in for it: `filled_quantity`
   * must equal the sum of the order's fills, and the status must be consistent
   * with that sum. A tampered or drifted `filled_quantity` shows up here even
   * though the hash chain would never notice.
   */
  auditOrderFills(mode = this.mode) {
    return this.db.all(
      `SELECT o.order_id, o.client_order_id, o.symbol, o.side, o.status, o.quantity AS order_quantity,
              o.filled_quantity, o.rejection_reason,
              COALESCE(SUM(f.quantity), 0) AS fills_quantity,
              COALESCE(SUM(f.notional_egp), 0) AS fills_notional_egp,
              COALESCE(SUM(f.fee_egp), 0) AS fills_fee_egp,
              COUNT(f.fill_id) AS fill_count
         FROM orders o LEFT JOIN fills f ON f.order_id = o.order_id AND f.mode = o.mode
        WHERE o.mode = ?
        GROUP BY o.order_id
        ORDER BY o.submitted_ms ASC`,
      mode,
    ).map((r) => {
      const problems = [];
      if (Math.abs(r.filled_quantity - r.fills_quantity) > 1e-6) {
        problems.push(`filled_quantity ${r.filled_quantity} != sum(fills) ${r.fills_quantity}`);
      }
      const complete = r.fills_quantity >= r.order_quantity - 1e-9;
      if (complete && r.status !== 'FILLED') problems.push(`fully filled but status is ${r.status}`);
      if (!complete && (r.status === 'FILLED')) problems.push(`status FILLED with ${r.fills_quantity} of ${r.order_quantity}`);
      if (r.status === 'REJECTED' && r.fill_count > 0) problems.push('REJECTED order has fills');
      if (r.fills_quantity > r.order_quantity + 1e-9) problems.push('over-filled: sum(fills) exceeds order quantity');
      return { ...r, ok: problems.length === 0, problems };
    });
  }

  // --------------------------------------------------------- fills
  insertFill(f, clock) {
    const id = newId('fill');
    this.db.run(
      `INSERT INTO fills (fill_id, order_id, client_order_id, decision_id, run_id, mode, symbol, side, quantity,
        price, reference_price, notional_egp, fee_egp, slippage_bps, slippage_cost_egp, liquidity, ts, ts_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, f.orderId, f.clientOrderId, f.decisionId, this.runId, this.mode, f.symbol, f.side, f.quantity,
      f.price, f.referencePrice, f.notionalEgp, f.feeEgp, f.slippageBps, f.slippageCostEgp, f.liquidity,
      clock.nowIso(), clock.now(),
    );
    return id;
  }

  /**
   * Fills, newest first. `runId` scopes the query to one run - required for any
   * integrity check, because a whole-mode list mixes the fills of every run that
   * has ever used the database.
   */
  listFills({ limit = 200, orderId = null, mode = this.mode, runId = null } = {}) {
    if (orderId) {
      return this.db.all('SELECT * FROM fills WHERE mode = ? AND order_id = ? ORDER BY ts_ms ASC', mode, orderId);
    }
    if (runId) {
      return this.db.all(
        'SELECT * FROM fills WHERE mode = ? AND run_id = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?', mode, runId, limit,
      );
    }
    return this.db.all('SELECT * FROM fills WHERE mode = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?', mode, limit);
  }

  // ------------------------------------------------------- positions
  openPosition({ symbol, quantity, avgEntryPrice, clock, positionId = null }) {
    const id = positionId ?? newId('pos');
    this.db.run(
      `INSERT INTO positions (position_id, run_id, mode, symbol, quantity, avg_entry_price, realized_pnl_egp,
        fees_paid_egp, slippage_cost_egp, opened_at, opened_ms, updated_at, status)
       VALUES (?,?,?,?,?,?,0,0,0,?,?,?,'OPEN')`,
      id, this.runId, this.mode, symbol, quantity, avgEntryPrice, clock.nowIso(), clock.now(), clock.nowIso(),
    );
    return id;
  }

  updatePosition(positionId, patch, clock) {
    const cur = this.db.get('SELECT * FROM positions WHERE position_id = ?', positionId);
    if (!cur) throw new Error(`position not found: ${positionId}`);
    const next = {
      quantity: patch.quantity ?? cur.quantity,
      avg_entry_price: patch.avgEntryPrice ?? cur.avg_entry_price,
      realized_pnl_egp: patch.realizedPnl ?? cur.realized_pnl_egp,
      fees_paid_egp: patch.feesPaid ?? cur.fees_paid_egp,
      slippage_cost_egp: patch.slippageCost ?? cur.slippage_cost_egp,
      status: patch.status ?? cur.status,
      closed_at: patch.status === 'CLOSED' ? clock.nowIso() : null,
    };
    this.db.run(
      `UPDATE positions SET quantity=?, avg_entry_price=?, realized_pnl_egp=?, fees_paid_egp=?,
        slippage_cost_egp=?, updated_at=?, status=?, closed_at=COALESCE(?, closed_at)
       WHERE position_id = ?`,
      next.quantity, next.avg_entry_price, next.realized_pnl_egp, next.fees_paid_egp, next.slippage_cost_egp,
      clock.nowIso(), next.status, next.closed_at, positionId,
    );
    return this.db.get('SELECT * FROM positions WHERE position_id = ?', positionId);
  }

  getPosition(positionId) {
    return this.db.get('SELECT * FROM positions WHERE position_id = ?', positionId);
  }

  findOpenPosition(symbol, mode = this.mode) {
    return this.db.get(
      `SELECT * FROM positions WHERE mode = ? AND symbol = ? AND status = 'OPEN' ORDER BY opened_ms DESC LIMIT 1`,
      mode, symbol,
    );
  }

  listPositions({ status = null, mode = this.mode } = {}) {
    let sql = `SELECT * FROM positions WHERE mode = ?`;
    const p = [mode];
    if (status) { sql += ' AND status = ?'; p.push(status); }
    sql += ' ORDER BY opened_ms DESC';
    return this.db.all(sql, ...p);
  }

  listOpenPositions(mode = this.mode) {
    return this.listPositions({ status: 'OPEN', mode });
  }

  // -------------------------------------------------------- balances
  recordBalance(b, clock) {
    this.db.run(
      `INSERT INTO balances (run_id, mode, ts, ts_ms, cash_egp, equity_egp, exposure_egp, realized_pnl_egp,
        unrealized_pnl_egp, total_pnl_egp, open_positions, fees_paid_egp, slippage_cost_egp, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.runId, this.mode, clock.nowIso(), clock.now(), b.cashEgp, b.equityEgp, b.exposureEgp,
      b.realizedPnlEgp, b.unrealizedPnlEgp, b.totalPnlEgp, b.openPositions, b.feesPaidEgp ?? 0,
      b.slippageCostEgp ?? 0, b.reason ?? null,
    );
  }

  latestBalance(mode = this.mode) {
    return this.db.get('SELECT * FROM balances WHERE mode = ? ORDER BY ts_ms DESC, id DESC LIMIT 1', mode);
  }

  // ------------------------------------------------------------ pnl
  recordPnl({ symbol = null, positionId = null, orderId = null, fillId = null, kind, amountEgp, note = null, clock }, mode = this.mode) {
    this.db.run(
      `INSERT INTO pnl_events (pnl_event_id, run_id, mode, symbol, position_id, order_id, fill_id, kind, amount_egp, ts, ts_ms, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId('pnl'), this.runId, mode, symbol, positionId, orderId, fillId, kind, amountEgp,
      clock.nowIso(), clock.now(), note,
    );
  }

  realizedPnl(mode = this.mode) {
    return this.db.scalar(`SELECT COALESCE(SUM(amount_egp),0) AS v FROM pnl_events WHERE mode = ? AND kind = 'REALIZED'`, mode) ?? 0;
  }

  totalFees(mode = this.mode) {
    return this.db.scalar(`SELECT COALESCE(SUM(fee_egp),0) AS v FROM fills WHERE mode = ?`, mode) ?? 0;
  }

  totalSlippageCost(mode = this.mode) {
    return this.db.scalar(`SELECT COALESCE(SUM(slippage_cost_egp),0) AS v FROM fills WHERE mode = ?`, mode) ?? 0;
  }

  // ---------------------------------------------------- equity curve
  recordEquity({ equityEgp, cashEgp, exposureEgp, peakEquityEgp, drawdownEgp, drawdownPct, clock }, mode = this.mode) {
    this.db.run(
      `INSERT INTO equity_curve (run_id, mode, ts, ts_ms, equity_egp, cash_egp, exposure_egp, peak_equity_egp, drawdown_egp, drawdown_pct)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      this.runId, mode, clock.nowIso(), clock.now(), equityEgp, cashEgp, exposureEgp, peakEquityEgp, drawdownEgp, drawdownPct,
    );
  }

  /**
   * Equity samples in ascending time order.
   *
   * `newest` returns the most recent `limit` samples instead of the oldest
   * ones. A 24/7 worker appends forever, so the chart needs the tail; taking
   * the head would show a window from the first day the agent ever ran and
   * never move again.
   */
  equitySeries({ limit = 1000, mode = this.mode, newest = false } = {}) {
    const cols = 'ts, ts_ms, equity_egp, cash_egp, exposure_egp, drawdown_pct';
    // `id` is selected in both branches because both the inner LIMIT and the
    // outer re-sort order by it: it is the only monotonic tie-breaker when two
    // samples share a millisecond, and without it the tie order is undefined.
    const sql = newest
      ? `SELECT * FROM (SELECT ${cols}, id FROM equity_curve WHERE mode = ?
           ORDER BY ts_ms DESC, id DESC LIMIT ?) ORDER BY ts_ms ASC, id ASC`
      : `SELECT ${cols}, id FROM equity_curve WHERE mode = ? ORDER BY ts_ms ASC, id ASC LIMIT ?`;
    return this.db.all(sql, mode, limit);
  }

  // ------------------------------------------------- emergency stops
  engageStop({ trigger, severity = 'CRITICAL', scope = 'NEW_ORDERS', reason, details = null, clock, stopId = null }) {
    const id = stopId ?? newId('stop');
    this.db.run(
      `INSERT INTO emergency_stops (stop_id, run_id, mode, instance_id, ts, ts_ms, trigger, severity, scope, reason, details_json, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      id, this.runId, this.mode, this.instanceId, clock.nowIso(), clock.now(), trigger, severity, scope, reason, J(details),
    );
    this.setFlag('EMERGENCY_STOP', 'true', clock, 'risk-engine', reason);
    return id;
  }

  clearStop(stopId, clearedBy, clock) {
    this.db.run('UPDATE emergency_stops SET active = 0, cleared_at = ?, cleared_by = ? WHERE stop_id = ? AND active = 1',
      clock.nowIso(), clearedBy, stopId);
    const still = this.db.count('SELECT COUNT(*) AS c FROM emergency_stops WHERE mode = ? AND active = 1', this.mode);
    if (still === 0) this.setFlag('EMERGENCY_STOP', 'false', clock, clearedBy, 'all stops cleared');
    return still;
  }

  /**
   * The latched emergency stop, if any.
   *
   * `runId` scopes the lookup to ONE run. A stop is a property of a trading
   * session: it must survive a process restart of that session (a resumed PAPER
   * run keeps its run_id, so it stays latched), but it must NOT leak into an
   * unrelated run. Without the scope, a BACKTEST run inherited a stop latched
   * by an earlier backtest in the same database and silently traded nothing.
   */
  activeStop(mode = this.mode, runId = null) {
    if (runId) {
      return this.db.get(
        'SELECT * FROM emergency_stops WHERE mode = ? AND run_id = ? AND active = 1 ORDER BY ts_ms DESC LIMIT 1',
        mode, runId,
      );
    }
    return this.db.get('SELECT * FROM emergency_stops WHERE mode = ? AND active = 1 ORDER BY ts_ms DESC LIMIT 1', mode);
  }

  /**
   * The emergency stop that gates THIS session, honouring the mode policy.
   *
   * This is the single place that decides stop scoping, and every caller (the
   * worker's kill switch, the agent's evaluation gate) must go through it.
   * Two callers previously read `activeStop()` with different implicit scopes
   * and disagreed, which is how a BACKTEST run ended up halted by a stop that
   * an earlier backtest had latched.
   */
  sessionStop(mode = this.mode) {
    return this.activeStop(mode, mode === 'BACKTEST' ? this.runId : null);
  }

  listStops({ limit = 100, mode = this.mode } = {}) {
    return this.db.all(
      `SELECT * FROM emergency_stops WHERE mode = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?`, mode, limit,
    ).map((r) => ({ ...r, details: P(r.details_json) }));
  }

  // ------------------------------------------------------ control flags
  setFlag(flag, value, clock, updatedBy = 'system', reason = null, mode = this.mode) {
    this.db.run(
      `INSERT INTO control_flags (flag, mode, value, updated_at, updated_ms, updated_by, reason)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(flag, mode) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at,
         updated_ms=excluded.updated_ms, updated_by=excluded.updated_by, reason=excluded.reason`,
      flag, mode, value, clock.nowIso(), clock.now(), updatedBy, reason,
    );
  }

  getFlag(flag, defaultValue = null, mode = this.mode) {
    const r = this.db.get('SELECT value FROM control_flags WHERE flag = ? AND mode = ?', flag, mode);
    return r ? r.value : defaultValue;
  }

  isFlagSet(flag, mode = this.mode) {
    return this.getFlag(flag, 'false', mode) === 'true';
  }

  // -------------------------------------------------------- heartbeats
  heartbeat(h, clock, mode = this.mode) {
    this.db.run(
      `INSERT INTO worker_heartbeats (run_id, mode, instance_id, ts, ts_ms, status, agent_state, pid, host,
        version, uptime_ms, tick_count, decision_count, order_count, error_count, last_decision_id, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.runId, mode, h.instanceId, clock.nowIso(), clock.now(), h.status, h.agentState, h.pid, h.host,
      h.version, h.uptimeMs, h.tickCount, h.decisionCount, h.orderCount, h.errorCount,
      h.lastDecisionId ?? null, h.lastError ?? null,
    );
  }

  latestHeartbeat(mode = this.mode) {
    return this.db.get(
      'SELECT * FROM worker_heartbeats WHERE mode = ? ORDER BY ts_ms DESC, id DESC LIMIT 1', mode,
    );
  }

  heartbeatHistory({ limit = 100, instanceId = null, mode = this.mode } = {}) {
    let sql = 'SELECT * FROM worker_heartbeats WHERE mode = ?';
    const p = [mode];
    if (instanceId) { sql += ' AND instance_id = ?'; p.push(instanceId); }
    sql += ' ORDER BY ts_ms DESC, id DESC LIMIT ?';
    p.push(limit);
    return this.db.all(sql, ...p);
  }

  // ---------------------------------------------------------- restarts
  recordRestart(r, clock, mode = this.mode) {
    const id = newId('rst');
    this.db.run(
      `INSERT INTO restarts (restart_id, run_id, mode, previous_instance, new_instance, ts, ts_ms, kind, reason, orphaned_orders, recovery_json, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, this.runId, mode, r.previousInstance ?? null, r.newInstance, clock.nowIso(), clock.now(),
      r.kind, r.reason, r.orphanedOrders ?? 0, J(r.recovery ?? null), r.notes ?? null,
    );
    return id;
  }

  listRestarts({ limit = 100, mode = this.mode } = {}) {
    return this.db.all(
      'SELECT * FROM restarts WHERE mode = ? ORDER BY ts_ms DESC, rowid DESC LIMIT ?', mode, limit,
    ).map((r) => ({ ...r, recovery: P(r.recovery_json) }));
  }

  // ---------------------------------------------------- agent states
  logState({ from, to, reason, clock, instanceId = this.instanceId, mode = this.mode }) {
    this.db.run(
      `INSERT INTO agent_state_log (run_id, mode, instance_id, ts, ts_ms, from_state, to_state, reason)
       VALUES (?,?,?,?,?,?,?,?)`,
      this.runId, mode, instanceId, clock.nowIso(), clock.now(), from, to, reason,
    );
  }

  stateHistory({ limit = 100, mode = this.mode } = {}) {
    return this.db.all('SELECT * FROM agent_state_log WHERE mode = ? ORDER BY ts_ms DESC, id DESC LIMIT ?', mode, limit);
  }

  // -------------------------------------------------------- backtests
  saveBacktest(b, clock) {
    this.db.run(
      `INSERT INTO backtest_runs (backtest_id, run_id, mode, strategy_id, strategy_json, params_json, from_ts, to_ts,
        bars, initial_equity_egp, final_equity_egp, status, metrics_json, created_at)
       VALUES (?,?,'BACKTEST',?,?,?,?,?,?,?,?,?,?,?)`,
      b.backtestId, this.runId, b.strategyId, J(b.strategy), J(b.params), b.fromTs, b.toTs, b.bars,
      b.initialEquityEgp, b.finalEquityEgp, b.status, J(b.metrics), clock.nowIso(),
    );
  }

  saveBacktestTrade(t, backtestId) {
    this.db.run(
      `INSERT INTO backtest_trades (backtest_id, symbol, side, entry_ts, entry_price, exit_ts, exit_price,
        quantity, pnl_egp, fees_egp, reason_in, reason_out, exit_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      backtestId, t.symbol, t.side, t.entryTs, t.entryPrice, t.exitTs ?? null, t.exitPrice ?? null,
      t.quantity, t.pnlEgp ?? null, t.feesEgp ?? 0, t.reasonIn ?? null, t.reasonOut ?? null, t.exitReason ?? null,
    );
  }

  listBacktests({ limit = 50 } = {}) {
    return this.db.all(
      'SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?', limit,
    ).map((r) => ({ ...r, metrics: P(r.metrics_json), params: P(r.params_json) }));
  }

  listBacktestTrades(backtestId) {
    return this.db.all('SELECT * FROM backtest_trades WHERE backtest_id = ? ORDER BY id ASC', backtestId);
  }

  // ------------------------------------------------------ trade stats
  /**
   * Closed round trips.
   *
   * `runId` scopes the query to ONE run. In PAPER mode a resumed run spans
   * several `run_id`s (each process start gets its own), so the default
   * `null` means "every run in this mode" and is what the dashboard and the
   * account want. In BACKTEST mode each run is a self-contained experiment and
   * MUST be scoped, or the second run silently reports the first run's trades
   * alongside its own - which is how a backtest ends up reporting a win rate
   * it never produced.
   */
  closedTrades(mode = this.mode, runId = null) {
    if (runId) {
      return this.db.all(
        `SELECT p.* FROM positions p WHERE p.mode = ? AND p.run_id = ? AND p.status = 'CLOSED'
         ORDER BY p.closed_at ASC`, mode, runId,
      );
    }
    return this.db.all(
      `SELECT p.* FROM positions p WHERE p.mode = ? AND p.status = 'CLOSED' ORDER BY p.closed_at ASC`, mode,
    );
  }

  /** Net P&L per closed position, including fees and slippage drag. */
  tradeStats(mode = this.mode, runId = null) {
    const trades = this.closedTrades(mode, runId);
    let wins = 0; let losses = 0; let flats = 0;
    let grossWin = 0; let grossLoss = 0;
    for (const t of trades) {
      const net = t.realized_pnl_egp - t.fees_paid_egp - t.slippage_cost_egp;
      if (net > 0) { wins += 1; grossWin += net; }
      else if (net < 0) { losses += 1; grossLoss += Math.abs(net); }
      else flats += 1;
    }
    const n = wins + losses;
    return {
      total: trades.length,
      wins,
      losses,
      flats,
      winRate: n === 0 ? null : wins / n,
      grossWinEgp: grossWin,
      grossLossEgp: grossLoss,
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? null : 0) : grossWin / grossLoss,
      avgWinEgp: wins === 0 ? 0 : grossWin / wins,
      avgLossEgp: losses === 0 ? 0 : grossLoss / losses,
    };
  }
}
