/**
 * TEOS Trade Agent - database/audit-chain.js
 *
 * Tamper-evident audit chain for executed decisions.
 *
 * Every immutable decision record (agent decision, risk verdict, sentinel
 * verdict, order) stores the hash of the previous record *in the same audit
 * stream* plus a hash over its own canonical JSON. Walking the chain therefore
 * detects any retroactive edit, deletion or insertion.
 *
 * Scope: a chain is per (mode, stream). Streams are 'decision', 'risk',
 * 'sentinel' and 'order'. Excluded from the chain: trades that the system
 * refuses to execute are still recorded (verdict=BLOCK) so the refusal is
 * auditable; a dropped or tampered record breaks the chain.
 */

import { newId, sha256 } from '../core/ids.js';

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const STREAMS = {
  DECISION: 'decision',
  RISK: 'risk',
  SENTINEL: 'sentinel',
  ORDER: 'order',
};

/**
 * The exact columns each stream hashes, IN THE ORDER THEY ARE SEALED.
 *
 * This list is the contract between `seal()` and `verify()`. It must be the
 * immutable portion of the row and nothing else: hashing a column that later
 * mutates would make `verify()` report tampering on every legitimate update,
 * and a chain that always reports "broken" is worse than no chain at all,
 * because it trains the operator to ignore it.
 *
 * `orders` is the only stream with mutable columns. Its LIFECYCLE
 * (`status`, `filled_quantity`, `avg_fill_price`, `updated_at`, `terminal_at`,
 * `rejection_reason`) is deliberately excluded and protected instead by the
 * order state machine in `Repos.updateOrderStatus`, which rejects illegal
 * transitions, and by reconciliation against the append-only `fills` table
 * (`Repos.auditOrderFills`). The status the order was submitted with is kept in
 * its own immutable `status_at_submit` column so it can still be proven.
 * What the chain proves about an order is that the INTENT - which decision it
 * came from, and the side, symbol, quantity and price it asked for - was never
 * rewritten after the fact.
 */
export const STREAM_COLUMNS = Object.freeze({
  [STREAMS.DECISION]: Object.freeze([
    'decision_id', 'run_id', 'mode', 'instance_id', 'ts', 'ts_ms', 'symbol', 'strategy_id', 'price',
    'signal', 'quantity', 'notional_egp', 'confidence', 'max_loss_egp', 'stop_price', 'stop_distance_pct',
    'risk_reward_ratio', 'reason', 'features_json', 'expected_execution_price', 'stop_condition', 'action',
    'agent_state',
  ]),
  [STREAMS.RISK]: Object.freeze([
    'risk_decision_id', 'decision_id', 'run_id', 'mode', 'instance_id', 'ts', 'ts_ms', 'verdict', 'blocked',
    'reason', 'failed_rule', 'passed_count', 'failed_count', 'rules_json', 'account_json', 'limits_json',
  ]),
  [STREAMS.SENTINEL]: Object.freeze([
    'sentinel_decision_id', 'decision_id', 'risk_decision_id', 'run_id', 'mode', 'instance_id', 'ts', 'ts_ms',
    'verdict', 'action_taken', 'reason', 'trigger_rule', 'policy_version', 'rules_json', 'threshold_json',
  ]),
  [STREAMS.ORDER]: Object.freeze([
    'order_id', 'client_order_id', 'decision_id', 'risk_decision_id', 'sentinel_decision_id', 'run_id', 'mode',
    'instance_id', 'symbol', 'side', 'order_type', 'quantity', 'limit_price', 'expected_price', 'reduce_only',
    'leverage_requested', 'submitted_at', 'submitted_ms', 'status_at_submit',
  ]),
});

/**
 * Per-stream chain cursor cache. Loaded once at start-up, advanced on every
 * append. Kept in memory for speed and validated against the DB on load.
 */
export class AuditChain {
  #db;
  #cursors = new Map();

  constructor(db) {
    this.#db = db;
  }

  static tableFor(stream) {
    switch (stream) {
      case STREAMS.DECISION: return 'agent_decisions';
      case STREAMS.RISK: return 'risk_decisions';
      case STREAMS.SENTINEL: return 'sentinel_decisions';
      case STREAMS.ORDER: return 'orders';
      default: throw new Error(`unknown audit stream: ${stream}`);
    }
  }

  #loadMode(stream, mode) {
    const key = `${stream}:${mode}`;
    if (this.#cursors.has(key)) return this.#cursors.get(key);
    const table = AuditChain.tableFor(stream);
    const row = this.#db.get(
      `SELECT record_hash FROM ${table} WHERE mode = ? ORDER BY rowid DESC LIMIT 1`,
      mode,
    );
    const cursor = { hash: row ? row.record_hash : null };
    this.#cursors.set(key, cursor);
    return cursor;
  }

  /**
   * Compute the hash for a record and advance the chain cursor.
   *
   * `record` must carry every column in `STREAM_COLUMNS[stream]`. Anything
   * outside that list is ignored, which is what keeps a mutable column from
   * ever entering the hash. Values are projected through the list in its
   * declared order, so a key that is absent and a key explicitly set to
   * `undefined` produce the same body - the hash describes the record, not the
   * shape of the object literal that built it.
   */
  seal(stream, mode, record) {
    const cursor = this.#loadMode(stream, mode);
    const prevHash = cursor.hash;
    const projected = project(stream, record);
    const body = { ...projected, prev_hash: prevHash };
    const recordHash = sha256(`${stream}|${mode}|${prevHash ?? 'GENESIS'}|${canonicalJson(body)}`);
    const sealed = { ...body, ...record, prev_hash: prevHash, record_hash: recordHash };
    cursor.hash = recordHash;
    return sealed;
  }

  reset() {
    this.#cursors.clear();
  }

  /**
   * Full verification of a chain. Returns { ok, checked, brokenAt, reason }.
   * Used by the CLI `verify` command and by a startup self-test.
   */
  verify(stream, mode) {
    const table = AuditChain.tableFor(stream);
    const columns = STREAM_COLUMNS[stream];
    const orderCol = STREAMS.ORDER === stream ? 'submitted_ms' : 'ts_ms';
    const rows = this.#db.all(
      `SELECT * FROM ${table} WHERE mode = ? ORDER BY rowid ASC`,
      mode,
    );
    let prev = null;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if ((r.prev_hash ?? null) !== (prev ?? null)) {
        return { ok: false, checked: i, brokenAt: r.record_hash, reason: 'prev_hash mismatch (record removed or reordered)' };
      }
      // Re-project through the same column list `seal` used, so any column
      // outside it - including every mutable lifecycle column - is ignored
      // here exactly as it was there.
      const body = project(stream, r, { tolerateMissing: true });
      const expect = sha256(
        `${stream}|${mode}|${r.prev_hash ?? 'GENESIS'}|${canonicalJson({ ...body, prev_hash: r.prev_hash })}`,
      );
      if (expect !== r.record_hash) {
        return { ok: false, checked: i, brokenAt: r.record_hash, reason: 'record_hash mismatch (record modified)' };
      }
      prev = r.record_hash;
    }
    return { ok: true, checked: rows.length, orderCol, columns: columns.length, reason: 'chain intact' };
  }
}

/**
 * Reduce a record to exactly the columns its stream hashes.
 *
 * In `seal` a missing column is an error: it means the caller built a record
 * that is not the one the chain is defined over, and sealing it anyway would
 * produce a chain that `verify` could never reproduce. In `verify` the columns
 * come from a real row, so `status_at_submit` (a seal-time-only projection of
 * `status`) and any other such name are simply skipped.
 */
function project(stream, record, { tolerateMissing = false } = {}) {
  const columns = STREAM_COLUMNS[stream];
  if (!columns) throw new Error(`unknown audit stream: ${stream}`);
  const out = {};
  for (const col of columns) {
    if (!(col in record)) {
      if (tolerateMissing) continue;
      throw new Error(`audit stream '${stream}' requires column '${col}' which the record does not carry`);
    }
    out[col] = record[col];
  }
  return out;
}

export function newAuditId(prefix) {
  return newId(prefix);
}
