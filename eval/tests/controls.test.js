/**
 * TEOS evaluation harness - tests/controls.test.js
 *
 * THE TEST THAT SHOULD HAVE EXISTED BEFORE THE FIRST PILOT.
 *
 * The first 20-seed pilot shipped a `random-entry` control with three defects,
 * none of which any test caught. All three biased the SAME way - toward making
 * the "random entry" arm look like the real strategy:
 *
 *   1. it returned sma_cross's BUY unchanged, so the control kept the
 *      crossover's own entries and therefore the crossover's edge;
 *   2. `fired` was a one-shot latch, so at most ONE random entry occurred in the
 *      entire run;
 *   3. it copied `stopPrice` off a HOLD signal, where sma_cross returns null, so
 *      the random entry was stopped by the risk engine's
 *      `defaultStopDistancePct` (1.5%) instead of the 0.25% real entries get.
 *
 * A control is a measurement instrument. When the instrument is broken the
 * measurement is not slightly off, it points the wrong way - and here it pointed
 * at "the entry signal is not the problem" when the fixed control may well say
 * the opposite. These tests are cheap, deterministic, and each one fails
 * against the original implementation.
 *
 * The unit tests drive the strategies directly with a hand-built context, so
 * they run in milliseconds and pin the behaviour at the source. The final test
 * is end-to-end through the real pipeline, proving the property survives all the
 * way to the decisions table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { smaCross } from '../../src/agent/strategies/sma_cross.js';
import { resolveStop } from '../../src/agent/strategies/strategy.interface.js';
import { buildArms, makeRandomEntryStrategy, makeRandomEntryStrategyV1 } from '../arms.js';
import { runOnce } from '../driver.js';

const BAND = { minPct: 0.25, maxPct: 5.0 };
const SYMBOL = 'TEST/USD';

/**
 * A long synthetic price path: a slow sinusoid, which makes the fast SMA cross
 * the slow SMA repeatedly in both directions.
 *
 * The series is exposed as a GROWING series, not a fixed 60-bar window, because
 * `ctx.candles.length` is the bar index the strategies use. A fixed-length
 * context reports the same bar number forever, which silently disables the
 * original control's `bar - last >= everyBars` gate and makes it look like it
 * never enters rather than like it enters once.
 */
function makeSeries({ bars = 400, amplitude = 4, period = 9 } = {}) {
  const candles = [];
  for (let i = 0; i < bars; i += 1) {
    const close = 100 + Math.sin(i / period) * amplitude;
    candles.push({
      ts_ms: 1_700_000_000_000 + i * 60_000,
      open: close, high: close + 0.35, low: close - 0.35, close, volume: 1,
    });
  }
  return candles;
}

/** Context for the first `n` bars of a series. `position` defaults to flat. */
function ctxAt(candles, n, { position = null } = {}) {
  const slice = candles.slice(0, n);
  return {
    symbol: SYMBOL,
    candles: slice,
    price: slice[slice.length - 1].close,
    position,
    params: {},
    stopBand: BAND,
  };
}

const POSITION = { symbol: SYMBOL, quantity: 1, avg_entry_price: 100 };

/** One shared series, so a fixture change cannot move the tests independently. */
const SERIES = makeSeries();

/**
 * Find the bar index at which sma_cross genuinely crosses UP, by asking
 * sma_cross itself rather than by assuming a shape produces a cross.
 *
 * Returns `{ ctx, crossUp }` where `crossUp` is the index. Throws if the series
 * never crosses, so a change to the fixture cannot quietly turn the
 * "suppresses the crossover" assertions into no-ops.
 */
function findCrossUp(candles) {
  for (let n = 41; n <= candles.length; n += 1) {
    const sig = smaCross.evaluate(ctxAt(candles, n));
    if (sig.signal === 'BUY') return { ctx: ctxAt(candles, n), crossUp: n, sig };
  }
  throw new Error('fixture: the series never produced a sma_cross BUY. '
    + 'The crossover-suppression tests would be vacuous.');
}

/** Find a bar index where sma_cross is on HOLD with indicators defined. */
function findHold(candles) {
  for (let n = 41; n <= candles.length; n += 1) {
    const ctx = ctxAt(candles, n);
    const sig = smaCross.evaluate(ctx);
    if (sig.signal === 'HOLD' && sig.features?.atr > 0) return ctx;
  }
  throw new Error('fixture: the series never produced a sma_cross HOLD with a usable ATR.');
}

// ---------------------------------------------------------------------------
// Defect 1: the crossover's own entries were passed through
// ---------------------------------------------------------------------------

test('DEFECT 1: the test context really does produce a sma_cross BUY', () => {
  // Guards the guard. If this stops being true, the two assertions below pass
  // because the control returned HOLD to a bar that was never a crossover.
  const { sig, crossUp } = findCrossUp(SERIES);
  assert.equal(sig.signal, 'BUY', 'fixture no longer produces a crossover BUY');
  assert.match(sig.reason, /crossed above/);
  assert.ok(crossUp > 40, 'the crossover is inside the warm-up window; fixture is wrong');
});

test('DEFECT 1: the random-entry control suppresses the crossover entry', () => {
  const { ctx } = findCrossUp(SERIES);
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 1 });
  const sig = control.evaluate(ctx);
  assert.notEqual(sig.signal, 'BUY',
    'the control passed a crossover BUY straight through. It is sma_cross with a '
    + 'garnish, not a random-entry control, and it measures nothing.');
  assert.equal(sig.signal, 'HOLD');
});

test('DEFECT 1: the ORIGINAL implementation fails this test', () => {
  // A regression canary. If someone re-points the arm at v1, this fails.
  const { ctx } = findCrossUp(SERIES);
  const flawed = makeRandomEntryStrategyV1({ id: 'random-entry-v1', seed: 1 });
  assert.equal(flawed.evaluate(ctx).signal, 'BUY',
    'the retained flawed control no longer exhibits the defect, so the side-by-side '
    + 'in the report is no longer comparing what it claims to compare.');
});

// ---------------------------------------------------------------------------
// Defect 2: the one-shot latch
// ---------------------------------------------------------------------------

test('DEFECT 2: the control can enter more than once per run', () => {
  // entryProbPct 100 makes the draw deterministic, so this asserts the LATCH is
  // gone rather than asserting a probability. A growing series is essential:
  // the real engine re-evaluates on each new bar.
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 7, entryProbPct: 100 });
  let buys = 0;
  let eligible = 0;
  for (let n = 41; n <= 120; n += 1) {
    const ctx = ctxAt(SERIES, n);
    if (smaCross.evaluate(ctx).signal !== 'HOLD') continue;   // only HOLD bars qualify
    eligible += 1;
    if (control.evaluate(ctx).signal === 'BUY') buys += 1;
  }  assert.ok(eligible > 20, `fixture only produced ${eligible} eligible bars`);
  assert.ok(buys > 1,
    `the control emitted ${buys} BUY across ${eligible} eligible bars. A one-shot `
    + 'latch means this arm contributes a single trade per run and its expectancy '
    + 'is meaningless.');
});

test('DEFECT 2: the ORIGINAL implementation exhibits the one-shot latch', () => {
  const flawed = makeRandomEntryStrategyV1({ id: 'random-entry-v1', seed: 7 });
  let randomBuys = 0;
  let crossoverBuys = 0;
  for (let n = 41; n <= SERIES.length; n += 1) {
    const s = flawed.evaluate(ctxAt(SERIES, n));
    if (s.signal !== 'BUY') continue;
    // v1 passes crossover BUYs through untouched, so the two have to be told
    // apart by origin. Counting all BUYs would blame the latch for the
    // pass-through defect and hide both.
    if (/Random control entry/.test(s.reason)) randomBuys += 1;
    else crossoverBuys += 1;
  }
  assert.ok(randomBuys <= 1,
    `the retained flawed control made ${randomBuys} random entries; it no longer `
    + 'shows the one-shot latch');
  assert.ok(crossoverBuys > 1,
    `the fixture only produced ${crossoverBuys} pass-through crossover BUYs, so it `
    + 'no longer demonstrates the pass-through defect either');
  assert.equal(flawed.stats().randomEntries, randomBuys);
});

test('the control does not open a second position while one is held', () => {
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 7, entryProbPct: 100 });
  const sig = control.evaluate({ ...findHold(SERIES), position: POSITION });
  assert.notEqual(sig.signal, 'BUY', 'the control entered while already long');
});

// ---------------------------------------------------------------------------
// Defect 3: the stop was copied off a HOLD signal, where it is null
// ---------------------------------------------------------------------------

test('DEFECT 3: the control entry carries the SAME stop a crossover entry would', () => {
  const ctx = findHold(SERIES);
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 3, entryProbPct: 100 });
  const sig = control.evaluate(ctx);
  assert.equal(sig.signal, 'BUY');

  const p = { ...smaCross.defaultParams, ...ctx.params };
  const atrNow = sig.features.atr;
  assert.ok(atrNow > 0, 'no ATR on the control entry; there is no stop to check');
  const expected = resolveStop({
    price: ctx.price,
    rawStopPrice: ctx.price - atrNow * p.stopAtrMultiple,
    band: ctx.stopBand,
    rewardMultiple: p.rewardMultiple,
  });
  assert.ok(Math.abs(sig.stopDistancePct - expected.stopDistancePct) < 1e-9,
    `control stop is ${sig.stopDistancePct}% but a real entry would be `
    + `${expected.stopDistancePct}%. A control stopped differently from the entries `
    + 'it is compared against is not a control.');
  assert.equal(sig.stopPrice, expected.stopPrice);
});

test('DEFECT 3: the control entry is NOT stopped at the policy default', () => {
  // The concrete harm: the original took `stopPrice` from a HOLD signal, where
  // sma_cross returns null, so the risk engine fell back to
  // defaultStopDistancePct = 1.5% - six times wider than the 0.25% floor the
  // real entries are clamped to.
  const ctx = findHold(SERIES);
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 3, entryProbPct: 100 });
  const sig = control.evaluate(ctx);
  assert.ok(sig.stopPrice != null, 'control entry has no stop at all');
  assert.ok(sig.stopDistancePct < 1.5,
    `control entry stopped at ${sig.stopDistancePct}%, which is the 1.5% policy `
    + 'default - the fallback the original hit.');
  assert.equal(sig.stopPrice, ctx.price * (1 - sig.stopDistancePct / 100));
});

test('DEFECT 3: the ORIGINAL implementation hits the default-stop fallback', () => {
  const flawed = makeRandomEntryStrategyV1({ id: 'random-entry-v1', seed: 11 });
  // Drive it across the whole growing series until it emits its one random
  // entry, then inspect the stop.
  let sig = null;
  for (let n = 41; n <= SERIES.length && sig == null; n += 1) {
    const s = flawed.evaluate(ctxAt(SERIES, n));
    if (s.signal === 'BUY' && /Random control entry/.test(s.reason)) sig = s;
  }
  assert.ok(sig != null, 'the flawed control never entered; cannot verify the fallback');
  assert.equal(sig.stopPrice, null,
    'the flawed control no longer emits a BUY with a null stop, so it no longer '
    + 'falls through to the 1.5% policy default. The side-by-side would change meaning.');
});

// ---------------------------------------------------------------------------
// Exits must be identical: the control changes ONE thing, not two
// ---------------------------------------------------------------------------

test('the control delegates every sma_cross SELL unchanged', () => {
  // NOTE ON THE FIXTURE: a cross-DOWN while flat is a HOLD in production - the
  // strategy will not propose reducing a position that does not exist. So the
  // way to find a cross-down bar is to ask with a position held, NOT to filter
  // for "not a HOLD", which skips precisely the bars under test.
  const flatCrossDowns = [];
  const longCrossDowns = [];
  for (let n = 41; n <= SERIES.length; n += 1) {
    const flat = ctxAt(SERIES, n);
    const long = { ...flat, position: POSITION };
    const flatSig = smaCross.evaluate(flat);
    const longSig = smaCross.evaluate(long);
    if (flatSig.signal === 'HOLD' && longSig.signal === 'HOLD') continue;
    if (flatSig.signal === 'HOLD') flatCrossDowns.push(n);
    if (longSig.signal === 'SELL') longCrossDowns.push({ n, long, longSig });
  }
  assert.ok(longCrossDowns.length > 0,
    `fixture: no cross-down bar produced a SELL while long (${flatCrossDowns.length} `
    + 'cross-down bars found flat). The delegation test would be vacuous.');
  assert.equal(flatCrossDowns.length, longCrossDowns.length,
    'a cross-down bar held flat did not come back a HOLD from sma_cross, so the '
    + 'production "nothing to reduce" rule is not what this fixture assumes');

  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 5, entryProbPct: 0 });
  for (const { long, longSig } of longCrossDowns) {
    const controlSig = control.evaluate(long);
    assert.equal(controlSig.signal, 'SELL');
    assert.equal(controlSig.reason, longSig.reason, 'the control rewrote the exit reason');
    assert.equal(controlSig.confidence, longSig.confidence);
    assert.equal(controlSig.meta.cross, longSig.meta.cross);
    assert.equal(controlSig.stopPrice, longSig.stopPrice);
  }
});

test('the control never emits a short: SELL only while long', () => {
  // Every bar where sma_cross would sell a long must be a HOLD from the control
  // when flat. Cross-down bars are found by asking WITH a long, because
  // cross-down-while-flat is legitimately a HOLD.
  const control = makeRandomEntryStrategy({ id: 'random-entry', seed: 5, entryProbPct: 0 });
  let checked = 0;
  for (let n = 41; n <= SERIES.length; n += 1) {
    const flat = ctxAt(SERIES, n);
    if (smaCross.evaluate({ ...flat, position: POSITION }).signal !== 'SELL') continue;
    checked += 1;
    assert.notEqual(control.evaluate(flat).signal, 'SELL',
      'the control emitted a SELL with no position to reduce');
  }
  assert.ok(checked > 5, `fixture only produced ${checked} cross-down bars to check`);
});

// ---------------------------------------------------------------------------
// Labelling: a broken control must never be presentable as a control
// ---------------------------------------------------------------------------

test('buildArms marks the flawed control INVALID and the fixed one valid', () => {
  const arms = buildArms();
  const fixed = arms.find((a) => a.key === 'random-entry');
  const flawed = arms.find((a) => a.key === 'random-entry-v1');
  assert.ok(fixed, 'the fixed random-entry arm is missing');
  assert.ok(flawed, 'the retained flawed arm is missing; the side-by-side cannot render');
  assert.equal(fixed.invalidControl, undefined,
    'the FIXED control is flagged invalid, which means the report will not use it');
  assert.equal(flawed.invalidControl, true,
    'the flawed control is not flagged invalid, so the report would present it as a control');
  assert.notEqual(flawed.group, fixed.group, 'a known-broken arm shares a group with a valid one');
});

// ---------------------------------------------------------------------------
// End to end: the property survives the real pipeline
// ---------------------------------------------------------------------------

test('END TO END: no crossover BUY reaches the decisions table in random-entry', async () => {
  // The canary seed and tick count, because at that seed the base arm is known to
  // produce 9 BUYs - so "zero crossover BUYs here" is a real suppression, not an
  // empty fixture.
  const arm = buildArms().find((a) => a.key === 'random-entry');
  const run = await runOnce({ arm, seed: 20260928, ticks: 2500 });
  const buys = run.rows.decisions.filter((d) => d.signal === 'BUY');

  const crossoverBuys = buys.filter((d) => /crossed above/.test(d.reason));
  assert.equal(crossoverBuys.length, 0,
    'crossover entries reached the decisions table through the control arm');

  assert.ok(buys.length > 0, 'the control produced no entries at all; the comparison is void');
  for (const b of buys) {
    assert.match(b.reason, /Random control entry/,
      `a BUY reached the table that the control did not originate: ${b.reason}`);
    assert.ok(b.stop_distance_pct != null && b.stop_distance_pct < 1.5,
      `control entry stopped at ${b.stop_distance_pct}%, i.e. the 1.5% policy default`);
  }
}, { timeout: 300_000 });
