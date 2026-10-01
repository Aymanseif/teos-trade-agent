/**
 * TEOS evaluation harness - driver.js
 *
 * THE ONLY MODULE IN eval/ THAT CALLS PRODUCTION CODE.
 *
 * Everything measured here is produced by the real pipeline:
 *
 *   generateHistory -> ReplayFeed -> Worker -> AgentEngine -> RiskEngine
 *   -> Sentinel -> ExecutionAdapter -> MatchingEngine -> Ledger
 *
 * There is no reimplementation of entry logic, exit logic, risk, execution or
 * accounting anywhere in this harness. If a number in a report is wrong, the
 * bug is in the system under test, not in a shortcut taken here.
 *
 * Two rules this module enforces:
 *   - one temporary database per run (`createWorkspace`)
 *   - `persist: false`, because the harness reads rows directly and a persisted
 *     run row is not part of any measurement
 */

import { loadConfig } from '../src/core/config.js';
import { generateHistory, ReplayFeed } from '../src/backtest/replay-feed.js';
import { BacktestEngine } from '../src/backtest/engine.js';
import { registerStrategy } from '../src/agent/strategies/registry.js';
import { openDatabase } from '../src/database/db.js';
import { createWorkspace } from './workspace.js';
import { classifyExit, EXIT } from './arms.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `loadConfig` resolves `config/default.json` relative to `process.cwd()` when
 * no path is given. The harness resolves it from its own location instead, so
 * `node eval/run.js` behaves the same from the repository root, from `eval/`, or
 * from a scheduled task. Without this, running the study from the wrong
 * directory fails with a ConfigError that looks like a missing file.
 */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = join(REPO_ROOT, 'config', 'default.json');

/** Registered harness strategies, so repeated arms do not re-register. */
const registered = new Set();

function ensureRegistered(strategy) {
  if (strategy == null) return null;
  if (!registered.has(strategy.id)) {
    registerStrategy(strategy);
    registered.add(strategy.id);
  }
  return strategy;
}

/**
 * Run one (arm, seed) pair and return everything the report needs.
 *
 * @param {object}   p
 * @param {object}   p.arm          an arm from `buildArms`
 * @param {number}   p.seed         price-path AND execution-noise seed
 * @param {number}   p.ticks        history length
 * @param {boolean}  [p.keepDir]    retain the temp database (debugging)
 * @param {string}   [p.workspaceParent] create the workspace inside this dir
 * @param {(msg:string)=>void} [p.log]
 */
export async function runOnce({ arm, seed, ticks, keepDir = false, workspaceParent, log = () => {} }) {
  const ws = createWorkspace(`${arm.key}-${seed}`, workspaceParent);
  const startedHr = process.hrtime.bigint();

  try {
    // A stateful harness strategy MUST be rebuilt per run: its entry/exit memory
    // from one seed would otherwise leak into the next.
    const strategy = ensureRegistered(arm.strategy ? arm.strategy(seed) : null);
    const strategyId = strategy ? strategy.id : null;

    const config = loadConfig({
      path: CONFIG_PATH,
      overrides: { mode: 'BACKTEST', ...(arm.overrides ?? {}) },
      env: ws.env,
    });

    const history = generateHistory({ config, ticks, seed });
    const feed = new ReplayFeed(history, config);
    const engine = new BacktestEngine({ config, feed, strategyId, seed });
    const result = await engine.run({ maxTicks: null, persist: false });

    const wallMs = Number((process.hrtime.bigint() - startedHr) / 1_000_000n);

    // The candles the run actually saw, read off the run's own feed. Aggregating
    // them here instead would mean reimplementing the broker's roll cadence.
    const candlesBySymbol = {};
    for (const sym of history.symbols) candlesBySymbol[sym] = feed.candles(sym);

    const rows = readRunRows(ws.dbFile, result.runId);

    log(`${arm.key} seed ${seed}: net ${result.metrics.netPnlEgp} EGP, ${result.metrics.tradeCount} trades, ${wallMs} ms`);

    return {
      arm: arm.key,
      armGroup: arm.group,
      armLabel: arm.label,
      strategyId: strategyId ?? config.strategies.active,
      seed,
      ticks,
      wallMs,
      // The raw production result, for anyone who wants to audit a number.
      metrics: result.metrics,
      counts: result.counts,
      // Harness-only introspection from the overlay strategies (how many random
      // entries an arm actually made). `null` for the production strategy, which
      // is a pure function and has no such notion.
      strategyStats: typeof strategy?.stats === 'function' ? strategy.stats() : null,
      // The engine's OWN closed-trade array - literally the rows it passed to
      // `computeMetrics`. Using these instead of re-querying the positions table
      // guarantees the harness's trade set is the engine's trade set, and makes
      // a reconciliation failure impossible by construction.
      trades: result.trades,
      config,
      historyMeta: {
        seed: history.seed,
        startMs: history.startMs,
        tickMs: history.tickMs,
        ticksPerCandle: history.ticksPerCandle,
        bars: Math.floor(history.ticks / history.ticksPerCandle),
        symbols: history.symbols,
      },
      candlesBySymbol,
      rows,
    };
  } finally {
    // On Windows the worker's SQLite handle is still mapped at this point, so
    // this usually fails and the directory leaks. That is why `eval/pool.js`
    // runs one job per process and deletes the directory from the PARENT after
    // the child has exited. In-process callers (the tests) accept the leak.
    if (!keepDir) ws.dispose(); else log(`kept workspace ${ws.dir}`);
  }
}

/** Read the audit rows for one run out of its own database. */
function readRunRows(dbFile, runId) {
  const db = openDatabase(dbFile, { readonly: true });
  try {
    return {
      decisions: db.all(
        `SELECT ts_ms, symbol, signal, price, stop_price, stop_distance_pct, confidence, reason, action
           FROM agent_decisions WHERE mode='BACKTEST' AND run_id=? ORDER BY ts_ms ASC`, runId),
      orders: db.all(
        `SELECT submitted_ms, symbol, side, quantity, expected_price, filled_quantity, status
           FROM orders WHERE mode='BACKTEST' AND run_id=? ORDER BY submitted_ms ASC`, runId),
      fills: db.all(
        `SELECT ts_ms, symbol, side, quantity, price, fee_egp, slippage_cost_egp, decision_id
           FROM fills WHERE mode='BACKTEST' AND run_id=? ORDER BY ts_ms ASC`, runId),
      // `positions` has NO closed_ms column - only `closed_at` (ISO text). The
      // timestamp is derived exactly as production `computeMetrics` does it, so
      // the hold time here and the hold time in the engine agree.
      positions: db.all(
        `SELECT position_id, symbol, avg_entry_price, realized_pnl_egp, fees_paid_egp,
                slippage_cost_egp, opened_ms, closed_at, status
           FROM positions WHERE mode='BACKTEST' AND run_id=? ORDER BY opened_ms ASC`, runId),
    };
  } finally {
    db.close();
  }
}

/**
 * One row per closed trade, attributed to the exit that closed it and tagged
 * with the regime at entry.
 *
 * SOURCE OF TRUTH: `run.trades`, the engine's own closed-trade array. This is
 * the same array `computeMetrics` used, so `sum(netPnlEgp)` here equals the
 * engine's `closedTradeNetPnlEgp` by construction.
 *
 * `netPnlEgp` per trade is realised P&L minus that trade's OWN fees and
 * slippage: the all-in result of the round trip, not the mark-to-market.
 *
 * A SIGNAL IS NOT A FILL. `signalsByKind` counts exit DECISIONS that were
 * emitted, and `exitKind` counts trades that were actually closed by that path.
 * They are reported separately because they genuinely differ: in the 1R
 * take-profit arm the target was reached and the SELL was submitted, yet the
 * trade still closed via the stop nineteen seconds later. Collapsing the two
 * counts would have reported "the take-profit never fired" when the truth is
 * "the take-profit fired and did not take effect".
 */
export function buildTrades(run) {
  const { decisions } = run.rows;
  const { historyMeta, metrics } = run;

  const sellsBySymbol = new Map();
  for (const d of decisions) {
    if (d.signal !== 'SELL') continue;
    if (!sellsBySymbol.has(d.symbol)) sellsBySymbol.set(d.symbol, []);
    sellsBySymbol.get(d.symbol).push(d);
  }
  for (const list of sellsBySymbol.values()) list.sort((a, b) => a.ts_ms - b.ts_ms);

  // Exit decisions EMITTED, regardless of whether they ever closed a position.
  const signalsByKind = {};
  for (const d of decisions) {
    if (d.signal !== 'SELL') continue;
    const k = classifyExit(d.reason);
    signalsByKind[k] = (signalsByKind[k] ?? 0) + 1;
  }

  const trades = [];
  for (const p of run.trades) {
    if (p.status !== 'CLOSED') continue;
    const closedMs = p.closed_at != null ? Date.parse(p.closed_at) : null;
    const list = sellsBySymbol.get(p.symbol) ?? [];
    // The last exit decision at or before the close: that is the one whose
    // order produced the closing fill.
    let exitDecision = null;
    if (closedMs != null) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].ts_ms <= closedMs) { exitDecision = list[i]; break; }
      }
    }
    const exitKind = exitDecision ? classifyExit(exitDecision.reason) : EXIT.UNKNOWN;

    const fees = p.fees_paid_egp ?? 0;
    const slip = p.slippage_cost_egp ?? 0;
    const grossPnl = p.realized_pnl_egp ?? 0;

    trades.push({
      arm: run.arm,
      seed: run.seed,
      positionId: p.position_id,
      symbol: p.symbol,
      entryPrice: p.avg_entry_price,
      openedMs: p.opened_ms,
      closedMs,
      holdMs: closedMs != null ? closedMs - p.opened_ms : null,
      grossPnlEgp: grossPnl,
      feesEgp: fees,
      slippageEgp: slip,
      netPnlEgp: grossPnl - fees - slip,
      exitKind,
      exitReason: exitDecision ? exitDecision.reason : null,
      ...entryRegime(run, p.symbol, p.opened_ms),
    });
  }

  // Reconcile against production. The engine computes the same sum from the same
  // array, so a mismatch means the harness has diverged from the engine and
  // every pooled statistic below would be quietly wrong.
  const pooledNet = round2(trades.reduce((s, t) => s + t.netPnlEgp, 0));
  const engineClosed = round2(metrics.closedTradeNetPnlEgp ?? 0);
  return {
    trades,
    signalsByKind,
    reconciliation: {
      pooledNetPnlEgp: pooledNet,
      engineClosedTradeNetPnlEgp: engineClosed,
      engineNetPnlEgp: round2(metrics.netPnlEgp),
      difference: round2(pooledNet - engineClosed),
    },
  };
}

/** Regime of the candle in which the position was opened. */
function entryRegime(run, symbol, openedMs) {
  const { startMs, tickMs, ticksPerCandle } = run.historyMeta;
  const tickIndex = Math.max(0, Math.floor((openedMs - startMs) / tickMs));
  const candleIndex = Math.floor(tickIndex / ticksPerCandle);
  return { candleIndex, regime: run.regimeBySymbol?.[symbol]?.[candleIndex] ?? null };
}

function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
