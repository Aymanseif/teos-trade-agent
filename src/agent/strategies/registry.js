/**
 * TEOS Trade Agent - agent/strategies/registry.js
 *
 * Strategy registry. Adding a strategy is a one-line change here plus a new
 * module; the engine, risk layer, sentinel and backtester need no edits.
 *
 * Every strategy is validated against STRATEGY_INTERFACE at import time, so a
 * malformed strategy fails loudly at boot instead of silently at 3am.
 */

import { assertStrategyShape } from './strategy.interface.js';
import { smaCross } from './sma_cross.js';
import { rsiReversion } from './rsi_reversion.js';
import { donchianBreakout } from './donchian_breakout.js';

const REGISTRY = new Map();

export function registerStrategy(strategy) {
  assertStrategyShape(strategy);
  if (REGISTRY.has(strategy.id)) {
    throw new Error(`Strategy id "${strategy.id}" is already registered.`);
  }
  REGISTRY.set(strategy.id, strategy);
  return strategy;
}

for (const s of [smaCross, rsiReversion, donchianBreakout]) registerStrategy(s);

export function getStrategy(id) {
  const s = REGISTRY.get(id);
  if (!s) {
    throw new Error(`Unknown strategy "${id}". Available: ${[...REGISTRY.keys()].join(', ')}`);
  }
  return s;
}

export function listStrategies() {
  return [...REGISTRY.values()].map((s) => ({
    id: s.id, description: s.description, minBars: s.minBars, defaultParams: s.defaultParams,
  }));
}

export function resetStrategies() {
  REGISTRY.clear();
  for (const s of [smaCross, rsiReversion, donchianBreakout]) registerStrategy(s);
}
