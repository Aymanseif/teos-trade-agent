/**
 * TEOS Trade Agent - core/ids.js
 * Deterministic, collision-resistant identifiers.
 *
 * ID policy
 *  - run_id / decision_id / order_id etc. are time-sortable (prefixed ULID-ish).
 *  - client_order_id is DETERMINISTIC from the decision id. This is the
 *    backbone of duplicate-order prevention across worker restarts.
 */

import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
let lastTime = 0;
let lastRandom = new Array(10).fill(0);

/**
 * `lastRandom` holds NUMERIC indices (0..31), not characters. Storing indices
 * matters: comparing a character to a number with `<` is always false, which
 * silently breaks the monotonic increment and produces duplicate ids.
 */
function randomIndices(len) {
  const bytes = randomBytes(len);
  const out = new Array(len);
  for (let i = 0; i < len; i += 1) out[i] = bytes[i] % 32;
  return out;
}

/** Increment a base-32 index array in place. Overflow returns false. */
function incrementIndices(arr) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] < 31) {
      arr[i] += 1;
      return true;
    }
    arr[i] = 0;
  }
  return false; // full wrap: caller must allocate a new random block
}

/** Monotonic, time-sortable, collision-resistant id. */
export function newId(prefix = '') {
  const now = Date.now();
  if (now === lastTime) {
    // Same millisecond: increment so ids stay unique and ordered.
    if (!incrementIndices(lastRandom)) lastRandom = randomIndices(lastRandom.length);
  } else {
    lastTime = now;
    lastRandom = randomIndices(lastRandom.length || 10);
  }

  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }

  const id = ts + lastRandom.map((n) => ALPHABET[n]).join('');
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Deterministic client order id.
 * Same decision_id always yields the same client_order_id, so a retry or a
 * post-restart replay can never create a second order for the same decision.
 */
export function clientOrderId(decisionId, attempt = 0) {
  const digest = sha256(`teos|${decisionId}|${attempt}`);
  const body = digest.slice(0, 24).toUpperCase();
  return `TEOS-${body}`;
}

/** Stable short hash, used for audit chain links and fingerprints. */
export function shortHash(input, len = 16) {
  return sha256(input).slice(0, len);
}
