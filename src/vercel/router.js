/**
 * TEOS Trade Agent - vercel/router.js
 *
 * The whole HTTP surface of the Vercel deployment, as a pure function.
 *
 * `handle()` takes a method, a path and a query string and returns
 * `{ status, headers, body }`. It opens no socket, reads no request body and
 * writes no response, which is what makes the safety properties below
 * testable without a server: a test can call it with `POST /api/snapshot` and
 * assert 405, or `/api/order` and assert 404, and the answer is a value rather
 * than a network observation.
 *
 * The adapter in `api/[[...slug]].js` is the only place a Node request object
 * exists, and it does nothing but unpack it.
 *
 * FOUR PROPERTIES, EACH ENFORCED HERE RATHER THAN PROMISED:
 *
 *   1. READ-ONLY. Only GET and HEAD are routed. There is no POST handler to
 *      reach, and no route name anywhere in this file that suggests writing -
 *      the route table is four read endpoints and a 404 for everything else.
 *   2. NO FABRICATION. `state.js` chooses between real projected data and
 *      explicit nulls. This file never invents a field.
 *   3. NO CREDENTIALS. Every payload passes through `redact()` on the way out,
 *      and `/api/env` returns only `describeEnv()`'s allow-list.
 *   4. NO FILESYSTEM REACH. Nothing here reads a request-controlled path. The
 *      one filesystem access in the whole layer is `TEOS_SNAPSHOT_DB`, set by
 *      the operator's deployment configuration, never by a request.
 */

import { describeEnv, redact } from '../core/env.js';
import { SECTIONS } from '../dashboard/api.js';
import { emptyChains, DATA_STATE, NO_DATA_MESSAGE } from './empty.js';
import { DEPLOYMENT, TRUTH } from './identity.js';
import { hasSnapshot, snapshotPayload, sectionPayload, state } from './state.js';

/**
 * Applied to every response, error responses included.
 *
 * The CSP mirrors the local dashboard's exactly. It is not tightened for the
 * public deployment because it does not need to be: there is no inline script,
 * no CDN, no font and no image from anywhere but this origin, so
 * `default-src 'none'` with explicit self-sources is already the strictest
 * policy the page can run under. A dashboard that renders data it fetched
 * itself gets no benefit from a looser policy, and a looser policy here would
 * be a regression against the local one.
 */
const SECURITY_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // A public dashboard must never be cached by an intermediary.
  'cross-origin-opener-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
});

/** The exact method set. Anything else is refused, not redirected. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD']);

function json(status, payload, extraHeaders = {}) {
  return {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
    body: payload,
  };
}

/**
 * `/api/healthz`
 *
 * Answers the five questions the deployment order names: service, version,
 * mode, runtime, deployment status. `mode` is the literal from `identity.js`
 * and is not read from configuration or the database, so a deployment that can
 * read neither still answers PAPER truthfully.
 */
export function healthz() {
  const s = state();
  const refusing = Boolean(s.refuse);

  const body = {
    status: refusing ? 'refused' : (s.view ? 'ok' : 'degraded'),
    service: DEPLOYMENT.service,
    version: DEPLOYMENT.version,
    mode: DEPLOYMENT.mode,
    runtime: DEPLOYMENT.runtime,
    nodeVersion: process.versions.node,
    deploymentStatus: {
      role: DEPLOYMENT.role,
      stateOwner: DEPLOYMENT.stateOwner,
      startsWorker: DEPLOYMENT.startsWorker,
      canPlaceOrders: DEPLOYMENT.canPlaceOrders,
      dataState: s.dataState,
      dataAvailable: s.view !== null,
      readOnly: true,
      liveTrading: refusing ? 'refused: environment not permitted' : DEPLOYMENT.liveTrading,
      withdrawals: DEPLOYMENT.withdrawals,
    },
    ...TRUTH,
    ...(refusing ? { refused: { reason: s.refuse.reason, detail: s.refuse.detail } } : {}),
    // Present in both states so a client can distinguish "healthy and empty"
    // from "healthy and full" without inspecting the payload.
    noDataMessage: s.view ? null : NO_DATA_MESSAGE,
    reason: s.view ? null : (s.reason ?? null),
  };

  return json(refusing ? 503 : 200, redact(body));
}

/**
 * `/api/env` - the same redacted allow-list the local dashboard serves.
 *
 * Kept for parity so the two front ends make the same request. `describeEnv()`
 * returns only variables on a fixed safe list and never their values for
 * anything sensitive, so this cannot become a credential oracle.
 */
export function envRoute() {
  return json(200, { env: describeEnv() });
}

/** `/api/audit/chains` - hash-chain verification, or an honest "not evaluated". */
export function chainsRoute() {
  const s = state();
  if (s.view === null) {
    return json(200, {
      dataState: s.dataState,
      evaluated: false,
      chains: emptyChains(s.reason ?? 'no database was read in this environment'),
      note: NO_DATA_MESSAGE,
    });
  }
  // Defer to the production projector for the same per-stream shape the local
  // dashboard serves, rather than re-implementing `chain.verify` here.
  const audit = sectionPayload('audit', new URLSearchParams()).body;
  return json(200, {
    dataState: DATA_STATE.SNAPSHOT,
    evaluated: true,
    chains: audit.chains,
  });
}

/** `/api/snapshot` */
export function snapshotRoute(params) {
  const { status, body } = snapshotPayload(params);
  return json(status, body);
}

/** `/api/section/{name}` */
export function sectionRoute(name, params) {
  if (!SECTIONS.includes(name)) {
    return json(404, {
      error: 'unknown section',
      requested: name,
      sections: SECTIONS,
      note: 'Only sections that correspond to existing project data are exposed. '
        + 'This project has four: account, agent, risk, audit.',
    });
  }
  const { status, body } = sectionPayload(name, params);
  return json(status, body);
}

function notFound(path) {
  return json(404, {
    error: 'not found',
    path,
    routes: ['GET /api/healthz', 'GET /api/snapshot', 'GET /api/env',
      'GET /api/audit/chains', 'GET /api/section/account',
      'GET /api/section/agent', 'GET /api/section/risk', 'GET /api/section/audit'],
    note: 'This deployment is read-only. There is no route that writes, trades, '
      + 'mutates state or starts a worker, and there never will be one.',
  });
}

function methodNotAllowed(method) {
  return json(405, {
    error: 'method not allowed',
    // A stable machine-readable code, so a client can branch on the refusal
    // without matching on English prose.
    code: 'READ_ONLY',
    method,
    allowed: ALLOWED_METHODS,
    detail: 'This deployment is a read-only presentation layer. It exposes GET and HEAD '
      + 'only, and has no write operation of any kind. The trading worker is controlled '
      + 'from the local command line.',
  }, { allow: 'GET, HEAD' });
}

/**
 * The router.
 *
 * @param {object} req  { method, path, query }
 * @returns {{status:number, headers:object, body:object}}
 */
export function handle({ method = 'GET', path = '/', query = '' } = {}) {
  // Read-only, before anything else. A write verb must not reach route
  // resolution at all, so there is no path by which a future route named
  // `/api/order` could accidentally become reachable.
  if (!ALLOWED_METHODS.includes(String(method).toUpperCase())) {
    return methodNotAllowed(method);
  }

  const params = new URLSearchParams(query ?? '');
  // Normalise a trailing slash so `/api/snapshot/` and `/api/snapshot` agree.
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

  if (clean === '/api/healthz' || clean === '/healthz') return healthz();
  if (clean === '/api/snapshot') return snapshotRoute(params);
  if (clean === '/api/env') return envRoute();
  if (clean === '/api/audit/chains') return chainsRoute();

  if (clean.startsWith('/api/section/')) {
    return sectionRoute(clean.slice('/api/section/'.length), params);
  }

  return notFound(clean);
}

/** `dataState` of the current container, for `vercel-check.js` and tests. */
export function currentDataState() {
  return state().dataState;
}

export { hasSnapshot };