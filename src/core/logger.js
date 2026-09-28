/**
 * TEOS Trade Agent - core/logger.js
 * Structured JSONL logging with hard secret redaction. Logs never contain an
 * order body with credentials, and redaction is applied to the final string
 * form, not just to known fields.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './env.js';
import { systemClock } from './clock.js';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

class Logger {
  constructor({ level = 'info', logDir = null, clock = systemClock, echo = true, name = 'teos' }) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.levelName = level;
    this.clock = clock;
    this.echo = echo;
    this.name = name;
    this.logDir = logDir;
    if (logDir) {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        this.logDir = null; // never let logging break the agent
      }
    }
    this.sinks = [];
  }

  child(name) {
    const c = new Logger({
      level: this.levelName,
      logDir: this.logDir,
      clock: this.clock,
      echo: this.echo,
      name: `${this.name}.${name}`,
    });
    c.sinks = this.sinks;
    return c;
  }

  addSink(fn) {
    this.sinks.push(fn);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== fn);
    };
  }

  _write(level, msg, fields) {
    if (LEVELS[level] < this.level) return;
    const record = {
      ts: this.clock.nowIso(),
      ts_ms: this.clock.now(),
      level,
      logger: this.name,
      msg: String(redact(msg)),
      ...(fields ? redact(fields) : {}),
    };
    const line = JSON.stringify(record);
    for (const sink of this.sinks) {
      try {
        sink(record);
      } catch {
        /* a broken sink must not kill the agent */
      }
    }
    if (this.logDir) {
      try {
        appendFileSync(join(this.logDir, 'teos.jsonl'), `${line}\n`);
      } catch {
        /* ignore */
      }
    }
    if (this.echo) {
      const tag = level.toUpperCase().padEnd(5);
      const extra = fields ? ` ${JSON.stringify(redact(fields))}` : '';
      process.stdout.write(`[${tag}] ${this.name}: ${redact(msg)}${extra}\n`);
    }
  }

  debug(msg, fields) { this._write('debug', msg, fields); }
  info(msg, fields) { this._write('info', msg, fields); }
  warn(msg, fields) { this._write('warn', msg, fields); }
  error(msg, fields) { this._write('error', msg, fields); }
  fatal(msg, fields) { this._write('fatal', msg, fields); }
}

export function createLogger(opts = {}) {
  return new Logger(opts);
}

export const rootLogger = createLogger({
  level: process.env.TEOS_LOG_LEVEL ?? 'info',
  logDir: process.env.TEOS_LOG_DIR ?? null,
});
