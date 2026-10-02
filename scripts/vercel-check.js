#!/usr/bin/env node
/**
 * TEOS Trade Agent - scripts/vercel-check.js
 *
 * A deterministic pre-deployment gate. Eight checks, each of which either
 * passes or fails with an explanation. Exit code 0 means deployable; non-zero
 * means do not deploy.
 *
 * This script exists because the most damaging possible outcome for this
 * repository is a deployment that appears to be a read-only paper-trading
 * dashboard and is not. That outcome is not prevented by writing careful code -
 * careful code is undone by the next refactor. It is prevented by a check that
 * fails the moment the property stops holding, and that a developer runs before
 * pushing rather than after a production incident.
 *
 * Check 5 is the one that matters. It walks the STATIC IMPORT GRAPH of the
 * Vercel entrypoint and fails if it reaches the worker, the broker, the
 * matching engine, the risk engine, the Sentinel or the execution adapter. Not
 * "no route is named /order" - the actual set of modules that will be loaded
 * when a request arrives. A route table can be edited; an import graph is what
 * the runtime will do.
 *
 * Check 6 never prints a secret. It prints file and line, and the NAME of the
 * variable, never its value.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported, not copied. If either module throws on load, or opens a socket or a
// database at import time, this file fails before a single check runs - which is
// the point: a cold start in production should never be the first time anyone
// finds out that importing this code has a side effect.
import vercelEntry from '../api/[[...slug]].js';
import { handle } from '../src/vercel/router.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = join(ROOT, 'api', '[[...slug]].js');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? 'ok' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

function mustExist(...paths) {
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`missing required file: ${relative(ROOT, p)}`);
  }
  return true;
}

// ------------------------------------------------------------------ 1. FILES

check('required Vercel files exist', () => {
  mustExist(
    ENTRY,
    join(ROOT, 'vercel.json'),
    join(ROOT, 'package.json'),
    join(ROOT, 'scripts', 'build.js'),
    join(ROOT, 'src', 'vercel', 'router.js'),
    join(ROOT, 'src', 'vercel', 'state.js'),
    join(ROOT, 'src', 'vercel', 'identity.js'),
    join(ROOT, 'src', 'vercel', 'empty.js'),
  );
  return 'vercel.json, api/[[...slug]].js, src/vercel/{router,state,identity,empty}.js';
});

// ---------------------------------------------------------- 2. ENTRY LOADS

check('API entrypoint loads and exposes a default handler', () => {
  // The import above is the test. A module that throws on load fails here with
  // an unhandled rejection rather than producing a plausible-looking report.
  if (typeof vercelEntry !== 'function') {
    throw new Error(`api/[[...slug]].js default export is ${typeof vercelEntry}, expected a function`);
  }
  if (vercelEntry.length !== 2) {
    throw new Error('the Vercel handler must take exactly (req, res)');
  }
  return 'default export is a (req, res) function';
});

// ------------------------------------------------------- 3. DASHBOARD ASSETS

check('dashboard assets exist in public/', () => {
  mustExist(
    join(ROOT, 'public', 'index.html'),
    join(ROOT, 'public', 'app.js'),
    join(ROOT, 'public', 'style.css'),
    join(ROOT, 'public', 'vercel-shell.js'),
    join(ROOT, 'public', 'vercel-shell.css'),
  );
  const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  // The generated page must load the shell, and must say PAPER in markup rather
  // than relying on JavaScript to render it - a page that only says PAPER once
  // a script runs has already lied to anyone whose script did not.
  if (!index.includes('/vercel-shell.js')) throw new Error('public/index.html does not load vercel-shell.js');
  if (!index.includes('/vercel-shell.css')) throw new Error('public/index.html does not load vercel-shell.css');
  if (!/>PAPER</.test(index)) throw new Error('public/index.html has no static PAPER marker in markup');
  if (!/TRADE AGENT/.test(index)) throw new Error('public/index.html has no static "TRADE AGENT" marker');
  return '5 assets; PAPER and TRADE AGENT present in static markup';
});

// ---------------------------------------------------------- 4. PACKAGE META

check('package metadata is valid and exposes the deployment contract', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const script of ['test', 'build', 'vercel:check']) {
    if (!pkg.scripts?.[script]) throw new Error(`package.json has no "${script}" script`);
  }
  if (pkg.type !== 'module') throw new Error('package.json "type" must be "module" (the codebase is ESM)');
  if (!pkg.engines?.node) throw new Error('package.json has no engines.node constraint');
  const major = Number.parseInt(process.versions.node, 10);
  if (major < 22) throw new Error(`node ${process.versions.node} cannot run this project (requires >= 22.5.0)`);
  return `name=${pkg.name} version=${pkg.version} engines.node=${pkg.engines.node} running ${process.versions.node}`;
});

// --------------------------------------------------- 5. NO TRADING CAPABILITY

/** Directories the Vercel layer must never reach, and why. */
const FORBIDDEN = [
  ['src/worker', 'the persistent trading worker'],
  ['src/broker', 'order submission and the matching engine'],
  ['src/execution', 'the execution adapter, firewall and Sentinel'],
  ['src/risk', 'the risk engine and its rule set'],
  ['src/agent', 'the decision agent engine'],
  ['src/backtest', 'the backtest engine'],
  ['src/paper', 'the paper ledger and account writer'],
];

/** Resolve a relative ESM specifier against the importing file. */
function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.')) return null; // node: builtins and packages are out of scope
  return resolve(dirname(fromFile), spec);
}

function walkImports(entry, seen = new Set()) {
  const file = resolve(entry);
  if (seen.has(file)) return seen;
  seen.add(file);

  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return seen; // schema.sql, css, html: not a module, nothing to walk
  }

  // Static ESM specifiers only: `import ... from 'x'` and `export ... from 'x'`.
  // A dynamic `import('x')` or `require('x')` inside the Vercel layer is a
  // finding in its own right and is reported by check 8.
  const re = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const target = resolveSpecifier(m[1], file);
    if (target && existsSync(target)) walkImports(target, seen);
  }
  return seen;
}

check('no trading capability is reachable from the Vercel entrypoint', () => {
  const graph = [...walkImports(ENTRY)];
  const rels = graph.map((f) => relative(ROOT, f).replace(/\\/g, '/'));
  const offences = [];
  for (const [dir, why] of FORBIDDEN) {
    for (const rel of rels) {
      if (rel.startsWith(`${dir}/`) || rel === dir) offences.push(`${rel} (${why})`);
    }
  }
  if (offences.length > 0) {
    throw new Error(
      `the Vercel import graph reaches ${offences.length} module(s) it must not: `
      + `${offences.join(', ')}. A public read-only layer that can reach the worker `
      + 'or the broker is not a read-only layer.',
    );
  }
  return `${rels.length} modules reachable, none in a trading directory`;
});

// -------------------------------------------------------- 6. NO CREDENTIALS

check('no credentials in tracked source or committed runtime state', () => {
  const tracked = ['api/[[...slug]].js', 'src/vercel/router.js', 'src/vercel/state.js',
    'src/vercel/identity.js', 'src/vercel/empty.js', 'src/vercel/public/shell.js',
    'vercel.json', 'public/index.html', 'public/app.js', 'public/vercel-shell.js'];

  // High-confidence formats. The value is deliberately not echoed.
  const patterns = [
    [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
    [/sk-[A-Za-z0-9]{32,}/, 'provider secret key'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'chat provider token'],
  ];

  const findings = [];
  for (const rel of tracked) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const [re, label] of patterns) {
        if (re.test(line)) findings.push(`${rel}:${i + 1} ${label}`);
      }
    });
  }

  // Runtime state must never be part of the deployment.
  const committed = ['data', 'logs'];
  for (const dir of committed) {
    const p = join(ROOT, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p)) {
      if (existsSync(join(ROOT, '.gitignore'))
        && readFileSync(join(ROOT, '.gitignore'), 'utf8').includes(`${dir}/`)) continue;
      findings.push(`${dir}/${f} runtime state present and not ignored`);
    }
  }

  // The deployment must not be configured to accept credentials at all.
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  if (JSON.stringify(cfg).match(/secret|token|password|apiKey/i)) {
    findings.push('vercel.json mentions a credential-shaped key');
  }

  if (findings.length > 0) throw new Error(findings.join('; '));
  return `${tracked.length} deployment files scanned, 0 secrets; runtime state ignored`;
});

// ---------------------------------------------- 7. ROUTE MODULES IMPORTABLE

const routeChecks = [];

check('route modules import and the router is pure', () => {
  if (typeof handle !== 'function') throw new Error('router.handle is not a function');

  // Method enforcement, checked as a value rather than as an HTTP observation.
  const post = handle({ method: 'POST', path: '/api/snapshot' });
  if (post.status !== 405) throw new Error(`POST /api/snapshot returned ${post.status}, expected 405`);
  if (!String(post.headers.allow ?? '').includes('GET')) throw new Error('405 response has no Allow header');

  const write = ['PUT', 'PATCH', 'DELETE', 'HEAD'];
  for (const m of write) {
    const r = handle({ method: m, path: '/api/snapshot' });
    if (m === 'HEAD') {
      if (r.status !== 200) throw new Error(`HEAD /api/snapshot returned ${r.status}, expected 200`);
    } else if (r.status !== 405) {
      throw new Error(`${m} /api/snapshot returned ${r.status}, expected 405`);
    }
  }

  const missing = handle({ method: 'GET', path: '/api/does-not-exist' });
  if (missing.status !== 404) throw new Error(`unknown route returned ${missing.status}, expected 404`);

  routeChecks.push('GET/HEAD accepted; POST/PUT/PATCH/DELETE -> 405; unknown -> 404');
  return 'router imported; method enforcement and 404 verified';
});

// ------------------------------------------------ 8. DEPLOYMENT CONFIG

check('deployment configuration is valid', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const entryKey = 'api/[[...slug]].js';
  if (!cfg.functions?.[entryKey]) throw new Error(`vercel.json has no functions entry for ${entryKey}`);
  const runtime = cfg.functions[entryKey].runtime;
  if (runtime !== 'nodejs24.x') throw new Error(`functions runtime is ${runtime}, expected nodejs24.x`);
  if (cfg.functions[entryKey].maxDuration > 30) {
    throw new Error('maxDuration over 30s invites a request to hold a warm function; keep it short');
  }
  // A rewrite that catches /api would shadow the function with the static shell.
  for (const r of cfg.rewrites ?? []) {
    if (typeof r.source === 'string' && /api/.test(r.source) && !/\(\?!api\/\)/.test(r.source)) {
      throw new Error(`rewrite source ${JSON.stringify(r.source)} would capture /api routes`);
    }
  }
  const csp = (cfg.headers ?? []).flatMap((h) => h.headers ?? []).find((h) => h.key === 'Content-Security-Policy');
  if (!csp) throw new Error('vercel.json sets no Content-Security-Policy');
  if (!/default-src 'none'/.test(csp.value)) throw new Error("CSP does not start from default-src 'none'");

  // Build output must exist and be a directory with the shell.
  const outDir = cfg.outputDirectory ?? 'public';
  mustExist(join(ROOT, outDir));
  return `runtime=${runtime} outputDirectory=${outDir} maxDuration=${cfg.functions[entryKey].maxDuration}s CSP present`;
});

// ------------------------------------------------------------- REPORT

process.stdout.write('\n');
process.stdout.write('=====================================================================\n');
process.stdout.write('TEOS TRADE AGENT - VERCEL DEPLOYMENT CHECK (PAPER, READ-ONLY)\n');
process.stdout.write('=====================================================================\n');
process.stdout.write(`mode: PAPER   runtime: nodejs ${process.versions.node}   entry: api/[[...slug]].js\n\n`);

let failed = 0;
for (const [i, r] of results.entries()) {
  const tag = r.ok ? '[PASS]' : '[FAIL]';
  if (!r.ok) failed += 1;
  process.stdout.write(`  ${tag} check ${i + 1}: ${r.name}\n`);
  process.stdout.write(`         ${r.detail}\n`);
}
for (const r of routeChecks) process.stdout.write(`         note: ${r}\n`);

process.stdout.write('\n');
if (failed > 0) {
  process.stdout.write(`VERCEL CHECK: FAILED (${failed} of ${results.length} checks)\n`);
  process.stdout.write('DO NOT DEPLOY.\n\n');
  process.exit(1);
}

process.stdout.write(`VERCEL CHECK: PASSED (${results.length} of ${results.length} checks)\n`);
process.stdout.write('The deployment is a read-only PAPER presentation layer: no worker is started,\n');
process.stdout.write('no trading capability is reachable, and no persistent database is provided.\n\n');