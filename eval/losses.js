/**
 * TEOS evaluation harness - losses.js
 *
 * Ranks the causes of loss from MEASURED data only.
 *
 * THE IDENTITY, AND WHY IT IS NOT THE OBVIOUS ONE
 * ----------------------------------------------
 * The tempting decomposition is
 *
 *     net = gross + (-cost)
 *
 * and it holds exactly: the engine reports `grossPnlBeforeCostsEgp`,
 * `feesPaidEgp`, `slippageCostEgp` and `netPnlEgp`, and gross - cost === net.
 *
 * But `grossPnlBeforeCostsEgp` is an EQUITY-based figure: final equity minus
 * starting capital, plus costs back. It is NOT the sum of closed trades'
 * realised P&L. Measured on the canary:
 *
 *     engine gross (equity-based)            -0.05
 *     sum of closed trades' realised P&L     -1.02
 *     unrealised P&L on still-open positions -0.08
 *     -> unattributed residual              -1.05
 *
 * That residual is real, not a bug in this file. It is mark-to-market movement
 * on positions that were open when the run ended, plus the cost of fills that
 * never became a closed trade (the canary shows 2.45 EGP of fees charged but
 * only 1.97 EGP attributable to any position row). Collapsing it into another
 * bucket would hide a genuine gap between two definitions of "gross", so it is
 * reported as its own measured term and the ranking closes against it.
 *
 * The closing identity is therefore:
 *
 *     net = [closed trades' realised gross, by exit path]
 *         + [unrealised on open positions]
 *         + [unattributed equity residual]
 *         - [fees + slippage]
 */

import { sum, round, tradeStats } from './stats.js';
import { pooledCosts } from './costs.js';
import { EXIT } from './arms.js';

/**
 * @param {Array}  runs     compact summaries (see summary.js)
 * @param {Array}  trades   pooled closed trades for those runs
 * @param {object} [signalTotals] summed `signalsByKind` across runs
 */
export function rankCauses({ runs, trades, signalTotals = {} }) {
  const costs = pooledCosts(runs);

  // ---- closed trades' realised P&L, attributed by exit path -------------
  const byExit = {};
  for (const t of trades) {
    const k = t.exitKind ?? EXIT.UNKNOWN;
    (byExit[k] ??= []).push(t);
  }
  const exitTerms = Object.entries(byExit).map(([kind, list]) => {
    const st = tradeStats(list);
    return {
      kind,
      n: list.length,
      grossPnlEgp: round(sum(list.map((t) => t.grossPnlEgp))),
      netPnlEgp: round(sum(list.map((t) => t.netPnlEgp))),
      feesEgp: round(sum(list.map((t) => t.feesEgp))),
      slippageEgp: round(sum(list.map((t) => t.slippageEgp))),
      winRatePct: round(st.winRatePct, 1),
      medianHoldMs: st.medianHoldMs,
      /** How many exit DECISIONS of this kind were emitted across the runs. */
      signalsEmitted: signalTotals[kind] ?? 0,
      /** Of those, how many actually closed a position. */
      closesFromSignal: list.length,
    };
  });

  const closed = trades.length;
  const closedRealisedGross = round(sum(trades.map((t) => t.grossPnlEgp)));
  const openPnl = round(sum(runs.map((r) => r.metrics.openPnlEgp ?? 0)));
  const unattributed = round(costs.grossPnlEgp - closedRealisedGross - openPnl);

  // ---- candidates, each a MEASURED amount with a sign -------------------
  const candidates = [];

  candidates.push({
    id: 'cost-drag',
    term: 'Trading costs (fees + spread + slippage)',
    amountEgp: round(-costs.totalCostEgp),
    evidence: `${round(costs.costBpsOfNotional, 1)} bps of traded notional`
      + `${costs.costShareOfLossPct != null ? `; ${round(costs.costShareOfLossPct, 1)}% of the total loss` : ''}`,
  });

  for (const t of exitTerms) {
    candidates.push({
      id: `exit-${t.kind.toLowerCase()}`,
      term: `Realised gross P&L of closed trades that exited via ${t.kind}`,
      amountEgp: t.grossPnlEgp,
      evidence: `${t.n} trade(s), win rate ${t.winRatePct}%, ${t.signalsEmitted} exit signal(s) emitted`,
    });
  }

  candidates.push({
    id: 'open-pnl',
    term: 'Unrealised P&L on positions still open when the runs ended',
    amountEgp: openPnl,
    evidence: `${sum(runs.map((r) => r.openPositionCount ?? 0))} position(s) open at the end`,
  });

  candidates.push({
    id: 'unattributed',
    term: 'Unattributed equity residual (mark-to-market plus fills that never closed a trade)',
    amountEgp: unattributed,
    evidence: 'engine gross is equity-based; this is the gap to the sum of realised '
      + 'and unrealised P&L. It is measured, not estimated.',
  });

  const ranked = candidates
    .filter((c) => c.amountEgp != null && Number.isFinite(c.amountEgp))
    .sort((a, b) => Math.abs(b.amountEgp) - Math.abs(a.amountEgp));

  return {
    costs,
    ranked,
    top3: ranked.slice(0, 3),
    exitMix: {
      closed,
      stopExits: trades.filter((t) => t.exitKind === EXIT.STOP).length,
      signalExits: trades.filter((t) => t.exitKind === EXIT.SIGNAL).length,
      takeProfitExits: trades.filter((t) => t.exitKind === EXIT.TAKE_PROFIT).length,
      stopFireRatePct: closed ? (trades.filter((t) => t.exitKind === EXIT.STOP).length / closed) * 100 : null,
    },
    exitTerms,
    verify: verify(ranked, costs, closedRealisedGross, openPnl, unattributed),
  };
}

/**
 * Closure check. The ranked terms must sum to the measured net P&L. If they do
 * not, the ranking is wrong and the report says so instead of publishing it.
 */
function verify(ranked, costs, closedRealisedGross, openPnl, unattributed) {
  const sumOf = (pred) => ranked.filter(pred).reduce((s, c) => s + c.amountEgp, 0);
  const costTerm = sumOf((c) => c.id === 'cost-drag');
  const grossTerms = sumOf((c) => c.id !== 'cost-drag');

  const grossRebuilt = grossTerms;
  const residual = grossRebuilt - costs.grossPnlEgp;
  const netRebuilt = grossRebuilt + costTerm;
  const netResidual = netRebuilt - costs.netPnlEgp;

  return {
    closedRealisedGrossEgp: closedRealisedGross,
    openPnlEgp: openPnl,
    unattributedEgp: unattributed,
    grossFromRankedTermsEgp: round(grossRebuilt),
    engineGrossPnlEgp: round(costs.grossPnlEgp),
    grossResidualEgp: round(residual),
    netFromRankedTermsEgp: round(netRebuilt),
    engineNetPnlEgp: round(costs.netPnlEgp),
    netResidualEgp: round(netResidual),
    /** The ranked terms account for the whole loss, to the cent. */
    closes: Math.abs(netResidual) < 0.05,
    /**
     * A GUARD AGAINST A VACUOUS DECOMPOSITION.
     *
     * `unattributed` is derived as the residual, so the terms close by
     * construction and closure alone proves nothing. What matters is whether the
     * unattributed bucket is large enough to be carrying the whole answer. When
     * it is, the gross attribution explains nothing, and the report must say so
     * rather than present a tidy ranking that means nothing.
     */
    grossAttributionIsInformative:
      Math.abs(unattributed) < Math.abs(closedRealisedGross) + Math.abs(openPnl),
    unattributedShareOfGrossPct: Math.abs(costs.grossPnlEgp) > 0.005
      ? round((Math.abs(unattributed) / Math.abs(costs.grossPnlEgp)) * 100, 1) : null,
    /** The engine agrees with itself: gross - cost === net. */
    netIdentityHolds: costs.reconciles,
  };
}