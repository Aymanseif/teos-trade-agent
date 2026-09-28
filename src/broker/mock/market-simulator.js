/**
 * TEOS Trade Agent - broker/mock/market-simulator.js
 *
 * Deterministic synthetic market. NO external data source is contacted in
 * Phase 1 - there is no exchange API key and no network call anywhere in this
 * file or its callers.
 *
 * Price process per tick, per symbol:
 *   1. drift term            (small, from a slow random-walk "regime" value)
 *   2. diffusion term        (annualised vol scaled to the tick)
 *   3. mean reversion       (pulls price back toward a slow-moving fair value)
 *   4. jump term             (rare, large -> exercises the abnormal-price rule)
 *
 * The jump process matters: it is what proves the risk engine's
 * `price_sanity` / `abnormal price` stop actually fires.
 *
 * Candles are aggregated from ticks so strategies have a real OHLCV series.
 */

import { Rng } from './rng.js';

export class MarketSimulator {
  #cfg;
  #rng;
  #symbols = new Map();
  #seq = 0;
  #ticks = 0;

  constructor(marketConfig, instruments, { seed = null } = {}) {
    this.#cfg = marketConfig;
    this.#rng = new Rng(seed ?? marketConfig.seed ?? 1);
    for (const inst of instruments) {
      this.#symbols.set(inst.symbol, {
        inst,
        mid: inst.startPrice,
        prevMid: inst.startPrice,
        fair: inst.startPrice,
        regime: 0,
        tickOpen: inst.startPrice,
        tickHigh: inst.startPrice,
        tickLow: inst.startPrice,
        tickVolume: 0,
        spreadBps: (inst.spreadBpsMin + inst.spreadBpsMax) / 2,
        last: inst.startPrice,
        candles: [],
        shocks: 0,
      });
    }
  }

  get rng() { return this.#rng; }
  get sequence() { return this.#seq; }
  get tickCount() { return this.#ticks; }

  symbols() { return [...this.#symbols.keys()]; }

  has(symbol) { return this.#symbols.has(symbol); }

  /** Vol per tick derived from annualised vol and the tick count per year. */
  #volPerTick(annualVolPct) {
    const ticksPerYear = (365 * 24 * 60 * 60 * 1000) / this.#cfg.tickMs;
    return (annualVolPct / 100) / Math.sqrt(ticksPerYear);
  }

  /**
   * Advance every symbol one tick. Returns an array of quotes.
   * Deterministic given the seed and the tick count.
   */
  tick() {
    this.#seq += 1;
    this.#ticks += 1;
    const out = [];
    for (const [symbol, s] of this.#symbols) {
      const inst = s.inst;
      const volTick = this.#volPerTick(inst.annualVolPct);

      // 1. slow regime drift (AR(1))
      s.regime = 0.995 * s.regime + 0.005 * this.#rng.normal();
      const drift = s.regime * volTick * 0.35;

      // 2. diffusion
      const diffusion = volTick * this.#rng.normal();

      // 3. mean reversion toward a slow fair value
      s.fair = 0.9995 * s.fair + 0.0005 * s.mid;
      const reversion = ((s.fair - s.mid) / s.mid) * 0.02;

      let ret = drift + diffusion + reversion;

      // 4. rare jump
      // The jump size is capped by `maxTickJumpBps` so that ordinary simulated
      // volatility never trips the risk engine's abnormal-price rule. That
      // rule must stay meaningful: it is reserved for genuinely pathological
      // moves (bad tick, venue glitch), which are produced deliberately by
      // `forceJump` in tests and by the `injectFailure` path.
      if (this.#rng.bool(0.05)) {
        const cap = this.#cfg.maxTickJumpBps ?? 120;
        const jumpBps = Math.min(this.#rng.uniform(20, 350), cap);
        const sign = this.#rng.bool(50) ? 1 : -1;
        ret += sign * (jumpBps / 10_000);
        s.shocks += 1;
        s.lastShockBps = sign * jumpBps;
      }

      s.prevMid = s.mid;
      s.mid = Math.max(s.mid * (1 + ret), inst.tickSize);

      // spread widens with realised volatility of the last tick
      const moveBps = Math.abs((s.mid - s.prevMid) / s.prevMid) * 10_000;
      const widen = Math.min(moveBps * 0.5, (inst.spreadBpsMax - inst.spreadBpsMin));
      s.spreadBps = Math.max(inst.spreadBpsMin, Math.min(inst.spreadBpsMax, s.spreadBps * 0.9 + widen));

      s.tickHigh = Math.max(s.tickHigh, s.mid);
      s.tickLow = Math.min(s.tickLow, s.mid);
      s.tickVolume += 1000 * (1 + Math.abs(ret) * 100);
      s.last = s.mid;

      out.push(this.#quote(symbol, s));
    }
    return out;
  }

  #quote(symbol, s) {
    const half = (s.spreadBps / 2 / 10_000) * s.mid;
    const bid = Math.max(s.mid - half, s.inst.tickSize);
    const ask = s.mid + half;
    return {
      symbol,
      bid,
      ask,
      last: s.last,
      mid: s.mid,
      spreadBps: s.spreadBps,
      prevMid: s.prevMid,
      source: 'mock-simulator',
      seq: this.#seq,
      shock: s.lastShockBps ?? 0,
    };
  }

  /** Current quote without advancing the simulation. */
  peek(symbol) {
    const s = this.#symbols.get(symbol);
    if (!s) return null;
    return this.#quote(symbol, s);
  }

  peekAll() {
    return [...this.#symbols.keys()].map((sym) => this.#quote(sym, this.#symbols.get(sym)));
  }

  /** Roll the current tick into a candle and start a new one. */
  rollCandle() {
    const out = [];
    for (const [symbol, s] of this.#symbols) {
      out.push({
        symbol,
        ts: this.#seq,
        open: s.tickOpen,
        high: s.tickHigh,
        low: s.tickLow,
        close: s.mid,
        volume: s.tickVolume,
      });
      s.candles.push(out[out.length - 1]);
      s.tickOpen = s.mid;
      s.tickHigh = s.mid;
      s.tickLow = s.mid;
      s.tickVolume = 0;
    }
    return out;
  }

  candles(symbol) {
    return this.#symbols.get(symbol)?.candles ?? [];
  }

  /** Inject a controlled price shock. Used by tests and the CLI. */
  forceJump(symbol, bps) {
    const s = this.#symbols.get(symbol);
    if (!s) return null;
    s.mid = Math.max(s.mid * (1 + bps / 10_000), s.inst.tickSize);
    s.last = s.mid;
    s.shocks += 1;
    s.lastShockBps = bps;
    return this.#quote(symbol, s);
  }

  forcePrice(symbol, price) {
    const s = this.#symbols.get(symbol);
    if (!s) return null;
    s.mid = Math.max(price, s.inst.tickSize);
    s.last = s.mid;
    return this.#quote(symbol, s);
  }

  /** Freeze the feed: used to test the stale-data risk rule. */
  freeze(on = true) {
    this.frozen = on;
    return this;
  }
}
