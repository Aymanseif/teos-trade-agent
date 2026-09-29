/**
 * Required scenario 2 of 13: EXCESSIVE_POSITION_SIZE
 *
 * Attempt a position exceeding the configured maximum position size.
 * Expected: blocked by the risk engine, no execution.
 *
 * The real `proposeOrder` sizes a BUY to the risk budget and caps it, so the
 * pipeline cannot normally emit an oversized order. This scenario therefore
 * proves the property at the layer that actually enforces it - the POSITION_SIZE
 * rule - and separately proves the end-to-end invariant that no order which DID
 * reach the broker ever exceeded the cap.
 *
 * A test that only fed the engine a well-sized order would prove nothing: it
 * would be asserting that the sizer respects its own limit, which is a
 * tautology. What matters is that a hand-crafted oversized proposal is refused,
 * and that the sizer is a convenience rather than the safeguard.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, rows, settle, orderIdOf, assert, roundEgp,
} from './helpers/harness.js';

test('SCENARIO 2: an oversized proposal is refused by POSITION_SIZE, and nothing executes', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const limit = h.limits.maxPositionSizeEgp;

    const d = h.buyDecision({ price: mid, quantity: 1, notionalEgp: mid });
    h.repos.insertDecision({
      decisionId: d.decisionId, symbol: d.symbol, strategyId: d.strategyId, price: mid,
      signal: 'BUY', quantity: 1, notionalEgp: mid, confidence: 0.9, maxLossEgp: 1,
      stopPrice: d.stopPrice, stopDistancePct: 1.5, riskRewardRatio: 1,
      reason: 'oversized probe', features: {}, expectedExecutionPrice: mid,
      stopCondition: d.stopCondition, action: 'PLACE_ORDER', agentState: 'HEALTHY',
    }, h.clock);

    // Sized to clear the POSITION cap (EGP 125) while still sitting UNDER the
    // portfolio EXPOSURE cap (EGP 250). That matters: the rules run in a fixed
    // order and EXPOSURE is evaluated first, so a probe that breached both
    // would legitimately be refused by EXPOSURE and would never prove anything
    // about POSITION_SIZE.
    const notional = roundEgp(limit * 1.2);
    assert.ok(notional > limit, 'the probe exceeds the position cap');
    assert.ok(notional < h.limits.maxPortfolioExposureEgp, 'the probe stays under the exposure cap');

    const oversized = {
      side: 'BUY',
      quantity: notional / mid,
      notionalEgp: notional,
      stopPrice: mid * 0.985,
      riskAtStopEgp: roundEgp(notional * 0.015),
      riskBudgetEgp: 1000,
      expectedExecutionPrice: mid,
      expectedSlippageBps: 5,
      expectedSlippageEgp: 0,
      feeBpsEstimate: 10,
    };

    const verdict = h.riskEngine.check({
      decision: d,
      proposal: oversized,
      account: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      killSwitch: { engaged: false, trigger: null, reason: null },
      quote: h.quote(),
      orderCounts: { day: 0, bySymbol: {} },
    });

    assert.equal(verdict.blocked, true, 'an oversized order must be blocked');
    assert.equal(verdict.failedRule, 'POSITION_SIZE', `blocked by POSITION_SIZE (was ${verdict.failedRule})`);

    const rule = verdict.rules.find((r) => r.rule === 'POSITION_SIZE');
    assert.equal(rule.status, 'BLOCK');
    assert.equal(rule.severity, 'CRITICAL');
    assert.ok(rule.data.notionalEgp > rule.data.limitEgp, 'the refusal records both numbers');

    // The refusal is persisted: a blocked order is as auditable as an execution.
    assert.equal(countRows(h, 'orders'), 0, 'no order row was created');
    assert.equal(countRows(h, 'risk_decisions') >= 1, true, 'the refusal IS recorded');
    const stored = h.repos.getRiskDecision(verdict.riskDecisionId);
    assert.equal(stored.blocked, 1, 'the stored record says blocked');
    assert.equal(stored.failed_rule, 'POSITION_SIZE');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 2b: no order that reaches the broker ever exceeds the position cap', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const limit = h.limits.maxPositionSizeEgp;

    // Three entries in the same symbol. The pipeline is free to block any of
    // them - that is the point - but whatever it allows through must respect the
    // cap. So this asserts the INVARIANT over every order that exists, rather
    // than demanding a particular number of fills.
    let submitted = 0;
    for (let i = 0; i < 3; i += 1) {
      const mid = h.quote().mid;
      const res = await h.submit(h.buyDecision({ price: mid, riskPctPerTrade: 5 }));
      if (res.outcome === 'EXECUTED') {
        submitted += 1;
        settle(h, orderIdOf(res.order), { maxTicks: 10 });
      }
      h.tickMarket();
    }
    assert.ok(submitted > 0, 'at least one order executed, so the cap was tested against real fills');

    const orders = rows(h, 'orders', { where: "status IN ('NEW','PARTIALLY_FILLED','FILLED')" });
    assert.equal(orders.length, submitted, 'every executed decision produced exactly one order row');
    for (const o of orders) {
      const notional = roundEgp(o.quantity * (o.expected_price ?? 0));
      assert.ok(
        notional <= limit + 0.01,
        `order ${o.order_id} notional EGP ${notional} must not exceed the EGP ${limit} position cap`,
      );
    }
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 2c: the position cap is derived from the EGP 500 ceiling, not a hard-coded number', () => {
  const h = createHarness();
  try {
    const cfg = h.config;
    // 25% of EGP 500.
    assert.equal(h.limits.maxPositionSizeEgp, 125, 'max position is 25% of EGP 500');
    assert.equal(h.limits.maxPortfolioExposureEgp, 250, 'max exposure is 50% of EGP 500');
    assert.equal(h.limits.maxLossPerTradeEgp, 5, 'max loss per trade is 1% of EGP 500');
    assert.equal(h.limits.dailyLossLimitEgp, 25, 'daily loss limit is 5% of EGP 500');
    assert.equal(h.limits.maxOpenPositions, 3);
    assert.equal(cfg.account.startingCapitalEgp, 500);
    assert.equal(cfg.risk.maxStartingCapitalEgp, 500);
  } finally {
    h.cleanup();
  }
});
