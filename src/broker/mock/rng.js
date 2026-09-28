/**
 * TEOS Trade Agent - broker/mock/rng.js
 *
 * Deterministic PRNG (mulberry32) + Box-Muller normal.
 *
 * EVERY stochastic element of the paper environment is drawn from a seeded
 * stream: price path, spreads, slippage jitter, partial-fill behaviour. A seed
 * plus a tick count therefore reproduces an identical run, which is what makes
 * the backtest and the test suite meaningful.
 */

export class Rng {
  constructor(seed = 1) {
    this.initialSeed = seed >>> 0;
    this.state = this.initialSeed;
    this.draws = 0;
  }

  reset() {
    this.state = this.initialSeed;
    this.draws = 0;
    return this;
  }

  /** Uniform in [0, 1). */
  next() {
    this.draws += 1;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  uniform(min, max) {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max]. */
  int(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  bool(probabilityPct) {
    return this.next() * 100 < probabilityPct;
  }

  /** Standard normal via Box-Muller. */
  normal() {
    let u = 0; let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
}
