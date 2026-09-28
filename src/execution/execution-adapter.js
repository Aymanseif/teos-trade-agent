/**
 * TEOS Trade Agent - execution/execution-adapter.js
 *
 * The ONLY component that may call `broker.placeOrder()`.
 *
 * Responsibilities
 *  - build a validated order from a decision + an approved risk + Sentinel verdict
 *  - enforce idempotency via a deterministic client_order_id
 *  - validate the order a final time before submission
 *  - record the order and its lifecycle in the database
 *  - refuse to submit anything that has not cleared the Sentinel
 *
 * If you are looking for the place an order is sent from, it is
 * `#submit()`. There is no other call site in the codebase.
 */

import { assertValidOrder } from './validator.js';
import { newId, clientOrderId as deriveClientOrderId } from '../core/ids.js';
import { roundTo, roundEgp } from '../core/money.js';
import { EmergencyStopError, InvalidOrderError, ValidationError } from '../core/errors.js';
import { toErrorPayload } from '../core/errors.js';

/** The only two Sentinel verdicts that permit an order to be built. */
const SUBMITTABLE = new Set(['ALLOW', 'WARN']);

export class ExecutionAdapter {
  #broker;
  #repos;
  #clock;
  #config;
  #instruments;

  constructor({ broker, repos, clock, config }) {
    this.#broker = broker;
    this.#repos = repos;
    this.#clock = clock;
    this.#config = config;
    this.#instruments = new Map(config.instruments.map((i) => [i.symbol, i]));
  }

  get broker() { return this.#broker; }

  /** Instrument metadata for a symbol, or null if unknown. */
  instrument(symbol) {
    return this.#instruments.get(symbol) ?? null;
  }

  /**
   * Build the order object. Separated from submission so the order can be
   * inspected (and unit-tested) without ever being sent.
   */
  buildOrder({ decision, proposal, riskVerdict, sentinelVerdict, quote, account }) {
    if (!SUBMITTABLE.has(sentinelVerdict.verdict)) {
      throw new InvalidOrderError(
        `Refusing to build an order: Sentinel verdict is ${sentinelVerdict.verdict} (${sentinelVerdict.reason}).`,
        { verdict: sentinelVerdict.verdict, decisionId: decision.decisionId },
      );
    }
    if (riskVerdict?.blocked) {
      throw new InvalidOrderError(
        `Refusing to build an order: risk engine blocked (${riskVerdict.failedRule}).`,
        { failedRule: riskVerdict.failedRule, decisionId: decision.decisionId },
      );
    }

    const instrument = this.#instruments.get(decision.symbol);
    if (!instrument) {
      throw new InvalidOrderError(`Unknown instrument ${decision.symbol}.`, { symbol: decision.symbol });
    }

    const cid = deriveClientOrderId(decision.decisionId);
    const order = {
      orderId: newId('ord'),
      clientOrderId: cid,
      decisionId: decision.decisionId,
      riskDecisionId: riskVerdict?.riskDecisionId ?? null,
      sentinelDecisionId: sentinelVerdict.sentinelDecisionId,
      symbol: decision.symbol,
      side: proposal.side,
      orderType: 'MARKET',
      quantity: roundTo(proposal.quantity, 8),
      limitPrice: null,
      expectedPrice: roundTo(quote?.mid ?? decision.expectedExecutionPrice, 8),
      reduceOnly: proposal.reduceOnly === true,
      // Hard-coded false. There is no code path anywhere that can set these.
      leverageRequested: false,
      borrowRequested: false,
      marginRequested: false,
      shortRequested: false,
      instrumentType: 'SPOT',
      submittedTs: this.#clock.now(),
    };

    const validation = assertValidOrder(order, {
      instrument,
      account: account ?? null,
      now: this.#clock.now(),
    });

    return { order, validation };
  }

  /**
   * Submit a built order. Idempotent.
   *
   * @returns {Promise<{ submitted:boolean, order, duplicate:boolean, reason?:string }>}
   */
  async submit({ decision, proposal, riskVerdict, sentinelVerdict, quote, account }) {
    // Idempotency check before anything else.
    const cid = deriveClientOrderId(decision.decisionId);
    const preexisting = this.#repos.getOrderByClientId(cid);
    if (preexisting) {
      this.#repos.logEvent({
        level: 'WARN', category: 'duplicate_order', clock: this.#clock,
        message: `Duplicate submission refused for decision ${decision.decisionId} (existing order ${preexisting.order_id}).`,
        details: { clientOrderId: cid, existingOrderId: preexisting.order_id, status: preexisting.status },
      });
      return { submitted: false, duplicate: true, order: preexisting, reason: 'DUPLICATE_CLIENT_ORDER_ID' };
    }

    // Last-chance kill-switch check immediately before the call.
    const activeStop = this.#repos.activeStop();
    if (activeStop) {
      throw new EmergencyStopError(
        `Emergency stop is active (${activeStop.trigger}); refusing to submit ${cid}.`,
        { stopId: activeStop.stop_id, trigger: activeStop.trigger },
      );
    }

    let built;
    try {
      built = this.buildOrder({ decision, proposal, riskVerdict, sentinelVerdict, quote, account });
    } catch (err) {
      this.#repos.logEvent({
        level: 'ERROR', category: 'order_build_failed', clock: this.#clock,
        message: `Order build failed for decision ${decision.decisionId}: ${err.message}`,
        details: { decisionId: decision.decisionId, error: toErrorPayload(err) },
      });
      return { submitted: false, duplicate: false, order: null, reason: 'BUILD_FAILED', error: toErrorPayload(err) };
    }

    const { order, validation } = built;

    // Persist intent BEFORE submitting, so a crash between submit and write
    // still leaves an auditable record (recovered as UNKNOWN on restart).
    const sealed = this.#repos.insertOrder({
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      decisionId: order.decisionId,
      riskDecisionId: order.riskDecisionId,
      sentinelDecisionId: order.sentinelDecisionId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      expectedPrice: order.expectedPrice,
      status: 'PENDING_NEW',
      reduceOnly: order.reduceOnly,
      rejectionReason: null,
    }, this.#clock);

    let ack;
    try {
      ack = this.#broker.placeOrder(order);
    } catch (err) {
      this.#repos.updateOrderStatus(order.orderId, {
        status: 'REJECTED', rejectionReason: `BROKER_ERROR:${err.message}`, terminal: true, clock: this.#clock,
      });
      this.#repos.logEvent({
        level: 'ERROR', category: 'broker_error', clock: this.#clock,
        message: `Broker rejected ${order.clientOrderId}: ${err.message}`,
        details: { orderId: order.orderId, error: toErrorPayload(err) },
      });
      return { submitted: false, duplicate: false, order: this.#repos.getOrder(order.orderId), reason: 'BROKER_ERROR', error: toErrorPayload(err) };
    }

    if (ack.duplicate) {
      this.#repos.updateOrderStatus(order.orderId, { status: 'REJECTED', rejectionReason: 'DUPLICATE_AT_BROKER', terminal: true, clock: this.#clock });
      return { submitted: false, duplicate: true, order: this.#repos.getOrder(order.orderId), reason: 'DUPLICATE_AT_BROKER' };
    }

    if (ack.status === 'REJECTED') {
      this.#repos.updateOrderStatus(order.orderId, {
        status: 'REJECTED', rejectionReason: ack.rejectionReason ?? 'REJECTED', terminal: true, clock: this.#clock,
      });
      this.#repos.logEvent({
        level: 'WARN', category: 'order_rejected', clock: this.#clock,
        message: `Broker rejected ${order.clientOrderId}: ${ack.rejectionReason}`,
        details: { orderId: order.orderId, reason: ack.rejectionReason },
      });
      return { submitted: false, duplicate: false, order: this.#repos.getOrder(order.orderId), reason: ack.rejectionReason };
    }

    this.#repos.updateOrderStatus(order.orderId, { status: 'NEW', terminal: false, clock: this.#clock });

    this.#repos.logEvent({
      level: 'INFO', category: 'order_submitted', clock: this.#clock,
      message: `Submitted ${order.side} ${order.quantity} ${order.symbol} (${order.clientOrderId}).`,
      details: {
        orderId: order.orderId, clientOrderId: order.clientOrderId, decisionId: decision.decisionId,
        notionalEgp: roundEgp(order.quantity * order.expectedPrice), validationWarnings: validation.warnings,
      },
    });

    return {
      submitted: true,
      duplicate: false,
      order: this.#repos.getOrder(order.orderId),
      sealed,
      warnings: validation.warnings,
    };
  }

  /** Cancel an order. Exposed for the CLI (e.g. flatten on demand). */
  cancel(orderId) {
    const res = this.#broker.cancelOrder(orderId);
    this.#repos.logEvent({
      level: 'INFO', category: 'order_canceled', clock: this.#clock,
      message: `Canceled order ${orderId}.`, details: { orderId, canceled: res.canceled },
    });
    return res;
  }
}

export { deriveClientOrderId, ValidationError };
