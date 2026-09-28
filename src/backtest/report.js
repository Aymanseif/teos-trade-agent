/**
 * TEOS Trade Agent - backtest/report.js
 *
 * Renders a backtest result. Two formats: a terminal/markdown text report and
 * a machine-readable JSON summary.
 *
 * The disclaimer is not decoration. A backtest number - a Sharpe of 2.1, a
 * profit factor of 1.8 - is very easy to read as "this makes money", and it is
 * not a statement about that at all. It describes how one set of rules behaved
 * on one recorded price path, at one size, with one cost model, and it says
 * nothing about the future. Every report this module produces opens with that
 * caveat, and the summary object carries it as a field.
 */

import { roundEgp, roundTo } from '../core/money.js';

export const DISCLAIMER = [
  'PAPER/BACKTEST SIMULATION ONLY. No real money was used and none can be.',
  'These figures describe how one set of rules behaved on ONE recorded price path',
  'under ONE fee and slippage model at ONE position size. They are not a forecast,',
  'not a claim of profitability, and not evidence that this strategy will profit.',
  'Live results will differ. Past or simulated performance implies nothing about future results.',
].join('\n');

const num = (v, digits = 2, suffix = '') => (v === null || v === undefined ? 'n/a' : `${v.toFixed(digits)}${suffix}`);
const egp = (v) => (v === null || v === undefined ? 'n/a' : `EGP ${Number(v).toFixed(2)}`);

function table(rows) {
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}

/** Human-readable report. */
export function toBacktestReport(result) {
  const m = result.metrics ?? {};
  const c = result.counts ?? {};
  const p = result.params ?? {};

  const lines = [];
  lines.push('='.repeat(78));
  lines.push('TEOS TRADE AGENT - BACKTEST REPORT');
  lines.push('='.repeat(78));
  lines.push(DISCLAIMER);
  lines.push('');
  lines.push('RUN');
  lines.push(table([
    ['id', result.backtestId],
    ['mode', `${result.mode} (isolated database; cannot read or write PAPER rows)`],
    ['strategy', result.strategyId],
    ['parameters', Object.entries(p).map(([k, v]) => `${k}=${v}`).join('  ') || 'defaults'],
    ['price history seed', String(result.seed)],
    ['ticks replayed', String(result.ticks)],
    ['simulated span', `${(result.elapsedMs / 3_600_000).toFixed(2)} h`],
  ]));
  lines.push('');
  lines.push('HEADLINE FIGURES');
  lines.push(table([
    ['starting capital', egp(m.startingCapitalEgp)],
    ['final equity', egp(m.finalEquityEgp)],
    ['net P&L (equity-based)', egp(m.netPnlEgp)],
    ['  of which closed trades', egp(m.closedTradeNetPnlEgp)],
    ['  of which still open', egp(m.openPnlEgp)],
    ['P&L before costs', egp(m.grossPnlBeforeCostsEgp)],
    ['trading cost', `-${egp(m.totalTradingCostEgp)}`],
    ['net P&L after costs', egp(m.netPnlAfterCostsEgp)],
    ['total return', num(m.totalReturnPct, 2, '%')],
    ['annualised return', m.annualisable === false ? 'n/a (span too short to annualise)' : num(m.cagrPct, 2, '%')],
  ]));
  lines.push('');
  lines.push('RISK');
  if (m.annualisable === false) {
    lines.push(`  This run spans ${((result.elapsedMs ?? 0) / 3_600_000).toFixed(1)} h, under the `
      + `${m.annualisationFloorDays ?? 30}-day floor, so no figure below is scaled to a year.`);
    lines.push('  A short run annualised is dominated by its sampling interval, not by the strategy:');
    lines.push('  the same ratio measured on 1-minute samples instead of 10-second ones would');
    lines.push('  differ by a factor of several thousand while nothing about the trading changed.');
    lines.push('');
  }
  lines.push(table([
    ['Sharpe ratio (annualised)', m.annualisable === false ? 'n/a (span too short to annualise)' : num(m.sharpeRatio, 3)],
    ['Sharpe ratio (per period)', num(m.perPeriodSharpe, 4)],
    ['Sortino ratio (annualised)', m.annualisable === false ? 'n/a (span too short to annualise)' : num(m.sortinoRatio, 3)],
    ['Sortino ratio (per period)', num(m.perPeriodSortino, 4)],
    ['max drawdown', `${egp(m.maxDrawdownEgp)}  (${num(m.maxDrawdownPct, 2, '%')} of peak)`],
    ['max losing streak', `${m.maxLosingStreak} periods`],
    ['volatility (per period)', num(m.volatilityPerPeriodPct, 4, '%')],
    ['volatility (annualised)', m.annualisable === false ? 'n/a (span too short to annualise)' : `${num(m.volatilityAnnualPct, 2, '%')}`],
    ['sampling interval', m.equitySampleMs ? `${(m.equitySampleMs / 1000).toFixed(0)} s` : 'n/a'],
  ]));
  lines.push('');
  lines.push('TRADES');
  lines.push(table([
    ['closed trades', String(m.tradeCount ?? 0)],
    ['wins / losses / flat', `${m.wins ?? 0} / ${m.losses ?? 0} / ${m.breakeven ?? 0}`],
    ['win rate', num(m.winRatePct, 2, '%')],
    ['gross profit', egp(m.grossProfitEgp)],
    ['gross loss', egp(m.grossLossEgp)],
    ['profit factor', m.profitFactor === null ? 'n/a (no losing trades)' : num(m.profitFactor, 3)],
    ['expectancy per trade', egp(m.expectancyEgp)],
    ['payoff ratio', num(m.payoffRatio, 3)],
    ['average hold', m.averageHoldMs ? `${(m.averageHoldMs / 1000).toFixed(0)} s` : 'n/a'],
  ]));
  lines.push('');
  lines.push('COSTS (these are charged on every fill, not assumed away)');
  lines.push(table([
    ['fees paid', egp(m.feesPaidEgp)],
    ['slippage cost', egp(m.slippageCostEgp)],
    ['total trading cost', egp(m.totalTradingCostEgp)],
  ]));
  lines.push('');
  lines.push('PIPELINE ACTIVITY');
  lines.push(table([
    ['agent decisions', String(c.decisions ?? 0)],
    ['risk evaluations', String(c.riskDecisions ?? 0)],
    ['sentinel verdicts', String(c.sentinelDecisions ?? 0)],
    ['orders submitted', String(c.orders ?? 0)],
    ['fills', String(c.fills ?? 0)],
    ['blocked by risk engine', String(c.blocked ?? 0)],
    ['quarantined by Sentinel', String(c.quarantined ?? 0)],
    ['emergency stops', String(c.emergencyStops ?? 0)],
    ['errors', String(c.errors ?? 0)],
  ]));
  lines.push('');
  lines.push('INTERPRETATION LIMITS');
  lines.push('  - One price path. Re-run with a different seed and these numbers change;');
  lines.push('    the spread across seeds is the honest measure of how much of this result');
  lines.push('    is the strategy and how much is the particular path it was measured on.');
  lines.push('  - Synthetic data. The Phase 1 price history is generated by a seeded');
  lines.push('    simulator, not recorded real markets. It exercises the machinery; it');
  lines.push('    says nothing about any real instrument.');
  lines.push('  - Fees and slippage are modelled, not observed.');
  lines.push('  - Long-only, cash-funded, no leverage: results do not extrapolate to any');
  lines.push('    strategy that uses leverage, shorting, options or derivatives.');
  lines.push('  - Net P&L above is equity-based and therefore already net of fees and');
  lines.push('    slippage; only the closed-trade subtotal has been fully realised.');
  lines.push('='.repeat(78));
  return lines.join('\n');
}

/** Machine-readable summary, safe to diff or store. */
export function toBacktestSummary(result) {
  const m = result.metrics ?? {};
  return {
    backtestId: result.backtestId,
    mode: result.mode,
    strategyId: result.strategyId,
    params: result.params,
    seed: result.seed,
    ticks: result.ticks,
    elapsedMs: result.elapsedMs,
    startingCapitalEgp: result.startingCapitalEgp,
    finalEquityEgp: result.finalEquityEgp,
    counts: result.counts,
    metrics: m,
    equitySeries: result.equitySeries,
    disclaimer: m.disclaimer ?? DISCLAIMER,
    isProfitabilityClaim: false,
  };
}

/**
 * Compare several runs side by side. Reports the SPREAD of each headline metric
 * rather than picking a winner, because choosing the best-looking parameter set
 * from a handful of runs and calling it "the strategy" is how backtests start
 * lying.
 */
export function compareRuns(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { count: 0, runs: [], disclaimer: DISCLAIMER };
  }
  const keys = ['netPnlEgp', 'totalReturnPct', 'perPeriodSharpe', 'maxDrawdownPct', 'winRatePct', 'profitFactor', 'tradeCount'];
  const runs = results.map((r) => ({
    backtestId: r.backtestId,
    strategyId: r.strategyId,
    seed: r.seed,
    ticks: r.ticks,
    ...Object.fromEntries(keys.map((k) => [k, r.metrics?.[k] ?? null])),
  }));
  const spread = {};
  for (const k of keys) {
    const xs = runs.map((r) => r[k]).filter((v) => v !== null && Number.isFinite(v));
    spread[k] = xs.length === 0 ? null : {
      min: Math.min(...xs), max: Math.max(...xs), range: roundTo(Math.max(...xs) - Math.min(...xs), 6),
    };
  }
  return {
    count: runs.length,
    runs,
    spread,
    note: 'A spread, not a ranking. The best-looking single run is the expected result of searching many runs; it is not evidence.',
    disclaimer: DISCLAIMER,
  };
}

export { roundEgp, roundTo };
