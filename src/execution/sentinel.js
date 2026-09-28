/**
 * TEOS TRADE AGENT - TEOS SENTINEL
 * ===========================================================================
 * execution/sentinel.js
 *
 * The deterministic pre-execution policy layer. It sits between the risk
 * engine and the execution adapter and can return exactly four decisions:
 *
 *     ALLOW   -> the execution adapter may build and submit the order
 *     WARN    -> allowed, but the warning is recorded and surfaced
 *     REVIEW  -> QUARANTINED. The order is NOT executed. It is written to the
 *                audit trail as a review item requiring explicit human
 *                approval via the CLI. Nothing auto-approves a REVIEW.
 *     BLOCK   -> rejected outright
 *
 * The Sentinel is deterministic: identical inputs always produce an identical
 * verdict, and every rule's contribution is recorded with the data that
 * triggered it. Precedence is BLOCK > REVIEW > WARN > ALLOW.
 *
 * The Sentinel's job is defence in depth. It is NOT a substitute for the risk
 * engine, and it can never widen anything the risk engine has already limited.
 * ===========================================================================
 */

import { newId } from '../core/ids.js';
import { roundEgp, roundTo } from '../core/money.js';
import { toErrorPayload } from '../core/errors.js';

export const SENTINEL_VERDICTS = Object.freeze(['ALLOW', 'WARN', 'REVIEW', 'BLOCK']);
export const SENTINEL_ACTIONS = Object.freeze(['PASS', 'PASS_WITH_WARNING', 'QUARANTINE', 'REJECT']);
export const POLICY_VERSION = 'sentinel/1.0.0-phase1';

const rank = (v) => SENTINEL_VERDICTS.indexOf(v); // ALLOW < WARN < REVIEW < BLOCK

/**
 * Sentinel rules. Each returns { verdict, detail, data }.
 * Evaluated in order; the highest-ranked verdict wins.
 */
export const SENTINEL_RULES = [
  {
    id: 'MODE_GUARD',
    description: 'Only PAPER and BACKTEST modes may reach the execution adapter. Live is impossible.',
    evaluate({ mode, verdict }) {
      if (mode === 'LIVE') {
        return { verdict: 'BLOCK', detail: 'LIVE mode is not implemented. This build cannot execute live.', data: { mode } };
      }
      if (!['PAPER', 'BACKTEST'].includes(mode)) {
        return { verdict: 'BLOCK', detail: `Unrecognised mode "${mode}".`, data: { mode } };
      }
      return { verdict: 'ALLOW', detail: `mode ${mode}`, data: { mode } };
    },
  },
  {
    id: 'KILL_SWITCH',
    description: 'An engaged emergency stop blocks execution even if the risk engine allowed it.',
    evaluate({ killSwitch }) {
      if (killSwitch?.engaged) {
        return { verdict: 'BLOCK', detail: `Emergency stop engaged (${killSwitch.trigger ?? 'unknown'}): ${killSwitch.reason ?? ''}`, data: { ...killSwitch } };
      }
      return { verdict: 'ALLOW', detail: 'kill switch clear' };
    },
  },
  {
    id: 'RISK_VERDICT',
    description: 'A BLOCK from the risk engine can never be upgraded by the Sentinel.',
    evaluate({ riskVerdict }) {
      if (riskVerdict?.blocked) {
        return {
          verdict: 'BLOCK',
          detail: `Risk engine blocked: ${riskVerdict.failedRule} - ${riskVerdict.reason}`,
          data: { failedRule: riskVerdict.failedRule, reason: riskVerdict.reason },
        };
      }
      if (riskVerdict?.verdict === 'WARN') {
        return { verdict: 'WARN', detail: `Risk engine warnings: ${(riskVerdict.rules ?? []).filter((r) => r.status === 'WARN').map((r) => r.rule).join(', ')}`, data: {} };
      }
      return { verdict: 'ALLOW', detail: 'risk engine allowed' };
    },
  },
  {
    id: 'DUPLICATE_ORDER',
    description: 'Refuse any order whose client_order_id already exists. Protects against restart replays.',
    evaluate({ existingOrder, clientOrderId }) {
      if (existingOrder) {
        return {
          verdict: 'BLOCK',
          detail: `Duplicate order refused: ${clientOrderId} already exists as ${existingOrder.order_id} (${existingOrder.status}).`,
          data: { clientOrderId, existingOrderId: existingOrder.order_id, existingStatus: existingOrder.status },
        };
      }
      return { verdict: 'ALLOW', detail: 'no duplicate' };
    },
  },
  {
    id: 'MANUAL_HOLD',
    description:
      'An operator-set trading hold blocks every order until it is explicitly cleared. This is '
      + 'deliberately NOT the same as a REVIEW: a REVIEW quarantines the single decision that '
      + 'triggered it and leaves the rest of the book free to run, while a manual hold is an '
      + 'operator deliberately stopping everything.',
    evaluate({ manualHold }) {
      if (manualHold) {
        return {
          verdict: 'BLOCK',
          detail: 'Manual trading hold is engaged; all orders are refused until an operator clears it.',
          data: { manualHold: true },
        };
      }
      return { verdict: 'ALLOW', detail: 'no manual hold' };
    },
  },
  {
    id: 'PRICE_DRIFT',
    description: 'The market has moved too far between the decision price and the execution price.',
    evaluate({ decisionPrice, currentPrice, proposal, thresholds }) {
      // Drift is precisely why a stop exit exists. Quarantining one because the
      // market moved would defeat the stop, so risk-REDUCING orders are exempt.
      if (proposal?.reduceOnly === true) {
        return { verdict: 'ALLOW', detail: 'risk-reducing exit: drift check not applicable', data: { reduceOnly: true } };
      }
      if (!(decisionPrice > 0) || !(currentPrice > 0)) {
        return { verdict: 'BLOCK', detail: `Unusable price for drift check (decision=${decisionPrice}, current=${currentPrice}).`, data: { decisionPrice, currentPrice } };
      }
      const driftBps = Math.abs((currentPrice - decisionPrice) / decisionPrice) * 10_000;
      if (driftBps > thresholds.priceDriftReviewBps) {
        return {
          verdict: 'REVIEW',
          detail: `Price drifted ${roundTo(driftBps, 1)}bps since the decision (review threshold ${thresholds.priceDriftReviewBps}bps). Quarantined.`,
          data: { driftBps, thresholdBps: thresholds.priceDriftReviewBps, decisionPrice, currentPrice },
        };
      }
      if (driftBps > thresholds.priceDriftReviewBps * 0.5) {
        return { verdict: 'WARN', detail: `Price drifted ${roundTo(driftBps, 1)}bps since the decision.`, data: { driftBps } };
      }
      return { verdict: 'ALLOW', detail: `drift ${roundTo(driftBps, 1)}bps`, data: { driftBps } };
    },
  },
  {
    id: 'UNUSUAL_SIZE',
    description: 'An order far larger than the strategy normally produces is quarantined for review.',
    evaluate({ proposal, account, thresholds }) {
      if (proposal.side !== 'BUY') return { verdict: 'ALLOW', detail: 'not an entry' };
      const pctOfEquity = account.equityEgp > 0 ? (proposal.notionalEgp / account.equityEgp) * 100 : 0;
      const byPct = pctOfEquity > thresholds.unusualSizeReviewPctOfEquity;
      const byAbs = proposal.notionalEgp > thresholds.unusualSizeReviewEgp;
      if (byPct || byAbs) {
        return {
          verdict: 'REVIEW',
          detail: `Unusual order size EGP ${roundEgp(proposal.notionalEgp)} (${roundTo(pctOfEquity, 2)}% of equity). Quarantined for review.`,
          data: { notionalEgp: proposal.notionalEgp, pctOfEquity, byPct, byAbs },
        };
      }
      return {
        verdict: 'ALLOW',
        detail: `size ${roundEgp(proposal.notionalEgp)} (${roundTo(pctOfEquity, 2)}% of equity)`,
        data: { pctOfEquity },
      };
    },
  },
  {
    id: 'LOW_CONFIDENCE',
    description: 'A very weak signal is quarantined rather than traded on.',
    evaluate({ decision, thresholds }) {
      if (decision.signal === 'HOLD') return { verdict: 'ALLOW', detail: 'hold' };
      if (decision.confidence < thresholds.lowConfidenceReview) {
        return {
          verdict: 'REVIEW',
          detail: `Signal confidence ${roundTo(decision.confidence, 3)} is below the review threshold ${thresholds.lowConfidenceReview}. Quarantined.`,
          data: { confidence: decision.confidence, threshold: thresholds.lowConfidenceReview },
        };
      }
      return { verdict: 'ALLOW', detail: `confidence ${roundTo(decision.confidence, 3)}`, data: { confidence: decision.confidence } };
    },
  },
  {
    id: 'WIDE_STOP',
    description: 'A stop far wider than normal is surfaced as a warning, not silently accepted.',
    evaluate({ proposal, decision, thresholds }) {
      if (proposal.side !== 'BUY' || proposal.stopPrice == null) return { verdict: 'ALLOW', detail: 'no stop' };
      const distPct = Math.abs((decision.marketPrice - proposal.stopPrice) / decision.marketPrice) * 100;
      if (distPct > thresholds.wideStopWarnPct) {
        return { verdict: 'WARN', detail: `Stop is ${roundTo(distPct, 2)}% away, wider than the ${thresholds.wideStopWarnPct}% guideline.`, data: { stopDistancePct: distPct } };
      }
      return { verdict: 'ALLOW', detail: `stop ${roundTo(distPct, 2)}% away`, data: { stopDistancePct: distPct } };
    },
  },
  {
    id: 'DAILY_LOSS_PRESSURE',
    description: 'Trading near the daily loss limit is surfaced as a warning to operators.',
    evaluate({ dailyLoss, limits, thresholds }) {
      const loss = Math.max(0, -(dailyLoss.realizedEgp + dailyLoss.unrealizedEgp));
      const pct = limits.dailyLossLimitEgp > 0 ? (loss / limits.dailyLossLimitEgp) * 100 : 0;
      if (pct >= 100) {
        return { verdict: 'BLOCK', detail: `Daily loss EGP ${roundEgp(loss)} has reached the limit.`, data: { loss, pct } };
      }
      if (pct >= thresholds.dailyLossWarnPctOfLimit) {
        return { verdict: 'WARN', detail: `Daily loss is at ${roundTo(pct, 1)}% of the limit.`, data: { loss, pct } };
      }
      return { verdict: 'ALLOW', detail: `daily loss ${roundTo(pct, 1)}% of limit`, data: { loss, pct } };
    },
  },
  {
    id: 'EXPOSURE_PRESSURE',
    description:
      'Exposure near the portfolio cap is surfaced as a warning. A risk-REDUCING '
      + 'exit is never blocked here: exposure is marked to market and can sit '
      + 'above the cap between orders, and the Sentinel must never be the layer '
      + 'that traps a position the risk engine is trying to close.',
    evaluate({ account, proposal, limits, thresholds }) {
      const reduceOnly = proposal.reduceOnly === true || proposal.side === 'SELL';
      const projected = account.exposureEgp
        + (proposal.side === 'BUY' ? proposal.notionalEgp : -proposal.notionalEgp);
      const pct = limits.maxPortfolioExposureEgp > 0 ? (projected / limits.maxPortfolioExposureEgp) * 100 : 0;
      const data = { projected, pct, reduceOnly };

      if (pct > 100) {
        if (reduceOnly) {
          return {
            verdict: 'WARN',
            detail: `Projected exposure ${roundTo(pct, 1)}% of the cap before this exit; `
              + `allowing it, which reduces exposure to EGP ${roundEgp(projected)}.`,
            data,
          };
        }
        return { verdict: 'BLOCK', detail: `Projected exposure ${roundTo(pct, 1)}% exceeds the cap.`, data };
      }
      if (pct >= thresholds.exposureWarnPctOfLimit) {
        return { verdict: 'WARN', detail: `Projected exposure is at ${roundTo(pct, 1)}% of the cap.`, data };
      }
      return { verdict: 'ALLOW', detail: `exposure ${roundTo(pct, 1)}% of cap`, data };
    },
  },
  {
    id: 'DECISION_RATE',
    description: 'An abnormal burst of decisions is quarantined - a common symptom of a runaway loop.',
    evaluate({ recentDecisionCount, proposal, thresholds, windowMs }) {
      if (proposal?.reduceOnly === true) {
        return { verdict: 'ALLOW', detail: 'risk-reducing exit: rate check not applicable', data: { reduceOnly: true } };
      }
      if (recentDecisionCount > thresholds.maxDecisionsPerMinute) {
        return {
          verdict: 'REVIEW',
          detail: `${recentDecisionCount} decisions in ${windowMs}ms exceeds the ${thresholds.maxDecisionsPerMinute}/min limit. Quarantined.`,
          data: { recentDecisionCount, windowMs, limit: thresholds.maxDecisionsPerMinute },
        };
      }
      return { verdict: 'ALLOW', detail: `${recentDecisionCount} decisions in window`, data: { recentDecisionCount } };
    },
  },
  {
    id: 'STOP_REQUIRED',
    description: 'An entry without a stop condition is blocked outright.',
    evaluate({ proposal, decision, thresholds }) {
      if (proposal.side === 'BUY' && thresholds.stopRequiredBlocks && !decision.stopCondition) {
        return { verdict: 'BLOCK', detail: 'Entry order has no stop condition.', data: { stopCondition: null } };
      }
      return { verdict: 'ALLOW', detail: 'stop condition present' };
    },
  },
  {
    id: 'SHORT_GUARD',
    description: 'Short positions are structurally impossible in this account.',
    evaluate({ proposal, decision, account, accountRef }) {
      if (proposal.side !== 'SELL') return { verdict: 'ALLOW', detail: 'not an exit' };
      const symbol = decision.symbol;
      // Prefer the live account lookup; fall back to the passed snapshot.
      const hasLong = typeof accountRef?.positionFor === 'function'
        ? Boolean(accountRef.positionFor(symbol))
        : (account?.openPositionDetails ?? []).some((p) => p.symbol === symbol);
      if (!hasLong) {
        return {
          verdict: 'BLOCK',
          detail: `SELL in ${symbol} with no open long position would open a short. Shorting is prohibited.`,
          data: { symbol },
        };
      }
      return { verdict: 'ALLOW', detail: 'long-only account; exit of an existing long' };
    },
  },
];

export class Sentinel {
  #config;
  #repos;
  #clock;

  constructor({ config, repos, clock }) {
    this.#config = config;
    this.#repos = repos;
    this.#clock = clock;
  }

  get policyVersion() { return POLICY_VERSION; }

  /**
   * @returns {{
   *   sentinelDecisionId, verdict, actionTaken, reason, triggerRule, rules,
   *   thresholds, policyVersion
   * }}
   */
  evaluate({ decision, proposal, riskVerdict, account, accountRef, dailyLoss, killSwitch, quote, mode }) {
    const nowMs = this.#clock.now();
    const clientOrderId = riskVerdict?.clientOrderId ?? null;
    const existingOrder = clientOrderId ? this.#repos.getOrderByClientId(clientOrderId) : null;
    const recentDecisionCount = this.#countRecentDecisions(nowMs - 60_000);
    // The manual hold is an operator control (CLI `hold` / `resume`), never set
    // automatically. A quarantined decision id is recorded separately for the
    // dashboard, but it does not stop unrelated trading.
    const manualHold = this.#repos.isFlagSet('TRADING_HOLD');

    const ctx = {
      mode,
      decision,
      proposal,
      riskVerdict,
      account,
      accountRef,
      dailyLoss,
      killSwitch,
      quote,
      manualHold,
      limits: this.#config.risk,
      thresholds: this.#config.sentinel,
      decisionPrice: decision.marketPrice,
      currentPrice: quote?.mid ?? null,
      clientOrderId,
      existingOrder,
      recentDecisionCount,
      windowMs: 60_000,
    };

    const results = [];
    for (const rule of SENTINEL_RULES) {
      let r;
      try {
        r = rule.evaluate(ctx);
      } catch (err) {
        // Fail closed, as with the risk engine.
        r = { verdict: 'BLOCK', detail: `Sentinel rule threw: ${err.message}`, data: { error: toErrorPayload(err) } };
      }
      if (!SENTINEL_VERDICTS.includes(r.verdict)) {
        r = { verdict: 'BLOCK', detail: `Sentinel rule ${rule.id} returned an invalid verdict "${r.verdict}".`, data: {} };
      }
      results.push({ rule: rule.id, description: rule.description, ...r });
    }

    // Precedence: the highest-ranked verdict wins.
    const winner = results.reduce((acc, r) => (rank(r.verdict) > rank(acc) ? r.verdict : acc), 'ALLOW');
    const decisive = results.find((r) => r.verdict === winner);

    const actionTaken = {
      ALLOW: 'PASS', WARN: 'PASS_WITH_WARNING', REVIEW: 'QUARANTINE', BLOCK: 'REJECT',
    }[winner];

    const out = {
      sentinelDecisionId: newId('sent'),
      decisionId: decision.decisionId,
      riskDecisionId: riskVerdict?.riskDecisionId ?? null,
      verdict: winner,
      actionTaken,
      reason: decisive?.detail ?? 'no sentinel rule objected',
      triggerRule: decisive?.rule ?? null,
      policyVersion: POLICY_VERSION,
      rules: results,
      thresholds: { ...this.#config.sentinel },
    };

    this.#repos.db.tx(() => {
      this.#repos.insertSentinelDecision(out, this.#clock);
      if (winner === 'REVIEW') {
        // Record WHICH decision is awaiting a human, for the dashboard. This is
        // deliberately not a blocking latch: the firewall already refuses to
        // execute a quarantined decision, and latching globally here would let a
        // single odd order stop the agent forever with no recovery path.
        this.#repos.setFlag('REVIEW_PENDING', decision.decisionId, this.#clock, 'sentinel', `Quarantined decision ${decision.decisionId}: ${decisive?.detail}`);
      }
      if (winner === 'BLOCK' || winner === 'REVIEW') {
        this.#repos.logEvent({
          level: winner === 'BLOCK' ? 'WARN' : 'INFO',
          category: 'sentinel',
          clock: this.#clock,
          message: `Sentinel ${winner} (${decisive?.rule}): ${decisive?.detail}`,
          details: { decisionId: decision.decisionId, verdict: winner, rule: decisive?.rule },
        });
      }
    });

    return out;
  }

  #countRecentDecisions(sinceMs) {
    // Run-scoped in BACKTEST: two backtests replay the same clock epoch, so an
    // unscoped window count sees the previous run's decisions and quarantines
    // this one for a burst it did not produce.
    const runId = this.#repos.decisionScopeRunId;
    if (runId) {
      return this.#repos.db.count(
        'SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ? AND run_id = ? AND ts_ms >= ?',
        this.#repos.mode, runId, sinceMs,
      );
    }
    return this.#repos.db.count(
      'SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ? AND ts_ms >= ?',
      this.#repos.mode, sinceMs,
    );
  }

  static describeRules() {
    return SENTINEL_RULES.map((r, i) => ({ order: i + 1, id: r.id, description: r.description }));
  }
}
