/**
 * TEOS Trade Agent - paper/equity-curve.js
 * Tracks the equity series, running peak and drawdown. Persists to
 * `equity_curve` on a fixed cadence so the dashboard can chart without
 * recomputing the whole ledger.
 */

import { roundEgp } from '../core/money.js';
import { drawdown } from './pnl.js';

export class EquityCurve {
  #points = [];
  #peak = 0;
  #lastPersistMs = -Infinity;
  #persistEveryMs;

  constructor({ startingCapitalEgp, persistEveryMs = 60_000, seedHistory = [] }) {
    this.startingCapitalEgp = startingCapitalEgp;
    this.#peak = startingCapitalEgp;
    this.#persistEveryMs = persistEveryMs;
    for (const p of seedHistory) this.add(p.tsMs, p.equityEgp, p.cashEgp, p.exposureEgp, { persist: false });
  }

  get length() { return this.#points.length; }
  get peak() { return this.#peak; }

  add(tsMs, equityEgp, cashEgp, exposureEgp, { persist = true } = {}) {
    const equity = roundEgp(equityEgp);
    if (equity > this.#peak) this.#peak = equity;
    const ddEgp = roundEgp(Math.max(0, this.#peak - equity));
    const ddPct = this.#peak > 0 ? roundEgp((ddEgp / this.#peak) * 100) : 0;
    const point = { tsMs, equityEgp: equity, cashEgp: roundEgp(cashEgp), exposureEgp: roundEgp(exposureEgp), peakEquityEgp: roundEgp(this.#peak), drawdownEgp: ddEgp, drawdownPct: ddPct };
    this.#points.push(point);
    if (this.#points.length > 50_000) this.#points.splice(0, 10_000);
    const shouldPersist = persist && tsMs - this.#lastPersistMs >= this.#persistEveryMs;
    if (shouldPersist) this.#lastPersistMs = tsMs;
    return { point, shouldPersist };
  }

  stats() {
    const series = this.#points.map((p) => p.equityEgp);
    const dd = drawdown(series);
    const last = this.#points[this.#points.length - 1] ?? null;
    return {
      points: this.#points.length,
      currentEgp: last ? last.equityEgp : this.startingCapitalEgp,
      peakEgp: roundEgp(this.#peak),
      ...dd,
    };
  }

  /** Downsample for charting: at most `maxPoints` evenly-spaced samples. */
  sample(maxPoints = 240) {
    if (this.#points.length <= maxPoints) return [...this.#points];
    const step = (this.#points.length - 1) / (maxPoints - 1);
    const out = [];
    for (let i = 0; i < maxPoints; i += 1) out.push(this.#points[Math.round(i * step)]);
    return out;
  }

  toJSON() { return this.#points; }
}
