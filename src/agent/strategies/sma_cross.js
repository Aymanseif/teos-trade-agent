/**
 * TEOS Trade Agent - agent/strategies/sma_cross.js
 *
 * Moving-average crossover with an ATR-based stop and a fixed reward multiple.
 *
 * Rationale (NOT a profitability claim): this is the simplest trend-following
 * construction that can be evaluated honestly, and its main value here is as a
 * transparent baseline against which the other strategies are compared. It has
 * no demonstrated edge in any market; it is included to exercise the
 * strategy interface, the sizer and the full risk pipeline end to end.
 */

import { sma, atr, toSeries, lastDefined, trendStrength } from '../indicators.js';
import { makeSignal, hold, resolveStop, hasLongToExit } from './strategy.interface.js';

export const smaCross = {
  id: 'sma_cross',
  description: 'Fast/slow simple moving average crossover. ATR stop, fixed reward multiple.',
  minBars: 40,
  defaultParams: {
    fastPeriod: 10,
    slowPeriod: 30,
    atrPeriod: 14,
    stopAtrMultiple: 1.5,
    rewardMultiple: 1.5,
    riskPctPerTrade: 0.5,
    minConfidence: 0.3,
  },

  evaluate(ctx) {
    const p = { ...this.defaultParams, ...ctx.params };
    const candles = ctx.candles ?? [];
    if (candles.length < this.minBars) {
      return hold(`warm-up: ${candles.length}/${this.minBars} bars`, { bars: candles.length });
    }

    const { high, low, close } = toSeries(candles);
    const fast = sma(close, p.fastPeriod);
    const slow = sma(close, p.slowPeriod);
    const a = atr(high, low, close, p.atrPeriod);

    const i = close.length - 1;
    const f0 = fast[i]; const f1 = fast[i - 1];
    const s0 = slow[i]; const s1 = slow[i - 1];
    const atrNow = a[i];
    if (f0 == null || s0 == null || atr0Bad(atrNow) || f1 == null || s1 == null) {
      return hold('indicators not yet defined', { fast: f0, slow: s0, atr: atrNow });
    }

    const price = ctx.price;
    const spread = trendStrength(fast, slow)[i] ?? 0;

    const crossedUp = f1 <= s1 && f0 > s0;
    const crossedDown = f1 >= s1 && f0 < s0;

    const features = {
      smaFast: f0, smaSlow: s0, smaFastPrev: f1, smaSlowPrev: s1,
      atr: atrNow, trendSpreadPct: spread, price, bars: candles.length,
    };

    if (crossedUp) {
      // The raw ATR stop is passed through the policy band, so the stop the
      // risk engine will validate is the stop this decision actually carries.
      const s = resolveStop({
        price,
        rawStopPrice: price - atrNow * p.stopAtrMultiple,
        band: ctx.stopBand,
        rewardMultiple: p.rewardMultiple,
      });
      const confidence = confidenceFrom({ separation: Math.abs(f0 - s0), atr: atrNow, floor: p.minConfidence });
      return makeSignal({
        signal: 'BUY', confidence, features,
        stopPrice: s.stopPrice, targetPrice: s.targetPrice,
        stopDistancePct: s.stopDistancePct,
        riskRewardRatio: s.riskRewardRatio,
        reason: `SMA${p.fastPeriod} crossed above SMA${p.slowPeriod} (${f0.toFixed(5)} > ${s0.toFixed(5)}); stop ${p.stopAtrMultiple}x ATR below, clamped to ${s.stopDistancePct.toFixed(3)}% by policy.`,
        meta: {
          cross: 'UP', atrMultiple: p.stopAtrMultiple, riskPctPerTrade: p.riskPctPerTrade,
          rawStopDistancePct: s.rawStopDistancePct, stopClamped: s.clamped,
        },
      });
    }

    if (crossedDown) {
      // Long-only, cash-funded account: a SELL is "reduce / close the existing
      // long". With no long there is nothing to reduce, so this is a HOLD - a
      // zero-quantity exit intent would only ever be refused downstream.
      if (!hasLongToExit(ctx.position)) {
        return hold(
          `SMA${p.fastPeriod} crossed below SMA${p.slowPeriod} but no long is held; nothing to reduce.`,
          features,
        );
      }
      const confidence = confidenceFrom({ separation: Math.abs(f0 - s0), atr: atrNow, floor: p.minConfidence });
      return makeSignal({
        signal: 'SELL', confidence, features,
        stopPrice: null,
        targetPrice: null,
        stopDistancePct: null,
        riskRewardRatio: null,
        reason: `SMA${p.fastPeriod} crossed below SMA${p.slowPeriod} (${f0.toFixed(5)} < ${s0.toFixed(5)}). Exit signal for an existing long.`,
        meta: { cross: 'DOWN', intent: 'EXIT_LONG', riskPctPerTrade: p.riskPctPerTrade },
      });
    }

    return hold(
      `no crossover (SMA${p.fastPeriod}=${f0.toFixed(5)}, SMA${p.slowPeriod}=${s0.toFixed(5)})`,
      features,
    );
  },
};

function atr0Bad(v) { return v == null || !Number.isFinite(v) || v <= 0; }

/**
 * Relative strength score for a crossover, in 0..1.
 *
 * The input is the distance between the two moving averages expressed in ATR
 * units, which makes it dimensionless and therefore comparable across
 * instruments with different price levels and volatilities.
 *
 * At the instant of a crossing that distance is near zero, which is correct: a
 * fresh crossover genuinely carries little information. `scaleAtr` is the
 * separation at which the score saturates, set from the observed distribution of
 * this strategy on the simulated feed rather than tuned to produce a number.
 *
 * This is a RELATIVE strength score, used for sizing and for the Sentinel's
 * review threshold. It is NOT a probability of profit and implies no such
 * claim.
 */
function confidenceFrom({ separation, atr, floor, scaleAtr = 0.5 }) {
  if (!Number.isFinite(separation) || !(atr > 0)) return floor;
  const separationAtr = separation / atr;
  const norm = Math.min(1, separationAtr / scaleAtr);
  return Math.max(floor, Math.min(0.95, floor + (0.95 - floor) * norm));
}

export default smaCross;
