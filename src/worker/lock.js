/**
 * TEOS Trade Agent - worker/lock.js
 *
 * Single-instance lock. A 24/7 agent must never run two decision loops against
 * the same database, because that would double every order.
 *
 * The lock is a file containing the owner PID, instance id and the last
 * heartbeat timestamp. It is refreshed on every tick. A lock whose heartbeat is
 * older than `staleAfterMs` is considered abandoned and may be reclaimed - this
 * is what makes the worker survive a hard kill (power loss, SIGKILL) without a
 * manual cleanup step.
 */

import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { LockHeldError } from '../core/errors.js';
import { newId } from '../core/ids.js';

export class WorkerLock {
  #path;
  #staleAfterMs;
  #owner = null;
  #held = false;

  constructor(path, { staleAfterMs = 30_000 } = {}) {
    this.#path = path;
    this.#staleAfterMs = staleAfterMs;
  }

  get held() { return this.#held; }
  get path() { return this.#path; }
  get owner() { return this.#owner; }

  #read() {
    if (!existsSync(this.#path)) return null;
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      return null; // corrupt lock = treat as absent, we will reclaim it
    }
  }

  /**
   * @returns {{ acquired:boolean, reclaimed:boolean, owner:object|null }}
   * @throws {LockHeldError} when a live lock is held by another instance
   */
  acquire(instanceId, nowMs) {
    const existing = this.#read();

    if (existing) {
      // A negative age means the lock was written by a clock ahead of ours
      // (or a previous process using an injected test clock). Treat that as
      // "unknown freshness" rather than "freshly locked", otherwise a stale
      // lock can never be reclaimed. `pidAlive` is the real authority on a
      // shared host.
      const age = nowMs - (existing.heartbeatMs ?? 0);
      const sameHost = existing.host === hostname();
      const fresh = age >= 0 && age <= this.#staleAfterMs;
      const alive = sameHost ? this.#pidAlive(existing.pid) : fresh;

      if (alive && existing.instanceId !== instanceId) {
        this.#owner = existing;
        throw new LockHeldError(
          `Worker lock is held by instance ${existing.instanceId} (pid ${existing.pid}, heartbeat ${age}ms ago). `
          + 'Two decision loops must never run against one database.',
          { path: this.#path, owner: existing, ageMs: age },
        );
      }
      if (alive && existing.instanceId === instanceId) {
        this.#owner = existing;
        this.#held = true;
        return { acquired: true, reclaimed: false, owner: existing };
      }
      // stale -> reclaim
    }

    const payload = {
      instanceId,
      pid: process.pid,
      host: hostname(),
      acquiredMs: nowMs,
      heartbeatMs: nowMs,
      version: 1,
    };
    const fd = openSync(this.#path, 'w');
    try {
      writeFileSync(fd, JSON.stringify(payload));
    } finally {
      closeSync(fd);
    }
    this.#owner = payload;
    this.#held = true;
    return { acquired: true, reclaimed: Boolean(existing), owner: payload };
  }

  refresh(nowMs) {
    if (!this.#held) return false;
    const payload = { ...this.#owner, heartbeatMs: nowMs };
    try {
      writeFileSync(this.#path, JSON.stringify(payload));
      this.#owner = payload;
      return true;
    } catch {
      return false;
    }
  }

  release() {
    if (!this.#held) return false;
    try {
      const cur = this.#read();
      // Only remove the lock if it is still ours.
      if (!cur || cur.instanceId === this.#owner?.instanceId) unlinkSync(this.#path);
    } catch { /* already gone */ }
    this.#held = false;
    return true;
  }

  #pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 performs the permission/existence check without signalling.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to another user.
      return err.code === 'EPERM';
    }
  }

  static inspect(path) {
    if (!existsSync(path)) return null;
    try {
      return { ...JSON.parse(readFileSync(path, 'utf8')), fileMtimeMs: statSync(path).mtimeMs };
    } catch {
      return null;
    }
  }
}

export function newInstanceId() {
  return newId('inst');
}
