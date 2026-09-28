/**
 * TEOS Trade Agent - backtest/replay-feed.js
 *
 * Historical replay. A backtest is only worth running if the price path is
 * FIXED IN ADVANCE and cannot be influenced by anything the strategy does.
 * This module is therefore split in two:
 *
 *   1. `generateHistory()` - produces a recorded price series ONCE, from a
 *      seed, and hands back a plain serialisable object. It never sees a
 *      strategy, an order or a position.
 *   2. `ReplayFeed`         - replays that recorded series tick by tick. It is
 *      a drop-in replacement for `MarketSimulator` behind `MockBroker`, so the
 *      matching engine, the fee and slippage models, the risk engine and the
 *      Sentinel are literally the same code in BACKTEST and in PAPER.
 *
 * A backtest therefore measures the STRATEGY against a price path, and the only
 * thing that changes between a backtest and live paper trading is where the
 * prices came from.
 *
 * SERIES FORMAT (compact on purpose - a 50k-tick, 5-symbol history is ~2 MB):
 *
 *   {
 *     version: 1,
 *     seed, generatedAt, ticks, tickMs, ticksPerCandle,
 *     symbols: ['USD/EGP', ...],
 *     // per symbol: arrays of [mid, spreadBps] aligned by tick index
 *     series: { 'USD/EGP': [[mid, spreadBps], ...], ... }
 *   }
 *
 * bid/ask are reconstructed as mid +/- spread/2, which is exactly how the live
 * simulator quotes, so a replayed quote is indistinguishable from a live one.
 */

import { MarketSimulator } from '../broker/mock/market-simulator.js';
import { ValidationError } from '../core/errors.js';

export const HISTORY_VERSION = 1;

/**
 * Build a recorded price history. Deterministic for a given (seed, ticks,
 * instruments, market config).
 *
 * The generator is a separate module-level function rather than a method on
 * ReplayFeed precisely so that it cannot be reached during a replay: generate
 * once, save to disk, then replay only what was saved.
 */
export function generateHistory({ config, ticks, seed = null, startMs = Date.UTC(2025, 0, 1) }) {
  if (!Number.isInteger(ticks) || ticks < 2) {
    throw new ValidationError('generateHistory requires an integer tick count >= 2.', { ticks });
  }
  const useSeed = seed ?? config.market.seed;
  const sim = new MarketSimulator(config.market, config.instruments, { seed: useSeed });
  const series = {};
  for (const inst of config.instruments) series[inst.symbol] = new Array(ticks);

  let t = 0;
  while (t < ticks) {
    for (const q of sim.tick()) {
      series[q.symbol][t] = [q.mid, q.spreadBps];
    }
    t += 1;
    if (t % config.market.ticksPerCandle === 0) sim.rollCandle();
  }

  return {
    version: HISTORY_VERSION,
    seed: useSeed,
    generatedAtIso: new Date(startMs).toISOString(),
    startMs,
    ticks,
    tickMs: config.market.tickMs,
    ticksPerCandle: config.market.ticksPerCandle,
    symbols: config.instruments.map((i) => i.symbol),
    series,
  };
}

/** Structural validation. A corrupt history must fail loudly, not silently
 *  produce a plausible-looking but meaningless backtest. */
export function validateHistory(history) {
  const fail = (msg, extra = {}) => { throw new ValidationError(`Invalid price history: ${msg}`, extra); };
  if (!history || typeof history !== 'object') fail('not an object');
  if (history.version !== HISTORY_VERSION) fail(`unsupported version ${history.version}`, { expected: HISTORY_VERSION });
  if (!Number.isInteger(history.ticks) || history.ticks < 2) fail('ticks must be an integer >= 2');
  if (!Array.isArray(history.symbols) || history.symbols.length === 0) fail('symbols must be a non-empty array');
  if (!history.series || typeof history.series !== 'object') fail('series is missing');
  for (const sym of history.symbols) {
    const rows = history.series[sym];
    if (!Array.isArray(rows)) fail(`series for ${sym} is missing`);
    if (rows.length !== history.ticks) fail(`series for ${sym} has ${rows.length} rows, expected ${history.ticks}`);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 2) fail(`series ${sym}[${i}] is malformed`);
      if (!(r[0] > 0) || !Number.isFinite(r[0])) fail(`series ${sym}[${i}] has a non-positive mid: ${r[0]}`);
      if (!(r[1] >= 0) || !Number.isFinite(r[1])) fail(`series ${sym}[${i}] has an invalid spread: ${r[1]}`);
    }
  }
  return true;
}

/**
 * Replays a recorded history. Implements the market-source contract that
 * `MockBroker` consumes:
 *
 *   tick()            -> Quote[]        (one per symbol, for the next index)
 *   rollCandle()      -> Candle[]
 *   candles(symbol)   -> Candle[]
 *   has(symbol)       -> boolean
 *   sequence          -> number
 */
export class ReplayFeed {
  #history;
  #cfg;
  #index = 0;
  #seq = 0;
  #ticksSinceCandle = 0;
  #last = new Map();
  #candles = new Map();
  #open = new Map();
  #high = new Map();
  #low = new Map();
  #volume = new Map();
  #exhausted = false;

  constructor(history, config) {
    validateHistory(history);
    this.#history = history;
    this.#cfg = config;
    for (const sym of history.symbols) {
      this.#candles.set(sym, []);
      this.#open.set(sym, history.series[sym][0][0]);
      this.#high.set(sym, history.series[sym][0][0]);
      this.#low.set(sym, history.series[sym][0][0]);
      this.#volume.set(sym, 0);
    }
  }

  get history() { return this.#history; }
  get index() { return this.#index; }
  get sequence() { return this.#seq; }
  get exhausted() { return this.#exhausted; }
  get totalTicks() { return this.#history.ticks; }
  /** TicksPerCandle comes from the RECORD, not from the live config. */
  get ticksPerCandle() { return this.#history.ticksPerCandle ?? this.#cfg.market.ticksPerCandle; }

  symbols() { return [...this.#history.symbols]; }
  has(symbol) { return this.#history.series[symbol] !== undefined; }

  /** Reset to the first recorded tick. */
  rewind() {
    this.#index = 0;
    this.#seq = 0;
    this.#exhausted = false;
    this.#ticksSinceCandle = 0;
    for (const sym of this.#history.symbols) this.#candles.set(sym, []);
    return this;
  }

  tick() {
    if (this.#index >= this.#history.ticks) {
      this.#exhausted = true;
      return [];
    }
    this.#seq += 1;
    const i = this.#index;
    this.#index += 1;

    const out = [];
    for (const sym of this.#history.symbols) {
      const [mid, spreadBps] = this.#history.series[sym][i];
      const prev = this.#last.get(sym) ?? mid;
      const half = (spreadBps / 2 / 10_000) * mid;
      out.push({
        symbol: sym,
        mid,
        bid: Math.max(mid - half, 1e-9),
        ask: mid + half,
        last: mid,
        prevMid: prev,
        spreadBps,
        source: 'replay',
        seq: this.#seq,
        shock: 0,
      });
      this.#last.set(sym, mid);
      this.#high.set(sym, Math.max(this.#high.get(sym), mid));
      this.#low.set(sym, Math.min(this.#low.get(sym), mid));
      this.#volume.set(sym, this.#volume.get(sym) + 1000);
    }
    return out;
  }

  rollCandle() {
    const out = [];
    for (const sym of this.#history.symbols) {
      const candle = {
        symbol: sym,
        ts: this.#seq,
        open: this.#open.get(sym),
        high: this.#high.get(sym),
        low: this.#low.get(sym),
        close: this.#last.get(sym),
        volume: this.#volume.get(sym),
      };
      this.#candles.get(sym).push(candle);
      out.push(candle);
      this.#open.set(sym, candle.close);
      this.#high.set(sym, candle.close);
      this.#low.set(sym, candle.close);
      this.#volume.set(sym, 0);
    }
    return out;
  }

  candles(symbol) { return this.#candles.get(symbol) ?? []; }

  /** Cursor management so a caller can rewind after inspecting. */
  saveCursor() { return { index: this.#index, seq: this.#seq }; }
  restoreCursor(c) { this.#index = c.index; this.#seq = c.seq; this.#exhausted = false; return this; }
}

/**
 * A "historical" series made of a single repeating pattern, provided so the
 * replay path can be exercised against a series the reader can verify by eye
 * (and so a test can force an exact, known outcome).
 */
export function syntheticFlatHistory({ symbols, ticks, price = 100, spreadBps = 10, tickMs = 1000, ticksPerCandle = 30 }) {
  const series = {};
  for (const s of symbols) series[s] = Array.from({ length: ticks }, () => [price, spreadBps]);
  return {
    version: HISTORY_VERSION, seed: 0, generatedAtIso: new Date(0).toISOString(), startMs: 0,
    ticks, tickMs, ticksPerCandle, symbols, series,
  };
}
