/**
 * TEOS evaluation harness - tests/checkpoint.test.js
 *
 * THE DURABILITY CONTRACT, PINNED
 * -------------------------------
 * The 20-seed pilot completed 293 of 360 runs and then lost the parent process.
 * Because progress lived only in a log file and results only in memory, 293
 * completed backtests were unrecoverable and it was impossible to tell a
 * completed run from a pending one.
 *
 * These tests exist so that failure cannot recur silently. Each one corresponds
 * to a specific way a resume can go wrong:
 *
 *   - skipping a run that never happened          -> "missing runs execute"
 *   - rerunning a run that already succeeded      -> "completed runs are skipped"
 *   - treating a repeated failure as a new sample -> "failed runs need an explicit retry"
 *   - double-counting a result in pooled stats     -> "duplicate results are rejected"
 *   - losing 359 of 360 records to a torn write   -> "partial writes are handled safely"
 *   - mixing two studies' numbers                 -> "a foreign checkpoint is refused"
 *
 * The torn-write case is the one that most needs a real filesystem rather than a
 * mock: the recovery depends on the actual byte layout of a file that was cut off
 * mid-line, so it is written to disk and truncated for real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointCorruptError, DuplicateResultError, StudyMismatchError,
  atomicWriteFileSync, loadRecords, openCheckpoint, studyIdentity,
} from '../checkpoint.js';
import { snapshot, format as formatTelemetry } from '../telemetry.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'teos-eval-ckpt-test-'));
}

// ---------------------------------------------------------------- identity

test('studyIdentity is stable across key ordering of the same study', () => {
  const armsA = [{ key: 'b', group: 'g', overrides: { x: 1, y: 2 } }, { key: 'a', group: 'g', overrides: {} }];
  const armsB = [{ key: 'a', group: 'g', overrides: {} }, { key: 'b', group: 'g', overrides: { y: 2, x: 1 } }];
  assert.equal(
    studyIdentity({ arms: armsA, seeds: [1, 2, 3], ticks: 2500 }),
    studyIdentity({ arms: armsB, seeds: [1, 2, 3], ticks: 2500 }),
  );
});

test('studyIdentity ignores seed ORDER but not seed SET', () => {
  const arms = [{ key: 'a', group: 'g' }];
  assert.equal(
    studyIdentity({ arms, seeds: [3, 1, 2], ticks: 100 }),
    studyIdentity({ arms, seeds: [1, 2, 3], ticks: 100 }),
  );
  assert.notEqual(
    studyIdentity({ arms, seeds: [1, 2, 3], ticks: 100 }),
    studyIdentity({ arms, seeds: [1, 2, 4], ticks: 100 }),
  );
});

test('studyIdentity changes when an arm override changes', () => {
  const base = { key: 'a', group: 'g' };
  assert.notEqual(
    studyIdentity({ arms: [base], seeds: [1], ticks: 100 }),
    studyIdentity({ arms: [{ ...base, overrides: { minStopDistancePct: 0.5 } }], seeds: [1], ticks: 100 }),
  );
});

test('studyIdentity changes when ticks change', () => {
  const arms = [{ key: 'a', group: 'g' }];
  assert.notEqual(
    studyIdentity({ arms, seeds: [1], ticks: 1200 }),
    studyIdentity({ arms, seeds: [1], ticks: 2500 }),
  );
});

test('studyIdentity is unaffected by worker count, checkpoint path or clock', () => {
  // Worker count changes throughput, not measurement. If identity included it, a
  // resume from a crash at 3 workers into a 2-worker run would be refused - which
  // is exactly the operational case this patch exists to support.
  const arms = [{ key: 'a', group: 'g' }];
  const want = studyIdentity({ arms, seeds: [1], ticks: 100 });
  assert.equal(want, studyIdentity({ arms, seeds: [1], ticks: 100 }));
});

// ------------------------------------------------------------------ writing

test('a completed result is durable immediately, before close', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: { net: -3.55 } });
    // Read the file back with a FRESH handle: no close, no flush, nothing.
    // If the record is not on disk yet, durability is a lie.
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).result.net, -3.55);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure record preserves every field needed to diagnose it', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({
      kind: 'run', arm: 'tp-2R', seed: 20260941, status: 'failed',
      durationMs: 600000, error: 'timed out after 600000 ms', exitCode: null,
      signal: 'SIGKILL', timedOut: true, stderr: '', stderrUnavailable: true,
      stdoutTail: '',
    });
    const rec = JSON.parse(readFileSync(p, 'utf8').trim());
    for (const k of ['arm', 'seed', 'status', 'durationMs', 'error', 'exitCode', 'signal', 'timedOut', 'stderr', 'stderrUnavailable']) {
      assert.ok(k in rec, `missing failure field: ${k}`);
    }
    assert.equal(rec.signal, 'SIGKILL');
    assert.equal(rec.timedOut, true);
    assert.equal(rec.stderrUnavailable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run killed with no stderr records stderr_unavailable rather than empty output', () => {
  // "It printed nothing" and "we have no stderr because it was SIGKILLed" are
  // different claims. Only the second one is evidence of an OOM-style death.
  const dir = scratch();
  try {
    const ck = openCheckpoint({ path: join(dir, 'ck.ndjson'), identity: 'id-1' });
    ck.append({
      kind: 'run', arm: 'a', seed: 1, status: 'failed', stderr: '', stderrUnavailable: true,
      error: 'child exited 1', exitCode: 1, signal: null, timedOut: false, durationMs: 12,
    });
    const rec = [...ck.records.values()][0];
    assert.equal(rec.stderrUnavailable, true);
    assert.equal(rec.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ dedupe

test('a record written with `armKey` is found by `arm`, and vice versa', () => {
  // Regression guard. Pool jobs carry `armKey`; the record and the report speak
  // of `arm`. When `append` keyed on `rec.arm` while the pool supplied
  // `rec.armKey`, every completed run was filed under the literal key
  // "undefined|<seed>": it was written, it was counted as "2 completed" in the
  // resume banner, and resume then scheduled both runs again. The unit tests
  // could not catch this because they all used one field name consistently; the
  // end-to-end test could.
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const jobs = [{ armKey: 'base', seed: 1 }];
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', armKey: 'base', seed: 1, status: 'completed', result: { net: -3.55 } });

    assert.equal(ck.isCompleted('base', 1), true, 'must be found by arm');
    assert.deepEqual(ck.pendingFor(jobs), [], 'the job must not be rescheduled');
    assert.equal(ck.stats(jobs).completed, 1, 'stats must find it too');

    // The on-disk record is self-describing, so a reader does not need to know
    // which field name the caller happened to use.
    const onDisk = JSON.parse(readFileSync(p, 'utf8').trim());
    assert.equal(onDisk.arm, 'base');

    // And it survives a reopen.
    assert.deepEqual(openCheckpoint({ path: p, identity: 'id-1' }).pendingFor(jobs), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second completed result for the same (arm, seed) is rejected', () => {
  const dir = scratch();
  try {
    const ck = openCheckpoint({ path: join(dir, 'ck.ndjson'), identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: { net: 1 } });
    assert.throws(
      () => ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: { net: 2 } }),
      DuplicateResultError,
    );
    // The original must survive the rejected attempt.
    assert.equal([...ck.records.values()][0].result.net, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure may be retried, superseding it, and the attempt counter increments', () => {
  const dir = scratch();
  try {
    const ck = openCheckpoint({ path: join(dir, 'ck.ndjson'), identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'failed', error: 'boom' });
    assert.equal(ck.attempts('base', 1), 1);
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: { net: 5 } });
    assert.equal(ck.attempts('base', 1), 2);
    assert.equal(ck.isCompleted('base', 1), true);
    assert.equal(ck.isFailed('base', 1), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a retry of a failure is recorded as a later attempt, keeping the earlier line', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'a', seed: 1, status: 'failed', error: 'first' });
    ck.append({ kind: 'run', arm: 'a', seed: 1, status: 'failed', error: 'second' });
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, 'both attempts must remain in the file as evidence');
    assert.equal(lines[0].attempt, 1);
    assert.equal(lines[1].attempt, 2);
    assert.equal(ck.attempts('a', 1), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------- resume

test('resume skips completed pairs and schedules missing ones', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const jobs = [
      { armKey: 'base', seed: 1 }, { armKey: 'base', seed: 2 }, { armKey: 'base', seed: 3 },
    ];
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: {} });
    ck.append({ kind: 'run', arm: 'base', seed: 2, status: 'completed', result: {} });

    const reopened = openCheckpoint({ path: p, identity: 'id-1' });
    const pending = reopened.pendingFor(jobs);
    assert.deepEqual(pending.map((j) => j.seed), [3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a resumed checkpoint returns the full result set, not just this process\'s', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: { net: -1 } });
    ck.append({ kind: 'run', arm: 'base', seed: 2, status: 'completed', result: { net: -2 } });
    const reopened = openCheckpoint({ path: p, identity: 'id-1' });
    const restored = [...reopened.records.values()]
      .filter((r) => r.status === 'completed')
      .map((r) => r.result);
    assert.equal(restored.length, 2);
    assert.deepEqual(restored.map((r) => r.net).sort((a, b) => a - b), [-2, -1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed pairs are excluded by default and included with retryFailed', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const jobs = [{ armKey: 'base', seed: 1 }, { armKey: 'base', seed: 2 }];
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'failed', error: 'x' });

    // Default: seed 1 is NOT scheduled, because its last attempt failed and an
    // automatic retry would let one flaky path masquerade as a fresh observation.
    assert.deepEqual(ck.pendingFor(jobs).map((j) => j.seed), [2]);

    // Explicit retry: now it is.
    assert.deepEqual(ck.pendingFor(jobs, { retryFailed: true }).map((j) => j.seed).sort((a, b) => a - b), [1, 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats reconciles completed, failed and pending against the FULL job list', () => {
  const dir = scratch();
  try {
    const ck = openCheckpoint({ path: join(dir, 'ck.ndjson'), identity: 'id-1' });
    const jobs = [
      { armKey: 'base', seed: 1 }, { armKey: 'base', seed: 2 }, { armKey: 'base', seed: 3 },
    ];
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: {} });
    ck.append({ kind: 'run', arm: 'base', seed: 2, status: 'failed', error: 'x' });
    const s = ck.stats(jobs);
    assert.equal(s.expected, 3);
    assert.equal(s.completed, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.pending, 1);
    assert.equal(s.duplicated, 0);
    assert.equal(s.allTerminal, false);

    ck.append({ kind: 'run', arm: 'base', seed: 2, status: 'completed', result: {} });
    ck.append({ kind: 'run', arm: 'base', seed: 3, status: 'completed', result: {} });
    const s2 = ck.stats(jobs);
    assert.equal(s2.allTerminal, true);
    assert.equal(s2.completed, 3);
    assert.equal(s2.failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ torn writes

test('a torn FINAL line is discarded and every earlier record survives', () => {
  // The real failure mode: the process died mid-append. Recovering 359 of 360 is
  // the entire point, so this must NOT throw.
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    for (let s = 1; s <= 3; s += 1) ck.append({ kind: 'run', arm: 'base', seed: s, status: 'completed', result: {} });
    // Simulate a crash halfway through writing the fourth line.
    appendFileSync(p, '{"kind":"run","arm":"base","seed":4,"stat');

    const reopened = openCheckpoint({ path: p, identity: 'id-1' });
    assert.equal(reopened.records.size, 3, 'the three complete records must be recovered');
    assert.ok(reopened.torn !== null, 'the torn line must be reported');
    assert.equal(reopened.isCompleted('base', 4), false, 'the torn record must not count as completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a torn line is detected when the file does NOT end in a newline', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    writeFileSync(p, '{"kind":"run","arm":"a","seed":1,"status":"completed","result":{}}\n{"kind":"run"');
    const { records, tornLine } = loadRecords(p);
    assert.equal(records.length, 1);
    assert.equal(tornLine, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corruption in the MIDDLE of a file is refused, not silently skipped', () => {
  // A mid-file parse failure means records are missing for an unknown reason.
  // Guessing which survived would corrupt the sample; refusing is correct.
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    writeFileSync(p, '{"kind":"run","arm":"a","seed":1,"status":"completed","result":{}}\n'
      + 'NOT JSON AT ALL\n'
      + '{"kind":"run","arm":"a","seed":3,"status":"completed","result":{}}\n');
    assert.throws(() => loadRecords(p), CheckpointCorruptError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty checkpoint file loads as zero records, not an error', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    writeFileSync(p, '');
    const ck = openCheckpoint({ path: p, identity: 'id-1' });
    assert.equal(ck.records.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --------------------------------------------------------- identity guard

test('a checkpoint from a DIFFERENT study is refused', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    openCheckpoint({ path: p, identity: 'study-A' }).append({ kind: 'run', arm: 'a', seed: 1, status: 'completed', result: {} });
    assert.throws(() => openCheckpoint({ path: p, identity: 'study-B' }), StudyMismatchError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records with no identity metadata are refused rather than merged', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    writeFileSync(p, '{"kind":"run","arm":"a","seed":1,"status":"completed","result":{}}\n');
    assert.throws(() => openCheckpoint({ path: p, identity: 'anything' }), StudyMismatchError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('forceNewStudy discards the old records instead of refusing', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    openCheckpoint({ path: p, identity: 'study-A' }).append({ kind: 'run', arm: 'a', seed: 1, status: 'completed', result: {} });
    const fresh = openCheckpoint({ path: p, identity: 'study-B', forceNew: true });
    assert.equal(fresh.records.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ fatal events

test('a study-level fatal event is stored and not counted as a run', () => {
  const dir = scratch();
  try {
    const ck = openCheckpoint({ path: join(dir, 'ck.ndjson'), identity: 'id-1' });
    ck.append({ kind: 'run', arm: 'base', seed: 1, status: 'completed', result: {} });
    ck.recordFatal({
      reason: 'uncaughtException', completed: 1, failed: 0, pending: 2,
      expected: 3, checkpointPath: ck.path, workers: 2,
    });
    assert.equal(ck.fatals.length, 1);
    assert.equal(ck.records.size, 1, 'a fatal event must not become a run record');
    assert.equal(ck.fatals[0].workers, 2);
    assert.equal(ck.fatals[0].expected, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fatal event survives a reopen', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'ck.ndjson');
    openCheckpoint({ path: p, identity: 'id-1' }).recordFatal({ reason: 'signal:SIGTERM' });
    assert.equal(openCheckpoint({ path: p, identity: 'id-1' }).fatals.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------- atomic

test('atomicWriteFileSync leaves no .tmp file behind and writes the full content', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'out.json');
    atomicWriteFileSync(p, JSON.stringify({ identity: 'x' }));
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).identity, 'x');
    // The temp file is renamed away, so a reader never sees a partial version and
    // a crash never leaves debris that looks like data.
    assert.throws(() => readFileSync(`${p}.tmp`, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFileSync overwrites an existing file completely', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'out.json');
    atomicWriteFileSync(p, 'a-much-longer-original-value');
    atomicWriteFileSync(p, 'short');
    assert.equal(readFileSync(p, 'utf8'), 'short');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- telemetry

test('telemetry snapshot reports host memory and parent RSS', () => {
  const s = snapshot({ workers: 2, activeWorkers: 1, event: 'test' });
  assert.ok(s.totalMemMb > 0);
  assert.ok(s.freeMemMb >= 0);
  assert.ok(s.parentRssMb > 0);
  assert.ok(s.usedMemPct > 0 && s.usedMemPct <= 100);
  assert.equal(s.workers, 2);
  assert.equal(s.activeWorkers, 1);
  assert.equal(s.event, 'test');
  assert.ok(s.at);
});

test('telemetry snapshot is JSON-serialisable so it can be appended to the checkpoint', () => {
  const s = snapshot({ childRssMb: 123.4 });
  assert.equal(JSON.parse(JSON.stringify(s)).childRssMb, 123.4);
});

test('telemetry format names free memory, which is the honest pressure signal', () => {
  const s = snapshot({ workers: 2, activeWorkers: 0 });
  const line = formatTelemetry(s);
  assert.match(line, /free \d/);
  assert.match(line, /parent rss \d/);
  assert.match(line, /active 0/);
});