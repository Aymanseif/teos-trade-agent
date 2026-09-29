/**
 * TEOS Trade Agent - tests/unit-sentinel-rules.test.js
 *
 * Exhaustive unit tests for the Sentinel's 14 rules
 * (`src/execution/sentinel.js`), the `Sentinel` class that composes them, and
 * the guarantees that only exist at the class level: verdict precedence, the
 * action vocabulary, and the fact that the Sentinel can never widen anything
 * the risk engine already refused.
 *
 * WHAT IS AND IS NOT RESTATED HERE
 * ---------------------------------
 * Nothing in this file retypes a production constant:
 *
 *   - rule ids and their order come from `SENTINEL_RULES`
 *   - the verdict and action vocabularies come from `SENTINEL_VERDICTS` and
 *     `SENTINEL_ACTIONS`, cross-checked against the `CHECK` constraints on the
 *     live `sentinel_decisions` table AND against the verdict->action table read
 *     out of `Sentinel#evaluate`'s own source
 *   - every threshold comes from `h.config.sentinel`, and every money limit
 *     from `h.config.risk` - the RAW config objects the Sentinel is actually
 *     handed (`limits: this.#config.risk`, `thresholds: this.#config.sentinel`).
 *     Using `h.limits` here would assert against a different object than the
 *     rules read
 *   - the mode whitelist, the "unknown trigger" wording, the risk-verdict token
 *     the Sentinel promotes, the decision-rate window, the manual-hold flag
 *     name, the review-pending flag, the event category and the fail-closed
 *     message prefix are all literals inside unexported code, so they are read
 *     out of the source rather than typed
 *   - the verdicts each rule can return, and the context fields `evaluate`
 *     derives for itself rather than taking from its caller, are likewise read
 *     out of the source. The first holds each branch table to covering every
 *     branch the rule really has; the second decides, per rule, whether its
 *     recorded prose can be compared word for word with a direct call at all
 *
 * The declared-and-cross-checked tokens are the Sentinel's `HOLD` signal and
 * its `BUY`/`SELL` sides. Those are the same kind of pin the risk-rule file
 * uses for the undefined agent state: read out of the rules' own source, then
 * asserted to be members of the production `SIGNALS` table, so the suite fails
 * if either moves instead of silently testing the old one.
 *
 * STRUCTURE
 * ---------
 *   1. registry integrity
 *   2. a healthy context on which all 14 rules are quiet (the control that
 *      makes every "this rule fires" assertion mean something)
 *   3. one test per rule: quiet on the control, then its own branches, each
 *      quoting the ACTUAL imported threshold
 *   4. fail-closed behaviour
 *   5. precedence: BLOCK > REVIEW > WARN > ALLOW, and the four action strings
 *   6. the Sentinel cannot widen a risk BLOCK (BLOCK, WARN and REVIEW inputs,
 *      asserted separately)
 *   7. operator control: the manual hold, through the real control_flags table
 *   8. idempotency: the duplicate-order check, through the real orders table
 *   9. the decision-rate window, through real rows in the real table
 *  10. mode isolation, and the fact that LIVE is not a mode this build has
 *  11. a quarantine is recorded for a human and does not latch
 *
 * SIMULATION ONLY. Paper account, in-process simulator, no real money, no real
 * venue, no leverage. LIVE MODE IS NOT IMPLEMENTED in this build - this file
 * asserts that, rather than working around it. Nothing here is a claim about
 * live trading, real-market execution, profitability, or production readiness.
 */

import { test } from 'node:test';
import {
  createHarness, assert, roundEgp, roundTo, countRows,
} from './helpers/harness.js';
import {
  SENTINEL_RULES, SENTINEL_VERDICTS, SENTINEL_ACTIONS, POLICY_VERSION, Sentinel,
} from '../src/execution/sentinel.js';
import { ExecutionFirewall, OUTCOMES } from '../src/execution/firewall.js';
import { VERDICTS } from '../src/risk/risk-engine.js';
import { decisionToRow } from '../src/agent/decision.js';
import { SIGNALS } from '../src/agent/strategies/strategy.interface.js';
import { clientOrderId, newId } from '../src/core/ids.js';

// ---------------------------------------------------------------------------
// Vocabulary, derived from the module itself
// ---------------------------------------------------------------------------

const [ALLOW, WARN, REVIEW, BLOCK] = SENTINEL_VERDICTS;
const [EXECUTED] = OUTCOMES;

/** ALLOW(0) < WARN(1) < REVIEW(2) < BLOCK(3). */
const rankOf = (v) => SENTINEL_VERDICTS.indexOf(v);

const RULE_IDS = SENTINEL_RULES.map((r) => r.id);
const RULE_BY_ID = new Map(SENTINEL_RULES.map((r) => [r.id, r]));
const ruleSource = (id) => RULE_BY_ID.get(id).evaluate.toString();
const EVALUATE_SRC = Sentinel.prototype.evaluate.toString();

/** The decision id the hand-built healthy context carries. A test label. */
const DEFAULT_DECISION_ID = 'UNIT-SENTINEL-DECISION';
const DEFAULT_CLIENT_ORDER_ID = clientOrderId(DEFAULT_DECISION_ID);

/**
 * The verdict -> action table, read out of `Sentinel#evaluate`'s own source.
 *
 * It is a literal object in the method body and is not exported, while
 * `SENTINEL_ACTIONS` separately declares the vocabulary it draws from. A test
 * that typed the four actions would be asserting its own list against itself;
 * reading the map out of the implementation and then comparing it with the
 * exported vocabulary and with the database's CHECK constraint checks the
 * implementation against two INDEPENDENT declarations of the same policy.
 */
const ACTION_BY_VERDICT = (() => {
  const found = EVALUATE_SRC.match(
    /\{\s*ALLOW: '([A-Z_]+)',\s*WARN: '([A-Z_]+)',\s*REVIEW: '([A-Z_]+)',\s*BLOCK: '([A-Z_]+)'/,
  );
  assert.ok(found, 'the Sentinel still maps each verdict to an action in a literal table');
  const table = {};
  SENTINEL_VERDICTS.forEach((v, i) => { table[v] = found[i + 1]; });
  assert.equal(
    new Set(Object.values(table)).size, SENTINEL_VERDICTS.length,
    'each verdict maps to a DISTINCT action - otherwise the audit trail could not tell them apart',
  );
  return Object.freeze(table);
})();

/** The modes MODE_GUARD will let through, read out of the rule's own source. */
const ALLOWED_MODES = (() => {
  const found = ruleSource('MODE_GUARD').match(
    /!\[\s*'([A-Z_]+)'\s*,\s*'([A-Z_]+)'\s*\]\.includes\(mode\)/,
  );
  assert.ok(found, 'MODE_GUARD still whitelists its modes with an inline literal array');
  return Object.freeze([found[1], found[2]]);
})();

/** The one mode the rule rejects by name, before the whitelist check. */
const LIVE_MODE = (() => {
  const found = ruleSource('MODE_GUARD').match(/mode === '([A-Z_]+)'/);
  assert.ok(found, 'MODE_GUARD still rejects a named mode by literal comparison');
  assert.ok(!ALLOWED_MODES.includes(found[1]), 'and that mode is not also whitelisted');
  return found[1];
})();

/** A mode token that is neither whitelisted nor the specially-named one. */
const UNKNOWN_MODE = (() => {
  const candidates = ['DRY_RUN', 'SHADOW', 'PAPER_LIVE', 'SIMULATED', 'PRODUCTION', 'LIVE_TRADING'];
  const found = candidates.find((m) => !ALLOWED_MODES.includes(m) && m !== LIVE_MODE);
  assert.ok(found, 'a mode token outside the whitelist exists to exercise the unrecognised branch');
  return found;
})();

/** The standing "(unknown)" wording KILL_SWITCH uses for a trigger-less stop. */
const UNKNOWN_TRIGGER = (() => {
  const found = ruleSource('KILL_SWITCH').match(/killSwitch\.trigger \?\? '([a-z]+)'/);
  assert.ok(found, 'KILL_SWITCH still has a standing wording for a stop with no trigger');
  return found[1];
})();

/**
 * The single risk-verdict token RISK_VERDICT promotes to a Sentinel WARN.
 *
 * Read out of the rule rather than assumed, because the rule's contract is
 * "recognise exactly one non-blocking risk outcome". If that token were changed
 * the "a risk warning is never escalated" assertions below would be meaningless,
 * so the derivation is cross-checked against the risk engine's own vocabulary.
 */
const RISK_PROMOTED_VERDICT = (() => {
  const found = ruleSource('RISK_VERDICT').match(/riskVerdict\?\.verdict === '([A-Z]+)'/);
  assert.ok(found, 'RISK_VERDICT still tests the risk verdict against a single literal');
  assert.ok(
    Object.values(VERDICTS).includes(found[1]),
    'and that literal is a verdict the risk engine actually declares',
  );
  assert.notEqual(
    found[1], VERDICTS.BLOCK,
    'a blocked risk verdict is handled by the `blocked` flag, not by the verdict string',
  );
  return found[1];
})();

/**
 * The decision-rate window: the span `evaluate` counts over, and the span it
 * reports to the operator. Derived separately from each site and then required
 * to agree - if they ever diverged, the "N decisions in 60000ms" message would
 * be quoting a window that was not the one applied.
 */
const COUNTED_WINDOW_MS = (() => {
  const found = EVALUATE_SRC.match(/countRecentDecisions\(nowMs - ([\d_]+)\)/);
  assert.ok(found, 'the Sentinel still counts decisions over a literal window');
  return Number(found[1].replace(/_/g, ''));
})();
const REPORTED_WINDOW_MS = (() => {
  const found = EVALUATE_SRC.match(/windowMs: ([\d_]+)/);
  assert.ok(found, 'the Sentinel still reports a literal window to the operator');
  return Number(found[1].replace(/_/g, ''));
})();

/** The control flag the operator hold is stored under, read from the source. */
const MANUAL_HOLD_FLAG = (() => {
  const found = EVALUATE_SRC.match(/isFlagSet\('([A-Z_]+)'\)/);
  assert.ok(found, 'the Sentinel still derives its manual hold from a named control flag');
  return found[1];
})();

/** The control flag a quarantined decision is filed under, from the source. */
const REVIEW_PENDING_FLAG = (() => {
  const found = EVALUATE_SRC.match(/setFlag\('([A-Z_]+)'/);
  assert.ok(found, 'the Sentinel still files a quarantined decision under a named control flag');
  return found[1];
})();

/** The `system_events` category a Sentinel refusal is logged under. */
const SENTINEL_EVENT_CATEGORY = (() => {
  const found = EVALUATE_SRC.match(/category: '([a-z_]+)'/);
  assert.ok(found, 'the Sentinel still logs under a literal event category');
  return found[1];
})();

/** The prefix the fail-closed handler puts in front of a rule's exception. */
const RULE_THREW_PREFIX = (() => {
  const found = EVALUATE_SRC.match(/detail: `([^`]*\$\{err\.message\}[^`]*)`/);
  assert.ok(found, 'the Sentinel still wraps a rule exception in a literal message prefix');
  return found[1].split('${err.message}')[0];
})();

/**
 * The second fail-closed guard: a rule that returns a verdict outside the
 * vocabulary is refused rather than trusted. It cannot be driven from a test
 * without appending to the production rule array - which would mutate module
 * state for every later test in the file - so it is pinned structurally, and
 * labelled as such rather than dressed up as a behavioural test. The first
 * guard (a rule that throws) is exercised for real, in `SENTINEL FAILS CLOSED`.
 */
const INVALID_VERDICT_GUARD_PRESENT = /SENTINEL_VERDICTS\.includes\(r\.verdict\)/.test(EVALUATE_SRC);

/**
 * Every verdict a rule's OWN source can return.
 *
 * Read out of the rule rather than declared in the test, so the branch table can
 * be held to covering every branch the implementation actually has. That
 * includes the rules that can only warn (WIDE_STOP) or only quarantine
 * (LOW_CONFIDENCE, UNUSUAL_SIZE, DECISION_RATE) - a rule that can never refuse
 * outright is a real property of this policy, and asserting that all fourteen
 * rules can block would be asserting something the Sentinel does not do.
 */
const ruleVerdictsIn = (id) => new Set([...ruleSource(id).matchAll(/verdict: '([A-Z]+)'/g)].map((m) => m[1]));

/** The context fields a rule reads, read out of its own parameter list. */
function ruleCtxKeys(id) {
  const found = ruleSource(id).match(/evaluate\(\{([^}]*)\}\)/);
  assert.ok(found, `${id} still destructures the fields it reads`);
  return found[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The context fields `evaluate` DERIVES for itself.
 *
 * It takes its arguments from the caller, then fills in the rest: the manual
 * hold, the duplicate lookup, the two prices, the client order id, the
 * decision-rate count and window, and the two config blocks. The config blocks
 * are excluded because a direct call reads the very same objects. Everything
 * else here a direct call cannot be handed, so a rule that reads one of these is
 * not given the same context by a direct call as by the class - and its prose is
 * therefore not comparable word for word between the two.
 *
 * Derived from the source so it moves with the implementation rather than being
 * a list this file has to remember to update.
 */
const DERIVED_CTX_KEYS = (() => {
  const args = EVALUATE_SRC.match(/evaluate\(\{([^}]*)\}\)/);
  assert.ok(args, 'the Sentinel still takes a destructured context it can read');
  const supplied = new Set(args[1].split(',').map((s) => s.trim()).filter(Boolean));

  const built = EVALUATE_SRC.match(/const ctx = \{([\s\S]*?)\n {4}\};/);
  assert.ok(built, 'the Sentinel still assembles its context in one place');
  const keys = [...built[1].matchAll(/^\s*(\w+)[,:]/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'and the assembled context is not empty');

  const fromConfig = new Set([...EVALUATE_SRC.matchAll(/(\w+): this\.#config\./g)].map((m) => m[1]));
  return new Set(keys.filter((k) => !supplied.has(k) && !fromConfig.has(k)));
})();

/** True when nothing a rule reads is one `evaluate` derives for itself. */
const ruleIsCallerSupplied = (id) => !ruleCtxKeys(id).some((k) => DERIVED_CTX_KEYS.has(k));

/** The signal a HOLD decision carries, read out of LOW_CONFIDENCE's source. */
const HOLD_SIGNAL = (() => {
  const found = ruleSource('LOW_CONFIDENCE').match(/decision\.signal === '([A-Z]+)'/);
  assert.ok(found, 'LOW_CONFIDENCE still exempts a signal by literal comparison');
  assert.ok(SIGNALS.includes(found[1]), 'and that literal is a real signal');
  return found[1];
})();

/** The two order sides, each read out of the rule that branches on them. */
const BUY_SIDE = (() => {
  const found = ruleSource('UNUSUAL_SIZE').match(/proposal\.side !== '(\w+)'/);
  assert.ok(found, 'UNUSUAL_SIZE still distinguishes the entry side by literal');
  return found[1];
})();
const SELL_SIDE = (() => {
  const found = ruleSource('SHORT_GUARD').match(/proposal\.side !== '(\w+)'/);
  assert.ok(found, 'SHORT_GUARD still distinguishes the exit side by literal');
  return found[1];
})();

/** The decision id a patch ends up with, so the derived ids stay consistent. */
function decisionIdFor(patchDecision) {
  return patchDecision?.decisionId ?? DEFAULT_DECISION_ID;
}

/**
 * The CHECK-enumerated vocabulary of a column, read out of the LIVE schema.
 *
 * The database is the last authority on what may be written: a Sentinel
 * verdict outside the constraint would not be a softer policy, it would be an
 * insert that rolls back and takes the whole audit write with it.
 */
function checkEnum(h, table, column) {
  const ddl = h.db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).sql;
  // `IN\s*\(` rather than `IN \(`: the schema wraps a long enum onto the next
  // line, and a single-space match would silently find nothing.
  const found = ddl.match(new RegExp(`${column}\\s+TEXT[^,]*?IN\\s*\\(([^)]*)\\)`));
  assert.ok(found, `${table}.${column} is CHECK-enumerated in the live schema`);
  const values = [...found[1].matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.ok(values.length > 0, `${table}.${column} declares at least one value`);
  return values;
}

// ---------------------------------------------------------------------------
// The context a Sentinel rule actually sees
// ---------------------------------------------------------------------------

/**
 * A context on which all 14 rules are quiet.
 *
 * This is the shape `Sentinel#evaluate` builds (`src/execution/sentinel.js`),
 * written out in full so a single rule can be driven in isolation. Every value
 * comes from the live config and the live account rather than being chosen
 * first, so the control stays valid if `config/default.json` is edited.
 *
 * There is exactly ONE factory and `patch` is its only entry point. `decision`
 * and `proposal` merge one level deep, because most rules read a single field
 * off one of them and a whole-object replacement would hide which input the
 * case is actually about.
 */
function sentinelCtx(h, patch = {}) {
  const mid = h.quote().mid;
  const snap = h.account.snapshot();
  const stopDistance = h.config.risk.defaultStopDistancePct;
  const stopPrice = roundTo(mid * (1 - stopDistance / 100), 8);
  const { decision, proposal, ...rest } = patch;
  const decisionId = decisionIdFor(decision);

  const base = {
    mode: h.mode,
    decision: {
      decisionId,
      symbol: h.instrument.symbol,
      signal: BUY_SIDE,
      confidence: 0.8,
      marketPrice: mid,
      stopPrice,
      stopCondition: `Stop at ${stopPrice}`,
    },
    proposal: {
      side: BUY_SIDE,
      quantity: 1,
      notionalEgp: cleanNotionalEgp(h),
      stopPrice,
      reduceOnly: false,
      expectedExecutionPrice: mid,
    },
    riskVerdict: cleanRiskVerdict(decisionId),
    account: snap,
    accountRef: h.account,
    dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
    killSwitch: h.killSwitch(),
    quote: h.syntheticQuote({ mid, tsMs: h.clock.now() }),
    manualHold: false,
    // The RAW config objects, exactly as `evaluate` hands them. The Sentinel
    // reads `config.risk` directly and never builds a `RiskLimits`.
    limits: h.config.risk,
    thresholds: h.config.sentinel,
    decisionPrice: mid,
    currentPrice: mid,
    clientOrderId: clientOrderId(decisionId),
    existingOrder: null,
    recentDecisionCount: 0,
    windowMs: REPORTED_WINDOW_MS,
  };

  return {
    ...base,
    ...rest,
    decision: { ...base.decision, ...(decision ?? {}) },
    proposal: { ...base.proposal, ...(proposal ?? {}) },
  };
}

/**
 * A risk verdict with nothing wrong with it.
 *
 * `blocked: false` and no promoted verdict is what RISK_VERDICT reads as
 * "allowed". `clientOrderId` is present because the real engine always carries
 * one and the Sentinel derives the duplicate-order check from it.
 */
function cleanRiskVerdict(decisionId = DEFAULT_DECISION_ID) {
  return {
    riskDecisionId: 'UNIT-SENTINEL-RISK',
    decisionId,
    blocked: false,
    failedRule: null,
    reason: null,
    verdict: VERDICTS.ALLOW,
    rules: [],
    clientOrderId: clientOrderId(decisionId),
  };
}

/**
 * A notional that is deliberately ORDINARY: half of the tightest size band the
 * Sentinel has. Anything larger and the healthy control would trip UNUSUAL_SIZE
 * or EXPOSURE_PRESSURE, and the per-rule tests would be measuring the wrong
 * rule. Derived from the live thresholds and the live equity, so it cannot drift
 * under a config edit.
 */
function cleanNotionalEgp(h) {
  const { equityEgp } = h.account.snapshot();
  const t = h.config.sentinel;
  const tightest = Math.min(
    t.unusualSizeReviewEgp,
    (equityEgp * t.unusualSizeReviewPctOfEquity) / 100,
    (h.config.risk.maxPortfolioExposureEgp * t.exposureWarnPctOfLimit) / 100,
  );
  return roundEgp(tightest / 2);
}

/**
 * A notional that trips UNUSUAL_SIZE and NOTHING ELSE.
 *
 * The obvious "make it big" oversize (`2x` the absolute band) also drives the
 * projection past the portfolio cap, so EXPOSURE_PRESSURE blocks it and the
 * case silently becomes a test of the wrong rule. A QUARANTINE has to be
 * provoked in isolation to mean anything, so this sits just over the percentage
 * band - the smallest oversize that is unambiguously a quarantine - and then
 * asserts for itself that the exposure projection stays under the warning band.
 */
function oversizeNotionalEgp(h) {
  const { equityEgp, exposureEgp } = h.account.snapshot();
  const t = h.config.sentinel;
  const notional = roundEgp((equityEgp * t.unusualSizeReviewPctOfEquity) / 100) + 0.01;
  assert.ok(
    (notional / equityEgp) * 100 > t.unusualSizeReviewPctOfEquity,
    `the oversize notional is really over the ${t.unusualSizeReviewPctOfEquity}% size-review band`,
  );
  assert.ok(
    ((exposureEgp + notional) / h.config.risk.maxPortfolioExposureEgp) * 100 < t.exposureWarnPctOfLimit,
    'and its exposure projection stays under the exposure-warning band, so it quarantines rather than blocks',
  );
  return notional;
}

/** A price sitting `bps` basis points away from the decision price. */
function driftedPrice(from, bps) {
  return from * (1 + bps / 10_000);
}

/** The drift a rule would actually measure, so the message tokens are exact. */
function actualDriftBps(from, to) {
  return Math.abs((to - from) / from) * 10_000;
}

/**
 * A REAL proposal from the risk engine, small enough that the size rules stay
 * quiet on it.
 *
 * The integration tests drive the real `Sentinel#evaluate`, which only means
 * something if its `proposal` input is the one production actually produces.
 * The size is reached by asking the strategy for less risk - `riskPctPerTrade`
 * is a strategy PARAMETER, not a threshold - and the result is then checked
 * against the bands it has to stay under, so a config edit that made the real
 * sizing cross a review threshold fails here loudly instead of quietly turning
 * every later test into a test of UNUSUAL_SIZE.
 */
function quietProposal(h) {
  const mid = h.quote().mid;
  const snap = h.account.snapshot();
  const stopPct = h.config.risk.defaultStopDistancePct;
  // qty = budget / (price - stop) and budget = equity * pct / 100, so asking for
  // `cleanNotional * stopPct / equity` percent lands the notional on the target,
  // up to the instrument's quantity step.
  const riskPctPerTrade = roundTo((cleanNotionalEgp(h) * stopPct) / snap.equityEgp, 6);
  const decision = h.buyDecision({ price: mid, riskPctPerTrade });
  const proposal = h.riskEngine.proposeOrder({
    decision, account: h.account, quote: h.quote(), instrument: h.instrument,
  });

  assert.ok(proposal.quantity > 0, 'the quiet proposal has a quantity to trade');
  const t = h.config.sentinel;
  const pctOfEquity = (proposal.notionalEgp / snap.equityEgp) * 100;
  assert.ok(
    pctOfEquity < t.unusualSizeReviewPctOfEquity,
    `the real proposal (EGP ${roundEgp(proposal.notionalEgp)}, ${roundTo(pctOfEquity, 2)}% of equity) stays under the ${t.unusualSizeReviewPctOfEquity}% size-review band`,
  );
  assert.ok(
    proposal.notionalEgp < t.unusualSizeReviewEgp,
    `and under the EGP ${t.unusualSizeReviewEgp} absolute band`,
  );
  assert.ok(
    (proposal.notionalEgp / h.config.risk.maxPortfolioExposureEgp) * 100 < t.exposureWarnPctOfLimit,
    `and projects under the ${t.exposureWarnPctOfLimit}% exposure-warning band`,
  );
  return { decision, proposal };
}

/**
 * Run the REAL `Sentinel#evaluate`.
 *
 * The decision is persisted first because `sentinel_decisions.decision_id`
 * references `agent_decisions`, and the write and the refusal happen in one
 * transaction - a decision that was never stored could not be judged. The
 * patch merges one level into `decision` and `proposal` on top of the real
 * proposal, so a case only has to name the field it is about.
 *
 * Key presence, not `??`, for the nullable inputs: "there is no account object
 * at all" is a condition the Sentinel must survive, and `null ?? snapshot`
 * would replace it and make the case assert nothing.
 */
function runSentinel(h, patch = {}) {
  const built = quietProposal(h);
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  const { decision, proposal, riskVerdict, setup, persist = true } = patch;

  const d = decision ? { ...built.decision, ...decision } : built.decision;
  const p = { ...built.proposal, ...(proposal ?? {}) };

  if (persist && !h.db.get('SELECT decision_id FROM agent_decisions WHERE decision_id = ?', d.decisionId)) {
    h.repos.insertDecision(decisionToRow(d), h.clock);
  }
  if (setup) setup(d);

  const risk = has('riskVerdict')
    ? { ...riskVerdict, clientOrderId: riskVerdict?.clientOrderId ?? clientOrderId(d.decisionId) }
    : cleanRiskVerdict(d.decisionId);

  const out = h.sentinel.evaluate({
    decision: d,
    proposal: p,
    riskVerdict: risk,
    account: has('account') ? patch.account : h.account.snapshot(),
    accountRef: has('accountRef') ? patch.accountRef : h.account,
    dailyLoss: has('dailyLoss') ? patch.dailyLoss : { realizedEgp: 0, unrealizedEgp: 0 },
    killSwitch: has('killSwitch') ? patch.killSwitch : h.killSwitch(),
    quote: has('quote') ? patch.quote : h.quote(),
    mode: has('mode') ? patch.mode : h.mode,
  });
  return { out, decision: d, proposal: p };
}

/** The persisted row for a Sentinel run, read back from the audit table. */
function persistedSentinelRow(h, sentinelDecisionId) {
  const row = h.db.get('SELECT * FROM sentinel_decisions WHERE sentinel_decision_id = ?', sentinelDecisionId);
  assert.ok(row, `the verdict ${sentinelDecisionId} was persisted`);
  return row;
}

/** The recorded result of one named rule inside a Sentinel run. */
function ruleResult(out, id) {
  const found = (out.rules ?? []).find((r) => r.rule === id);
  assert.ok(found, `${id} is present in the recorded rule results`);
  return found;
}

/**
 * A rule result's `data` is optional: several rules return a bare
 * `{ verdict, detail }` when they have nothing to report. The requirement is
 * that it is never anything else - a number or a string where a record is
 * expected would be a real defect.
 */
function assertDataShape(res, where) {
  assert.ok(
    res.data === undefined || (typeof res.data === 'object' && res.data !== null),
    `${where}: data is a record or absent (got ${typeof res.data})`,
  );
}

// ---------------------------------------------------------------------------
// 1. Registry integrity
// ---------------------------------------------------------------------------

test('SENTINEL REGISTRY: the rule list is well formed, ordered, and self-consistent', () => {
  const h = createHarness();
  try {
    assert.ok(RULE_IDS.length > 0, 'the registry is not empty');
    assert.equal(new Set(RULE_IDS).size, RULE_IDS.length, 'no rule id is listed twice');
    assert.equal(RULE_BY_ID.size, RULE_IDS.length, 'the by-id index covers the whole registry');

    for (const rule of SENTINEL_RULES) {
      assert.equal(typeof rule.id, 'string', `${rule.id}: id is a string`);
      assert.ok(rule.id.length > 0, `${rule.id}: id is not empty`);
      assert.ok(rule.description && rule.description.length > 0, `${rule.id}: carries a description`);
      assert.equal(typeof rule.evaluate, 'function', `${rule.id}: is callable`);
    }

    // The declared order is the documented one: absolute prohibitions, then
    // idempotency and operator control, then market and account conditions,
    // then the order-shape checks. Only the relationships that carry a safety
    // argument are pinned, not the whole sequence.
    assert.equal(RULE_IDS[0], 'MODE_GUARD', 'the mode guard runs first: in a mode that cannot trade, nothing else matters');
    assert.equal(RULE_IDS[1], 'KILL_SWITCH', 'an engaged stop is second, ahead of every market consideration');
    assert.ok(
      RULE_IDS.indexOf('RISK_VERDICT') < RULE_IDS.indexOf('DUPLICATE_ORDER'),
      'a risk block is read before the duplicate check, so a refusal is never re-derived as a duplicate',
    );
    assert.ok(
      RULE_IDS.indexOf('MANUAL_HOLD') < RULE_IDS.indexOf('PRICE_DRIFT'),
      'the operator hold is honoured before any market judgement is made about the order',
    );

    // `describeRules` is the table the CLI and dashboard print, so it must be
    // the registry, in order, 1-indexed.
    const described = Sentinel.describeRules();
    assert.equal(described.length, RULE_IDS.length, 'describeRules covers every rule');
    assert.deepEqual(described.map((r) => r.id), RULE_IDS, 'and lists them in evaluation order');
    assert.deepEqual(described.map((r) => r.order), RULE_IDS.map((_, i) => i + 1), 'with a 1-based order column');
    assert.deepEqual(
      described.map((r) => r.description), SENTINEL_RULES.map((r) => r.description),
      'and the descriptions the registry carries',
    );

    assert.ok(INVALID_VERDICT_GUARD_PRESENT, 'the Sentinel still refuses a verdict outside its own vocabulary');
    assert.equal(REPORTED_WINDOW_MS, COUNTED_WINDOW_MS, 'the counted window and the reported window are the same window');
    assert.notEqual(BUY_SIDE, SELL_SIDE, 'the two sides the rules branch on are different');
    assert.ok(SIGNALS.includes(BUY_SIDE) && SIGNALS.includes(SELL_SIDE), 'and both are real signals');
  } finally {
    h.cleanup();
  }
});

test('SENTINEL VOCABULARY: the action table, the exported list and the database agree', () => {
  const h = createHarness();
  try {
    const schemaActions = checkEnum(h, 'sentinel_decisions', 'action_taken');
    const schemaVerdicts = checkEnum(h, 'sentinel_decisions', 'verdict');

    assert.deepEqual(schemaVerdicts, [...SENTINEL_VERDICTS], 'the verdict CHECK enumerates the exported verdicts, in precedence order');
    assert.deepEqual(
      [...SENTINEL_ACTIONS].sort(), [...schemaActions].sort(),
      'the exported action list is exactly what the database will accept',
    );
    assert.deepEqual(
      [...SENTINEL_ACTIONS].sort(), [...Object.values(ACTION_BY_VERDICT)].sort(),
      'and exactly what the implementation can produce - every action is reachable and none is dead',
    );
    assert.equal(
      Object.values(ACTION_BY_VERDICT).length, SENTINEL_VERDICTS.length,
      'one action per verdict, and no more',
    );
    assert.ok(POLICY_VERSION.length > 0, 'the policy version is not empty - it is written onto every verdict');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. The healthy control
// ---------------------------------------------------------------------------

test('SENTINEL CONTROL: a healthy context leaves all 14 rules ALLOW, in order, with a reason', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const ctx = sentinelCtx(h);

    const results = SENTINEL_RULES.map((rule) => rule.evaluate(ctx));

    assert.equal(results.length, SENTINEL_RULES.length, 'every rule in the registry was evaluated');
    for (const [i, r] of results.entries()) {
      const where = RULE_IDS[i];
      assert.equal(r.verdict, ALLOW, `${where} is quiet on a healthy context (got ${r.verdict}: ${r.detail})`);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, `${where} says why it is quiet`);
      assertDataShape(r, where);
    }

    // The same thing through the real class, which is what production calls and
    // which is the only thing that proves each rule is attributed to its own
    // id and description.
    const { out, decision } = runSentinel(h, {});
    assert.equal(out.verdict, ALLOW, 'the composed verdict is an allow');
    assert.equal(out.actionTaken, ACTION_BY_VERDICT[ALLOW], 'with the passing action');
    assert.equal(out.policyVersion, POLICY_VERSION, 'stamped with the policy version in force');
    assert.deepEqual(out.thresholds, h.config.sentinel, 'and the thresholds it actually used');
    assert.equal(out.decisionId, decision.decisionId, 'attributed to the decision that was judged');

    // `triggerRule` is the first result at the winning rank, and an ALLOW is a
    // rank like any other - so an allow is attributed to the FIRST rule in the
    // registry rather than to nothing. That is what the class does; it is
    // pinned here so a future change to the "nothing objected" case is a
    // deliberate one, and so nothing in this file quietly relies on a null.
    assert.equal(out.triggerRule, RULE_IDS[0], 'an allow is attributed to the first rule at the winning rank');
    assert.equal(out.reason, ruleResult(out, RULE_IDS[0]).detail, 'and the reason is that rule\'s own wording');

    assert.deepEqual(
      out.rules.map((r) => r.rule), RULE_IDS,
      'each recorded result names the rule that produced it, in evaluation order',
    );
    for (const r of out.rules) {
      assert.equal(r.description, RULE_BY_ID.get(r.rule).description, `${r.rule} carries the registry description`);
      assert.equal(r.verdict, ALLOW, `${r.rule} is quiet end to end (got ${r.verdict}: ${r.detail})`);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, `${r.rule} says why`);
    }

    const row = persistedSentinelRow(h, out.sentinelDecisionId);
    assert.equal(row.verdict, ALLOW, 'and the allow is persisted');
    assert.equal(row.action_taken, ACTION_BY_VERDICT[ALLOW], 'with the action the database will accept');
    assert.equal(row.trigger_rule, out.triggerRule, 'and the rule it was attributed to');
    assert.equal(row.decision_id, decision.decisionId, 'against the decision that produced it');
    assert.equal(countRows(h, 'sentinel_decisions'), 1, 'written exactly once');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Per-rule branch tables
// ---------------------------------------------------------------------------

/**
 * Every branch of every rule, with the inputs that reach it and the outcome the
 * policy requires.
 *
 * `patch` is applied to the healthy context. `expect.mentions` are tokens the
 * operator-facing `detail` must contain - each derived from
 * `h.config.sentinel` / `h.config.risk` or computed from the very input that
 * was injected, never typed from memory, so the message cannot silently quote a
 * stale number. `expect.data` is asserted key by key: the facts a rule measured
 * have to survive into the audit record even when the prose does not repeat
 * them.
 */
function branchCases(h) {
  const T = h.config.sentinel;
  const L = h.config.risk;
  const mid = h.quote().mid;
  const snap = h.account.snapshot();
  const notional = cleanNotionalEgp(h);
  const otherSymbol = h.config.instruments[1].symbol;

  // A proposal/decision that trips one chosen rule and nothing else, kept as
  // named builders so a case reads as "this rule's breach", not as a wall of
  // numbers.
  const wideStopPct = T.wideStopWarnPct + 0.5;
  const oversizeNotional = roundEgp(T.unusualSizeReviewEgp * 2);
  const strippedDecision = { stopCondition: null, stopPrice: null };
  const sellProposal = { side: SELL_SIDE, reduceOnly: true, stopPrice: null };

  const orderStatus = checkEnum(h, 'orders', 'status')[0];
  const dupOrder = { order_id: 'ord_unit_sentinel', status: orderStatus };

  const reviewDriftBps = T.priceDriftReviewBps + 5;
  const warnDriftBps = T.priceDriftReviewBps * 0.5 + 5;
  const driftToken = (bps) => `${roundTo(actualDriftBps(mid, driftedPrice(mid, bps)), 1)}bps`;

  const lossLimit = L.dailyLossLimitEgp;
  const warnLoss = roundEgp(lossLimit * (T.dailyLossWarnPctOfLimit / 100));
  const underWarnLoss = roundEgp(warnLoss - 0.01);

  const cap = L.maxPortfolioExposureEgp;
  const exposurePct = (v) => (v / cap) * 100;
  const warnBandExposure = roundEgp(cap * (T.exposureWarnPctOfLimit / 100)) - notional;
  const overCapExposure = roundEgp(cap + notional + 1);

  return {
    // ---- 1 MODE_GUARD ---------------------------------------------------
    MODE_GUARD: [
      { name: 'live mode', patch: { mode: LIVE_MODE }, expect: { verdict: BLOCK, mentions: [LIVE_MODE] } },
      { name: 'unrecognised mode', patch: { mode: UNKNOWN_MODE }, expect: { verdict: BLOCK, mentions: [UNKNOWN_MODE], data: { mode: UNKNOWN_MODE } } },
      { name: 'the first allowed mode', patch: { mode: ALLOWED_MODES[0] }, expect: { verdict: ALLOW, mentions: [ALLOWED_MODES[0]], data: { mode: ALLOWED_MODES[0] } } },
      { name: 'the second allowed mode', patch: { mode: ALLOWED_MODES[1] }, expect: { verdict: ALLOW, mentions: [ALLOWED_MODES[1]], data: { mode: ALLOWED_MODES[1] } } },
      { name: 'no mode at all', patch: { mode: null }, expect: { verdict: BLOCK, mentions: ['null'] } },
    ],

    // ---- 2 KILL_SWITCH --------------------------------------------------
    //
    // Unlike the risk engine's KILL_SWITCH, the Sentinel's message carries the
    // trigger as well as the reason: an operator reading a refused order has no
    // other record of which stop fired. Both are asserted so the difference is
    // pinned rather than assumed.
    KILL_SWITCH: [
      {
        name: 'stop engaged with a trigger and a reason',
        patch: { killSwitch: { engaged: true, trigger: 'UNIT_SENTINEL_TRIGGER', reason: 'planted for the unit test' } },
        expect: {
          verdict: BLOCK,
          mentions: ['UNIT_SENTINEL_TRIGGER', 'planted for the unit test'],
          data: { engaged: true, trigger: 'UNIT_SENTINEL_TRIGGER', reason: 'planted for the unit test' },
        },
      },
      {
        // The record is a verbatim copy of the object the rule was handed, not a
        // normalised one. A stop that records no trigger and no reason therefore
        // stores NEITHER key - `data.trigger` is `undefined`, not `null` - and the
        // standing "unknown" wording in the prose is the only trace of the gap.
        // Asserted exactly, because a future `?? null` here would change what an
        // operator reading the audit row can tell.
        name: 'stop engaged with nothing recorded',
        patch: { killSwitch: { engaged: true } },
        expect: {
          verdict: BLOCK,
          mentions: [UNKNOWN_TRIGGER],
          dataEquals: { engaged: true },
        },
      },
      { name: 'stop clear', patch: { killSwitch: { engaged: false, trigger: null, reason: null } }, expect: { verdict: ALLOW } },
      { name: 'no kill switch object at all', patch: { killSwitch: null }, expect: { verdict: ALLOW } },
    ],

    // ---- 3 RISK_VERDICT -------------------------------------------------
    RISK_VERDICT: [
      {
        name: 'the risk engine blocked',
        patch: { riskVerdict: { blocked: true, failedRule: 'DAILY_LOSS', reason: 'loss limit reached' } },
        expect: { verdict: BLOCK, mentions: ['DAILY_LOSS', 'loss limit reached'], data: { failedRule: 'DAILY_LOSS', reason: 'loss limit reached' } },
      },
      {
        name: 'the risk engine warned',
        patch: {
          riskVerdict: {
            blocked: false,
            verdict: RISK_PROMOTED_VERDICT,
            rules: [{ rule: 'PRICE_SANITY', status: 'WARN' }, { rule: 'EXPOSURE', status: 'WARN' }, { rule: 'ORDER_VALID', status: 'BLOCK' }],
          },
        },
        expect: { verdict: WARN, mentions: ['PRICE_SANITY', 'EXPOSURE'] },
      },
      {
        // A warned verdict whose results carry no warning status names nothing.
        // It is still not a block, and an empty name list must not be mistaken
        // for one.
        name: 'a warned verdict with no warning results',
        patch: { riskVerdict: { blocked: false, verdict: RISK_PROMOTED_VERDICT, rules: [] } },
        expect: { verdict: WARN },
      },
      { name: 'an allowed risk verdict', patch: { riskVerdict: { blocked: false, verdict: VERDICTS.ALLOW, rules: [] } }, expect: { verdict: ALLOW } },
      { name: 'no risk verdict at all', patch: { riskVerdict: null }, expect: { verdict: ALLOW } },
    ],

    // ---- 4 DUPLICATE_ORDER ----------------------------------------------
    DUPLICATE_ORDER: [
      {
        name: 'the client order id already exists',
        patch: { existingOrder: dupOrder },
        expect: {
          verdict: BLOCK,
          mentions: [DEFAULT_CLIENT_ORDER_ID, dupOrder.order_id, orderStatus],
          data: { existingOrderId: dupOrder.order_id, existingStatus: orderStatus },
        },
      },
      { name: 'the client order id is new', patch: { existingOrder: null }, expect: { verdict: ALLOW } },
      {
        // With no client order id there is no idempotency key, so there is
        // nothing to be a duplicate OF. The rule declines to invent one.
        name: 'no client order id to check against',
        patch: { clientOrderId: null, existingOrder: null },
        expect: { verdict: ALLOW },
      },
    ],

    // ---- 5 MANUAL_HOLD --------------------------------------------------
    MANUAL_HOLD: [
      { name: 'operator hold engaged', patch: { manualHold: true }, expect: { verdict: BLOCK, mentions: ['Manual trading hold'], data: { manualHold: true } } },
      { name: 'operator hold cleared', patch: { manualHold: false }, expect: { verdict: ALLOW } },
      {
        // The rule tests truthiness, not `=== true`, and the repository stores
        // the flag as text. A caller handing it a non-empty string is still held
        // - and the record is normalised to a real boolean, so the audit row says
        // "held", not what happened to be in the column.
        name: 'a truthy but non-boolean hold value',
        patch: { manualHold: 'yes' },
        expect: { verdict: BLOCK, mentions: ['Manual trading hold'], data: { manualHold: true } },
      },
    ],

    // ---- 6 PRICE_DRIFT --------------------------------------------------
    PRICE_DRIFT: [
      {
        name: 'drift past the review band',
        patch: { currentPrice: driftedPrice(mid, reviewDriftBps) },
        expect: { verdict: REVIEW, mentions: [driftToken(reviewDriftBps), `${T.priceDriftReviewBps}bps`], data: { thresholdBps: T.priceDriftReviewBps } },
      },
      {
        name: 'drift past the warning band but inside review',
        patch: { currentPrice: driftedPrice(mid, warnDriftBps) },
        expect: { verdict: WARN, mentions: [driftToken(warnDriftBps)] },
      },
      {
        // Drift is precisely why a stop exit exists. Quarantining the order that
        // closes a position because the market moved would turn the stop into
        // the thing that leaves the position open.
        name: 'a risk-reducing exit, drifted far past review',
        patch: { proposal: { ...sellProposal, notionalEgp: notional }, currentPrice: driftedPrice(mid, reviewDriftBps * 20) },
        expect: { verdict: ALLOW, data: { reduceOnly: true } },
      },
      { name: 'no movement at all', patch: { currentPrice: mid }, expect: { verdict: ALLOW, data: { driftBps: 0 } } },
      {
        name: 'a decision price of zero is unusable, not merely suspicious',
        patch: { decisionPrice: 0 },
        expect: { verdict: BLOCK, mentions: ['Unusable price'], data: { decisionPrice: 0, currentPrice: mid } },
      },
      { name: 'a live price of zero is equally unusable', patch: { currentPrice: 0 }, expect: { verdict: BLOCK, mentions: ['Unusable price'] } },
    ],

    // ---- 7 UNUSUAL_SIZE -------------------------------------------------
    //
    // Two independent bands: an absolute EGP amount and a percentage of equity.
    // The two cases below reach them SEPARATELY, because a case that tripped
    // both would not show that either band works on its own.
    UNUSUAL_SIZE: [
      {
        name: 'over the percentage band only, on a small account',
        patch: { account: { ...snap, equityEgp: 200 }, proposal: { notionalEgp: 100 } },
        expect: { verdict: REVIEW, mentions: [String(roundEgp(100)), String(roundTo(50, 2))], data: { byPct: true, byAbs: false } },
      },
      {
        name: 'over the absolute band only, on a large account',
        patch: { account: { ...snap, equityEgp: 1000 }, proposal: { notionalEgp: roundEgp(T.unusualSizeReviewEgp * 1.1) } },
        expect: { verdict: REVIEW, mentions: [String(roundEgp(T.unusualSizeReviewEgp * 1.1))], data: { byAbs: true, byPct: false } },
      },
      {
        name: 'an exit is not an entry and is never size-reviewed',
        patch: { proposal: { side: SELL_SIDE, notionalEgp: oversizeNotional } },
        expect: { verdict: ALLOW },
      },
    ],

    // ---- 8 LOW_CONFIDENCE -----------------------------------------------
    LOW_CONFIDENCE: [
      {
        name: 'confidence below the review threshold',
        patch: { decision: { confidence: T.lowConfidenceReview * 0.5 } },
        expect: {
          verdict: REVIEW,
          mentions: [String(roundTo(T.lowConfidenceReview * 0.5, 3)), String(T.lowConfidenceReview)],
          data: { threshold: T.lowConfidenceReview },
        },
      },
      {
        // The band is "strictly below", so a signal exactly on the threshold is
        // tradable. Asserted because an off-by-one here would silently widen
        // or narrow the review set.
        name: 'confidence exactly on the threshold',
        patch: { decision: { confidence: T.lowConfidenceReview } },
        expect: { verdict: ALLOW },
      },
      {
        // A HOLD is not a trade, however weak it is. Quarantining it would put
        // a no-op in front of a human for no reason.
        name: 'a hold with no confidence at all',
        patch: { decision: { signal: HOLD_SIGNAL, confidence: 0 } },
        expect: { verdict: ALLOW },
      },
    ],

    // ---- 9 WIDE_STOP ----------------------------------------------------
    WIDE_STOP: [
      {
        name: 'stop wider than the guideline',
        patch: { proposal: { stopPrice: roundTo(mid * (1 - wideStopPct / 100), 8) } },
        expect: { verdict: WARN, mentions: [`${roundTo(wideStopPct, 2)}%`, `${T.wideStopWarnPct}%`] },
      },
      {
        name: 'stop exactly on the guideline',
        patch: { proposal: { stopPrice: roundTo(mid * (1 - T.wideStopWarnPct / 100), 8) } },
        expect: { verdict: ALLOW },
      },
      {
        name: 'an exit carries no stop to be wide',
        patch: { proposal: { side: SELL_SIDE, stopPrice: null } },
        expect: { verdict: ALLOW },
      },
    ],

    // ---- 10 DAILY_LOSS_PRESSURE -----------------------------------------
    DAILY_LOSS_PRESSURE: [
      {
        name: 'the loss has reached the limit',
        patch: { dailyLoss: { realizedEgp: -lossLimit, unrealizedEgp: 0 } },
        expect: { verdict: BLOCK, mentions: [String(roundEgp(lossLimit))], data: { loss: lossLimit, pct: 100 } },
      },
      {
        // The warning prose quotes the PERCENTAGE only. The EGP amount is on the
        // block branch, so expecting it here would be expecting a number the
        // message does not carry - and a percentage the operator cannot relate
        // to their own P&L would be the more useful thing to fix, not to assert
        // around. The token is computed from the injected loss, not copied from
        // the config, so it cannot drift from what the rule measured.
        name: 'the loss has reached the warning band',
        patch: { dailyLoss: { realizedEgp: -warnLoss, unrealizedEgp: 0 } },
        expect: {
          verdict: WARN,
          mentions: [String(roundTo((warnLoss / lossLimit) * 100, 1))],
          data: { loss: warnLoss, pct: T.dailyLossWarnPctOfLimit },
        },
      },
      {
        name: 'unrealised loss counts towards the same band',
        patch: { dailyLoss: { realizedEgp: 0, unrealizedEgp: -lossLimit } },
        expect: { verdict: BLOCK, data: { loss: lossLimit } },
      },
      {
        // One piastre short of the warning band. The prose rounds to the same
        // displayed percentage, so the VERDICT - not the message - is what
        // separates this from the case above. That is a rounding artefact of the
        // one-decimal display, not a second boundary.
        name: 'one piastre short of the warning band',
        patch: { dailyLoss: { realizedEgp: -underWarnLoss, unrealizedEgp: 0 } },
        expect: { verdict: ALLOW, dataBelow: { pct: T.dailyLossWarnPctOfLimit } },
      },
      {
        // A profitable day is a loss of zero, never a negative one.
        name: 'the day is in profit',
        patch: { dailyLoss: { realizedEgp: lossLimit * 2, unrealizedEgp: 0 } },
        expect: { verdict: ALLOW, data: { loss: 0, pct: 0 } },
      },
    ],

    // ---- 11 EXPOSURE_PRESSURE -------------------------------------------
    EXPOSURE_PRESSURE: [
      {
        name: 'an entry that would take the book over the cap',
        patch: { account: { ...snap, exposureEgp: cap } },
        expect: { verdict: BLOCK, mentions: [`${roundTo(exposurePct(cap + notional), 1)}%`], data: { reduceOnly: false } },
      },
      {
        name: 'an entry landing exactly on the warning band',
        patch: { account: { ...snap, exposureEgp: warnBandExposure } },
        expect: { verdict: WARN, mentions: [String(T.exposureWarnPctOfLimit)] },
      },
      {
        // The single most important branch in the rule. Exposure is marked to
        // market and can sit above the cap between orders, so a SELL that
        // reduces it is allowed through with a warning even though the
        // projection is over the cap. A Sentinel that trapped the exit would
        // leave the position open.
        name: 'a risk-reducing exit from an over-cap book',
        patch: { account: { ...snap, exposureEgp: overCapExposure }, proposal: { ...sellProposal, notionalEgp: notional } },
        expect: {
          verdict: WARN,
          mentions: [`${roundTo(exposurePct(cap + 1), 1)}%`, 'reduces exposure'],
          data: { reduceOnly: true, projected: cap + 1 },
        },
      },
      {
        // A plain SELL counts as risk-reducing too: the rule does not require
        // the caller to set the flag as well as the side.
        name: 'a plain sell from an over-cap book',
        patch: { account: { ...snap, exposureEgp: overCapExposure }, proposal: { side: SELL_SIDE, reduceOnly: false, notionalEgp: notional } },
        expect: { verdict: WARN, data: { reduceOnly: true } },
      },
      { name: 'an entry well inside the cap', patch: {}, expect: { verdict: ALLOW, data: { reduceOnly: false } } },
    ],

    // ---- 12 DECISION_RATE ------------------------------------------------
    DECISION_RATE: [
      {
        name: 'a burst past the per-minute cap',
        patch: { recentDecisionCount: T.maxDecisionsPerMinute + 1 },
        expect: {
          verdict: REVIEW,
          mentions: [`${T.maxDecisionsPerMinute + 1} decisions in ${REPORTED_WINDOW_MS}ms`, `${T.maxDecisionsPerMinute}/min`],
          data: { limit: T.maxDecisionsPerMinute, windowMs: REPORTED_WINDOW_MS },
        },
      },
      {
        // The band is "strictly more than", so the cap itself is still allowed.
        name: 'exactly at the per-minute cap',
        patch: { recentDecisionCount: T.maxDecisionsPerMinute },
        expect: { verdict: ALLOW, data: { recentDecisionCount: T.maxDecisionsPerMinute } },
      },
      {
        // A runaway loop that is emitting nothing but exits is still a runaway
        // loop, but those exits are what reduce risk - so the rate rule stands
        // aside, exactly as the drift rule does.
        name: 'a risk-reducing exit inside a burst',
        patch: { recentDecisionCount: T.maxDecisionsPerMinute * 10, proposal: { ...sellProposal, notionalEgp: notional } },
        expect: { verdict: ALLOW, data: { reduceOnly: true } },
      },
    ],

    // ---- 13 STOP_REQUIRED ------------------------------------------------
    STOP_REQUIRED: [
      {
        name: 'an entry with no stop condition',
        patch: { decision: strippedDecision, proposal: { stopPrice: null } },
        expect: { verdict: BLOCK, mentions: ['no stop condition'], data: { stopCondition: null } },
      },
      {
        // The rule is policy-gated. With the gate off a stop is advisory, and
        // asserting that is what keeps the gate from being untested.
        name: 'the same entry with the gate switched off',
        patch: { decision: strippedDecision, proposal: { stopPrice: null }, thresholds: { ...T, stopRequiredBlocks: false } },
        expect: { verdict: ALLOW },
      },
      {
        // An exit never carried a forward stop in the first place.
        name: 'an exit with no stop condition',
        patch: { decision: { ...strippedDecision, signal: SELL_SIDE }, proposal: sellProposal },
        expect: { verdict: ALLOW },
      },
      { name: 'an entry with its stop condition intact', patch: {}, expect: { verdict: ALLOW } },
    ],

    // ---- 14 SHORT_GUARD --------------------------------------------------
    SHORT_GUARD: [
      {
        name: 'a sell with no open long to exit',
        patch: { decision: { signal: SELL_SIDE }, proposal: sellProposal },
        expect: { verdict: BLOCK, mentions: [h.instrument.symbol, 'Shorting is prohibited'], data: { symbol: h.instrument.symbol } },
      },
      {
        // The live lookup is preferred over the snapshot, and the snapshot is
        // only consulted when no live account was handed in. Exercising the
        // fallback is what stops the two paths drifting apart unnoticed.
        name: 'a sell with a position in the snapshot but no live account',
        patch: {
          decision: { signal: SELL_SIDE },
          proposal: sellProposal,
          accountRef: null,
          account: { ...snap, openPositionDetails: [{ symbol: h.instrument.symbol, quantity: 1 }] },
        },
        expect: { verdict: ALLOW },
      },
      {
        // A position in a DIFFERENT symbol is not a position in this one.
        name: 'a sell whose only open position is another symbol',
        patch: {
          decision: { signal: SELL_SIDE },
          proposal: sellProposal,
          accountRef: null,
          account: { ...snap, openPositionDetails: [{ symbol: otherSymbol, quantity: 1 }] },
        },
        expect: { verdict: BLOCK, mentions: [h.instrument.symbol] },
      },
      {
        // The live account is authoritative: it has no position, so the
        // snapshot's claim is ignored.
        name: 'a sell the live account cannot corroborate',
        patch: {
          decision: { signal: SELL_SIDE },
          proposal: sellProposal,
          account: { ...snap, openPositionDetails: [{ symbol: h.instrument.symbol, quantity: 1 }] },
        },
        expect: { verdict: BLOCK, mentions: ['Shorting is prohibited'] },
      },
      { name: 'a buy is not an exit and is never short-checked', patch: {}, expect: { verdict: ALLOW } },
    ],
  };
}

/**
 * Every rule must be ABLE to object, not merely to pass, or the "this rule
 * fires" assertion below proves nothing - and the branch table has to reach
 * every branch the rule actually has, including the ones that can only warn or
 * quarantine.
 */
for (const ruleId of RULE_IDS) {
  test(`SENTINEL RULE ${ruleId}: quiet on the control, decisive on its own breach`, () => {
    const h = createHarness();
    try {
      h.tickMarket();
      const rule = RULE_BY_ID.get(ruleId);
      const cases = branchCases(h)[ruleId];

      // ---- the control, called directly -------------------------------
      const ctx = sentinelCtx(h);
      let direct;
      assert.doesNotThrow(
        () => { direct = rule.evaluate(ctx); },
        `${ruleId} evaluates a healthy context without throwing`,
      );
      assert.equal(direct.verdict, ALLOW, `${ruleId} is quiet on a healthy context (got ${direct.verdict}: ${direct.detail})`);
      assert.ok(typeof direct.detail === 'string' && direct.detail.length > 0, `${ruleId} says why it is quiet`);
      assertDataShape(direct, ruleId);

      // ---- the same rule inside a real run, under its own id -----------
      const { out, decision, proposal } = runSentinel(h, {});
      const recorded = ruleResult(out, ruleId);
      assert.equal(recorded.description, rule.description, `${ruleId} is recorded under its own description`);
      assert.equal(recorded.verdict, ALLOW, `${ruleId} is quiet through the composed class too`);
      assert.ok(typeof recorded.detail === 'string' && recorded.detail.length > 0, `${ruleId} says why, in the run too`);
      assertDataShape(recorded, `${ruleId} (recorded)`);

      // The recorded sentence has to be THIS RULE's own output, not a
      // restatement by the class, so re-running the rule on the very decision
      // and proposal the class was given must reproduce it word for word.
      //
      // That comparison is only available for a rule that reads nothing
      // `evaluate` derives for itself - the manual hold, the duplicate lookup,
      // the two prices, the decision-rate window and count. For those four
      // (DUPLICATE_ORDER, MANUAL_HOLD, PRICE_DRIFT, DECISION_RATE) a direct call
      // simply cannot be handed the same context, so the shared property is the
      // verdict, asserted above, and the prose is pinned by the direct call and
      // by each branch case instead.
      if (ruleIsCallerSupplied(ruleId)) {
        const replayed = rule.evaluate(sentinelCtx(h, { decision, proposal }));
        assert.equal(replayed.verdict, ALLOW, `${ruleId} is still quiet on the run's own inputs`);
        assert.equal(recorded.detail, replayed.detail, `${ruleId} records the reason a direct call on those inputs produces`);
      }

      // ---- the branches ------------------------------------------------
      assert.ok(cases && cases.length > 0, `${ruleId} has branch cases`);
      assert.ok(
        cases.some((c) => c.expect.verdict !== ALLOW),
        `${ruleId} can object, not merely pass`,
      );
      assert.deepEqual(
        [...new Set(cases.map((c) => c.expect.verdict))].sort(),
        [...ruleVerdictsIn(ruleId)].sort(),
        `${ruleId}: the branch table reaches every verdict the rule's own source can return, and no other`,
      );
      assert.ok(
        cases.every((c) => SENTINEL_VERDICTS.includes(c.expect.verdict)),
        `${ruleId}: every declared verdict is one of the four the Sentinel can return`,
      );

      for (const c of cases) {
        const res = rule.evaluate(sentinelCtx(h, c.patch));
        const where = `${ruleId} / ${c.name}`;

        assert.equal(res.verdict, c.expect.verdict, `${where}: verdict (got ${res.verdict}: ${res.detail})`);
        assert.ok(typeof res.detail === 'string' && res.detail.length > 0, `${where}: carries a reason`);
        assertDataShape(res, where);

        if (c.expect.dataEquals !== undefined) {
          assert.deepEqual(res.data, c.expect.dataEquals, `${where}: the record is the object the rule read, verbatim`);
        }
        for (const [key, value] of Object.entries(c.expect.data ?? {})) {
          assert.deepEqual(res.data?.[key], value, `${where}: data.${key} carries the value the rule read`);
        }
        for (const [key, bound] of Object.entries(c.expect.dataAbove ?? {})) {
          assert.ok(res.data?.[key] > bound, `${where}: data.${key} (${res.data?.[key]}) is above ${bound}`);
        }
        for (const [key, bound] of Object.entries(c.expect.dataBelow ?? {})) {
          assert.ok(res.data?.[key] < bound, `${where}: data.${key} (${res.data?.[key]}) is below ${bound}`);
        }
        for (const token of c.expect.mentions ?? []) {
          assert.ok(
            String(res.detail).includes(String(token)),
            `${where}: the reason quotes ${JSON.stringify(String(token))} so the operator sees the live value (got "${res.detail}")`,
          );
        }
      }
    } finally {
      h.cleanup();
    }
  });
}

test('SENTINEL RULES: the branch tables cover exactly the registry, with no invented ids', () => {
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

// ---------------------------------------------------------------------------
// 4. Fail-closed
// ---------------------------------------------------------------------------

test('SENTINEL FAILS CLOSED: a rule that throws is turned into a refusal, not an allow', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    // No account object at all. Two rules reach straight into it, so both throw -
    // and a thrown rule has to be a refusal, or a defect anywhere in the context
    // assembly would read as "no objection".
    const { out } = runSentinel(h, { account: null });

    assert.equal(out.verdict, BLOCK, 'a rule that threw blocks the order');
    assert.equal(out.actionTaken, ACTION_BY_VERDICT[BLOCK], 'with a rejecting action');
    assert.ok(
      out.reason.startsWith(RULE_THREW_PREFIX),
      `and a reason that says a rule threw, not that the order was fine (got "${out.reason}")`,
    );
    assert.equal(out.triggerRule, 'UNUSUAL_SIZE', 'naming the FIRST rule that threw, not whichever one is loudest');

    const thrown = out.rules.filter((r) => String(r.detail).startsWith(RULE_THREW_PREFIX));
    assert.ok(thrown.length >= 2, `both rules that reached the missing account are recorded as thrown (saw ${thrown.length})`);
    for (const r of thrown) {
      assert.equal(r.verdict, BLOCK, `${r.rule}: a thrown rule contributes a block`);
      assert.equal(typeof r.data?.error, 'object', `${r.rule}: and the failure payload is kept for the operator`);
      assert.ok(typeof r.data.error.message === 'string' && r.data.error.message.length > 0, `${r.rule}: with a message`);
    }

    assert.equal(persistedSentinelRow(h, out.sentinelDecisionId).verdict, BLOCK, 'and the refusal is persisted like any other');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Precedence and the action vocabulary
// ---------------------------------------------------------------------------

test('SENTINEL PRECEDENCE: the highest-ranked verdict wins, whoever raised it', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const T = h.config.sentinel;
    const L = h.config.risk;
    const mid = h.quote().mid;
    const snap = h.account.snapshot();

    // Each builder plants exactly one condition, named after the rule it
    // provokes. `proposal` patches merge onto the real proposal, so a builder
    // only names the field it is about.
    const wideStop = (bps) => ({ proposal: { stopPrice: roundTo(mid * (1 - bps / 100), 8) } });
    const unusualSize = () => ({ proposal: { notionalEgp: oversizeNotionalEgp(h) } });
    const priceDrift = () => ({ quote: h.syntheticQuote({ mid: driftedPrice(mid, T.priceDriftReviewBps + 5) }) });
    const lossWarn = () => ({ dailyLoss: { realizedEgp: -roundEgp(L.dailyLossLimitEgp * (T.dailyLossWarnPctOfLimit / 100)), unrealizedEgp: 0 } });
    const lossLimit = () => ({ dailyLoss: { realizedEgp: -L.dailyLossLimitEgp, unrealizedEgp: 0 } });
    const overCap = () => ({ account: { ...snap, exposureEgp: L.maxPortfolioExposureEgp } });
    const noStop = (d) => ({ decision: { ...d, stopCondition: null, stopPrice: null }, proposal: { stopPrice: null } });

    const cases = [
      {
        // ALLOW is a rank like any other, so an allow is attributed to the first
        // rule in the registry - see SENTINEL CONTROL. The expectation is the
        // first rule, not null, and saying so here is what keeps the lattice
        // honest about the shape the class actually returns.
        name: 'nothing objects',
        expect: { verdict: ALLOW, triggerRule: RULE_IDS[0] },
        build: () => ({}),
      },
      {
        name: 'one warning',
        expect: { verdict: WARN, triggerRule: 'WIDE_STOP' },
        build: () => wideStop(T.wideStopWarnPct + 0.5),
      },
      {
        // Two rules at the SAME rank: the earlier one in the registry is
        // recorded, so the audit trail names the first reason rather than an
        // arbitrary one from the set.
        name: 'two warnings - the earlier rule is recorded',
        expect: { verdict: WARN, triggerRule: 'WIDE_STOP' },
        build: () => ({ ...wideStop(T.wideStopWarnPct + 0.5), ...lossWarn() }),
      },
      {
        // A LATER rule, with a HIGHER rank, beats an earlier one. Position in
        // the list is an evaluation order, not a priority.
        name: 'an early warning loses to a later block',
        expect: { verdict: BLOCK, triggerRule: 'DAILY_LOSS_PRESSURE' },
        build: () => ({ ...wideStop(T.wideStopWarnPct + 0.5), ...lossLimit() }),
      },
      {
        // And a later REVIEW outranks an earlier warning.
        name: 'an early warning loses to an earlier review',
        expect: { verdict: REVIEW, triggerRule: 'PRICE_DRIFT' },
        build: () => ({ ...wideStop(T.wideStopWarnPct + 0.5), ...priceDrift() }),
      },
      {
        // Two reviews: again the earlier one is the recorded trigger, and the
        // later one is still present in the per-rule results.
        name: 'two reviews - the earlier rule is recorded',
        expect: { verdict: REVIEW, triggerRule: 'PRICE_DRIFT' },
        build: () => ({ ...priceDrift(), ...unusualSize(), ...wideStop(T.wideStopWarnPct + 0.5) }),
      },
      {
        // The quarantine cannot soften a block that a later rule raised.
        name: 'a review cannot soften a later block',
        expect: { verdict: BLOCK, triggerRule: 'STOP_REQUIRED' },
        build: (d) => ({ ...unusualSize(), ...noStop(d) }),
      },
      {
        name: 'an over-cap block beats an earlier review',
        expect: { verdict: BLOCK, triggerRule: 'EXPOSURE_PRESSURE' },
        build: () => ({ ...unusualSize(), ...overCap() }),
      },
      {
        name: 'two blocks - the earlier rule is recorded',
        expect: { verdict: BLOCK, triggerRule: 'MODE_GUARD' },
        build: (d) => ({ mode: LIVE_MODE, ...overCap(), ...unusualSize(), ...noStop(d) }),
      },
      {
        name: 'a mode block outranks everything else that fires',
        expect: { verdict: BLOCK, triggerRule: 'MODE_GUARD' },
        build: () => ({ mode: LIVE_MODE, ...overCap(), ...unusualSize(), ...wideStop(T.wideStopWarnPct + 0.5), ...lossWarn() }),
      },
    ];

    const seen = new Set();
    for (const c of cases) {
      const { out } = runSentinel(h, c.build(h.buyDecision({ price: mid })));
      const where = c.name;

      assert.equal(out.verdict, c.expect.verdict, `${where}: verdict`);
      assert.equal(out.triggerRule, c.expect.triggerRule, `${where}: the trigger is the FIRST rule at the winning rank`);
      assert.equal(out.actionTaken, ACTION_BY_VERDICT[out.verdict], `${where}: the action follows the verdict`);
      assert.ok(typeof out.reason === 'string' && out.reason.length > 0, `${where}: with a reason`);
      assert.equal(out.rules.length, RULE_IDS.length, `${where}: every rule still contributed a result`);

      // The winning rank really is the maximum over all the rules - the
      // property the table above only spot-checks - and the reported trigger is
      // the FIRST result at that rank, whatever the verdict.
      const ranks = out.rules.map((r) => rankOf(r.verdict));
      assert.equal(rankOf(out.verdict), Math.max(...ranks), `${where}: no rule outranked the verdict that won`);

      const firstAtRank = out.rules.findIndex((r) => r.verdict === out.verdict);
      assert.equal(out.rules[firstAtRank].rule, out.triggerRule, `${where}: the trigger is the first result at the winning rank`);
      assert.equal(out.reason, out.rules[firstAtRank].detail, `${where}: the reason is the trigger rule's own wording`);

      seen.add(out.verdict);
    }

    // The lattice is only worth something if it actually reached all four
    // verdicts - including the ALLOW, which is what a quarantining layer must
    // not turn everything into.
    assert.deepEqual([...seen].sort(), [...SENTINEL_VERDICTS].sort(), 'the combinations reached all four verdicts');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. The Sentinel cannot widen a risk refusal
// ---------------------------------------------------------------------------

test('SENTINEL CANNOT UPGRADE: a risk BLOCK stays a BLOCK, whatever else fires', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const T = h.config.sentinel;
    const mid = h.quote().mid;
    const snap = h.account.snapshot();

    // Four independent second opinions, of three different ranks, presented on
    // top of the same risk block. None of them may soften it.
    const others = [
      { name: 'a REVIEW from an unusual size', verdict: REVIEW, patch: () => ({ proposal: { notionalEgp: oversizeNotionalEgp(h) } }) },
      { name: 'a WARN from a wide stop', verdict: WARN, patch: () => ({ proposal: { stopPrice: roundTo(mid * (1 - (T.wideStopWarnPct + 0.5) / 100), 8) } }) },
      { name: 'a REVIEW from price drift', verdict: REVIEW, patch: () => ({ quote: h.syntheticQuote({ mid: driftedPrice(mid, T.priceDriftReviewBps + 5) }) }) },
      { name: 'a BLOCK from an over-cap book', verdict: BLOCK, patch: () => ({ account: { ...snap, exposureEgp: h.config.risk.maxPortfolioExposureEgp } }) },
    ];

    const riskBlock = {
      riskDecisionId: 'UNIT-SENTINEL-RISK-BLOCK',
      blocked: true,
      failedRule: 'DAILY_LOSS',
      reason: 'daily loss limit reached',
      verdict: VERDICTS.BLOCK,
      rules: [],
    };

    for (const other of others) {
      const { out } = runSentinel(h, {
        decision: h.buyDecision({ price: mid }),
        riskVerdict: riskBlock,
        ...other.patch(),
      });

      const where = `a risk BLOCK alongside ${other.name}`;
      assert.equal(out.verdict, BLOCK, `${where}: the risk block is not downgraded`);
      assert.equal(out.actionTaken, ACTION_BY_VERDICT[BLOCK], `${where}: and the action stays a rejection`);
      assert.equal(out.triggerRule, 'RISK_VERDICT', `${where}: named against the risk engine, not the second opinion`);
      assert.ok(out.reason.includes('DAILY_LOSS'), `${where}: the reason names the rule that actually refused (got "${out.reason}")`);
      assert.ok(out.reason.includes('daily loss limit reached'), `${where}: and quotes its reason`);

      // The other rule's result is still recorded. Suppressing it would hide
      // what else was wrong with the order from the operator.
      assert.ok(
        out.rules.some((r) => r.rule !== 'RISK_VERDICT' && r.verdict === other.verdict),
        `${where}: the second opinion is still recorded in its own right`,
      );
    }

    // A risk WARNING is a warning and nothing more: never escalated into a
    // quarantine or a rejection on its own.
    const riskWarn = {
      riskDecisionId: 'UNIT-SENTINEL-RISK-WARN',
      blocked: false,
      failedRule: null,
      reason: null,
      verdict: VERDICTS.WARN,
      rules: [{ rule: 'PRICE_SANITY', status: 'WARN' }, { rule: 'EXPOSURE', status: 'WARN' }],
    };
    const warned = runSentinel(h, { decision: h.buyDecision({ price: mid }), riskVerdict: riskWarn });
    assert.equal(warned.out.verdict, RISK_PROMOTED_VERDICT, 'a risk warning surfaces as a Sentinel warning');
    assert.equal(warned.out.actionTaken, ACTION_BY_VERDICT[WARN], 'and passes with a warning attached');
    assert.equal(warned.out.triggerRule, 'RISK_VERDICT', 'attributed to the risk engine');
    assert.notEqual(warned.out.verdict, REVIEW, 'a risk warning is never escalated into a quarantine');
    assert.notEqual(warned.out.verdict, BLOCK, 'nor into a rejection');

    // A REVIEW verdict from the risk engine is a token `VERDICTS` declares but
    // `RiskEngine#check` never emits. The Sentinel's RISK_VERDICT rule promotes
    // exactly one non-blocking token, so a REVIEW input falls through to ALLOW.
    // Recorded here rather than papered over: it is an observation about two
    // components, not a safety property. The safety property - a real block is
    // never widened - is what the rest of this test asserts.
    const riskReview = {
      riskDecisionId: 'UNIT-SENTINEL-RISK-REVIEW',
      blocked: false,
      failedRule: null,
      reason: null,
      verdict: VERDICTS.REVIEW,
      rules: [],
    };
    const reviewed = runSentinel(h, { decision: h.buyDecision({ price: mid }), riskVerdict: riskReview });
    assert.equal(reviewed.out.verdict, ALLOW, 'a REVIEW input the Sentinel does not recognise is not treated as a block');
    assert.equal(reviewed.out.actionTaken, ACTION_BY_VERDICT[ALLOW], 'and the order passes');
    assert.equal(ruleResult(reviewed.out, 'RISK_VERDICT').verdict, ALLOW, 'the rule itself reports no objection');

    // The narrowest possible statement of the same property, with nothing else
    // wrong and nothing to say.
    const bare = runSentinel(h, {
      decision: h.buyDecision({ price: mid }),
      riskVerdict: { ...riskBlock, failedRule: null, reason: null },
    });
    assert.equal(bare.out.verdict, BLOCK, 'a block stands even with nothing else wrong and nothing to say');
    assert.equal(bare.out.actionTaken, ACTION_BY_VERDICT[BLOCK], 'and still rejects');
    assert.equal(ruleResult(bare.out, 'RISK_VERDICT').data.failedRule, null, 'with no rule name to blame, and still refused');

    // Every Sentinel refusal a risk block produces is written to the audit
    // trail, so the two refusals can be told apart afterwards.
    const events = h.repos.listEvents({ category: SENTINEL_EVENT_CATEGORY });
    assert.ok(events.length >= 1, 'the Sentinel refusal is logged for the operator');
    assert.ok(events[0].message.includes('RISK_VERDICT'), `naming the rule that actually decided (got "${events[0].message}")`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Operator control: the manual hold
// ---------------------------------------------------------------------------

test('MANUAL HOLD: the hold is read from the control_flags table, not from the caller', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;

    // 1. Nothing set. The flag is absent, and the default is not a hold.
    assert.equal(h.repos.isFlagSet(MANUAL_HOLD_FLAG), false, 'the hold flag is not set on a fresh account');
    const free = runSentinel(h, {});
    assert.equal(free.out.verdict, ALLOW, 'an ordinary order passes');
    assert.equal(ruleResult(free.out, 'MANUAL_HOLD').verdict, ALLOW, 'and the hold rule has no objection');

    // 2. The caller cannot fabricate a hold. `evaluate` derives the hold from
    // the database, so an extra `manualHold` argument is simply not a parameter
    // it reads. A test that could assert a hold it had not actually set would
    // be asserting the harness.
    const faked = h.sentinel.evaluate({
      decision: free.decision,
      proposal: free.proposal,
      riskVerdict: cleanRiskVerdict(free.decision.decisionId),
      account: h.account.snapshot(),
      accountRef: h.account,
      dailyLoss: { realizedEgp: 0, unrealizedEgp: 0 },
      killSwitch: h.killSwitch(),
      quote: h.quote(),
      mode: h.mode,
      manualHold: true,
    });
    assert.equal(faked.verdict, ALLOW, 'a manualHold argument does not create a hold - only the flag does');
    assert.equal(ruleResult(faked, 'MANUAL_HOLD').verdict, ALLOW, 'and the hold rule still sees no hold');

    // 3. An operator sets it, exactly as the CLI does.
    h.repos.setFlag(MANUAL_HOLD_FLAG, 'true', h.clock, 'operator', 'operator stop for review');
    assert.equal(h.repos.isFlagSet(MANUAL_HOLD_FLAG), true, 'the flag is now set');

    const held = runSentinel(h, { decision: h.buyDecision({ price: mid }) });
    assert.equal(held.out.verdict, BLOCK, 'a hold blocks the order');
    assert.equal(held.out.actionTaken, ACTION_BY_VERDICT[BLOCK], 'with a rejection');
    assert.equal(held.out.triggerRule, 'MANUAL_HOLD', 'naming the hold rule');
    assert.ok(held.out.reason.includes('operator'), `and telling the operator what to do about it (got "${held.out.reason}")`);

    // A hold is a REFUSAL, not a quarantine. A quarantine would leave a
    // decision waiting for a human that the operator had already answered by
    // stopping everything.
    assert.notEqual(held.out.verdict, REVIEW, 'a hold is a refusal, not a quarantine');
    assert.equal(h.repos.getFlag(REVIEW_PENDING_FLAG), null, 'and nothing was filed as awaiting review');

    // 4. And it releases, with the operator recorded on the flag row.
    h.repos.setFlag(MANUAL_HOLD_FLAG, 'false', h.clock, 'operator', 'resumed');
    const resumed = runSentinel(h, { decision: h.buyDecision({ price: mid }) });
    assert.equal(resumed.out.verdict, ALLOW, 'clearing the hold releases the account again');
    const flagRow = h.db.get('SELECT * FROM control_flags WHERE flag = ? AND mode = ?', MANUAL_HOLD_FLAG, h.mode);
    assert.equal(flagRow.value, 'false', 'the flag reads back cleared');
    assert.equal(flagRow.updated_by, 'operator', 'with an actor on record');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Idempotency
// ---------------------------------------------------------------------------

test('DUPLICATE ORDER: the refusal comes from the real orders table', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;

    // The first pass records the order intent through the repository, exactly
    // as the adapter does. The client order id is derived from the decision id,
    // so the same decision always produces the same key.
    const decision = h.buyDecision({ price: mid });
    h.repos.insertDecision(decisionToRow(decision), h.clock);
    const orderId = newId('ord');
    h.repos.insertOrder({
      orderId,
      clientOrderId: clientOrderId(decision.decisionId),
      decisionId: decision.decisionId,
      riskDecisionId: null,
      sentinelDecisionId: null,
      symbol: decision.symbol,
      side: BUY_SIDE,
      orderType: 'MARKET',
      quantity: 1,
      limitPrice: null,
      expectedPrice: mid,
      reduceOnly: false,
      status: 'NEW',
    }, h.clock);

    assert.ok(h.repos.getOrderByClientId(clientOrderId(decision.decisionId)), 'the order is now findable by its client id');

    // A different decision has a different key, so it is not a duplicate.
    const other = runSentinel(h, { decision: h.buyDecision({ price: mid }) });
    assert.equal(ruleResult(other.out, 'DUPLICATE_ORDER').verdict, ALLOW, 'a different decision is not a duplicate of this one');

    // The same decision, re-presented - which is exactly what a restart replay
    // looks like - is refused.
    const replay = runSentinel(h, { decision });
    assert.equal(replay.out.verdict, BLOCK, 're-presenting the same decision is refused');
    assert.equal(replay.out.triggerRule, 'DUPLICATE_ORDER', 'by the idempotency rule');
    assert.equal(replay.out.actionTaken, ACTION_BY_VERDICT[BLOCK], 'with a rejection');
    assert.ok(
      replay.out.reason.includes(clientOrderId(decision.decisionId)) && replay.out.reason.includes(orderId),
      `and the message names both the key and the order it collided with (got "${replay.out.reason}")`,
    );
    assert.equal(countRows(h, 'orders'), 1, 'and no second order was written - the point of the check');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. The decision-rate window
// ---------------------------------------------------------------------------

test('DECISION RATE: the burst count is real rows in the real table', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const cap = h.config.sentinel.maxDecisionsPerMinute;
    const mid = h.quote().mid;

    // A quiet first decision, to prove the counter starts at one - and that one
    // is the decision under evaluation.
    const first = runSentinel(h, {});
    assert.equal(first.out.verdict, ALLOW, 'the first decision passes');
    assert.equal(ruleResult(first.out, 'DECISION_RATE').data.recentDecisionCount, 1, 'and the counter saw exactly itself');

    // Fill the window to the cap. Every filler is a REAL sealed decision written
    // through the repository, so the count is a count of decisions rather than
    // of test scaffolding. The decision under evaluation is one of them.
    const seed = (n) => {
      for (let i = 0; i < n; i += 1) {
        const d = h.buyDecision({ price: mid });
        h.repos.insertDecision(decisionToRow(d), h.clock);
      }
    };
    seed(cap - 2); // one already written, plus the one about to be = the cap
    const atCap = runSentinel(h, {});
    assert.equal(ruleResult(atCap.out, 'DECISION_RATE').data.recentDecisionCount, cap, `the window holds exactly the cap (${cap})`);
    assert.equal(ruleResult(atCap.out, 'DECISION_RATE').verdict, ALLOW, 'and the rate rule has no objection');
    assert.equal(atCap.out.verdict, ALLOW, 'so the decision passes');

    // One more and the window overflows. The expected count is derived from the
    // rows that are really in the table, not from `cap`: the count the Sentinel
    // reports always includes the decision under evaluation, which `runSentinel`
    // persists immediately before evaluating, so the honest statement is "every
    // row written so far, plus this one".
    const decisionsInTable = () => h.repos.db.count(
      'SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ?', h.mode,
    );
    seed(1);
    const rowsAtOverflow = decisionsInTable();
    assert.equal(rowsAtOverflow, cap + 1, `one more seeded decision really did take the table past the cap (${rowsAtOverflow})`);
    const overCap = runSentinel(h, {});
    assert.equal(
      ruleResult(overCap.out, 'DECISION_RATE').data.recentDecisionCount, rowsAtOverflow + 1,
      'the count is every row in the window, including the decision being judged',
    );
    assert.equal(overCap.out.verdict, REVIEW, 'and the decision is quarantined');
    assert.equal(overCap.out.triggerRule, 'DECISION_RATE', 'by the rate rule');
    assert.equal(overCap.out.actionTaken, ACTION_BY_VERDICT[REVIEW], 'with a quarantine, not a submission');
    assert.ok(
      overCap.out.reason.includes(`${cap}/min`) && overCap.out.reason.includes(String(COUNTED_WINDOW_MS)),
      `and quotes the cap and the window it applied (got "${overCap.out.reason}")`,
    );

    // The count is a WINDOW, not a latch. Age every decision out of it and the
    // same account is quiet again - the difference between a runaway loop and a
    // busy minute.
    h.advance(COUNTED_WINDOW_MS + 1);
    const afterWindow = runSentinel(h, {});
    assert.equal(ruleResult(afterWindow.out, 'DECISION_RATE').data.recentDecisionCount, 1, 'the burst has aged out of the window');
    assert.equal(afterWindow.out.verdict, ALLOW, 'and the same order is no longer quarantined');

    // The count came from rows, not from a constant: the whole burst is still in
    // the table, one row per decision, and only the last one is new.
    assert.equal(
      decisionsInTable(), rowsAtOverflow + 2,
      'the table really holds the whole burst plus the decision that aged the window, one row per decision',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. Mode isolation
// ---------------------------------------------------------------------------

test('MODE GUARD: only the modes this system actually has can reach the adapter', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const schemaModes = checkEnum(h, 'agent_decisions', 'mode');

    // Every mode the DATABASE will accept must be a mode the Sentinel allows.
    // If one were not, the agent could be configured into a mode in which it
    // writes rows it will never be allowed to act on - a silently dead system.
    for (const mode of schemaModes) {
      assert.ok(ALLOWED_MODES.includes(mode), `the database accepts ${mode} and the Sentinel allows it`);
    }
    assert.deepEqual(
      [...ALLOWED_MODES].sort(), [...schemaModes].sort(),
      'and the whitelist is exactly the schema vocabulary - no more, no less',
    );
    assert.ok(!schemaModes.includes(LIVE_MODE), `${LIVE_MODE} is not a mode this build can even record a decision in`);
    assert.ok(ALLOWED_MODES.includes(h.config.mode), `the configured default mode ${h.config.mode} is allowed`);

    // Nothing outside the whitelist gets through, and the refusal is a refusal.
    for (const mode of [LIVE_MODE, UNKNOWN_MODE, null, undefined, '', 'paper', 'PAPER ']) {
      const label = JSON.stringify(mode) ?? 'undefined';
      const { out } = runSentinel(h, { decision: h.buyDecision({ price: mid }), mode });
      assert.equal(out.verdict, BLOCK, `mode ${label} is refused`);
      assert.equal(out.actionTaken, ACTION_BY_VERDICT[BLOCK], `mode ${label}: with a rejection`);
      assert.equal(ruleResult(out, 'MODE_GUARD').verdict, BLOCK, `mode ${label}: by the mode guard`);
    }

    // Both allowed modes really do pass.
    for (const mode of ALLOWED_MODES) {
      const { out } = runSentinel(h, { decision: h.buyDecision({ price: mid }), mode });
      assert.equal(out.verdict, ALLOW, `mode ${mode} is allowed`);
      assert.equal(ruleResult(out, 'MODE_GUARD').data.mode, mode, `and the rule reports the mode it was given`);
    }
  } finally {
    h.cleanup();
  }
});

test('MODE GUARD: the firewall hands the Sentinel its own mode, in both real modes', async () => {
  for (const mode of ALLOWED_MODES) {
    const h = createHarness({ mode });
    try {
      h.tickMarket();
      h.advance();
      const decision = h.buyDecision({ price: h.quote().mid });

      const res = await h.submit(decision);

      assert.ok(OUTCOMES.includes(res.outcome), `in ${mode} the firewall returns a declared outcome`);
      assert.equal(res.outcome, EXECUTED, `in ${mode} a well-formed paper order executes`);
      assert.equal(res.sentinelVerdict.verdict, ALLOW, `the Sentinel allows a healthy order in ${mode}`);
      assert.equal(res.sentinelVerdict.actionTaken, ACTION_BY_VERDICT[ALLOW], 'with the passing action');

      // The Sentinel's own record of the mode it was given. This is the whole
      // point: the guard is only a guard if it is told the truth, and the only
      // way to see what it was told is to ask it.
      assert.equal(ruleResult(res.sentinelVerdict, 'MODE_GUARD').data.mode, mode, `the mode guard saw ${mode} in ${mode}`);
      assert.equal(countRows(h, 'sentinel_decisions'), 1, 'and the allow is recorded exactly once');
    } finally {
      h.cleanup();
    }
  }
});

test('MODE GUARD: the firewall cannot be routed around', () => {
  const h = createHarness();
  try {
    // The Sentinel is only a guard if it is actually consulted, and it is only
    // consulted with the right mode if the firewall passes its own. Both facts
    // are properties of the firewall's source, so they are read from it.
    const src = ExecutionFirewall.prototype.execute.toString();
    assert.ok(
      /mode: this\.#mode/.test(src),
      'the firewall passes its own mode to the Sentinel, so the mode guard cannot be handed a friendlier one',
    );
    assert.ok(
      /sentinelVerdict\.verdict === 'BLOCK'/.test(src) && /sentinelVerdict\.verdict === 'REVIEW'/.test(src),
      'the firewall acts on a Sentinel BLOCK and on a Sentinel REVIEW rather than proceeding regardless',
    );
    assert.ok(ALLOWED_MODES.includes(h.mode), 'the harness is in a mode the firewall can pass');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. The four actions, and what a quarantine leaves behind
// ---------------------------------------------------------------------------

test('SENTINEL ACTIONS: each verdict produces its own action, and the row keeps it', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const T = h.config.sentinel;
    const L = h.config.risk;
    const mid = h.quote().mid;
    const snap = h.account.snapshot();

    // One run per verdict, each reached the way it is reached in production: a
    // WARN from a real condition, a REVIEW from a real quarantine, a BLOCK from
    // a real refusal, and an ALLOW from a clean book.
    const runs = [
      { verdict: ALLOW, build: () => ({}) },
      { verdict: WARN, build: () => ({ proposal: { stopPrice: roundTo(mid * (1 - (T.wideStopWarnPct + 0.5) / 100), 8) } }) },
      // The smallest oversize that is unambiguously a quarantine. Twice the
      // absolute band would also push the exposure projection past the cap, so
      // the run would be a BLOCK and would never reach the quarantine action.
      { verdict: REVIEW, build: () => ({ proposal: { notionalEgp: oversizeNotionalEgp(h) } }) },
      { verdict: BLOCK, build: () => ({ account: { ...snap, exposureEgp: L.maxPortfolioExposureEgp } }) },
    ];

    const observed = new Map();
    let last = null;
    for (const r of runs) {
      const { out } = runSentinel(h, { ...r.build(), decision: h.buyDecision({ price: mid }) });
      assert.equal(out.verdict, r.verdict, `the ${r.verdict} run really produced a ${r.verdict}`);
      assert.equal(out.actionTaken, ACTION_BY_VERDICT[r.verdict], `${r.verdict} carries its own action`);
      assert.ok(SENTINEL_ACTIONS.includes(out.actionTaken), `${r.verdict}: and the action is in the declared vocabulary`);
      observed.set(out.verdict, out.actionTaken);

      const row = persistedSentinelRow(h, out.sentinelDecisionId);
      assert.equal(row.verdict, r.verdict, `${r.verdict}: the row keeps the verdict`);
      assert.equal(row.action_taken, out.actionTaken, `${r.verdict}: and the action`);
      assert.equal(row.policy_version, POLICY_VERSION, `${r.verdict}: with the policy version in force`);
      last = row;
    }

    // Four verdicts, four distinct actions, nothing unreachable.
    assert.equal(observed.size, SENTINEL_VERDICTS.length, 'all four verdicts were reached');
    assert.equal(new Set(observed.values()).size, SENTINEL_VERDICTS.length, 'and each carries a distinct action');
    assert.deepEqual(
      [...observed.values()].sort(), [...SENTINEL_ACTIONS].sort(),
      'the four actions produced are exactly the four the Sentinel declares',
    );

    // The audit chain keeps the per-rule results, so a reviewer can see WHY an
    // action was taken without replaying the decision.
    const rules = JSON.parse(last.rules_json);
    assert.equal(rules.length, RULE_IDS.length, 'the persisted row carries every rule result');
    assert.deepEqual(rules.map((r) => r.rule), RULE_IDS, 'in evaluation order');
  } finally {
    h.cleanup();
  }
});

test('SENTINEL REVIEW: a quarantine is filed for a human, and does not latch', () => {
  const h = createHarness();
  try {
    h.tickMarket();
    const mid = h.quote().mid;
    const notional = oversizeNotionalEgp(h);

    const { out, decision } = runSentinel(h, {
      proposal: { notionalEgp: notional },
    });
    assert.equal(out.verdict, REVIEW, 'the order is quarantined');
    assert.equal(out.actionTaken, ACTION_BY_VERDICT[REVIEW], 'with a quarantine rather than a submission');
    assert.equal(out.triggerRule, 'UNUSUAL_SIZE', 'by the size rule');
    assert.ok(
      out.reason.includes(String(roundEgp(notional))),
      `the reason quotes the EGP size it actually quarantined (got "${out.reason}")`,
    );

    // A quarantine is not submitted anywhere, and it is filed so the dashboard
    // can show what is waiting.
    assert.equal(h.repos.getFlag(REVIEW_PENDING_FLAG), decision.decisionId, 'the waiting decision is named on the control flags');
    const events = h.repos.listEvents({ category: SENTINEL_EVENT_CATEGORY });
    assert.equal(events.length, 1, 'and exactly one operator-visible event is written');
    assert.ok(events[0].message.includes(out.triggerRule), `naming the rule that fired (got "${events[0].message}")`);

    // It is deliberately NOT a latch. One odd order must not be able to stop the
    // agent forever, and the next healthy order has to be unaffected.
    const next = runSentinel(h, { decision: h.buyDecision({ price: mid }) });
    assert.equal(next.out.verdict, ALLOW, 'the next healthy order is unaffected by the quarantine');
    assert.equal(ruleResult(next.out, 'MANUAL_HOLD').verdict, ALLOW, 'and no hold was created');
    assert.equal(h.repos.isFlagSet(MANUAL_HOLD_FLAG), false, 'the hold flag is still clear');
  } finally {
    h.cleanup();
  }
});
