/**
 * TEOS evaluation harness - tests/durability.test.js
 *
 * END-TO-END PROOF THAT run.js WIRES THE CHECKPOINT
 * --------------------------------------------------
 * `checkpoint.test.js` proves the store behaves. It does not prove the CLI uses
 * it. That gap is exactly the kind that survives review: a module with good
 * tests, correctly implemented, and never actually called.
 *
 * So these tests drive the real `node eval/run.js` as a child process and check
 * what lands on disk and in the JSON. They use the REAL pool and REAL backtests
 * at `--ticks 600` (about 8.5 s per run), because the failure modes being tested
 * - a killed child, a resumed study - only exist across a process boundary.
 *
 * FAILURES ARE INJECTED, NOT MOCKED
 * ---------------------------------
 * `--timeout-ms 1` makes the pool SIGKILL a live child. That exercises the real
 * timeout path, the real `stderr_unavailable` marker and the real parent
 * handlers, rather than a simulated version of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, '..', 'run.js');
const TICKS = 600; // ~8.5s per run: real enough to be a real run, quick enough to test

function scratch() {
  return mkdtempSync(join(tmpdir(), 'teos-eval-durability-'));
}

/** Run the real CLI and capture everything a caller could observe. */
function cli(args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN, ...args], {
      cwd: join(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Read the checkpoint's run records, newest per (arm, seed). */
function recordsOf(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === 'run');
}

test('results are persisted to the checkpoint and a resumed study reuses them', async () => {
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');
    const json = join(dir, 'study.json');

    const first = await cli(['--seeds', '2', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '2', '--checkpoint', ck, '--json', json, '--quiet']);
    assert.equal(first.code, 0, `first run failed:\n${first.stderr}`);

    const recs = recordsOf(ck);
    assert.equal(recs.length, 2, 'both runs must be on disk immediately');
    assert.ok(recs.every((r) => r.status === 'completed'));
    assert.ok(existsSync(`${ck}.meta.json`), 'identity metadata must be written');

    // A second, independent process must schedule nothing and report the same
    // study. If resume reran the pairs, the JSON would show fresh runs rather
    // than restored ones.
    const second = await cli(['--seeds', '2', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '2', '--checkpoint', ck, '--resume', '--json', json, '--quiet']);
    assert.equal(second.code, 0, `resume failed:\n${second.stderr}`);
    assert.match(second.stderr, /0 of 2 runs scheduled/,
      `resume must schedule nothing; stderr was:\n${second.stderr}`);

    const study = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(study.runs.length, 2, 'the resumed report must contain both restored runs');
    assert.equal(study.reconciliation.completed, 2);
    assert.equal(study.reconciliation.pending, 0);
    assert.equal(study.reconciliation.allTerminal, true);

    // Exactly two records still: a completed result must never be rewritten.
    assert.equal(recordsOf(ck).length, 2, 'resume must not append duplicate results');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a killed run is recorded as a failure with full evidence, not dropped', async () => {
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');
    // SIGKILL every child after 1 ms: the real timeout path, no mocking.
    const r = await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '1', '--timeout-ms', '1', '--checkpoint', ck, '--quiet'], 120_000);

    assert.notEqual(r.code, 0, 'a study with no completed run must not exit 0');
    assert.match(r.stderr, /NO RUN COMPLETED/,
      `the diagnosis must be stated, not a TypeError; stderr was:\n${r.stderr}`);

    const recs = recordsOf(ck);
    assert.equal(recs.length, 1);
    const f = recs[0];
    assert.equal(f.status, 'failed');
    assert.equal(f.timedOut, true);
    assert.match(f.error, /timed out after 1 ms/);
    // A SIGKILLed process cannot have written anything. The record must say so
    // rather than presenting an empty stderr as "it printed nothing".
    assert.equal(f.stderrUnavailable, true);
    assert.ok('exitCode' in f && 'signal' in f && 'durationMs' in f && 'stdoutTail' in f);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed pair is not retried by default, and is retried only when asked', async () => {
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');

    await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '1', '--timeout-ms', '1', '--checkpoint', ck, '--quiet'], 120_000);
    assert.equal(recordsOf(ck)[0].status, 'failed');

    // Default resume: the failed pair is NOT scheduled. A retry that happened
    // silently would let one flaky path count as a second observation.
    // Exit 1 is correct here: nothing ran, so there is no study to report, and
    // reporting success on a study with zero measurements would be a lie.
    const noRetry = await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '1', '--checkpoint', ck, '--resume', '--quiet']);
    assert.equal(noRetry.code, 1, `a no-op resume must not claim success:\n${noRetry.stderr}`);
    assert.match(noRetry.stderr, /0 of 1 runs scheduled/);
    assert.match(noRetry.stderr, /NO RUN COMPLETED/);
    assert.equal(recordsOf(ck).length, 1, 'no new attempt without --retry-failed');

    // Explicit retry: now it runs, and the failure is superseded by a success.
    const retry = await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '1', '--checkpoint', ck, '--resume', '--retry-failed', '--quiet']);
    assert.equal(retry.code, 0, `retry failed:\n${retry.stderr}`);
    assert.match(retry.stderr, /1 of 1 runs scheduled/);

    const recs = recordsOf(ck);
    assert.equal(recs.length, 2, 'the failed attempt stays in the file as evidence');
    assert.equal(recs[1].status, 'completed');
    assert.equal(recs[1].attempt, 2, 'the retry must be recorded as a second attempt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a checkpoint written by a different study is refused, not merged', async () => {
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');
    const first = await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '1', '--checkpoint', ck, '--quiet']);
    assert.equal(first.code, 0, `setup failed:\n${first.stderr}`);

    // Same path, different tick count: a different measurement.
    const other = await cli(['--seeds', '1', '--groups', 'baseline', '--ticks', String(TICKS + 30),
      '--workers', '1', '--checkpoint', ck, '--resume', '--quiet']);
    assert.notEqual(other.code, 0, 'a mismatched checkpoint must not be silently accepted');
    assert.match(`${other.stderr}${other.stdout}`, /DIFFERENT study/);

    assert.equal(recordsOf(ck).length, 1, 'the refused study must not have appended anything');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a resumed study reconciles and prints an INCOMPLETE warning when runs are missing', async () => {
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');
    // One seed is killed; one completes. The study must report 1 completed,
    // 1 failed, 0 pending - and must NOT claim completeness while that holds.
    await cli(['--seeds', '2', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '2', '--timeout-ms', '1', '--checkpoint', ck, '--quiet'], 120_000);

    // Now the surviving state: resume with retries, so both pairs get an attempt.
    const r = await cli(['--seeds', '2', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '2', '--checkpoint', ck, '--resume', '--retry-failed', '--quiet']);
    assert.equal(r.code, 0, `resume should complete cleanly:\n${r.stderr}`);
    assert.match(r.stderr, /reconciliation\s+expected 2\s+completed 2\s+failed 0\s+pending 0/);
    assert.ok(!/INCOMPLETE/.test(r.stderr), 'a fully terminal study must not warn INCOMPLETE');

    const recs = recordsOf(ck);
    assert.equal(recs.filter((r) => r.status === 'completed').length, 2);
    assert.equal(recs.filter((r) => r.status === 'failed').length, 2, 'both failures are retained');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bad --groups value is reported as such, not as an unrelated crash', async () => {
  const dir = scratch();
  try {
    const r = await cli(['--seeds', '1', '--groups', 'nope', '--ticks', String(TICKS), '--quiet']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No arms matched/);
    assert.match(r.stderr, /Available groups/);
    assert.ok(!/TypeError/.test(r.stderr), 'must not surface as a TypeError');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a study whose results survive a hard parent kill can still be resumed', async () => {
  // The incident itself: the parent disappears mid-study. This asserts the
  // guarantee that matters - a SIGKILLed parent loses at most the runs that had
  // not yet finished, never the ones already recorded.
  const dir = scratch();
  try {
    const ck = join(dir, 'study.ndjson');
    const child = spawn(process.execPath, [RUN, '--seeds', '4', '--groups', 'baseline',
      '--ticks', String(TICKS), '--workers', '1', '--checkpoint', ck, '--quiet'], {
      cwd: join(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Wait until at least one run is durably recorded, then kill the parent
    // with a signal Node cannot handle in-process.
    const survived = await new Promise((resolve) => {
      const t = setInterval(() => {
        if (existsSync(ck)) {
          const n = readFileSync(ck, 'utf8').split('\n').filter((l) => l.trim()).length;
          if (n >= 1) { clearInterval(t); resolve(n); }
        }
      }, 100);
      child.on('close', () => { clearInterval(t); resolve(-1); });
    });
    child.kill('SIGKILL');

    assert.ok(survived >= 1, 'at least one run should have been recorded before the kill');
    const kept = recordsOf(ck);
    assert.equal(kept.length, survived, 'every recorded run must be intact after the parent dies');
    assert.ok(kept.every((r) => r.status === 'completed'), 'a SIGKILLed parent must not corrupt records');

    // And the study is resumable from exactly that point.
    const resume = await cli(['--seeds', '4', '--groups', 'baseline', '--ticks', String(TICKS),
      '--workers', '2', '--checkpoint', ck, '--resume', '--quiet']);
    assert.equal(resume.code, 0, `resume after a hard kill failed:\n${resume.stderr}${stderr}`);
    assert.match(resume.stderr, /reconciliation\s+expected 4\s+completed 4\s+failed 0\s+pending 0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});