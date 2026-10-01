/**
 * TEOS evaluation harness - tests/isolation.test.js
 *
 * PINS THE ISOLATION GUARANTEE.
 *
 * `AgentEngine.breachedStops()` selects the governing stop price with a query
 * that has NO `run_id` predicate:
 *
 *     SELECT stop_price FROM agent_decisions
 *      WHERE mode = ? AND symbol = ? AND signal = 'BUY' AND stop_price IS NOT NULL
 *      ORDER BY ts_ms DESC LIMIT 1
 *
 * Every backtest starts its ManualClock at the same `startMs`, so `ts_ms`
 * collides across runs. We are NOT fixing that query - it is production
 * behaviour and a measurement tool must not change it. Instead the harness
 * makes the hazard unreachable by giving every run its own data directory, and
 * these tests assert that the guarantee actually holds.
 *
 * If someone later "optimises" the harness to reuse one database, these fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createWorkspace } from '../workspace.js';
import { runOnce } from '../driver.js';
import { runPool } from '../pool.js';
import { buildArms } from '../arms.js';

const TICKS = 300; // short: this test is about isolation, not about results
const BASE = buildArms().find((a) => a.key === 'base');

test('createWorkspace yields a distinct directory each call', () => {
  const a = createWorkspace('t1');
  const b = createWorkspace('t2');
  try {
    assert.notEqual(a.dir, b.dir, 'two workspaces must not share a directory');
    assert.equal(a.dbFile.startsWith(a.dir), true);
    assert.ok(a.dbFile.endsWith('teos-backtest.db'));
    assert.equal(a.lockFile.startsWith(a.dir), true,
      'the worker lock must also be per-run, or runs contend for one lock');
    assert.equal(a.env.TEOS_DATA_DIR, a.dir);
  } finally {
    a.dispose(); b.dispose();
  }
});

test('dispose removes a workspace that never opened a database', () => {
  // Trivially true, but it pins that createWorkspace/dispose are symmetric and
  // that the directory name is what we think it is.
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('teos-eval-')).length;
  const a = createWorkspace('leak1');
  assert.ok(a.dir.includes('teos-eval-'));
  a.dispose();
  assert.equal(existsSync(a.dir), false);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('teos-eval-')).length;
  assert.ok(after <= before, 'dispose left the directory behind');
});

test('the run pool leaves no temporary directory behind - the real cleanup guarantee', async () => {
  // In-process cleanup CANNOT work on Windows: `Worker.stop()` releases the lock
  // and disconnects the broker but never closes the SQLite handle, and `Worker`
  // exposes no `close()`. A run's database therefore stays mapped until the
  // process exits, and an in-process `rmSync` gets EBUSY.
  //
  // This is why `eval/pool.js` runs one job per child process and deletes the
  // directory from the PARENT after the child has exited. Without this, a
  // 15-arm x 200-seed study leaks 3,000 open handles and up to 12 GB under
  // %TEMP%. This test is what stops that regression coming back.
  // Assert on the directories THIS CALL created, not on a global count of
  // `teos-eval-job-*` in %TEMP%. `node --test` runs test FILES concurrently, so a
  // global count is perturbed by any other harness test that happens to be
  // running: the original form of this assertion reported a leak in a pool that
  // had leaked nothing, which is how a real leak would have been lost in the
  // noise. Counting the pool's own directories is both stricter and immune to
  // concurrent tests.
  const { results, failures, scratchDirs } = await runPool(
    [{ armKey: 'base', seed: 20260928, ticks: 1500 }],
    { concurrency: 1 },
  );

  assert.deepEqual(failures, [], `pool job failed: ${JSON.stringify(failures[0])}`);
  assert.equal(results.length, 1);
  assert.equal(results[0].arm, 'base');

  assert.equal(scratchDirs.length, 1, 'the pool must report the scratch directory it created');
  const survivors = scratchDirs.filter((d) => existsSync(d));
  assert.deepEqual(survivors, [],
    `the pool leaked ${survivors.length} of its own temporary director(ies); each holds a multi-MB database`);
});

test('each harness run uses its own database file, and neither survives the run', async () => {
  const dbFiles = [];
  const originalOpen = process.env.TEOS_DATA_DIR;

  const r1 = await runOnce({
    arm: { ...BASE, key: 'iso-a' }, seed: 4242, ticks: TICKS, keepDir: true,
  });
  const r2 = await runOnce({
    arm: { ...BASE, key: 'iso-b' }, seed: 4243, ticks: TICKS, keepDir: true,
  });
  dbFiles.push(r1, r2);

  assert.notEqual(r1.config.paths.dbFile, r2.config.paths.dbFile,
    'TWO RUNS SHARED A DATABASE FILE. breachedStops() is not run-scoped, so this '
    + 'is the exact condition under which one run can read another run\'s stop.');
  assert.notEqual(r1.config.paths.dbFile, originalOpen,
    'a run must not fall back to the repo/ambient TEOS_DATA_DIR');
  for (const r of dbFiles) {
    assert.ok(existsSync(r.config.paths.dbFile), 'the temp database should still exist when keepDir is set');
  }

  // DELIBERATELY NOT CLEANED UP HERE, and that is a measured property, not an
  // oversight. An in-process `runOnce` cannot delete its own workspace on
  // Windows: the SQLite handle is still mapped in this process and `unlink`
  // fails with EBUSY. Confirmed by trying - a `rmSync` here throws exactly that,
  // which is why `workspace.js` dispose() swallows the error.
  //
  // So these 2 directories (~9 MB) are left behind by this file on every
  // execution, and they were left behind before this test was touched. Adding a
  // swallowed cleanup call would have looked like a fix while changing nothing.
  //
  // This does NOT affect the study: `runPool` runs every job in a child process
  // and deletes from the parent after that child exits, which is the guarantee
  // the test above actually pins. The leak is confined to in-process test runs.
});

test('runs on different seeds actually differ - the seed reaches the price path AND the broker', async () => {
  const r1 = await runOnce({ arm: { ...BASE, key: 'seed-a' }, seed: 20260928, ticks: 2500 });
  const r2 = await runOnce({ arm: { ...BASE, key: 'seed-b' }, seed: 20260929, ticks: 2500 });
  assert.ok(r1.metrics.tradeCount > 0 && r2.metrics.tradeCount > 0,
    'both runs must actually trade for this comparison to mean anything');
  assert.notEqual(
    JSON.stringify([r1.metrics, r1.counts]), JSON.stringify([r2.metrics, r2.counts]),
    'two different seeds produced identical runs - the seed may not be reaching the engine',
  );
});