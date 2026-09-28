/**
 * TEOS Trade Agent - database/migrate.js
 * Applies schema.sql and records the migration version. Idempotent.
 */

import { applySchema } from './db.js';
import { systemClock } from '../core/clock.js';

export const MIGRATIONS = [
  { version: 1, name: '0001_initial_phase1_schema' },
  // Adds orders.status_at_submit, the immutable submission status covered by the
  // audit chain. The chain for v1 rows was computed over the old column set and
  // is therefore not re-verifiable under the new one; Phase 1 has no deployed
  // history to preserve, and schema.sql is the single source of truth.
  { version: 2, name: '0002_order_status_at_submit' },
];

export function migrate(db, clock = systemClock) {
  applySchema(db);
  db.tx(() => {
    for (const m of MIGRATIONS) {
      const exists = db.get('SELECT version FROM schema_migrations WHERE version = ?', m.version);
      if (!exists) {
        db.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          m.version,
          m.name,
          clock.nowIso(),
        );
      }
    }
  });
  return db;
}
