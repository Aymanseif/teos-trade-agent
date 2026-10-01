/**
 * TEOS evaluation harness - costs.js
 *
 * Gross vs net decomposition.
 *
 * IT IS NOT POSSIBLE TO ASK THE ENGINE FOR A GROSS RUN, AND THAT IS CORRECT.
 * `validateConfig` throws if `fees` or `slippage` are all zero:
 *
 *     "Fees may not be zero. A zero-fee simulation is not a valid paper
 *      environment."
 *
 * So this harness never disables costs. It reads the decomposition the engine
 * already produces on every run:
 *
 *     netPnlEgp               = final equity - starting capital
 *     grossPnlBeforeCostsEgp  = netPnlEgp + fees + slippage
 *     feesPaidEgp             = charged on every fill
 *     slippageCostEgp         = |qty x (fillPrice - mid)|, i.e. it INCLUDES the
 *                               spread crossing and so overlaps the half-spread
 *
 * The last note matters: fees and slippage are not independent drags. Half of
 * the slippage figure is the spread the fill had to cross, and the fee schedule
 * is separate from that. They are additive in the total (the engine computes
 * `totalTradingCostEgp = fees + slippage` and equity is net of both) but they
 * are not two independent measures of the same thing, and the report says so.
 */

import { sum } from './stats.js';

/**
 * Per-run cost decomposition, plus the cost hurdle in basis points.
 *
 * Accepts either a raw run object (which carries `rows.fills`) or a compact
 * summary (which carries pre-derived `notionalEgp` / `fillCount`), so the same
 * arithmetic serves the child process and the parent aggregator.
 */
export function costBreakdown(run) {
  const m = run.metrics;
  const notional = run.notionalEgp ?? sum((run.rows?.fills ?? []).map((f) => f.quantity * f.price));
  const fillCount = run.fillCount ?? (run.rows?.fills ?? []).length;
  const roundTrips = Math.max(1, Math.round(fillCount / 2));
  const fees = m.feesPaidEgp ?? 0;
  const slip = m.slippageCostEgp ?? 0;
  const total = m.totalTradingCostEgp ?? (fees + slip);
  const gross = m.grossPnlBeforeCostsEgp ?? 0;
  const net = m.netPnlEgp ?? 0;

  return {
    grossPnlEgp: gross,
    feesEgp: fees,
    slippageEgp: slip,
    totalCostEgp: total,
    netPnlEgp: net,
    /** Identity check: gross - cost === net. If not, the engine disagrees with itself. */
    reconciles: Math.abs((gross - total) - net) < 0.011,
    notionalEgp: notional,
    fills: fillCount,
    roundTrips,
    costBpsOfNotional: notional > 0 ? (total / notional) * 10_000 : null,
    costPerRoundTripEgp: total / roundTrips,
    /** The edge a round trip must produce just to break even. */
    hurdleBps: notional > 0 ? ((total / notional) * 10_000) / roundTrips : null,
    /** Cost as a multiple of the gross result. >1 means costs dominate. */
    costToGrossRatio: Math.abs(gross) > 0.005 ? total / Math.abs(gross) : null,
  };
}

/**
 * Pooled across runs: the additive decomposition of the TOTAL loss.
 * This is the input to the ranked cause-of-loss analysis.
 */
export function pooledCosts(runs) {
  const parts = runs.map(costBreakdown);
  const gross = sum(parts.map((p) => p.grossPnlEgp));
  const fees = sum(parts.map((p) => p.feesEgp));
  const slip = sum(parts.map((p) => p.slippageEgp));
  const cost = sum(parts.map((p) => p.totalCostEgp));
  const net = sum(parts.map((p) => p.netPnlEgp));
  const notional = sum(parts.map((p) => p.notionalEgp));
  return {
    runs: runs.length,
    grossPnlEgp: gross,
    feesEgp: fees,
    slippageEgp: slip,
    totalCostEgp: cost,
    netPnlEgp: net,
    notionalEgp: notional,
    costBpsOfNotional: notional > 0 ? (cost / notional) * 10_000 : null,
    costShareOfLossPct: net < 0 ? (cost / Math.abs(net)) * 100 : null,
    reconciles: Math.abs((gross - cost) - net) < 0.05,
  };
}
