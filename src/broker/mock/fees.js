/**
 * TEOS Trade Agent - broker/mock/fees.js
 *
 * Simulated fees. Fees are NEVER zero: config validation rejects a zero-fee
 * environment, because a zero-cost simulation systematically overstates results.
 *
 * Money is computed in integer piastres so a long run cannot drift.
 */

import { fromMinor, toMinor, bpsToFraction } from '../../core/money.js';

export class FeeModel {
  #cfg;
  constructor(feesConfig) {
    this.#cfg = feesConfig;
  }

  get config() { return this.#cfg; }

  /**
   * @param {string} liquidity 'MAKER' | 'TAKER'
   * @param {number} notionalEgp
   * @returns {number} fee in EGP, >= minFee
   */
  compute(liquidity, notionalEgp) {
    const bps = liquidity === 'MAKER' ? this.#cfg.makerBps : this.#cfg.takerBps;
    const raw = Math.abs(notionalEgp) * bpsToFraction(bps);
    const minor = Math.max(Math.round(raw * 100), Math.round(this.#cfg.minFeeEgp * 100));
    return fromMinor(minor);
  }

  /** Round-trip estimate, used by the position sizer. */
  roundTripBps() {
    return this.#cfg.takerBps * 2;
  }
}
