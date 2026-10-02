/**
 * TEOS Trade Agent - vercel/state.js
 *
 * Decides what this deployment is able to truthfully show, and gets hold of it.
 *
 * A Vercel function is not a server with a disk. There is no `data/`
 * directory, no WAL file, no long-lived process, and no SQLite file that
 * survives a cold start. So there are exactly two honest states, and this
 * module picks between them:
 *
 *   1. SNAPSHOT. The operator pointed `TEOS_SNAPSHOT_DB` at a read-only SQLite
 *      file that exists in this environment. Real paper-trading data is
 *      projected through the SAME functions the local dashboard uses
 *      (`dashboard/api.js`), so the Vercel page cannot drift from the local page.
 *
 *   2. EMPTY. No such file, or it cannot be opened. `empty.js` supplies a
 *      payload in which every measured value is `null`.
 *
 * What this module will not do is invent a third state. In particular, if a
 * database opens but contains no balance row, it does NOT fall back to the
 * `startingCapitalEgp` default inside `accountSection` - it reports empty, for
 * the reason documented in `empty.js`. The fallback is correct on a live local
 * dashboard and would be a fabrication here.
 *
 * Nothing in the import graph below reaches the worker, the broker, the
 * matching engine or any execution path. That is checked mechanically by
 * `scripts/vercel-check.js`, not merely asserted here.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../core/config.js';
import { redact } from '../core/env.js';
import { systemClock } from '../core/clock.js';
import { openDatabase } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { AuditChain } from '../database/audit-chain.js';
import { Repos } from '../database/repositories/index.js';
import { snapshot as projectSnapshot, section as projectSection } from '../dashboard/api.js';
import { DATA_STATE, emptySnapshot, emptySection } from './empty.js';
import { DEPLOYMENT, TRUTH } from './identity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = resolve(ROOT, 'config', 'default.json');

/** The only mode this deployment may ever read. */
export const MODE = 'PAPER';

/** The env var an operator sets to supply a read-only snapshot database. */
export const SNAPSHOT_ENV_VAR = 'TEOS_SNAPSHOT_DB';

// Per-container cache. A serverless function is reused across requests, and
// opening the database once per cold start is the difference between a fast
// endpoint and a slow one. It is also what makes the read-only connection
// actually read-only in practice: there is no code path that reopens it
// writable, because there is no code path that reopens it at all.
let CACHE = null;

// --------------------------------------------------------------- CONFIG

/**
 * Load configuration from an explicit path rather than `process.cwd()`.
 *
 * `loadConfig` resolves `./config/default.json` relative to the working
 * directory unless given a path, and a serverless working directory is not
 * guaranteed to be the project root. Passing the path explicitly removes the
 * guess. It also keeps `loadConfig`'s two security assertions - no credentials
 * present, live trading disabled - on the serving path, which is where they
 * belong.
 */
function loadDeploymentConfig() {
  try {
    const config = loadConfig({ path: CONFIG_PATH, env: process.env });
    return { config, error: null };
  } catch (err) {
    // A refused environment is NOT the same as a missing file, and the two are
    // reported differently on purpose. `assertNoCredentialsPresent` and
    // `assertLiveTradingDisabled` throw `SecurityError` / `LiveTradingDisabledError`
    // when an operator has put a forbidden variable in the environment. Swallowing
    // that into "no configuration" would hide a misconfigured deployment behind a
    // healthy-looking 200. It is surfaced as `refused` instead.
    const refused = err?.name === 'SecurityError' || err?.name === 'LiveTradingDisabledError';
    return { config: null, error: { refused, name: err?.name ?? 'Error' } };
  }
}

// -------------------------------------------------------------- SNAPSHOT DB

/**
 * Open the operator-supplied snapshot database READ-ONLY.
 *
 * Returns a tagged result rather than throwing, because every failure mode
 * here is an expected condition in a serverless environment, not an exception.
 * Reasons are machine-readable codes; no filesystem path is ever placed in a
 * reason, so nothing about the host layout can be inferred from a response.
 */
function openSnapshot(env) {
  const configured = env[SNAPSHOT_ENV_VAR];
  if (typeof configured !== 'string' || configured.trim() === '') {
    return { ok: false, reason: 'snapshot_not_configured' };
  }

  // Absolute paths are the normal case on Vercel (`/var/task/...`); relative
  // paths are resolved against the project root rather than `process.cwd()` for
  // the same reason `CONFIG_PATH` is.
  const raw = configured.trim();
  const path = isAbsolute(raw) ? raw : resolve(ROOT, raw);

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, reason: 'snapshot_not_found' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'snapshot_not_a_file' };

  let db;
  try {
    db = openDatabase(path, { readonly: true });
  } catch {
    return { ok: false, reason: 'snapshot_not_openable' };
  }

  // A read-only connection cannot create tables, so an un-migrated file throws
  // here instead of quietly yielding zero rows. That is the behaviour we want:
  // "no schema" must not be reported as "no data".
  try {
    migrate(db, systemClock);
  } catch {
    try { db.close(); } catch { /* already unusable */ }
    return { ok: false, reason: 'snapshot_has_no_schema' };
  }

  return { ok: true, db };
}

// ------------------------------------------------------------------ STATE

function build() {
  const { config, error: configError } = loadDeploymentConfig();

  if (configError?.refused) {
    // Refuse loudly rather than serve a degraded 200. The message names the
    // offending class of variable, never its value.
    return {
      dataState: DATA_STATE.REFUSED,
      config: null,
      view: null,
      refuse: {
        reason: 'forbidden_environment_variable',
        detail: configError.name === 'SecurityError'
          ? 'This deployment refuses to serve while a credential variable is present. '
            + 'Vercel is a read-only layer and must hold no credentials.'
          : 'This deployment refuses to serve while live trading is enabled in the environment.',
      },
    };
  }

  const base = {
    config,
    configAvailable: Boolean(config),
    ...(configError ? { configError: { name: configError.name } } : {}),
  };

  const opened = openSnapshot(process.env);

  if (!opened.ok) {
    return {
      ...base,
      dataState: config
        ? DATA_STATE.NO_DATABASE
        : DATA_STATE.NO_CONFIG,
      view: null,
      // The distinction matters: `snapshot_not_configured` means the operator
      // never supplied one and the empty response is the intended design;
      // `snapshot_not_found` means they tried and it is missing.
      reason: opened.reason,
    };
  }

  const { db } = opened;
  const chain = new AuditChain(db);
  const repos = new Repos(db, chain, { mode: MODE, instanceId: 'vercel' });
  const view = { config, repos, chain, mode: MODE, scopeRunId: null };

  // The guard that makes the snapshot path incapable of fabricating money.
  // `accountSection` substitutes `config.account.startingCapitalEgp` when no
  // balance row is found. On a database that is momentarily locked that is the
  // right answer; on a database that holds no PAPER account it would render
  // "EGP 500" as a measured balance. So the row's existence is checked here
  // rather than discovered in the response.
  if (!repos.latestBalance(MODE)) {
    try { db.close(); } catch { /* nothing to salvage */ }
    return {
      ...base,
      dataState: DATA_STATE.NO_DATABASE,
      view: null,
      reason: 'snapshot_has_no_paper_balance_row',
    };
  }

  return { ...base, dataState: DATA_STATE.SNAPSHOT, view, db, chain, repos };
}

/** The per-container state. Built once; safe to call on every request. */
export function state() {
  if (CACHE === null) CACHE = build();
  return CACHE;
}

/** Test seam. Clears the cache so a test can install a different environment. */
export function resetStateCache() {
  if (CACHE?.db) { try { CACHE.db.close(); } catch { /* already closed */ } }
  CACHE = null;
}

// ------------------------------------------------------------- PROJECTIONS

/**
 * The snapshot payload for whichever state this deployment is in.
 *
 * On the snapshot path the production projector runs and its output is
 * re-wrapped with the deployment markers. Re-applying `redact()` after the
 * merge is deliberate: the markers are constants today, but a redaction pass
 * that is applied before new fields are added is not a redaction pass.
 */
export function snapshotPayload(params = new URLSearchParams()) {
  const s = state();

  if (s.view === null) {
    return {
      status: s.refuse ? 503 : 200,
      body: emptySnapshot({ config: s.config, dataState: s.dataState, reason: s.reason ?? s.refuse?.detail }),
    };
  }

  const projected = projectSnapshot(s.view, params);
  return {
    status: 200,
    body: redact({
      ...projected,
      dataState: s.dataState,
      noDataMessage: null,
      reason: null,
      deployment: { ...DEPLOYMENT, ...TRUTH },
    }),
  };
}

/** A single section. Unknown names return null so the router can answer 404. */
export function sectionPayload(name, params = new URLSearchParams()) {
  const s = state();

  if (s.view === null) {
    return {
      status: s.refuse ? 503 : 200,
      body: emptySection(s.config, name, s.dataState, s.reason ?? s.refuse?.detail),
    };
  }

  const projected = projectSection(s.view, name, params);
  if (projected === null) return { status: 404, body: null };
  return { status: 200, body: redact(projected) };
}

/** True when a snapshot database is actually behind this response. */
export function hasSnapshot() {
  return state().view !== null;
}

export { DATA_STATE, ROOT as PROJECT_ROOT, CONFIG_PATH };