/**
 * TEOS Trade Agent - execution/validator.js
 *
 * Order validation. The LAST chance to catch a malformed order before it
 * reaches the broker. Deliberately paranoid and deliberately independent of
 * the risk engine: two different implementations of the same invariants means a
 * bug in one is unlikely to be mirrored in the other.
 */

import { requireValidOrderShape } from '../core/assert.js';
import { InvalidOrderError, ValidationError } from '../core/errors.js';
import { roundTo } from '../core/money.js';

export const ORDER_TYPES = ['MARKET', 'LIMIT'];
export const SIDES = ['BUY', 'SELL'];

/**
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
export function validateOrder(order, { instrument = null, account = null, now = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!order || typeof order !== 'object') {
    return { ok: false, errors: ['order must be an object'], warnings };
  }

  // --- shape -------------------------------------------------------------
  try {
    requireValidOrderShape(order);
  } catch (err) {
    errors.push(err.message);
  }

  // --- prohibited features ----------------------------------------------
  if (order.leverageRequested === true) errors.push('leverageRequested must be false');
  if (order.borrowRequested === true) errors.push('borrowRequested must not be true');
  if (order.marginRequested === true) errors.push('marginRequested must not be true');
  if (order.shortRequested === true) errors.push('shortRequested must not be true');
  if (order.orderType === 'DERIVATIVE' || order.instrumentType === 'FUTURE' || order.instrumentType === 'PERPETUAL') {
    errors.push('derivative instruments are not permitted');
  }

  // --- client order id ---------------------------------------------------
  if (typeof order.clientOrderId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(order.clientOrderId)) {
    errors.push(`invalid clientOrderId: ${order.clientOrderId}`);
  }

  // --- numeric sanity ----------------------------------------------------
  if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
    errors.push(`quantity must be a positive finite number, got ${order.quantity}`);
  }
  if (!Number.isFinite(order.expectedPrice) || order.expectedPrice <= 0) {
    errors.push(`expectedPrice must be a positive finite number, got ${order.expectedPrice}`);
  }
  if (order.orderType === 'LIMIT' && (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0)) {
    errors.push('LIMIT orders require a positive limitPrice');
  }
  if (order.orderType === 'MARKET' && order.limitPrice != null) {
    warnings.push('MARKET order carries a limitPrice; it will be ignored');
  }

  // --- cross the spread in the right direction ---------------------------
  if (instrument) {
    if (order.symbol !== instrument.symbol) {
      errors.push(`order symbol ${order.symbol} does not match instrument ${instrument.symbol}`);
    }
    const px = order.orderType === 'LIMIT' ? order.limitPrice : order.expectedPrice;
    if (Number.isFinite(px)) {
      if (order.side === 'BUY' && px < instrument.startPrice * 0.001) errors.push('BUY price implausibly below the instrument reference');
      if (order.side === 'SELL' && px > instrument.startPrice * 1000) errors.push('SELL price implausibly above the instrument reference');
    }
    if (Number.isFinite(order.quantity) && order.quantity < instrument.minQty) {
      errors.push(`quantity ${order.quantity} below instrument minimum ${instrument.minQty}`);
    }
    if (Number.isFinite(order.quantity)) {
      const steps = order.quantity / instrument.qtyStep;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        warnings.push(`quantity ${order.quantity} is not a multiple of qtyStep ${instrument.qtyStep}`);
      }
    }
  } else {
    errors.push(`unknown instrument for order symbol ${order.symbol}`);
  }

  // --- account-level sanity ---------------------------------------------
  if (account && order.side === 'BUY') {
    const notional = order.quantity * order.expectedPrice;
    if (notional > account.cashEgp * 1.0000001) {
      errors.push(`BUY notional EGP ${roundTo(notional, 2)} exceeds available cash EGP ${account.cashEgp}`);
    }
  }
  if (order.side === 'SELL' && order.shortRequested === true) {
    errors.push('short selling is not permitted in this account');
  }
  if (now != null && order.submittedTs != null && order.submittedTs > now + 60_000) {
    errors.push('submittedTs is in the future');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Throwing variant used by the execution adapter. */
export function assertValidOrder(order, ctx) {
  const v = validateOrder(order, ctx);
  if (!v.ok) {
    throw new InvalidOrderError(`Order validation failed: ${v.errors.join('; ')}`, { errors: v.errors, warnings: v.warnings, order });
  }
  return v;
}

export { ValidationError };
