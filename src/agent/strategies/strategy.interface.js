/**
 * TEOS Trade Agent - agent/strategies/strategy.interface.js
 *
 * A strategy is a pure function:
 *
 *     evaluate(ctx) -> Signal
 *
 * It receives market context and portfolio state and returns a proposal. It
 * MUST NOT place orders, touch the database, or know that a risk engine or a
 * sentinel exist. That separation is what makes strategies independently
 * testable and swappable.
 *
 * Signal contract
 *   signal          : 'BUY' | 'SELL' | 'HOLD'
 *   confidence      : 0..1  (a heuristic score, NOT a probability of profit)
 *   reason          : human-readable explanation
 *   features        : object of indicator values used, for the audit trail
 *   stopPrice       : absolute price of the stop, or null for HOLD
 *   targetPrice     : absolute price of the target, or null
 *   stopDistancePct : percent distance to the stop
 *   riskRewardRatio : target distance / stop distance
 *   meta            : arbitrary strategy-specific extras
 *
 * IMPORTANT: no claim of profitability is made or implied anywhere. A
 * confidence value is a relative strength score used for sizing and for the
 * Sentinel's REVIEW threshold. It is not an expected return.
 */

export const SIGNALS = Object.freeze(['BUY', 'SELL', 'HOLD']);

/** Strategy implementation contract. */
export const STRATEGY_INTERFACE = Object.freeze([
  'id', 'description', 'minBars', 'defaultParams', 'evaluate',
]);

export function assertStrategyShape(strategy) {
  for (const key of STRATEGY_INTERFACE) {
    if (!(key in strategy)) {
      throw new Error(`Strategy "${strategy?.id ?? 'unknown'}" is missing required member "${key}".`);
    }
  }
  if (typeof strategy.evaluate !== 'function') {
    throw new Error(`Strategy "${strategy.id}" evaluate() must be a function.`);
  }
  if (typeof strategy.minBars !== 'number' || strategy.minBars < 2) {
    throw new Error(`Strategy "${strategy.id}" must declare a numeric minBars >= 2.`);
  }
  return true;
}

export function makeSignal({
  signal, confidence = 0, reason, features = {}, stopPrice = null, targetPrice = null,
  stopDistancePct = null, riskRewardRatio = null, meta = {},
}) {
  if (!SIGNALS.includes(signal)) {
    throw new Error(`Invalid signal "${signal}". Expected one of ${SIGNALS.join(', ')}.`);
  }
  return {
    signal,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason,
    features,
    stopPrice,
    targetPrice,
    stopDistancePct,
    riskRewardRatio,
    meta,
  };
}

export const hold = (reason, features = {}, meta = {}) => makeSignal({
  signal: 'HOLD', confidence: 0, reason, features, meta,
});

/**
 * Stop-distance band.
 *
 * The risk policy forbids a stop closer than `minStopDistancePct` (a stop
 * inside ordinary tick noise is not a risk control) and further than
 * `maxStopDistancePct` (the position would be sized to a loss it can never
 * reach). Strategies compute a raw ATR/structure stop and then PASS IT THROUGH
 * THIS BAND, so a strategy never proposes an order the risk engine is obliged
 * to refuse. The risk engine clamps again, defensively, before the order is
 * validated - the two must agree, and this function is the shared definition of
 * "agree".
 */
export const DEFAULT_STOP_BAND = Object.freeze({ minPct: 0.25, maxPct: 5.0 });

/**
 * Clamp a raw stop into the policy band and derive the target from the CLAMPED
 * stop, so a widened stop never leaves the reward distance stale.
 *
 * @param {object}  p
 * @param {number}  p.price            current price
 * @param {number}  p.rawStopPrice     the stop the strategy would like
 * @param {object}  [p.band]           { minPct, maxPct }
 * @param {number}  [p.rewardMultiple] R multiple to project a target from
 * @returns {{ stopPrice, stopDistancePct, targetPrice, riskRewardRatio, rawStopDistancePct, clamped }}
 */
export function resolveStop({ price, rawStopPrice, band = DEFAULT_STOP_BAND, rewardMultiple = null }) {
  if (!(price > 0) || rawStopPrice == null || !Number.isFinite(rawStopPrice)) {
    return {
      stopPrice: null, stopDistancePct: null, targetPrice: null,
      riskRewardRatio: null, rawStopDistancePct: null, clamped: false,
    };
  }
  const minPct = band?.minPct ?? DEFAULT_STOP_BAND.minPct;
  const maxPct = band?.maxPct ?? DEFAULT_STOP_BAND.maxPct;

  // Long-only: the stop is always below the entry, so measure it downward.
  const rawPct = Math.max(0, ((price - rawStopPrice) / price) * 100);
  const effectivePct = Math.min(maxPct, Math.max(minPct, rawPct));
  const clamped = effectivePct !== rawPct;

  const stopPrice = price * (1 - effectivePct / 100);
  const stopDistance = price - stopPrice;
  const targetPrice = rewardMultiple != null && rewardMultiple > 0
    ? price + stopDistance * rewardMultiple
    : null;

  return {
    stopPrice,
    stopDistancePct: effectivePct,
    targetPrice,
    riskRewardRatio: targetPrice != null ? (targetPrice - price) / stopDistance : null,
    rawStopDistancePct: rawPct,
    clamped,
  };
}

/**
 * Whether a SELL/EXIT signal is meaningful. The account is long-only and
 * cash-funded, so a SELL is "reduce or close an existing long" - never a short.
 * Emitting one with no position produces a zero-quantity order intent, which
 * the risk engine must (and does) refuse. Suppressing it here keeps the audit
 * trail honest instead of padding it with structurally impossible intents.
 */
export function hasLongToExit(position) {
  return position != null && Number(position.quantity) > 0;
}
