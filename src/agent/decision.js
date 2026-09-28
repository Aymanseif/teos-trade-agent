/**
 * TEOS Trade Agent - agent/decision.js
 *
 * The Decision record. EVERY agent action produces one of these, and every
 * field required by the specification is mandatory and validated:
 *
 *   timestamp              yes
 *   asset (symbol)         yes
 *   market price           yes
 *   signal                 yes  BUY | SELL | HOLD
 *   position size          yes
 *   risk calculation       yes
 *   reason / features      yes
 *   expected execution px  yes
 *   stop condition         yes for BUY/SELL
 *   resulting action       yes
 *
 * A Decision is immutable once built. `sealDecision` deep-freezes it, so a
 * downstream component cannot rewrite history before the audit write.
 */

import { makeSignal, SIGNALS } from './strategies/strategy.interface.js';
import { newId } from '../core/ids.js';
import { roundEgp, roundTo } from '../core/money.js';
import { ValidationError } from '../core/errors.js';

export const ACTIONS = Object.freeze([
  'PLACE_ORDER',   // intended to place an order; still must pass risk + sentinel
  'SKIP',          // deliberately no action (HOLD, warm-up, insufficient setup)
  'QUARANTINE',    // withheld pending manual review (Sentinel REVIEW)
  'REJECT',        // blocked by risk engine or Sentinel
  'HALT',          // no action: the agent is not permitted to trade
]);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {string} input.strategyId
 * @param {number} input.price          market price at decision time
 * @param {object} input.signalObj      output of strategy.evaluate()
 * @param {object} input.risk           { riskBudgetEgp, maxLossEgp, stopDistancePct, sizePctEquity, ... }
 * @param {number} input.quantity
 * @param {number} input.notionalEgp
 * @param {number} input.expectedExecutionPrice
 * @param {string} input.stopCondition  human-readable stop description
 * @param {string} input.action
 * @param {string} input.agentState
 * @param {object} [input.clock]
 */
export function sealDecision(input) {
  const {
    symbol, strategyId, price, signalObj, risk, quantity, notionalEgp,
    expectedExecutionPrice, stopCondition, action, agentState, clock,
    positionSizeSource = 'RISK_SIZED', permissions = null,
  } = input;

  if (!SIGNALS.includes(signalObj.signal)) {
    throw new ValidationError(`Decision signal must be one of ${SIGNALS.join('|')}`, { signal: signalObj.signal });
  }
  if (!ACTIONS.includes(action)) {
    throw new ValidationError(`Decision action must be one of ${ACTIONS.join('|')}`, { action });
  }
  if (!(price > 0)) throw new ValidationError('Decision price must be > 0', { price });

  const isEntry = signalObj.signal !== 'HOLD';
  if (isEntry && action === 'PLACE_ORDER' && !stopCondition) {
    throw new ValidationError('An order-intent decision must carry a stop condition.', { symbol });
  }

  const decision = {
    decisionId: newId('dec'),
    timestamp: clock.nowIso(),
    tsMs: clock.now(),

    // --- market ---------------------------------------------------------
    asset: symbol,
    symbol,
    marketPrice: roundTo(price, 8),
    strategyId,

    // --- signal ---------------------------------------------------------
    signal: signalObj.signal,
    confidence: roundTo(signalObj.confidence, 6),
    reason: signalObj.reason,
    features: signalObj.features ?? {},
    strategyMeta: signalObj.meta ?? {},

    // --- position size --------------------------------------------------
    positionSize: roundTo(quantity ?? 0, 8),
    quantity: roundTo(quantity ?? 0, 8),
    notionalEgp: roundEgp(notionalEgp ?? 0),
    positionSizeSource,

    // --- risk -----------------------------------------------------------
    risk: {
      riskBudgetEgp: roundEgp(risk?.riskBudgetEgp ?? 0),
      maxLossEgp: roundEgp(risk?.maxLossEgp ?? 0),
      stopDistancePct: roundTo(risk?.stopDistancePct ?? signalObj.stopDistancePct ?? 0, 6),
      riskRewardRatio: roundTo(risk?.riskRewardRatio ?? signalObj.riskRewardRatio ?? 0, 6),
      sizePctOfEquity: roundTo(risk?.sizePctOfEquity ?? 0, 6),
      stopPrice: risk?.stopPrice ?? signalObj.stopPrice ?? null,
      targetPrice: signalObj.targetPrice ?? null,
      feeBpsEstimate: roundTo(risk?.feeBpsEstimate ?? 0, 4),
      expectedSlippageBps: roundTo(risk?.expectedSlippageBps ?? 0, 4),
    },

    // --- execution ------------------------------------------------------
    expectedExecutionPrice: roundTo(expectedExecutionPrice ?? price, 8),
    expectedSlippageEgp: roundEgp(risk?.expectedSlippageEgp ?? 0),
    stopCondition: stopCondition ?? null,
    stopPrice: risk?.stopPrice ?? signalObj.stopPrice ?? null,

    // --- outcome --------------------------------------------------------
    action,
    agentState,
    // The permission matrix for the state this decision was made in. Carried
    // on the record so the risk engine can authorise a risk-REDUCING exit from
    // a state that forbids opening new positions.
    permissions,
  };

  return deepFreeze(decision);
}

/** Map a Decision to the row shape expected by the repositories layer. */
export function decisionToRow(d) {
  return {
    decisionId: d.decisionId,
    symbol: d.symbol,
    strategyId: d.strategyId,
    price: d.marketPrice,
    signal: d.signal,
    quantity: d.positionSize,
    notionalEgp: d.notionalEgp,
    confidence: d.confidence,
    maxLossEgp: d.risk.maxLossEgp,
    stopPrice: d.risk.stopPrice,
    stopDistancePct: d.risk.stopDistancePct,
    riskRewardRatio: d.risk.riskRewardRatio,
    reason: d.reason,
    features: d.features,
    expectedExecutionPrice: d.expectedExecutionPrice,
    stopCondition: d.stopCondition,
    action: d.action,
    agentState: d.agentState,
  };
}

export { makeSignal };
