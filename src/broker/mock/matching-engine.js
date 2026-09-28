/**
 * TEOS Trade Agent - broker/mock/matching-engine.js
 *
 * Paper matching engine. Models the behaviours that make naive simulators
 * unrealistically profitable:
 *
 *  - fills happen at a slipped price, never at the decision price
 *  - fees are charged on every fill, maker or taker
 *  - a large fraction of orders fill only PARTIALLY
 *  - remaining quantity stays open and can be filled by later ticks
 *  - LIMIT orders only fill when the market trades through the limit price
 *  - an unknown symbol is rejected, not silently filled
 *
 * All randomness comes from the injected seeded Rng.
 */

import { roundTo } from '../../core/money.js';
import { InvalidOrderError } from '../../core/errors.js';

export const OPEN_STATUSES = ['PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'UNKNOWN'];

export class MatchingEngine {
  #cfg;
  #rng;
  #feeModel;
  #slippageModel;
  #instruments;
  #fillGuard = null;

  /** orderId -> order */
  orders = new Map();
  /** orderId -> [fills] */
  fills = new Map();
  /** orderId -> id of the open position (paper account fills the position) */
  positionLinks = new Map();

  constructor({ executionConfig, feeModel, slippageModel, rng, instruments }) {
    this.#cfg = executionConfig;
    this.#rng = rng;
    this.#feeModel = feeModel;
    this.#slippageModel = slippageModel;
    this.#instruments = instruments instanceof Map ? instruments : new Map(instruments.map((i) => [i.symbol, i]));
  }

  /**
   * Install a guard consulted immediately before every fill is produced.
   *
   * The engine knows nothing about positions; the broker does. The guard is how
   * the broker tells the engine "there is no long left to sell here" so the
   * engine can CANCEL the resting order with a recorded reason instead of
   * producing a fill that the account would then have to reject. A fill that is
   * impossible must never surface as an exception out of `broker.tick()`.
   *
   * Contract: `(order, quote, proposedQuantity) => { allowed, quantity, reason }`
   *   allowed:false        -> cancel the order, produce no fill
   *   quantity < proposed  -> fill at most that much (e.g. available long)
   */
  setFillGuard(fn) {
    this.#fillGuard = typeof fn === 'function' ? fn : null;
  }

  #guardFill(order, quote, proposedQty) {
    if (!this.#fillGuard) return { allowed: true, quantity: proposedQty, reason: null };
    let verdict;
    try {
      verdict = this.#fillGuard(order, quote, proposedQty);
    } catch (err) {
      // A throwing guard is treated as "do not fill" - fail closed.
      return { allowed: false, quantity: 0, reason: `FILL_GUARD_THREW:${err.message}` };
    }
    if (!verdict || verdict.allowed === false) {
      return { allowed: false, quantity: 0, reason: verdict?.reason ?? 'FILL_NOT_PERMITTED' };
    }
    const qty = Number.isFinite(verdict.quantity) ? Math.min(proposedQty, verdict.quantity) : proposedQty;
    return { allowed: qty > 0, quantity: qty, reason: verdict.reason ?? null };
  }

  instrument(symbol) {
    return this.#instruments.get(symbol) ?? null;
  }

  hasOrder(orderId) {
    return this.orders.has(orderId);
  }

  getOrder(orderId) {
    return this.orders.get(orderId) ?? null;
  }

  getOrderByClientId(clientOrderId) {
    for (const o of this.orders.values()) if (o.clientOrderId === clientOrderId) return o;
    return null;
  }

  listOpenOrders() {
    return [...this.orders.values()].filter((o) => OPEN_STATUSES.includes(o.status));
  }

  /**
   * The oldest still-working order for a (symbol, side), or null.
   *
   * "Working" means the order is live at the exchange: NEW, PARTIALLY_FILLED or
   * UNKNOWN. A second decision must not be turned into a second order while one
   * of these is still outstanding.
   */
  findWorkingOrder(symbol, side) {
    let found = null;
    for (const o of this.orders.values()) {
      if (!OPEN_STATUSES.includes(o.status)) continue;
      if (o.symbol !== symbol || o.side !== side) continue;
      if (found === null || (o.submittedTs ?? 0) < (found.submittedTs ?? 0)) found = o;
    }
    return found;
  }

  listAllOrders() {
    return [...this.orders.values()];
  }

  listFills(orderId = null) {
    if (orderId) return this.fills.get(orderId) ?? [];
    return [...this.fills.values()].flat();
  }

  /**
   * Accept an order into the book.
   * @returns {{ status, order, rejectionReason }}
   */
  submit(order) {
    const inst = this.instrument(order.symbol);
    if (!inst && this.#cfg.rejectsUnknownSymbol) {
      return { status: 'REJECTED', order: null, rejectionReason: `UNKNOWN_SYMBOL:${order.symbol}` };
    }
    if (!(order.quantity > 0)) {
      return { status: 'REJECTED', order: null, rejectionReason: 'NON_POSITIVE_QUANTITY' };
    }
    if (!Number.isFinite(order.expectedPrice) || order.expectedPrice <= 0) {
      return { status: 'REJECTED', order: null, rejectionReason: 'INVALID_EXPECTED_PRICE' };
    }
    const record = {
      ...order,
      status: 'NEW',
      filledQuantity: 0,
      avgFillPrice: null,
      feesPaidEgp: 0,
      slippageCostEgp: 0,
      cancelReason: null,
      submittedTs: order.submittedTs,
      updatedTs: order.submittedTs,
    };
    this.orders.set(order.orderId, record);
    this.fills.set(order.orderId, []);
    return { status: 'NEW', order: { ...record }, rejectionReason: null };
  }

  /**
   * Attempt to fill against a quote. Called once per tick for every open order.
   *
   * An order the fill guard refuses is CANCELED here, with the reason recorded
   * on the order, and reported back to the caller so the cancel can be persisted.
   * Nothing about an impossible fill is left to throw later.
   *
   * @returns {{ fills: Array<Fill>, canceled: Array<{orderId, reason, filledQuantity, remainingQuantity}> }}
   */
  match(quote) {
    const produced = [];
    const canceled = [];
    for (const order of this.orders.values()) {
      if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') continue;
      if (order.symbol !== quote.symbol) continue;
      const inst = this.instrument(quote.symbol);
      if (!inst) continue;

      const refPrice = order.side === 'BUY' ? quote.ask : quote.bid;

      if (order.orderType === 'LIMIT') {
        const marketable = order.side === 'BUY' ? refPrice <= order.limitPrice : refPrice >= order.limitPrice;
        if (!marketable) continue;
      }

      const remaining = roundTo(order.quantity - order.filledQuantity, 8);
      if (remaining <= 0) continue;

      // fill ratio
      let ratio = 1;
      if (this.#rng.bool(this.#cfg.partialFillProbabilityPct)) {
        ratio = this.#rng.uniform(this.#cfg.minFillRatio, this.#cfg.maxFillRatio);
      }
      let qty = roundTo(remaining * ratio, 8);
      // respect the instrument quantity step
      qty = Math.max(roundTo(Math.floor(qty / inst.qtyStep) * inst.qtyStep, 8), 0);
      if (qty <= 0) continue;
      qty = Math.min(qty, remaining);

      // ---- fill guard: can this fill actually be applied? -----------------
      const guard = this.#guardFill(order, quote, qty);
      if (!guard.allowed) {
        order.status = 'CANCELED';
        order.cancelReason = guard.reason;
        order.updatedTs = quote.tsMs;
        canceled.push({
          orderId: order.orderId,
          reason: guard.reason,
          filledQuantity: roundTo(order.filledQuantity, 8),
          remainingQuantity: roundTo(order.quantity - order.filledQuantity, 8),
        });
        continue;
      }
      if (guard.quantity < qty) {
        // Cap to the guard's limit, then re-apply the instrument step.
        qty = Math.max(roundTo(Math.floor(guard.quantity / inst.qtyStep) * inst.qtyStep, 8), 0);
        qty = Math.min(qty, remaining);
        if (qty <= 0) {
          order.status = 'CANCELED';
          order.cancelReason = guard.reason ?? 'FILL_CAPPED_TO_ZERO';
          order.updatedTs = quote.tsMs;
          canceled.push({
            orderId: order.orderId,
            reason: order.cancelReason,
            filledQuantity: roundTo(order.filledQuantity, 8),
            remainingQuantity: roundTo(order.quantity - order.filledQuantity, 8),
          });
          continue;
        }
      }

      const notional = qty * refPrice;
      const { price, slippageBps } = this.#slippageModel.apply({
        side: order.side, mid: quote.mid, spreadBps: quote.spreadBps, notionalEgp: notional,
      });
      const fillPrice = inst.tickSize > 0 ? roundTo(price, 6) : price;
      const feeEgp = this.#feeModel.compute('TAKER', qty * fillPrice);
      // slippage cost measured against the mid price the decision expected
      const slippageCost = Math.abs(qty * (fillPrice - quote.mid));

      const fill = {
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        decisionId: order.decisionId,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        price: fillPrice,
        referencePrice: quote.mid,
        notionalEgp: qty * fillPrice,
        feeEgp,
        slippageBps,
        slippageCostEgp: slippageCost,
        liquidity: 'TAKER',
        tsMs: quote.tsMs,
      };
      this.fills.get(order.orderId).push(fill);
      produced.push(fill);

      const prevFilled = order.filledQuantity;
      const prevNotional = prevFilled * (order.avgFillPrice ?? fillPrice);
      order.filledQuantity = roundTo(prevFilled + qty, 8);
      order.avgFillPrice = roundTo((prevNotional + qty * fillPrice) / order.filledQuantity, 8);
      order.feesPaidEgp = Math.round((order.feesPaidEgp + feeEgp) * 100) / 100;
      order.slippageCostEgp = Math.round((order.slippageCostEgp + slippageCost) * 100) / 100;
      order.updatedTs = quote.tsMs;

      const done = order.filledQuantity >= order.quantity - 1e-9;
      order.status = done ? 'FILLED' : 'PARTIALLY_FILLED';
    }
    return { fills: produced, canceled };
  }

  /** @returns {boolean} whether the order was still open */
  cancel(orderId, tsMs, reason = 'CANCELED_BY_CLIENT') {
    const o = this.orders.get(orderId);
    if (!o) throw new InvalidOrderError(`Cannot cancel unknown order ${orderId}`, { orderId });
    if (!OPEN_STATUSES.includes(o.status)) return false;
    o.status = 'CANCELED';
    o.cancelReason = reason;
    o.updatedTs = tsMs;
    return true;
  }

  /** Re-drive a partially filled order at a later price (paper simplification). */
  markStatusUnknown(orderId, tsMs) {
    const o = this.orders.get(orderId);
    if (!o) return null;
    if (OPEN_STATUSES.includes(o.status)) {
      o.status = 'UNKNOWN';
      o.updatedTs = tsMs;
    }
    return o;
  }
}
