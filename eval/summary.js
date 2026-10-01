/**
 * TEOS evaluation harness - summary.js
 *
 * Reduces one full run object to a compact, JSON-serialisable record.
 *
 * WHY THIS EXISTS
 * ---------------
 * A run's raw output includes the full candle series and the full regime tag
 * array for every symbol. At 15 arms x 200 seeds that is far too much to hand
 * between processes, and none of it is needed after the trades are built.
 *
 * So every number the report can use is derived HERE, inside the child process
 * that owns the database, and only the compact record travels back to the
 * parent. The parent aggregates; it never re-derives anything from raw rows,
 * because that is exactly where a report silently starts disagreeing with the
 * engine.
 */

import { tagRun } from './regimes.js';
import { buildTrades } from './driver.js';
import { costBreakdown } from './costs.js';
import { round } from './stats.js';

/**
 * @param {object} run            full run object from `runOnce`
 * @returns {object}              compact record, safe to JSON.stringify
 */
export function summarise(run) {
  const tagged = tagRun(run);
  const { trades, signalsByKind, reconciliation } = buildTrades(tagged);
  const cost = costBreakdown(run);

  // The distinct effective stop distances the risk engine actually approved on
  // a BUY. This is the measured outcome of the stop arm, not the requested
  // value, so it shows whether a requested ATR stop was clamped up to the floor.
  const effectiveStopPcts = [...new Set(run.rows.decisions
    .filter((d) => d.signal === 'BUY' && d.stop_distance_pct != null)
    .map((d) => round(d.stop_distance_pct, 4)))]
    .sort((a, b) => a - b);

  return {
    arm: run.arm,
    armGroup: run.armGroup,
    armLabel: run.armLabel,
    strategyId: run.strategyId,
    // Hoisted out of `strategyStats` because the report needs it as a scalar to
    // average across seeds (the one-shot latch of the original control shows up
    // here as a flat ~1.0 while the fixed control's scales with the seed).
    randomEntries: run.strategyStats?.randomEntries ?? null,
    strategyStats: run.strategyStats,
    seed: run.seed,
    ticks: run.ticks,
    wallMs: run.wallMs,

    // Production output, passed through untouched.
    metrics: run.metrics,
    counts: run.counts,

    historyMeta: run.historyMeta,
    regimeStats: run.regimeStats,

    // The policy stop floor actually in force for this run, so the report can
    // state it as a measured fact rather than a constant typed into the report.
    stopFloorPct: run.config.risk.minStopDistancePct,
    stopCeilingPct: run.config.risk.maxStopDistancePct,

    // Derived, so the parent never has to touch a fills table.
    notionalEgp: round(cost.notionalEgp, 4),
    fillCount: cost.fills,
    openPositionCount: run.rows.positions.filter((p) => p.status === 'OPEN').length,
    effectiveStopPcts,

    trades,
    signalsByKind,
    reconciliation,
  };
}