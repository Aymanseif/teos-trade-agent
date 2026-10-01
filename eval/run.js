#!/usr/bin/env node
/**
 * TEOS evaluation harness - run.js
 *
 *   node eval/run.js --seeds 20 --ticks 2500
 *   node eval/run.js --seeds 5 --groups stop-sweep,take-profit
 *   node eval/run.js --seeds 200 --workers 4 --json out.json
 *
 * MEASUREMENT ONLY. This harness never writes `config/default.json`, never
 * mutates production code, and performs no parameter tuning. Its job is to
 * produce numbers that can be reviewed before anything is changed.
 *
 * Flags
 *   --seeds N        number of independent price paths (default 20)
 *   --seed-base N    first seed; seeds run base, base+1, ... (default 20260928)
 *   --project-seeds N  seed count the timing estimate is stated against
 *                    (default 200). Only affects the printed estimate; it never
 *                    changes how many paths are run.
 *   --ticks N        ticks per path (default 2500)
 *   --workers N      concurrent run processes (default 3)
 *   --groups a,b     only these arm groups
 *   --json PATH      also write the compact study as JSON
 *   --checkpoint PATH  durable per-run record (NDJSON); this is the authoritative
 *                    progress store, not the log
 *   --resume         schedule only the (arm, seed) pairs the checkpoint has not
 *                    completed. Completed results are never rerun.
 *   --retry-failed   with --resume, also rerun pairs whose last attempt failed.
 *                    Off by default: a repeated failure must not be mistaken for
 *                    an independent observation.
 *   --force-new-study  start a fresh checkpoint at the same path, discarding any
 *                    existing records
 *   --timeout-ms N   per-run wall-clock limit (default 600000)
 *   --in-process     run in this process instead of spawning children (debug only;
 *                    leaks one SQLite handle per run on Windows)
 *   --quiet          suppress per-run progress
 *
 * DURABILITY
 * ----------
 * Every terminal outcome is appended to the checkpoint synchronously, before the
 * next run starts. The first 20-seed pilot completed 293 of 360 runs and then
 * lost the parent process; because the study only wrote its aggregate JSON at the
 * very end, all 293 completed backtests were unrecoverable. Progress in a log
 * file is not state - it cannot distinguish "completed" from "pending" once the
 * writer is dead, so it is never used for that.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildArms } from './arms.js';
import { runOnce } from './driver.js';
import { summarise } from './summary.js';
import { runPool } from './pool.js';
import { pooledCosts } from './costs.js';
import { rankCauses } from './losses.js';
import { renderReport } from './report.js';
import { round } from './stats.js';
import { openCheckpoint, studyIdentity } from './checkpoint.js';
import { format as formatTelemetry } from './telemetry.js';

function parseArgs(argv) {
  const out = {
    seeds: 20, seedBase: 20260928, projectSeeds: 200, ticks: 2500, workers: 3,
    groups: null, json: null, quiet: false, inProcess: false, renderFrom: null,
    checkpoint: null, resume: false, retryFailed: false, forceNewStudy: false,
    timeoutMs: 600_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seeds') out.seeds = Number(argv[++i]);
    else if (a === '--seed-base') out.seedBase = Number(argv[++i]);
    else if (a === '--project-seeds') out.projectSeeds = Number(argv[++i]);
    else if (a === '--ticks') out.ticks = Number(argv[++i]);
    else if (a === '--workers') out.workers = Number(argv[++i]);
    else if (a === '--groups') out.groups = String(argv[++i]).split(',').map((s) => s.trim());
    else if (a === '--json') out.json = String(argv[++i]);
    else if (a === '--render-from') out.renderFrom = String(argv[++i]);
    else if (a === '--checkpoint') out.checkpoint = String(argv[++i]);
    else if (a === '--resume') out.resume = true;
    else if (a === '--retry-failed') out.retryFailed = true;
    else if (a === '--force-new-study') out.forceNewStudy = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--in-process') out.inProcess = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: node eval/run.js [--seeds N] [--seed-base N] [--project-seeds N] [--ticks N] [--workers N]'
    + ' [--groups a,b] [--json PATH] [--checkpoint PATH] [--resume] [--retry-failed]'
    + ' [--force-new-study] [--timeout-ms N] [--in-process] [--render-from PATH] [--quiet]\n',
  );
  process.exit(0);
}

// Re-render a previously saved study without re-running anything. Presentation
// is the part most likely to need a fix, and re-running an hour of backtests to
// correct a column heading is not acceptable.
if (args.renderFrom) {
  const saved = JSON.parse(readFileSync(args.renderFrom, 'utf8'));
  process.stdout.write(`${renderReport(saved)}\n`);
  process.exit(0);
}

const seeds = Array.from({ length: args.seeds }, (_, i) => args.seedBase + i);
const armOptions = {};
let arms = buildArms(armOptions);
if (args.groups) arms = arms.filter((a) => args.groups.includes(a.group));

// A typo'd --groups silently selected zero arms and then crashed further down
// with a TypeError about `historyMeta`, which says nothing about the real cause.
if (arms.length === 0) {
  const available = [...new Set(buildArms(armOptions).map((a) => a.group))];
  process.stderr.write(`No arms matched --groups "${args.groups.join(',')}". `
    + `Available groups: ${available.join(', ')}\n`);
  process.exit(2);
}

const log = args.quiet ? () => {} : (m) => process.stderr.write(`${m}\n`);

// `--quiet` is documented as suppressing PER-RUN PROGRESS. It must never
// suppress a failure diagnosis or a reconciliation count: a study that lost runs
// has to be able to say so even when asked to be quiet, because that output is
// the only record that the sample is incomplete. Routing these through `log`
// would let `--quiet` turn a partial study into a silent one.
const diagnose = (m) => process.stderr.write(`${m}\n`);

log(`TEOS evaluation harness`);
log(`  arms    ${arms.length}  (${arms.map((a) => a.key).join(', ')})`);
log(`  seeds   ${seeds.length}  (${seeds[0]}..${seeds[seeds.length - 1]})`);
log(`  ticks   ${args.ticks} per path`);
log(`  runs    ${arms.length * seeds.length}`);

const jobs = arms.flatMap((arm) => seeds.map((seed) => ({ armKey: arm.key, seed, ticks: args.ticks })));

// The checkpoint is opened BEFORE any compute, so an identity mismatch is caught
// in a second rather than after two hours of runs that were never going to be
// comparable with what is on disk.
let ck = null;
if (args.checkpoint) {
  const identity = studyIdentity({ arms, seeds, ticks: args.ticks });
  ck = openCheckpoint({ path: args.checkpoint, identity, forceNew: args.forceNewStudy });
  log(`  checkpoint ${args.checkpoint}  identity ${identity}`);
  if (ck.torn !== null) {
    log(`  WARNING: checkpoint had a torn final line (line ${ck.torn}); it was discarded. `
      + 'Earlier records are intact.');
  }
  if (ck.fatals.length) {
    log(`  NOTE: checkpoint records ${ck.fatals.length} prior abnormal-termination event(s).`);
  }
}

const startedAll = Date.now();

// Results already on disk are real results: a resumed study must include them or
// its pooled statistics are computed over a different sample than the one it
// claims.
const restoredRuns = ck
  ? [...ck.records.values()].filter((r) => r.status === 'completed').map((r) => r.result)
  : [];
const restoredFailures = ck
  ? [...ck.records.values()].filter((r) => r.status === 'failed')
  : [];

let scheduled = jobs;
if (ck && args.resume) {
  scheduled = ck.pendingFor(jobs, { retryFailed: args.retryFailed });
  // Unconditional: this line says how much of the study is being SKIPPED, which
  // determines whether the resulting sample is the one you think it is.
  diagnose(`  resume: ${restoredRuns.length} completed, ${restoredFailures.length} failed, `
    + `${scheduled.length} of ${jobs.length} runs scheduled`
    + (args.retryFailed ? ' (failed pairs included)' : ' (failed pairs NOT retried)'));
}

// Any abnormal exit of the PARENT is recorded, because the study-level counters
// are the only place the totals live. This cannot catch SIGKILL, a power loss or
// an OOM kill from outside the process - Node has no way to run code in those
// cases. That is exactly why each result is already on disk individually: the
// fatal record is a convenience, the per-run records are the guarantee.
if (ck) {
  const fatal = (reason, detail) => {
    try {
      const s = ck.stats(jobs);
      ck.recordFatal({
        reason, detail: detail ? String(detail).slice(0, 2000) : null,
        completed: s.completed, failed: s.failed, pending: s.pending,
        expected: s.expected, checkpointPath: ck.path, workers: args.workers,
      });
    } catch { /* the process is already failing; do not mask the original reason */ }
  };
  process.on('uncaughtException', (e) => { fatal('uncaughtException', e?.stack ?? e); process.exit(1); });
  process.on('unhandledRejection', (e) => { fatal('unhandledRejection', e?.stack ?? e); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { fatal(`signal:${sig}`); process.exit(130); });
  }
  process.on('exit', (code) => {
    // Only abnormal exits are worth a record. A clean exit already wrote its
    // results, and one fatal record per study is more useful than several.
    if (code !== 0) fatal(`exit:${code}`);
  });
}

let runs = [];
let failures = [];
if (args.inProcess) {
  log('  mode: IN-PROCESS (debug only; leaks a SQLite handle per run)');
  let n = 0;
  for (const job of scheduled) {
    const arm = arms.find((a) => a.key === job.armKey);
    // eslint-disable-next-line no-await-in-loop
    const result = summarise(await runOnce({ arm, seed: job.seed, ticks: job.ticks }));
    runs.push(result);
    ck?.append({
      kind: 'run', status: 'completed', ...job, durationMs: result.wallMs, result,
    });
    n += 1;
    log(`  [${n}/${scheduled.length}] ${job.armKey} seed ${job.seed}`);
  }
} else {
  log(`  mode: ${args.workers} worker processes`);
  const pool = await runPool(scheduled, {
    concurrency: args.workers,
    timeoutMs: args.timeoutMs,
    onProgress: log,
    armOptions,
    // Synchronous append inside the pool's own callback: the record is on disk
    // before that worker takes its next job.
    onResult: (rec) => { try { ck?.append(rec); } catch (e) { log(`  !! checkpoint append failed: ${e.message}`); } },
  });
  runs = pool.results;
  failures = pool.failures;
}

// A resumed study reports on restored + new together, so the totals always
// describe the whole study, not just this process's contribution.
runs = [...restoredRuns, ...runs];
if (ck) {
  // Failures are read BACK FROM THE CHECKPOINT rather than accumulated. A pair
  // that failed and then succeeded on an explicit retry is not a failure, and
  // carrying the stale record forward both misreported the study and forced a
  // non-zero exit for a study that had in fact completed every run.
  failures = [...ck.records.values()].filter((r) => r.status === 'failed');
} else {
  failures = [...restoredFailures, ...failures];
}
const totalMs = Date.now() - startedAll;

// Zero completed runs is a real outcome - a wholly failed or wholly resumed
// study - and it has no report. Attempting to render one anyway crashed on
// `runs[0].historyMeta`, which replaced the actual diagnosis ("every run
// failed", plus why) with an unrelated TypeError. Say what happened instead.
if (runs.length === 0) {
  const s = ck ? ck.stats(jobs) : null;
  diagnose('');
  diagnose(`!! NO RUN COMPLETED. ${failures.length} failure(s) recorded, ${jobs.length} job(s) expected.`);
  for (const f of failures.slice(0, 10)) {
    diagnose(`   ${f.armKey} seed ${f.seed}: ${f.error} (exit=${f.exitCode ?? '-'} signal=${f.signal ?? '-'} `
      + `timedOut=${!!f.timedOut} ${round((f.durationMs ?? 0) / 1000, 1)}s) `
      + `${f.stderrUnavailable ? 'stderr_unavailable' : `stderr: ${String(f.stderr).slice(0, 300)}`}`);
  }
  if (failures.length > 10) diagnose(`   ... and ${failures.length - 10} more; see the checkpoint.`);
  if (s) {
    diagnose(`   checkpoint ${ck.path}: completed ${s.completed} failed ${s.failed} pending ${s.pending}`);
  }
  diagnose('Nothing can be reported: a study with zero completed runs has no measurements.');
  process.exit(1);
}

// Order the results so the report is stable run to run.
const armOrder = new Map(arms.map((a, i) => [a.key, i]));
runs.sort((a, b) => (armOrder.get(a.arm) - armOrder.get(b.arm)) || (a.seed - b.seed));

const trades = runs.flatMap((r) => r.trades);
const reconciliations = runs.map((r) => ({ arm: r.arm, seed: r.seed, ...r.reconciliation }));
const signalTotals = {};
for (const r of runs.filter((x) => x.arm === 'base')) {
  for (const [k, v] of Object.entries(r.signalsByKind ?? {})) signalTotals[k] = (signalTotals[k] ?? 0) + v;
}

const baseRuns = runs.filter((r) => r.arm === 'base');
const costsByArm = {};
for (const arm of arms) costsByArm[arm.key] = pooledCosts(runs.filter((r) => r.arm === arm.key));

const ref = runs[0];
const minBars = 40; // sma_cross.minBars - the gate before any decision can be made
const meanWall = runs.length ? Math.round(runs.reduce((s, r) => s + r.wallMs, 0) / runs.length) : 0;

const study = {
  generatedIso: new Date().toISOString(),
  seeds,
  ticks: args.ticks,
  arms,
  runs,
  trades,
  reconciliations,
  failures,
  costsByArm,
  causes: rankCauses({
    runs: baseRuns,
    trades: trades.filter((t) => t.arm === 'base'),
    signalTotals,
  }),
  stopPcts: arms.filter((a) => a.group === 'stop-sweep').map((a) => Number(a.key.replace('stop-', ''))),
  stopFloorPct: baseRuns[0]?.stopFloorPct ?? 0.25,
  stopCeilingPct: baseRuns[0]?.stopCeilingPct ?? 5,
  barsPerPath: ref.historyMeta.bars,
  usableBars: ref.historyMeta.bars - minBars,
  ticksPerCandle: ref.historyMeta.ticksPerCandle,
  minBars,
  timing: {
    totalMs,
    runs: runs.length,
    failures: failures.length,
    meanPerRunMs: meanWall,
    workers: args.inProcess ? 1 : args.workers,
    // Wall-clock for `projectSeeds` seeds x `arms.length` arms, from the OBSERVED
    // per-run cost and the observed concurrency, not a guess. The scale factor is
    // the ratio of the requested seed count to the seed count actually run, so a
    // 20-seed pilot is projected to 200 seeds rather than back to 20.
    projectSeeds: args.projectSeeds,
    extrapolatedMs: (meanWall * (arms.length * args.projectSeeds)) / (args.inProcess ? 1 : args.workers),
  },
  // Reconciliation against the FULL job list, read from the checkpoint rather
  // than from this process's counters. On a resumed study those two can differ,
  // and the checkpoint is the authoritative one.
  reconciliation: ck ? {
    checkpointPath: ck.path,
    identity: ck.identity,
    tornLineDiscarded: ck.torn,
    priorFatalEvents: ck.fatals.length,
    ...ck.stats(jobs),
  } : null,
  limitations: [
    'The data is SYNTHETIC. Price paths come from a seeded simulator whose volatility is set by instruments[].annualVolPct in the config, not by any market. Nothing here transfers to a real instrument.',
    `A path is ${args.ticks} ticks = ${(args.ticks / 60).toFixed(1)} minutes and ${ref.historyMeta.bars} bars. The strategy needs ${minBars} bars before it evaluates, so only ${ref.historyMeta.bars - minBars} bars per symbol can ever produce a decision. At 1200 ticks the run produces literally zero trades.`,
    `Per-seed trade counts are far too low for a reliable expectancy estimate. Every trade-level statistic here is POOLED across seeds; per-seed figures are reported as a distribution, never as a mean.`,
    `${arms.length} arms x ${seeds.length} seeds = ${runs.length} completed runs is a PILOT, not a study. This many paths cannot separate a small edge from zero.`,
    'Stop distance in this configuration does NOT control position size: size is bound by risk.maxPositionSizeEgp, so the stop sweep measures exit timing and P&L, not risk.',
    'Costs are modelled, not observed. The slippage figure includes the spread crossing, so it overlaps the half-spread and is not an independent measure alongside fees.',
    'Long-only, cash-funded, no leverage, no shorting, no derivatives. These results do not extrapolate to any strategy that uses them.',
    "The take-profit arms are a stateful measurement overlay, not a shippable strategy: a take-profit needs the entry's risk unit in memory, which a pure production strategy is not allowed to keep.",
    'Regime tags are PERCENTILE ranks within each synthetic path, not measured market regimes. They split each path in half by construction and are not a claim about real market conditions.',
  ],
};

// The raw study is written BEFORE the report is rendered. Rendering is pure
// presentation, but it is the most likely place for a crash (a null where a
// number was expected, an empty bucket). Writing first means a rendering bug
// costs a re-render rather than an hour of completed runs.
if (args.json) {
  writeFileSync(args.json, JSON.stringify(study, null, 2));
  log(`study written to ${args.json}`);
}

process.stdout.write(`${renderReport(study)}\n`);

log('');
log(`completed ${runs.length}/${jobs.length} runs in ${(totalMs / 1000).toFixed(1)}s `
  + `(${round(meanWall / 1000, 1)}s per run, ${args.workers} workers)`
  + (scheduled.length === jobs.length ? '' : `  [${scheduled.length} scheduled this process]`));
if (failures.length) {
  log(`!! ${failures.length} FAILED run(s). First: ${JSON.stringify(failures[0])}`);
}
log(`extrapolated wall-clock for ${args.projectSeeds} seeds x ${arms.length} arms at ${args.workers} workers: `
  + `${round(study.timing.extrapolatedMs / 1000 / 60, 1)} min`);

// Reconciliation is printed unconditionally when a checkpoint exists, so a
// half-finished study is obvious from the console alone. A study is complete only
// when `pending` is 0; "the process exited 0" is not the same claim.
if (ck) {
  const s = ck.stats(jobs);
  diagnose('');
  diagnose(`reconciliation  expected ${s.expected}  completed ${s.completed}  failed ${s.failed}  `
    + `pending ${s.pending}  duplicated ${s.duplicated}`);
  diagnose(`  checkpoint ${ck.path}${ck.torn !== null ? `  (torn line ${ck.torn} discarded)` : ''}`);
  if (ck.fatals.length) diagnose(`  prior abnormal-termination events: ${ck.fatals.length}`);
  if (!s.allTerminal) {
    diagnose('  INCOMPLETE. Resume with --resume (add --retry-failed to include failed pairs).');
  }
  // A study with failed runs is complete in the sense that every pair has a
  // terminal state, but it is NOT a clean result, and the two must not read the
  // same way to anyone skimming the output.
  if (s.failed > 0) {
    diagnose(`  ${s.failed} run(s) FAILED. Their absence shrinks the sample, so per-arm figures are`
      + ' not comparable to a run with every arm complete. See section 8.');
  }
}

const badRecon = reconciliations.filter((r) => Math.abs(r.difference) > 0.5);
if (badRecon.length) {
  log(`WARNING: ${badRecon.length} run(s) where pooled trade P&L does not reconcile with the `
    + `engine's closed-trade figure. First: ${JSON.stringify(badRecon[0])}`);
}
if (failures.length) process.exit(1);
