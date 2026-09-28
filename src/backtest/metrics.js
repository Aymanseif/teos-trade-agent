/**
 * TEOS Trade Agent - backtest/metrics.js
 *
 * Performance metrics. Every function here is PURE: it takes a series or a list
 * of trades and returns numbers. Nothing in this file reads a clock, a database
 * or a config, which is what makes the numbers reproducible and testable.
 *
 * A note on what these numbers are and are not
 * ---------------------------------------------
 * The Sharpe ratio, the profit factor and the win rate describe how a strategy
 * behaved on ONE recorded price path, under ONE fee and slippage model, at ONE
 * position size. They are not evidence that the strategy is profitable, and a
 * backtest result is not a forecast. A positive Sharpe on a synthetic or single
 * historical path is a statement about that path, not about the future. The
 * report layer repeats this in every output it produces.
 */

import { drawdown } from '../paper/pnl.js';
import { roundEgp, roundTo } from '../core/money.js';

/** Per-period returns of a value series. The first observation has no return. */
export function returns(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    out.push(prev > 0 ? (series[i] - prev) / prev : 0);
  }
  return out;
}

export function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs, { sample = false } = {}) {
  if (xs.length < (sample ? 2 : 1)) return 0;
  const m = mean(xs);
  const sq = xs.reduce((a, b) => a + (b - m) ** 2, 0);
  return Math.sqrt(sq / (xs.length - (sample ? 1 : 0)));
}

/**
 * Annualised Sharpe ratio, risk-free rate 0.
 *
 * `periodsPerYear` converts the per-period return into an annual figure. It MUST
 * match the sampling interval of the series: passing a per-tick Sharpe with a
 * per-year period count produces a number that is off by orders of magnitude,
 * which is a common and serious backtesting error.
 */
export function sharpeRatio(series, { periodsPerYear = 252, riskFreeRate = 0 } = {}) {
  const rs = returns(series);
  if (rs.length < 2) return null;
  const rf = riskFreeRate / periodsPerYear;
  const excess = rs.map((r) => r - rf);
  const sd = stdev(excess, { sample: true });
  if (!(sd > 0)) return null;
  return roundTo((mean(excess) / sd) * Math.sqrt(periodsPerYear), 4);
}

/** Annualised Sortino: same, but only downside deviation is penalised. */
export function sortinoRatio(series, { periodsPerYear = 252, riskFreeRate = 0 } = {}) {
  const rs = returns(series);
  if (rs.length < 2) return null;
  const rf = riskFreeRate / periodsPerYear;
  const excess = rs.map((r) => r - rf);
  const downside = excess.filter((r) => r < 0);
  if (downside.length === 0) return null;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / excess.length);
  if (!(dd > 0)) return null;
  return roundTo((mean(excess) / dd) * Math.sqrt(periodsPerYear), 4);
}

/**
 * Per-period (NOT annualised) Sharpe and Sortino.
 *
 * These are the honest numbers for a short run. A Sharpe of 3,153,600 periods
 * per year multiplies the per-period ratio by 1,776, so a 50-minute backtest
 * with a per-period Sharpe of -0.05 reports "-296.59" as its Sharpe ratio. That
 * is not a high or low risk-adjusted return; it is a short run being scaled to
 * a horizon it contains no information about. The annualised figures are
 * therefore suppressed below `MIN_ANNUALISABLE_DAYS`, and the per-period values
 * are reported in their place with the sampling interval attached.
 */
export function perPeriodSharpe(series, { riskFreeRate = 0 } = {}) {
  const rs = returns(series);
  if (rs.length < 2) return null;
  const excess = rs.map((r) => r - riskFreeRate);
  const sd = stdev(excess, { sample: true });
  if (!(sd > 0)) return null;
  return roundTo(mean(excess) / sd, 6);
}

export function perPeriodSortino(series, { riskFreeRate = 0 } = {}) {
  const rs = returns(series);
  if (rs.length < 2) return null;
  const excess = rs.map((r) => r - riskFreeRate);
  const downside = excess.filter((r) => r < 0);
  if (downside.length === 0) return null;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / excess.length);
  if (!(dd > 0)) return null;
  return roundTo(mean(excess) / dd, 6);
}

/**
 * A run shorter than this is not annualised at all.
 *
 * Thirty days is the conventional floor. Below it, extrapolating a few dozen
 * samples to a year produces figures whose sign and magnitude are dominated by
 * the sampling interval rather than by the strategy.
 */
export const MIN_ANNUALISABLE_DAYS = 30;

const MS_PER_YEAR = 365 * 24 * 3600 * 1000;
const MS_PER_MONTH = 30 * 24 * 3600 * 1000;

/** Largest peak-to-trough decline of the series, in EGP and in percent. */
export function maxDrawdown(series) {
  const d = drawdown(series);
  return { maxDrawdownEgp: d.maxDrawdownEgp, maxDrawdownPct: d.maxDrawdownPct };
}

/** Longest run of consecutive losing periods. */
export function losingStreak(series) {
  let best = 0; let current = 0;
  for (const r of returns(series)) {
    current = r < 0 ? current + 1 : 0;
    if (current > best) best = current;
  }
  return best;
}

/** Milliseconds held for one closed trade, or null if either timestamp is absent. */
function holdMsOf(t) {
  if (Number.isFinite(t.closedMs) && Number.isFinite(t.openedMs)) return t.closedMs - t.openedMs;
  if (Number.isFinite(t.closed_ms) && Number.isFinite(t.opened_ms)) return t.closed_ms - t.opened_ms;
  const opened = t.openedMs ?? t.opened_ms ?? Date.parse(t.opened_at ?? '');
  const closed = t.closedMs ?? t.closed_ms ?? (t.closed_at ? Date.parse(t.closed_at) : NaN);
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null;
  return closed - opened;
}

/**
 * NET P&L of one closed round trip, in EGP.
 *
 * Realized P&L as recorded on a position is GROSS: fees and slippage are charged
 * against cash separately, so summing the raw `realized_pnl_egp` column would
 * quietly overstate every trade by the cost of trading it. Costs are subtracted
 * here so the trade statistics and the equity curve are measured the same way.
 */
function tradeNetPnl(t) {
  const realized = Number(t.realizedPnlEgp ?? t.realized_pnl_egp ?? 0);
  const fees = Number(t.feesPaidEgp ?? t.fees_paid_egp ?? 0);
  const slippage = Number(t.slippageCostEgp ?? t.slippage_cost_egp ?? 0);
  return realized - fees - slippage;
}

/**
 * Trade-level statistics.
 *
 * The returned `netPnlEgp` is the sum over CLOSED round trips only. It is
 * generally NOT equal to the portfolio `netPnlEgp`, because unrealised P&L on
 * still-open positions (and the cost of opening them) belongs to the equity
 * curve and not to a closed trade. The difference is a legitimate open P&L, not
 * a reconciliation error, and the two figures are reported under separate names
 * so they cannot be confused for one another.
 *
 * @param {Array<{realizedPnlEgp:number, ...}>} trades closed round trips
 */
export function tradeStatistics(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      tradeCount: 0, wins: 0, losses: 0, breakeven: 0, winRatePct: null,
      grossProfitEgp: 0, grossLossEgp: 0, netPnlEgp: 0,
      profitFactor: null, expectancyEgp: 0, averageWinEgp: 0, averageLossEgp: 0,
      largestWinEgp: 0, largestLossEgp: 0, averageHoldMs: 0, payoffRatio: null,
    };
  }
  const pnls = trades.map(tradeNetPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const flats = pnls.filter((p) => p === 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const net = pnls.reduce((a, b) => a + b, 0);
  const holds = trades.map(holdMsOf).filter((v) => Number.isFinite(v));

  return {
    tradeCount: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: flats.length,
    winRatePct: roundTo((wins.length / n) * 100, 4),
    grossProfitEgp: roundEgp(grossProfit),
    grossLossEgp: roundEgp(grossLoss),
    netPnlEgp: roundEgp(net),
    // With no losses the profit factor is unbounded, not 0 and not 1.
    profitFactor: grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : (grossProfit > 0 ? null : 0),
    expectancyEgp: roundEgp(net / n),
    averageWinEgp: wins.length ? roundEgp(grossProfit / wins.length) : 0,
    averageLossEgp: losses.length ? roundEgp(-grossLoss / losses.length) : 0,
    largestWinEgp: wins.length ? roundEgp(Math.max(...wins)) : 0,
    largestLossEgp: losses.length ? roundEgp(Math.min(...losses)) : 0,
    averageHoldMs: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0,
    payoffRatio: (losses.length && wins.length)
      ? roundTo((grossProfit / wins.length) / (grossLoss / losses.length), 4)
      : null,
  };
}

/**
 * The full metric set for one completed run.
 *
 * @param {object} p
 * @param {number[]} p.equitySeries  ordered equity observations
 * @param {number}   p.startingCapitalEgp
 * @param {Array}    p.trades        closed round trips
 * @param {object}   p.costs         { feesPaidEgp, slippageCostEgp }
 * @param {number}   p.elapsedMs
 * @param {number}   p.equitySampleMs spacing between equity observations
 */
export function computeMetrics({
  equitySeries, startingCapitalEgp, trades = [], costs = {}, elapsedMs = 0, equitySampleMs = 1000,
}) {
  const equity = equitySeries.filter((v) => Number.isFinite(v));
  const trades1 = tradeStatistics(trades);
  const dd = maxDrawdown(equity);
  const first = equity[0] ?? startingCapitalEgp;
  const last = equity[equity.length - 1] ?? startingCapitalEgp;
  const periodsPerYear = equitySampleMs > 0 ? Math.max(1, Math.round((365 * 24 * 3600 * 1000) / equitySampleMs)) : 252;

  const totalReturnPct = first > 0 ? roundTo(((last - first) / first) * 100, 4) : 0;
  const years = elapsedMs > 0 ? elapsedMs / MS_PER_YEAR : null;
  // Annualised figures only mean anything over a meaningful span. A 3-hour
  // backtest multiplied up to a year is a number with no interpretation: the
  // sampling interval, not the strategy, decides its sign and size. Below the
  // floor the annualised values are reported as null and the per-period values
  // are given instead, with the interval they were measured over.
  const annualisable = Boolean(years && years * 365 >= MIN_ANNUALISABLE_DAYS);
  const cagrPct = annualisable && first > 0 && last > 0
    ? roundTo((Math.pow(last / first, 1 / years) - 1) * 100, 4)
    : null;

  const fees = roundEgp(costs.feesPaidEgp ?? 0);
  const slippage = roundEgp(costs.slippageCostEgp ?? 0);

  // `trades1` is spread FIRST and its aggregate is renamed, so a future
  // `tradeStatistics()` field can never silently shadow a portfolio-level one.
  // An earlier version of this file spread it last and let `netPnlEgp` be
  // overwritten by the closed-trade total, which made a report show a final
  // equity of 500.00 next to a net P&L of 0.84.
  const { netPnlEgp: closedTradeNetPnlEgp, ...tradeStats } = trades1;

  return {
    observations: equity.length,
    startingCapitalEgp: roundEgp(startingCapitalEgp),
    finalEquityEgp: roundEgp(last),
    netPnlEgp: roundEgp(last - startingCapitalEgp),
    totalReturnPct,
    cagrPct,
    annualisable,
    annualisationFloorDays: MIN_ANNUALISABLE_DAYS,
    sharpeRatio: annualisable ? sharpeRatio(equity, { periodsPerYear }) : null,
    sortinoRatio: annualisable ? sortinoRatio(equity, { periodsPerYear }) : null,
    perPeriodSharpe: perPeriodSharpe(equity),
    perPeriodSortino: perPeriodSortino(equity),
    ...dd,
    maxLosingStreak: losingStreak(equity),
    volatilityAnnualPct: annualisable
      ? roundTo((stdev(returns(equity), { sample: true }) ?? 0) * Math.sqrt(periodsPerYear) * 100, 4)
      : null,
    volatilityPerPeriodPct: roundTo((stdev(returns(equity), { sample: true }) ?? 0) * 100, 6),
    ...tradeStats,
    closedTradeNetPnlEgp,
    /** closedTradeNetPnlEgp + unrealised P&L still open at the end of the run. */
    openPnlEgp: roundEgp((last - startingCapitalEgp) - closedTradeNetPnlEgp),
    feesPaidEgp: fees,
    slippageCostEgp: slippage,
    totalTradingCostEgp: roundEgp(fees + slippage),
    /**
     * Equity-based P&L is ALREADY net of every cost: fees and slippage are
     * debited from cash as they happen, so they are inside `equityEgp` and
     * therefore inside `netPnlEgp`. Subtracting them again - which an earlier
     * version of this file did, reporting a EGP -7.98 loss as EGP -15.37 - counts
     * the same EGP twice. The cost drag is instead shown by adding them back to
     * get the gross figure the book would have had with free, frictionless
     * execution.
     */
    netPnlAfterCostsEgp: roundEgp(last - startingCapitalEgp),
    grossPnlBeforeCostsEgp: roundEgp(last - startingCapitalEgp + fees + slippage),
    elapsedMs,
    equitySampleMs,
    periodsPerYear,
    disclaimer: 'Descriptive statistics for one recorded price path. Not a forecast and not a profitability claim.',
  };
}
