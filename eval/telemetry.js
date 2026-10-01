/**
 * TEOS evaluation harness - telemetry.js
 *
 * LIGHTWEIGHT RESOURCE OBSERVATIONS. This exists because the 20-seed pilot
 * died and left us unable to say why.
 *
 * WHAT THE INCIDENT LOOKED LIKE
 * -----------------------------
 *   - 3 children ran past a 600 s timeout when normal runs take ~35 s (17x)
 *   - the next 3 died instantly with NO stderr captured
 *   - the parent then died
 *   - 12,180 MB in use on an 11,210 MB machine, ~1.1 GB free
 *
 * Every one of those is a number. None of them was recorded at the time, so the
 * diagnosis afterwards had to be reconstructed from process tables rather than
 * read from the run. That is the whole reason this file exists.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * -----------------------------
 * It is not monitoring, and it does not poll. It is a snapshot taken at points
 * where something already happened (a run finished, a worker started) and
 * appended to the checkpoint. No timers, no extra processes, no dependency.
 * `os.totalmem()` / `os.freemem()` are syscalls on the host we are already
 * using.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ------------------------------
 * It cannot show a memory spike that happened between two samples, and it
 * cannot attribute memory to another process. It records FREE memory, which is
 * the honest signal: a study cannot tell what Chrome or an unrelated `npm ci`
 * was doing, but it can record that only 1.1 GB remained, which is enough to
 * make host pressure the leading hypothesis instead of a guess.
 */

import { freemem, totalmem, cpus } from 'node:os';

/** Round to 1 decimal MB so the checkpoint file stays small and readable. */
const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/**
 * A snapshot of what THIS process can observe about the host.
 *
 * @param {object} [o]
 * @param {number} [o.workers] configured worker count
 * @param {number} [o.activeWorkers] workers currently running a job
 * @param {string} [o.event] what triggered the snapshot
 * @param {number} [o.childRssMb] resident set of a child, when the child reported it
 */
export function snapshot({ workers = null, activeWorkers = null, event = null, childRssMb = null } = {}) {
  const total = totalmem();
  const free = freemem();
  return {
    at: new Date().toISOString(),
    event,
    workers,
    activeWorkers,
    parentRssMb: mb(process.memoryUsage().rss),
    childRssMb: childRssMb === null ? null : Math.round(childRssMb * 10) / 10,
    totalMemMb: mb(total),
    freeMemMb: mb(free),
    usedMemPct: Math.round(((total - free) / total) * 1000) / 10,
    cpuCount: cpus()?.length ?? null,
  };
}

/**
 * One-line human form, for the progress log. Kept short because it is printed
 * every run and the log is read by eye.
 */
export function format(s) {
  const parts = [`mem ${s.usedMemPct}% used`, `free ${s.freeMemMb} MB`];
  if (s.childRssMb !== null) parts.push(`child rss ${s.childRssMb} MB`);
  parts.push(`parent rss ${s.parentRssMb} MB`);
  if (s.activeWorkers !== null) parts.push(`active ${s.activeWorkers}`);
  return parts.join(', ');
}