/**
 * TEOS evaluation harness - tests/seed-threading.test.js
 *
 * PINS THE ONE PRODUCTION CHANGE MADE FOR THIS HARNESS.
 *
 * Before: `Worker` built its `MockBroker` with `seed: this.#config.market.seed`
 * unconditionally. `generateHistory` received a per-seed value, but the broker
 * did not, so in a multi-seed study the price path varied while slippage
 * jitter, partial-fill ratios and spread noise replayed as ONE identical
 * stream. The runs were not independent.
 *
 * After: `Worker`, `BacktestEngine` and `runBacktest` accept `seed = null`,
 * which falls back to `config.market.seed` and reproduces the previous
 * behaviour exactly.
 *
 * These tests pin BOTH halves. The fallback half matters more: if a future
 * change made `null` mean "unseeded" instead of "unchanged", every existing
 * caller would silently start getting a different execution stream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/core/config.js';
import { generateHistory, ReplayFeed } from '../../src/backtest/replay-feed.js';
import { BacktestEngine, runBacktest } from '../../src/backtest/engine.js';
import { Worker } from '../../src/worker/worker.js';
import { ManualClock } from '../../src/core/clock.js';
import { createWorkspace } from '../workspace.js';

// Long enough to trade. Below ~1500 ticks (50 bars) sma_cross never evaluates,
// so a shorter run produces zero decisions and every comparison below would pass
// vacuously.
const TICKS = 2500;

async function runWith({ seed, ticks = TICKS }) {
  const ws = createWorkspace('seed-threading');
  try {
    // BACKTEST mode is mandatory: BacktestEngine refuses to run against a PAPER
    // config, and refusing is correct.
    const config = loadConfig({ overrides: { mode: 'BACKTEST' }, env: ws.env });
    const history = generateHistory({ config, ticks, seed });
    const feed = new ReplayFeed(history, config);
    const engine = new BacktestEngine({ config, feed, seed });
    return await engine.run({ persist: false });
  } finally {
    ws.dispose();
  }
}

const shape = (r) => JSON.stringify({
  net: r.metrics.netPnlEgp,
  trades: r.metrics.tradeCount,
  counts: r.counts,
});

test('seed: null (the default) reproduces a run with no seed argument at all', async () => {
  const implicit = await runWith({ seed: undefined });
  const explicitNull = await runWith({ seed: null });
  assert.equal(shape(implicit), shape(explicitNull),
    'passing seed: null changed the run. The default MUST be behaviour-preserving.');
});

test('seed: null falls back to config.market.seed, not to an unseeded RNG', async () => {
  const ws = createWorkspace('seed-fallback');
  const marketSeed = loadConfig({ overrides: { mode: 'BACKTEST' }, env: ws.env }).market.seed;
  ws.dispose();

  const implicit = await runWith({ seed: undefined });
  const explicit = await runWith({ seed: marketSeed });
  assert.equal(shape(implicit), shape(explicit),
    `an unseeded run did not match a run seeded with config.market.seed (${marketSeed}). `
    + 'The null fallback is not wired to the config.');
});

test('a non-null seed produces a different run', async () => {
  const a = await runWith({ seed: null });
  const b = await runWith({ seed: 999 });
  assert.notEqual(shape(a), shape(b), 'an explicit seed had no effect on the run');
});

test('runBacktest forwards the seed too', async () => {
  // runBacktest takes `ticks`, not `feed`: it generates its own history. That
  // makes it the path most likely to silently drop a forwarded seed.
  const ws = createWorkspace('rb');
  try {
    const config = loadConfig({ overrides: { mode: 'BACKTEST' }, env: ws.env });
    const a = await runBacktest({ config, ticks: 2500, seed: null, persist: false });
    const b = await runBacktest({ config, ticks: 2500, seed: 999, persist: false });
    assert.notEqual(shape(a), shape(b),
      'runBacktest is not forwarding the seed to BacktestEngine - a caller using '
      + 'the convenience wrapper would still share one execution stream.');
  } finally {
    ws.dispose();
  }
});

test('Worker accepts a seed and still builds when none is given', async () => {
  // Guards against the constructor default breaking existing callers such as the
  // paper worker and the CLI.
  const ws = createWorkspace('worker');
  try {
    const config = loadConfig({ overrides: { mode: 'BACKTEST' }, env: ws.env });
    const clock = new ManualClock(Date.UTC(2025, 0, 1));
    const w1 = new Worker({ config, clock, mode: 'BACKTEST' });
    const w2 = new Worker({ config, clock, mode: 'BACKTEST', seed: 4242 });
    assert.ok(w1, 'Worker without a seed must still construct');
    assert.ok(w2, 'Worker with a seed must construct');
  } finally {
    ws.dispose();
  }
});