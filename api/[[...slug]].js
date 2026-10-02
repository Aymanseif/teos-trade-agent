/**
 * TEOS Trade Agent - api/[[...slug]].js
 *
 * The Vercel function. This file is deliberately the entire Vercel coupling in
 * the repository: it unpacks a Node request, calls the pure router, and writes
 * a response. No routing table, no business logic, no data access, and no
 * default route other than "404, JSON".
 *
 * WHY A CATCH-ALL RATHER THAN ONE FILE PER ENDPOINT
 *
 * File-based routing would give each endpoint its own module, and each of those
 * modules would then need the same method check, the same security headers and
 * the same error handling. Duplicating those four things across eight files is
 * how a deployment ends up with one endpoint that answers 405 and seven that
 * quietly accept POST. A single router means the read-only guarantee is
 * enforced in exactly one place, and it is enforced before any route is
 * resolved.
 *
 * WHY THIS FILE CANNOT TRADE
 *
 * It does not import the worker, the broker, the matching engine, the risk
 * engine or the Sentinel. Its entire import surface is `vercel/router.js`,
 * which in turn reaches only the read-only projections in `dashboard/api.js`.
 * `scripts/vercel-check.js` walks that import graph statically and fails the
 * build if a forbidden module appears in it, so the property is enforced by a
 * check rather than left to review.
 */

import { handle } from '../src/vercel/router.js';

/** Vercel's own routing has already normalised this; belt and braces. */
function normalise(url) {
  let pathname = '/';
  let query = '';
  try {
    const parsed = new URL(url ?? '/', 'http://localhost');
    pathname = parsed.pathname || '/';
    query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  } catch {
    // An unparseable URL is a 404, not a crash.
    return { path: '/__unparseable__', query: '' };
  }
  return { path: pathname, query };
}

export default async function handler(req, res) {
  const method = req?.method ?? 'GET';
  const { path, query } = normalise(req?.url);

  const result = handle({ method, path, query });

  for (const [key, value] of Object.entries(result.headers)) {
    try {
      res.setHeader(key, value);
    } catch {
      // A header the runtime rejects must not take the response down.
    }
  }

  const body = JSON.stringify(result.body, null, 2);
  res.setHeader('content-length', Buffer.byteLength(body));

  // HEAD must carry the same headers and status as GET, and no body.
  if (String(method).toUpperCase() === 'HEAD') {
    res.statusCode = result.status;
    res.end();
    return;
  }

  res.statusCode = result.status;
  res.end(body);
}