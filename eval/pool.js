#!/usr/bin/env node
/**
 * TEOS evaluation harness - pool.js
 *
 * Runs a list of (arm, seed) jobs across N child processes and collects the
 * compact summaries.
 *
 * CONCURRENCY IS SAFE BECAUSE OF THE ISOLATION GUARANTEE
 * -----------------------------------------------------
 * Each job runs in its own process with its own temporary `TEOS_DATA_DIR`, so
 * two concurrent jobs cannot share a database file, a worker lock or module
 * state. The only shared thing is the read-only `config/default.json`, which no
 * job writes. That is what makes the multi-seed study independent - and the
 * reason `eval/tests/isolation.test.js` is not optional decoration.
 *
 * A crashed or timed-out job is reported as a FAILURE with its stderr, never
 * silently dropped: a missing run that quietly shrinks the sample would make a
 * losing system look better by selecting out its worst paths.
 *
 * FAILURE RECORDS ARE EVIDENCE, NOT LOG LINES
 * --------------------------------------------
 * The first 20-seed pilot produced six failures whose only record was
 * `child exited 1` and nothing else. Exit code, signal, timeout flag, stderr,
 * stdout tail and duration were all discarded, so the incident could not be
 * diagnosed afterwards. Every failure here now carries all of them, and the
 * caller is handed the record through `onResult` the moment it is known, so it
 * can be durably stored before the next job starts.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './telemetry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'child.js');

/** Windows EBUSY on a just-closed handle; retry briefly, then give up quietly. */
function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* leak, not a wrong number */ }
}

/** Keep only the last N characters of a stream: the tail is where a crash explains itself. */
const tail = (s, n = 2000) => (s.length > n ? s.slice(-n) : s);

/**
 * @param {Array<{armKey:string, seed:number, ticks:number}>} jobs
 * @param {object} o
 * @param {number} [o.concurrency]
 * @param {number} [o.timeoutMs] per-job wall-clock limit
 * @param {(msg:string)=>void} [o.onProgress]
 * @param {object} [o.armOptions] passed through so the child rebuilds the same arm set
 * @param {(record:object)=>void} [o.onResult] called SYNCHRONOUSLY with every terminal
 *   outcome, before the next job is taken. This is the durability seam: a caller
 *   that writes the record here has it on disk before any further compute happens.
 * @returns {Promise<{results:object[], failures:object[], telemetry:object[], scratchDirs:string[]}>}
 *   `scratchDirs` is every directory this call created, so a caller can verify the
 *   cleanup guarantee about ITS OWN directories. A global count of `teos-eval-job-*`
 *   in %TEMP% is not usable for that: node --test runs test FILES concurrently, so
 *   any other harness test running at the same moment perturbs the count and a
 *   correct pool gets reported as leaking.
 */
export async function runPool(jobs, {
  concurrency = 1, timeoutMs = 600_000, onProgress = () => {}, armOptions = {}, onResult = () => {},
} = {}) {
  const results = [];
  const failures = [];
  const telemetry = [];
  const scratchDirs = [];
  const queue = [...jobs];
  let done = 0;
  let active = 0;

  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const scratch = mkdtempSync(join(tmpdir(), 'teos-eval-job-'));
      scratchDirs.push(scratch);
      const jobFile = join(scratch, 'job.json');
      const resultFile = join(scratch, 'result.json');
      // `workspaceParent` makes the child put its database INSIDE the scratch
      // directory, so the single `removeDir(scratch)` below cleans up the job
      // file, the result file AND the run's database. When the child created its
      // workspace as a sibling of scratch, 340 runs leaked 309 databases (~1.9
      // GB) and the study died before it produced a report.
      writeFileSync(jobFile, JSON.stringify({ ...job, armOptions, workspaceParent: scratch }));

      active += 1;
      const startedAt = Date.now();
      const outcome = await new Promise((resolve) => {
        const child = spawn(process.execPath, [CHILD, jobFile, resultFile], {
          // stdout is piped rather than ignored so a crash can leave a trace there.
          // The child writes its result to a FILE, not stdout, so this is quiet on
          // a healthy run and only carries anything on a failure.
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: HERE,
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.stdout.on('data', (d) => { stdout += d.toString(); });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ ok: false, error: `timed out after ${timeoutMs} ms`, timedOut: true, exitCode: null, signal: 'SIGKILL', stderr, stdout });
        }, timeoutMs);

        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: e.message, timedOut: false, exitCode: null, signal: null, stderr, stdout });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) {
            resolve({ ok: false, error: `child exited ${code}`, timedOut: false, exitCode: code, signal: signal ?? null, stderr, stdout });
            return;
          }
          try {
            resolve({ ok: true, json: readFileSync(resultFile, 'utf8'), exitCode: 0, signal: null, stderr, stdout });
          } catch (e) {
            resolve({ ok: false, error: `unreadable result: ${e.message}`, timedOut: false, exitCode: 0, signal: null, stderr, stdout });
          }
        });
      });

      const durationMs = Date.now() - startedAt;
      active -= 1;
      done += 1;

      if (outcome.ok) {
        const result = JSON.parse(outcome.json);
        results.push(result);
        // The child observed its own RSS; carry it up so a study can show memory
        // per RUN and not only for the parent.
        const snap = snapshot({
          workers: concurrency,
          activeWorkers: active,
          event: 'run-completed',
          childRssMb: result?.telemetry?.rssMb ?? null,
        });
        telemetry.push(snap);
        onResult({
          kind: 'run', status: 'completed', ...job, durationMs, telemetry: snap, result,
        });
        onProgress(`  [${done}/${jobs.length}] ${job.armKey} seed ${job.seed}`);
      } else {
        // A killed process cannot have written anything. Recording an empty
        // string would read as "it printed nothing", which is a different claim
        // from "we have no stderr because it died before it could write" - and
        // the difference matters when deciding whether the process was
        // OOM-killed. Say which one it is.
        const stderrText = outcome.stderr ? tail(outcome.stderr, 2000) : '';
        const detail = {
          arm: job.armKey,
          armKey: job.armKey,
          seed: job.seed,
          status: 'failed',
          durationMs,
          error: outcome.error,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: !!outcome.timedOut,
          stderr: stderrText,
          stderrUnavailable: stderrText === '',
          stdoutTail: tail(outcome.stdout, 1000),
          telemetry: snapshot({ workers: concurrency, activeWorkers: active, event: 'run-failed' }),
        };
        failures.push(detail);
        // Reported IMMEDIATELY, not just in the end-of-study summary. The first
        // pilot lost a run at 175/340 and the reason died with the process; a
        // failure that is only visible at the end is a failure you cannot debug.
        onProgress(`  [${done}/${jobs.length}] ${job.armKey} seed ${job.seed} FAILED: ${outcome.error} `
          + `(exit=${outcome.exitCode} signal=${outcome.signal ?? '-'} timedOut=${!!outcome.timedOut} ${(durationMs / 1000).toFixed(1)}s)`);
        if (stderrText) onProgress(`      stderr: ${stderrText.trim().split('\n').slice(0, 4).join(' | ')}`);
        else onProgress('      stderr: stderr_unavailable');
        onResult(detail);
      }
      removeDir(scratch);
    }
  }

  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker);
  await Promise.all(lanes);

  return { results, failures, telemetry, scratchDirs };
}