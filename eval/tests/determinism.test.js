/**
 * TEOS evaluation harness - tests/determinism.test.js
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING.
 *
 * 1. Same (arm, seed) twice must produce bit-identical results. Without this a
 *    multi-seed study measures noise in the harness rather than in the system,
 *    and the harness becomes the thing under test.
 *
 * 2. Different seeds must produce different results. This is what the
 *    seed-threading change was made for: before it, `Worker` built its
 *    `MockBroker` with `config.market.seed` unconditionally, so every path in a
 *    multi-seed study replayed ONE execution-noise stream - slippage jitter,
 *    partial fill ratios and spread noise - and only the price path varied.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runOnce } from '../driver.js';
import { buildArms } from '../arms.js';

// sma_cross needs 40 bars and a bar is 30 ticks, so anything under ~1500 ticks
// produces ZERO trades. Verified: 1200 ticks = 40 bars = 0 decisions, 0 fills.
// A determinism test over a run that does nothing would pass while testing
// nothing, so these use a length that actually trades.
const TICKS = 2500;
const BASE = buildArms().find((a) => a.key === 'base');

const fingerprint = (r) => JSON.stringify({
  m: r.metrics, c: r.counts,
  decisions: r.rows.decisions.length,
  orders: r.rows.orders.length,
  fills: r.rows.fills.map((f) => [f.ts_ms, f.symbol, f.quantity, f.price, f.fee_egp, f.slippage_cost_egp]),
  positions: r.rows.positions.map((p) => [p.symbol, p.avg_entry_price, p.realized_pnl_egp, p.status]),
});

test('the same arm and seed reproduce exactly', async () => {
  const a = await runOnce({ arm: BASE, seed: 777, ticks: TICKS });
  const b = await runOnce({ arm: BASE, seed: 777, ticks: TICKS });
  assert.ok(a.metrics.tradeCount > 0, 'this run traded nothing, so the test proves nothing');
  assert.equal(fingerprint(a), fingerprint(b),
    'the harness is not deterministic; its own results are worthless');
});

test('a different seed produces a different run', async () => {
  const a = await runOnce({ arm: BASE, seed: 777, ticks: TICKS });
  const b = await runOnce({ arm: BASE, seed: 778, ticks: TICKS });
  assert.notEqual(fingerprint(a), fingerprint(b),
    'seed had no effect at all - is the seed being forwarded to the engine?');
});

test('the seed reaches the broker, not only the price history', async () => {
  // A price-path-only difference changes which symbols trade. It does NOT change
  // the slippage charged on a given fill - that comes from the broker's own Rng,
  // which is what the seed-threading change exists to reseed. So we compare the
  // per-fill COST fields rather than the prices.
  const a = await runOnce({ arm: BASE, seed: 5001, ticks: TICKS });
  const b = await runOnce({ arm: BASE, seed: 5002, ticks: TICKS });
  assert.ok(a.rows.fills.length > 0 && b.rows.fills.length > 0, 'no fills to compare');
  const costStream = (r) => JSON.stringify(r.rows.fills.map((f) => [f.fee_egp, f.slippage_cost_egp]));
  assert.notEqual(costStream(a), costStream(b),
    'the fee/slippage stream is identical across seeds - the broker RNG is still shared');
});