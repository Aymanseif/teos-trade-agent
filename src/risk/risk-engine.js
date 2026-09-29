/**
 * TEOS Trade Agent - risk/risk-engine.js
 *
 * THE RISK ENGINE. Runs BEFORE every simulated order. Nothing reaches the
 * Sentinel or the execution adapter without passing through `check()`.
 *
 * Design properties
 *  - DETERMINISTIC: same inputs -> same verdict. No randomness, no clock reads
 *    of its own (nowMs is injected).
 *  - FAIL CLOSED: a rule that throws is treated as a BLOCK, never as a pass.
 *  - AUDITED: every evaluation produces a RiskDecision that is persisted,
 *    including BLOCK verdicts. A refusal is as auditable as an execution.
 *  - LATCHING: rules that indicate a systemic failure engage an emergency stop
 *    so new orders are refused even if the underlying condition clears.
 *
 * `check()` returns a verdict but never throws for a business-rule failure.
 */

import { RULES } from './rules/index.js';
import { RiskLimits, effectiveRiskBudget } from './limits.js';
import { sizePosition } from '../paper/pnl.js';
import { newId, clientOrderId } from '../core/ids.js';
import { roundEgp, roundTo, toMinor } from '../core/money.js';
import { toErrorPayload } from '../core/errors.js';

export const VERDICTS = Object.freeze({ ALLOW: 'ALLOW', WARN: 'WARN', REVIEW: 'REVIEW', BLOCK: 'BLOCK' });

/**
 * The risk engine receives a plain portfolio SNAPSHOT, not the live account
 * object, so that a rule can never mutate the portfolio. Look the position up
 * in whichever shape is available: a live PaperAccount, an array of positions,
 * or a snapshot carrying `openPositionDetails`.
 */
export function findPosition(account, symbol) {
  if (!account) return null;
  if (typeof account.positionFor === 'function') {
    const p = account.positionFor(symbol);
    if (p) return { quantity: p.quantity, avg_entry_price: p.avg_entry_price, position_id: p.position_id };
    return null;
  }
  if (Array.isArray(account)) {
    const p = account.find((x) => x.symbol === symbol);
    return p ? { quantity: p.quantity, avg_entry_price: p.avg_entry_price, position_id: p.position_id } : null;
  }
  const list = account.openPositionDetails ?? account.openPositionsDetails ?? [];
  const p = list.find((x) => x.symbol === symbol);
  if (!p) return null;
  return { quantity: p.quantity, avg_entry_price: p.avgEntryPrice ?? p.avg_entry_price, position_id: p.position_id };
}

/**
 * Force a stop price into the policy distance band.
 *
 * This mirrors `resolveStop` in the strategy interface - the two must agree,
 * and the strategy helper is the shared definition. Doing it here as well means
 * a third-party strategy that forgets to clamp yields a valid order rather than
 * a silent rejection, and `clamped` records that the adjustment happened.
 */
export function clampStopToBand(price, stopPrice, limits) {
  const rawPct = Math.max(0, ((price - stopPrice) / price) * 100);
  const effectivePct = Math.min(limits.maxStopDistancePct, Math.max(limits.minStopDistancePct, rawPct));
  return {
    stopPrice: price * (1 - effectivePct / 100),
    stopDistancePct: effectivePct,
    rawStopDistancePct: rawPct,
    clamped: effectivePct !== rawPct,
  };
}

export class RiskEngine {
  #config;
  #limits;
  #repos;
  #clock;
  #instruments;

  constructor({ config, repos, clock }) {
    this.#config = config;
    this.#limits = new RiskLimits(config);
    this.#repos = repos;
    this.#clock = clock;
    this.#instruments = new Map(config.instruments.map((i) => [i.symbol, i]));
  }

  get limits() { return this.#limits; }

  /**
   * Build the concrete order the agent PROPOSES, before any risk evaluation.
   *
   * The agent never picks a size by itself: it supplies a stop distance and a
   * requested risk percentage, and the sizer - bounded by the risk limits -
   * produces the quantity. That is what keeps sizing consistent with the
   * per-trade loss limit.
   *
   * @returns {{ side, quantity, notionalEgp, stopPrice, riskAtStopEgp, riskBudgetEgp, ... }}
   */
  proposeOrder({ decision, account, quote, instrument }) {
    const limits = this.#limits;

    // An unknown instrument must reach ORDER_VALID so it can be refused as a
    // CATASTROPHIC condition that latches a stop. Without this guard the very
    // next thing to touch `instrument` is `sizePosition({ qtyStep:
    // instrument.qtyStep })`, which throws a bare TypeError; the firewall then
    // reports FAILED with code UNKNOWN, no rule ever fires, and nothing latches.
    // The order is still refused - it fails closed - but the diagnosis is wrong
    // and the operator is told nothing about a misconfigured or hallucinated
    // symbol.
    if (!instrument) {
      return {
        side: decision.signal === 'SELL' ? 'SELL' : 'BUY',
        quantity: 0, notionalEgp: 0, stopPrice: null,
        riskAtStopEgp: 0, riskBudgetEgp: 0,
        expectedExecutionPrice: null, reason: 'UNKNOWN_INSTRUMENT',
      };
    }

    const price = quote.mid;
    const feeBps = this.#config.fees.takerBps;
    const expectedSlippageBps = Math.min(quote.spreadBps / 2 + this.#config.slippage.baseBps, this.#config.slippage.maxBps);

    // ---- SELL: exit / reduce an existing long. Never open a short. ----
    if (decision.signal === 'SELL') {
      const pos = findPosition(account, decision.symbol);
      if (!pos) {
        return { side: 'SELL', quantity: 0, notionalEgp: 0, reason: 'NO_POSITION_TO_EXIT', stopPrice: null, riskAtStopEgp: 0, riskBudgetEgp: 0 };
      }
      const quantity = roundTo(pos.quantity, 8);
      return {
        side: 'SELL',
        quantity,
        notionalEgp: roundEgp(quantity * price),
        stopPrice: null,
        riskAtStopEgp: 0,
        riskBudgetEgp: 0,
        reduceOnly: true,
        expectedExecutionPrice: price,
        expectedSlippageEgp: roundEgp(quantity * price * expectedSlippageBps / 10_000),
        feeBpsEstimate: feeBps,
        expectedSlippageBps,
        reason: 'EXIT_EXISTING_LONG',
      };
    }

    // ---- BUY: size from the risk budget. ----
    const requestedPct = decision.strategyMeta?.riskPctPerTrade ?? 0;
    const { budgetEgp, cappedBy } = effectiveRiskBudget({
      limits, equityEgp: account.equityEgp, requestedPct,
    });

    // Stop price: strategy-provided, otherwise the configured default distance.
    // It is then clamped into the policy band. The strategies clamp too, but the
    // risk engine is the last authority before the order is built, and an order
    // whose stop sits outside [min, max] would be refused by STOP_CONDITION -
    // so the engine fixes it here rather than knowingly emitting a doomed order.
    let stopPrice = decision.risk?.stopPrice ?? decision.stopPrice ?? null;
    if (!limits.stopLossRequired) stopPrice = null;
    if (stopPrice == null) {
      stopPrice = price * (1 - limits.defaultStopDistancePct / 100);
    }
    const clampedStop = clampStopToBand(price, stopPrice, limits);
    stopPrice = roundTo(clampedStop.stopPrice, 8);

    const maxNotional = Math.min(
      limits.maxPositionSizeEgp,
      limits.maxPortfolioExposureEgp - account.exposureEgp, // room left in the portfolio
      account.cashEgp,
    );

    const sized = sizePosition({
      price,
      stopPrice,
      riskBudgetEgp: budgetEgp,
      maxNotionalEgp: Math.max(0, maxNotional),
      availableCashEgp: account.cashEgp,
      qtyStep: instrument.qtyStep,
      minQty: instrument.minQty,
      feeBps,
      minNotionalEgp: limits.minOrderNotionalEgp,
    });

    return {
      side: 'BUY',
      quantity: sized.quantity,
      notionalEgp: sized.notionalEgp,
      stopPrice,
      stopDistancePct: clampedStop.stopDistancePct,
      stopClamped: clampedStop.clamped,
      riskAtStopEgp: sized.riskAtStopEgp ?? 0,
      riskBudgetEgp: budgetEgp,
      riskCappedBy: cappedBy,
      sizeBoundBy: sized.boundBy ?? null,
      sizeReason: sized.reason ?? null,
      expectedExecutionPrice: price,
      expectedSlippageEgp: roundEgp((sized.notionalEgp ?? 0) * expectedSlippageBps / 10_000),
      feeBpsEstimate: feeBps,
      expectedSlippageBps,
      sizePctOfEquity: account.equityEgp > 0 ? roundTo(((sized.notionalEgp ?? 0) / account.equityEgp) * 100, 6) : 0,
    };
  }

  /**
   * Run every rule against a proposed order.
   *
   * @returns {{
   *   riskDecisionId, verdict, blocked, reason, failedRule, rules,
   *   passedCount, failedCount, account, limits, clientOrderId, stopTriggered
   * }}
   */
  check({ decision, proposal, account, dailyLoss, brokerHealth, killSwitch, quote, orderCounts }) {
    const nowMs = this.#clock.now();
    const instrument = this.#instruments.get(decision.symbol) ?? null;

    // The reference price for the abnormal-movement check is the price at which
    // the agent formed its decision, taken from the previous stored snapshot.
    const previous = this.#repos.lastSnapshotBefore(decision.symbol, nowMs - 1, this.#repos.mode, this.#repos.decisionScopeRunId);
    const referencePrice = previous?.last ?? null;

    const ctx = {
      decision: {
        symbol: decision.symbol,
        side: proposal.side,
        quantity: proposal.quantity,
        notionalEgp: proposal.notionalEgp,
        price: decision.marketPrice,
        expectedExecutionPrice: proposal.expectedExecutionPrice ?? decision.expectedExecutionPrice,
        stopPrice: proposal.stopPrice,
        riskAtStopEgp: proposal.riskAtStopEgp,
        riskRewardRatio: decision.risk?.riskRewardRatio ?? null,
        leverageRequested: false,
        borrowRequested: false,
        derivative: false,
      },
      account,
      dailyLoss,
      brokerHealth,
      killSwitch,
      quote: quote ? { ...quote, tsMs: quote.tsMs ?? nowMs } : null,
      referencePrice,
      nowMs,
      limits: this.#limits,
      instrument,
      orderCounts: orderCounts ?? { day: 0, bySymbol: {} },
      dateKey: this.#clock.dateKey(),
      agentState: decision.agentState,
      // The permission matrix is carried on the decision so the record is
      // self-contained; falling back to the live state machine is not possible
      // here, and a missing matrix is treated as a BLOCK by the rule itself.
      permissions: decision.permissions ?? null,
      side: proposal.side,
      feeBps: this.#config.fees.takerBps,
      clientOrderId: clientOrderId(decision.decisionId),
      existingOrder: this.#repos.getOrderByClientId(clientOrderId(decision.decisionId)),
    };

    const results = [];
    let blocked = false;
    let failedRule = null;
    let stopToLatch = null;

    for (const rule of RULES) {
      let result;
      try {
        result = rule.evaluate(ctx);
      } catch (err) {
        // FAIL CLOSED: a broken rule must never behave like a passing rule.
        result = {
          rule: rule.id,
          status: 'BLOCK',
          detail: `Rule threw: ${err.message}`,
          data: { error: toErrorPayload(err) },
          severity: 'CATASTROPHIC',
          latchesStop: true,
          threw: true,
        };
      }
      results.push(result);
      if (result.status === 'BLOCK') {
        blocked = true;
        failedRule ??= result.rule;
        if (result.latchesStop && !stopToLatch) {
          stopToLatch = {
            trigger: result.rule,
            severity: result.severity ?? 'CRITICAL',
            scope: result.severity === 'CATASTROPHIC' ? 'HALT_ALL' : 'NEW_ORDERS',
            reason: result.detail,
            details: result.data,
          };
        }
        break; // fail fast: the first BLOCK is the operative reason
      }
    }

    const hasWarn = results.some((r) => r.status === 'WARN');
    const verdict = blocked ? VERDICTS.BLOCK : (hasWarn ? VERDICTS.WARN : VERDICTS.ALLOW);
    const passedCount = results.filter((r) => r.status === 'PASS').length;
    const failedCount = results.filter((r) => r.status !== 'PASS').length;

    const out = {
      riskDecisionId: newId('risk'),
      decisionId: decision.decisionId,
      verdict,
      blocked,
      reason: blocked ? results.find((r) => r.status === 'BLOCK')?.detail : (hasWarn ? 'allowed with warnings' : 'all risk rules passed'),
      failedRule,
      rules: results,
      passedCount,
      failedCount,
      account: {
        cashEgp: account.cashEgp,
        equityEgp: account.equityEgp,
        exposureEgp: account.exposureEgp,
        openPositions: account.openPositions,
        startingCapitalEgp: account.startingCapitalEgp,
        dailyRealizedPnlEgp: dailyLoss.realizedEgp,
        dailyUnrealizedPnlEgp: dailyLoss.unrealizedEgp,
      },
      limits: this.#limits.toJSON(),
      clientOrderId: ctx.clientOrderId,
      proposal,
      stopToLatch,
      rulesEvaluated: results.length,
      rulesTotal: RULES.length,
    };

    // Latch an emergency stop INSIDE the same transaction as the audit write,
    // so the stop and the refusal are recorded atomically.
    this.#repos.db.tx(() => {
      this.#repos.insertRiskDecision(out, this.#clock);
      if (stopToLatch) {
        this.#repos.engageStop({ ...stopToLatch, clock: this.#clock });
        this.#repos.logEvent({
          level: 'FATAL', category: 'emergency_stop', clock: this.#clock,
          message: `Emergency stop latched by risk rule ${stopToLatch.trigger}: ${stopToLatch.reason}`,
          details: { ...stopToLatch, decisionId: decision.decisionId },
        });
      }
    });

    return out;
  }

  /** Rules list for the dashboard / documentation. */
  static describeRules() {
    return RULES.map((r, i) => ({ order: i + 1, id: r.id, description: r.description }));
  }
}

export { RULES } from './rules/index.js';
