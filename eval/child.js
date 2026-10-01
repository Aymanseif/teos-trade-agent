#!/usr/bin/env node
/**
 * TEOS evaluation harness - child.js
 *
 * Runs EXACTLY ONE (arm, seed) pair, writes the compact summary as JSON to a
 * file, and exits.
 *
 * WHY A PROCESS PER RUN
 * ---------------------
 * `Worker.stop()` releases the worker lock and disconnects the broker, but it
 * never closes the SQLite handle, and `Worker` exposes no `close()`. In one
 * long-lived process, every run would leak one open database file. A 15-arm,
 * 200-seed study is 3,000 runs, which is 3,000 leaked handles and up to 12 GB of
 * undeleted databases under %TEMP%.
 *
 * We could add a `close()` to `Worker`. We are NOT going to edit production code
 * to serve a measurement tool. Instead each run gets its own process, and
 * process exit is what closes the handle - after which the parent can delete
 * the run's temporary directory.
 *
 * This also makes the study embarrassingly parallel: runs share no files, no
 * database and no module state, so they can run concurrently. `eval/pool.js`
 * does that.
 *
 * Usage: node eval/child.js <job.json> <resultPath>
 */

import { writeFileSync } from 'node:fs';
import { buildArms } from './arms.js';
import { runOnce } from './driver.js';
import { summarise } from './summary.js';

const [jobPath, resultPath] = process.argv.slice(2);
if (!jobPath || !resultPath) {
  process.stderr.write('usage: node eval/child.js <job.json> <result.json>\n');
  process.exit(2);
}

const job = JSON.parse(
  // eslint-disable-next-line no-undef
  (await import('node:fs')).readFileSync(jobPath, 'utf8'),
);

// The arm is rebuilt from its key rather than passed across the process
// boundary: the overrides contain functions for harness strategies, and
// functions do not survive JSON. Rebuilding guarantees the child constructs the
// same arm the parent meant.
const arm = buildArms(job.armOptions ?? {}).find((a) => a.key === job.armKey);
if (!arm) {
  process.stderr.write(`unknown arm key: ${job.armKey}\n`);
  process.exit(3);
}

try {
  // The workspace is created INSIDE the pool's scratch directory so the parent
  // can remove one path and take the database with it.
  const run = await runOnce({
    arm, seed: job.seed, ticks: job.ticks, workspaceParent: job.workspaceParent,
  });
  const summary = summarise(run);
  // The child is the only process that can report its OWN resident set, so it is
  // recorded here. The parent cannot read another process's RSS portably, and a
  // study that suspects memory pressure needs per-run numbers, not just its own.
  // Additive: `summarise`'s schema is unchanged, so nothing downstream shifts.
  summary.telemetry = {
    rssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    wallMs: summary.wallMs,
  };
  writeFileSync(resultPath, JSON.stringify(summary));
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
}