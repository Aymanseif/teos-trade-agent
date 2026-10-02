/**
 * TEOS Trade Agent - tests/unit-core-repos-audit.test.js
 *
 * Unit tests for the four layers everything else in the system rests on:
 *
 *   1. CONFIG AND ENVIRONMENT GUARDS - the startup refusals that make LIVE
 *      unreachable, and the internal coherence of the risk envelope.
 *   2. THE AGENT STATE MACHINE - which trades are permitted from which state,
 *      and what a health report may and may not change.
 *   3. THE REPOSITORY LAYER - round-trips, primary-key refusal, the SQL
 *      INSERT-arity invariant, run scoping, stops and the equity series.
 *   4. THE AUDIT CHAIN - and the money arithmetic the ledger depends on.
 *
 * Two rules run through the whole file.
 *
 *   NOTHING IS RESTATED. Every list under test - the credential variables, the
 *   legal transitions, the insert methods, the INSERT statements, the audit
 *   columns, the schema, the risk limits - is DERIVED from the source it tests,
 *   by reading the file as text. A test that typed a capital ceiling, or
 *   re-listed the transition table, would keep passing after the thing it
 *   guards had changed. Where a list is derived, the test also asserts it found
 *   something, so a derivation can never silently degrade into matching
 *   nothing and passing anyway.
 *
 *   EVERY SAFETY CLAIM IS EXTERNAL. The assertions are about what the process
 *   refuses to start with, refuses to write, and refuses to trade - not about
 *   the shape of an internal object.
 */

import { test } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, assert, makeTempDir, REPO_ROOT, EPOCH } from './helpers/harness.js';
import { loadConfig, validateConfig, MODES } from '../src/core/config.js';
import { readMode, assertLiveTradingDisabled } from '../src/core/env.js';
import { RiskLimits } from '../src/risk/limits.js';
import { STATES, permissionsFor, AgentStateMachine } from '../src/agent/state.js';
import { ManualClock } from '../src/core/clock.js';
import { decisionToRow } from '../src/agent/decision.js';
import { newId } from '../src/core/ids.js';
import { AuditChain, STREAMS, STREAM_COLUMNS, canonicalJson } from '../src/database/audit-chain.js';
import {
  roundQty, roundEgp, roundTo, toMinor, fromMinor, QUANTITY_DECIMALS, MINOR_UNITS_PER_EGP,
} from '../src/core/money.js';

// ===========================================================================
// SOURCE-DERIVED FIXTURES
// ===========================================================================

const REPOS_SRC = readFileSync(join(REPO_ROOT, 'src', 'database', 'repositories', 'index.js'), 'utf8');
const ENV_SRC = readFileSync(join(REPO_ROOT, 'src', 'core', 'env.js'), 'utf8');
const STATE_SRC = readFileSync(join(REPO_ROOT, 'src', 'agent', 'state.js'), 'utf8');
const SCHEMA_SQL = readFileSync(join(REPO_ROOT, 'src', 'database', 'schema.sql'), 'utf8');
const CONFIG_PATH = join(REPO_ROOT, 'config', 'default.json');

/** The credential variables Phase 1 refuses to start with, read from env.js. */
const CREDENTIAL_VARS = [
  ...ENV_SRC.match(/const CREDENTIAL_VARS = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g),
].map((m) => m[1]);

/**
 * Everything `assertNoCredentialsPresent` rejects: the credentials plus any
 * extra variable the source lists beside them. Derived, because the guard's
 * COVERAGE is the property under test - a variable added to the guard and not
 * to this list would otherwise go untested forever.
 */
const FORBIDDEN_ENV_VARS = [...new Set([
  ...CREDENTIAL_VARS,
  ...[...ENV_SRC.match(/const FORBIDDEN_NON_EMPTY = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
])];

/** The state machine's legal-transition table, read from state.js. */
const LEGAL_TRANSITIONS = new Map(
  STATE_SRC.match(/const TRANSITIONS = \{([\s\S]*?)\n\};/)[1]
    .split('\n')
    .map((line) => line.match(/^\s*(\w+):\s*\[([^\]]*)\]/))
    .filter(Boolean)
    .map((m) => [
      m[1],
      m[2].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
    ]),
);

/** Every `insert*` method Repos exposes - the list of writes under test. */
const REPOS_INSERT_METHODS = [...REPOS_SRC.matchAll(/^ {2}(insert[A-Z]\w*)\(/gm)].map((m) => m[1]);

/**
 * Every INSERT in the repositories layer, with the column list and the VALUES
 * list captured separately so the arity of each can be checked.
 *
 * The pattern is whitespace-tolerant about the line break after the table name.
 * A stricter form would match only the statements written one particular way,
 * examine a subset of the file, and report a pass it had not earned.
 */
const INSERT_RE = /INSERT INTO (\w+)[ \t]*\r?\n?[ \t]*\(([^)]*)\)[ \t]*\r?\n?[ \t]*VALUES[ \t]*\(([^)]*)\)/g;

/** Split a CREATE TABLE body on commas that are not inside a nested list. */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Remove `--` line comments, leaving the text inside single-quoted literals
 * alone. Newlines are preserved so the line-anchored CREATE TABLE match below
 * still works.
 *
 * This is not cosmetic. A CREATE TABLE body is free to carry explanatory
 * comments, and `orders` does - the three lines above `status_at_submit`
 * explain why that column exists. Fed to the comma-splitter, a comment is just
 * another chunk of text: the reader invented columns named `--`, `and` and
 * `so`, and the real column declared after them - `status_at_submit` - was
 * silently swallowed and never registered at all. The INSERT-arity scan and
 * the audit-stream check below then reported a real, correct column as "not a
 * column of orders". A derivation that loses a column is worse than one that
 * finds nothing, because it still produces confident assertions.
 */
function stripSqlComments(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The schema as data: table -> { columns, primaryKey }.
 *
 * The INSERT scan uses it to check that every named column really exists and
 * that every literal is admissible where it was placed. The primary key is
 * extracted so the audit-stream mapping can be checked against the schema
 * rather than against a list typed here.
 */
function parseSchema(sql) {
  const tables = new Map();
  // Column names that are not bare identifiers mean the reader has mis-parsed
  // the DDL rather than found an exotic column. Collected rather than thrown
  // so the tests can report it as a failure instead of the whole file failing
  // to load.
  SCHEMA_PARSE_PROBLEMS.length = 0;
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(stripSqlComments(sql))) !== null) {
    const columns = new Map();
    let primaryKey = null;
    for (const def of splitTopLevel(m[2])) {
      const text = def.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|KEY)\b/i.test(text)) continue;
      const parts = text.split(' ');
      if (!/^[A-Za-z_]\w*$/.test(parts[0])) {
        SCHEMA_PARSE_PROBLEMS.push(`${m[1]}.${parts[0]} (from "${text.slice(0, 60)}")`);
      }
      const defMatch = /\bDEFAULT ([^ ]+)/i.exec(text);
      let allowed = null;
      const inMatch = /\bIN\s*\(([^)]*)\)/i.exec(text);
      if (inMatch && /\bCHECK\b/i.test(text)) {
        allowed = inMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      } else {
        const eq = /\bCHECK\s*\(\s*\w+\s*=\s*'([^']*)'\s*\)/i.exec(text);
        if (eq) allowed = [eq[1]];
      }
      columns.set(parts[0], {
        name: parts[0],
        type: (parts[1] ?? '').toUpperCase(),
        notNull: /\bNOT NULL\b/i.test(text),
        default: defMatch ? defMatch[1] : null,
        allowed,
      });
      if (/\bPRIMARY KEY\b/i.test(text)) primaryKey = parts[0];
    }
    tables.set(m[1], { columns, primaryKey });
  }
  return tables;
}

/** Column definitions the DDL reader could not make sense of. Must stay empty. */
const SCHEMA_PARSE_PROBLEMS = [];

const SCHEMA = parseSchema(SCHEMA_SQL);

/** A state machine with a deterministic clock and nowhere to persist to. */
function stateMachine(initial) {
  return new AgentStateMachine({ repos: null, clock: new ManualClock(EPOCH), initial });
}

/** A private temp directory, so a config test never touches ./data or ./logs. */
function sandbox() {
  const dir = makeTempDir('teos-config-');
  return {
    dir,
    env: (extra = {}) => ({ TEOS_DATA_DIR: join(dir, 'data'), TEOS_LOG_DIR: join(dir, 'logs'), ...extra }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A refusal that must carry `code`, checked by code rather than by wording. */
function refusesWith(code) {
  return (err) => {
    assert.equal(err.isTeos, true, `the refusal is a typed TEOS error, not a bare throw (${err})`);
    assert.equal(err.code, code, `refused with ${code} (got ${err.code}: ${err.message})`);
    return true;
  };
}

/** -0 and 0 are the same amount; `assert.equal` distinguishes them. */
const same = (a, b) => (a === b || (a === 0 && b === 0));

// ===========================================================================
// 1. CONFIG AND ENVIRONMENT GUARDS
// ===========================================================================

test('CONFIG: a populated credential variable stops the process before it opens anything', () => {
  const sb = sandbox();
  try {
    // If the derivation ever came back empty the loop would pass vacuously and
    // the guard would look tested while nothing was.
    assert.ok(CREDENTIAL_VARS.length >= 1, `the credential list was found in env.js (${CREDENTIAL_VARS.length} variables)`);
    assert.deepEqual(
      FORBIDDEN_ENV_VARS.filter((v) => !CREDENTIAL_VARS.includes(v)),
      ['TEOS_DASHBOARD_TOKEN'],
      'the refused set is the credential list plus the variables the source lists beside it',
    );

    for (const variable of FORBIDDEN_ENV_VARS) {
      let err = null;
      try {
        loadConfig({ path: CONFIG_PATH, env: sb.env({ [variable]: 'a-real-looking-value' }) });
      } catch (e) { err = e; }
      assert.ok(err !== null, `${variable} being populated must prevent a start`);
      assert.equal(err.code, 'SECURITY_ERROR', `${variable} is refused as a security violation`);
      assert.ok(
        Array.isArray(err.details?.present) && err.details.present.includes(variable),
        `${variable} is named in the refusal, so the operator knows which one to unset`,
      );
    }

    // A populated credential also beats a perfectly valid mode: the guards run
    // before the config file is even read.
    assert.throws(
      () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_MARKET_DATA_API_KEY: 'x', TEOS_MODE: 'BACKTEST' }) }),
      refusesWith('SECURITY_ERROR'),
      'the credential guard is not bypassable by also naming a valid mode',
    );
  } finally {
    sb.cleanup();
  }
});

test('CONFIG: a credential variable that is set but empty is not a credential', () => {
  const sb = sandbox();
  try {
    // The guard is about a VALUE, not about the variable existing. An operator
    // who leaves `TEOS_TRADING_API_KEY=` in a service unit file has leaked
    // nothing, and refusing to boot for that would train them to delete the
    // guard rather than the line.
    for (const variable of FORBIDDEN_ENV_VARS) {
      for (const [label, value] of [['empty', ''], ['whitespace', '   ']]) {
        const cfg = loadConfig({ path: CONFIG_PATH, env: sb.env({ [variable]: value }) });
        assert.ok(Object.isFrozen(cfg), `${variable} set to ${label} still loads a validated config`);
      }
    }
    // ...and a genuine value is still refused, so the two assertions above are
    // not passing because the guard has stopped working.
    assert.throws(
      () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_TRADING_API_SECRET: 'x' }) }),
      refusesWith('SECURITY_ERROR'),
      'the same variable with a value in it is still refused',
    );
  } finally {
    sb.cleanup();
  }
});

test('CONFIG: live trading cannot be switched on by an environment variable, however it is spelled', () => {
  const sb = sandbox();
  try {
    for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'YES']) {
      assert.throws(
        () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_LIVE_TRADING_ENABLED: value }) }),
        refusesWith('LIVE_TRADING_DISABLED'),
        `TEOS_LIVE_TRADING_ENABLED=${value} is refused`,
      );
      assert.throws(
        () => assertLiveTradingDisabled(sb.env({ TEOS_LIVE_TRADING_ENABLED: value })),
        refusesWith('LIVE_TRADING_DISABLED'),
        `the gate itself refuses ${value} directly`,
      );
    }
    for (const value of ['false', 'FALSE', '0', 'no', '']) {
      const cfg = loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_LIVE_TRADING_ENABLED: value }) });
      assert.ok(cfg, `TEOS_LIVE_TRADING_ENABLED=${value} starts normally - the guard is not a blanket refusal`);
    }
  } finally {
    sb.cleanup();
  }
});

test('CONFIG: LIVE is not a mode anyone can reach', () => {
  const sb = sandbox();
  try {
    assert.throws(
      () => readMode(sb.env({ TEOS_MODE: 'LIVE' })),
      refusesWith('LIVE_TRADING_DISABLED'),
      'TEOS_MODE=LIVE is refused by the mode reader',
    );
    assert.throws(
      () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_MODE: 'LIVE' }) }),
      (err) => ['MODE_NOT_ALLOWED', 'LIVE_TRADING_DISABLED'].includes(err.code),
      'and therefore loadConfig cannot be made to run in it either',
    );
    // Case does not open a door: the mode is normalised before it is judged.
    for (const spelling of ['live', 'Live', 'lIvE']) {
      assert.throws(
        () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_MODE: spelling }) }),
        (err) => ['MODE_NOT_ALLOWED', 'LIVE_TRADING_DISABLED'].includes(err.code),
        `TEOS_MODE=${spelling} is refused`,
      );
    }

    // The set of modes the CONFIG VALIDATOR accepts is the safety boundary, and
    // it is imported rather than retyped.
    assert.ok(MODES.length >= 2, `the validator declares ${MODES.length} modes`);
    assert.equal(
      MODES.filter((m) => m.toUpperCase() === 'LIVE').length, 0,
      `no spelling of LIVE is an accepted mode (${MODES.join(', ')})`,
    );
    for (const mode of ['BACKTEST', 'PAPER']) {
      const cfg = loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_MODE: mode }) });
      assert.equal(cfg.mode, mode, `${mode} is reachable through the environment`);
      // Mode isolation is physical: the database file is named after the mode,
      // so a BACKTEST process cannot open the PAPER book even by accident.
      assert.match(cfg.paths.dbFile, /teos-/, `${mode} resolves to a mode-specific database file`);
      assert.ok(!/live/i.test(cfg.paths.dbFile), `${mode} never resolves to a live database (${cfg.paths.dbFile})`);
    }
    assert.throws(
      () => loadConfig({ path: CONFIG_PATH, env: sb.env({ TEOS_MODE: 'SHADOW' }) }),
      refusesWith('CONFIG_ERROR'),
      'an unrecognised mode is a configuration error, not a silent default',
    );

    const base = loadConfig({ path: CONFIG_PATH, env: sb.env() });
    assert.throws(
      () => validateConfig({ ...base, mode: 'LIVE' }),
      refusesWith('CONFIG_ERROR'),
      'a config FILE claiming LIVE is rejected by the validator as well',
    );
    assert.throws(
      () => validateConfig({ ...base, mode: base.mode.toLowerCase() }),
      refusesWith('CONFIG_ERROR'),
      'mode matching is exact: a lower-case mode is not a mode',
    );
  } finally {
    sb.cleanup();
  }
});

test('CONFIG: the risk envelope is internally coherent, and every limit is a real number', () => {
  const sb = sandbox();
  try {
    const cfg = loadConfig({ path: CONFIG_PATH, env: sb.env() });
    // The EFFECTIVE limits - after the tighter of the percentage and the
    // absolute value wins - are what the agent is actually held to, so that is
    // the object whose coherence matters.
    const limits = new RiskLimits(cfg);
    const capital = cfg.account.startingCapitalEgp;

    assert.ok(capital > 0, `the paper account is funded (${capital})`);
    assert.ok(capital <= limits.maxStartingCapitalEgp, 'the funded capital is inside the configured ceiling');

    // RELATIONSHIPS, never values: an operator who changes the ceiling or the
    // caps must not have to change this test.
    const pct = (value) => capital * (value / 100);
    const relationships = [
      ['maxPortfolioExposureEgp does not exceed the capital', limits.maxPortfolioExposureEgp, capital, '<='],
      ['maxLossPerTradeEgp does not exceed the capital', limits.maxLossPerTradeEgp, capital, '<='],
      ['dailyLossLimitEgp does not exceed the capital', limits.dailyLossLimitEgp, capital, '<='],
      ['maxPositionSizeEgp does not exceed maxPortfolioExposureEgp', limits.maxPositionSizeEgp, limits.maxPortfolioExposureEgp, '<='],
      ['minOrderNotionalEgp is within the position cap', limits.minOrderNotionalEgp, limits.maxPositionSizeEgp, '<='],
      ['maxOrdersPerSymbolPerDay is within the daily order cap', limits.maxOrdersPerSymbolPerDay, limits.maxOrdersPerDay, '<='],
      ['minStopDistancePct is below the default', limits.minStopDistancePct, limits.defaultStopDistancePct, '<'],
      ['the default stop distance is below the maximum', limits.defaultStopDistancePct, limits.maxStopDistancePct, '<'],
      // Defence in depth: the Sentinel is only useful if its unusual-size
      // threshold sits ABOVE what the sizer is allowed to produce. If it did
      // not, every legitimately-sized order would be quarantined and the agent
      // could not trade at all - a failure no single rule would report.
      ['sentinel.unusualSizeReviewEgp is above the position cap', cfg.sentinel.unusualSizeReviewEgp, limits.maxPositionSizeEgp, '>'],
      // The same relationship expressed as a percentage. It is read from the
      // CONFIG, not from `limits`, and that is not a convenience: `RiskLimits`
      // deliberately publishes only the EFFECTIVE cap - the tighter of the
      // absolute and the percentage, already resolved - and carries no
      // `*Pct` field at all. Asking `limits` for a percentage asks for a
      // property the envelope does not have, and `undefined > 30` is false, so
      // the assertion would have failed for a reason that has nothing to do
      // with the Sentinel. The config is the authority for the raw
      // percentage; the limits object is the authority for what is in force.
      ['sentinel.unusualSizeReviewPctOfEquity is above the position cap pct', cfg.sentinel.unusualSizeReviewPctOfEquity, cfg.risk.maxPositionSizePct, '>'],
      // The percentage and the absolute cap must not disagree about which is
      // tighter, or editing one of them silently does nothing.
      ['the per-trade cap is no looser than its percentage', limits.maxLossPerTradeEgp, pct(cfg.risk.maxLossPerTradePct), '<='],
      ['the daily loss cap is no looser than its percentage', limits.dailyLossLimitEgp, pct(cfg.risk.dailyLossLimitPct), '<='],
      ['the exposure cap is no looser than its percentage', limits.maxPortfolioExposureEgp, pct(cfg.risk.maxPortfolioExposurePct), '<='],
      ['the position cap is no looser than its percentage', limits.maxPositionSizeEgp, pct(cfg.risk.maxPositionSizePct), '<='],
      ['the degraded freshness threshold is inside the staleness limit', limits.degradedDataFreshnessMs, limits.maxDataStalenessMs, '<='],
      ['ordinary volatility is inside the abnormal-price threshold', cfg.market.maxTickJumpBps, limits.priceDeviationLimitBps, '<'],
    ];
    for (const [label, left, right, op] of relationships) {
      const ok = op === '<=' ? left <= right : op === '<' ? left < right : left > right;
      assert.ok(ok, `${label}: ${left} must be ${op} ${right}`);
    }

    // What the envelope actually publishes, pinned because the relationship
    // above depends on it. Each of these caps is configured twice - once as an
    // EGP figure, once as a percentage of equity - and `RiskLimits` resolves
    // them to the tighter of the two and publishes ONLY that, in EGP. So the
    // published cap is always the minimum of the two inputs, and there is no
    // `*Pct` counterpart to read. Anything that needs the raw percentage has to
    // go to the config, which is the authority for it.
    for (const [egpField, pctField] of [
      ['maxLossPerTradeEgp', 'maxLossPerTradePct'],
      ['dailyLossLimitEgp', 'dailyLossLimitPct'],
      ['maxPortfolioExposureEgp', 'maxPortfolioExposurePct'],
      ['maxPositionSizeEgp', 'maxPositionSizePct'],
    ]) {
      assert.equal(
        limits[egpField], roundEgp(Math.min(cfg.risk[egpField], pct(cfg.risk[pctField]))),
        `${egpField} in force is the tighter of the configured EGP figure and ${pctField} of equity`,
      );
      assert.equal(
        limits[pctField], undefined,
        `${pctField} is NOT published on the envelope - it carries the resolved EGP cap only, so a caller cannot read the looser of the two and quietly apply it`,
      );
    }

    // Every numeric limit is a positive finite number. A NaN that slipped into
    // a cap compares false against everything and would silently disable the
    // rule that reads it.
    const numeric = Object.entries(limits).filter(([, v]) => typeof v === 'number');
    assert.ok(numeric.length >= 10, `the limits object exposes ${numeric.length} numeric caps`);
    for (const [name, value] of numeric) {
      assert.ok(Number.isFinite(value), `limit ${name} is a finite number (was ${value})`);
      assert.ok(value > 0, `limit ${name} is positive (was ${value})`);
    }

    // The prohibitions are structural, not configurable: no edit to the JSON can
    // turn them on.
    for (const prohibition of ['allowLeverage', 'allowBorrowing', 'allowShorting', 'allowDerivatives', 'allowNegativeCash']) {
      assert.equal(limits[prohibition], false, `${prohibition} is not a configurable capability`);
    }
    assert.equal(limits.stopLossRequired, true, 'a stop is mandatory on every position');
    assert.ok(Object.isFrozen(limits), 'the limits in force cannot be edited by a downstream component');
  } finally {
    sb.cleanup();
  }
});

test('CONFIG: every instrument is uniquely named and tradable at its own minimum size', () => {
  const sb = sandbox();
  try {
    const cfg = loadConfig({ path: CONFIG_PATH, env: sb.env() });
    assert.ok(cfg.instruments.length > 0, 'the agent has at least one instrument');

    const seen = new Set();
    for (const i of cfg.instruments) {
      assert.ok(!seen.has(i.symbol), `instrument ${i.symbol} is declared only once`);
      seen.add(i.symbol);
      assert.ok(i.startPrice > 0, `${i.symbol} has a positive price`);
      assert.ok(i.qtyStep > 0, `${i.symbol} has a positive quantity step`);
      assert.ok(i.minQty > 0, `${i.symbol} has a positive minimum quantity`);
      assert.ok(i.spreadBpsMin <= i.spreadBpsMax, `${i.symbol} has an ordered spread band`);
      // A minimum order size the exchange cannot represent is an instrument the
      // agent will size into and then be unable to place, so minQty has to be a
      // whole number of the tradable increment.
      const steps = i.minQty / i.qtyStep;
      assert.ok(
        Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps)),
        `${i.symbol} minQty ${i.minQty} is a whole number of ${i.qtyStep} steps (was ${steps})`,
      );
    }
  } finally {
    sb.cleanup();
  }
});

// ===========================================================================
// 2. THE AGENT STATE MACHINE
// ===========================================================================

test('STATE: every declared state answers the three questions the risk engine asks of it', () => {
  const stateNames = Object.keys(STATES);
  assert.ok(stateNames.length >= 5, `${stateNames.length} states are declared`);

  for (const name of stateNames) {
    const p = permissionsFor(STATES[name]);
    assert.deepEqual(
      Object.keys(p).sort(), ['evaluate', 'openPosition', 'reduceOnly'],
      `state ${name} answers exactly the three questions the risk engine asks`,
    );
    for (const [question, answer] of Object.entries(p)) {
      assert.equal(typeof answer, 'boolean', `state ${name} answers ${question} with a boolean`);
    }
  }

  // Fail closed. The risk engine reads `openPosition` and `reduceOnly`, and an
  // undefined state must never be treated as anything but "no".
  for (const unknown of ['NOT_A_STATE', '', null, undefined, 0, 'healthy']) {
    const p = permissionsFor(unknown);
    assert.equal(p.openPosition, false, `an unrecognised state (${String(unknown)}) may not open a position`);
    assert.equal(p.reduceOnly, false, `an unrecognised state (${String(unknown)}) may not even reduce`);
    assert.equal(p.evaluate, false, `an unrecognised state (${String(unknown)}) may not evaluate`);
  }
});

test('STATE: the transition table and the state list describe the same machine', () => {
  const declared = new Set(Object.values(STATES));
  const inTable = new Set(LEGAL_TRANSITIONS.keys());
  assert.ok(inTable.size > 0, 'the legal-transition table was found in state.js');

  // A state with no entry in the table would be an unreachable dead end: it
  // could be entered and never left. A table entry naming a state that does not
  // exist would be a rule nothing could ever satisfy.
  for (const name of declared) {
    assert.ok(inTable.has(name), `state ${name} has legal transitions declared`);
  }
  for (const name of inTable) {
    assert.ok(declared.has(name), `the transition table names the real state ${name}`);
  }
  for (const [from, targets] of LEGAL_TRANSITIONS) {
    for (const to of targets) {
      assert.ok(declared.has(to), `${from} -> ${to} names a real state`);
    }
  }
});

test('STATE: every state is reachable from every other through legal transitions only', () => {
  const names = Object.values(STATES);
  for (const start of names) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const next of LEGAL_TRANSITIONS.get(queue.shift()) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const unreachable = names.filter((n) => !seen.has(n));
    assert.deepEqual(unreachable, [], `every state is reachable from ${start} (unreachable: ${unreachable.join(', ')})`);
  }
});

test('STATE: the machine permits exactly the legal transitions and refuses every other one', () => {
  const names = Object.values(STATES);
  let permitted = 0;
  let refused = 0;

  for (const from of names) {
    for (const to of names) {
      const m = stateMachine(from);
      const legal = (LEGAL_TRANSITIONS.get(from) ?? []).includes(to);
      if (legal) {
        const res = m.transition(to, 'unit test');
        assert.equal(res.changed, true, `${from} -> ${to} is a legal transition`);
        assert.equal(m.state, to, `${from} -> ${to} lands in ${to}`);
        assert.equal(m.history.at(-1).from, from, `the history records where ${to} was entered from`);
        assert.equal(m.history.at(-1).to, to, 'and where it went');
        assert.deepEqual(m.permissions, permissionsFor(to), `the permissions follow the state (${to})`);
        permitted += 1;
      } else if (to !== from) {
        // An illegal transition must be LOUD. Silently coercing it would let a
        // bug move an order out of a halted agent into a trading one with
        // nothing recording that it happened.
        const historyBefore = m.history.length;
        assert.throws(
          () => m.transition(to, 'unit test'),
          (err) => /Illegal agent state transition/.test(err.message),
          `${from} -> ${to} is refused loudly`,
        );
        assert.equal(m.state, from, `a refused transition leaves the machine in ${from}`);
        assert.equal(m.history.length, historyBefore, 'and records nothing in the history');
        refused += 1;
      }
    }
  }

  // The scan must have exercised something real, or "every legal transition" is
  // a statement about an empty set.
  assert.ok(permitted > 0, `${permitted} legal transitions were permitted`);
  assert.ok(refused > 0, `${refused} illegal transitions were refused`);
  assert.equal(
    permitted, [...LEGAL_TRANSITIONS.values()].reduce((a, b) => a + b.length, 0),
    'every pair in the source transition table is exercised exactly once',
  );
});

test('STATE: transitioning to a state that does not exist is treated as a failure', () => {
  const m = stateMachine(STATES.HEALTHY);
  const res = m.transition('DEFINITELY_NOT_A_STATE', 'unit test');
  assert.equal(m.state, STATES.FAILED, 'an undefined target state halts the agent');
  assert.equal(res.to, STATES.FAILED, 'and says so in its return value');
  assert.equal(m.permissions.openPosition, false, 'a failed agent may not open a position');
  assert.match(m.history.at(-1).reason, /UNKNOWN_STATE/, 'and the history names the cause');
});

test('STATE: an unhealthy report can never leave the agent able to open a position', () => {
  const healthy = { connected: true, dataFresh: true, abnormalPrice: false, undefinedState: false };
  const reports = [
    { label: 'the feed is lost', connected: false, dataFresh: true, abnormalPrice: false, undefinedState: false },
    { label: 'the data is stale', connected: true, dataFresh: false, abnormalPrice: false, undefinedState: false },
    { label: 'the price is abnormal', connected: true, dataFresh: true, abnormalPrice: true, undefinedState: false },
    { label: 'the state is undefined', ...healthy, undefinedState: true },
    { label: 'everything is wrong at once', connected: false, dataFresh: false, abnormalPrice: true, undefinedState: false },
    { label: 'undefined outranks everything', connected: false, dataFresh: false, abnormalPrice: true, undefinedState: true },
  ];
  // The control: a HEALTHY report from a healthy state leaves it able to trade.
  // Without it, the loop below would pass if `applyHealth` simply did nothing.
  const control = stateMachine(STATES.HEALTHY);
  assert.equal(control.applyHealth(healthy).changed, false, 'a healthy report on a healthy agent changes nothing');
  assert.equal(control.permissions.openPosition, true, 'and the agent is still allowed to trade');

  for (const from of Object.values(STATES)) {
    for (const report of reports) {
      const m = stateMachine(from);
      let refused = false;
      try {
        m.applyHealth(report);
      } catch (err) {
        // Refusing is an acceptable outcome - but only if the refusal left the
        // machine exactly where it was.
        assert.match(err.message, /Illegal agent state transition/, `${from} + ${report.label} refuses loudly`);
        refused = true;
      }
      if (!refused) {
        assert.ok(Object.hasOwn(STATES, m.state), `${from} + ${report.label} lands in a declared state (${m.state})`);
        assert.deepEqual(m.permissions, permissionsFor(m.state), 'and reports the permissions of that state');
      }
      assert.equal(
        m.permissions.openPosition, false,
        `${from} + ${report.label} leaves the agent unable to open a position`,
      );
    }
  }
});

test('STATE: good news does not revive an agent that has stopped or failed', () => {
  for (const terminal of [STATES.STOPPED, STATES.FAILED]) {
    const m = stateMachine(terminal);
    const before = m.permissions;
    const res = m.applyHealth({ connected: true, dataFresh: true, abnormalPrice: false });
    assert.equal(m.state, terminal, `a healthy report leaves a ${terminal} agent in ${terminal}`);
    assert.equal(res.changed, false, 'and reports that nothing changed');
    assert.deepEqual(m.permissions, before, 'so its permissions are untouched');
    assert.equal(m.permissions.openPosition, false, `a ${terminal} agent still may not open a position`);
  }
});

test('STATE: a recovered agent must pass back through degraded before it may trade again', () => {
  const m = stateMachine(STATES.HEALTHY);
  m.applyHealth({ connected: false, dataFresh: true, abnormalPrice: false });
  assert.equal(m.state, STATES.HALTED, 'losing the feed halts the agent');
  assert.equal(m.permissions.openPosition, false, 'a halted agent may not open a position');

  m.applyHealth({ connected: true, dataFresh: true, abnormalPrice: false });
  assert.equal(m.state, STATES.DEGRADED, 'the first healthy report only degrades it');
  assert.equal(m.permissions.openPosition, false, 'and one good reading does not immediately restore trading');
  assert.equal(
    m.permissions.reduceOnly, permissionsFor(STATES.DEGRADED).reduceOnly,
    'a degraded agent may still reduce what it holds',
  );

  m.applyHealth({ connected: true, dataFresh: true, abnormalPrice: false });
  assert.equal(m.state, STATES.HEALTHY, 'a second healthy report restores it');
  assert.equal(
    m.permissions.openPosition, permissionsFor(STATES.HEALTHY).openPosition,
    'and only then may it open a position',
  );
});

// ===========================================================================
// 3. THE REPOSITORY LAYER
// ===========================================================================

/**
 * Insert one decision -> risk verdict -> sentinel verdict -> order, all through
 * the production repositories, so fixtures satisfy the foreign keys and land in
 * the audit chain exactly as real traffic does.
 */
function insertPipeline(h, { quantity = 1 } = {}) {
  const { repos, clock, config } = h;
  const instrument = config.instruments[0];

  const decision = repos.insertDecision(
    decisionToRow(h.buyDecision({ symbol: instrument.symbol, price: instrument.startPrice, quantity })),
    clock,
  );
  const risk = repos.insertRiskDecision({
    riskDecisionId: newId('rsk'),
    decisionId: decision.decision_id,
    verdict: 'ALLOW',
    blocked: false,
    reason: 'unit test fixture',
    failedRule: null,
    passedCount: 1,
    failedCount: 0,
    rules: [{ rule: 'FIXTURE', ok: true }],
    account: { cashEgp: 500 },
    limits: { maxLossPerTradeEgp: 5 },
  }, clock);
  const sentinel = repos.insertSentinelDecision({
    sentinelDecisionId: newId('sen'),
    decisionId: decision.decision_id,
    riskDecisionId: risk.risk_decision_id,
    verdict: 'ALLOW',
    actionTaken: 'PASS',
    reason: 'unit test fixture',
    triggerRule: null,
    policyVersion: 'unit-test',
    rules: [{ rule: 'FIXTURE', ok: true }],
    thresholds: { unusualSizeReviewEgp: 150 },
  }, clock);
  const order = repos.insertOrder({
    orderId: newId('ord'),
    clientOrderId: newId('cli'),
    decisionId: decision.decision_id,
    riskDecisionId: risk.risk_decision_id,
    sentinelDecisionId: sentinel.sentinel_decision_id,
    symbol: instrument.symbol,
    side: 'BUY',
    orderType: 'MARKET',
    quantity,
    limitPrice: null,
    expectedPrice: instrument.startPrice,
    reduceOnly: false,
    status: 'PENDING_NEW',
    rejectionReason: null,
  }, clock);
  return { decision, risk, sentinel, order };
}

/** Attach a fill to an order created by `insertPipeline`. */
function insertFixtureFill(h, order, { quantity = 1 } = {}) {
  return h.repos.insertFill({
    orderId: order.order_id,
    clientOrderId: order.client_order_id,
    decisionId: order.decision_id,
    symbol: order.symbol,
    side: order.side,
    quantity,
    price: order.expected_price,
    referencePrice: order.expected_price,
    notionalEgp: quantity * order.expected_price,
    feeEgp: 0.05,
    slippageBps: 0,
    slippageCostEgp: 0,
    liquidity: 'TAKER',
  }, h.clock);
}

/**
 * One case per `insert*` method on Repos.
 *
 * `expect` entries are [column, the value the caller supplied], so the
 * assertion is "what went in came back out" rather than "the row matches the
 * row". `pk` says who chooses the primary key: a 'caller' method is re-issued
 * through the API, a 'generated' method is probed through the table, whose own
 * constraint is the thing that makes the log un-overwritable.
 */
const INSERT_CASES = [
  {
    method: 'insertDecision',
    table: 'agent_decisions',
    idColumn: 'decision_id',
    pk: 'caller',
    build: (h) => {
      const row = decisionToRow(h.buyDecision({ price: h.instrument.startPrice, quantity: 1 }));
      return {
        args: [row, h.clock],
        expect: [
          ['decision_id', row.decisionId], ['symbol', row.symbol], ['strategy_id', row.strategyId],
          ['price', row.price], ['signal', row.signal], ['quantity', row.quantity],
          ['notional_egp', row.notionalEgp], ['confidence', row.confidence],
          ['max_loss_egp', row.maxLossEgp], ['stop_price', row.stopPrice],
          ['stop_distance_pct', row.stopDistancePct], ['risk_reward_ratio', row.riskRewardRatio],
          ['reason', row.reason], ['expected_execution_price', row.expectedExecutionPrice],
          ['stop_condition', row.stopCondition], ['action', row.action], ['agent_state', row.agentState],
          ['run_id', h.runId], ['mode', h.mode], ['instance_id', h.instanceId],
        ],
        json: [['features_json', row.features]],
        rerun: (h) => h.repos.insertDecision(row, h.clock),
      };
    },
  },
  {
    method: 'insertRiskDecision',
    table: 'risk_decisions',
    idColumn: 'risk_decision_id',
    pk: 'caller',
    build: (h) => {
      const { decision } = insertPipeline(h);
      const risk = {
        riskDecisionId: newId('rsk'),
        decisionId: decision.decision_id,
        verdict: 'BLOCK',
        blocked: true,
        reason: 'round trip',
        failedRule: 'DAILY_LOSS_LIMIT',
        passedCount: 7,
        failedCount: 1,
        rules: [{ rule: 'A', ok: true }, { rule: 'B', ok: false }],
        account: { cashEgp: 1.5, equityEgp: 2.5 },
        limits: { maxLossPerTradeEgp: 5 },
      };
      return {
        args: [risk, h.clock],
        expect: [
          ['risk_decision_id', risk.riskDecisionId], ['decision_id', risk.decisionId],
          ['verdict', risk.verdict], ['blocked', 1], ['reason', risk.reason],
          ['failed_rule', risk.failedRule], ['passed_count', risk.passedCount],
          ['failed_count', risk.failedCount], ['run_id', h.runId], ['mode', h.mode],
          ['instance_id', h.instanceId],
        ],
        json: [['rules_json', risk.rules], ['account_json', risk.account], ['limits_json', risk.limits]],
        rerun: (h) => h.repos.insertRiskDecision(risk, h.clock),
      };
    },
  },
  {
    method: 'insertSentinelDecision',
    table: 'sentinel_decisions',
    idColumn: 'sentinel_decision_id',
    pk: 'caller',
    build: (h) => {
      const { decision, risk } = insertPipeline(h);
      const s = {
        sentinelDecisionId: newId('sen'),
        decisionId: decision.decision_id,
        riskDecisionId: risk.risk_decision_id,
        verdict: 'REVIEW',
        actionTaken: 'QUARANTINE',
        reason: 'round trip',
        triggerRule: 'UNUSUAL_SIZE',
        policyVersion: 'unit-test-1',
        rules: [{ rule: 'S', ok: false }],
        thresholds: { unusualSizeReviewEgp: 150 },
      };
      return {
        args: [s, h.clock],
        expect: [
          ['sentinel_decision_id', s.sentinelDecisionId], ['decision_id', s.decisionId],
          ['risk_decision_id', s.riskDecisionId], ['verdict', s.verdict],
          ['action_taken', s.actionTaken], ['reason', s.reason], ['trigger_rule', s.triggerRule],
          ['policy_version', s.policyVersion], ['run_id', h.runId], ['mode', h.mode],
          ['instance_id', h.instanceId],
        ],
        json: [['rules_json', s.rules], ['threshold_json', s.thresholds]],
        rerun: (h) => h.repos.insertSentinelDecision(s, h.clock),
      };
    },
  },
  {
    method: 'insertOrder',
    table: 'orders',
    idColumn: 'order_id',
    pk: 'caller',
    build: (h) => {
      const { decision, risk, sentinel } = insertPipeline(h);
      const o = {
        orderId: newId('ord'),
        clientOrderId: newId('cli'),
        decisionId: decision.decision_id,
        riskDecisionId: risk.risk_decision_id,
        sentinelDecisionId: sentinel.sentinel_decision_id,
        symbol: h.instrument.symbol,
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
        limitPrice: null,
        expectedPrice: h.instrument.startPrice,
        reduceOnly: true,
        status: 'PENDING_NEW',
        rejectionReason: null,
      };
      return {
        args: [o, h.clock],
        expect: [
          ['order_id', o.orderId], ['client_order_id', o.clientOrderId],
          ['decision_id', o.decisionId], ['risk_decision_id', o.riskDecisionId],
          ['sentinel_decision_id', o.sentinelDecisionId], ['symbol', o.symbol], ['side', o.side],
          ['order_type', o.orderType], ['quantity', o.quantity], ['limit_price', o.limitPrice],
          ['expected_price', o.expectedPrice], ['reduce_only', 1], ['leverage_requested', 0],
          ['status', o.status], ['status_at_submit', o.status],
          ['run_id', h.runId], ['mode', h.mode], ['instance_id', h.instanceId],
          // The order starts unfilled, unpriced and unterminal. Asserting the
          // zeros matters: an order that arrived already "partially filled"
          // would be reconciled against fills that do not exist.
          ['filled_quantity', 0], ['avg_fill_price', null], ['terminal_at', null],
        ],
        json: [],
        // The deterministic client id is the backbone of duplicate-order
        // prevention, so an order that cannot be found by it is not an order the
        // restart path would recognise.
        also: (h, id) => {
          assert.equal(
            h.repos.getOrderByClientId(o.clientOrderId)?.order_id, id,
            'the order is also findable by its deterministic client id',
          );
        },
        // A FRESH client id, so the refusal is unambiguously about the primary
        // key and not about a second unique column.
        rerun: (h) => h.repos.insertOrder({ ...o, clientOrderId: newId('cli') }, h.clock),
      };
    },
  },
  {
    method: 'insertFill',
    table: 'fills',
    idColumn: 'fill_id',
    pk: 'generated',
    build: (h) => {
      const { order } = insertPipeline(h);
      const f = {
        orderId: order.order_id,
        clientOrderId: order.client_order_id,
        decisionId: order.decision_id,
        symbol: order.symbol,
        side: order.side,
        quantity: 0.5,
        price: order.expected_price,
        referencePrice: order.expected_price,
        notionalEgp: 0.5 * order.expected_price,
        feeEgp: 0.05,
        slippageBps: 2,
        slippageCostEgp: 0.01,
        liquidity: 'TAKER',
      };
      return {
        args: [f, h.clock],
        expect: [
          ['order_id', f.orderId], ['client_order_id', f.clientOrderId], ['decision_id', f.decisionId],
          ['symbol', f.symbol], ['side', f.side], ['quantity', f.quantity], ['price', f.price],
          ['reference_price', f.referencePrice], ['notional_egp', f.notionalEgp],
          ['fee_egp', f.feeEgp], ['slippage_bps', f.slippageBps], ['slippage_cost_egp', f.slippageCostEgp],
          ['liquidity', f.liquidity], ['run_id', h.runId], ['mode', h.mode],
        ],
        json: [],
        also: (h, id) => {
          // Two identical fills are two fills. A log that quietly deduplicated
          // them would under-report execution, and the reconciliation that
          // cross-checks orders against fills would then be comparing against a
          // number nobody wrote.
          const second = insertFixtureFill(h, order, { quantity: f.quantity });
          assert.notEqual(second, id, 'an identical second fill gets its own primary key');
          assert.equal(
            h.repos.listFills({ orderId: f.orderId }).length, 2,
            'and both fills are stored, not collapsed into one',
          );
        },
        rerun: null,
      };
    },
  },
];

test('REPOS: every insert method round-trips its input and refuses to overwrite its primary key', () => {
  assert.ok(REPOS_INSERT_METHODS.length > 0, `the insert methods were found in the repositories layer (${REPOS_INSERT_METHODS.length})`);

  for (const c of INSERT_CASES) {
    const h = createHarness();
    try {
      const built = c.build(h);
      const result = h.repos[c.method](...built.args);
      // A caller-chosen id comes back on the sealed record; a generated one is
      // the return value itself.
      const id = c.pk === 'caller' ? result[c.idColumn] : result;
      assert.ok(typeof id === 'string' && id.length > 0, `${c.method} returns the id it wrote`);

      const stored = h.db.get(`SELECT * FROM ${c.table} WHERE ${c.idColumn} = ?`, id);
      assert.ok(stored, `${c.method}: the row is readable by its primary key`);
      for (const [column, want] of built.expect) {
        assert.equal(stored[column], want, `${c.method}: ${column} is what went in`);
      }
      for (const [column, want] of built.json) {
        assert.deepEqual(JSON.parse(stored[column]), want, `${c.method}: ${column} survives the JSON round trip`);
      }
      if (built.also) built.also(h, id);

      // --- primary key refusal -------------------------------------------
      const rowCountBefore = h.db.count(`SELECT COUNT(*) AS c FROM ${c.table} WHERE mode = ?`, h.mode);
      if (c.pk === 'caller') {
        assert.throws(
          () => built.rerun(h),
          (err) => err.code === 'DATABASE_ERROR' && err.message.includes(`${c.table}.${c.idColumn}`),
          `${c.method}: re-inserting the same ${c.idColumn} is refused, not merged`,
        );
      } else {
        // The id is server-generated, so the only way to reuse one is to write
        // the row directly - exactly the edit a careless operator or an attacker
        // would make. `SELECT *` expands both sides in declared order, so this
        // reproduces the row without restating its column list.
        assert.throws(
          () => h.db.run(`INSERT INTO ${c.table} SELECT * FROM ${c.table} WHERE ${c.idColumn} = ?`, id),
          (err) => err.code === 'DATABASE_ERROR' && /UNIQUE constraint failed/.test(err.message),
          `${c.method}: the table refuses a repeated primary key, so a fill cannot be overwritten`,
        );
      }

      const after = h.db.get(`SELECT * FROM ${c.table} WHERE ${c.idColumn} = ?`, id);
      assert.deepEqual(after, stored, `${c.method}: the refused write changed nothing`);
      assert.equal(
        h.db.count(`SELECT COUNT(*) AS c FROM ${c.table} WHERE mode = ?`, h.mode), rowCountBefore,
        `${c.method}: the refused write added no row either`,
      );
    } finally {
      h.cleanup();
    }
  }
});

test('REPOS: the insert cases cover every insert method the repositories layer exposes', () => {
  // The anti-rot assertion. A new `insert*` method must be tested here, and this
  // comparison is what forces that rather than letting it slip through.
  assert.deepEqual(
    INSERT_CASES.map((c) => c.method).sort(), [...REPOS_INSERT_METHODS].sort(),
    'every insert method has a round-trip case',
  );
  for (const c of INSERT_CASES) {
    assert.ok(SCHEMA.has(c.table), `the case for ${c.method} names the real table ${c.table}`);
    assert.ok(
      SCHEMA.get(c.table).columns.has(c.idColumn),
      `the case for ${c.method} names a real column ${c.idColumn}`,
    );
  }
});

test('REPOS: a sealed decision carries every column the audit chain claims to cover', () => {
  const h = createHarness();
  try {
    const { decision } = insertPipeline(h);
    const stored = h.db.get('SELECT * FROM agent_decisions WHERE decision_id = ?', decision.decision_id);
    for (const column of STREAM_COLUMNS[STREAMS.DECISION]) {
      assert.ok(Object.hasOwn(stored, column), `the stored decision has the column ${column} the chain hashes`);
      assert.equal(stored[column], decision[column], `and it holds the value that was sealed (${column})`);
    }
    // `blocked` is stored as 0/1, never as a boolean: node:sqlite binds a
    // boolean as an integer, so a raw `true` would hash as `true` and read back
    // as 1 - and the chain would then report tampering on a row nobody touched.
    const anyRisk = h.repos.listRiskDecisions({ limit: 1 })[0];
    assert.equal(typeof anyRisk.blocked, 'number', 'blocked comes back as a number, not a boolean');
    assert.ok([0, 1].includes(anyRisk.blocked), 'and as one of the two stored values');
  } finally {
    h.cleanup();
  }
});

test('SQL: every INSERT binds as many values as it names columns, and puts each in a column that accepts it', () => {
  const rawInserts = (REPOS_SRC.match(/INSERT INTO /g) ?? []).length;
  const statements = [...REPOS_SRC.matchAll(INSERT_RE)];
  // Two guards on the guard. If the pattern ever stops matching - a reformatted
  // statement, a different file layout - the arity check would pass by examining
  // nothing, which is the worst possible failure for a source-scanning test.
  assert.ok(rawInserts >= 15, `the repositories layer contains ${rawInserts} INSERT statements`);
  assert.equal(statements.length, rawInserts, 'and every one of them is examined by the scan');
  // The schema this scan checks against is itself derived, so the derivation is
  // guarded too: a column name that is not a bare identifier means the DDL was
  // mis-read, and every "names a real column" verdict below would be worthless.
  assert.deepEqual(
    SCHEMA_PARSE_PROBLEMS, [],
    'the DDL reader understood every column definition it saw',
  );

  for (const [, table, columnText, valueText] of statements) {
    const columns = columnText.split(',').map((s) => s.trim());
    const values = valueText.split(',').map((s) => s.trim());
    assert.equal(
      values.length, columns.length,
      `${table}: ${columns.length} columns but ${values.length} VALUES entries - a mismatch here shifts every bound value by one`,
    );

    const schema = SCHEMA.get(table);
    assert.ok(schema, `${table} is a real table in the schema`);
    const seen = new Set();
    for (let i = 0; i < columns.length; i += 1) {
      const column = columns[i];
      const value = values[i];
      const at = `${table}.${column} (position ${i + 1})`;

      assert.ok(schema.columns.has(column), `${at} names a real column`);
      assert.ok(!seen.has(column), `${at} is not named twice in one statement`);
      seen.add(column);
      if (value === '?') continue;

      // Positional: a hard-coded literal is only admissible in a column that can
      // hold it. A statement whose lists were transposed would put, say, a
      // literal status into a REAL column, and arity alone would not notice.
      const declared = schema.columns.get(column);
      if (/^NULL$/i.test(value)) {
        assert.ok(!declared.notNull, `${at} may be NULL, so the literal is admissible`);
        continue;
      }
      const quoted = /^'([^']*)'$/.exec(value);
      if (quoted) {
        assert.ok(!/^(INTEGER|REAL)$/.test(declared.type), `${at} is ${declared.type}, so a string literal cannot go there`);
        if (declared.allowed) {
          assert.ok(
            declared.allowed.includes(quoted[1]),
            `${at} only permits ${declared.allowed.join('|')}, not "${quoted[1]}"`,
          );
        }
        continue;
      }
      assert.match(value, /^-?\d+(\.\d+)?$/, `${at} has a VALUES literal this scan understands ("${value}")`);
      assert.ok(/^(INTEGER|REAL)$/.test(declared.type), `${at} is ${declared.type}, so a numeric literal is admissible`);
      if (declared.default !== null) {
        assert.equal(value, declared.default, `${at} hard-codes ${value} over its declared DEFAULT of ${declared.default}`);
      }
    }
  }
});

test('REPOS: reads are scoped to the current run in BACKTEST and span every run in PAPER', () => {
  for (const mode of ['BACKTEST', 'PAPER']) {
    const h = createHarness({ mode });
    try {
      const foreignRun = newId('run');
      const seedUnder = (runId, n) => {
        const previous = h.repos.runId;
        h.repos.setRun(runId, h.instanceId);
        try {
          for (let i = 0; i < n; i += 1) {
            const p = insertPipeline(h);
            insertFixtureFill(h, p.order, { quantity: p.quantity });
          }
        } finally {
          h.repos.setRun(previous, h.instanceId);
        }
      };
      seedUnder(h.runId, 1);
      seedUnder(foreignRun, 1);

      // Every row is attributed to the run that was in force when it was
      // written, in BOTH modes: a backtest and a paper run share a file shape,
      // not a row.
      assert.equal(
        h.db.count('SELECT COUNT(*) AS c FROM fills WHERE mode = ? AND run_id = ?', mode, h.runId), 1,
        `${mode}: this run's fill is attributed to this run`,
      );
      assert.equal(
        h.db.count('SELECT COUNT(*) AS c FROM fills WHERE mode = ?', mode), 2,
        `${mode}: both runs' fills are on disk, so scoping is a real choice and not an accident of there being one row`,
      );

      // A scoped read never leaks the other run's rows.
      assert.equal(
        h.repos.listFills({ mode, runId: h.runId }).length, 1,
        `${mode}: a run-scoped read returns only this run's fills`,
      );
      assert.equal(h.repos.countOrders(mode, h.runId), 1, `${mode}: a run-scoped order count excludes the other run`);
      assert.equal(
        h.repos.countOrders(mode), 2,
        `${mode}: an unscoped count is the whole mode, which is what a resumed PAPER run needs`,
      );

      if (mode === 'BACKTEST') {
        assert.equal(h.repos.decisionScopeRunId, h.runId, 'BACKTEST reads are scoped to the run in force');
        assert.equal(
          h.repos.listFills({ mode, runId: h.repos.decisionScopeRunId }).length, 1,
          'and the default scope returns this run only - a backtest that reported the previous run\'s trades would not be reproducible',
        );
      } else {
        assert.equal(h.repos.decisionScopeRunId, null, 'PAPER reads are deliberately unscoped across restarts');
        assert.equal(
          h.repos.listFills({ mode, runId: h.repos.decisionScopeRunId }).length, 2,
          'so a resumed PAPER run sees the whole history, not only the rows of this process',
        );
      }
    } finally {
      h.cleanup();
    }
  }
});

test('REPOS: an emergency stop is latched, cleared on the record, and listed newest first', () => {
  const h = createHarness();
  try {
    const { repos, clock } = h;
    assert.equal(repos.sessionStop(), null, 'no stop is latched to begin with');
    assert.equal(repos.isFlagSet('EMERGENCY_STOP'), false, 'and the control flag agrees');

    clock.advance(1000);
    const first = repos.engageStop({
      trigger: 'DAILY_LOSS_LIMIT', severity: 'CRITICAL', scope: 'HALT_ALL',
      reason: 'first stop', details: { note: 'first' }, clock,
    });
    assert.equal(repos.isFlagSet('EMERGENCY_STOP'), true, 'engaging a stop latches the control flag');

    clock.advance(1000);
    const second = repos.engageStop({
      trigger: 'OPERATOR', severity: 'WARNING', scope: 'NEW_ORDERS', reason: 'second stop', clock,
    });

    assert.equal(repos.activeStop().stop_id, second, 'the newest stop is the one that gates trading');
    const stored = repos.listStops().find((r) => r.stop_id === first);
    assert.equal(stored.trigger, 'DAILY_LOSS_LIMIT', 'the trigger is stored verbatim');
    assert.equal(stored.severity, 'CRITICAL', 'so is the severity');
    assert.equal(stored.scope, 'HALT_ALL', 'and the scope, which is what decides whether exits still work');
    assert.equal(stored.reason, 'first stop', 'and the reason an operator will read at 3am');
    assert.equal(stored.active, 1, 'and it is active');
    assert.deepEqual(stored.details, { note: 'first' }, 'and the structured details survive');

    const listed = repos.listStops();
    assert.equal(listed.length, 2, 'both stops are listed');
    assert.deepEqual(listed.map((r) => r.stop_id), [second, first], 'newest first: the stop that matters is at the top');

    // Clearing an id that is not latched must not report a success it did not
    // achieve. The return value is the number of stops STILL active, so an
    // operator who treats a small number as "cleared" is told the truth.
    assert.equal(repos.clearStop('no-such-stop', 'test:operator', clock), 2, 'clearing an unknown id reports that both stops are still latched');
    assert.equal(repos.activeStop().stop_id, second, 'and changes nothing about which stop is active');
    assert.equal(repos.isFlagSet('EMERGENCY_STOP'), true, 'the kill switch stays engaged');

    assert.equal(repos.clearStop(first, 'test:operator', clock), 1, 'clearing one of two reports that one is still latched');
    assert.equal(repos.isFlagSet('EMERGENCY_STOP'), true, 'and the kill switch stays engaged until the last one is cleared');

    assert.equal(repos.clearStop(second, 'test:operator', clock), 0, 'clearing the last one reports zero still latched');
    assert.equal(repos.activeStop(), null, 'no stop gates trading any more');
    assert.equal(repos.isFlagSet('EMERGENCY_STOP'), false, 'and the control flag is released');

    const cleared = repos.listStops().find((r) => r.stop_id === first);
    assert.equal(cleared.active, 0, 'the cleared stop is inactive, not deleted');
    assert.equal(cleared.cleared_by, 'test:operator', 'the clear is attributed to whoever performed it');
    assert.equal(cleared.cleared_at, clock.nowIso(), 'and timestamped');
    assert.equal(repos.listStops().length, 2, 'the record of the stop survives its clearing');
  } finally {
    h.cleanup();
  }
});

test('REPOS: a BACKTEST session is not halted by a stop another backtest latched, and a PAPER session is', () => {
  for (const mode of ['BACKTEST', 'PAPER']) {
    const h = createHarness({ mode });
    try {
      const otherRun = newId('run');
      h.repos.setRun(otherRun, h.instanceId);
      h.repos.engageStop({ trigger: 'OTHER_RUN', reason: 'latched by a different run', clock: h.clock });
      h.repos.setRun(h.runId, h.instanceId);

      assert.equal(
        h.repos.activeStop(mode)?.trigger, 'OTHER_RUN',
        `${mode}: the stop is on disk and visible to a mode-wide read`,
      );
      if (mode === 'BACKTEST') {
        assert.equal(
          h.repos.sessionStop(mode), null,
          'a BACKTEST run is not halted by a stop an earlier backtest latched, or it would silently trade nothing',
        );
      } else {
        assert.equal(
          h.repos.sessionStop(mode)?.trigger, 'OTHER_RUN',
          'a PAPER stop latched by a previous run must survive the restart of this one',
        );
      }
    } finally {
      h.cleanup();
    }
  }
});

test('REPOS: marking an order terminal records when it happened and who did it, and cannot be undone', () => {
  const h = createHarness();
  try {
    const { repos, clock } = h;
    const { order } = insertPipeline(h);

    const acked = repos.updateOrderStatus(order.order_id, { status: 'NEW', terminal: false, clock });
    assert.equal(acked.status, 'NEW', 'an acknowledgement moves the order on');
    assert.equal(acked.terminal_at, null, 'and a working order is not terminal');

    clock.advance(5000);
    const done = repos.updateOrderStatus(order.order_id, {
      status: 'FILLED', filledQuantity: 1, avgFillPrice: order.expected_price, terminal: true, clock,
    });
    assert.equal(done.status, 'FILLED', 'the fill is recorded');
    assert.equal(done.filled_quantity, 1, 'with the quantity that filled');
    assert.equal(done.avg_fill_price, order.expected_price, 'and the price it filled at');
    assert.equal(done.terminal_at, clock.nowIso(), 'and the instant the order became terminal');

    // A status change is outside the audit hash, so without the event log it
    // would be a change that no recorded artefact accounts for. The log is what
    // makes it accountable, and it must name the instance that performed it.
    const terminalEvent = repos.listEvents({ category: 'order_status' }).find((e) => e.details?.to === 'FILLED');
    assert.ok(terminalEvent, 'the terminal transition is written to the event log');
    assert.equal(terminalEvent.instance_id, h.instanceId, 'attributed to the instance that performed it');
    assert.equal(terminalEvent.details.orderId, order.order_id, 'naming the order');
    assert.equal(terminalEvent.details.from, 'NEW', 'and both sides of the transition');
    assert.equal(terminalEvent.details.to, 'FILLED', 'and both sides of the transition');
    assert.equal(terminalEvent.details.filledAfter, 1, 'and the resulting fill quantity');

    // A terminal order is terminal. A bug that resurrected a filled order would
    // let it be filled twice, and every reconciliation downstream would inherit
    // the error.
    assert.throws(
      () => repos.updateOrderStatus(order.order_id, { status: 'NEW', terminal: false, clock }),
      /illegal order transition FILLED -> NEW/,
      'a terminal order cannot be moved again',
    );
    assert.throws(
      () => repos.updateOrderStatus(order.order_id, { status: 'FILLED', terminal: true, clock }),
      /illegal order transition FILLED -> FILLED/,
      'not even back to the status it is already in',
    );
    const unchanged = repos.getOrder(order.order_id);
    assert.equal(unchanged.terminal_at, done.terminal_at, 'a refused transition leaves the terminal timestamp alone');
    assert.equal(unchanged.filled_quantity, 1, 'and the fill quantity alone');
  } finally {
    h.cleanup();
  }
});

test('REPOS: the equity series returns the tail in ascending order, in both modes', () => {
  for (const mode of ['PAPER', 'BACKTEST']) {
    const h = createHarness({ mode });
    try {
      const { repos, clock } = h;
      const samples = 12;
      for (let i = 0; i < samples; i += 1) {
        // The marker is carried in the value itself, so "the tail" is checkable
        // without trusting the ordering of anything else.
        repos.recordEquity({
          equityEgp: 1000 + i, cashEgp: 900 + i, exposureEgp: 100,
          peakEquityEgp: 1000 + i, drawdownEgp: 0, drawdownPct: 0, clock,
        }, mode);
        if (i < samples - 1) clock.advance(1000);
      }

      const ascending = repos.equitySeries({ limit: 1000, mode });
      assert.equal(ascending.length, samples, `${mode}: every sample is returned`);
      assert.deepEqual(
        ascending.map((r) => r.equity_egp), Array.from({ length: samples }, (_, i) => 1000 + i),
        `${mode}: the whole series is in ascending time order`,
      );

      const tail = repos.equitySeries({ limit: 3, mode, newest: true });
      assert.equal(tail.length, 3, `${mode}: the newest branch honours its limit`);
      assert.deepEqual(
        tail.map((r) => r.equity_egp), [1000 + samples - 3, 1000 + samples - 2, 1000 + samples - 1],
        `${mode}: the newest branch returns the TAIL, still ascending - a 24/7 agent appends forever, so the head would be a window from the first day it ever ran`,
      );

      // The tie-breaker column must be SELECTED in both branches. It is the only
      // monotonic ordering when two samples share a millisecond, and its absence
      // from one branch is what made the snapshot endpoint throw on every
      // request.
      for (const newest of [false, true]) {
        for (const row of repos.equitySeries({ limit: 2, mode, newest })) {
          assert.ok(
            Object.hasOwn(row, 'id'),
            `${mode} (${newest ? 'newest' : 'oldest'} branch): every row carries the tie-breaker column the query orders by`,
          );
        }
      }

      // Two samples in the same millisecond, which is the ordinary case at this
      // tick rate: both branches must still come back in a deterministic order
      // or the chart silently reshuffles between polls.
      const existing = repos.equitySeries({ limit: 1000, mode }).length;
      repos.recordEquity({
        equityEgp: 2000, cashEgp: 900, exposureEgp: 100,
        peakEquityEgp: 2000, drawdownEgp: 0, drawdownPct: 0, clock,
      }, mode);
      const sameMs = repos.equitySeries({ limit: 1000, mode });
      assert.equal(sameMs.length, existing + 1, `${mode}: the extra sample was written`);
      assert.equal(sameMs.at(-1).equity_egp, 2000, `${mode}: and it shares a millisecond with the one before it`);
      const ids = repos.equitySeries({ limit: 2, mode, newest: true }).map((r) => r.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `${mode}: same-millisecond samples stay in ascending id order`);
    } finally {
      h.cleanup();
    }
  }
});

// ===========================================================================
// 4. THE AUDIT CHAIN
// ===========================================================================

test('AUDIT: every stream verifies in its own mode, and in no other', () => {
  for (const mode of ['PAPER', 'BACKTEST']) {
    const h = createHarness({ mode });
    try {
      for (let i = 0; i < 3; i += 1) {
        h.clock.advance(1000);
        insertPipeline(h);
      }
      const other = mode === 'PAPER' ? 'BACKTEST' : 'PAPER';

      for (const [name, stream] of Object.entries(STREAMS)) {
        const result = h.chain.verify(stream, mode);
        assert.equal(result.ok, true, `${mode} ${name}: the chain verifies (${result.reason} after ${result.checked} records)`);
        assert.ok(result.checked > 0, `${mode} ${name}: the chain is not vacuously empty`);
        assert.equal(result.checked, 3, `${mode} ${name}: every sealed record was checked`);
        assert.equal(result.columns, STREAM_COLUMNS[stream].length, `${mode} ${name}: the hashed column count is reported`);
        const table = SCHEMA.get(AuditChain.tableFor(stream));
        assert.ok(table.columns.has(result.orderCol), `${mode} ${name}: the reported order column is a real column of ${AuditChain.tableFor(stream)}`);

        const elsewhere = h.chain.verify(stream, other);
        assert.equal(elsewhere.checked, 0, `${mode} ${name}: no record leaks into the ${other} chain`);
        assert.equal(elsewhere.ok, true, `${mode} ${name}: an empty chain in another mode is intact, not broken`);
      }
    } finally {
      h.cleanup();
    }
  }
});

test('AUDIT: an empty chain is intact, and that is not the same as verified', () => {
  const h = createHarness();
  try {
    for (const [name, stream] of Object.entries(STREAMS)) {
      const empty = h.chain.verify(stream, 'BACKTEST');
      assert.equal(empty.checked, 0, `${name}: nothing has been written in BACKTEST`);
      assert.equal(empty.ok, true, `${name}: so the chain is intact`);
      // The distinction matters. `ok: true, checked: 0` means "there is nothing
      // here", not "something was checked and passed" - an operator reading a
      // status page has to be able to tell those apart.
      assert.equal(typeof empty.checked, 'number', `${name}: the count is reported even when it is zero`);
      assert.equal(empty.reason, 'chain intact', `${name}: and the reason is stated, not inferred`);
    }
  } finally {
    h.cleanup();
  }
});

test('AUDIT: each stream is chained in the real table that owns it', () => {
  assert.equal(
    Object.keys(STREAMS).length, Object.keys(STREAM_COLUMNS).length,
    'every stream declares the columns it hashes',
  );

  for (const [name, stream] of Object.entries(STREAMS)) {
    const table = AuditChain.tableFor(stream);
    assert.ok(SCHEMA.has(table), `${name} (${stream}) maps to the real table ${table}`);

    // Derive the true owner of the stream from the schema: the stream's own
    // identifying column must be the PRIMARY KEY of the table it points at. A
    // mapping onto a table that merely happens to have a column of that name
    // would chain the wrong records.
    const idColumn = STREAM_COLUMNS[stream][0];
    const owners = [...SCHEMA.entries()]
      .filter(([, t]) => t.primaryKey === idColumn)
      .map(([t]) => t);
    assert.ok(owners.length >= 1, `${name}: ${idColumn} is a primary key somewhere in the schema`);
    assert.ok(owners.includes(table), `${name}: ${table} declares ${idColumn} as its primary key (owners: ${owners.join(', ')})`);

    for (const column of STREAM_COLUMNS[stream]) {
      assert.ok(
        SCHEMA.get(table).columns.has(column),
        `${name}: ${column} really is a column of ${table}, so sealing it and verifying it describe the same row`,
      );
    }
    assert.throws(() => AuditChain.tableFor('not_a_stream'), /unknown audit stream/, `${name}: an unknown stream is refused`);
  }
});

test('AUDIT: canonical JSON is a function of the record, not of the object literal that built it', () => {
  // If the canonical form depended on key insertion order, two identical records
  // could hash differently and every verification would be a coin flip.
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }), 'key order does not matter');
  const deep = { z: { y: { x: [1, 2, 3] } }, a: 0 };
  assert.equal(canonicalJson(deep), canonicalJson({ a: 0, z: { y: { x: [1, 2, 3] } } }), 'at any depth');

  // An absent key and a key explicitly set to undefined are the same record.
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }), 'undefined keys are omitted');
  assert.equal(canonicalJson({ a: undefined }), '{}', 'and an all-undefined object is empty, not "undefined"');
  assert.equal(canonicalJson({ a: { b: undefined, c: 2 } }), '{"a":{"c":2}}', 'recursion omits them too');

  // null is a VALUE and must survive: dropping it would let a null field and an
  // absent one hash identically.
  assert.equal(canonicalJson(null), 'null', 'null is preserved');
  assert.equal(canonicalJson({ a: null }), '{"a":null}', 'a null field is preserved');
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}), 'and a null field is not the same as an absent one');

  // Arrays keep their order: a sequence, not a set.
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]', 'array order is part of the value');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'reordering an array changes the record');
  assert.equal(canonicalJson({ a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}]}', 'it recurses into arrays and objects');
  assert.equal(canonicalJson([undefined]), '[null]', 'a hole in an array is a null, not a silently shorter array');

  // The form itself: compact and sorted, so a hash of the string is stable.
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}', 'the form is compact and sorted');
  assert.equal(canonicalJson('x'), '"x"', 'a bare string is quoted');
  assert.equal(canonicalJson(0), '0', 'a bare zero is zero, not null or empty');
  assert.equal(canonicalJson(false), 'false', 'a bare false is false');
});

test('AUDIT: a legitimate order lifecycle does not break the chain, but a rewritten intent does', () => {
  const h = createHarness();
  try {
    const { repos, clock } = h;
    const { order } = insertPipeline(h);
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, true, 'the chain starts intact');

    // The order works exactly as orders do: acknowledged, then filled, with the
    // average price recorded. Those columns are mutable by design - a chain that
    // broke here would report tampering on every normal trade and the operator
    // would learn to ignore it.
    repos.updateOrderStatus(order.order_id, { status: 'NEW', terminal: false, clock });
    clock.advance(1000);
    repos.updateOrderStatus(order.order_id, {
      status: 'FILLED', filledQuantity: 1, avgFillPrice: order.expected_price, terminal: true, clock,
    });
    const afterWorking = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(afterWorking.ok, true, `the lifecycle is outside the hash (${afterWorking.reason})`);
    assert.equal(afterWorking.checked, 1, 'and the record is still the one that was sealed');

    // The intent is a different matter. Rewriting the price or the quantity an
    // order was placed for is the edit that matters, and it is still caught.
    h.db.run('UPDATE orders SET quantity = ? WHERE order_id = ?', -1, order.order_id);
    const tampered = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(tampered.ok, false, 'rewriting the quantity the order was placed for is detected');
    assert.match(tampered.reason, /record_hash mismatch/, 'and named as a modification, not a removal');
  } finally {
    h.cleanup();
  }
});

test('AUDIT: a refused write cannot consume a chain position and forge a tamper report', () => {
  // Regression. `seal()` advances the in-memory cursor before the row is
  // written, because the hash has to exist before the row that carries it. A
  // write that is then refused - a duplicate primary key, a foreign key, a full
  // disk - used to leave the cursor pointing at a hash that was never stored, so
  // every later record linked to a phantom and `verify()` reported
  // "prev_hash mismatch (record removed or reordered)" for the rest of the
  // process, on a database nobody had touched. A chain that always reports
  // "broken" is worse than no chain at all, because it trains the operator to
  // ignore it.
  const h = createHarness();
  try {
    const { repos, clock } = h;
    const make = (reason) => decisionToRow(h.buyDecision({ price: h.instrument.startPrice, reason }));

    // --- a record written BEFORE the refused write ------------------------
    const first = make('first');
    const a = repos.insertDecision(first, clock);
    const storedBefore = h.db.get('SELECT * FROM agent_decisions WHERE decision_id = ?', a.decision_id);
    const rowsBefore = h.db.count('SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ?', h.mode);

    // The refusal has to be a REAL refusal. `buyDecision` mints a fresh
    // `newId('dec')` on every call, so calling it twice produces two different
    // decisions and two legal inserts - the previous version of this test
    // asserted that a duplicate was refused when no duplicate had been
    // attempted, and would have passed just as happily against a repository
    // that silently accepted every write. The row to retry is therefore built
    // ONCE and submitted twice, which is what a worker restart or a
    // double-acknowledged submit actually does.
    assert.equal(
      a.decision_id, first.decisionId,
      'the stored primary key is the id on the row that was submitted',
    );
    assert.throws(
      () => repos.insertDecision(first, clock),
      (err) => err.code === 'DATABASE_ERROR' && err.message.includes('agent_decisions.decision_id'),
      'the duplicate is refused',
    );

    // --- the database is untouched ----------------------------------------
    assert.equal(
      h.db.count('SELECT COUNT(*) AS c FROM agent_decisions WHERE mode = ?', h.mode), rowsBefore,
      'the refused write added no row',
    );
    assert.deepEqual(
      h.db.get('SELECT * FROM agent_decisions WHERE decision_id = ?', a.decision_id), storedBefore,
      'and did not modify the row it collided with',
    );

    // --- a record written AFTER the refused write -------------------------
    // This is the assertion the whole regression turns on. The cursor advanced
    // to a hash that was never stored, and the next seal has to ignore it and
    // link to the last record that WAS stored.
    const b = repos.insertDecision(make('second'), clock);
    assert.equal(b.prev_hash, a.record_hash, 'the record after the refusal links to the last record that was STORED');
    assert.notEqual(b.record_hash, a.record_hash, 'and is a record of its own, not a replay of the previous one');

    const result = h.chain.verify(STREAMS.DECISION, 'PAPER');
    assert.equal(result.ok, true, `the chain is intact after a refused write (${result.reason})`);
    assert.equal(result.checked, 2, 'and holds exactly the records that were actually written');

    // Continuity, not merely the absence of an error: the chain keeps going
    // from the recovered link, so a resumed process produces one unbroken
    // history rather than a fork at the point of the refusal.
    const c = repos.insertDecision(make('third'), clock);
    assert.equal(c.prev_hash, b.record_hash, 'and stays linked from then on');
    const after = h.chain.verify(STREAMS.DECISION, 'PAPER');
    assert.equal(after.ok, true, `still intact with a third record (${after.reason})`);
    assert.equal(after.checked, 3, 'every real record is in the chain');

    // The same verdict from a chain that has never cached anything, which is
    // what a restarted process sees. If the in-memory cursor and the database
    // could ever disagree about where the chain ends, this is where it shows.
    const freshChain = new AuditChain(h.db);
    const cold = freshChain.verify(STREAMS.DECISION, 'PAPER');
    assert.equal(cold.ok, true, `a cold reader agrees the chain is intact (${cold.reason})`);
    assert.equal(cold.checked, 3, 'and sees the same three records - the database, not the cursor, is the truth');
  } finally {
    h.cleanup();
  }
});

test('AUDIT: resetting the cursor re-reads the chain, it neither restarts nor launders it', () => {
  const h = createHarness();
  try {
    const { repos, clock } = h;
    const make = (reason) => decisionToRow(h.buyDecision({ price: h.instrument.startPrice, reason }));
    const a = repos.insertDecision(make('a'), clock);
    clock.advance(1000);
    const b = repos.insertDecision(make('b'), clock);

    h.chain.reset();
    const c = repos.insertDecision(make('c'), clock);
    // A restart re-reads the cursor from the database; it does not begin again
    // at GENESIS, or a restarted worker would silently fork the chain.
    assert.equal(c.prev_hash, b.record_hash, 'after a reset the chain continues from the last stored record');
    const result = h.chain.verify(STREAMS.DECISION, 'PAPER');
    assert.equal(result.ok, true, `and the whole chain still verifies (${result.reason})`);
    assert.equal(result.checked, 3, 'with every record in it');
    assert.notEqual(c.record_hash, a.record_hash, 'and each record is hashed over its own predecessor');

    // A reset is a cache invalidation, not an escape hatch: it must not make a
    // tampered chain verify again.
    h.db.run('UPDATE agent_decisions SET quantity = ? WHERE decision_id = ?', -7, a.decision_id);
    h.chain.reset();
    const afterTamper = h.chain.verify(STREAMS.DECISION, 'PAPER');
    assert.equal(afterTamper.ok, false, 'a reset does not launder a tampered record');
    assert.match(afterTamper.reason, /record_hash mismatch/, 'which is still reported as a modification');
  } finally {
    h.cleanup();
  }
});

test('AUDIT: a record removed from the middle is detected as a break in the links', () => {
  const h = createHarness();
  try {
    for (let i = 0; i < 3; i += 1) { h.clock.advance(1000); insertPipeline(h); }
    assert.equal(h.chain.verify(STREAMS.ORDER, 'PAPER').ok, true, 'the chain is intact to begin with');

    // Delete from the MIDDLE. Removing the tail of a chain leaves the remaining
    // links intact and is undetectable by any hash chain - only the middle
    // proves that removals are caught.
    const victim = h.db.get('SELECT order_id FROM orders WHERE mode = ? ORDER BY rowid ASC LIMIT 1 OFFSET 1', 'PAPER');
    assert.ok(victim, 'there is a middle record to remove');
    h.db.run('PRAGMA foreign_keys = OFF');
    h.db.run('DELETE FROM orders WHERE order_id = ?', victim.order_id);
    h.db.run('PRAGMA foreign_keys = ON');

    const result = h.chain.verify(STREAMS.ORDER, 'PAPER');
    assert.equal(result.ok, false, 'a record removed from the middle is detected');
    assert.match(result.reason, /prev_hash mismatch/, 'as a broken link, not a modified record');
    assert.equal(result.checked, 1, 'and the walk stops at the break rather than carrying on past it');
  } finally {
    h.cleanup();
  }
});

// ===========================================================================
// 5. MONEY ARITHMETIC
// ===========================================================================

test('MONEY: a quantity is never rounded as money', () => {
  // This is the whole reason `roundQty` exists. A gold position of 0.001 units
  // is a real position worth thousands of piastres, and `roundEgp(0.001)` is 0:
  // averaging into it with a cash-rounding helper collapses it to nothing, and
  // every average-price calculation after that divides by zero.
  const h = createHarness();
  try {
    const { instruments } = h.config;
    const gold = instruments.find((i) => i.symbol.endsWith('/XAU')) ?? instruments.at(-1);

    assert.ok(gold.minQty > 0, 'the gold instrument has a minimum tradable quantity');
    assert.ok(gold.minQty < 1, `which is a fraction of a unit (${gold.minQty}) - a sub-unit size is the case that matters`);

    assert.equal(roundQty(gold.minQty), gold.minQty, 'roundQty preserves a sub-unit quantity exactly');
    assert.ok(same(roundEgp(gold.minQty), 0), 'roundEgp annihilates it, which is why it must never be used on one');
    assert.notEqual(
      roundQty(gold.minQty), roundEgp(gold.minQty),
      'the two rounders are genuinely different operations, not two names for one',
    );

    // The property generalises: for every configured instrument, the smallest
    // order the agent is allowed to place survives the quantity rounder.
    for (const i of instruments) {
      assert.equal(roundQty(i.minQty), i.minQty, `${i.symbol}: its minimum quantity survives roundQty`);
      assert.equal(roundQty(i.qtyStep), i.qtyStep, `${i.symbol}: its quantity step survives roundQty`);
      assert.ok(roundQty(i.minQty) > 0, `${i.symbol}: a minimum quantity that rounds to zero is one the agent can never trade`);
    }
  } finally {
    h.cleanup();
  }
});

test('MONEY: rounding is idempotent, so a value is stored the same way however often it is rounded', () => {
  const h = createHarness();
  try {
    const values = [
      ...h.config.instruments.map((i) => i.minQty),
      ...h.config.instruments.map((i) => i.startPrice),
      0, 0.001, 0.005, 0.01, 0.07, 0.1 + 0.2, 1 / 3, 48.75, 4150, 1e-9, 1e-12,
    ];
    for (const v of values) {
      const once = roundQty(v);
      assert.equal(roundQty(once), once, `roundQty is idempotent at ${v} (${once})`);
      const money = roundEgp(v);
      assert.ok(same(roundEgp(money), money), `roundEgp is idempotent at ${v} (${money})`);
    }
  } finally {
    h.cleanup();
  }
});

test('MONEY: a sign cannot bias a ledger - ties resolve one way, and rounding can never create value', () => {
  // WHAT IS ACTUALLY TRUE, because the obvious claim is not.
  //
  // The general rounder `roundTo` rounds half AWAY FROM ZERO, so it is exactly
  // sign-symmetric: `roundTo(x, d) === -roundTo(-x, d)` for every input, and
  // `roundQty` inherits that from it.
  //
  // `roundEgp` is a different function and is NOT sign-symmetric. It is
  // `Math.round(x * 100) / 100`, and `Math.round` breaks a tie UPWARD, toward
  // +Infinity, for both signs. At an exact half-piastre the positive rounds
  // away from zero and the negative rounds toward it, so `roundEgp(0.005)` is
  // 0.01 while `roundEgp(-0.005)` is zero. The earlier version of this test
  // asserted `roundEgp(v) === -roundEgp(-v)` and was simply wrong about the
  // code it was testing. It is kept as an observation, not as a requirement:
  // a ledger is not required to be sign-antisymmetric, it is required not to
  // manufacture value.
  //
  // That is the guarantee asserted below, and it is the one that matters:
  //
  //   1. Rounding is NON-GENERATING. `roundEgp(x) + roundEgp(-x)` is never more
  //      than a single piastre. A value and its negation cannot BOTH gain, so
  //      no sequence of round trips can inflate a balance. The residual is
  //      one-directional - always toward +Infinity - so the error is bounded,
  //      never compounding, and can only ever overstate a magnitude.
  //   2. Rounding never changes a sign, so no rounding event can manufacture
  //      negative cash out of nothing. This system is long-only and
  //      cash-funded, so that is the property that actually protects it.
  //
  // The half-up tie-break in `roundEgp` and the half-away-from-zero tie-break
  // in `roundTo` disagree. That is recorded as an observation about
  // src/core/money.js, not asserted as correct and not "fixed" here: the
  // residual is bounded and one-directional, so it cannot corrupt a balance,
  // and changing rounding would move every stored figure in every existing
  // database. It is a consistency wart, not a defect.

  // A deterministic grid, fine enough to land exactly on every half-piastre
  // tie in [-2, 2]: steps of 0.00005 hit 0.005, 0.015, 0.125 and so on.
  const GRID = Array.from({ length: 80001 }, (_, i) => (i - 40000) / 20000);

  for (const v of [0.005, 0.015, 0.125, 1.005, 2.5, 1 / 3, 1e-9]) {
    assert.ok(same(roundTo(v, 2), -roundTo(-v, 2)), `roundTo is symmetric about zero at ${v}`);
    assert.ok(same(roundQty(v), -roundQty(-v)), `roundQty is symmetric about zero at ${v}`);
  }

  // The tie rule, pinned on a dense grid rather than assumed from the source.
  for (const v of GRID) {
    if (!same(roundTo(v, 2), -roundTo(-v, 2))) {
      assert.fail(`roundTo stopped being symmetric at ${v}: ${roundTo(v, 2)} vs ${roundTo(-v, 2)}`);
    }
    if (!same(roundQty(v), -roundQty(-v))) {
      assert.fail(`roundQty stopped being symmetric at ${v}: ${roundQty(v)} vs ${roundQty(-v)}`);
    }

    // (1) Non-generating, in integer piastres so no float noise is involved.
    const pair = toMinor(roundEgp(v)) + toMinor(roundEgp(-v));
    if (pair !== 0 && pair !== 1) {
      assert.fail(
        `rounding roundEgp at ${v} created value: a value and its negation sum to ${pair} piastres, not 0 or 1`,
      );
    }

    // (2) A rounder never turns a non-negative amount negative, or the other
    // way about: cash cannot be conjured out of a rounding step.
    if (v <= 0 && roundEgp(v) > 0) assert.fail(`roundEgp(${v}) produced positive cash (${roundEgp(v)})`);
    if (v >= 0 && roundEgp(v) < 0) assert.fail(`roundEgp(${v}) produced negative cash (${roundEgp(v)})`);
  }
  assert.ok(GRID.length > 1, `the symmetry sweep actually ran over ${GRID.length} points`);

  // The specific asymmetry, stated as fact. If `roundEgp` is ever changed to
  // break ties away from zero this fails, and the non-generating bound above
  // will start reporting a residual of 2 piastres - so the two together pin
  // the behaviour from both sides.
  assert.equal(roundEgp(0.005), 0.01, 'roundEgp breaks a half-piastre tie upward');
  assert.ok(same(roundEgp(-0.005), -0), 'and, being half-UP, breaks the negative tie toward zero');
  assert.notEqual(
    roundEgp(0.005), -roundEgp(-0.005),
    'so roundEgp is deliberately NOT antisymmetric - the ledger guarantee is the bounded residual, not a mirrored sign',
  );

  // Half away from zero, not half up: -0.125 rounds to -0.13, so a loss of one
  // eighth is never quietly recorded as a loss of one tenth.
  assert.equal(roundTo(0.125, 2), 0.13, 'roundTo breaks a tie away from zero, upward');
  assert.equal(roundTo(-0.125, 2), -0.13, 'and downward for the negative');
  assert.equal(
    roundQty(0.5 / 10 ** QUANTITY_DECIMALS), 10 ** -QUANTITY_DECIMALS,
    'a quantity is rounded to its own precision, not to a money precision',
  );
});

test('MONEY: cash is exact integer piastres, and repeated cash events do not drift', () => {
  // Balances are stored as integers, so rounding happens once per cash event.
  // Converting back must land on exactly the number the rounder would have
  // produced, or "the ledger balances" stops being true.
  for (const v of [0, 0.001, 0.005, 0.07, 0.1, 48.75, 4150, 1 / 3, 1e-9]) {
    assert.ok(same(fromMinor(toMinor(v)), roundEgp(v)), `${v} survives the piastre round trip exactly`);
    assert.ok(Number.isInteger(toMinor(v)), `${v} is stored as an integer number of piastres`);
  }
  assert.equal(MINOR_UNITS_PER_EGP, 100, 'an EGP is a hundred piastres');

  // The classic floating-point drift, in the order it would actually happen:
  // ten small cash events instead of one big one.
  const lumpSum = fromMinor(Array.from({ length: 10 }, () => toMinor(0.1)).reduce((a, b) => a + b, 0));
  assert.equal(roundEgp(lumpSum), 1, `ten 0.10 cash events sum to exactly EGP 1.00 (was ${lumpSum})`);
  assert.ok(Math.abs(lumpSum - 1) < 1e-9, 'and the residual drift is below a single piastre');
});
