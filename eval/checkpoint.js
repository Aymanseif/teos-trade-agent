/**
 * TEOS evaluation harness - checkpoint.js
 *
 * DURABLE STUDY PROGRESS. The checkpoint is the authoritative record of what a
 * study has actually run.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first 20-seed pilot completed 293 of 360 runs, lost the parent process to
 * host memory pressure, and produced NOTHING: the study aggregated every result
 * in memory and wrote its JSON once, at the end. 293 completed backtests - over
 * two hours of compute - evaporated because there was no incremental write.
 *
 * The second failure was that progress lived only in a log file. When the parent
 * died there was no way to tell a completed run from a pending one, so the
 * surviving log lines could not be trusted as a progress record. A log is an
 * event stream; it is not a state store.
 *
 * So: every terminal outcome is durably appended the moment it is known, and a
 * resume reads state from that file rather than inferring anything.
 *
 * FILE FORMAT
 * -----------
 *   <path>          newline-delimited JSON, one record per line, appended
 *   <path>.meta.json  study identity, written atomically at open
 *
 * NDJSON rather than one rewritten JSON blob, because rewriting a 360-record
 * document after every single run is 360 writes of the whole file. Append plus
 * "the last line may be torn" is the standard, cheap, recoverable shape.
 *
 * DURABILITY CONTRACT
 * -------------------
 * A crash can only ever damage the FINAL line, because every line before it was
 * flushed by the time the next one was started. `loadCheckpoint` therefore drops
 * an unparseable trailing line and reports it, rather than refusing to load a
 * study that is 359/360 complete. A parse failure anywhere else is real
 * corruption and is reported as such.
 *
 * Node cannot catch SIGKILL, a power loss, or an OOM kill from outside the
 * process. That is why the checkpoint is written on every result rather than at
 * the end: it does not depend on the parent surviving to tidy up.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, openSync, readFileSync,
  renameSync, writeFileSync, writeSync,
} from 'node:fs';

/** Thrown when a result is offered for a (arm, seed) that already completed. */
export class DuplicateResultError extends Error {
  constructor(arm, seed) {
    super(`Refusing to overwrite a COMPLETED result for ${arm} seed ${seed}. `
      + 'A completed result is immutable; rerun it only via an explicit rerun, '
      + 'which is reported as a separate attempt.');
    this.name = 'DuplicateResultError';
    this.arm = arm;
    this.seed = seed;
  }
}

/** Thrown when a checkpoint was written by a different study configuration. */
export class StudyMismatchError extends Error {
  constructor(want, got) {
    super(`Checkpoint was written by a DIFFERENT study and cannot be resumed.\n`
      + `  checkpoint identity: ${got}\n  requested identity:  ${want}\n`
      + 'Change --checkpoint to a new path, or pass --force-new-study to discard it.');
    this.name = 'StudyMismatchError';
    this.want = want;
    this.got = got;
  }
}

export class CheckpointCorruptError extends Error {
  constructor(path, line, detail) {
    super(`Checkpoint ${path} is corrupt at line ${line}: ${detail}. `
      + 'This is not a torn trailing write, so the file cannot be trusted. '
      + 'Start a new checkpoint path rather than guessing which records survived.');
    this.name = 'CheckpointCorruptError';
  }
}

/**
 * A stable identity for "the same study".
 *
 * Covers everything that would make a resumed run a DIFFERENT measurement: the
 * arm set with its config overrides and strategy ids, the seed list, and the tick
 * count. Deliberately EXCLUDES worker count, checkpoint path and wall clock,
 * because those do not change what a run measures - changing them must not
 * invalidate a resume.
 *
 * Strategy objects are functions and cannot be serialised, so identity uses
 * `strategyId` instead. Two arms with the same id and overrides are the same
 * arm.
 */
export function studyIdentity({ arms, seeds, ticks }) {
  const shape = {
    ticks,
    seeds: [...seeds].sort((a, b) => a - b),
    arms: arms
      .map((a) => ({ key: a.key, group: a.group, strategyId: a.strategyId ?? null, overrides: a.overrides ?? {} }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  return createHash('sha256').update(canonical(shape)).digest('hex').slice(0, 16);
}

/** Deterministic JSON: object keys sorted, so key order cannot change identity. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * Write a file so a reader never observes a partial version.
 *
 * Write to a sibling temp file, flush it, then rename over the target. Rename
 * within a directory is atomic on both NTFS and POSIX, so a crash leaves either
 * the old complete file or the new complete file - never a blend of the two.
 */
export function atomicWriteFileSync(path, data) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const META_SUFFIX = '.meta.json';

/**
 * Open (or create) a checkpoint for a study.
 *
 * @param {object} o
 * @param {string} o.path      checkpoint file; `<path>.meta.json` holds identity
 * @param {string} o.identity  from `studyIdentity`
 * @param {boolean} [o.forceNew] discard an existing checkpoint instead of validating it
 * @returns {{ records: Map, torn: number|null, path: string, meta: object, append: Function, ... }}
 */
export function openCheckpoint({ path, identity, forceNew = false }) {
  const metaPath = `${path}${META_SUFFIX}`;
  let torn = null;

  if (forceNew) {
    try { writeFileSync(path, ''); } catch { /* absent is the same as empty */ }
    atomicWriteFileSync(metaPath, JSON.stringify({ identity, createdIso: new Date().toISOString() }, null, 2));
  } else if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.identity !== identity) throw new StudyMismatchError(identity, meta.identity);
  } else if (existsSync(path) && readFileSync(path, 'utf8') !== '') {
    // Records without identity metadata: refuse rather than guess. A study with
    // an unknown provenance must not be silently merged into this one.
    throw new StudyMismatchError(identity, 'unknown (no meta file)');
  } else {
    // Either a brand-new path, or a zero-byte file left by a crash between
    // creating the file and writing its meta. There are no records to mismatch
    // in that case, so treating it as fresh loses nothing - whereas refusing
    // would strand the study permanently on a recoverable crash.
    atomicWriteFileSync(metaPath, JSON.stringify({ identity, createdIso: new Date().toISOString() }, null, 2));
  }

  /**
 * The identity of a run record.
 *
 * Pool jobs carry `armKey`; the persisted record and the report both speak of
 * `arm`. Normalising here means a record cannot be filed under `undefined` and
 * silently become invisible to resume - which is exactly what happened when
 * `append` keyed on `rec.arm` while the pool supplied `rec.armKey`: the run
 * completed, was written, and was then never found again.
 */
const armOf = (rec) => rec.arm ?? rec.armKey;
const keyOf = (rec) => `${armOf(rec)}|${rec.seed}`;

const { records, tornLine } = loadRecords(path);
  torn = tornLine;

  /** Latest record per `arm|seed`, plus every study-level event (fatal, complete). */
  const latest = new Map();
  const events = [];
  for (const rec of records) {
    if (rec.kind && rec.kind !== 'run') { events.push(rec); continue; }
    latest.set(keyOf(rec), rec);
  }
  // Prior abnormal terminations, computed LIVE. A filtered copy taken once at open
  // would miss every fatal recorded afterwards - which is the only kind that
  // matters, since the study is by definition not finished when they occur.
  const fatalEvents = () => events.filter((e) => e.kind === 'fatal');

  const key = (arm, seed) => `${arm}|${seed}`;

  return {
    path,
    metaPath,
    identity,
    torn,
    records: latest,
    events,
    get fatals() { return fatalEvents(); },

    /** @returns {boolean} a COMPLETED result exists, so the run need not repeat. */
    isCompleted(arm, seed) { return latest.get(key(arm, seed))?.status === 'completed'; },

    /** @returns {boolean} the last recorded attempt failed. */
    isFailed(arm, seed) { return latest.get(key(arm, seed))?.status === 'failed'; },

    /** @returns {number} 1 for a first attempt, 2+ for explicit reruns of a failure. */
    attempts(arm, seed) { return latest.get(key(arm, seed))?.attempt ?? 0; },

    /**
     * Durably record one terminal outcome. Synchronous by design: when this
     * returns, the bytes are on disk, so a crash immediately afterwards still
     * preserves the result.
     *
     * @param {object} rec  { kind:'run', arm, seed, status, ... }
     * @returns {object} the record as written
     */
    append(rec) {
      // Study-level events (kind: 'fatal', 'complete') carry no arm/seed, so they
      // are logged separately and never affect per-pair completion state.
      if (rec.kind && rec.kind !== 'run') {
        const written = { at: new Date().toISOString(), ...rec };
        appendFileSync(path, `${JSON.stringify(written)}\n`);
        events.push(written);
        return written;
      }
      const prev = latest.get(keyOf(rec));
      if (prev?.status === 'completed') throw new DuplicateResultError(armOf(rec), rec.seed);
      // `arm` is written as the canonical field so the record on disk is
      // self-describing and readable without knowing the caller's field names.
      const written = {
        kind: 'run',
        at: new Date().toISOString(),
        attempt: (prev?.attempt ?? 0) + 1,
        ...rec,
        arm: armOf(rec),
      };
      appendFileSync(path, `${JSON.stringify(written)}\n`);
      latest.set(keyOf(written), written);
      return written;
    },

    /** Record study-level abnormal termination. See the caveat in the header. */
    recordFatal(detail) { return this.append({ kind: 'fatal', ...detail }); },

    /** Record that the study reached the end of its scheduled work. */
    recordComplete(detail) { return this.append({ kind: 'complete', ...detail }); },

    /**
     * Jobs still needing a run.
     *
     * A COMPLETED pair is never rescheduled. A FAILED pair is also not
     * rescheduled unless `retryFailed` is set: a repeated failure must not be
     * mistaken for an independent observation, so rerunning it is always an
     * explicit decision.
     */
    pendingFor(jobs, { retryFailed = false } = {}) {
      return jobs.filter((j) => {
        const k = keyOf(j);
        // A COMPLETED pair is never rescheduled, under any flag.
        if (latest.get(k)?.status === 'completed') return false;
        // A FAILED pair is not rescheduled unless explicitly asked for: retrying
        // silently would let one flaky path be counted as if it were a second
        // independent observation of that path.
        if (latest.get(k)?.status === 'failed' && !retryFailed) return false;
        return true;
      });
    },

    /** Reconciliation counts against the FULL job list, not the pending list. */
    stats(jobs) {
      const expected = jobs.length;
      let completed = 0; let failed = 0; let pending = 0;
      for (const j of jobs) {
        const rec = latest.get(keyOf(j));
        if (rec?.status === 'completed') completed += 1;
        else if (rec?.status === 'failed') failed += 1;
        else pending += 1;
      }
      return {
        expected,
        completed,
        failed,
        pending,
        // "Duplicated" is a property we REFUSE to create: a completed result is
        // immutable and a second one throws. It is reported as 0 by construction.
        duplicated: 0,
        allTerminal: pending === 0,
      };
    },
  };
}

/** Parse the NDJSON file, tolerating exactly one torn trailing line. */
export function loadRecords(path) {
  if (!existsSync(path)) return { records: [], tornLine: null };
  const raw = readFileSync(path, 'utf8');
  if (raw === '') return { records: [], tornLine: null };
  const lines = raw.split('\n');
  // A well-formed file ends with a newline, so the final element is ''.
  const trailing = lines[lines.length - 1] === '' ? lines.pop() : null;

  const records = [];
  let tornLine = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      // Only the LAST line may legitimately be torn.
      if (i === lines.length - 1 && trailing === null) { tornLine = i + 1; break; }
      throw new CheckpointCorruptError(path, i + 1, e.message);
    }
  }
  return { records, tornLine };
}
