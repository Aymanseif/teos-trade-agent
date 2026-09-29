/**
 * TEOS Trade Agent - worker/heartbeat.js
 *
 * Heartbeat + health. Answers the question "is the agent actually alive and
 * making decisions?" for the dashboard and for the external watchdog.
 *
 * Health states:
 *   HEALTHY   heartbeat current, agent HEALTHY, no kill switch
 *   DEGRADED  heartbeat current but agent is DEGRADED (cannot open positions)
 *   HALTED    agent HALTED or an emergency stop is engaged
 *   STALE     the last heartbeat is older than the staleness threshold:
 *             the process is presumed dead
 *   STOPPED   the worker shut down cleanly
 *   STARTING  booting
 *   FAILED    an unrecoverable error
 */

import { hostname } from 'node:os';

export const HEALTH = Object.freeze({
  STARTING: 'STARTING',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  HALTED: 'HALTED',
  STALE: 'STALE',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

export class Heartbeat {
  #repos;
  #clock;
  #intervalMs;
  #staleAfterMs;
  #counters = { ticks: 0, decisions: 0, orders: 0, errors: 0 };
  #startedMs;
  #lastError = null;
  #lastDecisionId = null;
  #lastWriteMs = 0;
  #status = HEALTH.STARTING;

  constructor({ repos, clock, intervalMs = 5000, staleAfterMs = 30_000 }) {
    this.#repos = repos;
    this.#clock = clock;
    this.#intervalMs = intervalMs;
    this.#staleAfterMs = staleAfterMs;
    this.#startedMs = clock.now();
  }

  get counters() { return { ...this.#counters }; }
  get uptimeMs() { return this.#clock.now() - this.#startedMs; }
  get lastWriteMs() { return this.#lastWriteMs; }

  tick() { this.#counters.ticks += 1; }
  decision(id) { this.#counters.decisions += 1; this.#lastDecisionId = id; }
  order() { this.#counters.orders += 1; }
  error(err) {
    this.#counters.errors += 1;
    this.#lastError = typeof err === 'string' ? err : (err?.message ?? String(err));
  }

  setStatus(status) { this.#status = status; }

  /** Write a heartbeat if the interval has elapsed. */
  maybeWrite({ instanceId, agentState, status = null }) {
    const now = this.#clock.now();
    if (now - this.#lastWriteMs < this.#intervalMs) return false;
    this.write({ instanceId, agentState, status });
    return true;
  }

  write({ instanceId, agentState, status = null }) {
    const now = this.#clock.now();
    const resolved = status ?? this.#resolveStatus(agentState);
    this.#repos.heartbeat({
      instanceId,
      status: resolved,
      agentState,
      pid: process.pid,
      host: hostname(),
      version: '1.0.0-phase1',
      uptimeMs: now - this.#startedMs,
      tickCount: this.#counters.ticks,
      decisionCount: this.#counters.decisions,
      orderCount: this.#counters.orders,
      errorCount: this.#counters.errors,
      lastDecisionId: this.#lastDecisionId,
      lastError: this.#lastError,
    }, this.#clock);
    this.#lastWriteMs = now;
    this.#status = resolved;
    return resolved;
  }

  #resolveStatus(agentState) {
    // `sessionStop()`, never `activeStop()`. The health a worker reports has to
    // be the health of THIS session. An unscoped lookup is broader: in BACKTEST
    // a run whose own kill switch is clear reported HALTED because an earlier
    // backtest in the same database had latched a stop, which is a false alarm
    // about a condition that is not happening.
    if (this.#repos.sessionStop()) return HEALTH.HALTED;
    if (agentState === 'FAILED') return HEALTH.FAILED;
    if (agentState === 'HALTED') return HEALTH.HALTED;
    if (agentState === 'DEGRADED') return HEALTH.DEGRADED;
    if (agentState === 'STOPPED') return HEALTH.STOPPED;
    if (agentState === 'WARMUP' || agentState === 'STARTING') return HEALTH.STARTING;
    return HEALTH.HEALTHY;
  }

  /**
   * Read-side health, used by the dashboard. Detects a dead process even when
   * nobody is around to restart it.
   */
  probe() {
    const row = this.#repos.latestHeartbeat();
    if (!row) {
      return { status: HEALTH.STARTING, ok: true, alive: false, detail: 'no heartbeat recorded yet', counters: this.counters };
    }
    const age = this.#clock.now() - row.ts_ms;
    if (row.status === HEALTH.STOPPED) {
      return { ...this.#fromRow(row), ok: false, alive: false, ageMs: age, detail: 'worker stopped cleanly' };
    }
    if (age > this.#staleAfterMs) {
      return {
        ...this.#fromRow(row), status: HEALTH.STALE, ok: false, alive: false, ageMs: age,
        detail: `last heartbeat ${age}ms ago exceeds the ${this.#staleAfterMs}ms threshold; the worker is presumed dead`,
      };
    }
    return { ...this.#fromRow(row), ok: true, alive: true, ageMs: age, detail: row.last_error ?? null };
  }

  #fromRow(row) {
    return {
      status: row.status,
      agentState: row.agent_state,
      instanceId: row.instance_id,
      pid: row.pid,
      host: row.host,
      version: row.version,
      uptimeMs: row.uptime_ms,
      lastHeartbeatMs: row.ts_ms,
      lastHeartbeatIso: row.ts,
      counters: {
        ticks: row.tick_count, decisions: row.decision_count,
        orders: row.order_count, errors: row.error_count,
      },
      lastDecisionId: row.last_decision_id,
      lastError: row.last_error,
      countersLive: this.counters,
    };
  }
}
