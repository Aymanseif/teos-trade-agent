/**
 * Required scenario 6 of 13: DUPLICATE_ORDER_PREVENTION
 *
 * Submit the same decision twice.
 * Expected: the second submission is rejected; only one order exists; no double
 * position is opened.
 *
 * The client_order_id is a deterministic hash of the decision id, so this is not
 * a probabilistic property that happens to hold for most inputs - it is
 * structural. The same decision replays to the same id, and a UNIQUE column plus
 * a broker-side lookup means the second attempt is refused whether it arrives
 * 1ms later or after a restart three hours later.
 *
 * Three layers are tested, because each can fail on its own:
 *   - the risk engine's DUPLICATE_ORDER rule (queries the orders table),
 *   - the adapter (refuses to build a second order for a sealed decision),
 *   - the broker (refuses a repeated client_order_id outright).
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, rows, settle, orderIdOf, assert, roundEgp,
} from './helpers/harness.js';
import { decisionToRow } from '../src/agent/decision.js';

test('SCENARIO 6: submitting one decision twice yields exactly one order', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    h.advance();
    const d = h.buyDecision({ price: h.quote().mid });

    const first = await h.submit(d);
    assert.equal(first.outcome, 'EXECUTED', 'the first submission executes');
    const orderId = orderIdOf(first.order);
    const clientId = first.order.client_order_id;
    assert.ok(clientId, 'the order carries a client_order_id');

    // The identical decision, resubmitted. Same decision id, therefore the same
    // derived client_order_id.
    const second = await h.submit(d);
    assert.notEqual(second.outcome, 'EXECUTED', 'the resubmission must not execute');
    assert.equal(second.order, null, 'no second order object was produced');

    // Where it was caught depends on which layer saw it first; all three are
    // valid answers, and pinning one of them would be asserting an
    // implementation detail rather than the safety property.
    assert.ok(
      second.riskVerdict?.failedRule === 'DUPLICATE_ORDER' || second.reason?.includes('DUPLICATE'),
      `the duplicate was refused and named as such (outcome=${second.outcome} reason=${second.reason})`,
    );

    const all = rows(h, 'orders');
    assert.equal(all.length, 1, 'exactly one order row exists');
    assert.equal(all[0].order_id, orderId, 'and it is the original one');

    // Distinct client_order_ids across the whole table.
    const ids = h.repos.db.all('SELECT client_order_id FROM orders WHERE mode = ?', 'PAPER');
    assert.equal(new Set(ids.map((r) => r.client_order_id)).size, ids.length, 'no client_order_id repeats');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 6b: a duplicate is refused even after the first order has settled', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    h.advance();
    const d = h.buyDecision({ price: h.quote().mid });

    const first = await h.submit(d);
    settle(h, orderIdOf(first.order), { maxTicks: 20 });

    const filledQty = h.account.getPositions().reduce((a, p) => a + p.quantity, 0);
    assert.ok(filledQty > 0, 'the first order really filled');
    const cashAfter = h.account.cashEgp;

    // Replay the decision AFTER settlement. This is the dangerous shape of the
    // bug: a duplicate that is only detectable while an order is "working" is
    // not detected once it is filled, and quietly doubles the position.
    const replay = await h.submit(d);
    assert.notEqual(replay.outcome, 'EXECUTED', 'a replay after settlement is still refused');
    assert.equal(countRows(h, 'orders'), 1, 'still exactly one order');

    assert.equal(h.account.cashEgp, cashAfter, 'the replay moved no money');
    assert.equal(
      h.account.getPositions().reduce((a, p) => a + p.quantity, 0),
      filledQty,
      'the position was not doubled',
    );
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 6c: the client_order_id is derived from the decision, so it survives a restart', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    h.advance();
    const d = h.buyDecision({ price: h.quote().mid });

    // Recompute the id the way the adapter does, from the decision alone.
    const a = await h.submit(d);
    assert.equal(a.outcome, 'EXECUTED');
    const derived = a.order.client_order_id;

    // A second decision with the same id - as a resumed worker would rebuild -
    // derives the same client_order_id. That is the property that makes
    // restart-safety possible at all: there is no "new" random id to defeat the
    // UNIQUE constraint.
    const rebuilt = h.buyDecision({ price: h.quote().mid });
    const b = await h.submit({ ...rebuilt, decisionId: d.decisionId });
    assert.notEqual(b.outcome, 'EXECUTED', 'the rebuilt decision is refused as a duplicate');
    assert.equal(countRows(h, 'orders'), 1, 'still exactly one order');
    assert.equal(rows(h, 'orders')[0].client_order_id, derived, 'and it kept the original id');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 6d: the broker refuses a repeated client_order_id on its own', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const symbol = h.config.instruments[0].symbol;
    const d = h.buyDecision({ price: mid });
    h.repos.insertDecision(decisionToRow(d), h.clock);

    const base = {
      decisionId: d.decisionId,
      symbol, side: 'BUY', orderType: 'MARKET', quantity: 1,
      limitPrice: null, expectedPrice: mid, reduceOnly: false,
      leverageRequested: false, borrowRequested: false, marginRequested: false,
      shortRequested: false, instrumentType: 'SPOT', submittedTs: h.clock.now(),
    };

    const first = h.broker.placeOrder({ ...base, orderId: 'ord_A', clientOrderId: 'cid_A' });
    assert.equal(first.accepted, true, 'the first order is accepted');
    assert.equal(first.duplicate, false);

    const second = h.broker.placeOrder({ ...base, orderId: 'ord_B', clientOrderId: 'cid_A' });
    assert.equal(second.accepted, false, 'the repeat is refused');
    assert.equal(second.duplicate, true, 'and is reported as a duplicate, not an error');
    assert.equal(second.orderId, 'ord_A', 'the ORIGINAL order is returned, not the new one');

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});
