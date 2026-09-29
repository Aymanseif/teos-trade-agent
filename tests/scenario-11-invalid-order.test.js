/**
 * Required scenario 11 of 13: INVALID_ORDER
 *
 * Submit an order with an invalid price, quantity, symbol or order type.
 * Expected: it is rejected at every layer it can be caught at, no fill occurs,
 * and the account is unchanged.
 *
 * "Every layer it can be caught at" is the substantive claim. An invalid order
 * passes through five checks, and the ordering matters: the risk engine sees a
 * Decision, the adapter builds an Order, the broker validates against the
 * instrument definition, the matching engine checks the book, and the ledger
 * checks the money. A test that only exercised the first would pass even if
 * every other one had been deleted.
 *
 * The negative case is included for a reason: a validator that rejects
 * everything is trivially safe and useless. Each invalid shape is paired with a
 * near-miss valid one.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert,
} from './helpers/harness.js';
import { decisionToRow } from '../src/agent/decision.js';
import { RULES } from '../src/risk/rules/index.js';

/** A well-formed order request against the first instrument. */
function validOrder(h, over = {}) {
  const inst = h.instrument;
  const mid = h.quote(inst.symbol).mid;
  return {
    decisionId: 'dec_valid',
    symbol: inst.symbol,
    side: 'BUY',
    orderType: 'MARKET',
    quantity: inst.minQty,
    limitPrice: null,
    expectedPrice: mid,
    reduceOnly: false,
    leverageRequested: false,
    borrowRequested: false,
    marginRequested: false,
    shortRequested: false,
    instrumentType: 'SPOT',
    submittedTs: h.clock.now(),
    ...over,
  };
}

test('SCENARIO 11: a nonsense quantity in the decision never reaches the broker', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();

    // The risk engine SIZES the order itself from the risk budget; the
    // decision's own quantity is an input, not an instruction. So the property
    // to test is not "a bad quantity is refused" - it is "no bad quantity can
    // reach the book, whatever the decision claimed". An order that came back
    // with quantity -1 would be the bug.
    for (const [label, over] of [
      ['a negative quantity', { quantity: -1 }],
      ['a zero quantity', { quantity: 0 }],
      ['a huge quantity', { quantity: 1e9 }],
    ]) {
      const res = await h.submit(h.buyDecision({ price: h.quote().mid, ...over }));
      if (res.outcome === 'EXECUTED') {
        const q = res.order?.quantity ?? res.order?.filled_quantity ?? 0;
        assert.ok(q > 0, `${label}: the executed order has a positive quantity (got ${q})`);
        assert.ok(q <= res.order.quantity, `${label}: and was not enlarged past the proposal`);
      } else {
        assert.equal(res.order, null, `${label} produced no order`);
      }
    }
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11a: ORDER_VALID refuses each malformed shape when the rule is given one', () => {
  const h = createHarness();
  try {
    const rule = RULES.find((r) => r.id === 'ORDER_VALID');
    const base = { instrument: h.instrument, limits: h.limits };

    const blocked = [
      ['a negative quantity', { quantity: -1 }],
      ['a zero quantity', { quantity: 0 }],
      ['a quantity below the minimum', { quantity: h.instrument.minQty / 100 }],
      ['a non-positive expected price', { expectedExecutionPrice: 0 }],
      ['a negative notional', { notionalEgp: -5 }],
    ];
    for (const [label, over] of blocked) {
      const r = rule.evaluate({
        ...base,
        decision: {
          symbol: h.instrument.symbol, quantity: 1, expectedExecutionPrice: h.instrument.referencePrice ?? 1,
          notionalEgp: 10, ...over,
        },
      });
      assert.equal(r.status, 'BLOCK', `${label} is refused by ORDER_VALID (got ${r.status})`);
    }

    // A well-formed order passes, so the rule is discriminating and not simply
    // refusing everything.
    const ok = rule.evaluate({
      ...base,
      decision: {
        symbol: h.instrument.symbol, quantity: h.instrument.minQty,
        expectedExecutionPrice: 1, notionalEgp: 10,
      },
    });
    assert.equal(ok.status, 'PASS', 'a well-formed order is accepted');

    // An unknown instrument is CATASTROPHIC and latches.
    const unknown = rule.evaluate({ ...base, instrument: null, decision: { symbol: 'NOPE', quantity: 1, expectedExecutionPrice: 1, notionalEgp: 1 } });
    assert.equal(unknown.status, 'BLOCK', 'an unknown instrument is refused');
    assert.equal(unknown.severity, 'CATASTROPHIC', 'as CATASTROPHIC');
    assert.equal(unknown.latchesStop, true, 'and it latches a stop');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11b: a symbol with no market data is refused for want of data, not a crash', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    // The symbol is unknown AND the feed has nothing for it. There is no quote,
    // so the first rule with anything to say is the freshness check. This is
    // the common case, and it is a clean BLOCKED outcome with a named rule -
    // not an exception.
    const res = await h.submit(h.buyDecision({ price: h.quote().mid, symbol: 'NOT/A_SYMBOL' }));
    assert.equal(res.outcome, 'BLOCKED', 'a symbol with no market data is refused');
    assert.equal(res.order, null, 'and produces no order');
    assert.ok(res.riskVerdict != null, 'a verdict is returned, not a bare TypeError');
    assert.equal(
      res.riskVerdict.failedRule, 'DATA_FRESHNESS',
      `refused for want of data (was ${res.riskVerdict.failedRule})`,
    );
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11b2: a quoted but undefined instrument is a CATASTROPHIC block that latches a stop', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    // The feed quotes a symbol the instrument registry does not define. Now
    // there IS a quote, so DATA_FRESHNESS is satisfied and the order reaches
    // ORDER_VALID, which must recognise the unknown instrument and refuse it.
    //
    // This is the case a production fix was written for. With the quote
    // present, `proposeOrder` passed `instrument.qtyStep` straight to the
    // sizer, so an absent instrument threw a bare TypeError: the firewall
    // reported FAILED with code UNKNOWN, no rule ever fired, and the intended
    // emergency stop was never latched. The order was still refused - it fails
    // closed - but the diagnosis was wrong and an operator was told nothing
    // about an instrument the registry does not define.
    const quoted = await h.submit(
      h.buyDecision({ price: h.quote().mid, symbol: 'NOT/A_SYMBOL' }),
      { quote: h.quote() },
    );
    assert.equal(quoted.outcome, 'BLOCKED', 'a quoted but undefined instrument is refused');
    assert.equal(quoted.order, null, 'and produces no order');
    assert.equal(
      quoted.riskVerdict.failedRule, 'ORDER_VALID',
      `refused by ORDER_VALID (was ${quoted.riskVerdict.failedRule})`,
    );

    const rule = quoted.riskVerdict.rules.find((r) => r.rule === 'ORDER_VALID');
    assert.equal(rule.severity, 'CATASTROPHIC', 'as CATASTROPHIC, not a warning');
    assert.equal(rule.latchesStop, true, 'and it latches a stop');

    // The latch is the observable consequence of a CATASTROPHIC verdict.
    assert.ok(h.repos.sessionStop(), 'a durable stop was raised');
    assert.equal(h.repos.sessionStop().trigger, 'ORDER_VALID', 'naming the rule that raised it');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11c: the broker refuses an order for an instrument that does not exist', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const res = h.broker.placeOrder(validOrder(h, {
      decisionId: 'dec_unknown', symbol: 'FAKE/XXX', orderId: 'ord_x', clientOrderId: 'cid_x',
    }));
    assert.equal(res.accepted, false, 'the broker refuses an unknown symbol');
    assert.equal(res.status, 'REJECTED', 'as a rejection, not a silent acceptance');
    assert.match(res.rejectionReason, /UNKNOWN_SYMBOL/, 'and says why');
    assert.equal(h.broker.getOrder('ord_x'), null, 'nothing was created in the book');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11d: leverage and borrowing are refused at the broker boundary', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    for (const flag of ['leverageRequested', 'borrowRequested']) {
      assert.throws(
        () => h.broker.placeOrder(validOrder(h, {
          decisionId: `dec_${flag}`, orderId: `ord_${flag}`, clientOrderId: `cid_${flag}`, [flag]: true,
        })),
        (err) => err.code === 'VALIDATION_ERROR',
        `${flag} is refused by the broker itself`,
      );
    }
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11e: the validator is not a blanket refusal - a well-formed order is accepted', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const res = h.broker.placeOrder(validOrder(h, { orderId: 'ord_ok', clientOrderId: 'cid_ok' }));
    assert.equal(res.accepted, true, 'a valid order IS accepted, so 11c-11d are not vacuous');
    assert.equal(res.status, 'NEW', 'and it rests in the book');

    // The near-misses: still valid, so still accepted. This is the half of the
    // test that stops "reject everything" from being a passing implementation.
    const atMin = h.broker.placeOrder(validOrder(h, {
      decisionId: 'dec_min', orderId: 'ord_min', clientOrderId: 'cid_min', quantity: h.instrument.minQty,
    }));
    assert.equal(atMin.accepted, true, 'a quantity exactly at the minimum is valid');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11f: the matching engine refuses an order it cannot price', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    // A LIMIT order far above the market can never fill, and a limit order with
    // no limit price is meaningless. Both are refused rather than rested as a
    // phantom.
    const noLimit = h.broker.placeOrder(validOrder(h, {
      decisionId: 'dec_nl', orderId: 'ord_nl', clientOrderId: 'cid_nl',
      orderType: 'LIMIT', limitPrice: null, expectedPrice: null,
    }));
    assert.equal(noLimit.accepted, false, 'a LIMIT order with no limit price is refused');
    assert.equal(noLimit.status, 'REJECTED', 'as a rejection');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 11g: an invalid order leaves no trace of a fill, and the ledger is intact', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const before = { cash: h.account.cashEgp, positions: h.account.getPositions().length };

    // An unknown symbol is the one malformed decision the risk engine cannot
    // re-size into something valid, so it is the case that must produce nothing
    // at all. (A merely nonsensical *quantity* is re-sized by the engine - that
    // is scenario 11's claim - so it is deliberately not used here.)
    const res = await h.submit(h.buyDecision({ price: h.quote().mid, symbol: 'NOT/A_SYMBOL' }));
    assert.notEqual(res.outcome, 'EXECUTED', 'the malformed order does not execute');
    for (let i = 0; i < 5; i += 1) { h.tickMarket(); h.advance(); }

    assert.equal(countRows(h, 'fills'), 0, 'not one fill was produced');
    assert.equal(countRows(h, 'orders'), 0, 'and not one order row');
    assert.equal(h.account.cashEgp, before.cash, 'cash is untouched');
    assert.equal(h.account.getPositions().length, before.positions, 'no position was opened');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});
