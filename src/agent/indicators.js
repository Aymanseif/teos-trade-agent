/**
 * TEOS Trade Agent - agent/indicators.js
 *
 * Pure functions over plain arrays. No state, no clock, no side effects, so
 * every indicator is trivially unit-testable and deterministic.
 *
 * All functions return arrays aligned to the input where a per-bar value
 * exists, and `null` where the indicator is not yet defined (warm-up period).
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI (the standard definition used by most platforms). */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0; let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function trueRange(high, low, close) {
  const out = new Array(close.length).fill(null);
  for (let i = 0; i < close.length; i += 1) {
    if (i === 0) { out[i] = high[i] - low[i]; continue; }
    const pc = close[i - 1];
    out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc));
  }
  return out;
}

export function atr(high, low, close, period = 14) {
  const tr = trueRange(high, low, close);
  const out = new Array(close.length).fill(null);
  if (close.length < period) return out;
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < close.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Donchian channel: rolling max(high)/min(low) excluding the current bar. */
export function donchian(high, low, period) {
  const upper = new Array(high.length).fill(null);
  const lower = new Array(low.length).fill(null);
  for (let i = period; i < high.length; i += 1) {
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - period; j < i; j += 1) {
      if (high[j] > hi) hi = high[j];
      if (low[j] < lo) lo = low[j];
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const win = values.slice(i - period + 1, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / period;
    const v = win.reduce((a, b) => a + ((b - m) ** 2), 0) / period;
    out[i] = Math.sqrt(v);
  }
  return out;
}

export function slope(values, lookback = 5) {
  const out = new Array(values.length).fill(null);
  for (let i = lookback; i < values.length; i += 1) {
    const win = values.slice(i - lookback + 1, i + 1);
    const n = win.length;
    const mx = (n - 1) / 2;
    const my = win.reduce((a, b) => a + b, 0) / n;
    let num = 0; let den = 0;
    for (let j = 0; j < n; j += 1) { num += (j - mx) * (win[j] - my); den += (j - mx) ** 2; }
    out[i] = den === 0 ? 0 : num / den;
  }
  return out;
}

/** Bars-in-the-trend, used for confidence scoring. */
export function trendStrength(fast, slow) {
  const n = Math.min(fast.length, slow.length);
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (!isNum(fast[i]) || !isNum(slow[i]) || slow[i] === 0) continue;
    out[i] = (fast[i] - slow[i]) / slow[i];
  }
  return out;
}

/** Extract OHLCV arrays from a candle list for one symbol. */
export function toSeries(candles) {
  return {
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
  };
}

export function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (isNum(arr[i])) return arr[i];
  return null;
}

export function pctChange(a, b) {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  return (a - b) / b;
}
