/**
 * TEOS Trade Agent - broker/broker.interface.js
 *
 * Exchange / broker abstraction. The agent, risk engine and sentinel only ever
 * talk to this interface, so swapping the paper provider for a real adapter
 * later is a contained change.
 *
 * Phase 1 registers exactly ONE implementation: the mock paper broker.
 * Registering a live provider is impossible: `registerBroker` refuses any
 * provider that is not explicitly marked `paper: true`.
 */

import { ModeNotAllowedError, ValidationError } from '../core/errors.js';

export const PROVIDER_KINDS = ['PAPER']; // LIVE is absent in Phase 1.

/**
 * Required interface (documented contract). Any implementation must provide:
 *
 *   providerId                 : string
 *   kind                       : 'PAPER'
 *   isPaper()                  : boolean  -> always true in Phase 1
 *   connect()                  : Promise<{ ok, detail }>
 *   health()                   : { ok, lastErrorAt, consecutiveFailures, detail }
 *   getMarketData(symbol?)      : { symbol, bid, ask, last, mid, ts, tsMs, spreadBps, source, seq }
 *   get_market_data()          : alias
 *   getBalance()               : { cashEgp, equityEgp, startingCapitalEgp, currency }
 *   get_balance()              : alias
 *   getPositions()             : Position[]
 *   get_positions()            : alias
 *   getOpenOrders()            : Order[]
 *   get_open_orders()          : alias
 *   placeOrder(order)          : OrderAck
 *   place_order(order)         : alias
 *   cancelOrder(orderId)       : { canceled, order }
 *   cancel_order(orderId)      : alias
 *   mark(symbol, price)        : unrealized P&L marking (paper only)
 *   tick()                     : advance the simulated clock/market one step
 */
export const BROKER_INTERFACE = Object.freeze([
  'connect', 'health', 'getMarketData', 'getBalance', 'getPositions', 'getOpenOrders',
  'placeOrder', 'cancelOrder', 'mark', 'tick',
]);

export function assertBrokerShape(broker) {
  for (const m of BROKER_INTERFACE) {
    if (typeof broker[m] !== 'function') {
      throw new ValidationError(`Broker is missing required method: ${m}()`, { broker: broker?.providerId });
    }
  }
  if (broker.isPaper?.() !== true) {
    throw new ModeNotAllowedError('Only paper brokers may be registered in Phase 1.', { providerId: broker?.providerId });
  }
  return true;
}

const registry = new Map();

export function registerBroker(broker) {
  assertBrokerShape(broker);
  if (broker.kind !== 'PAPER') {
    throw new ModeNotAllowedError(`Refusing to register non-paper broker of kind "${broker.kind}".`, { providerId: broker.providerId });
  }
  registry.set(broker.providerId, broker);
  return broker;
}

export function getBroker(providerId) {
  const b = registry.get(providerId);
  if (!b) throw new ValidationError(`Unknown broker provider "${providerId}".`, { available: [...registry.keys()] });
  return b;
}

export function listBrokers() {
  return [...registry.keys()];
}

/** Unregister: used by tests to guarantee isolation between cases. */
export function resetBrokers() {
  registry.clear();
}
