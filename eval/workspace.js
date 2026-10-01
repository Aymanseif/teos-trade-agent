/**
 * TEOS evaluation harness - workspace.js
 *
 * Every run gets its OWN temporary database directory.
 *
 * WHY THIS IS NOT OPTIONAL
 * ------------------------
 * `BacktestEngine` scopes most of its counts to `run_id`, but not all of its
 * reads. `AgentEngine.breachedStops()` selects the governing stop price with
 *
 *     SELECT stop_price FROM agent_decisions
 *      WHERE mode = ? AND symbol = ? AND signal = 'BUY' AND stop_price IS NOT NULL
 *      ORDER BY ts_ms DESC LIMIT 1
 *
 * which has NO `run_id` predicate. Every backtest starts its ManualClock at the
 * same `startMs` (see `generateHistory`'s default), so `ts_ms` values collide
 * across runs and that query is ambiguous once a database holds more than one
 * run. A cold start currently clears prior-run positions before trading, so the
 * collision is not reachable in practice - but a 200-seed study sharing one
 * database is exactly the condition that would reach it.
 *
 * We deliberately do NOT "fix" that query. It is production behaviour and
 * changing it is out of scope for a measurement tool. Instead every run is
 * isolated at the filesystem level, which makes the hazard unreachable, and
 * `eval/tests/isolation.test.js` pins that guarantee.
 *
 * Isolation is enforced by the loader: `loadConfig` derives the database path
 * from `TEOS_DATA_DIR` plus the mode, and derives the WORKER LOCK path from
 * `TEOS_DATA_DIR` too. A shared data dir would also mean every run contending
 * for the same lock file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Human-readable prefix, so a stray directory is identifiable. */
const PREFIX = 'teos-eval-';

/**
 * @param {string} label short tag identifying the run, for debuggability
 * @param {string} [parentDir] create the workspace INSIDE this directory
 *   instead of the OS temp root. The pool passes its per-job scratch directory
 *   so that one `removeDir(scratch)` takes the job file, the result file and
 *   the run's multi-megabyte database together. Creating the workspace as a
 *   SIBLING of the scratch directory leaks it: 340 runs leaked 309 databases,
 *   about 1.9 GB, which is how the first pilot died.
 * @returns {{ dir: string, env: object, dbFile: string, lockFile: string, dispose: () => void }}
 */
export function createWorkspace(label = 'run', parentDir = tmpdir()) {
  const dir = mkdtempSync(join(parentDir, PREFIX));
  const env = {
    ...process.env,
    TEOS_DATA_DIR: dir,
    TEOS_LOG_DIR: join(dir, 'logs'),
  };
  return {
    dir,
    env,
    label,
    dbFile: join(dir, 'teos-backtest.db'),
    lockFile: join(dir, 'teos-backtest.lock'),
    dispose() {
      // Best effort: on Windows the SQLite file can still be mapped for a few
      // milliseconds after the last statement, and while this process lives it
      // usually still IS mapped. That is why the pool deletes from the parent,
      // after the child has exited. This call succeeds for callers that never
      // opened a database.
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
    },
  };
}
