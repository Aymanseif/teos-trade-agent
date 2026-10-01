/**
 * TEOS evaluation harness - tests/units.test.js
 *
 * The arithmetic that produces the report, tested without the trading system.
 *
 * These are deliberately NOT property-based or clever. Every one of them is a
 * case where a plausible bug would produce a plausible-looking number in the
 * report, and a plausible-looking wrong number in a loss diagnosis is worse
 * than an obvious failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mean, median, stdev, quantile, sum, tradeStats, runDistribution, groupBy,
  perPeriodSharpe, maxDrawdownPct, round,
} from '../stats.js';
import { costBreakdown, pooledCosts } from '../costs.js';
import { rankCauses } from '../losses.js';
import { buildArms, deepMerge, classifyExit, EXIT } from '../arms.js';
import { tagRegimes } from '../regimes.js';

// ------------------------------------------------------------------- stats

test('median of an even-length set averages the middle pair', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
});

test('stdev of fewer than two values is undefined, not zero', () => {
  assert.equal(stdev([5]), null, 'a single observation has no dispersion; reporting 0 would understate risk');
  assert.equal(stdev([]), null);
});

test('quantile interpolates linearly', () => {
  assert.equal(quantile([0, 10], 0.5), 5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
});

test('tradeStats computes expectancy and win rate from NET, not gross', () => {
  // A trade that is positive gross and negative net is a LOSS after costs. If
  // expectancy were computed on gross, the harness would report the system as
  // profitable when the thing actually charged to it made it a loss.
  const t = (net, gross) => ({ netPnlEgp: net, grossPnlEgp: gross, holdMs: 1000 });
  const s = tradeStats([t(3, 5), t(-3, -1), t(-1, 1)]);
  assert.equal(s.n, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 2);
  assert.equal(Math.round(s.winRatePct), 33);
  assert.equal(Math.round(s.expectancyEgp * 100) / 100, -0.33);
  assert.ok(s.expectancyEgp < s.expectancyGrossEgp, 'net expectancy must be worse than or equal to gross');
});

test('tradeStats on an empty set returns nulls, not NaN or 0', () => {
  const s = tradeStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.expectancyEgp, null);
  assert.equal(s.winRatePct, null);
  assert.equal(s.medianNetEgp, null);
});

test('profitFactor is null when it is undefined, in either direction', () => {
  const onlyWins = tradeStats([{ netPnlEgp: 1, grossPnlEgp: 2, holdMs: 1 }]);
  assert.equal(onlyWins.profitFactor, null, 'infinite profit factor must not print as a number');
  // Zero winners is the case this harness actually hits, and reporting 0 would
  // read as "terrible" when the truth is "undefined - nothing ever won".
  const onlyLosses = tradeStats([
    { netPnlEgp: -1, grossPnlEgp: -2, holdMs: 1 },
    { netPnlEgp: -3, grossPnlEgp: -4, holdMs: 1 },
  ]);
  assert.equal(onlyLosses.profitFactor, null);
  assert.equal(onlyLosses.wins, 0);
});

test('runDistribution reports the worst seed and the loss rate', () => {
  const d = runDistribution([-1, -2, 3, 4]);
  assert.equal(d.n, 4);
  assert.equal(d.worst, -2);
  assert.equal(d.best, 4);
  assert.equal(d.lossRatePct, 50);
  // sorted [-2,-1,3,4], so the median averages the middle pair -> 1, not 0.5
  // (0.5 is the MEAN; confusing the two is a classic silent reporting bug).
  assert.equal(median([-1, -2, 3, 4]), 1);
  assert.equal(mean([-1, -2, 3, 4]), 1);
  assert.equal(median([-1, -2, 3]), -1, 'odd-length median is the middle element');
  assert.equal(mean([-1, -2, 3]), 0);
});

test('perPeriodSharpe is null for a flat equity curve rather than infinite', () => {
  assert.equal(perPeriodSharpe([100, 100, 100, 100]), null);
  assert.equal(perPeriodSharpe([100, 101]), null, 'two points cannot define a return distribution');
});

test('maxDrawdownPct measures peak to trough, not first to last', () => {
  assert.equal(Math.round(maxDrawdownPct([100, 120, 60, 130])), 50);
  assert.equal(maxDrawdownPct([100, 101, 102]), 0);
});

test('round does not turn -0.005 into -0.00 surprises', () => {
  assert.equal(round(-0.004, 2), -0);
  assert.equal(round(0.004, 2), 0);
  assert.equal(round(null), null);
  assert.equal(round(Infinity), null);
});

test('groupBy skips null keys instead of inventing an "unknown" bucket', () => {
  const g = groupBy(
    [{ netPnlEgp: 1, grossPnlEgp: 1, holdMs: 1, regime: { regime: 'TREND' } },
     { netPnlEgp: 1, grossPnlEgp: 1, holdMs: 1, regime: null }],
    (t) => t.regime?.regime ?? null,
  );
  assert.deepEqual(Object.keys(g), ['TREND']);
});

// ------------------------------------------------------------------- costs

const fakeRun = (over = {}) => ({
  metrics: {
    netPnlEgp: -3.55, grossPnlBeforeCostsEgp: -0.05, feesPaidEgp: 2.45,
    slippageCostEgp: 1.05, totalTradingCostEgp: 3.5, openPnlEgp: -0.08,
    ...over,
  },
  rows: {
    fills: Array.from({ length: 33 }, () => ({ quantity: 10, price: 6 })),
    positions: [{ status: 'CLOSED' }, { status: 'CLOSED' }],
  },
});

test('gross minus cost equals net, and the harness notices when it does not', () => {
  assert.equal(costBreakdown(fakeRun()).reconciles, true);
  assert.equal(costBreakdown(fakeRun({ netPnlEgp: -2 })).reconciles, false,
    'a broken identity must be reported, not smoothed');
});

test('cost burden is expressed in basis points of traded notional', () => {
  const b = costBreakdown(fakeRun());
  // 33 fills x 10 x 6 = 1980 EGP notional; 3.50 EGP of cost.
  assert.equal(Math.round(b.notionalEgp), 1980);
  assert.equal(Math.round(b.costBpsOfNotional * 10) / 10, 17.7);
});

test('costToGrossRatio is null when gross is indistinguishable from zero', () => {
  const b = costBreakdown(fakeRun({ grossPnlBeforeCostsEgp: 0 }));
  assert.equal(b.costToGrossRatio, null,
    'a ratio against a zero denominator would be Infinity or NaN');
});

test('pooledCosts flags that costs are essentially the whole loss', () => {
  const p = pooledCosts([fakeRun(), fakeRun()]);
  assert.equal(p.totalCostEgp, 7);
  assert.equal(p.netPnlEgp, -7.1);
  // 7.00 of cost against a 7.10 total loss = 98.6%. The residual 0.10 is the
  // gross trading result, i.e. the strategy itself was roughly flat and costs
  // did all the damage. Note it is <100%: gross was itself a small loss.
  assert.ok(p.costShareOfLossPct > 98 && p.costShareOfLossPct < 100,
    `cost share should be just under 100%, got ${p.costShareOfLossPct}`);
  assert.ok(Math.abs(p.grossPnlEgp) < Math.abs(p.totalCostEgp),
    'costs must exceed the gross result for "costs are the killer" to be true');
});

// ------------------------------------------------------------ causes of loss

test('the cause ranking closes against measured net P&L and reports the residual honestly', () => {
  const trades = [
    { exitKind: EXIT.STOP, netPnlEgp: -2, grossPnlEgp: -1.5, feesEgp: 0.3, slippageEgp: 0.2, holdMs: 10 },
    { exitKind: EXIT.SIGNAL, netPnlEgp: 1, grossPnlEgp: 1.4, feesEgp: 0.2, slippageEgp: 0.2, holdMs: 20 },
  ];
  // Realistic canary-shaped fixture: closed realised gross -0.10, open P&L -0.08,
  // engine gross (equity-based) -0.05, so unattributed is about +0.13.
  const runs = [fakeRun({
    grossPnlBeforeCostsEgp: -0.05, netPnlEgp: -3.55, openPnlEgp: -0.08,
    totalTradingCostEgp: 3.5,
  })];
  const c = rankCauses({ runs, trades });

  assert.equal(c.verify.closedRealisedGrossEgp, -0.1);
  assert.equal(c.verify.openPnlEgp, -0.08);
  assert.equal(c.verify.unattributedEgp, 0.13);
  assert.equal(c.verify.closes, true, 'the ranked terms must account for the whole loss');
  assert.equal(c.verify.netIdentityHolds, true);
  assert.equal(c.exitMix.closed, 2);
  assert.equal(c.exitMix.stopFireRatePct, 50);
});

test('the ranking flags a VACUOUS decomposition when the residual swallows the answer', () => {
  // Engine gross far larger than closed + unrealised P&L. Closure still holds by
  // construction, so the guard is the only thing that catches this.
  const trades = [{ exitKind: EXIT.SIGNAL, netPnlEgp: -0.1, grossPnlEgp: -0.1, feesEgp: 0, slippageEgp: 0, holdMs: 5 }];
  const c = rankCauses({
    runs: [fakeRun({ grossPnlBeforeCostsEgp: -40, netPnlEgp: -43.5, openPnlEgp: 0, totalTradingCostEgp: 3.5 })],
    trades,
  });
  assert.equal(c.verify.closes, true);
  assert.equal(c.verify.grossAttributionIsInformative, false,
    'a residual that dominates must be flagged, not presented as a clean ranking');
  assert.ok(c.verify.unattributedShareOfGrossPct > 90);
});

test('exit signals emitted are counted separately from trades they closed', () => {
  const trades = [{ exitKind: EXIT.STOP, netPnlEgp: -1, grossPnlEgp: -1, feesEgp: 0, slippageEgp: 0, holdMs: 5 }];
  const c = rankCauses({
    runs: [fakeRun({ grossPnlBeforeCostsEgp: -1, netPnlEgp: -4.5, openPnlEgp: 0, totalTradingCostEgp: 3.5 })],
    trades,
    signalTotals: { STOP: 9, SIGNAL: 4 },
  });
  const stop = c.exitTerms.find((t) => t.kind === EXIT.STOP);
  assert.equal(stop.signalsEmitted, 9);
  assert.equal(stop.closesFromSignal, 1,
    'nine stop signals closed one trade - collapsing these counts would hide it');
});

test('cost drag ranks by measured EGP, and it is signed against us', () => {
  const c = rankCauses({ runs: [fakeRun()], trades: [] });
  const cost = c.ranked.find((x) => x.id === 'cost-drag');
  assert.equal(cost.amountEgp, -3.5, 'a cost must be reported as a negative contribution');
});

// -------------------------------------------------------------------- arms

test('deepMerge preserves sibling keys', () => {
  assert.deepEqual(
    deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
    { a: { x: 1, y: 3, z: 4 } },
  );
});

test('a pinned stop arm pins all three band values so the clamp lands on it', () => {
  const arm = buildArms({ stopPcts: [2] }).find((a) => a.key === 'stop-2');
  assert.deepEqual(arm.overrides.risk, {
    minStopDistancePct: 2, defaultStopDistancePct: 2, maxStopDistancePct: 2,
  });
});

test('the ATR arm lowers only the floor, leaving the ceiling alone', () => {
  const arm = buildArms({ atrMultiples: [2] }).find((a) => a.key === 'atr-2');
  assert.equal(arm.overrides.risk.minStopDistancePct, 0.01);
  assert.equal(arm.overrides.risk.maxStopDistancePct, undefined,
    'the ceiling must not move; a lowered floor must not silently widen policy');
  assert.equal(arm.overrides.strategies.params.sma_cross.stopAtrMultiple, 2);
});

test('no arm writes an override into config/default.json', () => {
  for (const arm of buildArms()) {
    const keys = Object.keys(arm.overrides ?? {});
    assert.ok(!keys.includes('paths'), `${arm.key} overrides the database path`);
    assert.ok(!keys.includes('mode'), `${arm.key} overrides the mode`);
  }
});

test('exit reasons are classified from the production text', () => {
  assert.equal(classifyExit('Stop loss breached in TEOS/XIDX: mid 1 is at or below the stop 0.9. Closing the long immediately.'), EXIT.STOP);
  assert.equal(classifyExit('SMA10 crossed below SMA30 in TEOS/XIDX.'), EXIT.SIGNAL);
  assert.equal(classifyExit('Take-profit reached in TEOS/XIDX.'), EXIT.TAKE_PROFIT);
  assert.equal(classifyExit(''), EXIT.SIGNAL);
});

// ------------------------------------------------------------------ regimes

const mkCandles = (closes) => closes.map((c, i) => ({ high: c * 1.001, low: c * 0.999, close: c, ts: i }));

test('regime tags split the path roughly in half by construction', () => {
  // Volatility and trend are ranked WITHIN each path, so an absolute level
  // cannot skew the split. That is the whole reason for percentile tagging.
  const candles = mkCandles(Array.from({ length: 120 }, (_, i) => 100 + (i % 7) * (i % 3 === 0 ? 3 : -2)));
  const { tags, stats } = tagRegimes(candles);
  const defined = tags.filter((t) => t.regime != null);
  assert.ok(defined.length > 0);
  assert.ok(Math.abs(stats.countHighVol - stats.countLowVol) <= 2,
    `high/low vol split should be balanced, got ${stats.countHighVol}/${stats.countLowVol}`);
  assert.ok(Math.abs(stats.countTrend - stats.countRange) <= 2,
    `trend/range split should be balanced, got ${stats.countTrend}/${stats.countRange}`);
});

test('bars before the indicators are defined are tagged null, not LOW', () => {
  const { tags } = tagRegimes(mkCandles(Array.from({ length: 30 }, () => 100)));
  assert.equal(tags[0].regime, null, 'the first bars have no ATR and must not be labelled');
});