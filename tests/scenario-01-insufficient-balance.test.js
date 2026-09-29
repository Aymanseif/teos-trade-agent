/**
 * Required scenario 1 of 13: INSUFFICIENT_BALANCE
 *
 * Attempt an order whose required cash exceeds available cash.
 * Expected: order rejected, cash never becomes negative, no broker execution.
 *
 * Two layers are tested, because a single layer is not a safety property:
 *
 *   (a) END TO END - the real pipeline is pushed past the available cash. The
 *       risk engine must refuse it, and no order may reach the broker.
 *   (b) AT THE BROKER - a hand-built order that bypasses the risk engine
 *       entirely, to prove the LAST line of defence also holds. An order this
 *       gross (EGP ~48,750 against an EGP 500 account) can never be funded.
 *
 * On (b): the order is ACCEPTED into the book and then CANCELED unfilled. That
 * is the correct behaviour for a matching engine, and the test asserts it
 * precisely rather than demanding a rejection at submission:
 *
 *   - the paper exchange rests orders and cancels them when they become
 *     unfillable, exactly as a real venue does, and
 *   - what matters is that cash is never debited beyond the balance, no
 *     unfundable position is ever opened, and the cancellation reason says
 *     `INSUFFICIENT_CASH_TO_FILL` rather than something misleading.
 *
 * An earlier draft of this test asserted an outright rejection, and asserted a
 * rejection reason matching /BALANCE|INSUFFICIENT|CASH/. It passed only because
 * the broker had no cash check at all and the failure surfaced late as
 * `SETTLEMENT_FAILED:DATABASE_ERROR` - a lie about the cause. That gap is fixed
 * in the broker's fill guard; this test now pins the corrected behaviour.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, settle, orderIdOf, assert, roundEgp,
} from './helpers/harness.js';
import { decisionToRow } from '../src/agent/decision.js';
import { RULES, RULE_IDS } from '../src/risk/rules/index.js';
import { Ledger } from '../src/paper/ledger.js';
import { InsufficientBalanceError } from '../src/core/errors.js';

test('SCENARIO 1: the pipeline cannot spend money the account does not have', async () => {
  const h = createHarness();
  try {
    h.tickMarket();

    // A healthy, affordable order first, so the account is genuinely engaged and
    // the later refusals cannot be mistaken for "nothing was tradable anyway".
    const first = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.equal(first.outcome, 'EXECUTED', 'the affordable order executes');
    settle(h, orderIdOf(first.order), { maxTicks: 10 });

    const cashAfterFirst = h.account.cashEgp;
    assert.ok(cashAfterFirst < 500, `cash should have been spent (was ${roundEgp(cashAfterFirst)})`);
    assert.ok(cashAfterFirst > 0, 'some cash remains to be over-spent');

    // Now ask, five times, for a position far larger than the account can fund,
    // with a risk budget large enough that nothing upstream re-sizes the request
    // away. Whatever the pipeline decides - refuse, or re-size down to what is
    // affordable - the observable guarantee is the same, and it is what is
    // asserted: money never leaves the account twice.
    //
    // An earlier draft asserted `sentinelVerdict === null` here, i.e. that the
    // second order was BLOCKED. It is not, and cannot be: `proposeOrder` sizes an
    // order down to what cash and the exposure cap allow, so a proposal cash
    // cannot fund is never produced. Asserting the refusal instead of the
    // guarantee would have made this a test of the sizer. The guarantee itself
    // is scenario 1a's subject, and the rule ordering that puts it out of reach
    // end to end is documented in 1a-bis.
    const symbol2 = h.config.instruments[1].symbol;
    for (let i = 0; i < 5; i += 1) {
      const res = await h.submit(h.buyDecision({
        symbol: symbol2,
        price: h.quote(symbol2).mid,
        riskPctPerTrade: 99,
        riskBudgetEgp: 10_000,
        quantity: 1_000_000,
        notionalEgp: 10_000_000,
      }));
      if (res.outcome === 'EXECUTED') settle(h, orderIdOf(res.order), { maxTicks: 10 });

      assert.ok(h.account.cashEgp >= 0, `cash is still not negative after attempt ${i + 1}`);
      assert.ok(h.account.equityEgp >= 0, `equity is still not negative after attempt ${i + 1}`);
      assertAccountInvariants(h.account);
    }

    // The decisive check, derived independently of the ledger: the net cost of
    // every fill in the database can never exceed the starting capital.
    const fills = h.db.all(
      `SELECT f.side AS side, f.quantity AS quantity, f.price AS price, f.fee_egp AS fee
         FROM fills f JOIN orders o ON o.order_id = f.order_id WHERE o.mode = 'PAPER'`,
    );
    let spent = 0;
    for (const f of fills) {
      const gross = f.quantity * f.price;
      spent += f.side === 'SELL' ? -(gross - f.fee) : gross + f.fee;
    }
    assert.ok(fills.length > 0, 'the run really did trade, so this is not a tautology');
    assert.ok(
      spent <= h.config.account.startingCapitalEgp + 0.02,
      `net spend of EGP ${roundEgp(spent)} never exceeded the EGP ${h.config.account.startingCapitalEgp} starting capital`,
    );
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 1a: SUFFICIENT_BALANCE refuses any order costing more than cash is held', () => {
  const h = createHarness();
  try {
    const rule = RULES.find((r) => r.id === 'SUFFICIENT_BALANCE');
    assert.ok(rule, 'the SUFFICIENT_BALANCE rule exists');

    const cash = h.account.cashEgp;
    const base = {
      account: h.account,
      limits: h.limits,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      killSwitch: { engaged: false },
      quote: h.syntheticQuote({ mid: 48.75 }),
      nowMs: h.clock.now(),
      orderCounts: { day: 0, bySymbol: {} },
      dateKey: h.clock.dateKey(),
      instrument: h.config.instruments[0],
      feeBps: h.config.fees.takerBps,
    };
    const proposalFor = (notional) => ({
      side: 'BUY', quantity: notional / 48.75, notionalEgp: roundEgp(notional),
      price: 48.75, expectedExecutionPrice: 48.75, stopPrice: 48.75 * 0.985,
      riskAtStopEgp: 1, stopDistancePct: 1.5, riskRewardRatio: 1,
      leverageRequested: false, borrowRequested: false, derivative: false,
    });

    // Affordable: allowed.
    const ok = rule.evaluate({ ...base, decision: proposalFor(cash - 1) });
    assert.equal(ok.status, 'PASS', 'an affordable order passes the rule');

    // One piastre beyond cash: refused, with the shortfall recorded.
    const over = roundEgp(cash + 0.01);
    const bad = rule.evaluate({ ...base, decision: proposalFor(over) });
    assert.equal(bad.status, 'BLOCK', 'an order beyond the cash balance is blocked');
    assert.equal(bad.severity, 'CRITICAL');
    assert.ok(
      bad.data.requiredEgp > bad.data.availableEgp,
      `the refusal records what was needed and what was held (got ${JSON.stringify(bad.data)})`,
    );
    assert.ok(
      bad.data.requiredEgp > bad.data.notionalEgp,
      'the requirement includes the fee, not just the notional',
    );

    // A shortfall is a refusal, NOT borrowing.
    assert.equal(bad.latchesStop, false, 'a single unaffordable order is not a systemic fault');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 1a-bis: the exposure cap is tighter than starting cash, so cash is never the first blocker', () => {
  // Documents WHY scenario 1a has to test the rule in isolation. In this
  // account, cash (EGP 500) and the exposure cap (EGP 250) are linked: buying
  // reduces cash and raises exposure by the same amount. So whenever an order
  // costs more than the cash left, it also pushes exposure past the cap, and
  // EXPOSURE - evaluated earlier - refuses first. SUFFICIENT_BALANCE remains a
  // real backstop, but in this configuration it is unreachable as the *first*
  // line, and a test that asserted otherwise would be asserting a fiction.
  const h = createHarness();
  try {
    assert.ok(
      h.limits.maxPortfolioExposureEgp < h.config.account.startingCapitalEgp,
      'exposure cap is below starting cash',
    );
    assert.ok(
      RULE_IDS.indexOf('EXPOSURE') < RULE_IDS.indexOf('SUFFICIENT_BALANCE'),
      'and EXPOSURE is evaluated earlier, so it is the rule that fires first',
    );
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 1b: an order the broker cannot fund never debits cash or opens a position', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const cash = h.account.cashEgp;
    const mid = h.quote().mid;
    const symbol = h.config.instruments[0].symbol;

    // Bypass the risk engine entirely. ~EGP 48,750 against an EGP 500 account.
    const grossQty = 1000;
    const d = h.buyDecision({ price: mid, quantity: grossQty, notionalEgp: grossQty * mid });
    h.repos.insertDecision(decisionToRow(d), h.clock);
    h.repos.insertOrder({
      orderId: 'ord_byhand', clientOrderId: 'cid_byhand', decisionId: d.decisionId,
      riskDecisionId: null, sentinelDecisionId: null,
      symbol, side: 'BUY', orderType: 'MARKET', quantity: grossQty,
      limitPrice: null, expectedPrice: mid,
      status: 'PENDING_NEW', reduceOnly: false, rejectionReason: null,
    }, h.clock);

    const ack = h.broker.placeOrder({
      orderId: 'ord_byhand', clientOrderId: 'cid_byhand', decisionId: d.decisionId,
      symbol, side: 'BUY', orderType: 'MARKET', quantity: grossQty,
      limitPrice: null, expectedPrice: mid, reduceOnly: false,
      leverageRequested: false, borrowRequested: false, marginRequested: false,
      shortRequested: false, instrumentType: 'SPOT', submittedTs: h.clock.now(),
    });

    // Accepted into the book, exactly as a real venue rests an order. What is
    // NOT acceptable is it ever becoming funded.
    assert.equal(ack.accepted, true, 'the order rests; unfundability is discovered at fill time');
    h.repos.updateOrderStatus('ord_byhand', { status: 'NEW', terminal: false, clock: h.clock });

    let lastStatus = null;
    for (let i = 0; i < 6; i += 1) {
      h.tickMarket();
      const row = h.repos.getOrder('ord_byhand');
      lastStatus = row?.status;
      assert.ok(h.account.cashEgp >= 0, `cash went negative on tick ${i}: ${h.account.cashEgp}`);
      if (lastStatus === 'CANCELED' || lastStatus === 'FILLED') break;
    }

    const row = h.repos.getOrder('ord_byhand');
    assert.equal(row.status, 'CANCELED', 'the unfundable order is canceled, not filled');
    assert.equal(
      row.rejection_reason,
      'INSUFFICIENT_CASH_TO_FILL',
      `the reason must name the real cause, not a database error (got ${row.rejection_reason})`,
    );

    // Whatever it did manage to fill, it never over-spent.
    assert.ok(h.account.cashEgp >= 0, 'cash is still not negative');
    assert.equal(
      h.broker.health().consecutiveFailures,
      0,
      'an unfundable order must not be counted as an exchange failure',
    );

    // Any fill recorded is consistent with the position it created.
    const fills = h.repos.db.all('SELECT quantity, price FROM fills WHERE order_id = ?', 'ord_byhand');
    const filledQty = fills.reduce((a, f) => a + f.quantity, 0);
    const posQty = h.account.getPositions().reduce((a, p) => a + p.quantity, 0);
    assert.ok(filledQty <= 1000, 'filled quantity never exceeds the order');
    assert.equal(
      Math.round(posQty * 1e6) / 1e6,
      Math.round(filledQty * 1e6) / 1e6,
      'the open position exactly equals what was filled',
    );

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 1c: the ledger itself refuses to go negative, whatever it is asked to do', () => {
  const h = createHarness();
  try {
    const ledger = new Ledger(500);

    assert.equal(ledger.cashEgp, 500);
    assert.throws(() => ledger.debit(501), InsufficientBalanceError, 'a debit beyond cash is refused');
    assert.equal(ledger.cashEgp, 500, 'the refused debit left cash untouched');

    // Spending exactly the whole balance is allowed; one piastre more is not.
    ledger.debit(500);
    assert.equal(ledger.cashEgp, 0, 'spending the exact balance is legal');
    assert.throws(() => ledger.debit(0.01), InsufficientBalanceError, 'there is no borrowing');
  } finally {
    h.cleanup();
  }
});
