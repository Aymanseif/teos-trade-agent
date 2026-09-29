/**
 * Required scenario 8 of 13: EMERGENCY_STOP
 *
 * Trigger the emergency stop.
 * Expected: all trading stops immediately, the stop persists, it survives a
 * restart, and only an explicit operator action can clear it.
 *
 * The property that matters is not "trading stopped" but "trading stopped and
 * cannot come back on its own". A kill switch that clears itself when the
 * condition that raised it goes away is not a kill switch, it is a retry loop.
 * So 8b deliberately clears every plausible cause and re-runs the pipeline, and
 * asserts the refusal is unchanged until someone acts.
 *
 * Two independent gates are exercised, because either alone can be bypassed:
 * the risk engine's KILL_SWITCH rule and the Sentinel's KILL_SWITCH rule. A kill
 * switch implemented in only one layer is one refactor away from being
 * decorative.
 */

import { test } from 'node:test';
import { join } from 'node:path';
import {
  createHarness, assertAccountInvariants, countRows, settle, orderIdOf, assert, REPO_ROOT,
} from './helpers/harness.js';
import { Repos } from '../src/database/repositories/index.js';
import { AuditChain } from '../src/database/audit-chain.js';
import { decisionToRow } from '../src/agent/decision.js';
import { SENTINEL_RULES } from '../src/execution/sentinel.js';
import { loadConfig } from '../src/core/config.js';

test('SCENARIO 8: the emergency stop blocks every order, including a risk-reducing exit', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    // Open a position first, so the "even an exit is refused" claim has teeth.
    const entry = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.equal(entry.outcome, 'EXECUTED', 'the entry filled');
    settle(h, orderIdOf(entry.order), { maxTicks: 20 });
    assert.ok(h.account.getPositions()[0]?.quantity > 0, 'there is a position to protect');

    h.engageStop({ trigger: 'OPERATOR', reason: 'manual test stop' });

    const buy = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.equal(buy.outcome, 'BLOCKED', 'a new position is refused while stopped');
    assert.equal(buy.riskVerdict.failedRule, 'KILL_SWITCH', `refused by KILL_SWITCH (was ${buy.riskVerdict.failedRule})`);

    // SELL: also refused, and refused by the KILL_SWITCH rule specifically. The
    // other limits are all sized to permit an exit, so if the refusal came from
    // one of them this assertion would fail - which is the point.
    const sell = await h.submit(h.sellDecision({ price: h.quote().mid }));
    assert.equal(sell.outcome, 'BLOCKED', 'a risk-REDUCING exit is refused too, by design');
    assert.equal(
      sell.riskVerdict.failedRule, 'KILL_SWITCH',
      `and it is the kill switch that refuses it, not some incidental rule (was ${sell.riskVerdict.failedRule})`,
    );

    assert.equal(countRows(h, 'orders'), 1, 'no order was created after the stop');
    assertAccountInvariants(h.account);
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 8b: the stop refuses orders until it is explicitly cleared, never on its own', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    h.engageStop({ trigger: 'OPERATOR', reason: 'transient condition' });
    const stop = h.repos.sessionStop();
    assert.ok(stop, 'the stop engaged');
    assert.equal((await h.submit(h.buyDecision({ price: h.quote().mid }))).outcome, 'BLOCKED');

    // Clear everything else that could plausibly explain the block: a fresh
    // tick of real market data, a healthy connection, no manual hold. If any of
    // that revives trading on its own, the switch is not a switch.
    h.broker.clearFailure();
    h.broker.connect();
    h.repos.setFlag('MANUAL_HOLD', 'false', h.clock, 'test', 'not a hold', 'PAPER');
    h.tickMarket(); h.advance();

    assert.equal((await h.submit(h.buyDecision({ price: h.quote().mid }))).outcome, 'BLOCKED',
      'a healthy feed does not clear the stop by itself');

    h.clearStop(stop.stop_id, 'operator:local');
    assert.equal(h.repos.sessionStop(), null, 'the stop is genuinely gone from the table');
    const after = await h.submit(h.buyDecision({ price: h.quote().mid }));
    assert.equal(after.outcome, 'EXECUTED', 'trading resumes only after an EXPLICIT clear');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 8c: the stop is durable - a fresh repository over the same file still sees it', async () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    h.engageStop({ trigger: 'DAILY_LOSS', reason: 'latched by the daily loss limit' });

    // "Durable" means it lives in the database, not in worker memory. Reading
    // it back through a brand-new Repos on the same file is the only honest
    // test of that: a restarted process would see exactly this. Asserting on
    // `h.repos` would only prove the in-memory repository still remembers what
    // it just wrote.
    const db2 = h.trackDb(h.db);
    const repos2 = new Repos(db2, new AuditChain(db2), { mode: 'PAPER', instanceId: 'inst_fresh' });
    repos2.setRun(h.runId, 'inst_fresh');

    const stop = repos2.sessionStop();
    assert.ok(stop, 'a fresh repository over the same file still sees the stop');
    assert.equal(stop.trigger, 'DAILY_LOSS', 'with the original trigger');
    assert.equal(stop.active, 1, 'and it is marked active');
    assert.ok(stop.reason.length > 0, 'and the reason an operator needs is preserved');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 8d: the Sentinel blocks on the kill switch independently of the risk engine', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    const decision = h.buyDecision({ price: h.quote().mid });
    // The Sentinel persists its verdict with a foreign key to the decision, so
    // the decision must exist first. Production never hits this because the
    // firewall has already inserted it by the time the Sentinel runs.
    h.repos.insertDecision(decisionToRow(decision), h.clock);
    const proposal = h.riskEngine.proposeOrder({
      decision, account: h.account, quote: h.quote(), instrument: h.instrument,
    });
    // A deliberately clean verdict. The only thing wrong is the kill switch, so
    // the Sentinel has to be the layer that catches it - otherwise this test
    // would be measuring the risk engine again.
    const clean = { blocked: false, failedRule: null, passedCount: 0, failedCount: 0, rules: [] };

    const before = h.sentinel.evaluate({
      decision, proposal, riskVerdict: clean, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 }, killSwitch: { engaged: false },
      quote: h.quote(), mode: 'PAPER',
    });
    assert.equal(before.verdict, 'ALLOW', 'the Sentinel allows the same order before the stop');

    h.engageStop({ trigger: 'OPERATOR', reason: 'test' });
    const after = h.sentinel.evaluate({
      decision, proposal, riskVerdict: clean, account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 }, killSwitch: h.killSwitch(),
      quote: h.quote(), mode: 'PAPER',
    });
    assert.equal(after.verdict, 'BLOCK', 'and blocks it once the stop is engaged');
    assert.equal(
      after.rules.find((r) => r.rule === 'KILL_SWITCH').verdict, 'BLOCK',
      'and the KILL_SWITCH rule is the one that fired',
    );
    assert.ok(after.sentinelDecisionId, 'the block is persisted as a Sentinel decision, not merely returned');
    // Counted from the raw table rather than via a getter, so "persisted" means
    // present in SQLite and not merely present in the returned object.
    assert.equal(
      h.db.get('SELECT verdict FROM sentinel_decisions WHERE sentinel_decision_id = ?', after.sentinelDecisionId)?.verdict,
      'BLOCK',
      'and that decision really is a BLOCK row in the database',
    );
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 8e: a cleared stop stays on the record, with who cleared it', () => {
  const h = createHarness();
  try {
    h.tickMarket(); h.advance();
    // `engageStop` returns the id it minted, not a row.
    const stopId = h.engageStop({ trigger: 'OPERATOR', reason: 'needs clearing' });
    assert.ok(h.repos.sessionStop(), 'the stop exists');

    const remaining = h.clearStop(stopId, 'operator:local');
    assert.equal(remaining, 0, 'no stop is left active');
    assert.equal(h.repos.sessionStop(), null, 'and it stops gating trading');

    // The row must survive. A stop that vanished from the database on clear
    // would erase the only record that trading was ever halted.
    const row = h.repos.listStops().find((r) => r.stop_id === stopId);
    assert.ok(row, 'the stop is still in the record after being cleared');
    assert.equal(row.active, 0, 'marked no longer active');
    assert.ok(row.cleared_at != null, 'with a clearance timestamp');
    assert.equal(row.cleared_by, 'operator:local', 'naming who cleared it');
    assert.equal(row.reason, 'needs clearing', 'and keeping the original reason');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 8f: LIVE is refused three times over - by the Sentinel, by the schema, and by config', () => {
  const h = createHarness();
  try {
    const decision = h.buyDecision({ price: 1 });
    h.repos.insertDecision(decisionToRow(decision), h.clock);
    const ctx = {
      decision,
      proposal: { side: 'BUY', notionalEgp: 10, reduceOnly: false, stopPrice: null, quantity: 1 },
      riskVerdict: { blocked: false, failedRule: null, rules: [] },
      account: h.account, accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: { engaged: false },
      quote: h.syntheticQuote({ mid: 1 }),
      mode: 'LIVE',
    };

    // 1. The Sentinel blocks. Asserting the POSITION of MODE_GUARD, not just
    //    its presence: a reordering that put a laxer rule first would let a live
    //    order be evaluated on its merits at all.
    // `SENTINEL_RULES` is the exported ordered list the Sentinel iterates.
    assert.equal(SENTINEL_RULES[0].id, 'MODE_GUARD', 'MODE_GUARD is the first rule in the order');
    assert.equal(
      SENTINEL_RULES[0].evaluate({ mode: 'LIVE' }).verdict, 'BLOCK',
      'and it blocks LIVE when evaluated at position zero',
    );

    // 2. The verdict cannot even be RECORDED as live. Every mode column is
    //    CHECK-constrained to ('BACKTEST','PAPER'), so a LIVE audit record is
    //    not representable in the schema. Proved by attempting the insert
    //    directly, because the Sentinel itself never gets that far - it stops at
    //    rule 1 and returns BLOCK, and the record it writes is a PAPER one.
    assert.throws(
      () => h.db.run(
        `INSERT INTO sentinel_decisions
           (sentinel_decision_id, decision_id, risk_decision_id, run_id, mode, instance_id, ts, ts_ms,
            verdict, action_taken, reason, trigger_rule, policy_version, rules_json, threshold_json,
            prev_hash, record_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        'sent_live', decision.decisionId, null, h.runId, 'LIVE', h.instanceId,
        h.clock.nowIso(), h.clock.now(), 'BLOCK', 'REJECT', 'live', 'MODE_GUARD', 'v1', '[]', '{}', null, 'h',
      ),
      (err) => /CHECK constraint failed/.test(err.message),
      'a LIVE sentinel_decision row is not representable: the schema forbids it',
    );

    const result = h.sentinel.evaluate(ctx);
    assert.equal(result.verdict, 'BLOCK', 'and the Sentinel blocks before it would ever try');
    assert.equal(
      h.db.get('SELECT COUNT(*) AS c FROM sentinel_decisions WHERE mode = ?', 'LIVE').c,
      0,
      'so no LIVE sentinel_decisions row exists, even after an evaluation',
    );

    // 3. Configuration refuses to LOAD in LIVE at all, so a live process cannot
    //    reach the point of evaluating an order in the first place.
    assert.throws(
      () => loadConfig({
        path: join(REPO_ROOT, 'config', 'default.json'),
        env: { ...process.env, TEOS_MODE: 'LIVE', TEOS_DATA_DIR: h.dataDir, TEOS_LOG_DIR: h.logDir },
      }),
      (err) => ['MODE_NOT_ALLOWED', 'LIVE_TRADING_DISABLED'].includes(err.code),
      'loading configuration with TEOS_MODE=LIVE is refused outright',
    );
  } finally {
    h.cleanup();
  }
});
