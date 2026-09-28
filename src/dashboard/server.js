/**
 * TEOS Trade Agent - dashboard/server.js
 *
 * A read-only HTTP server on the loopback interface. No framework, no CDN, no
 * external asset of any kind: the page is three static files served from this
 * repository and JSON produced by `dashboard/api.js`.
 *
 * The four safety properties, and how each is enforced rather than promised:
 *
 *  1. LOOPBACK ONLY. The bind host is checked against a loopback allow-list
 *     before `listen()` and the bound address is re-checked afterwards. Binding
 *     0.0.0.0 would put an unauthenticated read of the account on the LAN.
 *  2. READ-ONLY. The database is opened with `readOnly: true`, so SQLite itself
 *     rejects a write. Independently, only GET and HEAD are routed; every other
 *     method gets 405. There is no POST handler to enable.
 *  3. NO AUTH, THEREFORE NO SURFACE. Phase 1 forbids credentials
 *     (`core/env.js` throws if a token variable is set), so the dashboard has
 *     no auth code. That is only acceptable because of property 1: a
 *     loopback-only, read-only listener is not reachable from the network.
 *  4. NO PATH TRAVERSAL. Static files are resolved from a fixed allow-list of
 *     three names. No request-supplied string is ever joined to a filesystem
 *     path, so `../../.env` is not a request that can be made, only a string
 *     that fails to match.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { AuditChain } from '../database/audit-chain.js';
import { Repos } from '../database/repositories/index.js';
import { systemClock } from '../core/clock.js';
import { createLogger } from '../core/logger.js';
import { describeEnv, redact } from '../core/env.js';
import { makeView, snapshot, section, SECTIONS, AUDIT_STREAMS } from './api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

/** Hosts the dashboard is permitted to bind. Anything else is a hard error. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost', '[::1]']);

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  if (h === '::1' || h === '[::1]' || h === '0:0:0:0:0:0:0:1') return true;
  // Any 127.0.0.0/8 address is loopback. 0.0.0.0 is NOT: it is "every
  // interface", which is the mistake this check exists to catch.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Static assets. An allow-list, not a filter. Anything not named here is a 404,
 * and no request value is ever concatenated into a path.
 */
const STATIC_FILES = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
});

const MAX_URL_LENGTH = 2048;

export class DashboardServer {
  #server;
  #db;
  #chain;
  #repos;
  #view;
  #staticCache = new Map();
  #host;
  #port;

  /**
   * @param config  loaded, frozen config (from `loadConfig`)
   * @param opts.mode    which isolated database to read
   * @param opts.host    override the bind host (tests use port 0)
   * @param opts.port    override the bind port (0 = ephemeral)
   */
  constructor(config, { mode = 'PAPER', host = null, port = null, logger = null } = {}) {
    if (config.dashboard.allowNonLoopbackBind !== false) {
      throw new Error('Refusing to start: dashboard.allowNonLoopbackBind is not false.');
    }
    this.#host = host ?? config.dashboard.host;
    this.#port = port ?? config.dashboard.port;
    if (!isLoopbackHost(this.#host)) {
      throw new Error(
        `Refusing to bind the dashboard to "${this.#host}". Loopback only in Phase 1; `
        + 'set dashboard.host to 127.0.0.1.',
      );
    }
    this.mode = mode;
    this.config = config;
    this.logger = logger ?? createLogger({ name: 'dashboard', logDir: config.paths.logDir });

    this.#db = openDatabase(config.paths.dbFile, { readonly: true });
    // A read-only connection cannot run the migration, so a fresh checkout shows
    // "no schema" rather than an exception. Reporting that honestly is better
    // than a 500 on every poll.
    this.migrated = false;
    try {
      migrate(this.#db, systemClock);
      this.migrated = true;
    } catch {
      this.migrated = false;
    }
    this.#chain = new AuditChain(this.#db);
    this.#repos = new Repos(this.#db, this.#chain, { mode, instanceId: 'dashboard' });
    this.#view = makeView({ config, repos: this.#repos, chain: this.#chain, mode });
  }

  get host() { return this.#host; }
  get port() { return this.#port; }
  get address() {
    const a = this.#server?.address();
    return a && typeof a === 'object' ? a : null;
  }

  async listen() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    // Slow clients must not be able to hold a socket open forever.
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = 15_000;

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.#server.once('error', onError);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.removeListener('error', onError);
        resolve();
      });
    });

    // Re-check what was actually bound. Passing a loopback host to `listen()` is
    // the normal path; this catches the case where a future refactor binds via
    // an options object that was built somewhere else.
    const addr = this.address;
    if (addr && addr.address && !isLoopbackHost(addr.address)) {
      this.close();
      throw new Error(`Refusing to serve: the socket bound to non-loopback address ${addr.address}.`);
    }
    return this.address;
  }

  close() {
    if (this.#server?.listening) this.#server.close();
    this.#server = undefined;
    this.#db?.close();
    this.#db = undefined;
  }

  // ------------------------------------------------------------- routing

  async #handle(req, res) {
    try {
      const url = new URL(req.url, `http://${this.#host}`);
      const path = url.pathname;

      if ((req.url ?? '').length > MAX_URL_LENGTH) {
        return this.#json(res, 414, { error: 'URL too long' });
      }
      // Read-only. Enforced here and by the read-only SQLite connection; two
      // independent mechanisms so that neither a routing bug nor a config
      // change can turn this into a write path.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return this.#json(res, 405, {
          error: 'The dashboard is read-only.',
          detail: 'This server exposes no write operation. Control the agent from the CLI: '
            + '`node src/cli.js hold`, `kill-switch`, `reset-stop`.',
        });
      }

      if (path === '/healthz') return this.#json(res, 200, this.#health());
      if (path === '/api/snapshot') return this.#json(res, 200, snapshot(this.#view, url.searchParams));
      if (path === '/api/env') return this.#json(res, 200, { env: describeEnv() });
      if (path.startsWith('/api/section/')) {
        const name = path.slice('/api/section/'.length);
        if (!SECTIONS.includes(name)) {
          return this.#json(res, 404, { error: `unknown section "${name}"`, sections: SECTIONS });
        }
        return this.#json(res, 200, section(this.#view, name, url.searchParams));
      }
      if (path === '/api/audit/chains') {
        return this.#json(res, 200, {
          chains: AUDIT_STREAMS.map((stream) => {
            const v = this.#chain.verify(stream, this.mode);
            return { stream, ok: v.ok, records: v.checked, hashedColumns: v.columns, reason: v.reason };
          }),
        });
      }

      return this.#static(res, path);
    } catch (err) {
      // An error page must never contain a stack: a future edit could put
      // something sensitive in a message, and the dashboard is a network surface.
      this.logger.error('dashboard request failed', { message: err.message });
      return this.#json(res, 500, { error: 'internal error', detail: redact(err.message) });
    }
  }

  #health() {
    const balance = this.#repos.latestBalance(this.mode);
    const stop = this.#repos.sessionStop(this.mode);
    return {
      status: this.migrated ? 'ok' : 'no_schema',
      mode: this.mode,
      readOnly: true,
      loopbackOnly: true,
      auth: 'none (loopback-only by design; see SECURITY.md)',
      emergencyStopEngaged: Boolean(stop),
      equityEgp: balance?.equity_egp ?? null,
      auditStreams: AUDIT_STREAMS,
    };
  }

  #json(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      // Defence in depth for a page that will render data it fetched itself.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  #static(res, path) {
    const entry = STATIC_FILES[path];
    if (!entry) return this.#json(res, 404, { error: 'not found' });
    const file = join(PUBLIC_DIR, entry.file);
    // `entry.file` is a constant from STATIC_FILES, never request input; this is
    // belt-and-braces against PUBLIC_DIR itself being repointed somewhere odd.
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
      return this.#json(res, 500, { error: 'static asset missing', file: entry.file });
    }
    if (!this.#staticCache.has(entry.file)) {
      this.#staticCache.set(entry.file, readFileSync(file));
    }
    const body = this.#staticCache.get(entry.file);
    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // No inline script, no remote origin. The page loads exactly two local
      // files and talks only to this server.
      'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'",
    });
    res.end(body);
  }
}

export { SECTIONS, AUDIT_STREAMS };
