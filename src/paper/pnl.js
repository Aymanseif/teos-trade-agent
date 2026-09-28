/**
 * TEOS Trade Agent - paper/pnl.js
 *
 * Profit and loss.
 *
 * Realised P&L uses average-cost accounting per symbol (the standard for a
 * single-position spot book) and is NET of nothing: fees and slippage are
 * tracked separately by the Ledger and included in the net performance
 * figures, so the gross and the true cost of trading are both visible.
 *
 * Unrealised P&L is marked against the latest mid price.
 */

import { roundEgp, roundQty, toMinor, fromMinor } from '../core/money.js';

/**
 * @param {object} position  { quantity, avg_entry_price }
 * @param {number} mid
 */
export function unrealizedPnlEgp(position, mid) {
  if (!position || !position.quantity) return 0;
  return roundEgp(position.quantity * (mid - position.avg_entry_price));
}

/**
 * Realise `qty` units of a long position at `exitPrice`.
 * Average cost: the remaining quantity keeps the original average entry.
 *
 * @returns {{ realizedEgp:number, remainingQty:number, remainingAvgEntry:number, exitNotional:number }}
 */
export function realizeLong({ avgEntryPrice, quantity, exitPrice, qty }) {
  const remainingBefore = quantity;
  if (qty > remainingBefore + 1e-9) {
    throw new RangeError(`Cannot realize ${qty} from a position of ${remainingBefore}`);
  }
  const realized = roundEgp(qty * (exitPrice - avgEntryPrice));
  // The remaining size is a QUANTITY. Rounding it to piastre precision (2dp)
  // turns a 0.002-unit remainder into zero, which closes the position on paper
  // while only part of it was ever sold - inventing cash out of nothing.
  const remainingQty = roundQty(remainingBefore - qty);
  return {
    realizedEgp: realized,
    remainingQty,
    remainingAvgEntry: remainingQty > 0 ? avgEntryPrice : 0,
    exitNotional: roundEgp(qty * exitPrice),
  };
}

/**
 * Aggregate portfolio P&L from positions + realized history.
 */
export function portfolioPnl({
  startingCapitalEgp, cashEgp, positions, midBySymbol, realizedPnlEgp, feesPaidEgp, slippageCostEgp,
}) {
  let unrealized = 0;
  let exposure = 0;
  let costBasis = 0;
  for (const p of positions) {
    const mid = midBySymbol.get(p.symbol);
    const mark = mid ?? p.avg_entry_price;
    exposure += Math.abs(p.quantity * mark);
    costBasis += Math.abs(p.quantity * p.avg_entry_price);
    unrealized += unrealizedPnlEgp(p, mark);
  }
  unrealized = roundEgp(unrealized);
  exposure = roundEgp(exposure);
  costBasis = roundEgp(costBasis);

  // Equity = cash + the mark-to-market value of the open positions.
  //
  // Cash is DECREMENTED when a position is opened (see Ledger.reconcile), so
  // the asset acquired is no longer represented in the cash figure and must be
  // added back at its current value. That value is cost basis plus unrealised
  // P&L, so:
  //
  //     equity = cash + costBasis + unrealized
  //
  // Adding only `unrealized` would report a freshly opened position at a
  // near-zero value and make every purchase look like a total loss.
  const equity = roundEgp(cashEgp + costBasis + unrealized);
  const totalPnl = roundEgp(equity - startingCapitalEgp);
  const netPnlAfterCosts = roundEgp(totalPnl - feesPaidEgp - slippageCostEgp);

  return {
    startingCapitalEgp: roundEgp(startingCapitalEgp),
    cashEgp: roundEgp(cashEgp),
    equityEgp: equity,
    exposureEgp: exposure,
    costBasisEgp: costBasis,
    realizedPnlEgp: roundEgp(realizedPnlEgp),
    unrealizedPnlEgp: unrealized,
    totalPnlEgp: totalPnl,
    feesPaidEgp: roundEgp(feesPaidEgp),
    slippageCostEgp: roundEgp(slippageCostEgp),
    netPnlAfterCostsEgp: netPnlAfterCosts,
    openPositions: positions.length,
    leverageRatio: equity > 0 ? roundEgp(exposure / equity) : null,
  };
}

/** Drawdown of a value series against its running peak. */
export function drawdown(series) {
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = peak - v;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDd) maxDd = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }
  return { maxDrawdownEgp: roundEgp(maxDd), maxDrawdownPct: roundEgp(maxDdPct * 100) };
}

/**
 * Position size from risk budget.
 *
 *   qty = riskBudget / (price - stopPrice)
 *
 * then floored to the instrument's qtyStep and clamped so that
 * notional <= maxPositionSizeEgp and cash covers notional + fees.
 *
 * The account is LONG-ONLY and CASH-FUNDED. A SELL signal reduces or closes an
 * existing long position; it never opens a short. That is what makes
 * "no leverage, no borrowing" structurally true rather than merely configured.
 *
 * This is a pure function so the sizer is unit-testable in isolation.
 */
export function sizePosition({
  price, stopPrice, riskBudgetEgp, maxNotionalEgp, availableCashEgp,
  qtyStep, minQty, feeBps, minNotionalEgp = 0,
}) {
  const stopDistance = Math.abs(price - stopPrice);
  if (!(stopDistance > 0)) {
    return { quantity: 0, notionalEgp: 0, reason: 'ZERO_STOP_DISTANCE' };
  }
  const qtyByRisk = riskBudgetEgp / stopDistance;
  const qtyByNotional = maxNotionalEgp / price;
  // Cash cap: notional + fee( = notional * feeBps / 10000) must fit in cash.
  const qtyByCash = feeBps >= 0
    ? availableCashEgp / (1 + feeBps / 10_000)
    : availableCashEgp / price;

  const boundBy = qtyByRisk <= qtyByNotional && qtyByRisk <= qtyByCash
    ? 'RISK'
    : (qtyByNotional <= qtyByCash ? 'MAX_NOTIONAL' : 'CASH');

  let qty = Math.min(qtyByRisk, qtyByNotional, qtyByCash);
  qty = Math.floor(qty / qtyStep) * qtyStep;
  qty = roundQty(qty);

  if (qty < minQty) {
    return { quantity: 0, notionalEgp: 0, reason: 'BELOW_MIN_QTY', rawQty: qty };
  }
  const notional = roundEgp(qty * price);
  if (notional < minNotionalEgp) {
    return { quantity: 0, notionalEgp: notional, reason: 'BELOW_MIN_NOTIONAL', rawQty: qty };
  }
  return {
    quantity: qty,
    notionalEgp: notional,
    riskAtStopEgp: roundEgp(qty * stopDistance),
    boundBy,
  };
}

/** Convert an EGP risk budget into an integer piastre amount. */
export function riskBudgetMinor(egp) {
  return toMinor(egp);
}

export { fromMinor, toMinor };
