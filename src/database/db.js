/**
 * TEOS Trade Agent - database/db.js
 *
 * Thin, synchronous wrapper over node:sqlite. Synchronous is intentional: the
 * decision pipeline is a strict sequence (decision -> risk -> sentinel ->
 * execution -> audit) and must be atomic and deterministic. Throughput needs
 * are trivial at EGP-500 scale.
 *
 * Node's sqlite binding refuses to bind JS booleans, so `bind()` coerces them.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseError } from '../core/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(HERE, 'schema.sql');

/** Coerce JS values into something node:sqlite can bind. */
function bind(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'number' && !Number.isFinite(p)) return null;
    return p;
  });
}

function plain(row) {
  return row ? { ...row } : null;
}

export class Database {
  #db;
  #path;
  #txDepth = 0;
  #stmts = new Map();
  closed = false;

  constructor(path, { readonly = false } = {}) {
    this.#path = path;
    if (path !== ':memory:') {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (err) {
        throw new DatabaseError(`Cannot create database directory: ${err.message}`, { path });
      }
    }
    try {
      this.#db = new DatabaseSync(path, { readOnly: readonly });
    } catch (err) {
      throw new DatabaseError(`Cannot open database: ${err.message}`, { path });
    }
    this.#configure();
  }

  #configure() {
    const mem = this.#path === ':memory:';
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(`PRAGMA journal_mode = ${mem ? 'MEMORY' : 'WAL'};`);
    this.#db.exec('PRAGMA synchronous = FULL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
  }

  get path() { return this.#path; }
  get raw() { return this.#db; }

  exec(sql) {
    try {
      this.#db.exec(sql);
    } catch (err) {
      throw new DatabaseError(`exec failed: ${err.message}`, { sql: sql.slice(0, 200) });
    }
  }

  #prep(sql) {
    let s = this.#stmts.get(sql);
    if (!s) {
      try {
        s = this.#db.prepare(sql);
      } catch (err) {
        throw new DatabaseError(`prepare failed: ${err.message}`, { sql: sql.slice(0, 200) });
      }
      this.#stmts.set(sql, s);
    }
    return s;
  }

  run(sql, ...params) {
    try {
      return this.#prep(sql).run(...bind(params));
    } catch (err) {
      throw new DatabaseError(`run failed: ${err.message}`, { sql: sql.slice(0, 200), params: params.length });
    }
  }

  get(sql, ...params) {
    try {
      return plain(this.#prep(sql).get(...bind(params)));
    } catch (err) {
      throw new DatabaseError(`get failed: ${err.message}`, { sql: sql.slice(0, 200) });
    }
  }

  all(sql, ...params) {
    try {
      return this.#prep(sql).all(...bind(params)).map(plain);
    } catch (err) {
      throw new DatabaseError(`all failed: ${err.message}`, { sql: sql.slice(0, 200) });
    }
  }

  /** First column of the first row. */
  scalar(sql, ...params) {
    const row = this.get(sql, ...params);
    if (!row) return null;
    return row[Object.keys(row)[0]];
  }

  count(sql, ...params) {
    return this.scalar(sql, ...params) ?? 0;
  }

  /**
   * Transaction helper. Supports nesting via SAVEPOINT so a repository can be
   * composed into a larger transaction without knowing about it.
   */
  tx(fn) {
    const depth = this.#txDepth;
    const name = `sp_${depth}`;
    if (depth === 0) this.exec('BEGIN IMMEDIATE;');
    else this.exec(`SAVEPOINT ${name};`);
    this.#txDepth += 1;
    try {
      const out = fn();
      this.#txDepth -= 1;
      if (depth === 0) this.exec('COMMIT;');
      else this.exec(`RELEASE ${name};`);
      return out;
    } catch (err) {
      this.#txDepth -= 1;
      try {
        if (depth === 0) this.exec('ROLLBACK;');
        else this.exec(`ROLLBACK TO ${name}; RELEASE ${name};`);
      } catch { /* connection already unwound */ }
      throw err;
    }
  }

  get inTransaction() { return this.#txDepth > 0; }

  /** Read-only mode used by the dashboard: a second connection cannot write. */
  openReadOnly() {
    return new Database(this.#path, { readonly: true });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#stmts.clear();
    try { this.#db.close(); } catch { /* already closed */ }
  }
}

export function openDatabase(path, opts) {
  return new Database(path, opts);
}

export function applySchema(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
