/**
 * TEOS Trade Agent - backtest/engine.js
 *
 * Runs a strategy over a recorded price history through the SAME pipeline that
 * paper trading uses:
 *
 *     REPLAY FEED -> AGENT -> RISK ENGINE -> SENTINEL -> ADAPTER -> MATCHING ENGINE
 *                                                                  -> PAPER ACCOUNT
 *
 * There is no "backtest simplification" anywhere in this path. The risk engine
 * applies the same limits, the Sentinel issues the same verdicts, orders fill
 * partially at slipped prices with fees charged. A backtest that skipped those
 * steps would report numbers the paper trader could never reproduce, which is
 * worse than reporting nothing.
 *
 * MODE ISOLATION
 * --------------
 * A backtest writes to `teos-backtest.db` and stamps every row `mode =
 * 'BACKTEST'`. Every table has a CHECK constraint that rejects any other value,
 * and the repositories are constructed with that mode, so a backtest can neither
 * read nor write a single PAPER row. Conversely a backtest result can never
 * contaminate the paper account's equity curve or trade history.
 */

import { Worker } from '../worker/worker.js';
import { MockBroker } from '../broker/mock/mock-broker.js';
import { ManualClock } from '../core/clock.js';
import { createLogger } from '../core/logger.js';
import { newId } from '../core/ids.js';
import { roundEgp, roundTo } from '../core/money.js';
import { computeMetrics } from './metrics.js';
import { toBacktestReport } from './report.js';
import { saveBacktestRun, saveBacktestTrades } from './persist.js';

export const BACKTEST_MODE = 'BACKTEST';

export class BacktestEngine {
  #config;
  #clock;
  #logger;
  #worker = null;
  #broker = null;
  #feed = null;
  #strategyId = null;
  #mode = BACKTEST_MODE;
  #seed = null;

  constructor({ config, feed, clock = null, logger = null, strategyId = null, seed = null }) {
    if (config.mode !== BACKTEST_MODE) {
      throw new Error(`BacktestEngine requires config.mode === 'BACKTEST' (got ${config.mode}). Refusing to mix modes.`);
    }
    this.#config = config;
    this.#clock = clock ?? new ManualClock(0);
    this.#logger = logger ?? createLogger({ level: 'warn', name: 'backtest' });
    this.#strategyId = strategyId ?? config.strategies.active;
    // The history seed and the broker seed are the same value. The history
    // generator already received it; without forwarding it here the broker
    // would fall back to `config.market.seed` and every path in a multi-seed
    // study would share one execution-noise stream.
    this.#seed = seed;
    this.#feed = feed;
  }

  get mode() { return this.#mode; }
  get feed() { return this.#feed; }
  get worker() { return this.#worker; }
  get broker() { return this.#broker; }

  /**
   * Execute the backtest.
   *
   * @param {object} p
   * @param {number} [p.maxTicks]  stop after N replayed ticks (default: the whole history)
   * @param {number} [p.warmupTicks] ticks to replay before trading starts
   * @param {boolean}[p.persist]   write the result to the BACKTEST database
   */
  async run({ maxTicks = null, warmupTicks = 0, persist = true } = {}) {
    const feed = this.#feed;
    if (!feed) throw new Error('BacktestEngine requires a replay feed.');
    const total = maxTicks ?? feed.totalTicks;
    if (total > feed.totalTicks) {
      throw new Error(`Requested ${total} ticks but the recorded history only has ${feed.totalTicks}.`);
    }

    const clock = new ManualClock(feed.history.startMs ?? 0);
    this.#clock = clock;

    // The worker owns the loop, the account, the audit trail and the database.
    // The only thing this class supplies is the price source.
    const worker = new Worker({
      config: this.#config, clock, mode: this.#mode,
      logger: this.#logger, strategyId: this.#strategyId,
      seed: this.#seed,
    });
    this.#worker = worker;
    const boot = worker.start({ resume: false });
    if (boot.isResume) {
      throw new Error('Backtest refused to start: it resumed an existing run. A backtest always starts from EGP 500.');
    }

    // Swap the market source AFTER the account exists (the broker is constructed
    // with a reference to it) and BEFORE the first tick.
    this.#broker = worker.broker;
    this.#broker.setMarketSource(feed);
    this.#broker.connect();

    const equitySeries = [];
    const startMs = clock.now();
    let warmupLeft = Math.max(0, warmupTicks);
    let ticks = 0;
    const errors = [];

    for (let i = 0; i < total; i += 1) {
      if (feed.exhausted) break;
      clock.advance(feed.history.tickMs ?? this.#config.market.tickMs);

      if (warmupLeft > 0) {
        // Replay warm-up without trading: the agent is not permitted to
        // evaluate until it has enough history anyway, so this only spares the
        // database the snapshot writes.
        this.#broker.tick();
        warmupLeft -= 1;
        ticks += 1;
        continue;
      }

      const step = await worker.tick();
      ticks += 1;
      if (step.errors?.length) errors.push(...step.errors);
      if (i % 10 === 0 || i === total - 1) equitySeries.push(worker.account.equityEgp);
    }

    const account = worker.account.snapshot();
    const elapsedMs = clock.now() - startMs;
    // Scope every count to THIS run. A backtest database is reused across runs;
    // reading unscoped totals would fold the previous run's trades, orders and
    // emergency stops into this one's report.
    const runId = worker.runId;
    const trades = worker.repos.closedTrades(this.#mode, runId);
    const metrics = computeMetrics({
      equitySeries,
      startingCapitalEgp: this.#config.account.startingCapitalEgp,
      trades,
      costs: { feesPaidEgp: account.feesPaidEgp, slippageCostEgp: account.slippageCostEgp },
      elapsedMs,
      equitySampleMs: (feed.history.tickMs ?? 1000) * 10,
    });

    const result = {
      backtestId: newId('bt'),
      runId,
      mode: this.#mode,
      strategyId: this.#strategyId,
      params: this.#config.strategies.params[this.#strategyId],
      seed: feed.history.seed,
      ticks,
      warmupTicks,
      startedAtMs: startMs,
      endedAtMs: clock.now(),
      elapsedMs,
      startingCapitalEgp: this.#config.account.startingCapitalEgp,
      finalEquityEgp: account.equityEgp,
      account,
      counts: {
        decisions: worker.repos.countDecisions(this.#mode, runId),
        orders: worker.repos.countOrders(this.#mode, runId),
        fills: worker.repos.db.count('SELECT COUNT(*) AS c FROM fills WHERE mode = ? AND run_id = ?', this.#mode, runId),
        riskDecisions: worker.repos.db.count('SELECT COUNT(*) AS c FROM risk_decisions WHERE mode = ? AND run_id = ?', this.#mode, runId),
        sentinelDecisions: worker.repos.db.count('SELECT COUNT(*) AS c FROM sentinel_decisions WHERE mode = ? AND run_id = ?', this.#mode, runId),
        blocked: worker.repos.db.count(
          'SELECT COUNT(*) AS c FROM risk_decisions WHERE mode = ? AND run_id = ? AND blocked = 1', this.#mode, runId,
        ),
        quarantined: worker.repos.db.count(
          "SELECT COUNT(*) AS c FROM sentinel_decisions WHERE mode = ? AND run_id = ? AND action_taken = 'QUARANTINE'", this.#mode, runId,
        ),
        errors: errors.length,
        emergencyStops: worker.repos.db.count(
          'SELECT COUNT(*) AS c FROM emergency_stops WHERE mode = ? AND run_id = ? AND active = 1', this.#mode, runId,
        ),
      },
      equitySeries,
      trades,
      metrics,
    };
    result.report = toBacktestReport(result);

    await worker.stop({ reason: 'backtest complete' });

    if (persist) {
      saveBacktestRun(result, worker.repos, clock);
      saveBacktestTrades(result, worker.repos);
    }
    result.persisted = persist;
    return result;
  }
}

/** Convenience: generate a history, run it, return the report. */
export async function runBacktest({ config, ticks, seed = null, strategyId = null, maxTicks = null, persist = true, logger = null }) {
  const { generateHistory, ReplayFeed } = await import('./replay-feed.js');
  const history = generateHistory({ config, ticks, seed });
  const feed = new ReplayFeed(history, config);
  const engine = new BacktestEngine({ config, feed, strategyId, logger, seed });
  return engine.run({ maxTicks, persist });
}

export { roundEgp, roundTo };
