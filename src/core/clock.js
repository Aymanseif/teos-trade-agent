/**
 * TEOS Trade Agent - core/clock.js
 *
 * The whole system takes time from an injectable Clock. Production uses
 * SystemClock; tests and backtests use ManualClock. Nothing in the agent,
 * risk engine, sentinel or paper exchange may call Date.now() directly.
 */

export class SystemClock {
  now() {
    return Date.now();
  }

  nowIso() {
    return new Date(this.now()).toISOString();
  }

  dateKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /**
   * Wait for the tick interval.
   *
   * The timer is deliberately NOT unref'd. The worker loop spends almost all of
   * its life parked in this call, and an unref'd timer does not keep the event
   * loop alive - so with nothing else scheduled, Node would consider the process
   * finished and exit after the first tick. That is the difference between a
   * 24/7 agent and one that runs for a second. Shutdown is handled by the
   * SIGINT/SIGTERM handler in the CLI, not by starving the loop of handles.
   */
  sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }
}

export class ManualClock {
  constructor(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.t = startMs;
  }

  now() {
    return this.t;
  }

  nowIso() {
    return new Date(this.t).toISOString();
  }

  dateKey() {
    return new Date(this.t).toISOString().slice(0, 10);
  }

  advance(ms) {
    this.t += ms;
    return this.t;
  }

  sleep() {
    return Promise.resolve();
  }
}

export const systemClock = new SystemClock();
