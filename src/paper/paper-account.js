/**
 * TEOS Trade Agent - paper/paper-account.js
 *
 * The paper account. Owns cash (via Ledger), open positions, realized P&L and
 * the equity curve, and writes the corresponding audit rows.
 *
 * LONG-ONLY, CASH-FUNDED, NO LEVERAGE. A SELL reduces or closes a long
 * position; a short position cannot be created, so borrowing is impossible by
 * construction and not merely by policy.
 */

import { Ledger } from './ledger.js';
import { EquityCurve } from './equity-curve.js';
import { portfolioPnl, realizeLong, unrealizedPnlEgp } from './pnl.js';
import { roundEgp, roundQty, toMinor, fromMinor } from '../core/money.js';
import { newId } from '../core/ids.js';
import { InvalidOrderError, TeosError } from '../core/errors.js';

export class PaperAccount {
  #ledger;
  #curve;
  #midBySymbol = new Map();
  #positions = new Map(); // symbol -> position row
  #repos;
  #clock;
  #realizedMinor = 0;

  constructor({ repos, clock, startingCapitalEgp, restored = null }) {
    this.#repos = repos;
    this.#clock = clock;
    // On restart the cash balance is restored from the database. It is never
    // re-seeded from the starting capital, which would silently inflate the
    // account on every restart.
    this.#ledger = restored
      ? Ledger.restore(restored)
      : new Ledger(startingCapitalEgp);
    this.#curve = new EquityCurve({
      startingCapitalEgp,
      seedHistory: restored?.equityHistory ?? [],
    });
  }

  // ------------------------------------------------------------- marking
  mark(symbol, mid) {
    if (Number.isFinite(mid)) this.#midBySymbol.set(symbol, mid);
    return this.#midBySymbol.get(symbol);
  }

  markAll(quotes) {
    for (const q of quotes) this.mark(q.symbol, q.mid);
  }

  midFor(symbol) {
    return this.#midBySymbol.get(symbol) ?? null;
  }

  // --------------------------------------------------------------- fills
  /**
   * Apply a fill to cash + position. Called by the broker AFTER the matching
   * engine produces it, inside a database transaction.
   */
  applyFill(fill, { order }) {
    const symbol = fill.symbol;
    if (!order) throw new InvalidOrderError('applyFill requires the parent order.', { fill });

    if (fill.side === 'BUY') {
      const notional = roundEgp(fill.quantity * fill.price);
      this.#ledger.applyBuyFill({ notionalEgp: notional, feeEgp: fill.feeEgp, slippageCostEgp: fill.slippageCostEgp });
      this.#repos.recordPnl({ kind: 'FEE', amountEgp: -fill.feeEgp, orderId: fill.orderId, symbol, clock: this.#clock, note: 'taker fee' });
      if (fill.slippageCostEgp > 0) {
        this.#repos.recordPnl({ kind: 'SLIPPAGE', amountEgp: -fill.slippageCostEgp, orderId: fill.orderId, symbol, clock: this.#clock, note: 'slippage vs mid' });
      }
      // Open or increase the long position (average cost).
      const existing = this.#positions.get(symbol);
      if (existing && existing.status === 'OPEN' && existing.quantity > 0) {
        // Quantity is rounded as a QUANTITY (8dp), never as cash. Rounding
        // 0.002 units to piastre precision gives 0, which then divides the
        // average-price calculation by zero and throws Infinity into the ledger.
        const newQty = roundQty(existing.quantity + fill.quantity);
        const avg = roundEgp(((existing.quantity * existing.avg_entry_price) + notional) / newQty);
        this.#repos.updatePosition(existing.position_id, {
          quantity: newQty, avgEntryPrice: avg, feesPaid: roundEgp(existing.fees_paid_egp + fill.feeEgp),
          slippageCost: roundEgp(existing.slippage_cost_egp + fill.slippageCostEgp),
        }, this.#clock);
        this.#positions.set(symbol, { ...existing, quantity: newQty, avg_entry_price: avg });
      } else {
        const id = this.#repos.openPosition({
          symbol, quantity: fill.quantity, avgEntryPrice: fill.price, clock: this.#clock, positionId: newId('pos'),
        });
        this.#positions.set(symbol, {
          position_id: id, symbol, quantity: fill.quantity, avg_entry_price: fill.price,
          realized_pnl_egp: 0, fees_paid_egp: fill.feeEgp, slippage_cost_egp: fill.slippageCostEgp, status: 'OPEN',
        });
      }
      return { side: 'BUY', realizedEgp: 0 };
    }

    // ---- SELL: reduce or close a long position. Shorts are impossible. ----
    const pos = this.#positions.get(symbol);
    if (!pos || pos.status !== 'OPEN' || pos.quantity <= 0) {
      throw new TeosError(
        `SELL rejected: no open long position in ${symbol}. Short selling is not permitted.`,
        { symbol, code: 'NO_POSITION_TO_SELL' },
      );
    }
    const qty = Math.min(fill.quantity, pos.quantity);
    const exitNotional = roundEgp(qty * fill.price);
    this.#ledger.applySellFill({ notionalEgp: exitNotional, feeEgp: fill.feeEgp, slippageCostEgp: fill.slippageCostEgp });
    this.#repos.recordPnl({ kind: 'FEE', amountEgp: -fill.feeEgp, orderId: fill.orderId, symbol, clock: this.#clock, note: 'taker fee' });
    if (fill.slippageCostEgp > 0) {
      this.#repos.recordPnl({ kind: 'SLIPPAGE', amountEgp: -fill.slippageCostEgp, orderId: fill.orderId, symbol, clock: this.#clock, note: 'slippage vs mid' });
    }

    const r = realizeLong({
      avgEntryPrice: pos.avg_entry_price, quantity: pos.quantity, exitPrice: fill.price, qty,
    });
    this.#realizedMinor += toMinor(r.realizedEgp);
    this.#repos.recordPnl({
      kind: 'REALIZED', amountEgp: r.realizedEgp, positionId: pos.position_id, orderId: fill.orderId, symbol, clock: this.#clock, note: 'long exit',
    });

    const remainingQty = r.remainingQty;
    const updated = this.#repos.updatePosition(pos.position_id, {
      quantity: remainingQty,
      avgEntryPrice: remainingQty > 0 ? r.remainingAvgEntry : pos.avg_entry_price,
      realizedPnl: roundEgp(pos.realized_pnl_egp + r.realizedEgp),
      feesPaid: roundEgp(pos.fees_paid_egp + fill.feeEgp),
      slippageCost: roundEgp(pos.slippage_cost_egp + fill.slippageCostEgp),
      status: remainingQty > 0 ? 'OPEN' : 'CLOSED',
    }, this.#clock);
    this.#positions.set(symbol, updated);
    return { side: 'SELL', realizedEgp: r.realizedEgp, remainingQty, exitNotional };
  }

  // -------------------------------------------------------------- reads
  get cashEgp() { return this.#ledger.cashEgp; }
  get startingCapitalEgp() { return this.#ledger.startingCapitalEgp; }
  get feesPaidEgp() { return this.#ledger.feesPaidEgp; }
  get slippageCostEgp() { return this.#ledger.slippageCostEgp; }
  get realizedPnlEgp() { return fromMinor(this.#realizedMinor); }
  get ledger() { return this.#ledger; }
  get curve() { return this.#curve; }

  /**
   * Mark-to-market equity. A snapshot, not a stored balance: it is recomputed
   * from cash, cost basis and the latest mid for every open position. It is the
   * live value; `snapshot().equityEgp` is the same number with the components
   * broken out, and the persisted `balances` row is the historical record.
   */
  get equityEgp() { return this.snapshot().equityEgp; }
  get exposureEgp() { return this.snapshot().exposureEgp; }
  get unrealizedPnlEgp() { return this.snapshot().unrealizedPnlEgp; }

  /** Reload open positions from the DB (restart recovery). */
  loadOpenPositions() {
    this.#positions.clear();
    let realizedMinor = 0;
    for (const p of this.#repos.listOpenPositions()) {
      this.#positions.set(p.symbol, p);
    }
    for (const p of this.#repos.listPositions({ status: 'CLOSED' })) {
      realizedMinor += toMinor(p.realized_pnl_egp);
    }
    this.#realizedMinor = realizedMinor;
    return this.#positions;
  }

  getPositions() {
    return [...this.#positions.values()].filter((p) => p.status === 'OPEN' && p.quantity > 0);
  }

  getOpenPositions() { return this.getPositions(); }

  positionFor(symbol) {
    const p = this.#positions.get(symbol);
    return p && p.status === 'OPEN' && p.quantity > 0 ? p : null;
  }

  getBalance() {
    const snap = this.snapshot();
    return {
      cashEgp: snap.cashEgp,
      equityEgp: snap.equityEgp,
      startingCapitalEgp: snap.startingCapitalEgp,
      currency: 'EGP',
      leverage: 'NONE',
    };
  }

  get_balance() { return this.getBalance(); }

  /** Full portfolio snapshot. Pure read - safe to call from the dashboard. */
  snapshot() {
    const positions = this.getPositions();
    const p = portfolioPnl({
      startingCapitalEgp: this.startingCapitalEgp,
      cashEgp: this.cashEgp,
      positions,
      midBySymbol: this.#midBySymbol,
      realizedPnlEgp: this.realizedPnlEgp,
      feesPaidEgp: this.feesPaidEgp,
      slippageCostEgp: this.slippageCostEgp,
    });
    return {
      ...p,
      openPositionDetails: positions.map((pos) => ({
        position_id: pos.position_id,
        symbol: pos.symbol,
        quantity: pos.quantity,
        avgEntryPrice: pos.avg_entry_price,
        mid: this.#midBySymbol.get(pos.symbol) ?? null,
        unrealizedPnlEgp: unrealizedPnlEgp(pos, this.#midBySymbol.get(pos.symbol) ?? pos.avg_entry_price),
        realizedPnlEgp: pos.realized_pnl_egp,
        notionalEgp: roundEgp(pos.quantity * (this.#midBySymbol.get(pos.symbol) ?? pos.avg_entry_price)),
        openedAt: pos.opened_at,
      })),
    };
  }

  /** Append a point to the equity curve; returns true if it should be persisted. */
  tickEquity({ reason = 'tick' } = {}) {
    const s = this.snapshot();
    const { point, shouldPersist } = this.#curve.add(
      this.#clock.now(), s.equityEgp, s.cashEgp, s.exposureEgp,
    );
    if (shouldPersist) {
      this.#repos.recordEquity({
        equityEgp: point.equityEgp, cashEgp: point.cashEgp, exposureEgp: point.exposureEgp,
        peakEquityEgp: point.peakEquityEgp, drawdownEgp: point.drawdownEgp, drawdownPct: point.drawdownPct,
        clock: this.#clock,
      });
    }
    this.#repos.recordBalance({
      cashEgp: s.cashEgp, equityEgp: s.equityEgp, exposureEgp: s.exposureEgp,
      realizedPnlEgp: s.realizedPnlEgp, unrealizedPnlEgp: s.unrealizedPnlEgp, totalPnlEgp: s.totalPnlEgp,
      openPositions: s.openPositions, feesPaidEgp: s.feesPaidEgp, slippageCostEgp: s.slippageCostEgp, reason,
    }, this.#clock);
    return point;
  }

  equityStats() {
    return this.#curve.stats();
  }
}
