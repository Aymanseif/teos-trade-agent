/**
 * Required scenario 10 of 13: SENTINEL_REVIEW
 *
 * The Sentinel must flag an order for human review.
 * Expected: the order is NOT executed, the decision is recorded as awaiting
 * review, unrelated trading continues, and the review state is visible.
 *
 * REVIEW is deliberately different from BLOCK and the difference is the point.
 * A BLOCK is a refusal with no appeal. A REVIEW is a refusal that is ALSO a
 * request: the order is held, an operator can see it and decide, and - this is
 * the part that is easy to get wrong - every OTHER decision carries on trading.
 * A review queue that silently halts the whole agent is a BLOCK wearing a
 * different name, and the dashboard cannot tell the operator which they have.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert,
} from './helpers/harness.js';
import { decisionToRow } from '../src/agent/decision.js';

const CLEAN = { blocked: false, failedRule: null, passedCount: 0, failedCount: 0, rules: [], reason: null };

test('SCENARIO 10: a REVIEW verdict quarantines the order and records it for a human', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    const threshold = h.config.sentinel.lowConfidenceReview;
    const result = h.sentinel.evaluate({
      decision: { ...decision, confidence: threshold * 0.5 },
      proposal: h.riskEngine.proposeOrder({ decision, account: h.account, quote: h.quote(), instrument: h.instrument }),
      riskVerdict: CLEAN, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    });

    assert.equal(result.verdict, 'REVIEW', 'a low-confidence decision is sent for review');
    assert.equal(result.actionTaken, 'QUARANTINE', 'and is quarantined rather than executed');
    assert.equal(result.triggerRule, 'LOW_CONFIDENCE', 'naming the rule that asked for review');
    assert.ok(result.reason.includes(String(threshold * 0.5).slice(0, 4)) || result.reason.length > 0,
      'with a reason an operator can judge');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 10b: REVIEW blocks THIS order without stopping the rest of the agent', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    const held = h.sentinel.evaluate({
      decision: { ...decision, confidence: 0.01 },
      proposal: h.riskEngine.proposeOrder({ decision, account: h.account, quote: h.quote(), instrument: h.instrument }),
      riskVerdict: CLEAN, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    });
    assert.equal(held.verdict, 'REVIEW', 'the weak signal is quarantined');

    // The agent is still running and still able to act. A quarantine is a
    // verdict about ONE decision; if it also stopped the agent, then the
    // Sentinel would be implementing a kill switch, which is scenario 8's job.
    const other = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(other), h.clock);
    const fine = h.sentinel.evaluate({
      decision: { ...other, confidence: 0.95 },
      proposal: h.riskEngine.proposeOrder({ decision: other, account: h.account, quote: h.quote(), instrument: h.instrument }),
      riskVerdict: CLEAN, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    });
    assert.equal(fine.verdict, 'ALLOW', 'a confident decision is unaffected by the other one being quarantined');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 10c: a quarantined decision is listed for review, and only that decision', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const reviewable = h.buyDecision({ price: h.quote().mid });
    const normal = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(reviewable), h.clock);
    h.repos.insertDecision(decisionToRow(normal), h.clock);

    const base = {
      riskVerdict: CLEAN, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    };
    h.sentinel.evaluate({
      ...base, decision: { ...reviewable, confidence: 0.01 },
      proposal: h.riskEngine.proposeOrder({ decision: reviewable, account: h.account, quote: h.quote(), instrument: h.instrument }),
    });
    h.sentinel.evaluate({
      ...base, decision: { ...normal, confidence: 0.95 },
      proposal: h.riskEngine.proposeOrder({ decision: normal, account: h.account, quote: h.quote(), instrument: h.instrument }),
    });

    const quarantined = h.repos.db.all(
      `SELECT decision_id FROM sentinel_decisions
        WHERE mode = 'PAPER' AND action_taken = 'QUARANTINE'`,
    );
    assert.equal(quarantined.length, 1, 'exactly one decision is awaiting review');
    assert.equal(quarantined[0].decision_id, reviewable.decisionId, 'and it is the weak one, not the strong one');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 10d: a REVIEW is a distinct outcome from a BLOCK, and both are distinct from ALLOW', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);
    const base = {
      proposal: h.riskEngine.proposeOrder({ decision, account: h.account, quote: h.quote(), instrument: h.instrument }),
      riskVerdict: CLEAN, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false }, quote: h.quote(), mode: 'PAPER',
    };

    // The base decision is already persisted above; the two variants need their
    // own rows, because the Sentinel's verdict carries a foreign key back to the
    // decision and an unknown id fails the write with FOREIGN KEY instead of
    // producing a verdict.
    const reviewDecision = { ...decision, decisionId: `${decision.decisionId}_r`, confidence: 0.01 };
    const blockDecision = { ...decision, decisionId: `${decision.decisionId}_b` };
    h.repos.insertDecision(decisionToRow(reviewDecision), h.clock);
    h.repos.insertDecision(decisionToRow(blockDecision), h.clock);

    const allow = h.sentinel.evaluate({ ...base, decision });
    const review = h.sentinel.evaluate({ ...base, decision: reviewDecision });
    const block = h.sentinel.evaluate({ ...base, decision: blockDecision, killSwitch: { engaged: true } });

    // Four distinct outcomes, each mapping to its own action. Collapsing any two
    // of them would leave an operator unable to tell "not now, ask someone" from
    // "no" from "go".
    assert.equal(allow.verdict, 'ALLOW');
    assert.equal(allow.actionTaken, 'PASS');
    assert.equal(review.verdict, 'REVIEW');
    assert.equal(review.actionTaken, 'QUARANTINE');
    assert.equal(block.verdict, 'BLOCK');
    assert.equal(block.actionTaken, 'REJECT');

    const actions = new Set([allow.actionTaken, review.actionTaken, block.actionTaken]);
    assert.equal(actions.size, 3, 'the three outcomes take three different recorded actions');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 10e: a review does not consume order budget or place anything', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    const res = await h.submit({ ...decision, confidence: 0.01 });
    assert.notEqual(res.outcome, 'EXECUTED', 'a low-confidence decision is not executed');
    assert.equal(countRows(h, 'orders'), 0, 'no order reaches the paper exchange');
    assert.equal(h.account.getPositions().length, 0, 'and no position is opened');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});
