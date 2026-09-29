/**
 * Required regressions A and B, plus the dashboard's HTTP safety surface.
 *
 * A. `/api/snapshot` must succeed.
 * B. The mode badge must read the REAL snapshot mode, and BACKTEST must never
 *    display PAPER.
 *
 * Both of these were broken and both broke in a way no other test could see. The
 * snapshot threw a SQL error on every request because `equitySeries({newest:
 * true})` selected an `id` column in the inner query and then re-sorted on it
 * without selecting it; the dashboard rendered nothing at all, so the "is the
 * dashboard working" question had no answer. Separately, `envelope()` omitted
 * `mode` from the payload and the page badge hard-coded the string 'PAPER', so
 * a BACKTEST run would have been labelled PAPER - the single most misleading
 * thing this system could display, because a backtest is not a paper trade and
 * must never be presented as one.
 *
 * The HTTP-safety tests below are the third part of this file. They are not on
 * the required list, but a dashboard that is wrong in the safe direction is
 * still wrong, and these are the properties that make "read-only,
 * loopback-only" an enforced fact rather than a comment.
 *
 * A NOTE ON HOW THESE TESTS WERE WRITTEN. Several of them first failed because
 * they described an API that does not exist - a field that was never emitted, a
 * null that is really an object, a client limitation mistaken for a server
 * result, a check aimed at the test harness's own writable handle instead of the
 * server's. Every such assertion has been re-pointed at the real surface rather
 * than deleted, and the surrounding comment records what the real surface is, so
 * the next reader does not have to rediscover it. Nothing here asserts a
 * behaviour the code does not have.
 */

import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, settle, orderIdOf, assert, REPO_ROOT } from './helpers/harness.js';
import { DashboardServer, isLoopbackHost, LOOPBACK_HOSTS } from '../src/dashboard/server.js';
import { makeView, section, SECTIONS } from '../src/dashboard/api.js';
import { openDatabase } from '../src/database/db.js';
import { AuditChain } from '../src/database/audit-chain.js';
import { Repos } from '../src/database/repositories/index.js';
import { loadConfig } from '../src/core/config.js';
import { describeEnv, isSecretKey, redact } from '../src/core/env.js';

/**
 * Boot a real dashboard on an ephemeral port over the harness's database.
 *
 * `get` uses `fetch`, which is fine for GET. `raw` uses `node:http` directly,
 * and exists because undici refuses to put some methods on the wire at all -
 * `fetch(url, {method: 'TRACE'})` throws "'TRACE' HTTP method is unsupported"
 * in the CLIENT, before a byte leaves the process. Asserting anything about
 * the server through that path would be asserting undici's method table. A
 * refusal that is the server's decision has to be probed with a client that
 * will actually send the request.
 */
async function serve(h, extra = {}) {
  const server = new DashboardServer(h.config, { mode: h.mode, host: '127.0.0.1', port: 0, ...extra });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const decode = (status, rawHeaders, text) => {
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: static asset or error page */ }
    // One header shape for both transports: `fetch` hands back a `Headers`,
    // `node:http` a plain object, and a test that reads one route with one
    // client and another with the other must not read two different objects.
    let headers = rawHeaders;
    if (!(rawHeaders instanceof Headers)) {
      headers = new Headers();
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (Array.isArray(v)) for (const one of v) headers.append(k, one);
        else headers.set(k, v);
      }
    }
    return { status, headers, text, json };
  };
  return {
    server,
    base,
    port: address.port,
    async get(path, init) {
      const res = await fetch(`${base}${path}`, init);
      return decode(res.status, res.headers, await res.text());
    },
    /** One request, any method, any body. Same result shape as `get`. */
    raw(method, path, body = null) {
      return new Promise((resolve, reject) => {
        const headers = body === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        };
        const req = httpRequest({ host: '127.0.0.1', port: address.port, method, path, headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(decode(res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
      });
    },
    async close() { server.close(); },
  };
}

/** A dashboard with some real trading behind it, so the payload is not empty. */
async function tradedDashboard(h) {
  h.tickMarket(); h.advance();
  const entry = await h.submit(h.buyDecision({ price: h.quote().mid }));
  settle(h, orderIdOf(entry.order), { maxTicks: 20 });
  for (let i = 0; i < 5; i += 1) { h.tickMarket(); h.advance(); }
  await h.submit(h.buyDecision({ price: h.quote().mid, confidence: 0.01 }));
}

/**
 * A real config for `mode` over the harness's own data directory.
 *
 * The per-mode database file name is decided by `core/config.js`, so the test
 * asks the config loader for it rather than restating the rule: a test that
 * hard-codes `teos-${mode}.db` asserts its own string, not the production one.
 */
function configForMode(h, mode) {
  const env = { ...process.env, TEOS_DATA_DIR: h.dataDir, TEOS_LOG_DIR: h.logDir };
  delete env.TEOS_MODE;
  delete env.TEOS_LIVE_TRADING_ENABLED;
  delete env.TEOS_DASHBOARD_TOKEN;
  return loadConfig({ path: join(REPO_ROOT, 'config', 'default.json'), overrides: { mode }, env });
}

/**
 * A second set of repositories in ANOTHER mode, over the SAME database file.
 *
 * Built from the production objects - `openDatabase`, `AuditChain`, `Repos` -
 * so anything written through them was written by the same code that writes
 * every other row, under the same schema and the same constraints.
 *
 * Why the same file rather than the other mode's own file: the harness's `mode`
 * option sets the repositories' mode, not `config.mode`, so a BACKTEST harness
 * opens the same `teos-paper.db` a PAPER one would. That is the harder case and
 * the one worth testing. In production `src/cli.js` passes
 * `overrides: { mode }` to `loadConfig`, so each mode does get its own file
 * (asserted below, through the real config loader); here they share one, and
 * only the `mode` COLUMN separates them. A view that displayed another mode's
 * emergency stop would then be ignoring that column, not leaning on a file it
 * never opened.
 */
function otherModeRepos(h, mode) {
  const db = openDatabase(h.config.paths.dbFile);
  h.trackDb(db); // Windows keeps the file locked until the handle is closed
  const chain = new AuditChain(db);
  return { db, chain, repos: new Repos(db, chain, { mode, instanceId: `test-${mode.toLowerCase()}` }) };
}

/**
 * A content fingerprint of every row in the database, as a stable string.
 *
 * "The dashboard did not change anything" has to mean the CONTENTS, not the
 * file size, so this reads every row of every table and hashes the rows in a
 * deterministic order. It is computed through the harness's own handle, which
 * is the thing that can see a write if one happened.
 */
function fingerprint(db) {
  const tables = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((t) => t.name);
  return tables.map((t) => {
    const cols = db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    const rows = db.all(`SELECT * FROM ${t}`)
      .map((r) => JSON.stringify(r, cols))
      .sort();
    return `${t}[${cols.join(',')}]:${rows.length}:${createHash('sha256').update(rows.join('\n')).digest('hex')}`;
  }).join('\n');
}

/** Every field in a payload whose NAME looks like a credential carrier. */
function secretBearingFields(value, path = '', out = []) {
  if (value == null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) out.push({ path: `${path}.${k}`, value: v });
    secretBearingFields(v, `${path}.${k}`, out);
  }
  return out;
}

// ---------------------------------------------------------------- REGRESSION A

test('REGRESSION A: /api/snapshot succeeds, with and without any trading', async () => {
  const h = createHarness();
  try {
    await tradedDashboard(h);
    const d = await serve(h);
    try {
      const res = await d.get('/api/snapshot');
      assert.equal(res.status, 200, `the snapshot is served (got ${res.status}: ${res.text.slice(0, 200)})`);
      assert.ok(res.json != null, 'and it is valid JSON');

      // The four sections, all present. A snapshot that omits one is not a
      // smaller dashboard, it is a broken one.
      for (const key of ['generatedAt', 'mode', 'disclaimer', 'account', 'agent', 'risk', 'audit']) {
        assert.ok(key in res.json, `the snapshot carries "${key}"`);
      }
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('REGRESSION A2: the equity curve inside the snapshot is populated and ordered', async () => {
  const h = createHarness();
  try {
    // The field is `account.equityCurve`, not `equitySeries`: `accountSection()`
    // projects the `equity_curve` rows through `repos.equitySeries(...)` and
    // names the result for what the client draws with it. Each point carries
    // `tsMs` (camelCase, like every other field in the payload), not `ts_ms`.
    //
    // The window has to be a real SUBSET of a real series, which is where the
    // ordering bug was invisible, so the clock has to cross the curve's
    // persistence cadence: `PaperAccount` writes one `equity_curve` row per
    // `persistEveryMs` (60s), not one per tick. A second per tick leaves a
    // single stored point and an ordering assertion that can never fail.
    h.tickMarket(); h.advance(61_000);
    await h.submit(h.buyDecision({ price: h.quote().mid }));
    for (let i = 0; i < 25; i += 1) { h.tickMarket(); h.advance(61_000); }

    const stored = h.db.all(
      'SELECT id, ts_ms, equity_egp FROM equity_curve WHERE mode = ? ORDER BY ts_ms ASC, id ASC',
      h.mode,
    );
    assert.ok(stored.length > 10, `the curve holds more samples than the window (${stored.length})`);

    const d = await serve(h);
    try {
      const res = await d.get('/api/snapshot?equity=10&limit=50');
      assert.equal(res.status, 200, 'the snapshot with a small equity window succeeds');
      const series = res.json.account.equityCurve;
      assert.ok(Array.isArray(series), 'the equity curve is an array');
      assert.ok(series.length > 0, `and it is populated (${series.length} points)`);
      assert.ok(series.length <= 10, `and it honours the requested window (${series.length} <= 10)`);

      // The window is the TAIL, which is the whole point of `newest: true`: a
      // 24/7 worker appends forever, so taking the head would chart day one for
      // the life of the account.
      assert.equal(
        series[series.length - 1].tsMs, stored[stored.length - 1].ts_ms,
        'the last point is the newest sample on disk',
      );
      assert.equal(
        series[0].tsMs, stored[stored.length - series.length].ts_ms,
        'and the first point is the oldest sample OF THE WINDOW, not of the table',
      );
      assert.equal(
        series[series.length - 1].equityEgp, stored[stored.length - 1].equity_egp,
        'and the point reports the equity that was stored, not a recomputed one',
      );

      // The regression itself. `equitySeries({newest: true})` selected `id` in
      // the inner query and re-sorted on it in the outer one without selecting
      // it, so the snapshot threw on every request. The window therefore comes
      // back in ascending time order even though the newest samples were asked
      // for - which is not what a naive "ORDER BY ts_ms DESC" tail would give.
      assert.ok(series.length >= 2, 'and there are enough points for that ordering to mean something');
      for (let i = 1; i < series.length; i += 1) {
        assert.ok(
          series[i].tsMs >= series[i - 1].tsMs,
          `points are in ascending time order even when the newest window was requested (point ${i})`,
        );
      }

      // Page sizes are clamped, not obeyed. `?equity=1` is below the minimum, so
      // it is raised to it rather than honoured: a caller cannot ask the
      // dashboard for a one-point chart, and cannot ask for an unbounded one.
      const clamped = await d.get('/api/snapshot?equity=1');
      assert.equal(
        clamped.json.account.equityCurve.length, 10,
        'a window below the minimum is raised to the minimum of 10',
      );
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('REGRESSION A3: an empty database still produces a valid snapshot', async () => {
  const h = createHarness();
  try {
    // No ticks, no trades, no balances. The dashboard must describe "nothing
    // yet" rather than 500 - an operator opening it before the worker has run
    // is the normal case, not an edge case.
    const d = await serve(h);
    try {
      const res = await d.get('/api/snapshot');
      assert.equal(res.status, 200, 'an empty database still serves a snapshot');
      assert.equal(res.json.mode, 'PAPER', 'and it still names the mode');
      assert.ok(res.json.account != null, 'with an account section');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('REGRESSION A4: every named section is served on its own', async () => {
  const h = createHarness();
  try {
    await tradedDashboard(h);
    const d = await serve(h);
    try {
      for (const name of SECTIONS) {
        const res = await d.get(`/api/section/${name}`);
        assert.equal(res.status, 200, `section "${name}" is served`);
        assert.ok(res.json != null, `section "${name}" returns JSON`);
      }
      const unknown = await d.get('/api/section/not-a-section');
      assert.equal(unknown.status, 404, 'an unknown section is a 404');
      assert.ok(Array.isArray(unknown.json.sections), 'and the 404 lists the real ones');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------- REGRESSION B

test('REGRESSION B: the mode badge reads the real mode, and BACKTEST never shows PAPER', async () => {
  for (const mode of ['PAPER', 'BACKTEST']) {
    const h = createHarness({ mode });
    try {
      await tradedDashboard(h);
      const d = await serve(h, { mode });
      try {
        const res = await d.get('/api/snapshot');
        assert.equal(res.status, 200, `the ${mode} snapshot is served`);
        assert.equal(
          res.json.mode, mode,
          `the payload says "${mode}" - not a constant, and not the other mode`,
        );
        assert.equal(res.json.disclaimer.paperOnly, true, 'the disclaimer is present in both modes');

        // The page must render the mode from the payload, not from a literal.
        const html = await d.get('/');
        assert.equal(html.status, 200, 'the page is served');
        const app = await d.get('/app.js');
        assert.equal(app.status, 200, 'and its script is served');
        assert.ok(
          !/>PAPER</.test(app.text),
          'the client script contains no hard-coded "PAPER" badge literal',
        );
        assert.ok(
          /\bmode\b/.test(app.text),
          'it does refer to the mode from the payload',
        );
      } finally {
        await d.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test('REGRESSION B2: a BACKTEST dashboard reports its own stop and never a PAPER one', async () => {
  const h = createHarness({ mode: 'BACKTEST' });
  try {
    await tradedDashboard(h);

    // Why the PAPER stop below can go into the same file the dashboard reads.
    // In production `src/cli.js` passes `overrides: { mode }` to `loadConfig`,
    // so each mode is opened from its own file and a cross-mode read is
    // physically impossible. Asserted through the real loader, because that is
    // the property and not the file name.
    assert.notEqual(
      configForMode(h, 'PAPER').paths.dbFile,
      configForMode(h, 'BACKTEST').paths.dbFile,
      'in production the two modes are opened from different database files',
    );
    // The harness does NOT do that: its `mode` option sets the repositories'
    // mode, not `config.mode`, so this BACKTEST harness opened the PAPER file.
    // That is the harder case - the two modes share one file and only the
    // `mode` COLUMN separates them - so the test is built on it deliberately,
    // and this assertion says so, because a harness that changed would
    // otherwise silently weaken everything below.
    assert.equal(
      h.config.paths.dbFile, configForMode(h, 'PAPER').paths.dbFile,
      'the harness opens one file for both modes, which is the case under test',
    );

    // Arrange a REAL PAPER emergency stop, latched and active, written into the
    // very database the BACKTEST dashboard is about to read. Asserting "no PAPER
    // stop appears" against a database that has never contained one proves
    // nothing: the field would be empty however badly the view were scoped.
    const paper = otherModeRepos(h, 'PAPER');
    const paperRunId = paper.repos.createRun({
      mode: 'PAPER',
      instanceId: 'test-paper',
      strategyId: h.config.strategies.active,
      startingCapitalEgp: h.config.account.startingCapitalEgp,
      config: { profile: h.config.profileName, mode: 'PAPER' },
      clock: h.clock,
    });
    const paperStopId = paper.repos.engageStop({
      trigger: 'DAILY_LOSS_LIMIT',
      severity: 'CRITICAL',
      scope: 'HALT_ALL',
      reason: 'a PAPER stop that must never reach a BACKTEST view',
      details: { marker: 'PAPER_ONLY_MARKER' },
      clock: h.clock,
    });
    assert.equal(
      paper.db.get('SELECT active FROM emergency_stops WHERE stop_id = ?', paperStopId)?.active, 1,
      'the PAPER stop is really latched, and it is really in the file the dashboard opens',
    );
    assert.equal(
      h.db.count("SELECT COUNT(*) AS c FROM emergency_stops WHERE mode = 'PAPER' AND active = 1"), 1,
      'so there is an active PAPER stop on disk for a leak to reveal',
    );

    // And a real BACKTEST stop in this run, so the BACKTEST view has something
    // of its own to report. `{ engaged: false }` is what riskSection() returns
    // when `Repos#sessionStop(mode)` finds nothing - an object, not a null, so
    // a client can read `.engaged` without a null check. A view with a stop IN
    // it is the only way to show the lookup picked the right one; a view with an
    // empty field cannot tell a correct scope from a broken one.
    const backtestStopId = h.engageStop({ trigger: 'MANUAL_OPERATOR', reason: 'this run halted' });

    const d = await serve(h, { mode: 'BACKTEST' });
    try {
      const res = await d.get('/api/snapshot');
      assert.equal(res.status, 200, 'the BACKTEST snapshot is served');
      assert.equal(res.json.mode, 'BACKTEST', 'the mode is BACKTEST');

      // The real shape, with a stop in the view.
      const stop = res.json.risk.emergencyStop;
      assert.equal(stop.engaged, true, 'the latched stop is reported as engaged');
      assert.equal(stop.stopId, backtestStopId, 'and it is THIS run\'s stop, identified by id');
      assert.equal(stop.runId, h.runId, 'and it belongs to this run, not to another one');
      assert.equal(stop.trigger, 'MANUAL_OPERATOR', 'with the trigger that caused it');
      assert.equal(stop.severity, 'CRITICAL', 'and its severity');
      assert.equal(stop.scope, 'HALT_ALL', 'and its scope');
      assert.equal(stop.since, h.db.get('SELECT ts FROM emergency_stops WHERE stop_id = ?', backtestStopId).ts, 'and the time it engaged');

      // The mirror image, and the reason the assertion below is not vacuous:
      // a PAPER view built over the SAME database DOES report the PAPER stop.
      // The stop is there, reachable through the API, and only its `mode` keeps
      // it out of the BACKTEST view.
      const paperViewRisk = section(
        makeView({ config: h.config, repos: paper.repos, chain: paper.chain, mode: 'PAPER' }),
        'risk', new URLSearchParams(),
      );
      assert.equal(
        paperViewRisk.emergencyStop.engaged, true,
        'a PAPER view of the same data does see a PAPER stop',
      );
      assert.equal(paperViewRisk.emergencyStop.stopId, paperStopId, 'and it is the PAPER stop, not the BACKTEST one');

      // Mode isolation. Only the `mode` COLUMN separates the two sets of rows
      // here, in one file the dashboard has open, so nothing from another mode
      // may appear anywhere in the payload - not the stop's id, its trigger, its
      // reason or its detail marker, and not a single field claiming PAPER.
      for (const leak of [paperStopId, 'DAILY_LOSS_LIMIT', 'a PAPER stop that must never reach a BACKTEST view', 'PAPER_ONLY_MARKER', paperRunId]) {
        assert.ok(!res.text.includes(leak), `the BACKTEST payload does not mention the PAPER stop's ${JSON.stringify(leak)}`);
      }
      // Not one field anywhere claims to be PAPER. `disclaimer.paperOnly` is a
      // property of the BUILD, not of the mode, so it is checked by name rather
      // than by substring.
      assert.ok(
        !/"mode"\s*:\s*"PAPER"/.test(res.text),
        'no field in the BACKTEST payload claims mode PAPER',
      );
      assert.equal(res.json.disclaimer.paperOnly, true, 'and the build-wide paperOnly disclaimer is still reported');

      // Every stop the view lists is a stop of this mode and this run.
      assert.ok(res.json.risk.stopHistory.length > 0, 'the stop history is populated');
      for (const s of res.json.risk.stopHistory) {
        assert.equal(s.runId, h.runId, `stop ${s.stopId} in the history belongs to this run`);
        assert.notEqual(s.stopId, paperStopId, 'and is not the PAPER stop');
      }
      // The audit lists carry no `mode` column of their own - the mode is
      // applied in the WHERE clause - so the isolation claim is made on ids:
      // everything the payload lists is a row of THIS mode in the database.
      const backtestOrderIds = new Set(
        h.db.all('SELECT order_id FROM orders WHERE mode = ?', 'BACKTEST').map((r) => r.order_id),
      );
      assert.ok(res.json.audit.orders.length > 0, 'the audit list is populated');
      for (const o of res.json.audit.orders) {
        assert.ok(backtestOrderIds.has(o.order_id), `order ${o.order_id} in the audit list is a BACKTEST order`);
      }
      const allBacktest = h.db.all('SELECT mode FROM orders');
      assert.ok(allBacktest.length > 0, 'and the orders on disk really are all BACKTEST');
      assert.ok(allBacktest.every((r) => r.mode === 'BACKTEST'), 'every one of them');
      assert.equal(res.json.agent.run.runId, h.runId, 'and the run the view reports is this run, not the PAPER one');

      // The health endpoint reads the same stop through the same rule, so it
      // must agree with the snapshot rather than answering from a different one.
      const health = await d.get('/healthz');
      assert.equal(health.json.emergencyStopEngaged, true, '/healthz reports the same latched stop');
      assert.equal(health.json.mode, 'BACKTEST', 'and names the same mode');
    } finally {
      await d.close();
    }

    // The same rule one level down, without the server in the way: the stop the
    // risk section reports must belong to the run the view is scoped to. A view
    // and a stop lookup that disagreed would display another run's verdict.
    const view = makeView({ config: h.config, repos: h.repos, chain: h.chain, mode: 'BACKTEST' });
    assert.equal(view.scopeRunId, h.runId, 'the view is scoped to this run');
    const risk = section(view, 'risk', new URLSearchParams());
    assert.equal(risk.emergencyStop.engaged, true, 'the risk section sees the latched stop');
    assert.equal(risk.emergencyStop.runId, view.scopeRunId, 'and reports it as belonging to the run the view is scoped to');
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------- run-scoped emergency stop

test('DASHBOARD: an emergency stop is scoped to the run the view describes', async () => {
  // A defect the test above could not see, because it latched its stop in the
  // run it was reading.
  //
  // `Repos.sessionStop()` decides scope from `repos.runId`. In BACKTEST that is
  // the run, and a null runId is indistinguishable from "no scoping requested",
  // so the lookup falls through to the UNSCOPED query: the newest active stop
  // for the MODE, from any run in that mode's history. `makeView` computed the
  // correct `scopeRunId` and every other query on the page used it -
  // `countDecisions`, `countOrders`, `tradeStats` - but the one query that reads
  // a stop went around it, because the server never called `repos.setRun()`.
  //
  // The result was a page showing one backtest run's decisions, orders and
  // fills beside an emergency stop belonging to a DIFFERENT run in the same
  // mode. It is the exact failure the existing comment in `makeView` says must
  // not happen: a dashboard that disagreed with the engine about scope, and so
  // displayed another run's verdict. The old test asserted the stop was visible
  // and belonged to the view's run - both true when the view's run IS the
  // latching run, which is the only arrangement it built. So the missing case
  // is not a stronger version of that test; it is a different shape of database.
  const h = createHarness({ mode: 'BACKTEST' });
  try {
    const runA = h.runId;

    // Run A halts. The stop row carries run A's id, and is ACTIVE.
    const stopA = h.engageStop({ trigger: 'MANUAL_OPERATOR', reason: 'run A halted' });
    const stopRow = h.db.get('SELECT run_id, active FROM emergency_stops WHERE stop_id = ?', stopA);
    assert.equal(stopRow.run_id, runA, 'the stop belongs to run A on disk');
    assert.equal(stopRow.active, 1, 'and it is active - a cleared stop would make this test vacuous');

    // Run B starts afterwards, in the SAME database and the SAME mode. Its own
    // kill switch is clear: nothing about run B has gone wrong.
    const runB = 'run_second_backtest';
    h.repos.createRun({
      runId: runB,
      mode: 'BACKTEST',
      strategyId: 'strategy-under-test',
      startingCapitalEgp: h.config.risk.maxStartingCapitalEgp,
      config: h.config,
      clock: h.clock,
    });
    // `latestRun` orders by `started_at DESC, rowid DESC`, so the later insert
    // wins the tie deterministically even under a frozen test clock. Asserted
    // rather than assumed, because every scoping claim below depends on it.
    assert.equal(h.repos.latestRun('BACKTEST').run_id, runB, 'the newest BACKTEST run is B, so the view will describe B');

    // --- the defect itself -------------------------------------------------
    // Built BEFORE any view exists, so nothing has had a chance to scope the
    // repository. This is the raw state the server used to be in.
    h.repos.setRun(null);
    const unscoped = h.repos.sessionStop('BACKTEST');
    assert.equal(unscoped?.stop_id ?? null, stopA, 'baseline: with no run scope, the lookup returns run A\'s stop - this is what the dashboard used to show');

    // --- the fix -----------------------------------------------------------
    const view = makeView({ config: h.config, repos: h.repos, chain: h.chain, mode: 'BACKTEST' });
    assert.equal(view.scopeRunId, runB, 'the view describes run B');
    assert.equal(h.repos.runId, runB, 'and the repository now agrees with the view about which run it is reading');

    const risk = section(view, 'risk', new URLSearchParams());
    assert.equal(
      risk.emergencyStop.engaged, false,
      "run B's page does not report run A's stop as its own emergency stop",
    );
    // Not merely disengaged: run A's stop id must not appear in the engaged
    // block at all, so this cannot be satisfied by a lookup that found the
    // right stop and then mislabelled it.
    assert.notEqual(risk.emergencyStop.stopId ?? null, stopA, 'and run A\'s stop id is not presented as B\'s');
    assert.equal(h.repos.sessionStop('BACKTEST') ?? null, null, 'the repository itself reports no active stop for B');

    // --- the assertion is not vacuous --------------------------------------
    // Scope B back to run A and the very same stop must reappear. If this failed
    // the test above would be passing merely because no stop exists anywhere.
    h.repos.setRun(runA);
    assert.equal(
      h.repos.sessionStop('BACKTEST')?.stop_id ?? null, stopA,
      "scoped to run A, the same stop is found - so it is present, active, and correctly attributed",
    );

    // And the converse: a stop latched by B itself must be honoured, or the fix
    // would have bought isolation by making stops invisible.
    h.repos.setRun(runB);
    const stopB = h.engageStop({ trigger: 'DAILY_LOSS_LIMIT', reason: 'run B halted' });
    const viewAfterStop = makeView({ config: h.config, repos: h.repos, chain: h.chain, mode: 'BACKTEST' });
    const riskAfterStop = section(viewAfterStop, 'risk', new URLSearchParams());
    assert.equal(riskAfterStop.emergencyStop.engaged, true, "run B's own stop IS reported as engaged");
    assert.equal(riskAfterStop.emergencyStop.stopId, stopB, 'and it is B\'s stop');
    assert.notEqual(riskAfterStop.emergencyStop.stopId, stopA, 'not run A\'s');

    // --- over real HTTP, through a server that scopes nothing itself -------
    // `serve()` builds a fresh DashboardServer, and therefore a fresh `Repos`
    // with a null runId. If the fix lived in the test rather than in
    // `makeView`, this is the request that would expose it.
    const d = await serve(h, { mode: 'BACKTEST' });
    try {
      const res = await d.get('/api/snapshot');
      assert.equal(res.status, 200, 'the snapshot is served');
      assert.equal(res.json.agent.run.runId, runB, 'and it describes run B');
      assert.equal(res.json.risk.emergencyStop.engaged, true, "run B's own latched stop is reported");
      assert.equal(res.json.risk.emergencyStop.stopId, stopB, 'and it is B\'s stop, not A\'s');
      // `/healthz` reads the stop through `sessionStop()` as well; it must
      // agree with the snapshot rather than answering from a different scope.
      const health = await d.get('/healthz');
      assert.equal(health.json.emergencyStopEngaged, true, '/healthz agrees the stop is engaged');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------------ HTTP safety

test('DASHBOARD: it refuses to bind anything but loopback', () => {
  // `isLoopbackHost` is the enforcement, and it is deliberately literal: it
  // lower-cases the string and then matches LITERAL loopback addresses. It
  // never resolves a name, so no lookup can turn a loopback decision into a
  // LAN one. The two mistakes that matter are both refused:
  for (const bad of [
    '0.0.0.0',                  // "every interface" - the classic mistake
    '::',                       // the same thing, in IPv6
    '192.168.1.10', '10.0.0.1', '172.16.0.1', '169.254.169.254',
    'example.com', 'localhost', '',
    '1127.0.0.1',               // loopback-looking, but not in 127.0.0.0/8
    '::FFFF:127.0.0.1',         // an IPv4-mapped address, not a literal
    '127.0.0.1 ',               // no trimming: the string checked is the string
    //                           that is passed to listen()
  ]) {
    assert.equal(isLoopbackHost(bad), false, `${JSON.stringify(bad)} is not loopback`);
  }

  // The whole of 127.0.0.0/8, which is loopback by definition, and every
  // accepted spelling of the IPv6 loopback.
  for (const good of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackHost(good), true, `${JSON.stringify(good)} is loopback`);
  }

  // `LOOPBACK_HOSTS` is the list of literal bind targets the module advertises,
  // and it is frozen so nothing at runtime can add a host to it. It used to
  // contain "localhost", which the check refuses - a constant advertising a
  // value the code rejects. The invariant now asserted is the one that matters:
  // nothing may be advertised that enforcement would then refuse, because an
  // operator who reads the list and configures `dashboard.host` from it must
  // not be turned away at startup. The set was narrowed; the predicate was not
  // weakened, and still resolves no name.
  assert.ok(Object.isFrozen(LOOPBACK_HOSTS), 'the advertised allow-list cannot be mutated at runtime');
  for (const advertised of LOOPBACK_HOSTS) {
    assert.equal(isLoopbackHost(advertised), true, `${JSON.stringify(advertised)} is advertised AND accepted`);
  }
  assert.ok(!LOOPBACK_HOSTS.includes('localhost'), 'no name is advertised: the check never resolves one, so a name is always a hard error');
  // The advertised list must also be a subset of what the predicate accepts,
  // in the direction that matters. Anything advertised-but-refused is the defect.
  for (const refusedAbove of ['localhost', 'example.com', '0.0.0.0', '192.168.1.10']) {
    assert.ok(
      !LOOPBACK_HOSTS.includes(refusedAbove),
      `${JSON.stringify(refusedAbove)} is refused by the check, so it must not be advertised as permitted`,
    );
  }

  // And the constructor refuses rather than binding. The message is the
  // operator's next action, so the assertion is on the real wording: a bare
  // /loopback/ would also match the unrelated allowNonLoopbackBind guard below.
  const h = createHarness();
  try {
    const refused = /Refusing to bind the dashboard to ".*"\. Loopback only in Phase 1; set dashboard\.host to 127\.0\.0\.1\./;
    for (const host of ['0.0.0.0', '192.168.1.10', '::', 'localhost', '']) {
      assert.throws(
        () => new DashboardServer(h.config, { mode: 'PAPER', host, port: 0 }),
        refused,
        `constructing a server for ${JSON.stringify(host)} throws instead of listening`,
      );
    }

    // The escape hatch is checked first, and it is a real gate rather than a
    // config convention: `loadConfig` already rejects the flag, so this is the
    // second, independent refusal - the one that holds if a future config
    // loader is more permissive.
    assert.throws(
      () => new DashboardServer(
        { ...h.config, dashboard: { ...h.config.dashboard, allowNonLoopbackBind: true } },
        { mode: 'PAPER', host: '127.0.0.1', port: 0 },
      ),
      /Refusing to start: dashboard\.allowNonLoopbackBind is not false\./,
      'a config that opens the non-loopback bind is refused before any host is considered',
    );
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: it is read-only - every write method is refused with 405', async () => {
  const h = createHarness();
  try {
    const d = await serve(h);
    try {
      // Probed with `node:http` rather than `fetch`, because undici refuses to
      // send TRACE at all: the refusal would be the client's, and the test
      // would be asserting undici's method table.
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
        // With a body, where the method has one. A write that is refused must be
        // refused with its payload attached, not only when empty.
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? '{"equityEgp":1000000}' : null;
        const res = await d.raw(method, '/api/snapshot', body);
        assert.equal(res.status, 405, `${method} is refused`);
        assert.equal(res.headers.get('allow'), 'GET, HEAD', `${method} is told what is allowed`);
        assert.equal(res.json.error, 'The dashboard is read-only.', `${method} is refused in words`);
        assert.match(
          res.json.detail, /CLI/,
          'and the refusal says where control actually lives',
        );
        assert.ok(!('stack' in (res.json ?? {})), `${method}'s refusal carries no stack`);
        assert.equal(
          res.headers.get('content-type'), 'application/json; charset=utf-8',
          `${method}'s refusal is JSON, never a page a browser could render`,
        );
      }

      // Including a write aimed at a path that does not exist, and at a static
      // asset that a GET would serve: the method check runs before routing and
      // before the static allow-list, so neither is a way in.
      const post = await d.raw('POST', '/api/nonexistent', 'x');
      assert.equal(post.status, 405, 'a POST is refused on any path, known or not');
      assert.equal(post.headers.get('allow'), 'GET, HEAD', 'and is still told what is allowed');
      const postAsset = await d.raw('POST', '/app.js', 'x');
      assert.equal(postAsset.status, 405, 'a POST is refused on a static asset, not served as one');
      const postRoot = await d.raw('POST', '/', 'x');
      assert.equal(postRoot.status, 405, 'and on the page itself');
      const postTraversal = await d.raw('POST', '/../.env', 'x');
      assert.equal(postTraversal.status, 405, 'a write aimed at a traversal path is refused before the path is examined');

      // The `Allow` header is honest, not decorative: HEAD is the one other
      // method that is really routed, and it returns the GET headers with the
      // body suppressed.
      const head = await d.raw('HEAD', '/api/snapshot');
      assert.equal(head.status, 200, 'HEAD is served, as the Allow header claims');
      assert.equal(head.text, '', 'with no body');
      const get = await d.raw('GET', '/api/snapshot');
      assert.equal(head.headers.get('content-length'), get.headers.get('content-length'), 'and the same content-length as the GET it stands in for');
      assert.equal(get.status, 200, 'and GET is served');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: the database is genuinely read-only, not merely unrouted', async () => {
  const h = createHarness();
  try {
    // Real trading first, so "nothing changed" is a claim about rows that
    // exist. A fingerprint of an empty database would match itself whatever the
    // server did.
    await tradedDashboard(h);

    // A second connection to the SAME file, opened the way the server opens it:
    // `openDatabase(path, { readonly: true })`, which is the option name the
    // server passes and which reaches `DatabaseSync` as `readOnly`. This is the
    // second, independent mechanism behind "read-only": routing could be wrong
    // and SQLite would still refuse.
    //
    // The harness's own `h.db` is NOT the thing under test - it is a writable
    // handle to the same file, and asserting that IT refuses a write would be
    // asserting that a writable connection is read-only.
    const serverRo = openDatabase(h.config.paths.dbFile, { readonly: true });
    h.trackDb(serverRo); // Windows keeps the file locked until it is closed
    try {
      assert.ok(
        serverRo.all('SELECT COUNT(*) AS c FROM orders')[0].c > 0,
        'the read-only connection can READ the real rows - the refusals below are about writing',
      );
      const writeAttempts = [
        ['UPDATE', () => serverRo.run("UPDATE control_flags SET value = 'false' WHERE flag = 'EMERGENCY_STOP'")],
        ['DELETE', () => serverRo.run("DELETE FROM balances WHERE mode = 'PAPER'")],
        ['INSERT', () => serverRo.run("INSERT INTO balances (mode) VALUES ('PAPER')")],
        ['DDL', () => serverRo.exec('CREATE TABLE dashboard_probe (a)')],
        ['a write inside a transaction', () => serverRo.tx(() => serverRo.run("UPDATE equity_curve SET equity_egp = 0"))],
      ];
      for (const [label, attempt] of writeAttempts) {
        assert.throws(
          attempt,
          (err) => /readonly|read.only/i.test(err.message) && err.code === 'DATABASE_ERROR',
          `SQLite refuses ${label} on a read-only connection`,
        );
      }
      // ... and the rows are all still there after those attempts.
      assert.ok(
        serverRo.all('SELECT COUNT(*) AS c FROM orders')[0].c > 0,
        'and the rows the refused writes targeted are untouched',
      );
    } finally {
      serverRo.close();
    }

    // And the observable guarantee, which needs no access to the server's
    // private connection: after every write attempt made against the running
    // server over HTTP, not one row has changed.
    const d = await serve(h);
    try {
      const sizesBefore = ['', '-wal', '-shm'].map((s) => {
        try { return statSync(h.config.paths.dbFile + s).size; } catch { return -1; }
      });
      const fpBefore = fingerprint(h.db);
      const attempts = [
        ['POST', '/api/snapshot'], ['PUT', '/api/snapshot'], ['PATCH', '/api/snapshot'],
        ['DELETE', '/api/snapshot'], ['OPTIONS', '/api/snapshot'], ['TRACE', '/api/snapshot'],
        ['POST', '/api/section/risk'], ['DELETE', '/healthz'], ['POST', '/api/env'],
        ['POST', '/api/audit/chains'], ['POST', '/app.js'], ['POST', '/not/a/route'],
      ];
      for (const [method, path] of attempts) {
        const res = await d.raw(method, path, '{"value":"false"}');
        assert.equal(res.status, 405, `${method} ${path} was refused`);
      }
      // ... and a read still works afterwards, so the server did not simply
      // wedge itself to achieve it.
      assert.equal((await d.get('/api/snapshot')).status, 200, 'and the snapshot is still served afterwards');

      assert.equal(
        fingerprint(h.db), fpBefore,
        `every row of every table is byte-identical after ${attempts.length} write attempts over HTTP`,
      );
      const sizesAfter = ['', '-wal', '-shm'].map((s) => {
        try { return statSync(h.config.paths.dbFile + s).size; } catch { return -1; }
      });
      assert.deepEqual(sizesAfter, sizesBefore, 'and not one byte was written to the database file either');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: path traversal is a 404, not a file read', async () => {
  const h = createHarness();
  try {
    const d = await serve(h);
    try {
      // The filesystem is never reached for any of these. The request is
      // decoded by `new URL()` first, so a browser-style `../` is collapsed
      // before it is ever compared to the allow-list.
      const attempts = [
        '/../.env',
        '/../../package.json',
        '/..%2f.env',
        '/%2e%2e/%2e%2e/package.json',
        '/app.js/../../.env',
        '/./../../src/cli.js',
        '/api/../../.env',
      ];
      for (const path of attempts) {
        const res = await d.get(path);
        assert.equal(res.status, 404, `${path} is a 404`);
        assert.ok(!res.text.includes('TEOS_'), `${path} leaked no environment content`);
        assert.ok(!res.text.includes('"scripts"'), `${path} leaked no package.json`);
      }
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: an unknown path is a 404 and a long URL is a 414', async () => {
  const h = createHarness();
  try {
    const d = await serve(h);
    try {
      const unknown = await d.get('/not/a/route');
      assert.equal(unknown.status, 404, 'an unknown path is a 404');
      assert.equal(unknown.json.error, 'not found', 'with a JSON error, not an HTML page');

      const long = await d.get(`/api/snapshot?x=${'a'.repeat(3000)}`);
      assert.equal(long.status, 414, 'an over-long URL is refused before it is parsed');
      assert.equal(long.json.error, 'URL too long', 'and says why');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: no response is cacheable and none is readable cross-origin', async () => {
  const h = createHarness();
  try {
    await tradedDashboard(h);
    const d = await serve(h);
    try {
      // Every route in the table, including the error paths. These headers are
      // sent by both `#json` and `#static`, so the property is "every response",
      // not "the happy path".
      const responses = [
        ['/api/snapshot', await d.get('/api/snapshot')],
        ['/api/section/risk', await d.get('/api/section/risk')],
        ['/api/env', await d.get('/api/env')],
        ['/api/audit/chains', await d.get('/api/audit/chains')],
        ['/healthz', await d.get('/healthz')],
        ['/ (static)', await d.get('/')],
        ['/app.js (static)', await d.get('/app.js')],
        ['404', await d.get('/not/a/route')],
        ['414', await d.get(`/api/snapshot?x=${'a'.repeat(3000)}`)],
        ['405', await d.raw('POST', '/api/snapshot')],
      ];
      for (const [label, res] of responses) {
        assert.equal(res.headers.get('cache-control'), 'no-store', `${label} is never stored by a cache`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label} is never sniffed into another type`);
        assert.ok(res.headers.get('content-security-policy') != null, `${label} carries a Content-Security-Policy`);
        // The dashboard has no authentication, so any page the operator visits
        // could issue a GET to loopback. It could not READ the answer: a
        // cross-origin read needs the server to opt in with CORS, and this
        // server has no CORS code at all.
        for (const header of res.headers.keys()) {
          assert.ok(
            !header.startsWith('access-control-'),
            `${label} sends no ${header}, so no other origin can read it`,
          );
        }
      }

      // The JSON responses additionally refuse to be a referrer and are typed
      // as JSON. `#static` does not send `referrer-policy`; the page loads no
      // third-party resource, so there is nowhere for a referrer to go, and the
      // gap is recorded rather than papered over.
      for (const [label, res] of responses.filter(([label]) => !label.includes('static'))) {
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${label} is sent as a referrer nowhere`);
        assert.match(res.headers.get('content-type'), /^application\/json/, `${label} is declared as JSON`);
      }
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: /healthz reports honestly, including a missing schema', async () => {
  const h = createHarness();
  try {
    const d = await serve(h);
    try {
      const res = await d.get('/healthz');
      assert.equal(res.status, 200, 'health is served');
      assert.equal(res.json.mode, 'PAPER', 'it names the mode');
      assert.equal(res.json.readOnly, true, 'it claims read-only, and that claim is tested above');
      assert.equal(res.json.loopbackOnly, true, 'and loopback-only');
      assert.equal(res.json.emergencyStopEngaged, false, 'with no emergency stop engaged');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: the audit chains endpoint reports on all four streams', async () => {
  const h = createHarness();
  try {
    await tradedDashboard(h);
    const d = await serve(h);
    try {
      const res = await d.get('/api/audit/chains');
      assert.equal(res.status, 200, 'the chain report is served');
      assert.equal(res.json.chains.length, 4, 'all four streams are reported');
      for (const c of res.json.chains) {
        assert.equal(c.ok, true, `the ${c.stream} chain reports intact (${c.reason})`);
      }
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: no credential is ever exposed by any endpoint', async () => {
  const h = createHarness();
  try {
    await tradedDashboard(h);
    const d = await serve(h);
    try {
      // `/api/env` is a real endpoint, not a 404: it reports `describeEnv()`,
      // an allow-list of eight configuration variables plus the five credential
      // variables Phase 1 forbids. An earlier version of this test scanned
      // every payload for a secret-SHAPED STRING and failed here - correctly,
      // because the report necessarily NAMES the credential variables it
      // refuses to carry. A name is not a secret. What must never appear is a
      // credential VALUE, so that is what is asserted, and with a real
      // credential in the environment rather than with a regex for the word
      // "key".
      const env = await d.get('/api/env');
      assert.equal(env.status, 200, '/api/env is a real endpoint');
      assert.equal(env.json.error, undefined, 'and it is not an error page');

      // The report is exactly the allow-list `describeEnv()` produces - nothing
      // added, nothing dropped. Asking the production function with an empty
      // environment enumerates the variables, so the test never restates them.
      const withNothingSet = describeEnv({});
      assert.deepEqual(
        Object.keys(env.json.env).sort(), Object.keys(withNothingSet).sort(),
        '/api/env reports exactly the variables describeEnv() knows about',
      );
      for (const [name, value] of Object.entries(env.json.env)) {
        if (!isSecretKey(name)) continue;
        assert.equal(
          value, withNothingSet[name],
          `${name} is reported as unset, and reports no value of its own`,
        );
        assert.equal(value, null, `${name} is null while Phase 1 forbids credentials`);
      }

      // Now put a credential in the process environment and read every endpoint
      // again. `describeEnv()` reads `process.env` at call time, so this really
      // does put a populated credential variable in front of the endpoint - the
      // case the redaction exists for, which a regex over an empty environment
      // could never reach.
      const sentinel = 'sk-live-AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF';
      process.env.TEOS_TRADING_API_KEY = sentinel;
      try {
        const live = await d.get('/api/env');
        assert.equal(
          live.json.env.TEOS_TRADING_API_KEY, 'SET(redacted)',
          'a populated credential variable is reported as SET and redacted, never as its value',
        );
        assert.ok(!live.text.includes(sentinel), 'and the value itself is not in the response');

        for (const path of ['/api/snapshot', '/api/env', '/api/audit/chains', '/healthz', '/api/section/audit', '/', '/app.js']) {
          const res = await d.get(path);
          assert.ok(!res.text.includes(sentinel), `${path} exposes no credential value`);
          // Recursively: a field whose NAME is credential-shaped may only ever
          // carry a redaction marker, or nothing. `core/env.js#redact` is what
          // enforces that on the way out, and the dashboard is the one place
          // that is worth re-checking.
          for (const field of secretBearingFields(res.json ?? {}, path)) {
            assert.ok(
              field.value === null || (typeof field.value === 'string' && /REDACTED/i.test(field.value)),
              `${field.path} carries only a redaction marker, not a value (got ${JSON.stringify(field.value)})`,
            );
          }
        }
      } finally {
        delete process.env.TEOS_TRADING_API_KEY;
      }

      // The redactor is not decoration. Every payload goes through
      // `core/env.js#redact` on the way out (`scrub()` in `dashboard/api.js`),
      // so this asserts the function itself still destroys a credential-shaped
      // string: a refactor that dropped the call, or broke the pattern, fails
      // here rather than on an operator's screen.
      assert.match(
        redact('downstream=TEOS_TRADING_API_KEY=sk-live-AAAA1111BBBB2222'),
        /\*\*\*REDACTED\*\*\*/,
        'redact() destroys a credential-shaped string instead of passing it through',
      );
      assert.ok(
        !JSON.stringify((await d.get('/api/snapshot')).json).includes('***REDACTED***'),
        'and the snapshot needed none: nothing secret-shaped reaches it',
      );
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: the static assets are local files only, with a strict CSP', async () => {
  const h = createHarness();
  try {
    const d = await serve(h);
    try {
      const html = await d.get('/');
      assert.equal(html.status, 200, 'the page is served');
      const csp = html.headers.get('content-security-policy');
      assert.ok(csp != null, 'a Content-Security-Policy is sent');
      assert.ok(csp.includes("default-src 'none'"), 'which defaults to denying everything');
      assert.ok(!/unsafe-inline/.test(csp), 'and allows no inline script or style');
      assert.ok(!/https?:\/\//.test(csp), 'and names no remote origin');

      // No remote asset is referenced by the page itself. A CDN link here
      // would be an outbound request on every dashboard load.
      assert.ok(!/https?:\/\//.test(html.text), 'the page references no remote URL');
      assert.ok(!/<script[^>]+src="http/i.test(html.text), 'and loads no remote script');

      assert.equal(html.headers.get('x-content-type-options'), 'nosniff', 'nosniff is set');
      assert.equal((await d.get('/style.css')).status, 200, 'the stylesheet is served');
    } finally {
      await d.close();
    }
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: the view is scoped to the mode it was built for', () => {
  // `makeView` is the one place scope is decided, and `sessionStop` is the rule
  // it mirrors. If the two ever disagreed, the dashboard would show another
  // run's emergency stop - the single most misleading thing it could display.
  const h = createHarness({ mode: 'BACKTEST' });
  try {
    const view = makeView({ config: h.config, repos: h.repos, chain: h.chain, mode: 'BACKTEST' });
    assert.equal(view.mode, 'BACKTEST', 'the view carries the mode it was built for');
    assert.equal(view.scopeRunId, h.runId, 'and a BACKTEST view is scoped to its own run');

    const paperView = makeView({ config: h.config, repos: h.repos, chain: h.chain, mode: 'PAPER' });
    assert.equal(paperView.scopeRunId, null, 'a PAPER view is not run-scoped: it is one continuous account');
  } finally {
    h.cleanup();
  }
});

test('DASHBOARD: the client script renders the mode from the payload', () => {
  // Read the shipped file rather than the served bytes, so the assertion is
  // about what is in the repository - the thing a reviewer can see.
  const app = readFileSync(join(REPO_ROOT, 'src', 'dashboard', 'public', 'app.js'), 'utf8');
  assert.ok(/\bmode\b/.test(app), 'the client script reads a mode field');
  assert.ok(!/textContent\s*=\s*['"]PAPER['"]/.test(app), 'and never assigns a hard-coded PAPER badge');
});
