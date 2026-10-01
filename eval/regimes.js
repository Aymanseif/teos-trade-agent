/**
 * TEOS evaluation harness - regimes.js
 *
 * Tags every bar of a recorded path as TREND / RANGE and HIGHVOL / LOWVOL, so
 * expectancy can be reported per regime instead of as one blended number.
 *
 * WHY PERCENTILE AND NOT AN ABSOLUTE THRESHOLD
 * --------------------------------------------
 * The absolute volatility of this market is set by `instruments[].annualVolPct`
 * in the config - 8% for USD/EGP, 24% for SILVER/XAG - not by any market
 * reality. An absolute "high volatility" threshold would therefore just
 * re-encode the simulator's configuration, and the same absolute cut would
 * label every bar of USD/EGP low and every bar of SILVER/XAG high.
 *
 * So each bar is ranked against the distribution of its OWN path. That makes
 * the split balanced by construction (half the bars above, half below) and
 * therefore comparable across seeds and instruments, which is what a
 * per-regime expectancy comparison needs.
 *
 * The trend measure is the strategy's own: the SMA separation expressed in ATR
 * units. It is already used by `sma_cross` to score a crossover's conviction,
 * so reusing it means the regime label describes the same quantity the entry
 * signal reasons about. No new indicator is invented here.
 */

import { atr, sma } from '../src/agent/indicators.js';

/**
 * @param {Array<{high:number,low:number,close:number}>} candles
 * @returns {{atr:number[], trend:number[], atrPct:number[]}} aligned arrays, null before defined
 */
export function barFeatures(candles, { fast = 10, slow = 30, atrPeriod = 14 } = {}) {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const a = atr(high, low, close, atrPeriod);
  const f = sma(close, fast);
  const s = sma(close, slow);
  const atrPct = a.map((v, i) => (v != null && close[i] > 0 ? (v / close[i]) * 100 : null));
  const trend = a.map((v, i) => (v != null && v > 0 ? Math.abs((f[i] ?? 0) - (s[i] ?? 0)) / v : null));
  return { atr: a, trend, atrPct };
}

/** Rank-based percentile of `value` within `sorted`, 0..100. */
function percentileOf(sorted, value) {
  let lo = 0; let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return sorted.length === 0 ? null : (lo / sorted.length) * 100;
}

/**
 * Tag every bar. `undefined` where the indicators are not yet defined.
 * @returns {{ tags: Array<{regime:string, vol:string, atrPct:number|null, trend:number|null}>, stats: object }}
 */
export function tagRegimes(candles, opts = {}) {
  const { atr: atrArr, trend, atrPct } = barFeatures(candles, opts);
  const definedAtr = atrPct.filter((v) => v != null).sort((x, y) => x - y);
  const definedTrend = trend.filter((v) => v != null).sort((x, y) => x - y);
  const atrMedian = median(definedAtr);
  const trendMedian = median(definedTrend);

  const tags = atrPct.map((v, i) => {
    if (v == null || trend[i] == null) return { regime: null, vol: null, atrPct: null, trend: null };
    const volPctile = percentileOf(definedAtr, v);
    const trendPctile = percentileOf(definedTrend, trend[i]);
    return {
      regime: trendPctile >= 50 ? 'TREND' : 'RANGE',
      vol: volPctile >= 50 ? 'HIGHVOL' : 'LOWVOL',
      atrPct: v,
      trend: trend[i],
    };
  });

  return {
    tags,
    stats: {
      bars: candles.length,
      definedBars: definedAtr.length,
      atrMedianPct: atrMedian,
      trendMedianAtr: trendMedian,
      minAtrPct: definedAtr[0] ?? null,
      maxAtrPct: definedAtr[definedAtr.length - 1] ?? null,
      countTrend: tags.filter((t) => t.regime === 'TREND').length,
      countRange: tags.filter((t) => t.regime === 'RANGE').length,
      countHighVol: tags.filter((t) => t.vol === 'HIGHVOL').length,
      countLowVol: tags.filter((t) => t.vol === 'LOWVOL').length,
    },
  };
}

/** Tag every symbol of a run, ready to attach to the run object. */
export function tagRun(run) {
  const regimeBySymbol = {};
  const bySymbol = {};
  for (const [sym, candles] of Object.entries(run.candlesBySymbol)) {
    const { tags, stats } = tagRegimes(candles);
    regimeBySymbol[sym] = tags;
    bySymbol[sym] = stats;
  }
  run.regimeBySymbol = regimeBySymbol;
  run.regimeStats = bySymbol;
  return run;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
