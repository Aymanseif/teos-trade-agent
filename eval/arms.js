/**
 * TEOS evaluation harness - arms.js
 *
 * An "arm" is one experimental condition: a config override set, and optionally
 * a harness strategy to evaluate instead of the production one.
 *
 * TWO HARD RULES
 * --------------
 * 1. `config/default.json` is NEVER written. Every override is passed to
 *    `loadConfig({ overrides })`, which deep-merges into an in-memory object and
 *    then deep-freezes it. A run physically cannot mutate the shipped policy.
 *
 * 2. No production file is edited to create an arm. Anything that needs a
 *    different strategy registers one through the public `registerStrategy`
 *    seam, so the risk engine, Sentinel, execution adapter, matching engine and
 *    accounting are the same code in every arm.
 */

import { smaCross } from '../src/agent/strategies/sma_cross.js';
import { Rng } from '../src/broker/mock/rng.js';
import { hasLongToExit, hold, makeSignal, resolveStop } from '../src/agent/strategies/strategy.interface.js';

/** Exit reason markers, used by the report to attribute every closed trade. */
export const EXIT = {
  STOP: 'STOP',
  SIGNAL: 'SIGNAL',
  TAKE_PROFIT: 'TAKE_PROFIT',
  OPEN: 'OPEN',
  UNKNOWN: 'UNKNOWN',
};

/** Classify a decision by the reason the production code wrote into it. */
export function classifyExit(reason = '') {
  if (/^Stop loss breached/.test(reason)) return EXIT.STOP;
  if (/take-profit reached/i.test(reason)) return EXIT.TAKE_PROFIT;
  return EXIT.SIGNAL;
}

// ---------------------------------------------------------------------------
// Harness strategies
//
// A production strategy is a pure function of (ctx, state) -> Signal and may not
// hold mutable state. Two of the three harness strategies NEED to remember the
// entry's risk unit in order to define an exit, so they are deliberately
// stateful. They live in eval/ and are never registered into a production
// process. That deviation is the honest cost of measuring the "missing
// take-profit" hypothesis, and it is why the take-profit arm is labelled a
// measurement overlay rather than a shippable strategy.
// ---------------------------------------------------------------------------

/**
 * Wraps the real `sma_cross` and adds a take-profit at `rMultiple` of the
 * entry's own risk unit (entry - stop). The entry and the stop are the
 * production ones; only the exit is added.
 */
export function makeTakeProfitStrategy({ id, rMultiple }) {
  const entryStop = new Map();   // symbol -> stop price proposed on the BUY
  const firedFor = new Set();    // position_id -> already exited at the target

  return {
    id,
    description: `sma_cross + a take-profit at ${rMultiple}R of the entry stop. Measurement overlay, not a production strategy.`,
    minBars: smaCross.minBars,
    defaultParams: { ...smaCross.defaultParams },

    evaluate(ctx) {
      const position = ctx.position;
      if (position && hasLongToExit(position)) {
        const stop = entryStop.get(ctx.symbol);
        if (stop != null && stop < position.avg_entry_price) {
          const riskUnit = position.avg_entry_price - stop;
          const target = position.avg_entry_price + riskUnit * rMultiple;
          if (ctx.price >= target && !firedFor.has(position.position_id)) {
            firedFor.add(position.position_id);
            return makeSignal({
              signal: 'SELL',
              confidence: 1,
              reason: `Take-profit reached in ${ctx.symbol}: mid ${ctx.price} is at or above the ${rMultiple}R target ${target}. Closing the long.`,
              features: { mid: ctx.price, target, rMultiple, avgEntryPrice: position.avg_entry_price, entryStop: stop },
              meta: { intent: 'TAKE_PROFIT_EXIT', rMultiple },
            });
          }
        }
      }
      const sig = smaCross.evaluate(ctx);
      if (sig.signal === 'BUY' && sig.stopPrice != null) entryStop.set(ctx.symbol, sig.stopPrice);
      return sig;
    },
  };
}

/**
 * Random ENTRY, production EXITS. This is the control that decides whether the
 * entry signal has any edge at all: if this matches the strategy, the crossover
 * is noise and no exit work will help.
 *
 * A control is only a control if the ONE thing you change is the thing you are
 * testing. That forces three properties, each of which the previous
 * implementation of this function got wrong:
 *
 *   1. The crossover's OWN entries are suppressed. Otherwise the arm is
 *      sma_cross plus a garnish, and it measures nothing - it hands the
 *      "random" arm the very edge it is supposed to lack.
 *   2. The random entry carries the SAME stop a crossover entry would. The stop
 *      comes from the identical `resolveStop` call, on the identical `atr`
 *      feature sma_cross itself returns, through the identical policy band. A
 *      control entry stopped 6x wider than a real entry is not a control.
 *   3. Entries can recur. There is no one-shot latch, so the arm produces a
 *      comparable NUMBER of trades rather than one.
 *
 * ENTRY RATE. `entryProbPct` is a per-ELIGIBLE-EVALUATION probability, applied
 * only while flat. The agent evaluates far more often than once per bar, so the
 * signal count is not a simple multiple of the bar count, and it is NOT monotonic
 * in this rate: at the canary seed 5% produced 128 signals / 2 closed trades, 9%
 * produced 65 / 4, and 12% produced 320 / 10. The count is chaotic in the rate
 * because holding a position REMOVES the evaluations that would produce the next
 * entry - a feedback loop, not a linear scale. Matching the base arm's trade count
 * by tuning this number on one seed would be fitting the instrument to the answer.
 *
 * 9% is therefore a fixed, stated choice, and the report prints POOLED trade
 * counts across all seeds for every arm so the match can be judged rather than
 * assumed.
 *
 * THE COMPARISON MUST BE MADE ON RATE-INVARIANT STATISTICS. Win rate and
 * expectancy per trade do not depend on how many trades an arm took. Total P&L and
 * median seed net do. Arms with different trade counts are therefore NOT
 * comparable on P&L, and the report says so in section 1.
 *
 * CONFIDENCE. A fresh crossover has near-zero SMA separation, so sma_cross's own
 * `confidenceFrom` returns the floor `minConfidence` (0.3). The control uses the
 * same floor, which keeps sizing and the Sentinel's review threshold identical.
 */
export function makeRandomEntryStrategy({ id, seed, entryProbPct = 9 }) {
  const rng = new Rng(seed);
  const entries = new Map();   // symbol -> count, for the audit trail

  return {
    id,
    description: `Random entry on a seeded ${entryProbPct}%-per-bar draw while flat; crossover entries suppressed; exits delegated to sma_cross unchanged; same ATR stop and same confidence floor as a real entry. Control for "does the entry signal have an edge".`,
    minBars: smaCross.minBars,
    defaultParams: { ...smaCross.defaultParams },

    /** Harness-only introspection, read by the driver so the report can state
     *  how many random entries the arm actually made. A production strategy is
     *  a pure function and has no equivalent. */
    stats() {
      return {
        randomEntries: [...entries.values()].reduce((s, n) => s + n, 0),
        randomEntriesBySymbol: { ...entries },
        entryProbPct,
      };
    },

    evaluate(ctx) {
      const p = { ...smaCross.defaultParams, ...ctx.params };
      const sig = smaCross.evaluate(ctx);

      // (1) EXITS ARE DELEGATED UNCHANGED. A SELL from sma_cross is passed
      // through byte-for-byte, so the control's exit path is the production one.
      if (sig.signal === 'SELL') return sig;

      // (2a) SUPPRESS THE CROSSOVER'S OWN ENTRY. Without this the arm is mostly
      // sma_cross, which is the defect the harness test now pins shut.
      if (sig.signal === 'BUY') {
        return hold('random-entry control: crossover entry suppressed by design', sig.features);
      }

      // Only consider a fresh random entry while flat.
      if (hasLongToExit(ctx.position)) return sig;

      // (3) A fresh seeded draw on every evaluable bar, no latch, so the arm
      // enters repeatedly and its trade count is comparable to the real one.
      if (!rng.bool(entryProbPct)) return sig;

      // (2b) THE SAME STOP A CROSSOVER ENTRY WOULD CARRY. `sig.features.atr` is
      // the ATR sma_cross itself just computed for this bar, and `resolveStop`
      // is the same shared clamp it calls on a crossedUp bar. Nothing is
      // invented here; if the ATR is unusable there is no honest stop to place,
      // so the bar is skipped.
      const atrNow = sig.features?.atr;
      if (atrNow == null || !Number.isFinite(atrNow) || atrNow <= 0) return sig;
      const bar = ctx.candles.length;
      const s = resolveStop({
        price: ctx.price,
        rawStopPrice: ctx.price - atrNow * p.stopAtrMultiple,
        band: ctx.stopBand,
        rewardMultiple: p.rewardMultiple,
      });
      if (s.stopPrice == null) return sig;

      entries.set(ctx.symbol, (entries.get(ctx.symbol) ?? 0) + 1);
      return makeSignal({
        signal: 'BUY',
        confidence: p.minConfidence,
        reason: `Random control entry in ${ctx.symbol} (bar ${bar}, no crossover). Stop ${p.stopAtrMultiple}x ATR below, clamped to ${s.stopDistancePct.toFixed(3)}% by policy - identical to a real entry. Exits are delegated to sma_cross unchanged.`,
        features: { ...sig.features, randomBar: bar, seed, entryProbPct },
        stopPrice: s.stopPrice,
        targetPrice: s.targetPrice,
        stopDistancePct: s.stopDistancePct,
        riskRewardRatio: s.riskRewardRatio,
        meta: {
          intent: 'RANDOM_CONTROL_ENTRY',
          riskPctPerTrade: p.riskPctPerTrade,
          cross: 'NONE',
          rawStopDistancePct: s.rawStopDistancePct,
          stopClamped: s.clamped,
        },
      });
    },
  };
}

/**
 * The ORIGINAL, FLAWED random-entry control, kept ONLY to quantify the flaw.
 *
 * DO NOT READ ANY RESULT FROM THIS AS A CONTROL. It is retained because the
 * first 20-seed pilot was run with it and the difference has to be shown, not
 * asserted. Its three defects, all in the original single implementation:
 *
 *   - it returns sma_cross's BUY unchanged, so the arm keeps the crossover's
 *     entries and keeps the crossover's edge;
 *   - `fired` is a one-shot latch, so at most ONE random entry occurs in the
 *     whole run;
 *   - it copies `stopPrice` off a HOLD signal, where sma_cross returns null, so
 *     the random entry is stopped by the risk engine's `defaultStopDistancePct`
 *     (1.5%) rather than the 0.25% the real entries get.
 *
 * Every one of the three biases the arm toward looking like the strategy, so the
 * original understated the crossover's value and overstated the cost of the
 * entry signal as a suspect.
 */
export function makeRandomEntryStrategyV1({ id, seed, everyBars = 3 }) {
  const rng = new Rng(seed);
  const lastEntryBar = new Map();
  let fired = false;
  let randomEntries = 0;

  return {
    id,
    description: `RETAINED FOR COMPARISON ONLY - known-flawed random-entry control (passes crossover entries through, one-shot latch, wrong stop). Not a valid control.`,
    minBars: smaCross.minBars,
    defaultParams: { ...smaCross.defaultParams },

    /** Harness-only introspection, read by the driver. `randomEntries` is the
     *  direct measurement of the one-shot latch: it can never exceed 1. */
    stats() { return { randomEntries, fired, everyBars }; },

    evaluate(ctx) {
      const sig = smaCross.evaluate(ctx);
      if (sig.signal !== 'SELL') {
        if (!ctx.position && !fired && sig.signal === 'HOLD') {
          const bar = ctx.candles.length;
          const last = lastEntryBar.get(ctx.symbol);
          if (last == null || bar - last >= everyBars) {
            lastEntryBar.set(ctx.symbol, bar);
            if (rng.bool(100 / everyBars)) {
              fired = true;
              randomEntries += 1;
              return makeSignal({
                signal: 'BUY',
                confidence: Math.max(sig.confidence, 0.3),
                reason: `Random control entry in ${ctx.symbol} (bar ${bar}). Exits are delegated to sma_cross unchanged.`,
                features: { randomBar: bar, seed },
                stopPrice: sig.stopPrice,
                targetPrice: sig.targetPrice,
                stopDistancePct: sig.stopDistancePct,
                riskRewardRatio: sig.riskRewardRatio,
                meta: { intent: 'RANDOM_CONTROL_ENTRY', riskPctPerTrade: smaCross.defaultParams.riskPctPerTrade },
              });
            }
          }
        }
      }
      return sig;
    },
  };
}

/**
 * Buy and hold: enter once, then never emit a SELL. The position still exits
 * through the production stop machinery, so this is "hold until stopped", not
 * "ignore risk". The size is whatever the risk engine permits, which is the
 * only fair comparison in a long-only, cash-funded, notional-capped account.
 */
export function makeBuyAndHoldStrategy({ id }) {
  let entered = false;
  return {
    id,
    description: 'Buy once at the first evaluable bar and hold. Exits only via the production stop. Long-only, cash-funded, notional-capped.',
    minBars: smaCross.minBars,
    defaultParams: { ...smaCross.defaultParams },
    evaluate(ctx) {
      if (entered) {
        return ctx.position
          ? hold('buy and hold: position open, no signal exit', { mid: ctx.price })
          : hold('buy and hold: position closed by the stop, not re-entering', { mid: ctx.price });
      }
      if (ctx.candles.length < this.minBars) return hold('buy and hold: warm-up', {});
      entered = true;
      const probe = smaCross.evaluate(ctx);
      return makeSignal({
        signal: 'BUY',
        confidence: 0.3,
        reason: `Buy and hold: single entry in ${ctx.symbol} at bar ${ctx.candles.length}.`,
        features: { mid: ctx.price, bars: ctx.candles.length },
        // No invented stop: fall back to the policy default rather than
        // borrowing the crossover's (which is null on a HOLD).
        stopPrice: probe.stopPrice ?? ctx.price * (1 - (ctx.stopBand?.minPct ?? 0.25) / 100),
        targetPrice: null,
        stopDistancePct: ctx.stopBand?.minPct ?? null,
        riskRewardRatio: null,
        meta: { intent: 'BUY_AND_HOLD_ENTRY', riskPctPerTrade: smaCross.defaultParams.riskPctPerTrade },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Arm definitions
// ---------------------------------------------------------------------------

/** Force the EFFECTIVE stop to exactly `pct` percent of price, by pinning the
 *  policy band to [pct, pct, pct]. The ATR stop is still computed and then
 *  clamped to pct, which is exactly the production clamping path. */
function pinStop(pct) {
  return { risk: { minStopDistancePct: pct, defaultStopDistancePct: pct, maxStopDistancePct: pct } };
}

/** Let the ATR stop bind by dropping the policy floor. Band ceiling untouched. */
function freeStop(floorPct = 0.01) {
  return { risk: { minStopDistancePct: floorPct } };
}

function atrMultiple(mult) {
  return { strategies: { params: { sma_cross: { stopAtrMultiple: mult } } } };
}

/** Merge nested override objects (a shallow spread would drop sibling keys). */
export function deepMerge(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      out[k] = (v && typeof v === 'object' && !Array.isArray(v))
        ? deepMerge(out[k], v)
        : v;
    }
  }
  return out;
}

/**
 * Build the arm list.
 * @param {object} o
 * @param {number[]} [o.stopPcts]     effective-stop sweep, percent of price
 * @param {number[]} [o.atrMultiples] ATR-binding sweep (needs a lowered floor)
 * @param {number[]} [o.tpMultiples]  take-profit R multiples
 * @param {boolean}   [o.randomEntry] include the random-entry control
 * @param {boolean}   [o.randomEntryV1] also include the known-flawed original control, for the side-by-side
 * @param {boolean}   [o.buyAndHold]  include the buy-and-hold baseline
 */
export function buildArms({
  stopPcts = [0.25, 0.5, 1, 2, 5],
  atrMultiples = [0.5, 1, 1.5, 2, 3, 4],
  tpMultiples = [1, 1.5, 2],
  randomEntry = true,
  randomEntryV1 = true,
  buyAndHold = true,
  atrFloorPct = 0.01,
} = {}) {
  const arms = [];

  // 1. Production baseline, untouched.
  arms.push({ key: 'base', group: 'baseline', label: 'production config, sma_cross', overrides: {} });

  // 2. Effective-stop sweep, in percent of price.
  for (const pct of stopPcts) {
    arms.push({
      key: `stop-${pct}`,
      group: 'stop-sweep',
      label: `effective stop pinned to ${pct}% of price`,
      overrides: pinStop(pct),
    });
  }

  // 3. ATR-binding sweep: floor lowered so the ATR stop can actually express itself.
  for (const m of atrMultiples) {
    arms.push({
      key: `atr-${m}`,
      group: 'stop-sweep-atr',
      label: `ATR-binding stop at ${m}x ATR (policy floor lowered to ${atrFloorPct}%)`,
      overrides: deepMerge(freeStop(atrFloorPct), atrMultiple(m)),
    });
  }

  // 4. Take-profit overlay at the production stop.
  for (const r of tpMultiples) {
    arms.push({
      key: `tp-${r}R`,
      group: 'take-profit',
      label: `sma_cross + take-profit at ${r}R of the entry stop`,
      overrides: {},
      strategy: () => makeTakeProfitStrategy({ id: `tp-${r}R`, rMultiple: r }),
      strategyId: `tp-${r}R`,
    });
  }

  // 5. Controls.
  if (randomEntry) {
    arms.push({
      key: 'random-entry',
      group: 'control',
      label: 'random entry, crossover entries suppressed, exits delegated to sma_cross, same stop and confidence',
      overrides: {},
      strategy: (seed) => makeRandomEntryStrategy({ id: 'random-entry', seed }),
      strategyId: 'random-entry',
    });
  }
  if (randomEntryV1) {
    arms.push({
      key: 'random-entry-v1',
      group: 'control-v1',
      label: 'RETAINED FOR COMPARISON ONLY: the known-flawed first random-entry control (passes crossover entries through, one-shot latch, 1.5% fallback stop). NOT a valid control - the difference against random-entry is the measured size of that flaw.',
      overrides: {},
      strategy: (seed) => makeRandomEntryStrategyV1({ id: 'random-entry-v1', seed }),
      strategyId: 'random-entry-v1',
      invalidControl: true,
    });
  }
  if (buyAndHold) {
    arms.push({
      key: 'buy-and-hold',
      group: 'control',
      label: 'single entry, held, exit only via the production stop',
      overrides: {},
      strategy: () => makeBuyAndHoldStrategy({ id: 'buy-and-hold' }),
      strategyId: 'buy-and-hold',
    });
  }

  return arms;
}
