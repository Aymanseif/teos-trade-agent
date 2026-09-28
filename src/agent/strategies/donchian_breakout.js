/**
 * TEOS Trade Agent - agent/strategies/donchian_breakout.js
 *
 * Donchian channel breakout: buy when price exceeds the prior N-bar high
 * (excluding the current bar), exit on the prior M-bar low. Classic
 * trend-following breakout; included as a third independent strategy so
 * parameter sweeps have something structurally different to compare against.
 */

import { donchian, atr, toSeries, slope } from '../indicators.js';
import { makeSignal, hold, resolveStop, hasLongToExit } from './strategy.interface.js';

export const donchianBreakout = {
  id: 'donchian_breakout',
  description: 'Donchian channel breakout with ATR stop. Long-only; SELL exits.',
  minBars: 30,
  defaultParams: {
    entryPeriod: 20,
    exitPeriod: 10,
    atrPeriod: 14,
    stopAtrMultiple: 2.0,
    rewardMultiple: 2.0,
    riskPctPerTrade: 0.4,
    minConfidence: 0.3,
  },

  evaluate(ctx) {
    const p = { ...this.defaultParams, ...ctx.params };
    const candles = ctx.candles ?? [];
    if (candles.length < this.minBars) {
      return hold(`warm-up: ${candles.length}/${this.minBars} bars`, { bars: candles.length });
    }
    const { high, low, close } = toSeries(candles);
    const ch = donchian(high, low, p.entryPeriod);
    const chExit = donchian(high, low, p.exitPeriod);
    const a = atr(high, low, close, p.atrPeriod);
    const i = close.length - 1;
    const upper = ch.upper[i]; const lower = ch.lower[i];
    const exitLower = chExit.lower[i];
    const atrNow = a[i];
    if (upper == null || lower == null || atrNow == null || atrNow <= 0) {
      return hold('indicators not yet defined', { upper, lower, atr: atrNow });
    }

    const price = ctx.price;
    const breakout = close[i] > upper;
    const breakoutPrev = i > 0 && close[i - 1] > ch.upper[i - 1];
    const features = {
      channelUpper: upper, channelLower: lower, exitLower, close: close[i],
      breakout, atr: atrNow, price, bars: candles.length,
      channelSlope: slope(close, 5)[i],
    };

    if (breakout && !breakoutPrev && !hasLongToExit(ctx.position)) {
      const width = upper - lower;
      const s = resolveStop({
        price,
        rawStopPrice: Math.min(price - atrNow * p.stopAtrMultiple, lower),
        band: ctx.stopBand,
        rewardMultiple: p.rewardMultiple,
      });
      const conf = width > 0 ? Math.max(p.minConfidence, Math.min(0.9, (close[i] - lower) / width)) : p.minConfidence;
      return makeSignal({
        signal: 'BUY', confidence: conf, features,
        stopPrice: s.stopPrice, targetPrice: s.targetPrice,
        stopDistancePct: s.stopDistancePct,
        riskRewardRatio: s.riskRewardRatio,
        reason: `close ${close[i].toFixed(5)} broke above the prior ${p.entryPeriod}-bar high ${upper.toFixed(5)}; stop below the channel / ${p.stopAtrMultiple}x ATR, clamped to ${s.stopDistancePct.toFixed(3)}% by policy.`,
        meta: {
          trigger: 'DONCHIAN_BREAKOUT', riskPctPerTrade: p.riskPctPerTrade,
          rawStopDistancePct: s.rawStopDistancePct, stopClamped: s.clamped,
        },
      });
    }

    if (hasLongToExit(ctx.position) && exitLower != null && close[i] < exitLower) {
      return makeSignal({
        signal: 'SELL',
        confidence: Math.max(p.minConfidence, Math.min(0.9, (exitLower - close[i]) / (widthOf(upper, lower) || 1))),
        features, stopPrice: null, targetPrice: null,
        stopDistancePct: null, riskRewardRatio: null,
        reason: `close ${close[i].toFixed(5)} fell below the prior ${p.exitPeriod}-bar low ${exitLower.toFixed(5)}. Exit long.`,
        meta: { trigger: 'DONCHIAN_EXIT', intent: 'EXIT_LONG' },
      });
    }

    return hold(`no breakout (close ${close[i].toFixed(5)} vs channel [${lower.toFixed(5)}, ${upper.toFixed(5)}])`, features);
  },
};

function widthOf(upper, lower) {
  return upper != null && lower != null ? upper - lower : 0;
}

export default donchianBreakout;
