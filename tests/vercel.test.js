/**
 * The Vercel deployment layer's safety properties, as tests rather than as
 * claims.
 *
 * Every assertion in this file was written against a way the deployment could
 * be dangerous rather than a way it could be broken. The interesting failures
 * are not "the endpoint 500s" - they are "the endpoint answers 200 with a
 * fabricated EGP 500 balance", "the 405 is missing so a future POST route is
 * reachable", and "the import graph grew by one edge and the function can now
 * reach the broker". All three of those return HTTP 200 on every naive smoke
 * test, which is why they need their own tests.
 *
 * THE CENTRAL TEST
 *
 * `a read-only layer with no database must not report money` is the property
 * this whole file exists for. `dashboard/api.js:117` falls back to
 * `config.account.startingCapitalEgp` when no balance row is found - correct on
 * a local dashboard whose database is briefly locked, and a fabrication on a
 * serverless function that has no database at all. The empty path is therefore
 * written out longhand in `vercel/empty.js` rather than derived, and the test
 * below asserts the longhand is actually in use.
 */

import { test, describe, before, after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, EPOCH } from './helpers/harness.js';

import { handle, ALLOWED_METHODS } from '../src/vercel/router.js';
import { DATA_STATE, NO_DATA_MESSAGE } from '../src/vercel/empty.js';
import { DEPLOYMENT, TRUTH } from '../src/vercel/identity.js';
import { resetStateCache } from '../src/vercel/state.js';

import { openDatabase } from '../src/database/db.js';
import { migrate } from '../src/database/migrate.js';
import { ManualClock } from '../src/core/clock.js';
import { patchIndex, assertUniformNewlines } from '../scripts/build.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Snapshots are cached per container, so a test that changes the environment has
// to say so. Every test that touches TEOS_SNAPSHOT_DB resets it either side.
const CREDENTIAL_VARS = [
  'TEOS_MARKET_DATA_API_KEY', 'TEOS_MARKET_DATA_API_SECRET',
  'TEOS_TRADING_API_KEY', 'TEOS_TRADING_API_SECRET', 'TEOS_TRADING_API_PASSPHRASE',
];

function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetStateCache();
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetStateCache();
  }
}

/** A closed, migrated PAPER database with one balance row. */
function makeSnapshotDb(dir) {
  const file = join(dir, 'snapshot.db');
  const db = openDatabase(file);
  migrate(db, new ManualClock(EPOCH));
  // Named parameters: `Database#run` forwards straight to node:sqlite, which
  // rejects positional binds on a statement that declares names.
  db.run(
    `INSERT INTO balances (run_id, mode, ts, ts_ms, cash_egp, equity_egp, exposure_egp,
       realized_pnl_egp, unrealized_pnl_egp, total_pnl_egp, open_positions,
       fees_paid_egp, slippage_cost_egp, reason)
     VALUES ($runId, $mode, $ts, $tsMs, $cash, $equity, $exposure,
       $realized, $unrealized, $total, $openPositions, $fees, $slippage, $reason)`,
    {
      runId: null,
      mode: 'PAPER',
      ts: new Date(EPOCH).toISOString(),
      tsMs: EPOCH,
      cash: 487.5,
      equity: 487.5,
      exposure: 0,
      realized: -12.5,
      unrealized: 0,
      total: -12.5,
      openPositions: 0,
      fees: 9.5,
      slippage: 3.0,
      reason: 'test snapshot',
    },
  );
  db.close();
  return file;
}

const TMP = mkdtempSync(join(tmpdir(), 'teos-vercel-test-'));
after(() => { rmSync(TMP, { recursive: true, force: true }); });

/** Serialise and re-parse: every response must survive a JSON round trip. */
function roundTrip(body) {
  return JSON.parse(JSON.stringify(body));
}

// ============================================================ ROUTING / HTTP

describe('Vercel routing: methods, status codes, headers', () => {
  test('the documented endpoints all answer 200 with no snapshot configured', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      for (const path of [
        '/api/healthz', '/api/snapshot', '/api/env', '/api/audit/chains',
        '/api/section/account', '/api/section/agent', '/api/section/risk', '/api/section/audit',
      ]) {
        const res = handle({ method: 'GET', path });
        assert.equal(res.status, 200, `${path} returned ${res.status}: ${JSON.stringify(res.body)}`);
      }
    });
  });

  test('only the four sections this project actually has are routable', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      // The deployment order listed nine section names. This project has four.
      // Exposing the other five would mean inventing contracts, so they 404.
      for (const ghost of ['positions', 'orders', 'trades', 'performance', 'sentinel', 'market', 'system']) {
        const res = handle({ method: 'GET', path: `/api/section/${ghost}` });
        assert.equal(res.status, 404, `/api/section/${ghost} should not exist, got ${res.status}`);
      }
      for (const real of ['account', 'agent', 'risk', 'audit']) {
        assert.equal(handle({ method: 'GET', path: `/api/section/${real}` }).status, 200);
      }
    });
  });

  test('every write verb is refused with 405 and an Allow header', () => {
    const snapshot = mkdtempSync(join(tmpdir(), 'teos-vercel-405-'));
    const db = makeSnapshotDb(snapshot);
    try {
      withEnv({ TEOS_SNAPSHOT_DB: db }, () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
          const res = handle({ method, path: '/api/snapshot' });
          assert.equal(res.status, 405, `${method} /api/snapshot returned ${res.status}`);
          assert.equal(res.headers.allow, 'GET, HEAD', `${method} has no Allow header`);
          assert.equal(res.body.code, 'READ_ONLY', `${method} has no machine-readable refusal code`);
          assert.match(res.body.detail, /read-only presentation layer/i);
        }
      });
    } finally { rmSync(snapshot, { recursive: true, force: true }); }
  });

  test('the method check happens before route resolution, so no path can bypass it', () => {
    // A route table can gain an entry later. The guard is above it, not beside it.
    for (const path of ['/api/snapshot', '/api/does-not-exist', '/', '/api/section/account', '/api/audit/chains']) {
      assert.equal(handle({ method: 'POST', path }).status, 405, `${path} leaked through the method guard`);
    }
  });

  test('HEAD is allowed and carries the same status as GET', () => {
    assert.deepEqual(ALLOWED_METHODS, ['GET', 'HEAD']);
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      for (const path of ['/api/healthz', '/api/snapshot', '/api/section/audit']) {
        assert.equal(handle({ method: 'HEAD', path }).status, handle({ method: 'GET', path }).status);
      }
    });
  });

  test('unknown routes return JSON 404, never HTML', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      for (const path of ['/api/nope', '/api/section/', '/api/audit', '/nonsense']) {
        const res = handle({ method: 'GET', path });
        assert.equal(res.status, 404, `${path} returned ${res.status}`);
        assert.equal(roundTrip(res.body).error, 'not found');
        assert.match(res.headers['content-type'], /application\/json/);
      }
    });
  });

  test('a trailing slash does not create a second, unrouted URL', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      assert.equal(handle({ method: 'GET', path: '/api/snapshot/' }).status, 200);
    });
  });

  test('security headers are present on success, 404 and 405 alike', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const responses = [
        handle({ method: 'GET', path: '/api/snapshot' }),
        handle({ method: 'GET', path: '/api/nope' }),
        handle({ method: 'POST', path: '/api/snapshot' }),
      ];
      for (const res of responses) {
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'DENY');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.match(res.headers['content-security-policy'], /default-src 'none'/);
        assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
      }
    });
  });

  test('every response body survives a JSON round trip with no NaN or undefined', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const paths = ['/api/healthz', '/api/snapshot', '/api/audit/chains',
        '/api/section/account', '/api/section/agent', '/api/section/risk', '/api/section/audit'];
      for (const path of paths) {
        const text = JSON.stringify(handle({ method: 'GET', path }).body);
        assert.ok(!text.includes('NaN'), `${path} serialised NaN`);
        assert.ok(!text.includes('undefined'), `${path} serialised undefined`);
        assert.doesNotThrow(() => JSON.parse(text));
      }
    });
  });
});

// ============================================================ NO FABRICATION

describe('no fabricated trading data when no database exists', () => {
  test('the empty snapshot reports no money at all', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const { body } = handle({ method: 'GET', path: '/api/snapshot' });
      const a = body.account;

      for (const field of ['cashEgp', 'equityEgp', 'exposureEgp', 'realizedPnlEgp',
        'unrealizedPnlEgp', 'feesPaidEgp', 'slippagePaidEgp', 'peakEquityEgp',
        'maxDrawdownPct', 'openPositionCount', 'trades']) {
        assert.equal(a[field], null, `account.${field} is ${JSON.stringify(a[field])}, expected null`);
      }
      assert.deepEqual(a.positions, [], 'positions must be empty, not fabricated');
      assert.deepEqual(a.market, [], 'market must be empty, not fabricated');
      assert.deepEqual(a.equityCurve, [], 'equityCurve must be empty, not fabricated');
      assert.deepEqual(body.audit.orders, []);
      assert.deepEqual(body.audit.fills, []);
      assert.deepEqual(body.audit.decisions, []);
    });
  });

  test('the starting-capital fallback never leaks into a measured balance field', () => {
    // THE test this file exists for. `accountSection` substitutes
    // startingCapitalEgp for a missing balance. If that ever reaches this
    // deployment, cashEgp becomes 500 and reads as a real balance.
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const { body } = handle({ method: 'GET', path: '/api/snapshot' });
      const configured = body.account.startingCapitalEgp;
      assert.equal(typeof configured, 'number', 'the configured ceiling is knowable and should be reported');
      for (const field of ['cashEgp', 'equityEgp', 'exposureEgp']) {
        assert.notEqual(body.account[field], configured,
          `account.${field} equals the configured starting capital - that is a fabricated balance`);
      }
      assert.ok(body.account.equityInvariant.ok === null,
        'an invariant over no data must be null (unevaluated), never true');
      assert.ok(body.account.capitalInvariant.ok === null,
        'an invariant over no data must be null (unevaluated), never true');
    });
  });

  test('emergency stop and hold state are unknown, not "not engaged"', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const risk = handle({ method: 'GET', path: '/api/section/risk' }).body;
      assert.equal(risk.emergencyStop.engaged, null, 'false is a claim; null is "not knowable here"');
      assert.equal(risk.tradingHold.engaged, null);
      assert.equal(risk.emergencyStop.stateUnknown, true);
      // The limits are configuration, not results, and remain available.
      assert.equal(typeof risk.limits.maxLossPerTradeEgp, 'number');
      assert.equal(risk.limits.maxStartingCapitalEgp, 500);
    });
  });

  test('counters are null, not zero', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const agent = handle({ method: 'GET', path: '/api/section/agent' }).body;
      for (const k of ['decisions', 'orders', 'errors']) {
        assert.equal(agent.counters[k], null, `counters.${k} must be null, not 0`);
      }
      assert.equal(agent.heartbeat, null, 'no worker runs here, so there is no heartbeat to report');
    });
  });

  test('the empty state is labelled and carries the exact operator-facing wording', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const body = handle({ method: 'GET', path: '/api/snapshot' }).body;
      assert.equal(body.dataState, DATA_STATE.NO_DATABASE);
      assert.equal(body.noDataMessage, NO_DATA_MESSAGE);
      assert.match(body.noDataMessage, /No persistent worker data available/i);
      assert.equal(body.mode, 'PAPER');
    });
  });

  test('chain verification reports "not evaluated" rather than "verified"', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const { body } = handle({ method: 'GET', path: '/api/audit/chains' });
      assert.equal(body.evaluated, false);
      assert.equal(body.chains.length, 4);
      for (const c of body.chains) {
        assert.equal(c.ok, null, `${c.stream}: ok must be null, not true`);
        assert.ok(c.reason, `${c.stream}: a reason must be given`);
      }
    });
  });
});

// ================================================================ SNAPSHOT MODE

describe('snapshot mode: real data, read-only', () => {
  test('a supplied database is projected through the production functions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teos-vercel-snap-'));
    const file = makeSnapshotDb(dir);
    try {
      withEnv({ TEOS_SNAPSHOT_DB: file }, () => {
        const body = handle({ method: 'GET', path: '/api/snapshot' }).body;
        assert.equal(body.dataState, DATA_STATE.SNAPSHOT);
        assert.equal(body.noDataMessage, null, 'there IS data, so no empty notice');
        assert.equal(body.account.cashEgp, 487.5, 'a real measured balance, not null');
        assert.equal(body.account.equityEgp, 487.5);
        assert.equal(body.account.realizedPnlEgp, -12.5);
        assert.equal(body.account.feesPaidEgp, 9.5);
        assert.equal(body.account.equityInvariant.ok, true);
        assert.deepEqual(body.deployment, { ...DEPLOYMENT, ...TRUTH });
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('snapshot mode still reports no worker, because none is started', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teos-vercel-snap2-'));
    const file = makeSnapshotDb(dir);
    try {
      withEnv({ TEOS_SNAPSHOT_DB: file }, () => {
        const agent = handle({ method: 'GET', path: '/api/section/agent' }).body;
        assert.equal(agent.heartbeat, null, 'a snapshot database is not a running worker');
        assert.equal(agent.run, null);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a snapshot is read-only: the query parameters cannot reach the filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teos-vercel-snap3-'));
    const file = makeSnapshotDb(dir);
    try {
      withEnv({ TEOS_SNAPSHOT_DB: file }, () => {
        // Classic path traversal and injection attempts, all of which must be
        // inert: the only path in the system came from the operator's env.
        for (const q of [
          'limit=../../../../etc/passwd',
          'db=../../../secrets.db',
          'limit=99999999',
          "limit=1&limit=2&limit=' OR 1=1 --",
          'equity=NaN',
        ]) {
          const res = handle({ method: 'GET', path: '/api/snapshot', query: q });
          assert.equal(res.status, 200, `query "${q}" produced ${res.status}`);
          assert.doesNotThrow(() => JSON.parse(JSON.stringify(res.body)));
          assert.equal(res.body.account.cashEgp, 487.5, 'a query parameter changed the data source');
        }
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a configured-but-missing database degrades honestly instead of crashing', () => {
    withEnv({ TEOS_SNAPSHOT_DB: join(TMP, 'nope', 'missing.db') }, () => {
      const body = handle({ method: 'GET', path: '/api/snapshot' }).body;
      assert.equal(body.dataState, DATA_STATE.NO_DATABASE);
      assert.equal(body.reason, 'snapshot_not_found');
      assert.equal(body.account.cashEgp, null);
      // No host path may appear in a response.
      const text = JSON.stringify(body);
      assert.ok(!text.includes('missing.db'), 'the response leaked a filesystem path');
      assert.ok(!text.includes(TMP), 'the response leaked the temp directory');
    });
  });

  test('an un-migrated database is "no schema", never "no data"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teos-vercel-noschema-'));
    const file = join(dir, 'empty.db');
    const db = openDatabase(file);
    db.run('CREATE TABLE unrelated (x INTEGER)'); // a valid database with the wrong schema
    db.close();
    try {
      withEnv({ TEOS_SNAPSHOT_DB: file }, () => {
        const body = handle({ method: 'GET', path: '/api/snapshot' }).body;
        assert.equal(body.reason, 'snapshot_has_no_schema');
        assert.equal(body.account.cashEgp, null);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a database with no PAPER balance row is empty, not defaulted to 500', () => {
    // The specific hole the guard in state.js closes: a database that opens and
    // migrates but holds no balance would otherwise render EGP 500 as measured.
    const dir = mkdtempSync(join(tmpdir(), 'teos-vercel-nobalance-'));
    const file = join(dir, 'nobalance.db');
    const db = openDatabase(file);
    migrate(db, new ManualClock(EPOCH));
    db.close();
    try {
      withEnv({ TEOS_SNAPSHOT_DB: file }, () => {
        const body = handle({ method: 'GET', path: '/api/snapshot' }).body;
        assert.equal(body.dataState, DATA_STATE.NO_DATABASE);
        assert.equal(body.reason, 'snapshot_has_no_paper_balance_row');
        assert.equal(body.account.cashEgp, null, 'fell back to the configured capital');
        assert.equal(body.account.equityEgp, null);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ================================================================= HEALTHZ

describe('/api/healthz', () => {
  test('names service, version, mode, runtime and deployment status', () => {
    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      const { status, body } = handle({ method: 'GET', path: '/api/healthz' });
      assert.equal(status, 200);
      assert.equal(body.service, 'teos-trade-agent');
      assert.equal(body.mode, 'PAPER');
      assert.equal(body.runtime, 'nodejs');
      assert.match(body.version, /^\d+\.\d+\.\d+/);
      assert.equal(body.deploymentStatus.role, 'read-only-presentation-layer');
      assert.equal(body.deploymentStatus.startsWorker, false);
      assert.equal(body.deploymentStatus.canPlaceOrders, false);
      assert.equal(body.deploymentStatus.stateOwner, 'local-worker');
      assert.equal(body.deploymentStatus.readOnly, true);
      assert.match(body.version, /^\d+\.\d+\.\d+/);
    });
  });

  test('the mode is PAPER even with nothing readable', () => {
    // PAPER is a literal in identity.js, not a value read from a config file or
    // a database, precisely so that an environment which can read neither still
    // answers truthfully.
    withEnv({ TEOS_SNAPSHOT_DB: join(TMP, 'definitely-absent.db') }, () => {
      assert.equal(handle({ method: 'GET', path: '/api/healthz' }).body.mode, 'PAPER');
    });
  });

  test('healthz states plainly that Vercel provides no persistent database', () => {
    const body = handle({ method: 'GET', path: '/api/healthz' }).body;
    assert.equal(body.vercelHasPersistentDatabase, false);
    assert.equal(body.vercelProvidesPersistentSqlite, false);
    assert.equal(body.vercelStartsAWorker, false);
    assert.equal(body.workerRunsLocally, true);
  });

  test('a credential in the environment makes the deployment refuse rather than serve', () => {
    for (const varName of ['TEOS_TRADING_API_KEY', 'TEOS_TRADING_API_SECRET', 'TEOS_MARKET_DATA_API_KEY']) {
      withEnv({ [varName]: 'not-a-real-value' }, () => {
        const res = handle({ method: 'GET', path: '/api/healthz' });
        assert.equal(res.status, 503, `${varName}: expected 503, got ${res.status}`);
        assert.equal(res.body.status, 'refused');
        assert.equal(res.body.refused.reason, 'forbidden_environment_variable');
        // The refusal must name the variable class, never its value.
        assert.ok(!JSON.stringify(res.body).includes('not-a-real-value'),
          `${varName}: the refusal leaked the value`);
      });
    }
  });

  test('a credential in the environment also stops the snapshot from being served', () => {
    withEnv({ TEOS_TRADING_API_KEY: 'not-a-real-value' }, () => {
      assert.equal(handle({ method: 'GET', path: '/api/snapshot' }).status, 503);
    });
  });
});

// ============================================================ CAPABILITY WALL

describe('the deployment cannot reach trading capability', () => {
  /** Resolve the static ESM import graph of the Vercel entrypoint. */
  function importGraph(entry) {
    const seen = new Set();
    (function walk(file) {
      const f = resolve(file);
      if (seen.has(f) || !existsSync(f)) return;
      seen.add(f);
      let source;
      try { source = readFileSync(f, 'utf8'); } catch { return; }
      const re = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        if (!m[1].startsWith('.')) continue;
        walk(resolve(dirname(f), m[1]));
      }
    }(entry));
    return [...seen].map((f) => relative(ROOT, f).replace(/\\/g, '/'));
  }

  test('no worker, broker, execution, risk, agent, backtest or paper module is reachable', () => {
    const graph = importGraph(join(ROOT, 'api', '[[...slug]].js'));
    for (const dir of ['src/worker', 'src/broker', 'src/execution', 'src/risk', 'src/agent', 'src/backtest', 'src/paper']) {
      const reached = graph.filter((g) => g.startsWith(`${dir}/`));
      assert.deepEqual(reached, [], `the Vercel graph reaches ${reached.join(', ')}`);
    }
    // And it is not vacuously empty - it genuinely loads the read path.
    assert.ok(graph.includes('src/vercel/router.js'));
    assert.ok(graph.includes('src/dashboard/api.js'));
  });

  test('no route name implies a write, a trade or an execution', () => {
    const source = readFileSync(join(ROOT, 'src', 'vercel', 'router.js'), 'utf8');
    for (const word of ['submit', 'placeOrder', 'execute', 'cancel', 'kill', 'resume', 'withdraw', 'transfer']) {
      assert.ok(!new RegExp(`['"\`]/${word}`, 'i').test(source), `router exposes a /${word} route`);
    }
  });

  test('no response body contains a credential value', () => {
    // Names are not secrets: `describeEnv()` is a fixed allow-list that reports
    // which variables EXIST so an operator can see they are unset. What must
    // never appear is a value. `TEOS_SNAPSHOT_DB` is deliberately absent from
    // that allow-list, so the deployment never advertises its own configuration.
    const env = handle({ method: 'GET', path: '/api/env' }).body.env;
    for (const [name, value] of Object.entries(env)) {
      assert.equal(value, null, `${name} reported a value from /api/env`);
    }
    assert.ok('TEOS_TRADING_API_KEY' in env, 'the allow-list should still name the credential variables');
    assert.ok(!('TEOS_SNAPSHOT_DB' in env), '/api/env must not advertise the snapshot database variable');

    withEnv({ TEOS_SNAPSHOT_DB: undefined }, () => {
      for (const path of ['/api/healthz', '/api/snapshot', '/api/env', '/api/audit/chains',
        '/api/section/account', '/api/section/agent', '/api/section/risk', '/api/section/audit']) {
        const text = JSON.stringify(handle({ method: 'GET', path }).body);
        assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}/.test(text),
          `${path} contains a credential-shaped value`);
      }
    });
  });

  test('the deployment layer imports no process-spawning or shell module', () => {
    for (const rel of importGraph(join(ROOT, 'api', '[[...slug]].js'))) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      assert.ok(!/from\s*['"]node:child_process['"]/.test(text), `${rel} imports node:child_process`);
      assert.ok(!/from\s*['"]node:worker_threads['"]/.test(text), `${rel} imports node:worker_threads`);
      assert.ok(!/from\s*['"]node:net['"]/.test(text), `${rel} imports node:net`);
    }
  });
});

// ================================================================= DASHBOARD

describe('the Vercel dashboard', () => {
  test('says TEOS TRADE AGENT and PAPER in static markup, not only after JS runs', () => {
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /TEOS/);
    assert.match(html, /TRADE AGENT/);
    assert.match(html, />PAPER</);
    assert.match(html, /SIMULATION ONLY/);
    assert.match(html, /no real money/);
  });

  test('loads the shell that adds the read-only banner and the no-data notice', () => {
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /\/vercel-shell\.js/);
    assert.match(html, /\/vercel-shell\.css/);
  });

  test('reuses the existing dashboard renderer and stylesheet byte for byte', () => {
    for (const name of ['app.js', 'style.css']) {
      const built = readFileSync(join(ROOT, 'public', name));
      const source = readFileSync(join(ROOT, 'src', 'dashboard', 'public', name));
      assert.ok(built.equals(source), `public/${name} has drifted from src/dashboard/public/${name}`);
    }
  });

  test('the committed index.html is exactly what the build generates', () => {
    // THE REPRODUCIBILITY TEST. It was missing, and its absence is how a mixed
    // -line-ending bug survived a full green suite: the drift checks above only
    // byte-compared the VERBATIM copies and never the PATCHED file.
    //
    // Regenerating from source in memory and comparing bytes to the committed
    // output is the only assertion that catches "the build is stable but does
    // not produce what is in the repository".
    const source = readFileSync(join(ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');
    const expected = Buffer.from(patchIndex(source), 'utf8');
    const committed = readFileSync(join(ROOT, 'public', 'index.html'));
    assert.ok(expected.equals(committed),
      'public/index.html is not what `npm run build` generates - run `npm run build` and commit the result');
  });

  test('the build emits one line-ending convention, never a mix', () => {
    // A file with both CRLF and bare LF is not reproducible, is invisible in a
    // normal diff, and is a real portability hazard on a Linux build runner.
    for (const rel of ['public/index.html', 'public/app.js', 'public/style.css',
      'public/vercel-shell.js', 'public/vercel-shell.css']) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const crlf = (text.match(/\r\n/g) ?? []).length;
      const bare = (text.match(/(?<!\r)\n/g) ?? []).length;
      assert.ok(crlf === 0 || bare === 0,
        `${rel} has mixed line endings (${crlf} CRLF, ${bare} bare LF)`);
    }
  });

  test('the patch is a pure function of its input', () => {
    const source = readFileSync(join(ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');
    assert.equal(patchIndex(source), patchIndex(source));
    // And it must be idempotent-safe: applying it twice would double the tags,
    // which is what would happen if a generated file were ever used as input.
    assert.notEqual(patchIndex(patchIndex(source)), patchIndex(source));
  });

  test('the patch refuses to run against markup it does not recognise', () => {
    assert.throws(() => patchIndex('<html><body>no anchors here</body></html>'),
      /anchor .* not found/);
    // Ambiguity is a failure, not a coin flip.
    assert.throws(() => patchIndex('<head></head><body></body></head>'),
      /more than once/);
  });

  test('the patch matches the source file line endings', () => {
    const crlf = patchIndex('<html>\r\n<head></head>\r\n<body></body>\r\n</html>');
    assert.ok(!/(?<!\r)\n/.test(crlf), 'a CRLF source must yield a CRLF output, with no bare LF');
    assert.equal((crlf.match(/\r\n/g) ?? []).length, 5);
    const lf = patchIndex('<html>\n<head></head>\n<body></body>\n</html>');
    assert.ok(!lf.includes('\r'), 'an LF source must yield an LF output');
    // And a mixed output is a hard failure rather than a silent one.
    assert.throws(
      () => assertUniformNewlines('a\r\nb\nc', 'x.html'),
      /mixed line endings/);
  });

  test('the shell tells the truth about what this deployment is', () => {
    const shell = readFileSync(join(ROOT, 'public', 'vercel-shell.js'), 'utf8');
    assert.match(shell, /PAPER/);
    assert.match(shell, /READ-ONLY/);
    assert.match(shell, /starts no trading worker/i);
    // The exact wording shown to an operator lives in empty.js, not here - the
    // shell renders whatever the API says rather than hard-coding a second copy
    // that could disagree with it.
    assert.match(NO_DATA_MESSAGE, /No persistent worker data available/i);
    assert.match(shell, /noDataMessage/, 'the shell must display the API message, not its own wording');
    // An unreachable endpoint must be reported as unavailable, not as an
    // empty account.
    assert.match(shell, /availability problem, not an empty account/i);
  });

  test('the shell cannot make a network call other than to this origin', () => {
    const shell = readFileSync(join(ROOT, 'public', 'vercel-shell.js'), 'utf8');
    assert.equal(shell.match(/fetch\(/g).length, 1, 'the shell should make exactly one request');
    assert.ok(!/https?:\/\//.test(shell.replace(/http:\/\/localhost/g, '')),
      'the shell references an absolute URL');
  });
});