/**
 * TEOS Trade Agent - core/assert.js
 * Small validation helpers used at trust boundaries (config, order payloads,
 * broker responses). Failures throw typed errors so the risk engine can map
 * them to a rule outcome instead of a generic crash.
 */

import { ConfigError, InvalidOrderError, ValidationError } from './errors.js';

export function assert(condition, message, details = {}, Err = ValidationError) {
  if (!condition) throw new Err(message, details);
  return true;
}

export function requireNumber(value, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  assert(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number`, { name, value });
  if (integer) assert(Number.isInteger(value), `${name} must be an integer`, { name, value });
  assert(value >= min, `${name} must be >= ${min}`, { name, value, min });
  assert(value <= max, `${name} must be <= ${max}`, { name, value, max });
  return value;
}

export function requireString(value, name, { maxLength = 512, pattern = null } = {}) {
  assert(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`, { name });
  assert(value.length <= maxLength, `${name} exceeds max length ${maxLength}`, { name, maxLength });
  if (pattern) assert(pattern.test(value), `${name} does not match required pattern`, { name, pattern: String(pattern) });
  return value;
}

export function requireEnum(value, name, allowed, Err = ValidationError) {
  assert(allowed.includes(value), `${name} must be one of ${allowed.join(', ')}`, { name, value, allowed }, Err);
  return value;
}

export function requirePlainObject(value, name) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} must be a plain object`,
    { name },
    ConfigError,
  );
  return value;
}

export function requireArray(value, name, { minLength = 0 } = {}) {
  assert(Array.isArray(value), `${name} must be an array`, { name }, ConfigError);
  assert(value.length >= minLength, `${name} must contain at least ${minLength} entries`, { name, minLength }, ConfigError);
  return value;
}

/** Order-specific assertions. All failures are INVALID_ORDER. */
export function requireValidOrderShape(order) {
  requirePlainObject(order, 'order');
  requireString(order.symbol, 'order.symbol', { maxLength: 32 });
  requireEnum(order.side, 'order.side', ['BUY', 'SELL'], InvalidOrderError);
  requireEnum(order.orderType, 'order.orderType', ['MARKET', 'LIMIT'], InvalidOrderError);
  requireNumber(order.quantity, 'order.quantity', { min: Number.MIN_VALUE });
  requireString(order.clientOrderId, 'order.clientOrderId', { maxLength: 64, pattern: /^[A-Za-z0-9_-]{6,64}$/ });
  if (order.orderType === 'LIMIT') {
    requireNumber(order.limitPrice, 'order.limitPrice', { min: Number.MIN_VALUE });
  }
  assert(order.leverageRequested === false, 'Leverage is not permitted. order.leverageRequested must be false.', { order }, InvalidOrderError);
  assert(order.borrowRequested !== true, 'Borrowing is not permitted. order.borrowRequested must not be true.', { order }, InvalidOrderError);
  return true;
}
