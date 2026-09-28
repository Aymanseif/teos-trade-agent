/**
 * TEOS Trade Agent - agent/strategies/rsi_reversion.js
 *
 * RSI(14) mean-reversion: buy when RSI leaves oversold, exit when it leaves
 * overbought. ATR stop.
 *
 * Deliberately the opposite style to sma_cross, so the backtester compares a
 * trend follower against a mean reverter on identical cost assumptions. No
 * claim is made that either is profitable.
 */

import { rsi, atr, toSeries, pctChange } from '../indicators.js';
import { makeSignal, hold, resolveStop, hasLongToExit } from './strategy.interface.js';

export const rsiReversion = {
  id: 'rsi_reversion',
  description: 'RSI(14) mean reversion with ATR stop. Long-only; SELL exits.',
  minBars: 30,
  defaultParams: {
    rsiPeriod: 14,
    oversold: 28,
    overbought: 72,
    atrPeriod: 14,
    stopAtrMultiple: 1.8,
    rewardMultiple: 1.2,
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
    const r = rsi(close, p.rsiPeriod);
    const a = atr(high, low, close, p.atrPeriod);
    const i = close.length - 1;
    const rsiNow = r[i]; const rsiPrev = r[i - 1];
    const atrNow = a[i];
    if (rsiNow == null || rsiPrev == null || atrNow == null || atrNow <= 0) {
      return hold('indicators not yet defined', { rsi: rsiNow, atr: atrNow });
    }

    const price = ctx.price;
    const features = {
      rsi: rsiNow, rsiPrev, atr: atrNow, price,
      change1Pct: pctChange(close[i], close[i - 1]) * 100,
      bars: candles.length,
    };

    const leavingOversold = rsiPrev <= p.oversold && rsiNow > p.oversold && rsiNow < 50;
    if (leavingOversold && !hasLongToExit(ctx.position)) {
      const s = resolveStop({
        price,
        rawStopPrice: price - atrNow * p.stopAtrMultiple,
        band: ctx.stopBand,
        rewardMultiple: p.rewardMultiple,
      });
      const confidence = Math.max(p.minConfidence, Math.min(0.9, (p.oversold + 10 - rsiPrev) / 20));
      return makeSignal({
        signal: 'BUY', confidence, features,
        stopPrice: s.stopPrice, targetPrice: s.targetPrice,
        stopDistancePct: s.stopDistancePct,
        riskRewardRatio: s.riskRewardRatio,
        reason: `RSI(${p.rsiPeriod}) rose out of oversold (${rsiPrev.toFixed(2)} -> ${rsiNow.toFixed(2)}, threshold ${p.oversold}); stop ${p.stopAtrMultiple}x ATR below, clamped to ${s.stopDistancePct.toFixed(3)}% by policy.`,
        meta: {
          trigger: 'RSI_LEAVING_OVERSOLD', riskPctPerTrade: p.riskPctPerTrade,
          rawStopDistancePct: s.rawStopDistancePct, stopClamped: s.clamped,
        },
      });
    }

    const leavingOverbought = rsiPrev >= p.overbought && rsiNow < p.overbought && rsiNow > 50;
    if (leavingOverbought && hasLongToExit(ctx.position)) {
      return makeSignal({
        signal: 'SELL',
        confidence: Math.max(p.minConfidence, Math.min(0.9, (rsiPrev - p.overbought + 10) / 20)),
        features, stopPrice: null, targetPrice: null,
        stopDistancePct: null, riskRewardRatio: null,
        reason: `RSI(${p.rsiPeriod}) fell out of overbought (${rsiPrev.toFixed(2)} -> ${rsiNow.toFixed(2)}, threshold ${p.overbought}). Exit long.`,
        meta: { trigger: 'RSI_LEAVING_OVERBOUGHT', intent: 'EXIT_LONG' },
      });
    }

    return hold(
      `RSI(${p.rsiPeriod})=${rsiNow.toFixed(2)} inside band [${p.oversold}, ${p.overbought}]`,
      features,
    );
  },
};

export default rsiReversion;
