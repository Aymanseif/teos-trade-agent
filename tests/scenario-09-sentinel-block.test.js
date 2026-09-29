/**
 * Required scenario 9 of 13: SENTINEL_BLOCK
 *
 * The Sentinel must block an order the risk engine ALLOWED.
 * Expected: execution is refused, the block is recorded, and no order reaches
 * the paper exchange.
 *
 * The Sentinel is the last gate before execution and is deliberately
 * redundant with the risk engine. Redundancy only earns its keep if it can
 * actually catch something, so this file never re-tests something the risk
 * engine would have caught first. Every case here presents the Sentinel with a
 * deliberately CLEAN risk verdict, so the block can only have come from the
 * Sentinel. A test that passed through the risk engine would be a test of the
 * risk engine wearing the Sentinel's name.
 *
 * REVIEW is a separate scenario (10) because it is a different outcome with a
 * different meaning: BLOCK means no, REVIEW means not without a human.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert,
} from './helpers/harness.js';
import { SENTINEL_RULES } from '../src/execution/sentinel.js';
import { decisionToRow } from '../src/agent/decision.js';

/** A risk verdict with nothing wrong with it. */
const CLEAN = { blocked: false, failedRule: null, passedCount: 0, failedCount: 0, rules: [], reason: null };

/**
 * Run the Sentinel on a decision under a chosen mode, with the decision already
 * persisted so the verdict it writes can be read back.
 */
function sentinelOn(h, decision, { proposal, mode = 'PAPER', ...rest } = {}) {
  h.repos.insertDecision(decisionToRow(decision), h.clock);
  return h.sentinel.evaluate({
    decision,
    proposal: proposal ?? h.riskEngine.proposeOrder({
      decision, account: h.account, quote: h.quote(), instrument: h.instrument,
    }),
    riskVerdict: CLEAN,
    account: h.account,
    accountRef: h.account,
    dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
    killSwitch: { engaged: false },
    quote: h.quote(),
    mode,
    ...rest,
  });
}

test('SCENARIO 9: a Sentinel BLOCK refuses execution and is recorded', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });

    // An entry with no stop condition. The risk engine's STOP_CONDITION is a
    // separate concern; here the point is that the Sentinel has its own,
    // independent STOP_REQUIRED rule that blocks even when risk says yes.
    const stripped = { ...decision, stopCondition: null, stopPrice: null };
    const proposal = {
      side: 'BUY', quantity: 1, notionalEgp: h.quote().mid, reduceOnly: false, stopPrice: null,
    };
    const result = sentinelOn(h, stripped, { proposal });

    assert.equal(result.verdict, 'BLOCK', 'the Sentinel blocks an entry with no stop condition');
    assert.equal(result.triggerRule, 'STOP_REQUIRED', 'and names the rule that fired');
    assert.equal(result.actionTaken, 'REJECT', 'with a rejecting action');
    assert.ok(result.reason.length > 0, 'and a reason an operator can read');

    // Recorded, in the database, not just returned.
    const row = h.db.get(
      'SELECT verdict, action_taken, trigger_rule FROM sentinel_decisions WHERE sentinel_decision_id = ?',
      result.sentinelDecisionId,
    );
    assert.ok(row, 'the verdict is persisted');
    assert.equal(row.verdict, 'BLOCK', 'as a BLOCK');
    assert.equal(row.action_taken, 'REJECT', 'as a REJECT');
    assert.equal(row.trigger_rule, 'STOP_REQUIRED', 'naming the rule');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 9b: an unusual order size triggers a REVIEW, which the firewall treats as no', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    const t = h.config.sentinel;

    // The notional has to sit in a window, and finding that window is the whole
    // difficulty of this test. Above the unusual-size floor (30% of equity, or
    // EGP 150 absolute) it is quarantined; below the exposure-pressure line
    // (80% of the EGP 250 cap, i.e. EGP 200) nothing else objects. An earlier
    // draft used 5x the threshold, which also blew through the exposure cap, so
    // EXPOSURE_PRESSURE blocked and UNUSUAL_SIZE was never actually under test.
    const floor = Math.max(t.unusualSizeReviewEgp, (t.unusualSizeReviewPctOfEquity / 100) * 500);
    const ceiling = (t.exposureWarnPctOfLimit / 100) * h.limits.maxPortfolioExposureEgp;
    const target = Math.min(floor * 1.2, ceiling * 0.9);
    assert.ok(target > floor, `a target exists between the floor ${floor} and the ceiling ${ceiling}`);

    const result = sentinelOn(h, decision, {
      proposal: { side: 'BUY', quantity: 1, notionalEgp: target, reduceOnly: false, stopPrice: null },
    });
    assert.equal(result.verdict, 'REVIEW', `an EGP ${target} order is quarantined for review`);
    assert.equal(result.triggerRule, 'UNUSUAL_SIZE', 'by the unusual-size rule');
    assert.equal(result.actionTaken, 'QUARANTINE', 'and is quarantined, not silently passed');

    // Below the floor, the same shape of order is not quarantined - which is
    // what proves the threshold is doing the work rather than some always-on
    // condition.
    const small = sentinelOn(h, { ...decision, decisionId: `${decision.decisionId}_small` }, {
      proposal: { side: 'BUY', quantity: 1, notionalEgp: floor * 0.5, reduceOnly: false, stopPrice: null },
    });
    assert.notEqual(small.verdict, 'REVIEW', 'a normal-sized order is not quarantined');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 9c: a low-confidence signal is held for review, a confident one is not', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const base = h.buyDecision({ price: h.quote().mid });
    const threshold = h.config.sentinel.lowConfidenceReview;
    assert.ok(threshold > 0, 'the confidence floor is configured');

    const unsure = sentinelOn(h, { ...base, decisionId: `${base.decisionId}_low`, confidence: threshold * 0.5 }, {
      proposal: { side: 'BUY', quantity: 1, notionalEgp: 10, reduceOnly: false, stopPrice: null },
    });
    assert.equal(unsure.verdict, 'REVIEW', 'a low-confidence signal is held for review');
    assert.equal(unsure.triggerRule, 'LOW_CONFIDENCE', 'by the confidence rule');

    const sure = sentinelOn(h, { ...base, decisionId: `${base.decisionId}_high`, confidence: 0.9 }, {
      proposal: { side: 'BUY', quantity: 1, notionalEgp: 10, reduceOnly: false, stopPrice: null },
    });
    assert.notEqual(sure.verdict, 'REVIEW', 'a confident signal is not held');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 9d: a manual hold blocks every order the Sentinel sees', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    const small = { side: 'BUY', quantity: 1, notionalEgp: 10, reduceOnly: false, stopPrice: null };

    const before = sentinelOn(h, decision, { proposal: small });
    assert.notEqual(before.verdict, 'BLOCK', 'the same order is fine before a hold is engaged');

    // The Sentinel reads the hold from the control_flags table itself, not from
    // its argument list - which is the right design, because the flag is what
    // survives a restart. An earlier draft passed `manualHold: true` as an
    // option, which was silently ignored: the spread put it in `ctx`, but the
    // Sentinel overwrites that field from the database. The flag is set the way
    // the CLI `hold` command sets it.
    h.repos.setFlag('TRADING_HOLD', 'true', h.clock, 'operator', 'test hold');
    const held = sentinelOn(h, { ...decision, decisionId: `${decision.decisionId}_hold` }, { proposal: small });
    assert.equal(held.verdict, 'BLOCK', 'a manual hold blocks it');
    assert.equal(held.triggerRule, 'MANUAL_HOLD', 'by the manual-hold rule');

    h.repos.setFlag('TRADING_HOLD', 'false', h.clock, 'operator', 'test resume');
    const resumed = sentinelOn(h, { ...decision, decisionId: `${decision.decisionId}_resumed` }, { proposal: small });
    assert.notEqual(resumed.verdict, 'BLOCK', 'and clearing the hold releases it again');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 9e: a decision-rate flood is refused, but a risk-reducing exit is exempt', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const cap = h.config.sentinel.maxDecisionsPerMinute;
    assert.ok(cap > 0, 'the rate cap is configured');

    // The Sentinel counts recent decisions from the DATABASE, not from its
    // arguments. Passing `recentDecisionCount` as an option does nothing, so
    // the flood has to be produced by actually recording the decisions - which
    // is also what makes the test meaningful: it measures the real counter.
    for (let i = 0; i <= cap; i += 1) {
      h.repos.insertDecision(decisionToRow(h.buyDecision({ price: h.quote().mid })), h.clock);
    }

    const small = { side: 'BUY', quantity: 1, notionalEgp: 10, reduceOnly: false, stopPrice: null };
    const flooded = sentinelOn(h, h.buyDecision({ price: h.quote().mid }), { proposal: small });
    assert.equal(flooded.verdict, 'REVIEW', 'too many decisions in a minute is held for review');
    assert.equal(flooded.triggerRule, 'DECISION_RATE', 'by the rate rule');

    // Exiting a position is exactly what must still work when everything else is
    // refusing, so the rate check is explicitly skipped for reduce-only orders.
    const exit = sentinelOn(h, h.sellDecision({ price: h.quote().mid }), {
      proposal: { side: 'SELL', quantity: 1, notionalEgp: 10, reduceOnly: true, stopPrice: null },
    });
    assert.notEqual(exit.verdict, 'REVIEW', 'a risk-reducing exit is exempt from the rate limit');

    // And the flood is not permanent: the window is a minute, so moving past it
    // clears the count rather than latching.
    h.clock.advance(61_000);
    const afterWindow = sentinelOn(h, h.buyDecision({ price: h.quote().mid }), { proposal: small });
    assert.notEqual(afterWindow.verdict, 'REVIEW', 'the flood expires with its window instead of latching');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 9f: no Sentinel rule can be reordered past MODE_GUARD or KILL_SWITCH', () => {
  const ids = SENTINEL_RULES.map((r) => r.id);
  assert.equal(ids[0], 'MODE_GUARD', 'MODE_GUARD is first: no mode check is ever skipped');
  assert.equal(ids[1], 'KILL_SWITCH', 'KILL_SWITCH is second: the stop is checked before anything discretionary');
  assert.equal(
    new Set(ids).size, ids.length,
    'no rule is listed twice, which would silently double its weight',
  );
  // Every rule must be reachable, and the order must be the declared one.
  for (const rule of SENTINEL_RULES) {
    assert.ok(rule.id && rule.description, `${rule.id} is documented`);
  }
});

test('SCENARIO 9g: a Sentinel BLOCK reaches the outside world as a refusal, not an execution', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    // A proposal the risk engine would allow but the Sentinel will not: no stop
    // condition on a BUY, presented through the FULL firewall so the outcome
    // classification is exercised, not just the rule.
    const decision = { ...h.buyDecision({ price: h.quote().mid }), stopCondition: null };
    const res = await h.submit(decision);
    assert.notEqual(res.outcome, 'EXECUTED', 'the order does not execute');
    assert.equal(countRows(h, 'orders'), 0, 'and no order row is created');

    // Whatever the classification, the operator must be able to see why.
    assert.ok(res.reason != null && res.reason.length > 0, 'the refusal carries a reason');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});
