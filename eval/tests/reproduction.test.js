/**
 * TEOS evaluation harness - tests/reproduction.test.js
 *
 * THE GATE. This is the most important test in the repository.
 *
 * The canary run (seed 20260928, 2500 ticks) is a known losing result:
 *
 *     net P&L (equity)   EGP -3.55      closed-trade net   EGP -3.47
 *     total return       -0.71%         max drawdown       0.71% of peak
 *     closed trades      7              win rate           0.00%
 *     expectancy/trade   EGP -0.50       fees               EGP 2.45
 *     slippage           EGP 1.05
 *     18 decisions       16 orders      33 fills
 *
 * If the harness cannot recreate that through its own code path, then no
 * multi-seed number it produces can be trusted - the harness might be driving
 * the engine differently from the CLI, or not driving it at all.
 *
 * The expected values are asserted against the engine's OWN reported metrics
 * and against rows read straight out of the run's database, so this cannot pass
 * by coincidence in a summary line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runOnce, buildTrades } from '../driver.js';
import { buildArms } from '../arms.js';
import { tagRun } from '../regimes.js';

const CANARY = {
  seed: 20260928,
  ticks: 2500,
  netPnlEgp: -3.55,
  closedTradeNetPnlEgp: -3.47,
  totalReturnPct: -0.71,
  maxDrawdownPct: 0.71,
  tradeCount: 7,
  winRatePct: 0,
  expectancyEgp: -0.5,
  feesPaidEgp: 2.45,
  slippageCostEgp: 1.05,
  decisions: 18,
  orders: 16,
  fills: 33,
};

/** EGP amounts are rounded to 2dp by production code, so compare to the cent. */
const cent = (v) => Math.round(v * 100) / 100;

let cached = null;
async function canaryRun() {
  if (!cached) {
    const arm = buildArms().find((a) => a.key === 'base');
    cached = tagRun(await runOnce({ arm, seed: CANARY.seed, ticks: CANARY.ticks }));
  }
  return cached;
}

test('harness reproduces the canary net P&L exactly', async () => {
  const r = await canaryRun();
  assert.equal(cent(r.metrics.netPnlEgp), CANARY.netPnlEgp);
  assert.equal(cent(r.metrics.closedTradeNetPnlEgp), CANARY.closedTradeNetPnlEgp);
});

test('harness reproduces the canary return and drawdown', async () => {
  const r = await canaryRun();
  assert.equal(cent(r.metrics.totalReturnPct), CANARY.totalReturnPct);
  assert.equal(cent(r.metrics.maxDrawdownPct), CANARY.maxDrawdownPct);
});

test('harness reproduces the canary cost model', async () => {
  const r = await canaryRun();
  assert.equal(cent(r.metrics.feesPaidEgp), CANARY.feesPaidEgp);
  assert.equal(cent(r.metrics.slippageCostEgp), CANARY.slippageCostEgp);
  assert.equal(cent(r.metrics.totalTradingCostEgp), CANARY.feesPaidEgp + CANARY.slippageCostEgp);
  assert.equal(cent(r.metrics.grossPnlBeforeCostsEgp), -0.05);
});

test('harness reproduces the canary trade statistics', async () => {
  const r = await canaryRun();
  assert.equal(r.metrics.tradeCount, CANARY.tradeCount);
  assert.equal(r.metrics.winRatePct, CANARY.winRatePct);
  assert.equal(cent(r.metrics.expectancyEgp), CANARY.expectancyEgp);
});

test('harness reproduces the canary event counts', async () => {
  const r = await canaryRun();
  assert.equal(r.rows.decisions.length, CANARY.decisions);
  assert.equal(r.rows.orders.length, CANARY.orders);
  assert.equal(r.rows.fills.length, CANARY.fills);
});

test('the database rows reconcile with the engine metrics', async () => {
  const r = await canaryRun();
  const { reconciliation } = buildTrades(r);
  assert.equal(reconciliation.pooledNetPnlEgp, CANARY.closedTradeNetPnlEgp,
    'the trades reconstructed from the positions table do not sum to the '
    + "engine's closed-trade net. The report's per-trade numbers would be wrong.");
});

test('the canary loss really is a loss - the baseline has not silently turned profitable', async () => {
  const r = await canaryRun();
  assert.ok(r.metrics.netPnlEgp < 0,
    'the protected canary baseline is no longer negative. Either the system '
    + 'changed behaviour, or this harness is no longer driving the same code.');
});