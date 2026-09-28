/**
 * TEOS Trade Agent - risk/rules/index.js
 *
 * Every risk rule is a pure function of (ctx) -> RuleResult.
 *
 *   RuleResult = { rule, status, detail, data, severity }
 *   status     = 'PASS' | 'WARN' | 'BLOCK'
 *
 * `severity` drives what the engine does on failure:
 *   'BLOCK'  -> refuse the order, and latch an emergency stop when
 *               `latchesStop` is true
 *   'WARN'   -> allow, but record why
 *
 * A rule NEVER throws. If a rule throws, the engine converts the exception into
 * a BLOCK with the exception as detail. A broken rule must never accidentally
 * behave like a passing rule.
 */

import { roundEgp, roundTo, toMinor } from '../../core/money.js';

const pass = (rule, detail = '', data = {}) => ({ rule, status: 'PASS', detail, data, severity: 'BLOCK', latchesStop: false });
const warn = (rule, detail, data = {}, severity = 'WARN') => ({ rule, status: 'WARN', detail, data, severity, latchesStop: false });
const block = (rule, detail, data = {}, { severity = 'BLOCK', latchesStop = false } = {}) => ({ rule, status: 'BLOCK', detail, data, severity, latchesStop });

/**
 * Tolerance for percentage-limit comparisons, in percentage points.
 *
 * Prices in an order are stored rounded to 8 decimals, and the rules
 * deliberately re-derive percentages from those prices rather than trusting a
 * reported field. Reading back a stop placed exactly at the policy minimum
 * therefore lands a few 1e-8 points either side of the limit. Refusing an order
 * on that artefact would be a false refusal, so boundary comparisons carry this
 * tolerance.
 *
 * 1e-6 percentage points is 0.0001 bps. The smallest tick in the instrument
 * universe is 0.0001 on a price of 48.75, i.e. 0.0002% - two hundred times
 * larger - so this cannot mask a genuine breach.
 */
const PCT_EPSILON = 1e-6;

/**
 * Rule registry. ORDER MATTERS: the engine evaluates top to bottom and returns
 * on the first BLOCK, so cheap/absolute prohibitions run before numeric ones.
 */
export const RULES = [
  // ---- 1. absolute prohibitions -----------------------------------------
  {
    id: 'NO_LEVERAGE',
    description: 'Leverage, margin, borrowing and derivatives are prohibited. No path may create them.',
    evaluate({ decision }) {
      if (decision.leverageRequested || decision.borrowRequested || decision.derivative) {
        return block('NO_LEVERAGE', 'Order requests leverage/borrowing/derivatives, which are prohibited.', {
          leverageRequested: decision.leverageRequested ?? false,
          borrowRequested: decision.borrowRequested ?? false,
        }, { severity: 'CATASTROPHIC', latchesStop: true });
      }
      return pass('NO_LEVERAGE', 'no leverage, no borrowing, no derivatives');
    },
  },
  {
    id: 'KILL_SWITCH',
    description: 'An engaged emergency stop blocks every new order immediately.',
    evaluate({ killSwitch }) {
      if (killSwitch.engaged) {
        return block('KILL_SWITCH', `Emergency stop engaged: ${killSwitch.reason ?? 'unspecified'}.`, {
          trigger: killSwitch.trigger ?? null, since: killSwitch.since ?? null, scope: killSwitch.scope ?? 'NEW_ORDERS',
        }, { severity: 'CATASTROPHIC', latchesStop: false });
      }
      return pass('KILL_SWITCH', 'kill switch clear');
    },
  },
  {
    id: 'AGENT_STATE',
    description:
      'Only the HEALTHY agent state may open new positions. Exits that reduce existing exposure are '
      + 'permitted in any state that allows reduceOnly, so risk can always be taken off. '
      + 'Any undefined state stops trading entirely.',
    evaluate({ agentState, permissions, side }) {
      if (agentState === 'UNDEFINED' || agentState == null) {
        return block('AGENT_STATE', `Agent is in an undefined state ("${agentState}"). Trading stopped.`, { agentState },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (!permissions) {
        return block('AGENT_STATE',
          `No permission matrix supplied for agent state ${agentState}; refusing to authorise.`,
          { agentState }, { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (side === 'SELL') {
        if (permissions.reduceOnly === true) {
          return pass('AGENT_STATE', `agent state ${agentState} permits reducing exposure`,
            { agentState, permissions });
        }
        return block('AGENT_STATE', `Agent state ${agentState} does not permit any order.`, {
          agentState, permissions,
        }, { severity: 'CRITICAL', latchesStop: false });
      }
      if (permissions.openPosition !== true) {
        return block('AGENT_STATE', `Agent state ${agentState} does not permit opening positions.`, {
          agentState, permissions,
        }, { severity: 'CRITICAL', latchesStop: false });
      }
      return pass('AGENT_STATE', `agent state ${agentState} permits new positions`);
    },
  },

  // ---- 2. connectivity and data quality ---------------------------------
  {
    id: 'CONNECTION',
    description: 'If the broker/market-data connection fails, trading stops.',
    evaluate({ brokerHealth, limits }) {
      if (!brokerHealth) {
        return block('CONNECTION', 'No broker health information available.', {}, { severity: 'CRITICAL', latchesStop: true });
      }
      if (brokerHealth.consecutiveFailures >= limits.consecutiveFailureHaltCount) {
        return block('CONNECTION',
          `Broker connection failing: ${brokerHealth.consecutiveFailures} consecutive failures (limit ${limits.consecutiveFailureHaltCount}).`,
          { consecutiveFailures: brokerHealth.consecutiveFailures, lastErrorAt: brokerHealth.lastErrorAt },
          { severity: 'CRITICAL', latchesStop: true });
      }
      if (brokerHealth.connected === false) {
        return block('CONNECTION', 'Broker is disconnected.', { health: brokerHealth },
          { severity: 'CRITICAL', latchesStop: true });
      }
      if (brokerHealth.consecutiveFailures > 0) {
        return warn('CONNECTION', `Broker has ${brokerHealth.consecutiveFailures} recent failure(s).`, { brokerHealth });
      }
      return pass('CONNECTION', 'connection healthy');
    },
  },
  {
    id: 'DATA_FRESHNESS',
    description: 'If market data becomes stale, STOP trading.',
    evaluate({ quote, nowMs, limits }) {
      if (!quote) {
        return block('DATA_FRESHNESS', 'No market data available for the symbol.', {}, { severity: 'CRITICAL', latchesStop: true });
      }
      const age = nowMs - quote.tsMs;
      if (age > limits.maxDataStalenessMs) {
        return block('DATA_FRESHNESS',
          `Market data is stale: ${age}ms old (limit ${limits.maxDataStalenessMs}ms).`,
          { ageMs: age, limitMs: limits.maxDataStalenessMs, symbol: quote.symbol },
          { severity: 'CRITICAL', latchesStop: true });
      }
      if (age > limits.degradedDataFreshnessMs) {
        return warn('DATA_FRESHNESS', `Market data is ageing: ${age}ms old.`, { ageMs: age });
      }
      return pass('DATA_FRESHNESS', `data ${age}ms old`, { ageMs: age });
    },
  },
  {
    id: 'PRICE_SANITY',
    description: 'Abnormal price movement or an abnormal spread stops trading.',
    evaluate({ quote, referencePrice, limits }) {
      if (!(quote.mid > 0) || !Number.isFinite(quote.mid)) {
        return block('PRICE_SANITY', `Non-positive or non-finite price for ${quote.symbol}.`, { mid: quote.mid },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (quote.spreadBps > limits.maxSpreadBps) {
        return block('PRICE_SANITY',
          `Spread ${quote.spreadBps.toFixed(2)}bps exceeds limit ${limits.maxSpreadBps}bps.`,
          { spreadBps: quote.spreadBps, limitBps: limits.maxSpreadBps },
          { severity: 'CRITICAL', latchesStop: true });
      }
      if (referencePrice != null && referencePrice > 0) {
        const moveBps = Math.abs((quote.mid - referencePrice) / referencePrice) * 10_000;
        if (moveBps > limits.priceDeviationLimitBps) {
          return block('PRICE_SANITY',
            `Abnormal price movement: ${moveBps.toFixed(1)}bps from reference ${referencePrice} (limit ${limits.priceDeviationLimitBps}bps).`,
            { moveBps, limitBps: limits.priceDeviationLimitBps, referencePrice, mid: quote.mid },
            { severity: 'CRITICAL', latchesStop: true });
        }
        if (moveBps > limits.priceDeviationLimitBps * 0.6) {
          return warn('PRICE_SANITY', `Elevated price movement: ${moveBps.toFixed(1)}bps from reference.`, { moveBps });
        }
      }
      return pass('PRICE_SANITY', `spread ${quote.spreadBps.toFixed(2)}bps`);
    },
  },

  // ---- 3. account-level hard limits -------------------------------------
  {
    id: 'MAX_CAPITAL',
    description: 'Maximum starting capital is EGP 500. Equity above the cap means the account is outside policy.',
    evaluate({ account, limits }) {
      if (account.equityEgp > limits.maxStartingCapitalEgp * 1.5) {
        return block('MAX_CAPITAL',
          `Equity EGP ${roundEgp(account.equityEgp)} is far above the EGP ${limits.maxStartingCapitalEgp} cap. Account state is inconsistent.`,
          { equityEgp: account.equityEgp, cap: limits.maxStartingCapitalEgp },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (account.startingCapitalEgp > limits.maxStartingCapitalEgp) {
        return block('MAX_CAPITAL',
          `Starting capital EGP ${account.startingCapitalEgp} exceeds the EGP ${limits.maxStartingCapitalEgp} maximum.`,
          { startingCapitalEgp: account.startingCapitalEgp, cap: limits.maxStartingCapitalEgp },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (account.equityEgp <= 0) {
        return block('MAX_CAPITAL', `Equity is EGP ${account.equityEgp}. Account is exhausted.`,
          { equityEgp: account.equityEgp }, { severity: 'CRITICAL', latchesStop: true });
      }
      return pass('MAX_CAPITAL', `equity EGP ${roundEgp(account.equityEgp)} within cap`);
    },
  },
  {
    id: 'NO_NEGATIVE_CASH',
    description: 'Cash may never be negative. This is what makes borrowing structurally impossible.',
    evaluate({ account }) {
      if (toMinor(account.cashEgp) < 0) {
        return block('NO_NEGATIVE_CASH',
          `Cash is negative: EGP ${account.cashEgp}. Borrowing is prohibited.`,
          { cashEgp: account.cashEgp }, { severity: 'CATASTROPHIC', latchesStop: true });
      }
      return pass('NO_NEGATIVE_CASH', `cash EGP ${roundEgp(account.cashEgp)}`);
    },
  },
  {
    id: 'DAILY_LOSS',
    description: 'Configurable daily loss limit. Realised plus unrealised loss is measured against it.',
    evaluate({ dailyLoss, limits, account }) {
      const lossEgp = roundEgp(Math.max(0, -(dailyLoss.realizedEgp + dailyLoss.unrealizedEgp)));
      if (lossEgp >= limits.dailyLossLimitEgp) {
        return block('DAILY_LOSS',
          `Daily loss EGP ${lossEgp} has reached the EGP ${limits.dailyLossLimitEgp} limit. No new orders today.`,
          { lossEgp, limitEgp: limits.dailyLossLimitEgp, equityEgp: account.equityEgp },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (lossEgp >= limits.dailyLossLimitEgp * 0.8) {
        return warn('DAILY_LOSS', `Daily loss EGP ${lossEgp} is within 20% of the EGP ${limits.dailyLossLimitEgp} limit.`,
          { lossEgp, limitEgp: limits.dailyLossLimitEgp });
      }
      return pass('DAILY_LOSS', `daily loss EGP ${lossEgp} of EGP ${limits.dailyLossLimitEgp}`,
        { lossEgp, limitEgp: limits.dailyLossLimitEgp });
    },
  },
  {
    id: 'EXPOSURE',
    description:
      'Configurable maximum portfolio exposure. Total position notional is capped. '
      + 'A risk-REDUCING exit is never blocked by this rule: exposure is marked to '
      + 'market, so it can drift above the cap between orders, and refusing the '
      + 'sell that shrinks it would make the breach permanent.',
    evaluate({ account, decision, limits }) {
      const current = account.exposureEgp;
      const projected = decision.side === 'BUY' ? current + decision.notionalEgp : current - decision.notionalEgp;
      const data = {
        exposureEgp: current, notionalEgp: decision.notionalEgp, projectedEgp: projected,
        limitEgp: limits.maxPortfolioExposureEgp,
      };

      if (current > limits.maxPortfolioExposureEgp + PCT_EPSILON) {
        if (decision.side !== 'BUY') {
          // Already over the cap, and this order would bring it back down. Allow
          // it, and say so loudly enough that the breach is visible in the audit.
          return warn('EXPOSURE',
            `Exposure EGP ${roundEgp(current)} is over the EGP ${limits.maxPortfolioExposureEgp} limit; `
            + 'allowing the risk-reducing exit to bring it back to '
            + `EGP ${roundEgp(projected)}.`, data, 'CRITICAL');
        }
        return block('EXPOSURE',
          `Exposure EGP ${roundEgp(current)} already exceeds the EGP ${limits.maxPortfolioExposureEgp} limit; `
          + 'no new exposure may be added.',
          data, { severity: 'CRITICAL', latchesStop: true });
      }

      if (decision.side === 'BUY' && projected > limits.maxPortfolioExposureEgp + PCT_EPSILON) {
        return block('EXPOSURE',
          `Projected exposure EGP ${roundEgp(projected)} would exceed the EGP ${limits.maxPortfolioExposureEgp} limit.`,
          data, { severity: 'CRITICAL', latchesStop: false });
      }

      return pass('EXPOSURE', `exposure EGP ${roundEgp(current)} of EGP ${limits.maxPortfolioExposureEgp}`, data);
    },
  },
  {
    id: 'OPEN_POSITIONS',
    description:
      'The number of simultaneously open positions is capped. Positions are never unlimited. '
      + 'A risk-REDUCING exit is exempt: a cap on taking on new exposure must never trap exposure '
      + 'that is already open.',
    evaluate({ account, decision, limits }) {
      if (decision.side !== 'BUY') {
        return pass('OPEN_POSITIONS', 'exit closes an existing position', { openPositions: account.openPositions });
      }
      if (account.openPositions >= limits.maxOpenPositions) {
        return block('OPEN_POSITIONS',
          `Already holding ${account.openPositions} open position(s); the limit is ${limits.maxOpenPositions}.`,
          { openPositions: account.openPositions, limit: limits.maxOpenPositions },
          { severity: 'CRITICAL', latchesStop: false });
      }
      return pass('OPEN_POSITIONS', `${account.openPositions}/${limits.maxOpenPositions} open`);
    },
  },
  {
    id: 'ORDER_RATE',
    description:
      'Per-day order count caps, preventing runaway order loops. A risk-REDUCING exit is exempt, '
      + 'so reaching the cap cannot leave a position open with no way to close it.',
    evaluate({ orderCounts, limits, decision, dateKey }) {
      if (decision.side !== 'BUY') {
        return pass('ORDER_RATE', 'exit exempt from order-rate caps', { day: orderCounts.day });
      }
      if (orderCounts.day >= limits.maxOrdersPerDay) {
        return block('ORDER_RATE', `Daily order limit reached (${orderCounts.day}/${limits.maxOrdersPerDay}).`,
          { day: orderCounts.day, limit: limits.maxOrdersPerDay, dateKey }, { severity: 'CRITICAL', latchesStop: true });
      }
      if ((orderCounts.bySymbol[decision.symbol] ?? 0) >= limits.maxOrdersPerSymbolPerDay) {
        return block('ORDER_RATE',
          `Per-symbol daily order limit reached for ${decision.symbol} (${orderCounts.bySymbol[decision.symbol]}/${limits.maxOrdersPerSymbolPerDay}).`,
          { symbol: decision.symbol, count: orderCounts.bySymbol[decision.symbol], limit: limits.maxOrdersPerSymbolPerDay },
          { severity: 'CRITICAL', latchesStop: true });
      }
      return pass('ORDER_RATE', `${orderCounts.day} orders today`);
    },
  },

  // ---- 4. order-specific checks -----------------------------------------
  {
    id: 'ORDER_VALID',
    description: 'Shape and sanity of the intended order: symbol known, positive quantity and price, no reduce-only misuse.',
    evaluate({ decision, instrument }) {
      if (!instrument) {
        return block('ORDER_VALID', `Unknown instrument ${decision.symbol}.`, { symbol: decision.symbol },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      if (!(decision.quantity > 0)) {
        return block('ORDER_VALID', `Quantity must be positive (got ${decision.quantity}).`, { quantity: decision.quantity });
      }
      if (decision.quantity < instrument.minQty) {
        return block('ORDER_VALID', `Quantity ${decision.quantity} is below the minimum ${instrument.minQty}.`, {
          quantity: decision.quantity, minQty: instrument.minQty,
        });
      }
      if (!(decision.expectedExecutionPrice > 0)) {
        return block('ORDER_VALID', `Expected execution price must be positive (got ${decision.expectedExecutionPrice}).`, {});
      }
      if (decision.notionalEgp < 0) {
        return block('ORDER_VALID', `Negative notional EGP ${decision.notionalEgp}.`, { notionalEgp: decision.notionalEgp },
          { severity: 'CATASTROPHIC', latchesStop: true });
      }
      return pass('ORDER_VALID', `qty ${decision.quantity} ${decision.symbol}`);
    },
  },
  {
    id: 'MIN_NOTIONAL',
    description: 'Orders below the minimum notional are refused (dust / fee-dominated trades).',
    evaluate({ decision, limits }) {
      if (decision.side === 'BUY' && decision.notionalEgp < limits.minOrderNotionalEgp) {
        return block('MIN_NOTIONAL',
          `Notional EGP ${decision.notionalEgp} is below the EGP ${limits.minOrderNotionalEgp} minimum.`,
          { notionalEgp: decision.notionalEgp, minNotionalEgp: limits.minOrderNotionalEgp });
      }
      return pass('MIN_NOTIONAL', `notional EGP ${roundEgp(decision.notionalEgp)}`);
    },
  },
  {
    id: 'SUFFICIENT_BALANCE',
    description: 'Cash must cover notional plus fees. Cash is never allowed to go negative.',
    evaluate({ account, decision, feeBps }) {
      if (decision.side !== 'BUY') {
        return pass('SUFFICIENT_BALANCE', 'sell requires no cash');
      }
      const feeEgp = decision.notionalEgp * (feeBps / 10_000);
      const requiredMinor = toMinor(decision.notionalEgp) + toMinor(feeEgp);
      const availableMinor = toMinor(account.cashEgp);
      if (requiredMinor > availableMinor) {
        return block('SUFFICIENT_BALANCE',
          `Insufficient balance: need EGP ${roundEgp(decision.notionalEgp + feeEgp)} (notional + fee), have EGP ${account.cashEgp}.`,
          { requiredEgp: roundEgp(decision.notionalEgp + feeEgp), notionalEgp: decision.notionalEgp, feeEgp: roundEgp(feeEgp), availableEgp: account.cashEgp },
          { severity: 'CRITICAL', latchesStop: false });
      }
      return pass('SUFFICIENT_BALANCE',
        `cash EGP ${account.cashEgp} covers EGP ${roundEgp(decision.notionalEgp + feeEgp)}`,
        { requiredEgp: roundEgp(decision.notionalEgp + feeEgp), availableEgp: account.cashEgp });
    },
  },
  {
    id: 'POSITION_SIZE',
    description: 'Configurable maximum position size, in EGP notional.',
    evaluate({ decision, limits }) {
      if (decision.side !== 'BUY') {
        return pass('POSITION_SIZE', 'sell size is bounded by the position');
      }
      if (decision.notionalEgp > limits.maxPositionSizeEgp) {
        return block('POSITION_SIZE',
          `Position notional EGP ${decision.notionalEgp} exceeds the EGP ${limits.maxPositionSizeEgp} limit.`,
          { notionalEgp: decision.notionalEgp, limitEgp: limits.maxPositionSizeEgp },
          { severity: 'CRITICAL', latchesStop: false });
      }
      return pass('POSITION_SIZE', `notional EGP ${roundEgp(decision.notionalEgp)} of EGP ${limits.maxPositionSizeEgp}`,
        { notionalEgp: decision.notionalEgp, limitEgp: limits.maxPositionSizeEgp });
    },
  },
  {
    id: 'RISK_PER_TRADE',
    description: 'Loss at the stop must not exceed the configurable per-trade maximum.',
    evaluate({ decision, limits, account }) {
      if (decision.side !== 'BUY') {
        return pass('RISK_PER_TRADE', 'exits realise existing risk');
      }
      const risk = decision.riskAtStopEgp;
      if (risk > limits.maxLossPerTradeEgp + 1e-9) {
        return block('RISK_PER_TRADE',
          `Loss at stop EGP ${roundEgp(risk)} exceeds the EGP ${limits.maxLossPerTradeEgp} per-trade limit.`,
          { riskAtStopEgp: risk, limitEgp: limits.maxLossPerTradeEgp, stopPrice: decision.stopPrice, price: decision.price },
          { severity: 'CRITICAL', latchesStop: false });
      }
      const pctOfEquity = account.equityEgp > 0 ? (risk / account.equityEgp) * 100 : 100;
      if (pctOfEquity > 2) {
        return warn('RISK_PER_TRADE', `Trade risk is ${roundTo(pctOfEquity, 3)}% of equity.`, { pctOfEquity });
      }
      return pass('RISK_PER_TRADE', `risk at stop EGP ${roundEgp(risk)} of EGP ${limits.maxLossPerTradeEgp}`,
        { riskAtStopEgp: risk, limitEgp: limits.maxLossPerTradeEgp, pctOfEquity });
    },
  },
  {
    id: 'STOP_CONDITION',
    description: 'Every entry must carry a stop loss within the configured distance band.',
    evaluate({ decision, limits }) {
      if (decision.side !== 'BUY') {
        return pass('STOP_CONDITION', 'exit order needs no stop');
      }
      if (limits.stopLossRequired && !decision.stopPrice) {
        return block('STOP_CONDITION', 'A stop loss is mandatory on every entry.', {},
          { severity: 'CRITICAL', latchesStop: true });
      }
      if (decision.stopPrice == null) return pass('STOP_CONDITION', 'no stop required for this side');
      const distPct = Math.abs((decision.price - decision.stopPrice) / decision.price) * 100;
      if (distPct < limits.minStopDistancePct - PCT_EPSILON) {
        return block('STOP_CONDITION',
          `Stop distance ${roundTo(distPct, 4)}% is tighter than the ${limits.minStopDistancePct}% minimum (too easy to be noise-triggered).`,
          { stopDistancePct: roundTo(distPct, 4), minPct: limits.minStopDistancePct });
      }
      if (distPct > limits.maxStopDistancePct + PCT_EPSILON) {
        return block('STOP_CONDITION',
          `Stop distance ${roundTo(distPct, 4)}% exceeds the ${limits.maxStopDistancePct}% maximum.`,
          { stopDistancePct: roundTo(distPct, 4), maxPct: limits.maxStopDistancePct });
      }
      if (decision.stopPrice >= decision.price) {
        return block('STOP_CONDITION',
          `Stop ${decision.stopPrice} must be below the entry price ${decision.price} for a long position.`,
          { stopPrice: decision.stopPrice, price: decision.price }, { severity: 'CRITICAL', latchesStop: true });
      }
      if (limits.minRiskRewardRatio > 0 && decision.riskRewardRatio != null && decision.riskRewardRatio < limits.minRiskRewardRatio) {
        return warn('STOP_CONDITION',
          `Risk/reward ${roundTo(decision.riskRewardRatio, 3)} is below the ${limits.minRiskRewardRatio} minimum.`,
          { riskRewardRatio: decision.riskRewardRatio, minRatio: limits.minRiskRewardRatio });
      }
      return pass('STOP_CONDITION', `stop ${roundTo(distPct, 4)}% away`, { stopDistancePct: distPct });
    },
  },
  {
    id: 'DUPLICATE_ORDER',
    description: 'The same decision may never produce two orders, including after a restart.',
    evaluate({ decision, clientOrderId, existingOrder }) {
      if (existingOrder) {
        return block('DUPLICATE_ORDER',
          `Order already exists for this decision (${existingOrder.order_id}, status ${existingOrder.status}). Duplicate refused.`,
          { clientOrderId, existingOrderId: existingOrder.order_id, existingStatus: existingOrder.status },
          { severity: 'CRITICAL', latchesStop: false });
      }
      return pass('DUPLICATE_ORDER', 'no duplicate', { clientOrderId });
    },
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

export const RULE_HELPERS = { pass, warn, block };
