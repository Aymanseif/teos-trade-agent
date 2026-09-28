/**
 * TEOS Trade Agent - agent/state.js
 *
 * Agent state machine.
 *
 *   STARTING ─► WARMUP ─► HEALTHY ─► DEGRADED ─► HALTED
 *                  │          ▲   ▲        │         │
 *                  │          └───┘        │         │
 *                  └────────────────────────┴─────────┘  (cooldown expiry)
 *   any state ─► STOPPED (graceful shutdown)
 *   any state ─► FAILED   (undefined / unhandled error)
 *
 * Trade-permission matrix. Only HEALTHY may open new exposure.
 *
 *   state      evaluate   open new position   exit existing
 *   HEALTHY    yes        yes                 yes
 *   DEGRADED   yes        NO                  yes (risk-reducing only)
 *   WARMUP     no         no                  no
 *   HALTED     no         no                  yes (risk-reducing only)
 *   STARTING   no         no                  no
 *   STOPPED    no         no                  no
 *   FAILED     no         no                  no
 *
 * An unrecognised state is treated as FAILED. The risk engine's AGENT_STATE
 * rule blocks any order unless the state is exactly HEALTHY, so an undefined
 * state can never produce an order.
 */

import { newId } from '../core/ids.js';

export const STATES = Object.freeze({
  STARTING: 'STARTING',
  WARMUP: 'WARMUP',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  HALTED: 'HALTED',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

const PERMISSIONS = {
  STARTING: { evaluate: false, openPosition: false, reduceOnly: false },
  WARMUP: { evaluate: false, openPosition: false, reduceOnly: false },
  HEALTHY: { evaluate: true, openPosition: true, reduceOnly: true },
  DEGRADED: { evaluate: true, openPosition: false, reduceOnly: true },
  HALTED: { evaluate: false, openPosition: false, reduceOnly: true },
  STOPPED: { evaluate: false, openPosition: false, reduceOnly: false },
  FAILED: { evaluate: false, openPosition: false, reduceOnly: false },
};

export function permissionsFor(state) {
  // Undefined state => no permissions whatsoever. Fail closed, always.
  return PERMISSIONS[state] ?? { evaluate: false, openPosition: false, reduceOnly: false };
}

export function isKnownState(state) {
  return Object.hasOwn(STATES, state);
}

/** Legal transitions. Anything else is a bug and throws. */
const TRANSITIONS = {
  STARTING: ['WARMUP', 'HEALTHY', 'DEGRADED', 'HALTED', 'STOPPED', 'FAILED'],
  WARMUP: ['HEALTHY', 'DEGRADED', 'HALTED', 'STOPPED', 'FAILED'],
  HEALTHY: ['DEGRADED', 'HALTED', 'WARMUP', 'STOPPED', 'FAILED'],
  DEGRADED: ['HEALTHY', 'HALTED', 'STOPPED', 'FAILED'],
  HALTED: ['DEGRADED', 'HEALTHY', 'STOPPED', 'FAILED'],
  STOPPED: ['STARTING', 'FAILED'],
  FAILED: ['STARTING', 'STOPPED'],
};

export class AgentStateMachine {
  #state = STATES.STARTING;
  #since = 0;
  #repos;
  #clock;
  #history = [];

  constructor({ repos, clock, initial = STATES.STARTING }) {
    this.#repos = repos;
    this.#clock = clock;
    this.#state = isKnownState(initial) ? initial : STATES.FAILED;
    this.#since = clock.now();
  }

  get state() { return this.#state; }
  get since() { return this.#since; }
  get history() { return [...this.#history]; }
  get permissions() { return permissionsFor(this.#state); }

  can(permission) {
    return permissionsFor(this.#state)[permission] === true;
  }

  /**
   * @returns {{ changed:boolean, from:string, to:string }}
   * @throws on an illegal transition - an illegal transition means there is a
   *         bug in the caller, and silently coercing it would hide it.
   */
  transition(to, reason) {
    if (!isKnownState(to)) {
      // An undefined target state is itself a stop-trading condition.
      this.#history.push({ from: this.#state, to: STATES.FAILED, reason: `UNKNOWN_STATE:${to}`, tsMs: this.#clock.now() });
      this.#state = STATES.FAILED;
      this.#since = this.#clock.now();
      this.#persist(this.#history[this.#history.length - 1]);
      return { changed: true, from: STATES.HEALTHY, to: STATES.FAILED };
    }
    if (to === this.#state) return { changed: false, from: this.#state, to };

    const allowed = TRANSITIONS[this.#state] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`Illegal agent state transition ${this.#state} -> ${to} (reason: ${reason ?? 'none'})`);
    }
    const from = this.#state;
    this.#state = to;
    this.#since = this.#clock.now();
    const entry = { from, to, reason: reason ?? null, tsMs: this.#clock.now() };
    this.#history.push(entry);
    this.#persist(entry);
    return { changed: true, from, to };
  }

  #persist(entry) {
    if (!this.#repos) return;
    this.#repos.logState({ from: entry.from, to: entry.to, reason: entry.reason, clock: this.#clock });
  }

  /** Map a connectivity / data-quality condition onto a state. */
  applyHealth({ connected, dataFresh, abnormalPrice, undefinedState = false }) {
    if (undefinedState || !isKnownState(this.#state)) return this.transition(STATES.FAILED, 'UNDEFINED_STATE');
    if (!connected) return this.transition(STATES.HALTED, 'BROKER_DISCONNECTED');
    if (abnormalPrice) return this.transition(STATES.HALTED, 'ABNORMAL_PRICE');
    if (!dataFresh) return this.transition(STATES.HALTED, 'STALE_MARKET_DATA');
    if (this.#state === STATES.HALTED) return this.transition(STATES.DEGRADED, 'HALT_CONDITIONS_CLEARED');
    if (this.#state === STATES.DEGRADED) return this.transition(STATES.HEALTHY, 'DEGRADATION_CLEARED');
    return { changed: false, from: this.#state, to: this.#state };
  }

  toJSON() {
    return {
      state: this.#state,
      sinceMs: this.#since,
      sinceIso: new Date(this.#since).toISOString(),
      permissions: this.permissions,
      history: this.#history.slice(-50),
    };
  }
}

export { newId };
