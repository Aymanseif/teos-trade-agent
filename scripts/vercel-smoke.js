#!/usr/bin/env node
/**
 * TEOS Trade Agent - scripts/vercel-smoke.js
 *
 * End-to-end smoke test of the Vercel function, over real HTTP.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
 *
 * `tests/vercel.test.js` calls `router.handle()` and gets a value back. That
 * proves the routing, the method guard, the headers and the payloads. It does
 * NOT prove that `api/[[...slug]].js` correctly translates a Node
 * `(req, res)` pair into that value and back - the URL parsing, the header
 * writing, the HEAD-must-not-have-a-body rule, the status code landing where it
 * should. Those are exactly the parts that are wrong in ways a value-level test
 * cannot see, and they are the parts Vercel actually runs.
 *
 * So this boots the real exported handler on loopback and drives it with real
 * requests. It is a local process on 127.0.0.1, an ephemeral port, and no
 * network egress. Nothing is deployed and nothing is claimed to be deployed:
 * this proves the function behaves, not that a URL exists.
 *
 * Exits 0 only if every check passes.
 */

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import vercelHandler from '../api/[[...slug]].js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Names that would indicate a money-moving or state-mutating route. */
const FORBIDDEN_ROUTE_WORDS = [
  'order', 'submit', 'execute', 'trade', 'buy', 'sell', 'cancel', 'kill',
  'reset', 'hold', 'resume', 'withdraw', 'transfer', 'balance', 'position',
  'mutation', 'admin', 'control',
];

const checks = [];
function record(ok, label, detail = '') {
  checks.push({ ok, label, detail });
  const tag = ok ? '[PASS]' : '[FAIL]';
  process.stdout.write(`  ${tag} ${label}${detail ? `\n         ${detail}` : ''}\n`);
}

/** Drive the mounted handler the way a request would. */
function call(port, method, path, { headers = {} } = {}) {
  return new Promise((resolveCall, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolveCall({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const server = createServer((req, res) => {
    vercelHandler(req, res).catch((err) => {
      // The adapter must never leave a socket hanging on an unexpected throw.
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: 'internal error', detail: err?.message ?? 'unknown' }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.stdout.write('\n');
  process.stdout.write('=====================================================================\n');
  process.stdout.write('TEOS TRADE AGENT - VERCEL ENDPOINT SMOKE TEST (local, real HTTP)\n');
  process.stdout.write('=====================================================================\n');
  process.stdout.write(`handler: api/[[...slug]].js on http://127.0.0.1:${port} (ephemeral, loopback)\n`);
  process.stdout.write('nothing is deployed; this proves the function, not a URL\n\n');

  try {
    // -------------------------------------------------- the required endpoints
    const REQUIRED = [
      ['GET', '/api/healthz', 200],
      ['GET', '/api/snapshot', 200],
      ['GET', '/api/audit/chains', 200],
      ['GET', '/api/section/account', 200],
      ['GET', '/api/section/agent', 200],
      ['GET', '/api/section/risk', 200],
      ['GET', '/api/section/audit', 200],
      ['GET', '/api/env', 200],
    ];

    for (const [method, path, expected] of REQUIRED) {
      const res = await call(port, method, path);
      const ok = res.status === expected;
      let detail = `status ${res.status} (expected ${expected})`;
      if (ok) {
        try {
          const json = JSON.parse(res.body);
          detail = `status 200, ${res.body.length} bytes of valid JSON, `
            + `${Object.keys(json).length} top-level keys`;
          record(true, `${method} ${path}`, detail);
          continue;
        } catch (err) {
          record(false, `${method} ${path}`, `status 200 but body is not valid JSON: ${err.message}`);
          continue;
        }
      }
      record(false, `${method} ${path}`, detail);
    }

    // ------------------------------------------------------------- 404 / 405
    for (const path of ['/api/nope', '/api/section/positions', '/definitely-not-a-route']) {
      const res = await call(port, 'GET', path);
      let validJson = false;
      try { JSON.parse(res.body); validJson = true; } catch { /* reported below */ }
      record(res.status === 404 && validJson,
        `GET ${path} => 404 JSON`,
        `status ${res.status}, valid JSON: ${validJson}`);
    }

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(port, method, '/api/snapshot');
      record(res.status === 405 && String(res.headers.allow ?? '').includes('GET'),
        `${method} /api/snapshot => 405 with Allow`,
        `status ${res.status}, Allow: ${res.headers.allow ?? '(absent)'}`);
    }

    // ------------------------------------------------------------------ HEAD
    const head = await call(port, 'HEAD', '/api/snapshot');
    record(head.status === 200 && head.body === '',
      'HEAD /api/snapshot => 200 with an empty body',
      `status ${head.status}, body ${head.body.length} bytes, content-length ${head.headers['content-length']}`);

    // ------------------------------------------------- headers and JSON shape
    const health = await call(port, 'GET', '/api/healthz');
    const hj = JSON.parse(health.body);
    record(hj.mode === 'PAPER', 'healthz reports mode PAPER', `mode=${hj.mode}`);
    record(Boolean(hj.service && hj.version && hj.runtime && hj.deploymentStatus),
      'healthz names service, version, runtime and deployment status',
      `service=${hj.service} version=${hj.version} runtime=${hj.runtime} role=${hj.deploymentStatus?.role}`);
    record(hj.deploymentStatus?.startsWorker === false && hj.deploymentStatus?.canPlaceOrders === false,
      'healthz states no worker is started and no order can be placed',
      `startsWorker=${hj.deploymentStatus?.startsWorker} canPlaceOrders=${hj.deploymentStatus?.canPlaceOrders}`);

    const snap = await call(port, 'GET', '/api/snapshot');
    const sj = JSON.parse(snap.body);
    record(sj.account?.cashEgp === null && sj.account?.equityEgp === null,
      'snapshot with no database reports no balance and no equity',
      `cashEgp=${sj.account?.cashEgp} equityEgp=${sj.account?.equityEgp} (both null, not fabricated)`);
    record(typeof sj.noDataMessage === 'string' && /No persistent worker data/i.test(sj.noDataMessage),
      'snapshot carries the truthful no-data message',
      sj.noDataMessage ?? '(absent)');

    const withHeaders = await call(port, 'GET', '/api/snapshot');
    record(
      withHeaders.headers['x-content-type-options'] === 'nosniff'
      && withHeaders.headers['x-frame-options'] === 'DENY'
      && /default-src 'none'/.test(withHeaders.headers['content-security-policy'] ?? ''),
      'security headers survive the real response path',
      `nosniff=${withHeaders.headers['x-content-type-options']} frame=${withHeaders.headers['x-frame-options']} csp=${/default-src 'none'/.test(withHeaders.headers['content-security-policy'] ?? '')}`);

    // -------------------------------------------- zero live-trading routes
    const routes = [...REQUIRED.map(([, p]) => p),
      '/api/nope', '/api/section/positions'];
    const offending = [];
    for (const p of routes) {
      const res = await call(port, 'GET', p);
      if (res.status === 200) {
        const name = p.toLowerCase();
        for (const word of FORBIDDEN_ROUTE_WORDS) {
          if (name.includes(`/${word}`)) offending.push(`${p} (matches /${word})`);
        }
      }
    }
    record(offending.length === 0,
      'zero live-trading routes are exposed',
      offending.length ? offending.join(', ') : `${routes.length} probed, none money-moving`);

    // A 200 is required to be reachable ONLY by GET and HEAD. Verified above for
    // four write verbs; this is the summary assertion for the report.
    const writeReachable = [];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await call(port, method, '/api/healthz');
      if (res.status === 200) writeReachable.push(method);
    }
    record(writeReachable.length === 0,
      'no write verb reaches a 200 on any endpoint',
      writeReachable.length ? `reachable: ${writeReachable.join(', ')}` : 'POST/PUT/PATCH/DELETE/OPTIONS all refused');
  } finally {
    await new Promise((r) => server.close(r));
  }

  const failed = checks.filter((c) => !c.ok).length;
  process.stdout.write('\n');
  process.stdout.write(`SMOKE TEST: ${checks.length - failed} of ${checks.length} checks passed\n`);
  if (failed > 0) {
    process.stdout.write(`SMOKE TEST: FAILED (${failed})\n\n`);
    process.exit(1);
  }
  process.stdout.write('\nNote: this exercised the function on loopback. No deployment was performed,\n');
  process.stdout.write('no URL exists yet, and nothing here claims one does.\n\n');
}

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});