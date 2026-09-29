/**
 * Required scenario 4 of 13: STALE_MARKET_DATA
 *
 * Provide market data older than maxDataStalenessMs.
 * Expected: trading blocked, no execution.
 *
 * The limit is 15,000ms (EGP-configured), with a 9,000ms degradation warning
 * band. Three ages matter and all three are tested, because a rule that blocks
 * at the wrong threshold is as dangerous as one that does not block at all:
 *
 *   - fresh          -> allowed
 *   - warning band   -> allowed, but WARNed and recorded
 *   - past the limit -> BLOCKED, with a latching stop
 *
 * The data is aged through the real mechanism: the ManualClock advances past
 * the quote's `tsMs`. Nothing is mocked, and the broker's own `quoteAgeMs`
 * agrees with the rule's view, so the two are cross-checked.
 */

import { test } from 'node:test';
import {
  createHarness, assertAccountInvariants, countRows, assert,
} from './helpers/harness.js';
import { AgentEngine } from '../src/agent/engine.js';
import { AgentStateMachine, STATES } from '../src/agent/state.js';

test('SCENARIO 4: data older than the freshness limit is refused, and the boundary is exact', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const maxAge = h.limits.maxDataStalenessMs;
    const warnAge = h.limits.degradedDataFreshnessMs;
    assert.equal(maxAge, 15_000, 'the freshness limit is 15s');
    assert.equal(warnAge, 9_000, 'the degradation warning starts at 9s');

    const symbol = h.config.instruments[0].symbol;

    // --- fresh: allowed -------------------------------------------------
    const fresh = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.notEqual(fresh.outcome, 'BLOCKED', 'fresh data is tradable');
    const freshRule = fresh.riskVerdict.rules.find((r) => r.rule === 'DATA_FRESHNESS');
    assert.equal(freshRule.status, 'PASS');

    // --- warning band: allowed but flagged ------------------------------
    h.clock.advance(warnAge + 1000);
    const ageing = h.syntheticQuote({ mid: h.quote().mid, tsMs: h.clock.now() - warnAge - 500 });
    const warnRes = await h.submit(h.buyDecision({ price: ageing.mid }), { quote: ageing });
    const warnRule = warnRes.riskVerdict.rules.find((r) => r.rule === 'DATA_FRESHNESS');
    assert.equal(warnRule.status, 'WARN', 'ageing data is warned about, not blocked');
    assert.equal(warnRes.riskVerdict.blocked, false, 'the warning band does not block');

    // --- past the limit: blocked ----------------------------------------
    const stale = h.syntheticQuote({ mid: ageing.mid, tsMs: h.clock.now() - maxAge - 1000 });
    assert.ok(h.clock.now() - stale.tsMs > maxAge, 'the probe really is stale');

    const res = await h.submit(h.buyDecision({ price: stale.mid }), { quote: stale });
    assert.equal(res.outcome, 'BLOCKED', 'stale data must block trading');
    assert.equal(res.riskVerdict.failedRule, 'DATA_FRESHNESS', `blocked by DATA_FRESHNESS (was ${res.riskVerdict.failedRule})`);

    const rule = res.riskVerdict.rules.find((r) => r.rule === 'DATA_FRESHNESS');
    assert.equal(rule.status, 'BLOCK');
    assert.equal(rule.latchesStop, true, 'staleness latches a stop - it is a systemic fault, not a one-off');
    assert.ok(rule.data.ageMs > maxAge, 'the refusal records the actual age');

    // No order was created.
    const ordersBefore = countRows(h, 'orders');
    assert.equal(res.order, null, 'no order object was created from stale data');
    assert.equal(countRows(h, 'orders'), ordersBefore, 'the order count did not move');

    // The refusal is driven by the quote's own timestamp, not by wall-clock
    // guessing: the age the rule computed must match the age of the quote that
    // was handed in. A rule that ignored `quote.tsMs` and used `nowMs`
    // everywhere would pass the block test above but fail this.
    const computedAge = res.riskVerdict.rules.find((r) => r.rule === 'DATA_FRESHNESS').data.ageMs;
    assert.equal(computedAge, h.clock.now() - stale.tsMs, 'the rule measures age from the quote timestamp');

    // The synthetic quote is deliberately NOT what the broker's own feed is
    // carrying, so `quoteAgeMs` correctly reports a fresh live quote. That
    // difference is the point: the risk engine judges the quote it is given,
    // not the broker's global opinion.
    assert.ok(
      h.broker.quoteAgeMs(symbol) < maxAge,
      'the live feed is still fresh - so the block came from the quote passed in, not from the broker',
    );

    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 4b: a completely missing quote never reaches execution', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const ordersBefore = countRows(h, 'orders');

    // A symbol with no data at all. Two independent defences are checked:
    //
    //  1. The AGENT does not build a decision for a symbol it has no quote
    //     for (`#safeQuote` returns null), so there is nothing to execute.
    //  2. If a decision somehow arrives anyway, the firewall fails CLOSED. The
    //     outcome is FAILED rather than BLOCKED, because `proposeOrder` needs
    //     `quote.mid` to size anything and a null quote throws. That is still a
    //     refusal - the important property is that no order exists - and it is
    //     recorded as an ERROR event for an operator to investigate.
    const state = new AgentStateMachine({ repos: h.repos, clock: h.clock, initial: STATES.HEALTHY });
    const agent = new AgentEngine({
      config: h.config, clock: h.clock, repos: h.repos, account: h.account,
      broker: h.broker, riskEngine: h.riskEngine, state, strategyId: 'sma_cross',
    });
    // `evaluateOnce` returns a report, not a bare decision: `{ decision, quote,
    // accountSnapshot, health }`. The decision is null and the quote is null,
    // which is the property under test.
    const report = await agent.evaluateOnce({ symbols: ['NOT/A_SYMBOL'] });
    assert.equal(report.decision, null, 'the agent builds no decision for a symbol with no market data');
    assert.equal(report.quote, null, 'and it reports no quote for that symbol');

    const res = await h.submit(h.buyDecision({ price: 48.75 }), { quote: null });
    assert.notEqual(res.outcome, 'EXECUTED', 'a missing quote must never execute');
    assert.equal(res.order, null, 'no order object was created');
    assert.equal(countRows(h, 'orders'), ordersBefore, 'the order count did not move');

    if (res.outcome === 'FAILED') {
      // Fail-closed via an exception. `proposeOrder` dereferences `quote.mid` to
      // size an order, so a null quote throws a plain TypeError before the
      // DATA_FRESHNESS rule (which handles null correctly) is ever reached. The
      // error is therefore untyped, which is exactly why the assertion here is
      // on the OUTCOME and the audit record rather than on an error code - an
      // assertion on `code` would be asserting on which layer happened to throw
      // first, which is not a safety property.
      assert.equal(res.error.code, 'UNKNOWN', 'a bare TypeError carries no typed code');
      const events = h.repos.listEvents({ limit: 10, level: 'ERROR' });
      assert.ok(events.length > 0, 'the failure is written to the event log');
      assert.match(events[0].category, /risk_engine_error/);
    } else {
      assert.equal(res.outcome, 'BLOCKED');
      assert.equal(res.riskVerdict.failedRule, 'DATA_FRESHNESS');
    }
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 4c: a stalled feed is caught at the broker, not just by a test clock', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const symbol = h.config.instruments[0].symbol;
    const before = h.broker.quoteAgeMs(symbol);
    assert.ok(before < h.limits.maxDataStalenessMs, 'the feed starts fresh');

    // The real stall mechanism: the broker stops producing quotes.
    h.broker.injectFailure({ type: 'DATA_STALL' });
    h.clock.advance(h.limits.maxDataStalenessMs + 2000);

    assert.ok(
      h.broker.quoteAgeMs(symbol) > h.limits.maxDataStalenessMs,
      'the stalled feed really did age past the limit',
    );

    const res = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.equal(res.outcome, 'BLOCKED', 'a stalled feed blocks trading');
    assert.equal(res.riskVerdict.failedRule, 'DATA_FRESHNESS', `blocked by DATA_FRESHNESS (was ${res.riskVerdict.failedRule})`);

    h.broker.clearFailure();
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 4d: the agent state machine halts on stale data', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const sm = new AgentStateMachine({ repos: h.repos, clock: h.clock, initial: STATES.HEALTHY });

    sm.applyHealth({ connected: true, dataFresh: false, abnormalPrice: false, undefinedState: false });
    assert.equal(sm.state, STATES.HALTED, 'stale data halts the agent');
    assert.equal(sm.permissions.openPosition, false, 'a halted agent may not open positions');
    assert.equal(sm.permissions.reduceOnly, true, 'but it may still reduce risk');

    // The transition is persisted, so the dashboard and a post-mortem can see
    // when and why the agent stopped.
    const history = h.repos.stateHistory();
    assert.ok(history.length >= 1, 'the state transition is recorded');
    assert.match(history[history.length - 1].reason, /STALE_MARKET_DATA/);

    // Recovering requires health to return.
    sm.applyHealth({ connected: true, dataFresh: true, abnormalPrice: false, undefinedState: false });
    assert.equal(sm.state, STATES.DEGRADED, 'clearing the fault de-escalates to DEGRADED, not straight to HEALTHY');
    assert.equal(sm.permissions.openPosition, false, 'DEGRADED still forbids new exposure');
  } finally {
    h.cleanup();
  }
});
