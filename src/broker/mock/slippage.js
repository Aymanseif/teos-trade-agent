/**
 * TEOS Trade Agent - broker/mock/slippage.js
 *
 * Simulated slippage. A market order does not fill at the mid price:
 *
 *   fill = mid + side * (halfSpread + baseBps + impactBps + jitter)
 *
 *  - halfSpread     : crossing the bid/ask, unavoidable for a taker
 *  - baseBps        : baseline execution friction
 *  - impactBps      : scales with order size relative to the instrument's
 *                     configured liquidity proxy (a bigger order moves price more)
 *  - jitter         : seeded, so runs stay reproducible
 *
 * The reference (mid) price is stored on every fill, so the slippage cost in
 * EGP is directly auditable.
 */

import { bpsToFraction } from '../../core/money.js';

export class SlippageModel {
  #cfg;
  #rng;
  /** Per-instrument liquidity proxy in EGP notional. Notional exposure is measured against it. */
  #liquidityProxyEgp;

  constructor(slippageConfig, rng, { liquidityProxyEgp = 250_000 } = {}) {
    this.#cfg = slippageConfig;
    this.#rng = rng;
    this.#liquidityProxyEgp = liquidityProxyEgp;
  }

  setLiquidityProxy(egp) {
    this.#liquidityProxyEgp = egp;
    return this;
  }

  /**
   * @returns {{ bps:number, halfSpreadBps:number, impactBps:number, jitterBps:number }}
   */
  components({ side, mid, spreadBps, notionalEgp }) {
    const halfSpreadBps = spreadBps / 2;
    const pctOfLiquidity = (Math.abs(notionalEgp) / this.#liquidityProxyEgp) * 100;
    const impactBps = Math.min(pctOfLiquidity * this.#cfg.impactBpsPerPctOfLimit, this.#cfg.maxBps);
    const jitterBps = this.#rng.uniform(0, this.#cfg.baseBps);
    const total = Math.min(halfSpreadBps + this.#cfg.baseBps + impactBps + jitterBps, this.#cfg.maxBps);
    return {
      bps: total,
      halfSpreadBps,
      impactBps,
      jitterBps,
      sideSign: side === 'BUY' ? 1 : -1,
      mid,
    };
  }

  /** Apply slippage to a mid price for a given side. */
  apply({ side, mid, spreadBps, notionalEgp }) {
    const c = this.components({ side, mid, spreadBps, notionalEgp });
    const price = mid * (1 + c.sideSign * bpsToFraction(c.bps));
    return { price: Math.max(price, 0), slippageBps: c.bps, components: c };
  }

  /** Expected (zero-jitter) slippage for planning purposes, e.g. the sizer. */
  expectedBps(spreadBps, notionalEgp) {
    const halfSpreadBps = spreadBps / 2;
    const pctOfLiquidity = (Math.abs(notionalEgp) / this.#liquidityProxyEgp) * 100;
    const impactBps = Math.min(pctOfLiquidity * this.#cfg.impactBpsPerPctOfLimit, this.#cfg.maxBps);
    return Math.min(halfSpreadBps + this.#cfg.baseBps + impactBps, this.#cfg.maxBps);
  }
}
