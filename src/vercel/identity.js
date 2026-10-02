/**
 * TEOS Trade Agent - vercel/identity.js
 *
 * What this deployment IS, stated in one place so `/api/healthz` and
 * `/api/snapshot` cannot drift apart.
 *
 * The single most important value here is `mode: 'PAPER'`. It is a literal,
 * not a read from `config/default.json`, because this module must be able to
 * answer even when no configuration file and no database are readable. A
 * deployment that cannot load its config must still be able to say "PAPER",
 * because "PAPER" is the only mode it is ever permitted to claim.
 *
 * `role` is the second most important value. A reader of this API has no other
 * way to tell a presentation layer from a trading system, and a response that
 * omitted it would let a well-designed page imply that a trading worker is
 * running behind it. There is no worker behind it. That is the whole point.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** Read `version` from package.json. Falls back to 'unknown', never throws. */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const SERVICE = 'teos-trade-agent';

/**
 * The deployment contract. Every field is a fixed fact about this code, not a
 * runtime measurement, so it is exported as a frozen object and can be asserted
 * against in tests.
 */
export const DEPLOYMENT = Object.freeze({
  service: SERVICE,
  version: readVersion(),
  /** Always PAPER. Not configurable, not derived, not overridable by env. */
  mode: 'PAPER',
  /** The Node.js runtime this function executes on. */
  runtime: 'nodejs',
  /** What this deployment is allowed to be called. */
  role: 'read-only-presentation-layer',
  /** The layer that actually holds state, and where it runs. */
  stateOwner: 'local-worker',
  /** Explicit: no long-lived process is started here. */
  startsWorker: false,
  /** Explicit: there is no order-placement surface on this deployment. */
  canPlaceOrders: false,
  liveTrading: 'not implemented; no live execution adapter exists in this repository',
  withdrawals: 'not implemented; no withdrawal code exists in this repository',
  leverage: 'impossible by construction: long-only, cash-funded, cash can never go negative',
  currency: 'EGP',
});

/** One sentence a human can read without the source. */
export const TRUTH = Object.freeze({
  workerRunsLocally: true,
  vercelStartsAWorker: false,
  vercelProvidesPersistentSqlite: false,
  vercelHasPersistentDatabase: false,
  statement:
    'The trading worker runs on a local machine and writes a local SQLite file. '
    + 'This Vercel deployment is a read-only presentation layer: it starts no worker, '
    + 'holds no persistent database, and cannot place, modify or cancel an order.',
});