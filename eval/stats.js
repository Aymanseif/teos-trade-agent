/**
 * TEOS evaluation harness - stats.js
 *
 * Descriptive statistics for a multi-path study.
 *
 * Everything here is a plain arithmetic function with no dependency on the
 * trading system, because these numbers are the ones we are least able to trust
 * if they come out of the same code that produced the thing being measured.
 *
 * The one thing this file is deliberate about: POOLED statistics. A single
 * 2,500-tick path yields 83 bars, of which 43 can produce a decision, which
 * yields roughly 7 closed trades. Seven trades cannot support an expectancy
 * estimate. Trade-level statistics are therefore computed over trades POOLED
 * ACROSS SEEDS, and per-seed statistics are reported as a distribution
 * (median, worst, best) rather than as a mean.
 */

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs) {
  return medianImpl(xs);
}

function medianImpl(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }

/**
 * Annualisation is deliberately refused for spans under 30 days, matching the
 * production metrics. A 41-minute path scaled to a year is dominated by its
 * sampling interval, not by the strategy.
 */
export const MIN_ANNUALISABLE_MS = 30 * 24 * 3_600_000;

/** Sharpe from an equity series, per sampling period. Risk-free 0. */
export function perPeriodSharpe(equitySeries) {
  if (equitySeries.length < 3) return null;
  const rets = [];
  for (let i = 1; i < equitySeries.length; i += 1) {
    const prev = equitySeries[i - 1];
    rets.push(prev > 0 ? (equitySeries[i] - prev) / prev : 0);
  }
  const sd = stdev(rets);
  if (!sd || sd === 0) return null;
  return mean(rets) / sd;
}

export function maxDrawdownPct(series) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Per-trade statistics for a POOLED trade set.
 * @param {Array<{netPnlEgp:number, grossPnlEgp:number, holdMs:number}>} trades
 */
export function tradeStats(trades) {
  const nets = trades.map((t) => t.netPnlEgp);
  const gross = trades.map((t) => t.grossPnlEgp);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const flat = nets.length - wins.length - losses.length;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n: nets.length,
    wins: wins.length,
    losses: losses.length,
    flat,
    winRatePct: nets.length ? (wins.length / nets.length) * 100 : null,
    expectancyEgp: nets.length ? mean(nets) : null,
    expectancyGrossEgp: gross.length ? mean(gross) : null,
    totalNetEgp: sum(nets),
    totalGrossEgp: sum(gross),
    averageWinEgp: wins.length ? mean(wins) : null,
    averageLossEgp: losses.length ? mean(losses) : null,
    payoffRatio: wins.length && losses.length
      ? mean(wins) / Math.abs(mean(losses)) : null,
    profitFactor: grossLoss > 0 && grossProfit > 0 ? grossProfit / grossLoss : null,
    medianNetEgp: median(nets),
    bestNetEgp: nets.length ? Math.max(...nets) : null,
    worstNetEgp: nets.length ? Math.min(...nets) : null,
    stdevNetEgp: stdev(nets),
    medianHoldMs: median(trades.map((t) => t.holdMs)),
  };
}

/** Distribution of a per-run scalar across seeds. */
export function runDistribution(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { n: 0 };
  return {
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    stdev: stdev(xs),
    min: Math.min(...xs),
    p10: quantile(xs, 0.10),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    p90: quantile(xs, 0.90),
    max: Math.max(...xs),
    worst: Math.min(...xs),
    best: Math.max(...xs),
    /** Share of seeds that lost money. The single most useful number here. */
    lossRatePct: (xs.filter((v) => v < 0).length / xs.length) * 100,
  };
}

/** Group trades by a key function and summarise each group. */
export function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  const out = {};
  for (const [k, v] of m) out[k] = tradeStats(v);
  return out;
}

export function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round((v + Number.EPSILON) * f) / f;
}
