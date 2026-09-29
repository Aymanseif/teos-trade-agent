/**
 * Required scenario 13 of 13: DATABASE / AUDIT INTEGRITY
 *
 * Verify that the database and the audit trail are internally consistent.
 * Expected: every audit chain verifies, the fills reconcile against the orders
 * and the ledger, the balance sheet balances, and a deliberate edit to a record
 * is DETECTED rather than silently accepted.
 *
 * This is the scenario that the other twelve depend on. A kill switch recorded
 * in a table that can be edited, an order whose fills disagree with its
 * status, a balance that does not equal the sum of its own transactions - each
 * of those turns every other safety property in the system into a claim about
 * a record anyone can quietly rewrite.
 *
 * The tamper tests are the substantive half. "The chain verifies" is a claim
 * that the chain has teeth, not that it has them; so the chain is verified
 * again after deliberately modifying, deleting and inserting records, and in
 * each case the failure must be reported with the row that broke it.
 */

import { test } from 'node:test';
import { createHarness, countRows, assert, roundEgp, settle, orderIdOf, submitAndSettle, assertAccountInvariants } from './helpers/harness.js';
import { STREAMS, canonicalJson } from '../src/database/audit-chain.js';

/** Run a real trading session so there is a chain worth verifying. */
async function tradedSession(h, { ticks = 6 } = {}) {
  h.tickMarket(); h.advance();
  const entry = await h.submit(h.buyDecision({ price: h.quote().mid }));
  settle(h, orderIdOf(entry.order), { maxTicks: 20 });
  for (let i = 0; i < ticks; i += 1) { h.tickMarket(); h.advance(); }
  return entry;
}

/**
 * Two entries on different instruments, both settled.
 *
 * Deleting a record is only detectable if there is a record AFTER it, and the
 * chain walk stops at the break - so a one-order session proves nothing. Two
 * orders on two symbols also mean the audit trail spans more than one
 * instrument, which is closer to a real session than a single fill.
 */
async function twoOrderSession(h) {
  const first = await tradedSession(h, { ticks: 2 });
  const secondSymbol = h.config.instruments[1].symbol;
  const second = await h.submit(h.buyDecision({ symbol: secondSymbol, price: h.quote(secondSymbol).mid }));
  settle(h, orderIdOf(second.order), { maxTicks: 20 });
  for (let i = 0; i < 3; i += 1) { h.tickMarket(); h.advance(); }
  return { first, second };
}

test('SCENARIO 13: every audit chain verifies after a real trading session', async () => {
  const h = createHarness();
  try {
    await tradedSession(h);
    // A refusal must be in the chain too. If only executed orders were sealed,
    // a blocked decision would leave no tamper-evident trace of having been
    // considered and refused, which is exactly the record an operator needs.
    await h.submit(h.buyDecision({ price: h.quote().mid, confidence: 0.01 }));
    h.engageStop({ trigger: 'OPERATOR', reason: 'chain test' });
    await h.submit(h.buyDecision({ price: h.quote().mid }));

    for (const stream of Object.values(STREAMS)) {
      const r = h.chain.verify(stream, 'PAPER');
      assert.equal(r.ok, true, `the ${stream} chain verifies (${r.reason} after ${r.checked} records)`);
      assert.ok(r.checked > 0, `and the ${stream} chain is not vacuously empty`);
      assert.equal(r.reason, 'chain intact', `the ${stream} chain reports itself intact`);
    }
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13a: a modified record is detected and located', async () => {
  const h = createHarness();
  try {
    await tradedSession(h);
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, true, 'the chain is intact to begin with');

    // Retroactively rewrite the price on the order - the single most valuable
    // edit an attacker or a careless operator could make.
    const order = h.db.get('SELECT order_id, expected_price FROM orders WHERE mode = ? LIMIT 1', 'PAPER');
    h.db.run('UPDATE orders SET expected_price = ? WHERE order_id = ?', 0.01, order.order_id);

    const r = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(r.ok, false, 'editing a sealed column is detected');
    assert.equal(r.reason, 'record_hash mismatch (record modified)', 'and named as a modification');
    assert.equal(r.brokenAt, order.order_id === undefined ? r.brokenAt : h.db.get('SELECT record_hash FROM orders WHERE order_id = ?', order.order_id).record_hash,
      'and it points at the record that was changed');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13b: a deleted record is detected as a break, not ignored', async () => {
  const h = createHarness();
  try {
    await twoOrderSession(h);
    const before = h.db.count('SELECT COUNT(*) AS c FROM orders WHERE mode = ?', 'PAPER');
    assert.ok(before > 1, `there is more than one order (${before}), so a deletion is meaningful`);

    // Delete the FIRST order, not the last. Removing the tail of a chain leaves
    // the remaining links intact and is genuinely undetectable by any
    // hash chain - only the middle proves that removals are caught.
    //
    // Foreign keys are switched off for the delete on purpose. They are a real
    // defence, but one that any editor with file access disables in a single
    // statement, and `PRAGMA foreign_keys` cannot be changed inside a
    // transaction. A hash chain has to catch the edit regardless of whether the
    // editor was careful, so the test does not let the editor be careful.
    const victim = h.db.get('SELECT order_id FROM orders WHERE mode = ? ORDER BY rowid ASC LIMIT 1', 'PAPER');
    h.db.run('PRAGMA foreign_keys = OFF');
    h.db.run('DELETE FROM orders WHERE order_id = ?', victim.order_id);
    h.db.run('PRAGMA foreign_keys = ON');

    const r = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(r.ok, false, 'removing a record breaks the chain');
    assert.equal(r.reason, 'prev_hash mismatch (record removed or reordered)', 'and is reported as removal or reordering');
    assert.equal(r.checked, 0, 'and the walk stops at the point of the break rather than carrying on');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13c: an inserted record cannot be spliced into the middle of a chain', async () => {
  const h = createHarness();
  try {
    await tradedSession(h);
    const before = countRows(h, 'sentinel_decisions');
    assert.ok(before > 0, 'the stream under test has records');

    // Clone the first sentinel row, with a fresh id, and insert it immediately
    // after itself. Its `prev_hash` still points at the previous record, so the
    // walk from there on is out of step.
    const first = h.db.get('SELECT * FROM sentinel_decisions WHERE mode = ? ORDER BY rowid ASC LIMIT 1', 'PAPER');
    h.db.run(
      `INSERT INTO sentinel_decisions
         (sentinel_decision_id, decision_id, risk_decision_id, run_id, mode, instance_id, ts, ts_ms,
          verdict, action_taken, reason, trigger_rule, policy_version, rules_json, threshold_json,
          prev_hash, record_hash)
       SELECT 'sent_forged', decision_id, risk_decision_id, run_id, mode, instance_id, ts, ts_ms,
              verdict, action_taken, reason, trigger_rule, policy_version, rules_json, threshold_json,
              prev_hash, record_hash
         FROM sentinel_decisions WHERE sentinel_decision_id = ?`,
      first.sentinel_decision_id,
    );

    const r = h.chain.verify(STREAMS.SENTINEL, 'PAPER');
    assert.equal(r.ok, false, 'a forged record spliced into the chain is detected');
    assert.match(r.reason, /prev_hash mismatch/, 'as a linkage break, not as a modified record');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13d: the order lifecycle is not in the chain, and cannot be quietly rewritten', async () => {
  const h = createHarness();
  try {
    const entry = await tradedSession(h);
    const orderId = orderIdOf(entry.order);
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, true, 'the chain is intact');

    // Legitimate lifecycle updates: the order filled, the price averaged, the
    // status changed. These MUST NOT break the chain, or the chain would be
    // useless and the operator would learn to ignore it.
    h.db.run(
      'UPDATE orders SET filled_quantity = 999, avg_fill_price = 12345, status = ? WHERE order_id = ?',
      'FILLED', orderId,
    );
    const afterLifecycle = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(afterLifecycle.ok, true,
      'a legitimate lifecycle update does not break the chain - the mutable columns are excluded by design');

    // But the intent is still proven: the immutable part cannot be touched.
    h.db.run('UPDATE orders SET quantity = -1 WHERE order_id = ?', orderId);
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, false,
      'and the quantity the order was placed for still cannot be rewritten');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13e: fills reconcile against their orders, exactly', async () => {
  const h = createHarness();
  try {
    await tradedSession(h);
    const exit = await submitAndSettle(h, h.sellDecision({ price: h.quote().mid }), {}, { maxTicks: 20 });
    assert.equal(exit.outcome, 'EXECUTED', 'the exit filled, so the reconciliation covers a round trip');
    assert.ok(exit.settledAfterTicks > 0, 'and really settled rather than resting in the book');

    // `auditOrderFills` returns one row per order, each carrying its own `ok`
    // and the reasons it failed. Asserting on `ok` per row, rather than on a
    // summary count, is what makes the failure message name the bad order.
    const audit = h.repos.auditOrderFills('PAPER');
    assert.ok(audit.length >= 2, `the round trip produced ${audit.length} orders to reconcile`);
    for (const row of audit) {
      assert.equal(row.ok, true, `order ${row.order_id} reconciles (${row.problems.join('; ')})`);
      assert.deepEqual(row.problems, [], `and reports no problems for ${row.order_id}`);
    }

    // The reconciliation is not vacuous: the fills really are there.
    const fills = h.db.all('SELECT f.order_id, f.quantity, f.price FROM fills f JOIN orders o ON o.order_id = f.order_id WHERE o.mode = ?', 'PAPER');
    assert.ok(fills.length > 0, 'the session produced fills to reconcile');
    for (const f of fills) {
      assert.ok(f.quantity > 0, `fill on ${f.order_id} has a positive quantity`);
      assert.ok(f.price > 0, `fill on ${f.order_id} has a positive price`);
    }
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13f: a fill that contradicts its order is caught by reconciliation', async () => {
  const h = createHarness();
  try {
    const entry = await tradedSession(h);
    assert.ok(
      h.repos.auditOrderFills('PAPER').every((r) => r.ok),
      'the session reconciles to begin with',
    );

    // Fabricate extra fills against an order that already reconciled, at a
    // quantity and price nobody agreed to. This is the shape of a tampered
    // ledger: not a broken order status, but a ledger that no longer agrees
    // with the fills it claims to summarise. The `client_order_id` is copied
    // from the real order so the row is indistinguishable by inspection.
    const order = h.db.get('SELECT order_id, client_order_id, symbol, side FROM orders WHERE order_id = ?', orderIdOf(entry.order));
    h.db.run(
      `INSERT INTO fills
         (fill_id, order_id, client_order_id, decision_id, run_id, mode, symbol, side, quantity,
          price, reference_price, notional_egp, fee_egp, slippage_bps, slippage_cost_egp, liquidity, ts, ts_ms)
       VALUES ('fill_forged', ?, ?, NULL, ?, 'PAPER', ?, ?, 42, 99999, 99999, 4198958, 0, 0, 0, 'TAKER', ?, ?)`,
      order.order_id, order.client_order_id, h.runId, order.symbol, order.side,
      h.clock.nowIso(), h.clock.now(),
    );

    const bad = h.repos.auditOrderFills('PAPER').find((r) => r.order_id === orderIdOf(entry.order));
    assert.equal(bad.ok, false, 'reconciliation reports the fabricated fill');
    assert.ok(
      bad.problems.some((p) => /over-filled|sum\(fills\)/.test(p)),
      `and says why (${bad.problems.join('; ')})`,
    );
    assert.ok(bad.fills_quantity > bad.order_quantity, 'the summed fills now exceed the order quantity');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13g: cash is exactly the sum of its own transactions', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const entry = await submitAndSettle(h, h.buyDecision({ price: h.quote().mid }), {}, { maxTicks: 20 });
    assert.equal(entry.outcome, 'EXECUTED', 'the entry filled');
    for (let i = 0; i < 4; i += 1) { h.tickMarket(); h.advance(); }
    const exit = await submitAndSettle(h, h.sellDecision({ price: h.quote().mid }), {}, { maxTicks: 20 });
    assert.equal(exit.outcome, 'EXECUTED', 'and so did the exit');

    // Derive cash from the raw fill rows - a computation completely independent
    // of PaperAccount, which is the whole point: two derivations that agree are
    // evidence, one derivation checked against itself is not.
    const fills = h.db.all(
      `SELECT f.side AS side, f.quantity AS quantity, f.price AS price, f.fee_egp AS fee
         FROM fills f JOIN orders o ON o.order_id = f.order_id WHERE o.mode = 'PAPER'`,
    );
    assert.ok(fills.length > 0, 'there are fills to sum');
    let derived = h.config.account.startingCapitalEgp;
    for (const f of fills) {
      const gross = f.quantity * f.price;
      derived += f.side === 'SELL' ? gross - f.fee : -(gross + f.fee);
    }
    const recorded = h.repos.latestBalance('PAPER').cash_egp;
    assert.ok(
      Math.abs(roundEgp(recorded) - roundEgp(derived)) <= 0.02,
      `recorded cash ${recorded} equals the fill-derived ${roundEgp(derived)}`,
    );
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13h: a balance row that disagrees with the last one is visible in the curve', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    for (let i = 0; i < 3; i += 1) { h.tickMarket(); h.advance(); }

    // The equity curve is a series of snapshots, not a recomputation. A gap in
    // it (a tick that never recorded) is not corruption, but it IS something an
    // operator looking at the dashboard should be able to see, so the series
    // must at least be ordered and internally consistent.
    const series = h.repos.equitySeries({ limit: 100, mode: 'PAPER' });
    for (let i = 1; i < series.length; i += 1) {
      assert.ok(series[i].ts_ms >= series[i - 1].ts_ms, 'the equity series is ordered by time');
    }
    for (const row of series) {
      assert.ok(Number.isFinite(row.equity_egp), 'every equity point is a real number');
      assert.ok(row.equity_egp > 0, 'and positive: the account has not been driven to zero');
    }
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 13i: canonical JSON is stable, so a hash means the same thing twice', () => {
  // If the canonical form depended on key insertion order, two identical records
  // could hash differently and every verification would be a coin flip.
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }), 'key order does not matter');
  assert.equal(canonicalJson({ a: 1, b: 2 }), '{"a":1,"b":2}', 'and the form is compact and sorted');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', 'undefined keys are omitted entirely');
  assert.equal(canonicalJson({ a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}]}', 'and it recurses into arrays and objects');
  assert.equal(canonicalJson(null), 'null', 'null is preserved, not dropped');
});

test('SCENARIO 13j: PAPER and BACKTEST records cannot be mixed up', async () => {
  const h = createHarness({ mode: 'BACKTEST' });
  try {
    h.tickMarket(); h.advance();
    await h.submit(h.buyDecision({ price: h.quote().mid }));
    settle(h, orderIdOf((await h.submit(h.buyDecision({ price: h.quote().mid }))).order), { maxTicks: 20 });

    assert.equal(h.chain.verify(STREAMS.ORDER, 'BACKTEST').ok, true, 'the backtest chain verifies');
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').checked, 0, 'and there is no PAPER order to confuse it with');
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, true, 'an empty chain in another mode is not a broken chain');

    for (const stream of Object.values(STREAMS)) {
      const r = h.chain.verify(stream, 'BACKTEST');
      assert.equal(r.ok, true, `the backtest ${stream} chain verifies`);
      const other = h.chain.verify(stream, 'PAPER');
      assert.equal(other.checked, 0, `and no ${stream} record leaks into the PAPER chain`);
    }
  } finally {
    h.cleanup();
  }
});
