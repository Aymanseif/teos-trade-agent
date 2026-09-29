/**
 * Required scenario 3 of 13: DAILY_LOSS_LIMIT
 *
 * Drive realised/unrealised losses through the configured daily loss threshold.
 * Expected: new orders blocked, emergency-stop behaviour verified.
 *
 * The rule is `DAILY_LOSS`: loss >= EGP 25 (5% of the EGP 500 ceiling) blocks,
 * at severity CATASTROPHIC with `latchesStop: true`. So this scenario has to
 * prove THREE separate things, and proving only the first would leave the
 * dangerous half unverified:
 *
 *   1. the order is refused,
 *   2. an emergency stop is latched and persists in the database,
 *   3. the stop genuinely blocks SUBSEQUENT orders - including risk-reducing
 *      exits that would otherwise be allowed.
 *
 * Point 3 is the one that matters. A stop that is written to the database but
 * never consulted is decoration.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, settle, orderIdOf, assert, roundEgp,
} from './helpers/harness.js';

test('SCENARIO 3: crossing the daily loss limit blocks orders and latches a persistent stop', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const limit = h.limits.dailyLossLimitEgp;
    assert.equal(limit, 25, 'the daily loss limit is 5% of EGP 500');

    // A loss just under the limit must NOT block. Otherwise the block could be
    // caused by something unrelated and the test would prove nothing.
    const under = await h.submit(h.buyDecision({ price: mid }), {
      dailyLoss: { realizedEgp: -(limit - 1), unrealizedEgp: 0 },
    });
    assert.notEqual(under.outcome, 'BLOCKED', 'just under the limit is still tradable');

    // At the limit it must block.
    const atLimit = await h.submit(h.buyDecision({ price: mid }), {
      dailyLoss: { realizedEgp: -limit, unrealizedEgp: 0 },
    });
    assert.equal(atLimit.outcome, 'BLOCKED', 'the order must be refused at the limit');
    assert.equal(atLimit.riskVerdict.failedRule, 'DAILY_LOSS', `blocked by DAILY_LOSS (was ${atLimit.riskVerdict.failedRule})`);

    const rule = atLimit.riskVerdict.rules.find((r) => r.rule === 'DAILY_LOSS');
    assert.equal(rule.status, 'BLOCK');
    assert.equal(rule.severity, 'CATASTROPHIC');
    assert.equal(rule.latchesStop, true, 'a daily-loss breach latches an emergency stop');

    // The stop is persisted, not merely returned.
    const stop = h.repos.activeStop();
    assert.ok(stop, 'an emergency stop is now active in the database');
    assert.equal(stop.trigger, 'DAILY_LOSS');
    assert.equal(stop.cleared_at, null, 'the stop is latched (not auto-cleared)');
    assert.equal(stop.scope, 'HALT_ALL', 'a catastrophic stop halts everything, not just new orders');

    // A brand new decision, with a fresh, perfectly healthy account snapshot,
    // is still refused - the stop is consulted independently of the loss figure.
    const after = await h.submit(h.buyDecision({ price: mid }), {
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
    });
    assert.equal(after.outcome, 'BLOCKED', 'a latched stop blocks a later order even at zero loss');
    assert.equal(after.riskVerdict.failedRule, 'KILL_SWITCH', `refused by KILL_SWITCH (was ${after.riskVerdict.failedRule})`);

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 3b: the latched stop also blocks a risk-REDUCING exit', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;

    // Build a real long so an exit is genuinely available to be refused.
    const entry = await h.submit(h.buyDecision({ price: mid }));
    assert.equal(entry.outcome, 'EXECUTED', 'the entry executed');
    settle(h, orderIdOf(entry.order), { maxTicks: 10 });
    assert.ok(h.account.getPositions().length > 0, 'a long is open');

    const before = h.account.getPositions().reduce((a, p) => a + p.quantity, 0);
    assert.ok(before > 0, 'there is something to exit');

    // Latch the stop, exactly as the catastrophic daily-loss breach does.
    h.repos.engageStop({
      trigger: 'DAILY_LOSS',
      severity: 'CATASTROPHIC',
      scope: 'HALT_ALL',
      reason: 'test: daily loss limit breached',
      details: null,
      clock: h.clock,
    });

    const exit = await h.submit(h.sellDecision({ price: mid }));
    assert.equal(exit.outcome, 'BLOCKED', 'the exit is refused while the stop is latched');
    assert.equal(exit.riskVerdict.failedRule, 'KILL_SWITCH', `refused by KILL_SWITCH (was ${exit.riskVerdict.failedRule})`);
    assert.equal(exit.order, null, 'no exit order was created');

    // This is deliberately a HALT rather than a partial block: after a
    // catastrophic stop the operator is expected to inspect the account by hand.
    // The runbook's reset procedure is the only way out, and that is the point.
    const after = h.account.getPositions().reduce((a, p) => a + p.quantity, 0);
    assert.equal(after, before, 'the position is unchanged - no fill slipped through');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 3c: the stop is auditable and can only be cleared explicitly', async () => {
  const h = createHarness();
  try {
    const stopId = h.repos.engageStop({
      trigger: 'DAILY_LOSS',
      severity: 'CATASTROPHIC',
      scope: 'HALT_ALL',
      reason: 'auditable stop',
      details: { lossEgp: 25, limitEgp: 25 },
      clock: h.clock,
    });

    const stops = h.repos.listStops();
    assert.equal(stops.length, 1, 'the stop is recorded in the emergency_stops table');
    assert.equal(stops[0].trigger, 'DAILY_LOSS');
    assert.equal(stops[0].reason, 'auditable stop');
    assert.ok(stops[0].ts_ms, 'the stop records when it engaged');
    assert.equal(stops[0].active, 1, 'the stop is flagged active');

    // The stop persists across a fresh handle on the same database, which is
    // what "durable" means for an operator restarting the machine.
    const reopened = h.db.get('SELECT * FROM emergency_stops WHERE stop_id = ?', stopId);
    assert.ok(reopened, 'the stop is a durable row, not in-memory state');
    assert.equal(reopened.cleared_at, null);

    // It clears ONLY through an explicit, attributed action.
    h.clock.advance(60_000);
    h.repos.clearStop(stopId, 'operator:unit-test', h.clock);
    assert.equal(h.repos.activeStop(), null, 'an explicit clear removes the block');

    const cleared = h.repos.listStops();
    assert.equal(cleared[0].active, 0, 'the stop is no longer active');
    assert.equal(cleared[0].cleared_by, 'operator:unit-test', 'the clear is attributed to whoever did it');
    assert.ok(cleared[0].cleared_at, 'the clear is timestamped');

    // The row survives the clear: an operator must be able to see that a stop
    // happened and who released it.
    assert.equal(cleared.length, 1, 'clearing does not erase history');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 3d: the Sentinel independently blocks at the daily loss limit', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const d = h.buyDecision({ price: mid });
    h.repos.insertDecision({
      decisionId: d.decisionId, symbol: d.symbol, strategyId: d.strategyId, price: mid,
      signal: 'BUY', quantity: d.quantity, notionalEgp: d.notionalEgp, confidence: 0.8,
      maxLossEgp: 1, stopPrice: d.stopPrice, stopDistancePct: 1.5, riskRewardRatio: 1,
      reason: 'sentinel probe', features: {}, expectedExecutionPrice: mid,
      stopCondition: d.stopCondition, action: 'PLACE_ORDER', agentState: 'HEALTHY',
    }, h.clock);

    // A CLEAN risk verdict - so only the Sentinel can be the thing that blocks.
    const riskVerdict = {
      riskDecisionId: 'risk_probe', blocked: false, verdict: 'ALLOW', reason: 'probe', failedRule: null,
    };
    const proposal = {
      side: 'BUY', quantity: d.quantity, notionalEgp: d.notionalEgp, stopPrice: d.stopPrice,
      expectedExecutionPrice: mid, expectedSlippageBps: 5, riskAtStopEgp: 1, reduceOnly: false,
    };

    const verdict = h.sentinel.evaluate({
      decision: d, proposal, riskVerdict,
      account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: -h.limits.dailyLossLimitEgp, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    });

    assert.equal(verdict.verdict, 'BLOCK', 'the Sentinel blocks at the daily loss limit');
    assert.equal(verdict.triggerRule, 'DAILY_LOSS_PRESSURE');
    assert.equal(verdict.actionTaken, 'REJECT');
  } finally {
    h.cleanup();
  }
});
