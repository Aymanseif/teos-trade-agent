/**
 * TEOS Trade Agent - execution/firewall.js
 *
 * ===========================================================================
 *  THE EXECUTION FIREWALL
 * ===========================================================================
 *
 *  This module is the ONLY sanctioned route from an agent decision to the
 *  paper exchange. The pipeline is fixed and non-bypassable:
 *
 *      AGENT
 *        -> SIGNAL
 *          -> RISK ENGINE      (15 ordered rules, fail-closed)
 *            -> TEOS SENTINEL  (ALLOW | WARN | REVIEW | BLOCK)
 *              -> EXECUTION ADAPTER (validate + idempotency)
 *                -> PAPER EXCHANGE
 *
 *  Enforcement mechanisms, in order of strength:
 *
 *   1. The ExecutionAdapter throws if handed anything other than a Sentinel
 *      ALLOW/WARN. It cannot be constructed without a Sentinel verdict object.
 *   2. The MockBroker rejects any order whose `leverageRequested` /
 *      `borrowRequested` is not literally false.
 *   3. `firewall.execute()` is the only exported function that calls
 *      `adapter.submit()`. The worker's decision loop calls only this.
 *   4. Every stage writes an immutable audit record. A missing record is itself
 *      a detectable defect (see `verifyPipeline`).
 *   5. A test asserts that no other module imports `placeOrder`.
 *
 *  Outcomes returned by `execute()`:
 *   executed   - order submitted to the paper exchange
 *   blocked    - risk engine or Sentinel refused
 *   quarantined- Sentinel REVIEW; held for human approval, NOT executed
 *   failed     - an unexpected error; the decision is recorded and trading is
 *                halted for this tick
 * ===========================================================================
 */

import { newId } from '../core/ids.js';
import { toErrorPayload } from '../core/errors.js';
import { roundEgp } from '../core/money.js';

export const OUTCOMES = Object.freeze(['EXECUTED', 'BLOCKED', 'QUARANTINED', 'FAILED']);

export class ExecutionFirewall {
  #risk;
  #sentinel;
  #adapter;
  #repos;
  #clock;
  #mode;
  // Live paper-account reference, used for portfolio-level Sentinel checks
  // (e.g. the SHORT_GUARD needs to know whether a long actually exists).
  // A snapshot is not sufficient for that, so the account object is passed in
  // and used only for read-only lookups.
  #account;

  constructor({ riskEngine, sentinel, adapter, repos, clock, mode, account = null }) {
    this.#risk = riskEngine;
    this.#sentinel = sentinel;
    this.#adapter = adapter;
    this.#repos = repos;
    this.#clock = clock;
    this.#mode = mode;
    this.#account = account;
  }

  get riskEngine() { return this.#risk; }
  get sentinel() { return this.#sentinel; }
  get adapter() { return this.#adapter; }

  /**
   * Run one decision through the full pipeline.
   *
   * @param {object} p
   * @param {object} p.decision        sealed agent Decision
   * @param {object} p.account         portfolio snapshot
   * @param {object} p.dailyLoss       { realizedEgp, unrealizedEgp }
   * @param {object} p.brokerHealth    broker health
   * @param {object} p.killSwitch      { engaged, trigger, reason }
   * @param {object} p.quote           current quote for the symbol
   * @param {object} p.orderCounts     { day, bySymbol }
   * @returns {{ outcome, decisionId, riskVerdict, sentinelVerdict, order, error }}
   */
  async execute({ decision, account, dailyLoss, brokerHealth, killSwitch, quote, orderCounts }) {
    const base = {
      decisionId: decision.decisionId, riskVerdict: null, sentinelVerdict: null, order: null, error: null,
    };

    // ---- STAGE 1: RISK ENGINE -------------------------------------------
    // Always runs, even for HOLD decisions, so the refusal itself is auditable.
    let proposal;
    let riskVerdict;
    try {
      proposal = this.#risk.proposeOrder({
        decision, account, quote, instrument: this.#adapter.instrument(decision.symbol),
      });
      riskVerdict = this.#risk.check({
        decision, proposal, account, dailyLoss, brokerHealth, killSwitch, quote, orderCounts,
      });
    } catch (err) {
      const payload = toErrorPayload(err);
      this.#repos.logEvent({
        level: 'ERROR', category: 'risk_engine_error', clock: this.#clock,
        message: `Risk engine threw for decision ${decision.decisionId}: ${err.message}`,
        details: { decisionId: decision.decisionId, error: payload },
      });
      return { ...base, outcome: 'FAILED', error: payload };
    }

    // A HOLD, or a proposal with nothing to trade, stops here - but the risk
    // record is already written, which is the point.
    if (decision.signal === 'HOLD' || proposal.quantity <= 0) {
      return {
        ...base,
        outcome: 'BLOCKED',
        riskVerdict,
        // The parentheses are load-bearing. `??` binds LOOSER than `===`, so
        // without them this reads
        //   (proposal.reason ?? (signal === 'HOLD')) ? 'HOLD' : 'NO_EXECUTABLE_QUANTITY'
        // and every refusal that carries a reason - 'UNKNOWN_INSTRUMENT', say -
        // has a truthy condition, so it was reported as `reason: 'HOLD'`: the
        // operator was told the agent had chosen to hold, when the order was
        // actually refused for having no executable quantity. `detail` on the
        // next line was always correct, which is what made the mismatch
        // readable rather than merely wrong.
        reason: proposal.reason ?? (decision.signal === 'HOLD' ? 'HOLD' : 'NO_EXECUTABLE_QUANTITY'),
        detail: proposal.reason ?? 'no executable quantity',
      };
    }

    if (riskVerdict.blocked) {
      return { ...base, outcome: 'BLOCKED', riskVerdict, reason: riskVerdict.reason, detail: riskVerdict.failedRule };
    }

    // ---- STAGE 2: TEOS SENTINEL ----------------------------------------
    let sentinelVerdict;
    try {
      sentinelVerdict = this.#sentinel.evaluate({
        decision, proposal, riskVerdict, account, accountRef: this.#account,
        dailyLoss, killSwitch, quote, mode: this.#mode,
      });
    } catch (err) {
      const payload = toErrorPayload(err);
      this.#repos.logEvent({
        level: 'ERROR', category: 'sentinel_error', clock: this.#clock,
        message: `Sentinel threw for decision ${decision.decisionId}: ${err.message}`,
        details: { decisionId: decision.decisionId, error: payload },
      });
      return { ...base, outcome: 'FAILED', riskVerdict, error: payload };
    }

    if (sentinelVerdict.verdict === 'BLOCK') {
      return { ...base, outcome: 'BLOCKED', riskVerdict, sentinelVerdict, reason: sentinelVerdict.reason, detail: sentinelVerdict.triggerRule };
    }
    if (sentinelVerdict.verdict === 'REVIEW') {
      // Quarantined. Deliberately NOT submitted. Requires human approval.
      return { ...base, outcome: 'QUARANTINED', riskVerdict, sentinelVerdict, reason: sentinelVerdict.reason, detail: sentinelVerdict.triggerRule };
    }

    // ---- STAGE 3+4: ADAPTER -> PAPER EXCHANGE ---------------------------
    try {
      const res = await this.#adapter.submit({
        decision, proposal, riskVerdict, sentinelVerdict, quote, account,
      });
      if (!res.submitted) {
        const outcome = res.duplicate ? 'BLOCKED' : 'BLOCKED';
        return {
          ...base,
          outcome, riskVerdict, sentinelVerdict, order: res.order,
          reason: res.reason ?? 'NOT_SUBMITTED', error: res.error ?? null,
        };
      }
      return { ...base, outcome: 'EXECUTED', riskVerdict, sentinelVerdict, order: res.order, warnings: res.warnings };
    } catch (err) {
      const payload = toErrorPayload(err);
      this.#repos.logEvent({
        level: 'ERROR', category: 'execution_error', clock: this.#clock,
        message: `Execution failed for decision ${decision.decisionId}: ${err.message}`,
        details: { decisionId: decision.decisionId, error: payload },
      });
      return { ...base, outcome: 'FAILED', riskVerdict, sentinelVerdict, error: payload };
    }
  }

  #instrumentOf(symbol) {
    return this.#adapter.instrument?.(symbol) ?? null;
  }
  /**
   * Self-audit: confirm that the pipeline left a complete, linked record for a
   * decision. Used by the CLI `verify` command and by startup checks.
   */
  verifyPipeline(decisionId) {
    const decision = this.#repos.getDecision(decisionId);
    if (!decision) return { ok: false, missing: ['agent_decisions'], decisionId };
    const risk = this.#repos.db.all('SELECT * FROM risk_decisions WHERE decision_id = ?', decisionId);
    const sent = this.#repos.db.all('SELECT * FROM sentinel_decisions WHERE decision_id = ?', decisionId);
    const orders = this.#repos.db.all('SELECT * FROM orders WHERE decision_id = ?', decisionId);
    const missing = [];
    if (risk.length === 0) missing.push('risk_decisions');
    if (sent.length === 0) missing.push('sentinel_decisions');
    if (decision.action === 'PLACE_ORDER' && risk[0] && !risk[0].blocked && orders.length === 0) {
      missing.push('orders');
    }
    return {
      ok: missing.length === 0,
      decisionId,
      missing,
      counts: { decisions: 1, risk: risk.length, sentinel: sent.length, orders: orders.length },
      notionalEgp: orders.reduce((a, o) => a + roundEgp(o.quantity * (o.expected_price ?? 0)), 0),
    };
  }
}

/** Re-exported so the CLI can report the firewall's policy surface. */
export { newId };
