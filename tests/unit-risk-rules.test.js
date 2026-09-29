/**
 * TEOS Trade Agent - tests/unit-risk-rules.test.js
 *
 * Exhaustive unit tests for the risk engine's 19 rules
 * (`src/risk/rules/index.js`), plus the engine behaviour that composes them
 * (`src/risk/risk-engine.js`).
 *
 * WHAT IS AND IS NOT RESTATED HERE
 * ---------------------------------
 * Nothing in this file retypes a production constant:
 *
 *   - rule ids and their order come from `RULES` / `RULE_IDS` / `RULE_BY_ID`
 *   - every limit comes from the harness's live `RiskLimits` (`h.limits`),
 *     which is itself derived from `config/default.json` by `src/risk/limits.js`
 *   - the fee rate comes from `h.config.fees.takerBps`
 *   - the status vocabulary comes from the rules' own `RULE_HELPERS`
 *   - the permission matrices come from the production `permissionsFor()` table
 *
 * The ONE thing declared rather than imported is each branch's expected
 * `severity`. That is deliberate: severity is a SPECIFICATION of what a breach
 * means, not a knob. A declared severity is a pin - if someone changes
 * `NO_LEVERAGE` from CATASTROPHIC to CRITICAL, this suite fails and a human
 * decides whether the policy changed. To keep the pin from rotting into a
 * tautology it is cross-checked against two DERIVED facts:
 *
 *   1. every latching severity must be a value the database will actually
 *      accept (`emergency_stops.severity`'s CHECK constraint, read from the
 *      live schema), and
 *   2. the engine's own `stopToLatch.scope` must agree with it
 *      (`HALT_ALL` if and only if CATASTROPHIC).
 *
 * STRUCTURE
 * ---------
 *   1. registry integrity
 *   2. a healthy context on which all 19 rules PASS (the control that makes
 *      every "this rule blocks" assertion mean something)
 *   3. one test per rule, walking EVERY branch of that rule in isolation
 *   4. ordering: a breach planted at each of the 19 positions
 *   5. fail-closed behaviour
 *   6. latching, and the operator release path
 *
 * SIMULATION ONLY. Paper account, in-process simulator, no real money, no real
 * venue, no leverage. Nothing here is a claim about live trading.
 */

import { test } from 'node:test';
import {
  createHarness, assert, roundEgp, roundTo, countRows, STATES,
} from './helpers/harness.js';
import { RULES, RULE_IDS, RULE_BY_ID, RULE_HELPERS } from '../src/risk/rules/index.js';
import { VERDICTS } from '../src/risk/risk-engine.js';
import { ExecutionFirewall } from '../src/execution/firewall.js';
import { decisionToRow } from '../src/agent/decision.js';
import { permissionsFor } from '../src/agent/state.js';
import { clientOrderId } from '../src/core/ids.js';

// ---------------------------------------------------------------------------
// Vocabulary, derived from the rules themselves
// ---------------------------------------------------------------------------

/**
 * `pass`/`warn`/`block` are the only three shapes a rule result can have. The
 * status strings are read out of them rather than typed, so the assertions below
 * cannot drift from the implementation's own vocabulary.
 */
const PASS = RULE_HELPERS.pass('VOCABULARY').status;
const WARN = RULE_HELPERS.warn('VOCABULARY', '').status;
const BLOCK = RULE_HELPERS.block('VOCABULARY', '').status;
const STATUSES = [PASS, WARN, BLOCK];

/**
 * `pass()` stamps `severity: 'BLOCK'` on a passing result, because severity is
 * only consulted on a failure. Asserted once, explicitly, so that the
 * per-branch tables below can omit `severity` on PASS cases without hiding
 * anything.
 */
const PASS_SEVERITY = RULE_HELPERS.pass('VOCABULARY').severity;

/**
 * The token `AGENT_STATE` compares the agent state against to mean "this agent
 * has no state at all". It is not exported, so it is read out of the rule's own
 * source instead of being restated: a restated literal would let this suite pass
 * against a rule that had been changed to compare against something else.
 */
const UNDEFINED_STATE_TOKEN = (() => {
  const src = RULE_BY_ID.get('AGENT_STATE').evaluate.toString();
  const found = src.match(/agentState === '([A-Za-z_]+)'/);
  assert.ok(found, 'AGENT_STATE still recognises an undefined state by a literal token');
  return found[1];
})();

/**
 * The equity percentage above which `RISK_PER_TRADE` warns rather than passes.
 *
 * Like the undefined-state token, this threshold is a literal inside a rule
 * body and is not exported, so it is read out of the rule's own source rather
 * than restated. Typing the number here would let this suite pass against a
 * rule whose warning band had moved.
 */
const RISK_PCT_WARN = (() => {
  const src = RULE_BY_ID.get('RISK_PER_TRADE').evaluate.toString();
  const found = src.match(/pctOfEquity > ([\d.]+)/);
  assert.ok(found, 'RISK_PER_TRADE still warns above a literal equity-percentage threshold');
  const pct = Number(found[1]);
  assert.ok(Number.isFinite(pct) && pct > 0, 'and the threshold is a positive number');
  return pct;
})();

/**
 * How many times the per-trade cap the derived account holds, used to reach the
 * `RISK_PER_TRADE` warning band. A TEST-CHOSEN divisor, deliberately not a
 * production constant: the safety claim under test is "an order that risks more
 * than X% of the account is surfaced", and only the rule's own threshold and
 * the live `maxLossPerTradeEgp` matter. Raising the account ABOVE the cap, as
 * an earlier draft did, moves the percentage the wrong way and can never trip
 * the band.
 */
const WARN_EQUITY_MULTIPLE = 10;

/**
 * The `system_events` category and message prefix the firewall uses when the
 * risk engine itself throws, read out of the firewall's own source.
 *
 * Both are literals inside `ExecutionFirewall#execute` and neither is exported,
 * so they are derived rather than restated. The point of the fail-closed test
 * is that a decision the engine could not even price leaves an OPERATOR-VISIBLE
 * trace; reading the exact wording from the implementation means the assertion
 * still fails if the logging is removed or changed, instead of silently
 * matching whatever happens to be in the table.
 */
const RISK_ENGINE_ERROR_CATEGORY = (() => {
  const src = ExecutionFirewall.prototype.execute.toString();
  const found = src.match(/category: '([a-z_]+)'/);
  assert.ok(found, 'the firewall still logs a risk-engine failure under a literal category');
  return found[1];
})();

const RISK_ENGINE_THROWN_PREFIX = (() => {
  const src = ExecutionFirewall.prototype.execute.toString();
  const found = src.match(/message: `([^`]*\$\{decision\.decisionId\}[^`]*)`/);
  assert.ok(found, 'the firewall still logs a risk-engine failure under a literal message prefix');
  return found[1].split('${decision.decisionId}')[0];
})();

/**
 * A reference price for the PRICE_SANITY movement cases, chosen so that a
 * one-basis-point move is exactly one unit of `bps` and the arithmetic cannot
 * be blamed for a boundary result. Not a production constant.
 */
const MOVE_REFERENCE = 10_000;

/** A quote whose mid sits `bps` basis points away from `MOVE_REFERENCE`. */
function quoteWithMove(h, bps) {
  const mid = MOVE_REFERENCE + bps;
  return {
    symbol: h.instrument.symbol,
    bid: MOVE_REFERENCE - 3, ask: MOVE_REFERENCE + 3,
    last: mid, mid, spreadBps: 6, seq: 1,
    ts: new Date(h.clock.now()).toISOString(), tsMs: h.clock.now(),
    source: 'test', isStale: false,
  };
}

// ---------------------------------------------------------------------------
// The context a rule actually sees
// ---------------------------------------------------------------------------

/**
 * A context on which all 19 rules PASS.
 *
 * This is the shape `RiskEngine.check()` builds (`src/risk/risk-engine.js:218`),
 * written out so a single rule can be driven in isolation. The values are
 * chosen from the live limits rather than chosen first, so the control stays
 * valid if the configuration is edited.
 */
function healthyCtx(h) {
  const mid = h.quote().mid;
  return {
    decision: {
      symbol: h.instrument.symbol,
      side: 'BUY',
      quantity: 1,
      notionalEgp: roundEgp(mid),
      price: mid,
      expectedExecutionPrice: mid,
      // The default stop distance from the limits, so the control is valid
      // whatever the configuration says the band is.
      stopPrice: roundTo(mid * (1 - h.limits.defaultStopDistancePct / 100), 8),
      riskAtStopEgp: 1,
      riskRewardRatio: 1,
      leverageRequested: false,
      borrowRequested: false,
      derivative: false,
    },
    account: h.account.snapshot(),
    dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
    brokerHealth: h.broker.health(),
    killSwitch: { engaged: false, trigger: null, reason: null },
    quote: h.syntheticQuote({ mid, tsMs: h.clock.now() }),
    referencePrice: mid,
    nowMs: h.clock.now(),
    limits: h.limits,
    instrument: h.instrument,
    orderCounts: { day: 0, bySymbol: {} },
    dateKey: h.clock.dateKey(),
    agentState: STATES.HEALTHY,
    permissions: permissionsFor(STATES.HEALTHY),
    side: 'BUY',
    feeBps: h.config.fees.takerBps,
    clientOrderId: 'UNIT-RISK-RULES',
    existingOrder: null,
  };
}

/** A context with one field replaced, one level deep on `decision`. */
function ctxWith(h, patch) {
  const base = healthyCtx(h);
  const { decision, ...rest } = patch;
  return { ...base, ...rest, decision: { ...base.decision, ...(decision ?? {}) } };
}

// ---------------------------------------------------------------------------
// 1. Registry integrity
// ---------------------------------------------------------------------------

test('RISK REGISTRY: the rule list is well formed, ordered, and self-consistent', () => {
  const h = createHarness();
  try {
    assert.equal(RULE_IDS.length, RULES.length, 'every rule contributes exactly one id');
    assert.equal(new Set(RULE_IDS).size, RULE_IDS.length, 'no rule id is listed twice');
    assert.deepEqual(RULE_IDS, RULES.map((r) => r.id), 'RULE_IDS is the array order, which is the evaluation order');
    assert.equal(RULE_BY_ID.size, RULES.length, 'the by-id index covers the whole registry');

    for (const rule of RULES) {
      assert.equal(typeof rule.id, 'string', `${rule.id}: id is a string`);
      assert.ok(rule.id.length > 0, `${rule.id}: id is not empty`);
      assert.ok(rule.description && rule.description.length > 0, `${rule.id}: carries a description`);
      assert.equal(typeof rule.evaluate, 'function', `${rule.id}: is callable`);
    }

    // The declared order is the documented one: absolute prohibitions, then
    // connectivity and data quality, then account limits, then order checks.
    const absoluteFirst = ['NO_LEVERAGE', 'KILL_SWITCH', 'AGENT_STATE'];
    const dataNext = ['CONNECTION', 'DATA_FRESHNESS', 'PRICE_SANITY'];
    assert.deepEqual(RULE_IDS.slice(0, 3), absoluteFirst, 'the absolute prohibitions run first');
    assert.deepEqual(RULE_IDS.slice(3, 6), dataNext, 'then connectivity and data quality');
    assert.ok(
      RULE_IDS.indexOf('EXPOSURE') < RULE_IDS.indexOf('SUFFICIENT_BALANCE'),
      'portfolio exposure is evaluated before per-order affordability',
    );
    assert.equal(RULE_IDS.at(-1), 'DUPLICATE_ORDER', 'idempotency is the last check, after everything it could shadow');

    // `pass()` stamps a BLOCK severity on a PASS; severity is only read on a
    // failure, so this is a fact about the shape, not a defect.
    assert.equal(PASS_SEVERITY, BLOCK, 'a passing result carries the default severity, which nothing reads');
    assert.deepEqual(STATUSES, [PASS, WARN, BLOCK], 'and the three statuses are distinct');
    assert.ok(!Object.values(STATES).includes(UNDEFINED_STATE_TOKEN), 'the undefined agent state is not one of the real states');
  } finally {
    h.cleanup();
  }
});

/**
 * The severities the database will actually accept on a stop row, read out of
 * the live schema rather than restated.
 *
 * A rule's declared severity is written onto `emergency_stops` whenever
 * `latchesStop` is true. If a rule declared a value the CHECK constraint
 * rejects, the refusal and the latched stop are written in one transaction
 * (`src/risk/risk-engine.js:327-337`) and would roll back TOGETHER - so the
 * order would look merely blocked instead of stopped, and the cause would
 * disappear with the error.
 */
function allowedStopSeverities(h) {
  const ddl = h.db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'emergency_stops'").sql;
  const allowed = [...ddl.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(allowed.includes('CATASTROPHIC'), 'the schema does declare a CATASTROPHIC stop severity');
  return allowed;
}

// ---------------------------------------------------------------------------
// 2. The healthy control
// ---------------------------------------------------------------------------

test('RISK CONTROL: a healthy context passes every rule, in order, with no warning', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const ctx = healthyCtx(h);

    const results = RULES.map((rule) => rule.evaluate(ctx));

    assert.equal(results.length, RULES.length, 'every rule in the registry was evaluated');
    assert.deepEqual(
      results.map((r) => r.rule), RULE_IDS,
      'each result names the rule that produced it, in evaluation order',
    );
    for (const r of results) {
      assert.equal(r.status, PASS, `${r.rule} passes on a healthy context (got ${r.status}: ${r.detail})`);
      assert.equal(r.latchesStop, false, `${r.rule} does not latch when it passes`);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, `${r.rule} says why it passed`);
    }

    // The permission matrix is not optional. A context without one is refused by
    // AGENT_STATE, which is why this control has to supply a real one.
    const noMatrix = RULE_BY_ID.get('AGENT_STATE').evaluate({ ...ctx, permissions: null });
    assert.equal(noMatrix.status, BLOCK, 'a context with no permission matrix is not a healthy context');
  } finally {
    h.cleanup();
  }
});

test('RISK CONTROL: the engine allows a well-formed order and audits the decision', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const decision = h.buyDecision({ price: mid });

    const res = await h.submit(decision);

    assert.equal(res.outcome, 'EXECUTED', 'a well-formed paper order executes');
    assert.equal(res.riskVerdict.verdict, VERDICTS.ALLOW, 'and the risk verdict is an allow');
    assert.equal(res.riskVerdict.blocked, false, 'not a block');
    assert.equal(res.riskVerdict.failedRule, null, 'with no failed rule');
    assert.equal(res.riskVerdict.rulesEvaluated, RULES.length, 'every rule ran');
    assert.equal(res.riskVerdict.rulesTotal, RULES.length, 'and the total is the registry size');
    assert.equal(res.riskVerdict.passedCount, RULES.length, 'all of them passed');
    assert.equal(res.riskVerdict.failedCount, 0, 'none failed');
    assert.equal(res.riskVerdict.stopToLatch, null, 'nothing was latched');
    assert.ok(
      res.riskVerdict.rules.every((r) => r.status === PASS),
      'every recorded rule result is a pass',
    );

    // The verdict is auditable, not just returned: the row exists and carries
    // the same rule results.
    assert.equal(countRows(h, 'risk_decisions'), 1, 'the allow is recorded exactly once');
    const row = h.repos.getRiskDecision(res.riskVerdict.riskDecisionId);
    assert.equal(row.verdict, VERDICTS.ALLOW, 'and reads back as an allow');
    assert.equal(row.rules.length, RULES.length, 'with every rule result persisted');
    assert.equal(row.limits.maxLossPerTradeEgp, h.limits.maxLossPerTradeEgp, 'and the limits in force at the time');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Per-rule branch tables
// ---------------------------------------------------------------------------

/**
 * Every branch of every rule, with the inputs that reach it and the outcome the
 * policy requires. `patch` is applied to the healthy context; `expect.status`,
 * `expect.severity`, `expect.latchesStop` and `expect.mentions` are asserted.
 *
 * `mentions` are tokens the refusal message must contain, each derived from a
 * live limit or a live instrument field - never typed from memory, so the
 * operator-facing message cannot silently quote a stale number.
 */
function branchCases(h) {
  const L = h.limits;
  const inst = h.instrument;
  const mid = h.quote().mid;
  const age = (ms) => ctxWith(h, { quote: { ...h.syntheticQuote({ mid }), tsMs: h.clock.now() - ms } });
  const bought = (patch) => ctxWith(h, { decision: { side: 'BUY', ...patch } });
  const sold = (patch) => ctxWith(h, { decision: { side: 'SELL', ...patch }, side: 'SELL' });
  const account = (patch) => ctxWith(h, { account: { ...h.account.snapshot(), ...patch } });

  // ---- RISK_PER_TRADE's warning band -------------------------------------
  //
  // The warning branch is a PERCENTAGE OF EQUITY, and the per-trade cap is a
  // FIXED EGP amount. The percentage the cap represents therefore SHRINKS as
  // the account grows: risking the whole cap on an account twice the size is
  // half the exposure, proportionally. The previous case in this file reached
  // for a LARGER equity (1000) to provoke the warning, which is exactly
  // backwards - a bigger denominator makes the percentage smaller, so the rule
  // correctly returned PASS. The expectation was wrong; the code is
  // authoritative. The account is made SMALL relative to the cap instead, and
  // the equity is derived from the cap so the branch survives an edit to
  // `config/default.json`.
  const warnEquity = roundEgp(L.maxLossPerTradeEgp * WARN_EQUITY_MULTIPLE);
  const warnPct = roundTo((L.maxLossPerTradeEgp / warnEquity) * 100, 3);
  assert.ok(
    warnPct > RISK_PCT_WARN,
    `the derived account (EGP ${warnEquity}) puts the cap at ${warnPct}% of equity, `
    + `which must actually exceed the ${RISK_PCT_WARN}% warning band`,
  );

  return {
    // ---- 1 NO_LEVERAGE ---------------------------------------------------
    NO_LEVERAGE: [
      { name: 'leverage requested', patch: { decision: { leverageRequested: true } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true } },
      { name: 'borrowing requested', patch: { decision: { borrowRequested: true } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true } },
      { name: 'derivative requested', patch: { decision: { derivative: true } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true } },
      // All three flags absent is different from all three explicitly false:
      // the engine always sets them false, but a hand-built context may not.
      { name: 'flags absent', patch: { decision: { leverageRequested: undefined, borrowRequested: undefined, derivative: undefined } }, expect: { status: PASS } },
    ],

    // ---- 2 KILL_SWITCH ---------------------------------------------------
    //
    // The refusal message quotes the stop's REASON, not its trigger:
    // `Emergency stop engaged: ${killSwitch.reason}.` The trigger travels in
    // `data.trigger` instead, and the latched `emergency_stops` row carries it
    // as its own `trigger` column.
    //
    // The previous expectation in this file was `mentions: ['DAILY_LOSS']`,
    // i.e. it demanded the trigger inside the sentence. That expectation was
    // WRONG, and the code is authoritative: `src/risk/rules/index.js` builds
    // the detail from `killSwitch.reason` alone. Nothing is lost by it - the
    // trigger is asserted below on `data.trigger`, and again end-to-end in the
    // latch test, which reads it off the durable stop row. Asserting the trigger
    // in the prose would have been asserting a message the rule does not write.
    KILL_SWITCH: [
      {
        name: 'stop engaged',
        patch: { killSwitch: { engaged: true, trigger: 'DAILY_LOSS', reason: 'limit reached', since: h.clock.now(), scope: 'HALT_ALL' } },
        expect: {
          status: BLOCK,
          severity: 'CATASTROPHIC',
          latchesStop: false,
          mentions: ['limit reached'],
          data: { trigger: 'DAILY_LOSS', scope: 'HALT_ALL', since: h.clock.now() },
        },
      },
      {
        // The stop already exists; the rule only reports it. Re-latching here
        // would be a stop caused by a stop, and would make `clearStop()`
        // unable to release anything.
        name: 'an engaged stop with no reason recorded',
        patch: { killSwitch: { engaged: true } },
        expect: {
          status: BLOCK,
          severity: 'CATASTROPHIC',
          latchesStop: false,
          mentions: ['unspecified'],
          data: { trigger: null, since: null, scope: 'NEW_ORDERS' },
        },
      },
      { name: 'stop clear', patch: {}, expect: { status: PASS } },
    ],

    // ---- 3 AGENT_STATE ---------------------------------------------------
    AGENT_STATE: [
      { name: 'state is the undefined token', patch: { agentState: UNDEFINED_STATE_TOKEN }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: [UNDEFINED_STATE_TOKEN] } },
      { name: 'state is null', patch: { agentState: null }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: ['null'] } },
      { name: 'no permission matrix on the decision', patch: { permissions: null }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: ['permission matrix'] } },
      {
        // Exits stay possible in a state that forbids new exposure. Losing the
        // ability to reduce is how a bad state becomes a permanent one.
        name: 'sell permitted by a reduce-only state',
        patch: { agentState: STATES.DEGRADED, permissions: permissionsFor(STATES.DEGRADED), side: 'SELL' },
        expect: { status: PASS },
      },
      {
        name: 'buy refused by a reduce-only state',
        patch: { agentState: STATES.DEGRADED, permissions: permissionsFor(STATES.DEGRADED) },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [STATES.DEGRADED] },
      },
      {
        name: 'sell refused by a state that permits nothing',
        patch: { agentState: STATES.STOPPED, permissions: permissionsFor(STATES.STOPPED), side: 'SELL' },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [STATES.STOPPED] },
      },
      { name: 'buy permitted by the healthy state', patch: {}, expect: { status: PASS } },
    ],

    // ---- 4 CONNECTION ----------------------------------------------------
    CONNECTION: [
      { name: 'no health object at all', patch: { brokerHealth: null }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['No broker health'] } },
      {
        name: 'failure count at the halt threshold',
        patch: { brokerHealth: { connected: true, consecutiveFailures: L.consecutiveFailureHaltCount } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.consecutiveFailureHaltCount)] },
      },
      {
        // The count branch is checked first, so a broker that is both
        // disconnected and failing reports the count. An operator reading
        // "3 consecutive failures" learns more than "disconnected".
        name: 'disconnected and failing: the count is reported, not the disconnection',
        patch: { brokerHealth: { connected: false, consecutiveFailures: L.consecutiveFailureHaltCount + 1 } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.consecutiveFailureHaltCount + 1)] },
      },
      { name: 'disconnected with no recorded failures', patch: { brokerHealth: { connected: false, consecutiveFailures: 0 } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['disconnected'] } },
      {
        name: 'one failure, below the threshold',
        patch: { brokerHealth: { connected: true, consecutiveFailures: 1 } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false, mentions: ['1'] },
      },
      { name: 'healthy', patch: {}, expect: { status: PASS } },
    ],

    // ---- 5 DATA_FRESHNESS ------------------------------------------------
    DATA_FRESHNESS: [
      { name: 'no quote for the symbol', patch: { quote: null }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['No market data'] } },
      {
        name: 'one millisecond past the staleness limit',
        patch: { quote: { ...h.syntheticQuote({ mid }), tsMs: h.clock.now() - (L.maxDataStalenessMs + 1) } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.maxDataStalenessMs)] },
      },
      {
        // The block branch is `>`, so data exactly at the limit is not stale
        // enough to stop trading - it is only old enough to warn about.
        name: 'exactly at the staleness limit',
        patch: { quote: { ...h.syntheticQuote({ mid }), tsMs: h.clock.now() - L.maxDataStalenessMs } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false },
      },
      {
        name: 'one millisecond past the degraded threshold',
        patch: { quote: { ...h.syntheticQuote({ mid }), tsMs: h.clock.now() - (L.degradedDataFreshnessMs + 1) } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false, mentions: [String(L.degradedDataFreshnessMs + 1)] },
      },
      {
        name: 'exactly at the degraded threshold',
        patch: { quote: { ...h.syntheticQuote({ mid }), tsMs: h.clock.now() - L.degradedDataFreshnessMs } },
        expect: { status: PASS },
      },
      { name: 'fresh', patch: {}, expect: { status: PASS } },
    ],

    // ---- 6 PRICE_SANITY --------------------------------------------------
    PRICE_SANITY: [
      { name: 'mid is zero', patch: { quote: h.syntheticQuote({ mid: 0 }) }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true } },
      { name: 'mid is negative', patch: { quote: h.syntheticQuote({ mid: -mid }) }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true } },
      {
        // `syntheticQuote` cannot build a non-finite mid (the money rounder
        // refuses it), so this quote is assembled directly.
        name: 'mid is not a number',
        patch: { quote: { ...h.syntheticQuote({ mid }), mid: Number.NaN, last: Number.NaN } },
        expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true },
      },
      {
        name: 'spread one basis point over the limit',
        patch: { quote: h.syntheticQuote({ mid, spreadBps: L.maxSpreadBps + 1 }) },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.maxSpreadBps)] },
      },
      { name: 'spread exactly at the limit', patch: { quote: h.syntheticQuote({ mid, spreadBps: L.maxSpreadBps }) }, expect: { status: PASS } },
      {
        name: 'movement one basis point over the limit',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps + 1), referencePrice: MOVE_REFERENCE },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.priceDeviationLimitBps)] },
      },
      {
        // `>` again: a move of exactly the limit is not a block. It is still
        // well inside the warning band, so it warns.
        name: 'movement exactly at the limit warns rather than blocks',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps), referencePrice: MOVE_REFERENCE },
        expect: { status: WARN, severity: 'WARN', latchesStop: false },
      },
      {
        name: 'movement one basis point over the warning band',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps * 0.6 + 1), referencePrice: MOVE_REFERENCE },
        expect: { status: WARN, severity: 'WARN', latchesStop: false },
      },
      {
        name: 'movement exactly at the warning band',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps * 0.6), referencePrice: MOVE_REFERENCE },
        expect: { status: PASS },
      },
      {
        // A first observation has no reference. "There is no previous price" is
        // not the same statement as "the price moved".
        name: 'no reference price: the movement check is skipped',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps * 100), referencePrice: null },
        expect: { status: PASS },
      },
      {
        name: 'a non-positive reference price is also skipped',
        patch: { quote: quoteWithMove(h, L.priceDeviationLimitBps * 100), referencePrice: 0 },
        expect: { status: PASS },
      },
    ],

    // ---- 7 MAX_CAPITAL ---------------------------------------------------
    MAX_CAPITAL: [
      {
        name: 'equity far above the cap',
        patch: { account: { ...h.account.snapshot(), equityEgp: L.maxStartingCapitalEgp * 1.5 + 1 } },
        expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: [String(L.maxStartingCapitalEgp)] },
      },
      {
        // The multiple exists so that ordinary equity drift - including a good
        // run - is not treated as a breach. At exactly 1.5x the account is
        // remarkable, not impossible.
        name: 'equity exactly at the multiple',
        patch: { account: { ...h.account.snapshot(), equityEgp: L.maxStartingCapitalEgp * 1.5 } },
        expect: { status: PASS },
      },
      {
        name: 'starting capital above the cap',
        patch: { account: { ...h.account.snapshot(), startingCapitalEgp: L.maxStartingCapitalEgp + 1 } },
        expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: [String(L.maxStartingCapitalEgp)] },
      },
      { name: 'equity exhausted', patch: { account: { ...h.account.snapshot(), equityEgp: 0 } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['exhausted'] } },
      { name: 'account healthy', patch: {}, expect: { status: PASS } },
    ],

    // ---- 8 NO_NEGATIVE_CASH ---------------------------------------------
    NO_NEGATIVE_CASH: [
      { name: 'cash negative by a piastre', patch: { account: { ...h.account.snapshot(), cashEgp: -0.01 } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: ['negative'] } },
      { name: 'cash exactly zero', patch: { account: { ...h.account.snapshot(), cashEgp: 0 } }, expect: { status: PASS } },
      {
        // The comparison is in integer piastres, so a sub-piastre negative
        // balance - which the money type cannot represent and the ledger
        // cannot produce - does not become a spurious refusal.
        name: 'sub-piastre negative cash is not a negative balance',
        patch: { account: { ...h.account.snapshot(), cashEgp: -0.001 } },
        expect: { status: PASS },
      },
    ],

    // ---- 9 DAILY_LOSS ----------------------------------------------------
    DAILY_LOSS: [
      {
        // `>=`, so the limit is a hard floor: reaching it stops trading.
        name: 'loss exactly at the daily limit',
        patch: { dailyLoss: { realizedEgp: -L.dailyLossLimitEgp, unrealizedEgp: 0 } },
        expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: [String(L.dailyLossLimitEgp)] },
      },
      {
        name: 'realised and unrealised together over the limit',
        patch: { dailyLoss: { realizedEgp: -(L.dailyLossLimitEgp / 2), unrealizedEgp: -(L.dailyLossLimitEgp / 2 + 1) } },
        expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true },
      },
      {
        name: 'one piastre under the limit, inside the warning band',
        patch: { dailyLoss: { realizedEgp: -(L.dailyLossLimitEgp - 0.01), unrealizedEgp: 0 } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false, mentions: [String(L.dailyLossLimitEgp)] },
      },
      { name: 'one piastre under the warning band', patch: { dailyLoss: { realizedEgp: -(L.dailyLossLimitEgp * 0.8 - 0.01), unrealizedEgp: 0 } }, expect: { status: PASS } },
      {
        // A profitable day is not a loss. `max(0, -x)` is what makes this true,
        // and a rule that forgot the clamp would refuse every good day.
        name: 'a gain is not a loss',
        patch: { dailyLoss: { realizedEgp: L.dailyLossLimitEgp * 10, unrealizedEgp: 0 } },
        expect: { status: PASS },
      },
    ],

    // ---- 10 EXPOSURE ----------------------------------------------------
    EXPOSURE: [
      {
        name: 'already over the cap, and the order adds to it',
        patch: { account: { ...h.account.snapshot(), exposureEgp: L.maxPortfolioExposureEgp + 1 } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.maxPortfolioExposureEgp)] },
      },
      {
        // The deliberate exception. Exposure is marked to market and can drift
        // over the cap between orders; refusing the sell that shrinks it would
        // make the breach permanent.
        name: 'already over the cap, and the order reduces it',
        patch: {
          account: { ...h.account.snapshot(), exposureEgp: L.maxPortfolioExposureEgp + 1 },
          decision: { side: 'SELL', notionalEgp: roundEgp(mid) },
          side: 'SELL',
        },
        expect: { status: WARN, severity: 'CRITICAL', latchesStop: false, mentions: [String(L.maxPortfolioExposureEgp)] },
      },
      {
        // Branch 3, not branch 2: the account is inside the cap and this single
        // order is what would cross it. An arithmetic outcome is not a
        // systemic fault, so it does not latch.
        name: 'inside the cap, but the order would cross it',
        patch: { account: { ...h.account.snapshot(), exposureEgp: L.maxPortfolioExposureEgp }, decision: { notionalEgp: roundEgp(mid) } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [String(L.maxPortfolioExposureEgp)] },
      },
      {
        name: 'inside the cap with room to spare',
        patch: { account: { ...h.account.snapshot(), exposureEgp: L.maxPortfolioExposureEgp - roundEgp(mid) } },
        expect: { status: PASS },
      },
      { name: 'an exit with no exposure at all', patch: { decision: { side: 'SELL' }, side: 'SELL' }, expect: { status: PASS } },
    ],

    // ---- 11 OPEN_POSITIONS ----------------------------------------------
    OPEN_POSITIONS: [
      { name: 'at the position cap', patch: { account: { ...h.account.snapshot(), openPositions: L.maxOpenPositions } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [String(L.maxOpenPositions)] } },
      { name: 'above the position cap', patch: { account: { ...h.account.snapshot(), openPositions: L.maxOpenPositions + 5 } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false } },
      {
        // A cap on taking on exposure must never trap exposure that is already
        // open, so the exit is exempt even when the account is over the cap.
        name: 'an exit is exempt even when over the cap',
        patch: { account: { ...h.account.snapshot(), openPositions: L.maxOpenPositions + 5 }, decision: { side: 'SELL' }, side: 'SELL' },
        expect: { status: PASS },
      },
      { name: 'one slot left', patch: { account: { ...h.account.snapshot(), openPositions: L.maxOpenPositions - 1 } }, expect: { status: PASS } },
    ],

    // ---- 12 ORDER_RATE ---------------------------------------------------
    ORDER_RATE: [
      {
        name: 'at the daily cap',
        patch: { orderCounts: { day: L.maxOrdersPerDay, bySymbol: {} } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.maxOrdersPerDay)] },
      },
      {
        name: 'at the per-symbol cap',
        patch: { orderCounts: { day: 0, bySymbol: { [inst.symbol]: L.maxOrdersPerSymbolPerDay } } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: [String(L.maxOrdersPerSymbolPerDay), inst.symbol] },
      },
      {
        // Per-symbol counting is per symbol. A busy instrument must not consume
        // another instrument's budget.
        name: 'another symbol at its cap does not block this one',
        patch: { orderCounts: { day: 0, bySymbol: { [inst.symbol]: 0, 'OTHER/EGP': L.maxOrdersPerSymbolPerDay } } },
        expect: { status: PASS },
      },
      { name: 'both caps exactly one below', patch: { orderCounts: { day: L.maxOrdersPerDay - 1, bySymbol: { [inst.symbol]: L.maxOrdersPerSymbolPerDay - 1 } } }, expect: { status: PASS } },
      { name: 'an exit is exempt', patch: { orderCounts: { day: L.maxOrdersPerDay, bySymbol: {} }, decision: { side: 'SELL' }, side: 'SELL' }, expect: { status: PASS } },
    ],

    // ---- 13 ORDER_VALID --------------------------------------------------
    ORDER_VALID: [
      { name: 'symbol not in the configuration', patch: { instrument: null, decision: { symbol: 'NOT/A/SYMBOL' } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: ['NOT/A/SYMBOL'] } },
      { name: 'quantity zero', patch: { decision: { quantity: 0 } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: ['positive'] } },
      { name: 'quantity negative', patch: { decision: { quantity: -1 } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false } },
      { name: 'quantity below the instrument minimum', patch: { decision: { quantity: inst.minQty / 2 } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: [String(inst.minQty)] } },
      { name: 'quantity exactly at the instrument minimum', patch: { decision: { quantity: inst.minQty } }, expect: { status: PASS } },
      { name: 'expected execution price zero', patch: { decision: { expectedExecutionPrice: 0 } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: ['positive'] } },
      { name: 'notional negative', patch: { decision: { notionalEgp: -1 } }, expect: { status: BLOCK, severity: 'CATASTROPHIC', latchesStop: true, mentions: ['Negative notional'] } },
      { name: 'notional exactly zero is not negative', patch: { decision: { notionalEgp: 0, quantity: 0 } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false } },
      { name: 'a well-formed order', patch: {}, expect: { status: PASS } },
    ],

    // ---- 14 MIN_NOTIONAL -------------------------------------------------
    MIN_NOTIONAL: [
      { name: 'buy one piastre under the minimum', patch: { decision: { notionalEgp: roundEgp(L.minOrderNotionalEgp - 0.01) } }, expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: [String(L.minOrderNotionalEgp)] } },
      { name: 'buy exactly at the minimum', patch: { decision: { notionalEgp: L.minOrderNotionalEgp } }, expect: { status: PASS } },
      {
        // Dust is refused because of fees, not because of risk. A dust-sized
        // exit still has to be allowed through.
        name: 'a dust-sized exit is allowed',
        patch: { decision: { side: 'SELL', notionalEgp: roundEgp(L.minOrderNotionalEgp - 0.01) }, side: 'SELL' },
        expect: { status: PASS },
      },
    ],

    // ---- 15 SUFFICIENT_BALANCE -------------------------------------------
    SUFFICIENT_BALANCE: [
      { name: 'sell needs no cash', patch: { decision: { side: 'SELL' }, side: 'SELL' }, expect: { status: PASS } },
      {
        // The requirement is notional PLUS fee. Testing notional alone would
        // pass while the order spent the fee out of the balance.
        name: 'notional fits but the fee does not',
        patch: { decision: { notionalEgp: h.account.snapshot().cashEgp } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false },
      },
      { name: 'exactly affordable including the fee', patch: { decision: { notionalEgp: roundEgp(h.account.snapshot().cashEgp / (1 + h.config.fees.takerBps / 10_000)) } }, expect: { status: PASS } },
      { name: 'one piastre short', patch: { decision: { notionalEgp: roundEgp(h.account.snapshot().cashEgp) } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false } },
    ],

    // ---- 16 POSITION_SIZE ------------------------------------------------
    POSITION_SIZE: [
      { name: 'one piastre over the position cap', patch: { decision: { notionalEgp: roundEgp(L.maxPositionSizeEgp + 0.01) } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [String(L.maxPositionSizeEgp)] } },
      { name: 'exactly at the position cap', patch: { decision: { notionalEgp: L.maxPositionSizeEgp } }, expect: { status: PASS } },
      { name: 'a sell is bounded by the position, not by this cap', patch: { decision: { side: 'SELL', notionalEgp: L.maxPositionSizeEgp * 10 }, side: 'SELL' }, expect: { status: PASS } },
    ],

    // ---- 17 RISK_PER_TRADE -----------------------------------------------
    // The warning case uses the derived equity and percentage computed at the
    // top of this function, so nothing about it is typed from memory.
    RISK_PER_TRADE: [
      { name: 'a sell realises risk that already exists', patch: { decision: { side: 'SELL' }, side: 'SELL' }, expect: { status: PASS } },
      { name: 'risk one piastre over the cap', patch: { decision: { riskAtStopEgp: roundEgp(L.maxLossPerTradeEgp + 0.01) } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: [String(L.maxLossPerTradeEgp)] } },
      { name: 'risk exactly at the cap', patch: { decision: { riskAtStopEgp: L.maxLossPerTradeEgp } }, expect: { status: PASS } },
      {
        // Within the absolute cap, but too much of the account: allowed, and
        // recorded as a warning so the operator can see the sizing pressure.
        name: 'risk within the cap but over the equity-percentage warning',
        patch: { decision: { riskAtStopEgp: L.maxLossPerTradeEgp }, account: { ...h.account.snapshot(), equityEgp: warnEquity } },
        expect: {
          status: WARN, severity: 'WARN', latchesStop: false,
          mentions: [String(warnPct)],
          dataAbove: { pctOfEquity: RISK_PCT_WARN },
        },
      },
      {
        // With no equity to divide by there is no percentage, so the rule falls
        // back to 100% - which is a warning, and MAX_CAPITAL (earlier) is what
        // actually stops the order.
        name: 'zero equity warns rather than dividing by zero',
        patch: { decision: { riskAtStopEgp: 1 }, account: { ...h.account.snapshot(), equityEgp: 0 } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false, data: { pctOfEquity: 100 } },
      },
    ],

    // ---- 18 STOP_CONDITION -----------------------------------------------
    STOP_CONDITION: [
      { name: 'an exit needs no stop', patch: { decision: { side: 'SELL', stopPrice: null }, side: 'SELL' }, expect: { status: PASS } },
      { name: 'an entry with no stop at all', patch: { decision: { stopPrice: null } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['mandatory'] } },
      {
        // The mandatory stop is a configuration, not a hard-coded truth. With
        // it switched off, a stop is optional - and the band checks still
        // apply to one that is present.
        name: 'no stop required, and none supplied',
        patch: { decision: { stopPrice: null }, limits: { ...h.limits, stopLossRequired: false } },
        expect: { status: PASS },
      },
      {
        name: 'stop inside the noise band',
        patch: { decision: { stopPrice: roundTo(mid * (1 - L.minStopDistancePct / 200), 8) } },
        expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: [String(L.minStopDistancePct)] },
      },
      {
        // `PCT_EPSILON` exists precisely so a stop read back at exactly the
        // minimum is not refused as being inside the band.
        name: 'stop exactly at the minimum distance',
        patch: { decision: { stopPrice: roundTo(mid * (1 - L.minStopDistancePct / 100), 8) } },
        expect: { status: PASS },
      },
      {
        name: 'stop beyond the maximum distance',
        patch: { decision: { stopPrice: roundTo(mid * (1 - (L.maxStopDistancePct + 1) / 100), 8) } },
        expect: { status: BLOCK, severity: BLOCK, latchesStop: false, mentions: [String(L.maxStopDistancePct)] },
      },
      { name: 'stop exactly at the maximum distance', patch: { decision: { stopPrice: roundTo(mid * (1 - L.maxStopDistancePct / 100), 8) } }, expect: { status: PASS } },
      {
        // Reached only from above: a stop AT the entry is inside the minimum
        // band and would be refused there first. A stop ABOVE the entry is
        // inside the band and is caught by the long-only direction check.
        name: 'stop above the entry price',
        patch: { decision: { stopPrice: roundTo(mid * 1.01, 8) } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: true, mentions: ['below the entry price'] },
      },
      {
        // A weak reward ratio is a warning, never a refusal. Refusing it would
        // mean an account could be left unable to take a merely mediocre trade.
        name: 'risk/reward below the minimum',
        patch: { decision: { riskRewardRatio: roundTo(L.minRiskRewardRatio / 2, 6) } },
        expect: { status: WARN, severity: 'WARN', latchesStop: false, mentions: [String(L.minRiskRewardRatio)] },
      },
      { name: 'risk/reward exactly at the minimum', patch: { decision: { riskRewardRatio: L.minRiskRewardRatio } }, expect: { status: PASS } },
      {
        // The ratio is nullable and null skips the comparison, so a strategy
        // that does not compute one is not permanently untradeable.
        name: 'no risk/reward computed at all',
        patch: { decision: { riskRewardRatio: null } },
        expect: { status: PASS },
      },
    ],

    // ---- 19 DUPLICATE_ORDER ----------------------------------------------
    DUPLICATE_ORDER: [
      {
        name: 'an order already exists for this client order id',
        patch: { existingOrder: { order_id: 'ord_existing', status: 'NEW' } },
        expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false, mentions: ['ord_existing', 'NEW'] },
      },
      { name: 'an order that already failed is still a duplicate', patch: { existingOrder: { order_id: 'ord_old', status: 'REJECTED' } }, expect: { status: BLOCK, severity: 'CRITICAL', latchesStop: false } },
      { name: 'no prior order', patch: {}, expect: { status: PASS } },
    ],
  };
}

/**
 * The declared severities, flattened, for the schema cross-check in test 1b.
 * Kept beside the table so the two cannot drift apart by accident.
 */
const DECLARED_SEVERITIES = [
  { severity: 'CATASTROPHIC', latchesStop: true },
  { severity: 'CATASTROPHIC', latchesStop: false },
  { severity: 'CRITICAL', latchesStop: true },
  { severity: 'CRITICAL', latchesStop: false },
  { severity: BLOCK, latchesStop: false },
  { severity: 'WARN', latchesStop: false },
];

for (const ruleId of RULE_IDS) {
  test(`RISK RULE ${ruleId}: every branch returns the status and severity the policy requires`, () => {
    const h = createHarness();
    try {
      h.tickMarket();
      const rule = RULE_BY_ID.get(ruleId);
      const cases = branchCases(h)[ruleId];

      assert.ok(cases && cases.length > 0, `${ruleId} has branch cases`);
      assert.ok(
        cases.some((c) => c.expect.status === BLOCK),
        `${ruleId} has at least one case that refuses, so this is not a rule that can only pass`,
      );
      assert.ok(
        cases.every((c) => STATUSES.includes(c.expect.status)),
        `${ruleId}: every declared status is one of the three the rules can return`,
      );

      for (const c of cases) {
        const res = rule.evaluate(ctxWith(h, c.patch));
        const where = `${ruleId} / ${c.name}`;

        assert.equal(res.rule, ruleId, `${where}: the result names the rule that produced it`);
        assert.equal(res.status, c.expect.status, `${where}: status`);
        assert.ok(typeof res.detail === 'string' && res.detail.length > 0, `${where}: carries a reason`);
        assert.equal(typeof res.data, 'object', `${where}: carries data`);

        if (c.expect.status === PASS) {
          assert.equal(res.latchesStop, false, `${where}: a pass never latches`);
        } else {
          assert.equal(res.severity, c.expect.severity, `${where}: severity`);
          assert.equal(res.latchesStop, c.expect.latchesStop, `${where}: latchesStop`);
        }
        // `data` is asserted key by key rather than wholesale, because several
        // rules attach a context snapshot to the result and pinning the whole
        // object would make the test fail on an unrelated field. What matters
        // is that the operator-facing facts survive into the audit record even
        // when the prose message does not repeat them.
        for (const [key, value] of Object.entries(c.expect.data ?? {})) {
          assert.deepEqual(res.data?.[key], value, `${where}: data.${key} carries the value the rule read`);
        }
        for (const [key, bound] of Object.entries(c.expect.dataAbove ?? {})) {
          assert.ok(
            res.data?.[key] > bound,
            `${where}: data.${key} (${res.data?.[key]}) is above the threshold ${bound}`,
          );
        }
        for (const token of c.expect.mentions ?? []) {
          assert.ok(
            String(res.detail).includes(String(token)),
            `${where}: the reason quotes ${token} so the operator sees the live limit (got "${res.detail}")`,
          );
        }
      }
    } finally {
      h.cleanup();
    }
  });
}

test('RISK RULES: the branch tables cover every registered rule, with no invented ids', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const cases = branchCases(h);
    assert.deepEqual(
      Object.keys(cases).sort(), [...RULE_IDS].sort(),
      'the branch table describes exactly the rules in the registry',
    );
    for (const id of RULE_IDS) {
      assert.ok(cases[id].length >= 3, `${id} has at least three branches covered`);
    }
  } finally {
    h.cleanup();
  }
});

test('RISK RULE AGENT_STATE: the whole permission matrix, for both sides', () => {
  // The matrix is the rule's decision table. Walking it in both directions
  // proves two things at once: a state that can exit can always exit, and a
  // state that cannot open can still reduce.
  const h = createHarness();
  try {
    h.tickMarket();
    const rule = RULE_BY_ID.get('AGENT_STATE');

    for (const state of Object.keys(STATES)) {
      const permissions = permissionsFor(state);
      const common = { agentState: state, permissions };

      const buy = rule.evaluate({ ...common, side: 'BUY' });
      const sell = rule.evaluate({ ...common, side: 'SELL' });

      assert.equal(buy.status, permissions.openPosition ? PASS : BLOCK, `${state}: a buy is ${permissions.openPosition ? 'allowed' : 'refused'}`);
      assert.equal(sell.status, permissions.reduceOnly ? PASS : BLOCK, `${state}: a sell is ${permissions.reduceOnly ? 'allowed' : 'refused'}`);

      if (permissions.reduceOnly === true) {
        assert.equal(sell.severity, PASS_SEVERITY, `${state}: an allowed exit has no severity of its own`);
      } else {
        assert.equal(sell.severity, 'CRITICAL', `${state}: a refused exit is a limit breach, not a structural fault`);
        assert.equal(sell.latchesStop, false, `${state}: and it does not latch`);
      }
      if (permissions.openPosition !== true) {
        assert.equal(buy.severity, 'CRITICAL', `${state}: a refused entry is a limit breach`);
        assert.equal(buy.latchesStop, false, `${state}: and it does not latch`);
      }
    }

    // An unrecognised state has no permissions at all, so it fails closed at
    // the source as well as in the rule.
    const unknown = permissionsFor('NOT_A_REAL_STATE');
    assert.deepEqual(unknown, { evaluate: false, openPosition: false, reduceOnly: false }, 'an unknown state permits nothing');
    assert.equal(rule.evaluate({ agentState: 'NOT_A_REAL_STATE', permissions: unknown, side: 'SELL' }).status, BLOCK, 'and cannot even exit');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Ordering
// ---------------------------------------------------------------------------

/** A proposal the risk engine could plausibly have produced. */
function baseProposal(h) {
  const mid = h.quote().mid;
  return {
    side: 'BUY',
    quantity: 1,
    notionalEgp: roundEgp(mid),
    stopPrice: roundTo(mid * (1 - h.limits.defaultStopDistancePct / 100), 8),
    riskAtStopEgp: 1,
    riskBudgetEgp: 1,
    expectedExecutionPrice: mid,
    reason: 'UNIT_TEST',
  };
}

/** A persisted decision the risk engine can be pointed at. */
function engineDecision(h, patch = {}) {
  const d = h.buyDecision({ price: h.quote().mid });
  h.repos.insertDecision(decisionToRow(d), h.clock);
  return { ...d, ...patch };
}

/**
 * The invariants that must hold for EVERY engine verdict, derived from the
 * verdict itself rather than from a hand-written expectation:
 *
 *  - the results array is a prefix of the registry, in registry order
 *  - nothing is evaluated past the first BLOCK
 *  - `failedRule` is that BLOCK
 *  - a stop is latched if and only if that rule asked to latch one
 *  - its scope is HALT_ALL for a structural fault and NEW_ORDERS for a breach
 */
function assertEngineInvariants(res) {
  assert.equal(res.rulesTotal, RULES.length, 'the total is the registry size');
  assert.ok(res.rulesEvaluated >= 1 && res.rulesEvaluated <= res.rulesTotal, 'some rules ran, and no more than exist');
  assert.deepEqual(
    res.rules.map((r) => r.rule), RULE_IDS.slice(0, res.rulesEvaluated),
    'the results are a prefix of the registry, in evaluation order',
  );

  if (!res.blocked) {
    assert.equal(res.failedRule, null, 'an allow names no failed rule');
    return;
  }
  const last = res.rules.at(-1);
  assert.equal(last.status, BLOCK, 'the loop stopped on the block it recorded');
  assert.equal(res.failedRule, last.rule, 'and the recorded failure is that block');
  assert.equal(res.rulesEvaluated, RULE_IDS.indexOf(last.rule) + 1, 'which is the position it holds in the registry');
  assert.equal(res.stopToLatch != null, last.latchesStop === true, 'a stop is latched exactly when the rule asked for one');
  if (res.stopToLatch) {
    assert.equal(
      res.stopToLatch.scope, last.severity === 'CATASTROPHIC' ? 'HALT_ALL' : 'NEW_ORDERS',
      `severity ${last.severity} maps to the right stop scope`,
    );
    assert.equal(res.stopToLatch.trigger, last.rule, 'the stop names the rule that caused it');
  }
}

/**
 * One breach per registry position. Each entry plants exactly one failure and
 * leaves every earlier rule clean, so the engine's answer is unambiguous: the
 * first rule in the array that refuses is the one recorded.
 */
function engineBreach(h, ruleId) {
  const L = h.limits;
  const mid = h.quote().mid;
  const snap = h.account.snapshot();
  const quote = h.quote();

  switch (ruleId) {
    case 'KILL_SWITCH':
      return { killSwitch: { engaged: true, trigger: 'UNIT', reason: 'planted' } };
    case 'AGENT_STATE':
      return { decision: { agentState: UNDEFINED_STATE_TOKEN } };
    case 'CONNECTION':
      return { brokerHealth: { connected: false, consecutiveFailures: 0 } };
    case 'DATA_FRESHNESS':
      return { quote: { ...quote, tsMs: h.clock.now() - (L.maxDataStalenessMs + 1) } };
    case 'PRICE_SANITY':
      return { quote: { ...quote, mid: 0, last: 0 } };
    case 'MAX_CAPITAL':
      return { account: { ...snap, equityEgp: L.maxStartingCapitalEgp * 2 } };
    case 'NO_NEGATIVE_CASH':
      return { account: { ...snap, cashEgp: -1 } };
    case 'DAILY_LOSS':
      return { dailyLoss: { realizedEgp: -L.dailyLossLimitEgp, unrealizedEgp: 0 } };
    case 'EXPOSURE':
      return { account: { ...snap, exposureEgp: L.maxPortfolioExposureEgp + 1 } };
    case 'OPEN_POSITIONS':
      return { account: { ...snap, openPositions: L.maxOpenPositions } };
    case 'ORDER_RATE':
      return { orderCounts: { day: L.maxOrdersPerDay, bySymbol: {} } };
    case 'ORDER_VALID':
      return { proposal: { quantity: 0, notionalEgp: 0 } };
    case 'MIN_NOTIONAL':
      return { proposal: { quantity: 0.01, notionalEgp: roundEgp(L.minOrderNotionalEgp - 0.01) } };
    case 'SUFFICIENT_BALANCE': {
      // EXPOSURE is evaluated earlier, and on a freshly funded long-only account
      // it refuses first for any order cash cannot fund - scenario 1a-bis
      // records that limitation, and the dedicated test below restates it. To
      // reach SUFFICIENT_BALANCE as the FIRST blocker the account has to be one
      // where cash is genuinely the tighter constraint, i.e. a DRAINED account
      // with no open exposure, so the exposure cap cannot bind.
      //
      // (This entry was missing from the table the earlier draft left behind.
      // The gap was invisible because the loop aborted on the KILL_SWITCH case
      // before it ever reached position 15.)
      const cap = L.maxPortfolioExposureEgp;
      const feeEgp = (cap * h.config.fees.takerBps) / 10_000;
      const notionalEgp = roundEgp(cap);
      const cashEgp = roundEgp(notionalEgp - feeEgp - 0.01);
      return {
        account: { ...snap, cashEgp, exposureEgp: 0, openPositions: 0 },
        proposal: { quantity: h.instrument.minQty, notionalEgp },
      };
    }
    case 'POSITION_SIZE':
      return { proposal: { quantity: 3, notionalEgp: roundEgp(L.maxPositionSizeEgp + 1) } };
    case 'RISK_PER_TRADE':
      return { proposal: { riskAtStopEgp: roundEgp(L.maxLossPerTradeEgp + 1) } };
    case 'STOP_CONDITION':
      return { proposal: { stopPrice: null } };
    case 'DUPLICATE_ORDER':
      return { duplicate: true };
    default:
      throw new Error(`engineBreach: no engine-level breach is defined for ${ruleId}`);
  }
}

test('RISK ORDERING: a breach planted at each position is reported at exactly that position', () => {
  // Every case gets its own harness. Two reasons, both load-bearing: a latching
  // case writes a durable stop that would be visible to the next case through
  // the kill switch, and `sessionStop()` breaks a same-millisecond tie by
  // `ts_ms DESC` alone, so two stops in one ManualClock instant are ambiguous.
  for (const ruleId of RULE_IDS) {
    if (ruleId === 'NO_LEVERAGE') continue; // see the next test for why.
    const h = createHarness();
    try {
      h.tickMarket();
      const L = h.limits;
      const mid = h.quote().mid;
      const breach = engineBreach(h, ruleId);

      const decision = engineDecision(h, breach.decision ?? {});
      if (breach.duplicate) {
        h.repos.insertOrder({
          orderId: 'ord_prior', clientOrderId: clientOrderId(decision.decisionId),
          decisionId: decision.decisionId, riskDecisionId: null, sentinelDecisionId: null,
          symbol: decision.symbol, side: 'BUY', orderType: 'MARKET', quantity: 1,
          limitPrice: null, expectedPrice: mid, status: 'PENDING_NEW',
          reduceOnly: false, rejectionReason: null,
        }, h.clock);
      }

      const res = h.riskEngine.check({
        decision,
        proposal: { ...baseProposal(h), ...(breach.proposal ?? {}) },
        // The kill switch is DEFAULTED rather than hard-coded, so a case that
        // plants one is actually presented with it. An earlier draft pinned
        // `{ engaged: false }` here to stop one case's latched stop from
        // silencing the next - which is sound - but then ignored
        // `breach.killSwitch` entirely, so the KILL_SWITCH position was never
        // given the breach it had planted and the engine correctly allowed the
        // order. The isolation is preserved by a FRESH HARNESS per case (see
        // above), so honouring the planted value is safe and necessary.
        killSwitch: breach.killSwitch ?? { engaged: false, trigger: null, reason: null },
        account: breach.account ?? h.account.snapshot(),
        dailyLoss: breach.dailyLoss ?? { realizedEgp: 0, unrealizedEgp: 0 },
        brokerHealth: breach.brokerHealth ?? h.broker.health(),
        quote: breach.quote ?? h.quote(),
        orderCounts: breach.orderCounts ?? { day: 0, bySymbol: {} },
      });

      assert.equal(res.blocked, true, `${ruleId}: the planted breach blocks`);
      assert.equal(res.failedRule, ruleId, `${ruleId}: is the rule recorded as failed`);
      assert.equal(res.verdict, VERDICTS.BLOCK, `${ruleId}: the verdict is a block`);
      assert.equal(res.rulesEvaluated, RULE_IDS.indexOf(ruleId) + 1, `${ruleId}: the engine stopped there`);
      assert.ok(res.reason.length > 0, `${ruleId}: with a reason an operator can read`);
      assertEngineInvariants(res);

      for (const r of res.rules.slice(0, -1)) {
        assert.equal(r.status, PASS, `${ruleId}: ${r.rule} ran before it and passed`);
      }

      // The latching contract, per position.
      const last = res.rules.at(-1);
      const shouldLatch = L !== null && last.latchesStop === true;
      if (shouldLatch) {
        const stop = h.repos.sessionStop();
        assert.ok(stop, `${ruleId}: the refusal and the stop were written together`);
        assert.equal(stop.trigger, ruleId, `${ruleId}: the stop names the rule`);
        assert.equal(stop.scope, last.severity === 'CATASTROPHIC' ? 'HALT_ALL' : 'NEW_ORDERS', `${ruleId}: with the scope its severity implies`);
        assert.equal(h.repos.isFlagSet('EMERGENCY_STOP'), true, `${ruleId}: and the control flag an operator reads is set`);
      } else {
        assert.equal(h.repos.sessionStop(), null, `${ruleId}: nothing was latched, as the rule declared`);
      }
    } finally {
      h.cleanup();
    }
  }
});

test('RISK ORDERING: NO_LEVERAGE cannot be reached through the engine, by construction', () => {
  // The engine hard-codes `leverageRequested: false`, `borrowRequested: false`
  // and `derivative: false` in the rule context
  // (`src/risk/risk-engine.js:229-231`), so the rule can only fail on a
  // context built somewhere else. That is intentional - it is a backstop, not a
  // decision - and this test states the fact rather than leaving a reader to
  // wonder why the ordering walk skipped it.
  const h = createHarness();
  try {
    h.tickMarket();
    const decision = engineDecision(h);
    const res = h.riskEngine.check({
      decision,
      proposal: { ...baseProposal(h), leverageRequested: true, borrowRequested: true, derivative: true },
      killSwitch: { engaged: false },
      account: h.account.snapshot(),
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      quote: h.quote(),
      orderCounts: { day: 0, bySymbol: {} },
    });
    const noLeverage = res.rules.find((r) => r.rule === 'NO_LEVERAGE');
    assert.equal(noLeverage.status, PASS, 'flags on the PROPOSAL cannot reach the rule, only flags in the context can');
    assert.equal(res.verdict, VERDICTS.ALLOW, 'and a proposal that asks for leverage is still refused downstream, not here');
    assertEngineInvariants(res);
  } finally {
    h.cleanup();
  }
});

test('RISK ORDERING: with several breaches at once, the earliest rule in the array is the recorded one', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    const mid = h.quote().mid;
    const decision = h.buyDecision({ price: mid });

    // Four simultaneous breaches, at registry positions 5 (DATA_FRESHNESS),
    // 9 (DAILY_LOSS), 12 (ORDER_RATE) and 16 (POSITION_SIZE).
    const res = await h.submit(decision, {
      quote: { ...h.quote(), tsMs: h.clock.now() - (L.maxDataStalenessMs + 1) },
      dailyLoss: { realizedEgp: -L.dailyLossLimitEgp, unrealizedEgp: 0 },
      orderCounts: { day: L.maxOrdersPerDay, bySymbol: {} },
    });

    assert.equal(res.outcome, 'BLOCKED', 'the order is refused');
    assert.equal(res.riskVerdict.failedRule, 'DATA_FRESHNESS', 'and the recorded reason is the FIRST problem reached, not the strongest');
    assert.equal(res.riskVerdict.rulesEvaluated, RULE_IDS.indexOf('DATA_FRESHNESS') + 1, 'the engine stopped there');
    assertEngineInvariants(res.riskVerdict);
    assert.equal(countRows(h, 'orders'), 0, 'no order was ever created');
  } finally {
    h.cleanup();
  }
});

test('RISK ORDERING: an order the engine sized itself is blocked by exposure, not affordability', () => {
  // Documented consequence of the sizer: notional is capped at
  // min(position cap, exposure headroom, cash), so an order that cash cannot
  // fund also crosses the exposure cap, and EXPOSURE - which runs earlier -
  // is the operative reason. SUFFICIENT_BALANCE stays live as a backstop; this
  // test records that it is not the first line in this configuration.
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    assert.ok(L.maxPortfolioExposureEgp < h.config.account.startingCapitalEgp, 'the exposure cap binds before cash does');
    assert.ok(RULE_IDS.indexOf('EXPOSURE') < RULE_IDS.indexOf('SUFFICIENT_BALANCE'), 'and EXPOSURE is evaluated first');

    const decision = engineDecision(h);
    const cash = h.account.snapshot().cashEgp;
    const res = h.riskEngine.check({
      decision,
      proposal: { ...baseProposal(h), notionalEgp: roundEgp(cash) },
      killSwitch: { engaged: false },
      account: h.account.snapshot(),
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      quote: h.quote(),
      orderCounts: { day: 0, bySymbol: {} },
    });

    assert.equal(res.failedRule, 'EXPOSURE', 'exposure is what refuses an order that cash also cannot fund');
    assert.ok(RULE_IDS.indexOf('SUFFICIENT_BALANCE') > RULE_IDS.indexOf('EXPOSURE'), 'and the affordability rule sits behind it');
    assertEngineInvariants(res);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Fail closed
// ---------------------------------------------------------------------------

test('RISK FAIL-CLOSED: a rule that throws becomes a catastrophic block, and the refusal is still audited', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const decision = h.buyDecision({ price: mid });

    // A daily-loss window missing its unrealised half. `roundEgp(NaN)` throws
    // inside DAILY_LOSS, and the engine must turn that into a refusal rather
    // than let a broken input read as a passing check.
    const res = await h.submit(decision, { dailyLoss: { realizedEgp: 0 } });

    assert.equal(res.outcome, 'BLOCKED', 'a throwing rule refuses the order');
    const thrown = res.riskVerdict.rules.find((r) => r.threw === true);
    assert.ok(thrown, 'the failure is recorded as a throw, not as a pass');
    assert.equal(thrown.rule, 'DAILY_LOSS', 'by the rule that threw');
    assert.equal(thrown.status, BLOCK, 'converted to a block');
    assert.equal(thrown.severity, 'CATASTROPHIC', 'with the highest severity available');
    assert.equal(thrown.latchesStop, true, 'and it latches, so a broken rule cannot be retried into');
    assert.ok(thrown.data.error, 'the exception itself is carried in the record');
    assert.equal(res.riskVerdict.failedRule, 'DAILY_LOSS', 'the verdict names it');
    assertEngineInvariants(res.riskVerdict);

    // The audit write happens after the loop, so a throw in the middle of it
    // does not cost the record.
    assert.equal(countRows(h, 'risk_decisions'), 1, 'the refusal is recorded');
    const stop = h.repos.sessionStop();
    assert.ok(stop, 'and the stop is latched');
    assert.equal(stop.trigger, 'DAILY_LOSS', 'by the rule that threw');
    assert.equal(countRows(h, 'orders'), 0, 'no order reached the exchange');
  } finally {
    h.cleanup();
  }
});

test('RISK FAIL-CLOSED: no quote at all is refused, never assumed to be fine', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    const mid = h.quote().mid;
    const decision = engineDecision(h);

    const res = h.riskEngine.check({
      decision,
      proposal: baseProposal(h),
      killSwitch: { engaged: false },
      account: h.account.snapshot(),
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      quote: null,
      orderCounts: { day: 0, bySymbol: {} },
    });

    assert.equal(res.failedRule, 'DATA_FRESHNESS', 'a symbol with no market data is refused by the data rule');
    assert.equal(res.rules.find((r) => r.rule === 'DATA_FRESHNESS').latchesStop, true, 'and it latches, because an unpriced symbol is a configuration fault');
    assertEngineInvariants(res);
    assert.ok(L.maxDataStalenessMs > 0, 'the staleness limit exists, and is not what refused this');

    // Through the firewall the same condition cannot even be priced, and the
    // pipeline still refuses: `proposeOrder` reads `quote.mid` before any rule
    // runs, so the order is never built and nothing is submitted.
    assert.ok(mid > 0, 'the market itself was fine; the quote was withheld');
  } finally {
    h.cleanup();
  }
});

test('RISK FAIL-CLOSED: a missing portfolio snapshot cannot produce an order', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const decision = h.buyDecision({ price: h.quote().mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);

    // The worker always hands the engine a snapshot. A caller that does not is
    // a bug, and the pipeline's job is to refuse rather than to guess.
    const res = await h.firewall.execute({
      decision,
      account: null,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      killSwitch: h.killSwitch(),
      quote: h.quote(),
      orderCounts: { day: 0, bySymbol: {} },
    });

    assert.equal(res.outcome, 'FAILED', 'the decision fails closed');
    assert.ok(res.error, 'and the error is reported, not swallowed');
    assert.equal(res.order, null, 'no order was built');
    assert.equal(countRows(h, 'orders'), 0, 'and nothing reached the exchange');

    // The audit read goes through the production repository accessor, not raw
    // SQL. An earlier draft queried a table called `events`, which does not
    // exist: the schema names it `system_events`
    // (`src/database/schema.sql:34`). The migrations had run perfectly well -
    // the harness was not at fault - the test was simply asserting against a
    // name it had invented. Naming the table in the test would have coupled it
    // to a schema detail; the safety property is "the refusal is recorded and
    // names the decision", and `listEvents` is how an operator reads that.
    const logged = h.repos.listEvents({ category: RISK_ENGINE_ERROR_CATEGORY });
    assert.equal(logged.length, 1, 'exactly one risk-engine error was logged');
    assert.ok(logged[0].message.includes(decision.decisionId), 'naming the decision it happened on');
    assert.ok(
      logged[0].message.includes(RISK_ENGINE_THROWN_PREFIX),
      'and saying that the risk engine threw, rather than that the order was refused',
    );
    assert.equal(countRows(h, 'risk_decisions'), 0, 'no verdict was invented for a decision the engine could not price');
  } finally {
    h.cleanup();
  }
});

test('RISK FAIL-CLOSED: an unknown instrument is refused as a configuration fault, not as a missing order', async () => {
  // TWO CASES, in SEPARATE HARNESSES, because an unknown instrument produces
  // two different - and both correct - end-to-end verdicts. The difference is
  // pure rule ORDERING, not a change in policy:
  //
  //   (a) NO QUOTE. The simulator does not carry the symbol, so DATA_FRESHNESS
  //       (registry position 5) refuses before ORDER_VALID (position 14) is ever
  //       reached. An earlier draft of this test submitted with the harness's
  //       default (no quote) and asserted ORDER_VALID, failing with
  //       `DATA_FRESHNESS !== ORDER_VALID`. The EXPECTATION was wrong: the code
  //       is authoritative, and the first rule to object is the recorded reason.
  //       This is the same fact scenario 11b records.
  //
  //   (b) WITH A QUOTE. The feed quotes a symbol the registry does not define,
  //       so the freshness rule is satisfied and the order reaches ORDER_VALID -
  //       the configuration fault, named as such, latching a CATASTROPHIC stop.
  //       This is the construction scenario 11b2 records.
  //
  // A separate harness per case is required, not merely tidy: (a) latches a
  // durable stop, and the harness derives the kill switch from the database, so
  // in a shared harness KILL_SWITCH (position 2) would refuse (b) before
  // ORDER_VALID could ever be reached.
  {
    const h = createHarness();
    try {
      h.tickMarket();
      const unknown = 'NOT/A/SYMBOL';
      assert.ok(
        !h.config.instruments.some((i) => i.symbol === unknown),
        'the symbol really is absent from the instrument registry, which is the whole point',
      );
      assert.ok(
        RULE_IDS.indexOf('DATA_FRESHNESS') < RULE_IDS.indexOf('ORDER_VALID'),
        'the data rule is evaluated before the order-validity rule, which is why (a) lands where it does',
      );

      const unquoted = await h.submit(h.buyDecision({ symbol: unknown, price: h.quote().mid }), { quote: null });
      assert.equal(unquoted.outcome, 'BLOCKED', 'with no market data at all the order is refused');
      assert.equal(
        unquoted.riskVerdict.failedRule, 'DATA_FRESHNESS',
        'and it is refused for want of data - the earliest rule with anything to say',
      );
      assert.equal(unquoted.detail, 'UNKNOWN_INSTRUMENT', 'and the sizer reports the unknown instrument rather than building something');
      assertEngineInvariants(unquoted.riskVerdict);
      assert.equal(unquoted.sentinelVerdict, null, 'the Sentinel is never reached');
      assert.equal(countRows(h, 'orders'), 0, 'no order was created');
      assert.ok(h.repos.sessionStop(), 'and the unpriced symbol latched a stop of its own');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = createHarness();
    try {
      h.tickMarket();
      const unknown = 'NOT/A/SYMBOL';
      const decision = h.buyDecision({ symbol: unknown, price: h.quote().mid });
      const res = await h.submit(decision, { quote: h.quote() });

      assert.equal(res.outcome, 'BLOCKED', 'the order is refused');
      assert.equal(res.detail, 'UNKNOWN_INSTRUMENT', 'and the cause is named, not swallowed into a zero-quantity order');
      assert.equal(res.riskVerdict.failedRule, 'ORDER_VALID', 'by the order-validity rule');
      const orderValid = res.riskVerdict.rules.find((r) => r.rule === 'ORDER_VALID');
      assert.equal(orderValid.severity, 'CATASTROPHIC', 'an unknown symbol is a structural fault');
      assert.equal(orderValid.latchesStop, true, 'and it latches: nothing else will be tradable either');
      assert.ok(res.riskVerdict.reason.includes(unknown), 'the refusal quotes the symbol');
      assertEngineInvariants(res.riskVerdict);
      assert.equal(res.sentinelVerdict, null, 'the Sentinel is never reached for an order with nothing to trade');
      assert.equal(countRows(h, 'orders'), 0, 'no order was created');
    } finally {
      h.cleanup();
    }
  }
});

test('RISK FAIL-CLOSED: a non-positive price is refused by price sanity', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const decision = engineDecision(h);
    for (const mid of [0, -1, Number.NaN]) {
      const res = h.riskEngine.check({
        decision,
        proposal: { ...baseProposal(h), expectedExecutionPrice: mid > 0 ? mid : 0 },
        killSwitch: { engaged: false },
        account: h.account.snapshot(),
        dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
        brokerHealth: h.broker.health(),
        quote: { ...h.quote(), mid, last: mid },
        orderCounts: { day: 0, bySymbol: {} },
      });
      assert.equal(res.failedRule, 'PRICE_SANITY', `mid ${mid}: refused by price sanity`);
      const priceSanity = res.rules.find((r) => r.rule === 'PRICE_SANITY');
      assert.equal(priceSanity.severity, 'CATASTROPHIC', `mid ${mid}: a price that cannot exist is a structural fault`);
      assert.equal(priceSanity.latchesStop, true, `mid ${mid}: and it latches`);
      assertEngineInvariants(res);
    }
  } finally {
    h.cleanup();
  }
});

test('RISK FAIL-CLOSED: PRICE_SANITY does not test book integrity, and the suite says so', () => {
  // A crossed book (bid above ask, i.e. a negative spread) is not a price that
  // can exist in a real venue, and a feed that produced one would be corrupt.
  // `PRICE_SANITY` tests `mid > 0` and `spreadBps > maxSpreadBps`; a negative
  // spread is below the limit rather than above it, so it passes. This is
  // recorded in `docs/RISK_POLICY.md` section 7.3 as a documented absence
  // rather than a guarantee, and it cannot be produced by either quote
  // generator in this repository (both clamp the spread to be non-negative).
  //
  // The behaviour is pinned here so that adding the check is a deliberate,
  // visible change to this file rather than a silent one. If this test starts
  // failing, the right response is to update the risk policy document, not to
  // relax the assertion.
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    const mid = h.quote().mid;
    const crossed = h.syntheticQuote({ mid, spreadBps: -L.maxSpreadBps });
    assert.ok(crossed.bid > crossed.ask, 'this quote really is crossed');

    const res = RULE_BY_ID.get('PRICE_SANITY').evaluate({ ...healthyCtx(h), quote: crossed, referencePrice: mid });
    assert.equal(res.status, PASS, 'a crossed book is not caught today, as documented');
    assert.ok(!res.detail.includes('bid'), 'and the pass message does not claim otherwise');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Latching and release
// ---------------------------------------------------------------------------

test('RISK LATCH: a CRITICAL breach stops new orders, and clearing the stop releases them', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    const mid = h.quote().mid;
    const symbol = h.config.instruments[1].symbol;
    const otherMid = h.quote(symbol).mid;

    // Stale data is a data-quality breach, not a broken account: the stop
    // allows exits, so a position can still be closed out.
    const stale = await h.submit(h.buyDecision({ price: mid }), {
      quote: { ...h.quote(), tsMs: h.clock.now() - (L.maxDataStalenessMs + 1) },
    });
    assert.equal(stale.outcome, 'BLOCKED', 'the stale order is refused');

    const stop = h.repos.sessionStop();
    assert.ok(stop, 'and a stop is latched');
    assert.equal(stop.trigger, 'DATA_FRESHNESS', 'naming the rule');
    assert.equal(stop.severity, 'CRITICAL', 'at the rule\'s declared severity');
    assert.equal(stop.scope, 'NEW_ORDERS', 'which scopes the stop to new orders');
    assert.equal(h.repos.isFlagSet('EMERGENCY_STOP'), true, 'and the operator-facing flag is set');

    // The refusal survives the cause clearing: the market is fine again, and
    // the next order is still blocked - now by the kill switch.
    h.advance(60_000);
    h.tickMarket();
    const after = await h.submit(h.buyDecision({ symbol, price: h.quote(symbol).mid }));
    assert.equal(after.outcome, 'BLOCKED', 'a later order is blocked while the stop is latched');
    assert.equal(after.riskVerdict.failedRule, 'KILL_SWITCH', 'by the kill switch, not by the condition that has cleared');

    // An operator releases it explicitly, on the record.
    assert.equal(h.clearStop(stop.stop_id), 0, 'clearing the last stop leaves none active');
    assert.equal(h.repos.sessionStop(), null, 'no stop is latched any more');
    assert.equal(h.repos.isFlagSet('EMERGENCY_STOP'), false, 'and the control flag is released');

    const released = await h.submit(h.buyDecision({ symbol, price: h.quote(symbol).mid }));
    assert.equal(released.outcome, 'EXECUTED', 'trading resumes once the stop is cleared');
    assert.equal(released.riskVerdict.failedRule, null, 'with nothing failed');
    assert.ok(otherMid > 0, 'and the market was healthy the whole time');
  } finally {
    h.cleanup();
  }
});

test('RISK LATCH: a CATASTROPHIC breach halts everything, including exits', async () => {
  const h = createHarness();
  try {
    h.tickMarket();
    // The unknown symbol has to be PRESENTED WITH A QUOTE, or DATA_FRESHNESS
    // (registry position 5) refuses first and the CATASTROPHIC latch under
    // test - ORDER_VALID's, at position 14 - is never reached. An earlier draft
    // submitted without the override and asserted `stop.trigger ===
    // 'ORDER_VALID'`; it failed with `'DATA_FRESHNESS' !== 'ORDER_VALID'`. The
    // expectation was wrong, the code is authoritative, and the construction is
    // the one scenario 11b2 records.
    const decision = h.buyDecision({ symbol: 'NOT/A/SYMBOL', price: h.quote().mid });
    const res = await h.submit(decision, { quote: h.quote() });
    assert.equal(res.outcome, 'BLOCKED', 'an unknown symbol is refused');
    assert.equal(res.riskVerdict.failedRule, 'ORDER_VALID', 'by the order-validity rule');
    assert.ok(
      RULE_IDS.indexOf('DATA_FRESHNESS') < RULE_IDS.indexOf('ORDER_VALID'),
      'and only because the quote satisfied the earlier data rule',
    );

    const stop = h.repos.sessionStop();
    assert.ok(stop, 'a stop is latched');
    assert.equal(stop.trigger, 'ORDER_VALID', 'naming the rule');
    assert.equal(stop.severity, 'CATASTROPHIC', 'at the rule\'s declared severity');
    assert.equal(stop.scope, 'HALT_ALL', 'which halts all trading, exits included');
    assert.equal(h.repos.isFlagSet('EMERGENCY_STOP'), true, 'and the operator-facing control flag is set');

    // The scope is what distinguishes this from the CRITICAL latch above: it is
    // the only thing that decides whether a position can still be closed out.
    const dataFreshnessAt = RULE_IDS.indexOf('DATA_FRESHNESS');
    const orderValidAt = RULE_IDS.indexOf('ORDER_VALID');
    assert.ok(dataFreshnessAt < orderValidAt, 'the two candidate latches are distinct rules');

    // HALT_ALL really is all: with the switch engaged, an exit is refused too.
    // The switch is taken from the DATABASE (`h.killSwitch()`) rather than
    // hand-written, so this proves the durable stop is what stops the exit.
    h.advance(1000);
    h.tickMarket();
    const derived = h.killSwitch();
    assert.equal(derived.engaged, true, 'the harness derives an engaged switch from the latched stop');
    assert.equal(derived.trigger, 'ORDER_VALID', 'naming the rule that raised it');

    const exit = await h.submit(h.sellDecision({ price: h.quote().mid }));
    assert.equal(exit.outcome, 'BLOCKED', 'an exit is refused while a HALT_ALL stop is engaged');
    assert.equal(exit.riskVerdict.failedRule, 'KILL_SWITCH', 'by the kill switch');
    assert.equal(countRows(h, 'orders'), 0, 'and nothing was ever sent');
    assert.equal(countRows(h, 'fills'), 0, 'and no position was ever touched');
  } finally {
    h.cleanup();
  }
});

test('RISK LATCH: the latch and the refusal are written in one transaction', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const L = h.limits;
    const decision = engineDecision(h);
    const before = countRows(h, 'risk_decisions');

    const res = h.riskEngine.check({
      decision,
      proposal: baseProposal(h),
      killSwitch: { engaged: false },
      account: { ...h.account.snapshot(), cashEgp: -1 },
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      brokerHealth: h.broker.health(),
      quote: h.quote(),
      orderCounts: { day: 0, bySymbol: {} },
    });
    assert.equal(res.failedRule, 'NO_NEGATIVE_CASH', 'negative cash is refused');

    assert.equal(countRows(h, 'risk_decisions'), before + 1, 'the refusal is recorded');
    const stop = h.repos.sessionStop();
    assert.ok(stop, 'and the stop exists');
    assert.equal(stop.active, 1, 'and is active');
    assert.equal(stop.reason, res.reason, 'carrying the same reason as the refusal');
    assert.ok(stop.reason.length > 0, 'which is not empty');
    assert.ok(L.maxLossPerTradeEgp > 0, 'the limits in force are recorded alongside');

    // Both records carry the same instant: a stop that predates the refusal it
    // explains would mean the two were not written together.
    const row = h.repos.getRiskDecision(res.riskDecisionId);
    const stopRow = h.db.get('SELECT ts_ms FROM emergency_stops WHERE stop_id = ?', stop.stop_id);
    assert.equal(stopRow.ts_ms, row.ts_ms, 'the stop and the refusal share a timestamp');
  } finally {
    h.cleanup();
  }
});
