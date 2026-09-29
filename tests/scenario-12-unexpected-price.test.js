/**
 * Required scenario 12 of 13: UNEXPECTED_PRICE
 *
 * Feed an unexpected price: a sudden spike, a crash, a runaway quote, a stale
 * print, or a price that simply disagrees with what the decision was formed on.
 * Expected: the order is refused, nothing is executed at the abnormal price, and
 * the agent degrades rather than trading through it.
 *
 * There are two DISTINCT price hazards and they are tested separately, because
 * conflating them hides bugs:
 *
 *   (a) MOVEMENT - the price moved far enough since the decision was formed that
 *       the order is no longer the one anybody reasoned about. Handled by
 *       `PRICE_SANITY`, which compares the live quote against the last stored
 *       snapshot.
 *   (b) COHERENCE - the price is internally inconsistent: zero, negative,
 *       non-finite, or a bid above the ask. Handled by `PRICE_SANITY` and by the
 *       broker's own validation.
 *
 * A price that is merely *large* is not a fault. Every test here moves the
 * price by an amount the market model itself would never produce, so a pass
 * cannot be explained by the shock being too small to notice.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert, roundEgp,
} from './helpers/harness.js';
import { decisionToRow } from '../src/agent/decision.js';
import { RULES } from '../src/risk/rules/index.js';

test('SCENARIO 12: a price that has moved far since the decision is refused', async () => {
  const h = createHarness();
  try {
    const symbol = h.config.instruments[0].symbol;
    h.tickMarket(); h.advance();
    const reference = h.quote(symbol).mid;

    // The decision is formed here, at a price the agent could actually see.
    const decision = h.buyDecision({ price: reference });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    // The market then moves by a multiple of what the market model can produce
    // on its own (`maxTickJumpBps`). A shock inside that band would be
    // indistinguishable from normal volatility, and the test would pass for the
    // wrong reason.
    const jumpBps = 10 * h.config.market.maxTickJumpBps;
    h.broker.simulator.forceJump(symbol, jumpBps);
    h.tickMarket();

    const shocked = h.quote(symbol).mid;
    assert.ok(
      Math.abs((shocked - reference) / reference) * 10_000 > h.config.market.maxTickJumpBps,
      'the price really did move beyond anything the model would produce',
    );

    const res = await h.submit(decision);
    assert.equal(res.outcome, 'BLOCKED', 'the order is refused');
    assert.equal(res.riskVerdict.failedRule, 'PRICE_SANITY', `refused by PRICE_SANITY (was ${res.riskVerdict.failedRule})`);

    const rule = res.riskVerdict.rules.find((r) => r.rule === 'PRICE_SANITY');
    assert.equal(rule.latchesStop, true, 'an unexplained move latches a stop: something is wrong upstream');
    assert.ok(rule.data.moveBps > h.config.market.maxTickJumpBps, 'and the refusal records how far it moved');

    assert.equal(countRows(h, 'orders'), 0, 'nothing was ordered at the abnormal price');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12a: the movement check is bounded - an ordinary wobble is allowed', async () => {
  const h = createHarness();
  try {
    const symbol = h.config.instruments[0].symbol;
    h.tickMarket(); h.advance();
    const reference = h.quote(symbol).mid;
    const decision = h.buyDecision({ price: reference });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    // A move well inside the model's own band. If this were refused, PRICE_SANITY
    // would be rejecting normal volatility, which is a defect in the other
    // direction - and a limit that refuses everything is as useless as one that
    // refuses nothing.
    h.broker.simulator.forceJump(symbol, Math.round(h.config.market.maxTickJumpBps / 4));
    h.tickMarket();

    const res = await h.submit(decision);
    assert.notEqual(res.outcome, 'BLOCKED', 'a modest move within the normal band is not refused');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12b: a price crash is treated exactly like a spike', async () => {
  const h = createHarness();
  try {
    const symbol = h.config.instruments[0].symbol;
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote(symbol).mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    h.broker.simulator.forceJump(symbol, -10 * h.config.market.maxTickJumpBps);
    h.tickMarket();

    const res = await h.submit(decision);
    assert.equal(res.outcome, 'BLOCKED', 'a crash is refused just as a spike is');
    assert.equal(res.riskVerdict.failedRule, 'PRICE_SANITY', 'by PRICE_SANITY');
    // `moveBps` is deliberately a MAGNITUDE - a crash and a spike are the same
    // hazard and are treated identically. The signed direction is not recorded,
    // and this test pins that as intended rather than accidental.
    const data = res.riskVerdict.rules.find((r) => r.rule === 'PRICE_SANITY').data;
    assert.ok(data.moveBps > 0, 'the size of the move is recorded');
    assert.ok(data.mid < data.referencePrice, 'and the reference it moved from is recorded, so the direction is derivable');
    assert.equal(countRows(h, 'orders'), 0, 'nothing was bought into the crash');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12c: an incoherent quote is refused - zero, negative and inverted', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const base = h.quote();
    const bad = [
      ['a zero price', { ...base, bid: 0, ask: 0, mid: 0 }],
      ['a negative price', { ...base, bid: -1, ask: -1, mid: -1 }],
      ['a bid above the ask', { ...base, bid: base.mid * 1.02, ask: base.mid * 0.98, mid: base.mid }],
    ];

    for (const [label, quote] of bad) {
      const res = await h.submit(h.buyDecision({ price: base.mid }), { quote });
      assert.notEqual(res.outcome, 'EXECUTED', `${label} never executes`);
      assert.equal(res.order, null, `${label} produces no order`);
    }
    assert.equal(countRows(h, 'orders'), 0, 'no incoherent quote produced an order');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12d: the broker refuses to mark an account at an impossible price', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const symbol = h.config.instruments[0].symbol;
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => h.broker.mark(symbol, price),
        (err) => err.code === 'VALIDATION_ERROR',
        `marking at ${price} is refused`,
      );
    }
    // The converse, so the check is discriminating rather than a blanket refusal.
    const ok = h.broker.mark(symbol, h.quote(symbol).mid * 1.01);
    assert.ok(ok != null, 'a sane mark price is accepted');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12e: PRICE_SANITY is armed before any order-affecting rule, and its boundary is exact', () => {
  const h = createHarness();
  try {
    const ids = RULES.map((r) => r.id);
    const sanityAt = ids.indexOf('PRICE_SANITY');
    assert.ok(sanityAt >= 0, 'PRICE_SANITY exists');
    // Everything after it that could allow an order through must not be able to
    // run first: a rule ordering that put a permissive rule above the sanity
    // check would let a bad price be traded on.
    for (const id of ['SUFFICIENT_BALANCE', 'POSITION_SIZE', 'RISK_PER_TRADE', 'DUPLICATE_ORDER']) {
      assert.ok(ids.indexOf(id) > sanityAt, `${id} is evaluated after PRICE_SANITY`);
    }

    // The boundary, asserted on the rule itself so it is exact rather than
    // approximate. The limit is the RISK limit on deviation (150bps), not the
    // market model's own per-tick jump bound - they are different numbers with
    // different jobs, and conflating them would make the test pass for the
    // wrong reason.
    const rule = RULES.find((r) => r.id === 'PRICE_SANITY');
    const limit = h.limits.priceDeviationLimitBps;
    assert.ok(limit > 0, 'the deviation limit is configured');
    const ctx = (reference) => ({
      decision: { symbol: h.instrument.symbol, quantity: 1, expectedExecutionPrice: 100, notionalEgp: 10 },
      instrument: h.instrument, quote: { mid: 100, spreadBps: 5 },
      referencePrice: reference, limits: h.limits, nowMs: h.clock.now(),
    });

    // Three bands, not two: below 60% of the limit the move is unremarkable, in
    // the 60%-100% band it is flagged but allowed, and only strictly ABOVE the
    // limit is it refused. An earlier draft asserted the limit itself was a
    // clean PASS, which it is not - it is a WARN. The block boundary is `>`.
    assert.equal(rule.evaluate(ctx(100 * (1 + (limit * 0.5) / 10_000))).status, 'PASS',
      'a move well inside the limit is unremarkable');
    assert.equal(rule.evaluate(ctx(100 * (1 + (limit * 0.8) / 10_000))).status, 'WARN',
      'a move in the warning band is flagged but allowed');
    assert.equal(rule.evaluate(ctx(100 * (1 + limit / 10_000))).status, 'WARN',
      'a move exactly AT the limit is still allowed, only flagged');
    assert.equal(rule.evaluate(ctx(100 * (1 + (limit + 5) / 10_000))).status, 'BLOCK',
      'a move past the limit is refused');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12f: a wide spread is treated as a price fault too', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const base = h.quote();
    // The rule reads `quote.spreadBps`, which the broker derives from bid/ask.
    // Widening the spread therefore means widening the spread field, not just
    // moving the prices - otherwise this test would assert nothing at all.
    const wide = (base.mid * 2 * h.limits.maxSpreadBps) / 10_000;
    const res = await h.submit(h.buyDecision({ price: base.mid }), {
      quote: { ...base, bid: base.mid - wide / 2, ask: base.mid + wide / 2, spreadBps: h.limits.maxSpreadBps * 2 },
    });
    assert.equal(res.outcome, 'BLOCKED', 'a spread twice the limit never executes');
    assert.equal(res.riskVerdict.failedRule, 'PRICE_SANITY', 'and is refused as a price fault');
    assert.equal(countRows(h, 'orders'), 0, 'no order is produced');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 12g: after an abnormal price the agent refuses to keep trading until it is cleared', async () => {
  const h = createHarness();
  try {
    const symbol = h.config.instruments[0].symbol;
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote(symbol).mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);
    h.broker.simulator.forceJump(symbol, 10 * h.config.market.maxTickJumpBps);
    h.tickMarket();

    await h.submit(decision);
    assert.ok(h.repos.sessionStop(), 'the shock latched a stop');

    // A fresh, well-formed decision at the NEW price is still refused. That is
    // the point of latching: the operator has to look, not just wait.
    const fresh = h.buyDecision({ price: h.quote(symbol).mid, symbol });
    h.advance();
    const after = await h.submit(fresh);
    assert.notEqual(after.outcome, 'EXECUTED', 'a subsequent decision is refused too');
    assert.equal(after.riskVerdict.failedRule, 'KILL_SWITCH', `by the latched stop (was ${after.riskVerdict.failedRule})`);
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});
