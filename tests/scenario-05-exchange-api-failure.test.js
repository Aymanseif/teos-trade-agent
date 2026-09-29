/**
 * Required scenario 5 of 13: EXCHANGE / API FAILURE
 *
 * Simulate an exchange or API failure.
 * Expected: system does not crash, no orders placed while the venue is down,
 * trading halts or degrades safely, and recovery is possible.
 *
 * The failure is produced through the broker's own injection points
 * (`DISCONNECT`, `DATA_STALL`, `ABNORMAL_PRICE`) rather than by replacing the
 * broker with a stub. That distinction matters: a stubbed broker would only
 * prove the test can survive a throw, whereas the injected failure exercises the
 * health accounting, the CONNECTION rule, the state machine and the restart
 * path that production actually depends on.
 *
 * The central claim being tested is FAIL-OPEN-vs-CLOSED in the right direction:
 * a venue outage must stop orders, never create them.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert,
} from './helpers/harness.js';
import { AgentEngine } from '../src/agent/engine.js';
import { AgentStateMachine, STATES } from '../src/agent/state.js';

test('SCENARIO 5: a disconnected venue stops order flow without crashing the agent', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const before = countRows(h, 'orders');
    assert.equal(h.broker.health().ok, true, 'the venue starts healthy');

    // The real failure mechanism, not a mock.
    h.broker.injectFailure({ type: 'DISCONNECT' });

    const health = h.broker.health();
    assert.equal(health.connected, false, 'the broker reports itself disconnected');
    assert.equal(health.ok, false, 'and reports itself unhealthy');

    // Placing an order against a down venue must throw rather than silently
    // "succeed" - the caller has to learn that nothing reached the exchange.
    assert.throws(
      () => h.broker.placeOrder({ clientOrderId: 'x', symbol: h.config.instruments[0].symbol }),
      (err) => err.code === 'CONNECTION_ERROR',
      'placeOrder refuses to run while disconnected',
    );

    // The risk engine sees the same fact and blocks at CONNECTION.
    const res = await h.submit(h.buyDecision({ price: h.quote().mid }), {
      brokerHealth: h.broker.health(),
    });
    assert.equal(res.outcome, 'BLOCKED', 'no order is created while the venue is down');
    assert.equal(res.riskVerdict.failedRule, 'CONNECTION', `blocked by CONNECTION (was ${res.riskVerdict.failedRule})`);
    assert.equal(countRows(h, 'orders'), before, 'the order count did not move');

    // And it latches: a connectivity fault is systemic, not a one-off.
    const rule = res.riskVerdict.rules.find((r) => r.rule === 'CONNECTION');
    assert.equal(rule.latchesStop, true, 'a disconnected venue latches a stop');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 5b: the agent goes to HALTED on a disconnect and recovers to DEGRADED, not straight to HEALTHY', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const state = new AgentStateMachine({ repos: h.repos, clock: h.clock, initial: STATES.HEALTHY });
    const agent = new AgentEngine({
      config: h.config, clock: h.clock, repos: h.repos, account: h.account,
      broker: h.broker, riskEngine: h.riskEngine, state, strategyId: 'sma_cross',
    });

    h.broker.injectFailure({ type: 'DISCONNECT' });
    h.broker.disconnect();
    await agent.evaluateOnce({ symbols: [h.config.instruments[0].symbol] });

    assert.equal(state.state, STATES.HALTED, 'a disconnect halts the agent');
    assert.equal(state.permissions.openPosition, false, 'a halted agent may not open positions');
    assert.equal(state.permissions.reduceOnly, true, 'but it may still take risk off');

    h.broker.clearFailure();
    h.broker.connect();
    await agent.evaluateOnce({ symbols: [h.config.instruments[0].symbol] });

    assert.equal(state.state, STATES.DEGRADED, 'recovery de-escalates to DEGRADED, never straight to HEALTHY');
    assert.equal(state.permissions.openPosition, false, 'DEGRADED still refuses new exposure');

    // Only a second clean cycle grants full permission.
    await agent.evaluateOnce({ symbols: [h.config.instruments[0].symbol] });
    assert.equal(state.state, STATES.HEALTHY, 'a second clean cycle restores HEALTHY');
    assert.equal(state.permissions.openPosition, true);

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 5c: failures below the threshold warn, and the threshold itself halts', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const threshold = h.config.risk.consecutiveFailureHaltCount;
    assert.equal(threshold, 3, 'the halt threshold is 3 consecutive failures');

    // Connected, but flapping. The rule deliberately does NOT halt on the first
    // failure - a single blip must not end trading for the day - so this is
    // where the WARN band is verified, up to but not including the threshold.
    const flapping = (n) => ({
      ...h.broker.health(),
      ok: false,
      connected: true,
      consecutiveFailures: n,
      failure: { type: 'DISCONNECT' },
    });

    for (let n = 1; n < threshold; n += 1) {
      const res = await h.submit(h.buyDecision({ price: h.quote().mid }), {
        brokerHealth: flapping(n),
      });
      const rule = res.riskVerdict.rules.find((r) => r.rule === 'CONNECTION');
      assert.equal(rule.status, 'WARN', `${n} consecutive failure(s) warns rather than halts`);
      assert.equal(res.riskVerdict.blocked, false, `${n} failure(s) still allows trading`);
    }

    // At the threshold it halts, and latches.
    const atThreshold = await h.submit(h.buyDecision({ price: h.quote().mid }), {
      brokerHealth: flapping(threshold),
    });
    assert.equal(atThreshold.outcome, 'BLOCKED', 'the threshold halts trading');
    assert.equal(atThreshold.riskVerdict.failedRule, 'CONNECTION', 'blocked by CONNECTION');
    const rule = atThreshold.riskVerdict.rules.find((r) => r.rule === 'CONNECTION');
    assert.equal(rule.latchesStop, true, 'a persistent outage latches a stop');
    assert.equal(rule.data.consecutiveFailures, threshold, 'the refusal records the failure count');

    // A fully disconnected venue blocks immediately, without waiting for three.
    const down = await h.submit(h.buyDecision({ price: h.quote().mid }), {
      brokerHealth: { ...h.broker.health(), ok: false, connected: false, consecutiveFailures: 0 },
    });
    assert.equal(down.outcome, 'BLOCKED', 'a hard disconnect halts on the first reading');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 5d: an abnormal price from the venue is a refusal, not a trade at a crazy price', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    h.advance();
    const symbol = h.config.instruments[0].symbol;
    const before = h.quote(symbol).mid;

    // The documented injection point. This is the exact path scenario 12
    // (UNEXPECTED_PRICE) also exercises; here the claim is narrower - the fault
    // is actually injected, and the pipeline refuses rather than trading.
    //
    // Note the tick is NOT followed by a clock advance. That is the worker's
    // ordering too: the snapshot for this tick is stamped with the current
    // clock time, the risk engine then asks for the snapshot strictly before
    // it, and that is what it compares against. Advancing first would make the
    // reference this tick's own price and the measured move exactly 0bps.
    h.broker.injectFailure({ type: 'ABNORMAL_PRICE' });
    h.tickMarket();

    const after = h.quote(symbol).mid;
    const moveBps = Math.abs((after - before) / before) * 10_000;
    assert.ok(
      moveBps > h.config.market.maxTickJumpBps,
      `the injected fault really moved the price (${moveBps.toFixed(0)}bps > ${h.config.market.maxTickJumpBps}bps)`,
    );

    const res = await h.submit(h.buyDecision({ price: after }));
    assert.equal(res.outcome, 'BLOCKED', 'an abnormal price blocks trading');
    assert.equal(res.riskVerdict.failedRule, 'PRICE_SANITY', `blocked by PRICE_SANITY (was ${res.riskVerdict.failedRule})`);

    const priceRule = res.riskVerdict.rules.find((r) => r.rule === 'PRICE_SANITY');
    assert.equal(priceRule.latchesStop, true, 'an abnormal price latches a stop');
    assert.ok(priceRule.data.moveBps > h.config.market.maxTickJumpBps, 'the refusal records the size of the move');

    assert.equal(countRows(h, 'orders'), 0, 'nothing was ordered at the abnormal price');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 5e: a venue outage is recorded for an operator, not swallowed', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    h.broker.injectFailure({ type: 'DISCONNECT' });
    await h.submit(h.buyDecision({ price: h.quote().mid }), { brokerHealth: h.broker.health() });

    const stops = h.repos.listStops();
    assert.ok(stops.length >= 1, 'the outage latched a durable stop record');
    assert.match(stops[stops.length - 1].trigger, /CONNECTION|DATA_FRESHNESS|PRICE_SANITY/);

    // The stop names a reason an operator can act on.
    assert.ok(stops[stops.length - 1].reason.length > 10, 'the stop carries a human-readable reason');
  } finally {
    h.cleanup();
  }
});
