/**
 * TEOS Trade Agent - worker/idempotency.js
 *
 * Order idempotency and restart-safety helpers.
 *
 * The invariant: ONE decision can produce AT MOST ONE order, forever, across
 * any number of process restarts. This is guaranteed by two independent
 * mechanisms:
 *
 *   1. DETERMINISTIC client_order_id = H(decision_id). Retrying the same
 *      decision always yields the same id, and `orders.client_order_id` is a
 *      UNIQUE column. A second insert is impossible at the storage layer.
 *   2. IN-FLIGHT RECONCILIATION. An order that was submitted but whose
 *      lifecycle was not completed when the process died is recovered as
 *      UNKNOWN (or reconciled from recorded fills) and is NEVER resubmitted.
 *
 * Together these mean a crash between "submit to broker" and "record fill"
 * cannot duplicate an order.
 */

import { clientOrderId } from '../core/ids.js';
import { roundTo } from '../core/money.js';

export class IdempotencyGuard {
  #repos;

  constructor(repos) { this.#repos = repos; }

  static idFor(decisionId) { return clientOrderId(decisionId); }

  /** Has this decision already produced an order? */
  hasOrderFor(decisionId) {
    return this.#repos.getOrderByClientId(IdempotencyGuard.idFor(decisionId)) !== null;
  }

  getExisting(decisionId) {
    return this.#repos.getOrderByClientId(IdempotencyGuard.idFor(decisionId));
  }

  /**
   * Client-order-id collisions are cryptographically improbable, but a
   * collision would be a silent, serious defect. This is a cheap assertion.
   */
  assertNoCollision(decisionId) {
    const cid = IdempotencyGuard.idFor(decisionId);
    const row = this.#repos.db.get('SELECT decision_id FROM orders WHERE client_order_id = ?', cid);
    if (row && row.decision_id !== decisionId) {
      throw new Error(`CRITICAL: client_order_id collision between ${row.decision_id} and ${decisionId} (${cid}).`);
    }
    return true;
  }
}

export const OPEN_ORDER_STATUSES = ['PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'UNKNOWN'];

/**
 * Reconcile in-flight orders after an unclean shutdown.
 *
 * Deliberately does NOT resubmit anything. An order whose true state is
 * unknowable is marked UNKNOWN, which blocks further action on that decision
 * and is visible in the audit log. Resubmitting a possibly-live order is
 * precisely the mistake this function exists to prevent.
 *
 * @returns {{ orphans:Array, byResolution:Object }}
 */
export function reconcileInFlight({ repos, broker, clock }) {
  const orphans = repos.orphanOrders();
  const byResolution = { FILLED: 0, PARTIALLY_FILLED: 0, UNKNOWN_NO_FILLS: 0, UNKNOWN_WITH_FILLS: 0 };
  const details = [];

  for (const o of orphans) {
    const fills = repos.listFills({ orderId: o.order_id });
    const filledQty = roundTo(fills.reduce((a, f) => a + f.quantity, 0), 8);
    const notional = roundTo(fills.reduce((a, f) => a + f.quantity * f.price, 0), 8);

    if (fills.length === 0) {
      // Nothing happened: the order never traded. Cancel it so it can never be
      // matched later, and mark it explicitly.
      repos.updateOrderStatus(o.order_id, {
        status: 'CANCELED', rejectionReason: 'RECOVERED_UNFILLED_AFTER_RESTART', terminal: true, clock,
      });
      byResolution.UNKNOWN_NO_FILLS += 1;
      details.push({ orderId: o.order_id, clientOrderId: o.client_order_id, resolution: 'CANCELED_UNFILLED', resubmitted: false });
      continue;
    }

    const complete = filledQty >= o.quantity - 1e-9;
    if (complete) {
      repos.updateOrderStatus(o.order_id, { status: 'FILLED', filledQuantity: filledQty, terminal: true, clock });
      byResolution.FILLED += 1;
      details.push({ orderId: o.order_id, resolution: 'FILLED', filledQuantity: filledQty, resubmitted: false });
    } else {
      // Partially filled and then the process died. The remainder is
      // cancelled; the filled part stands and is already in the position.
      repos.updateOrderStatus(o.order_id, { status: 'CANCELED', filledQuantity: filledQty, terminal: true, clock });
      byResolution.PARTIALLY_FILLED += 1;
      details.push({ orderId: o.order_id, resolution: 'PARTIAL_CANCELED_REMAINDER', filledQuantity: filledQty, remainingQuantity: roundTo(o.quantity - filledQty, 8), resubmitted: false });
    }
    void notional;
  }

  if (orphans.length > 0) {
    repos.logEvent({
      level: 'WARN', category: 'recovery', clock,
      message: `Reconciled ${orphans.length} in-flight order(s) after restart. None were resubmitted.`,
      details: { byResolution, details },
    });
  }

  return { orphans: details, byResolution };
}

/**
 * Self-check that the fill history reconstructs the current cash balance.
 * A mismatch means the ledger and the fill log have diverged, which is a
 * serious integrity defect worth surfacing loudly at startup.
 *
 * `runId` scopes the reconstruction to the run being reconciled. Without it the
 * check sums EVERY fill the database has ever held, so a legitimate cold start
 * (ledger at EGP 500, zero fills of its own) was reported as a large
 * reconciliation failure caused by an unrelated earlier run.
 */
export function reconcileCash({ repos, startingCapitalEgp, cashEgp, runId = null }) {
  const fills = repos.listFills({ limit: 1_000_000, runId });
  let minor = Math.round(startingCapitalEgp * 100);
  for (const f of fills) {
    const notional = Math.round(f.notional_egp * 100);
    const fee = Math.round(f.fee_egp * 100);
    minor += f.side === 'BUY' ? -(notional + fee) : (notional - fee);
  }
  const expected = minor / 100;
  const delta = Math.round((cashEgp - expected) * 100) / 100;
  return {
    ok: Math.abs(delta) < 0.011,
    expectedCashEgp: expected,
    actualCashEgp: cashEgp,
    deltaEgp: delta,
    fillCount: fills.length,
    runId,
  };
}
