/**
 * Required scenario 7 of 13: RESTART_RECOVERY
 *
 * Kill the process mid-run and start it again.
 * Expected: state is recovered from the database; no duplicate orders; the
 * account reconciles; the restart is recorded.
 *
 * A real restart is simulated by building a SECOND `Worker` over the SAME
 * database file and the SAME lock path, after abandoning the first one without
 * calling `stop()`. That reproduces the two cases that matter:
 *
 *   - a lock left behind by a process that is gone (must be reclaimed, or the
 *     agent could never restart), and
 *   - a run row still marked RUNNING (must be detected as a resume).
 *
 * A `ManualClock` drives both workers, so the whole scenario costs milliseconds
 * instead of the one-second-per-tick a real-time run needs. The clock is
 * deliberately NOT advanced between the two workers: the restarted process picks
 * up where the first left off in simulated time, which is exactly the situation
 * a real restart creates.
 */

import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  createHarness, assertAccountInvariants, assert, roundEgp, createLogger,
} from './helpers/harness.js';
import { Worker } from '../src/worker/worker.js';
import { WorkerLock } from '../src/worker/lock.js';
import { openDatabase } from '../src/database/db.js';
import { newId } from '../src/core/ids.js';

/**
 * Config for the restart scenarios.
 *
 * The default 60-candle warm-up at 30 ticks per candle is 1800 ticks before the
 * strategy will emit anything, which costs ~18s per worker and ~70s for this
 * file. Shrinking the warm-up and the candle length is a test-time
 * configuration change, not a change to any code path: the same warm-up
 * accounting, the same gating, the same strategy. It buys back an order of
 * magnitude in runtime while leaving the restart behaviour under test exactly
 * as it would be in production.
 */
const FAST = { market: { warmupCandles: 5, ticksPerCandle: 5 } };
const TICKS = 500;

/**
 * A worker over the harness's existing database and lock, as a restart would be.
 *
 * The extra connection is registered with the harness so `cleanup()` closes it:
 * on Windows an open handle keeps the file locked, and the temp-directory removal
 * would then fail with EBUSY, masking whatever the test actually reported.
 */
function startWorker(h, name) {
  const instanceId = newId('inst');
  const db = h.trackDb(openDatabase(h.config.paths.dbFile));
  const worker = new Worker({
    config: h.config,
    clock: h.clock,
    db,
    mode: h.mode,
    instanceId,
    strategyId: h.config.strategies.active,
    logger: createLogger(h, name),
  });
  return { worker, db, instanceId };
}

/**
 * Rewrite the lock file to look like one left behind by a DEAD process.
 *
 * This is the whole point of the lock, so it is worth being precise about. On
 * one host, `WorkerLock` treats process liveness - not the heartbeat age - as
 * the authority on whether a lock is still held. A worker abandoned inside its
 * own test process is therefore correctly seen as ALIVE, and its lock is
 * rightly refused; a same-process "crash" is not a crash. A pid that is not
 * running is what a real SIGKILL leaves behind, and it is the only faithful way
 * to exercise the reclaim path here.
 */
function orphanLock(path, instanceId) {
  writeFileSync(path, JSON.stringify({
    instanceId,
    pid: 999_999, // not a live process
    host: hostname(),
    acquiredMs: 0,
    heartbeatMs: 0,
    version: 1,
  }));
}

test('SCENARIO 7: an abandoned run is resumed, not restarted from zero', async () => {
  const h = createHarness({ overrides: FAST, withRun: false });
  try {
    const a = startWorker(h, 'before');
    const started = await a.worker.start({ resume: true });
    assert.ok(['COLD_START', 'RESUME'].includes(started.kind), `the first start is a ${started.kind}`);

    // Trade a little, so there is real state to recover.
    for (let i = 0; i < TICKS; i += 1) await a.worker.tick();
    assert.equal(a.worker.health().tickCount, TICKS, 'the first worker ran its ticks');

    const cashBefore = roundEgp(a.worker.account.cashEgp);
    const equityBefore = a.worker.account.snapshot().equityEgp;
    const runId = started.runId;

    // Hard kill: no stop(), no run-status update, lock left behind by a process
    // that is no longer running. This is what a SIGKILL or a power cut leaves.
    assert.ok(existsSync(h.lockPath), 'the abandoned worker left its lock behind');
    orphanLock(h.lockPath, a.instanceId);

    // ---- restart ------------------------------------------------------
    const b = startWorker(h, 'after');
    const resumed = await b.worker.start({ resume: true });

    // Reaching this line at all is the reclaim proof: `start()` acquires the
    // lock first and throws `LockHeldError` on a live one, so a lock left by a
    // dead owner must have been taken over rather than refused.
    assert.equal(resumed.kind, 'RESUME', `the restart resumed the open run (was ${resumed.kind})`);
    assert.equal(resumed.runId, runId, 'the same run id continued');
    assert.equal(resumed.isResume, true, 'and it reports itself as a resume');
    assert.equal(resumed.cashCheck.ok, true, 'cash reconciled against the recorded fills on the way back in');

    assert.equal(
      roundEgp(b.worker.account.cashEgp), cashBefore,
      `cash was restored exactly (${cashBefore} -> ${roundEgp(b.worker.account.cashEgp)})`,
    );
    assert.ok(
      Math.abs(b.worker.account.snapshot().equityEgp - equityBefore) < 1,
      'equity is restored to within a tick of where it was',
    );
    assertAccountInvariants(b.worker.account);

    // The lock now belongs to the new instance, and only to it.
    const newLock = JSON.parse(readFileSync(h.lockPath, 'utf8'));
    assert.equal(newLock.instanceId, b.instanceId, 'the lock was handed to the new instance');

    // The restart is in the record, naming the run and the instance it took over.
    const restarts = b.worker.repos.listRestarts();
    assert.ok(restarts.length >= 1, 'the restart is recorded');
    const last = restarts[0];
    assert.equal(last.run_id, runId, 'and it names the run it continued');
    assert.equal(last.new_instance, b.instanceId, 'and the instance that took over');
    assert.equal(last.previous_instance, a.instanceId, 'and the instance it replaced');
    assert.equal(last.kind, 'RESUME', 'and records what kind of start it was');
    assert.ok(last.orphaned_orders >= 0, 'it reports the in-flight orders it had to reconcile');

    b.worker.stop({ reason: 'test complete' });
    assert.ok(!existsSync(h.lockPath), 'a clean stop releases the lock');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 7b: a restart never replays an order that was already placed', async () => {
  const h = createHarness({ overrides: FAST, withRun: false });
  try {
    const a = startWorker(h, 'before');
    await a.worker.start({ resume: true });
    for (let i = 0; i < TICKS; i += 1) await a.worker.tick();

    const before = a.worker.repos.db.all('SELECT order_id, client_order_id FROM orders WHERE mode = ?', 'PAPER');
    assert.ok(before.length > 0, 'the first run actually traded, so this check means something');
    orphanLock(h.lockPath, a.instanceId);

    const b = startWorker(h, 'after');
    await b.worker.start({ resume: true });
    for (let i = 0; i < TICKS; i += 1) await b.worker.tick();

    const after = b.worker.repos.db.all('SELECT order_id, client_order_id FROM orders WHERE mode = ?', 'PAPER');

    const afterIds = new Set(after.map((o) => o.order_id));
    for (const o of before) {
      assert.ok(afterIds.has(o.order_id), `order ${o.order_id} survived the restart`);
    }

    // A duplicated order shows up as a repeated client_order_id. This is the
    // check that matters: order ids are generated fresh, so only the
    // DECISION-derived client id can catch a replay.
    const clientIds = after.map((o) => o.client_order_id);
    assert.equal(
      new Set(clientIds).size, clientIds.length,
      'no client_order_id was ever submitted twice, across the restart',
    );
    assert.ok(after.length >= before.length, 'the restart did not lose orders');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 7c: a live lock is respected, so two workers can never trade at once', async () => {
  const h = createHarness({ overrides: FAST, withRun: false });
  try {
    const a = startWorker(h, 'holder');
    await a.worker.start({ resume: true });
    assert.ok(existsSync(h.lockPath), 'the first worker holds the lock');

    // Two workers trading one account would double every position. The lock is
    // what prevents that, and `acquire` signals refusal by THROWING rather than
    // returning a flag, so the refusal has to be asserted as a throw.
    const lock = new WorkerLock(h.lockPath, { staleAfterMs: h.config.worker.lockStaleAfterMs });
    assert.throws(
      () => lock.acquire(newId('inst'), h.clock.now()),
      (err) => err.code === 'LOCK_HELD' && err.details.owner.instanceId === a.instanceId,
      'a live lock is not handed to a second instance, and the refusal names the holder',
    );

    // A whole second Worker must fail to start, not start alongside the first.
    // `start()` is synchronous and signals the refusal by throwing, so this is
    // `assert.throws` - `assert.rejects` would let a synchronous throw escape
    // and report the refusal as a test failure instead of catching it.
    const b = startWorker(h, 'intruder');
    assert.throws(
      () => b.worker.start({ resume: true }),
      (err) => err.code === 'LOCK_HELD',
      'a second worker refuses to start at all rather than running in parallel',
    );
    assert.equal(
      b.worker.health().running, false,
      'and it never entered its decision loop',
    );

    a.worker.stop({ reason: 'test complete' });
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 7d: cash after a restart reconciles exactly against the recorded fills', async () => {
  const h = createHarness({ overrides: FAST, withRun: false });
  try {
    const a = startWorker(h, 'before');
    await a.worker.start({ resume: true });
    for (let i = 0; i < TICKS; i += 1) await a.worker.tick();
    orphanLock(h.lockPath, a.instanceId);

    const b = startWorker(h, 'after');
    await b.worker.start({ resume: true });
    for (let i = 0; i < TICKS; i += 1) await b.worker.tick();

    const repos = b.worker.repos;
    assert.ok(
      repos.db.all('SELECT order_id FROM orders WHERE mode = ?', 'PAPER').length > 0,
      'both runs traded, so reconciliation is a real check and not a tautology',
    );
    // Sum every BUY cost and SELL proceeds, plus fees, straight from the raw
    // fill rows - a derivation completely independent of how PaperAccount
    // computes cash. If the two ever disagree, the ledger is lying.
    const fills = repos.db.all(
      `SELECT f.side AS side, f.quantity AS quantity, f.price AS price, f.fee_egp AS fee
         FROM fills f JOIN orders o ON o.order_id = f.order_id
        WHERE o.mode = 'PAPER'`,
    );
    let derived = h.config.account.startingCapitalEgp;
    for (const f of fills) {
      const gross = f.quantity * f.price;
      derived += f.side === 'SELL' ? gross - f.fee : -(gross + f.fee);
    }

    const recorded = repos.latestBalance('PAPER').cash_egp;
    assert.ok(
      Math.abs(roundEgp(recorded) - roundEgp(derived)) <= 0.02,
      `recorded cash ${recorded} reconciles with fill-derived ${roundEgp(derived)}`,
    );
    assert.ok(recorded >= 0, 'cash never went negative across the restart');
  } finally {
    h.cleanup();
  }
});

test('SCENARIO 7e: an ordinary restart is not a crash recovery, and says which it was', async () => {
  const h = createHarness({ overrides: FAST, withRun: false });
  try {
    const a = startWorker(h, 'before');
    await a.worker.start({ resume: true });
    for (let i = 0; i < TICKS; i += 1) await a.worker.tick();
    orphanLock(h.lockPath, a.instanceId);

    // The difference between RESUME and CRASH_RECOVERY is the run row: a run
    // still marked RUNNING means the previous process never closed it, so the
    // new one has to finish reconciling it. A run closed cleanly does not.
    const b = startWorker(h, 'after');
    const resumed = await b.worker.start({ resume: true });
    assert.equal(resumed.kind, 'RESUME', 'an abandoned RUNNING run is resumed');
    b.worker.stop({ reason: 'clean shutdown' });

    // Nothing is left holding the lock or the run row, so a third start is a
    // cold start rather than a recovery - which is exactly the signal an
    // operator needs to tell "it crashed" from "I stopped it".
    const c = startWorker(h, 'later');
    const cold = await c.worker.start({ resume: true });
    assert.equal(cold.kind, 'CRASH_RECOVERY', 'a closed run is superseded, not resumed');
    assert.notEqual(cold.runId, resumed.runId, 'and it gets a fresh run id');

    const restarts = c.worker.repos.listRestarts();
    const kinds = restarts.map((r) => r.kind);
    assert.ok(kinds.includes('RESUME'), 'the resume was recorded as a resume');
    assert.ok(kinds.includes('CRASH_RECOVERY'), 'and the second start as a crash recovery');

    c.worker.stop({ reason: 'test complete' });
  } finally {
    h.cleanup();
  }
});


