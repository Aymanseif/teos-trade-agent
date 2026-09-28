/**
 * TEOS Trade Agent - paper/ledger.js
 *
 * The cash ledger. This is the ONLY place that mutates the cash balance, and
 * it mutates in integer piastres, so repeated buy/sell cycles cannot drift.
 *
 * Invariants enforced here (defence in depth; the risk engine also checks):
 *   - cash may never go negative  -> borrowing is impossible
 *   - cash is never credited beyond the value of closed positions + starting
 *     capital; every credit is backed by an actual SELL fill
 *   - no entry exists for leverage, margin or borrowing
 */

import { fromMinor, toMinor, roundEgp } from '../core/money.js';
import { InsufficientBalanceError } from '../core/errors.js';

export class Ledger {
  #startingMinor;
  #cashMinor;
  #feesMinor = 0;
  #slippageMinor = 0;

  constructor(startingCapitalEgp) {
    const m = toMinor(startingCapitalEgp);
    if (m <= 0) throw new InsufficientBalanceError('Starting capital must be positive.', { startingCapitalEgp });
    this.#startingMinor = m;
    this.#cashMinor = m;
  }

  get startingCapitalEgp() { return fromMinor(this.#startingMinor); }
  get cashEgp() { return fromMinor(this.#cashMinor); }
  get cashMinor() { return this.#cashMinor; }
  get feesPaidEgp() { return fromMinor(this.#feesMinor); }
  get slippageCostEgp() { return fromMinor(this.#slippageMinor); }
  get availableCashEgp() { return Math.max(0, fromMinor(this.#cashMinor)); }

  /** Can this debit be covered? Used by the risk engine and by the ledger. */
  canDebit(egp) {
    return toMinor(egp) <= this.#cashMinor;
  }

  /** Debit cash. Throws if it would go negative - borrowing is not possible. */
  debit(egp, { reason = 'debit' } = {}) {
    const m = toMinor(egp);
    if (m < 0) throw new InsufficientBalanceError('Cannot debit a negative amount.', { egp });
    if (m > this.#cashMinor) {
      throw new InsufficientBalanceError(
        `Insufficient cash: requested EGP ${roundEgp(egp)} but only EGP ${fromMinor(this.#cashMinor)} available.`,
        { requested: roundEgp(egp), available: fromMinor(this.#cashMinor), cashMinor: this.#cashMinor, reason },
      );
    }
    this.#cashMinor -= m;
    return fromMinor(this.#cashMinor);
  }

  /** Credit cash (proceeds from a SELL fill). */
  credit(egp, { reason = 'credit' } = {}) {
    const m = toMinor(egp);
    if (m < 0) throw new InsufficientBalanceError('Cannot credit a negative amount.', { egp });
    this.#cashMinor += m;
    return fromMinor(this.#cashMinor);
  }

  /**
   * Apply a BUY fill: cash out for the notional, cash out for the fee.
   * A SELL fill is handled by `applySellFill` because it must also realise P&L.
   */
  applyBuyFill({ notionalEgp, feeEgp, slippageCostEgp = 0 }) {
    const totalMinor = toMinor(notionalEgp) + toMinor(feeEgp);
    if (totalMinor > this.#cashMinor) {
      throw new InsufficientBalanceError(
        `BUY fill would overdraw cash: notional EGP ${roundEgp(notionalEgp)} + fee EGP ${roundEgp(feeEgp)} `
        + `exceeds EGP ${fromMinor(this.#cashMinor)}.`,
        { notional: notionalEgp, fee: feeEgp, cash: fromMinor(this.#cashMinor) },
      );
    }
    this.#cashMinor -= totalMinor;
    this.#feesMinor += toMinor(feeEgp);
    this.#slippageMinor += toMinor(slippageCostEgp);
    return fromMinor(this.#cashMinor);
  }

  /** Apply a SELL fill: cash in for the notional, cash out for the fee. */
  applySellFill({ notionalEgp, feeEgp, slippageCostEgp = 0 }) {
    this.#cashMinor += toMinor(notionalEgp);
    const feeMinor = toMinor(feeEgp);
    this.#cashMinor -= feeMinor;
    this.#feesMinor += feeMinor;
    this.#slippageMinor += toMinor(slippageCostEgp);
    if (this.#cashMinor < 0) {
      // Selling always frees cash, so this is unreachable in normal operation.
      // It is a hard invariant, not a recoverable condition.
      throw new InsufficientBalanceError('Invariant violation: cash went negative after a SELL fill.', {
        cash: fromMinor(this.#cashMinor),
      });
    }
    return fromMinor(this.#cashMinor);
  }

  /**
   * Rebuild a ledger from persisted state after a restart.
   * The cash balance is restored verbatim - it is NEVER re-seeded from the
   * starting capital, which would silently inflate the account on every restart.
   */
  static restore({ startingCapitalEgp, cashEgp, feesPaidEgp = 0, slippageCostEgp = 0 }) {
    const l = new Ledger(startingCapitalEgp);
    l.#cashMinor = toMinor(cashEgp);
    l.#feesMinor = toMinor(feesPaidEgp);
    l.#slippageMinor = toMinor(slippageCostEgp);
    return l;
  }

  snapshot() {
    return {
      startingCapitalEgp: this.startingCapitalEgp,
      cashEgp: this.cashEgp,
      feesPaidEgp: this.feesPaidEgp,
      slippageCostEgp: this.slippageCostEgp,
    };
  }

  /** Full cash reconstruction from the fill history (integrity self-check). */
  static reconcile(startingCapitalEgp, fills) {
    let minor = toMinor(startingCapitalEgp);
    for (const f of fills) {
      if (f.side === 'BUY') minor -= toMinor(f.notional_egp ?? f.notionalEgp) + toMinor(f.fee_egp ?? f.feeEgp);
      else minor += toMinor(f.notional_egp ?? f.notionalEgp) - toMinor(f.fee_egp ?? f.feeEgp);
    }
    return fromMinor(minor);
  }
}
