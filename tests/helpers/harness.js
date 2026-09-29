/**
 * TEOS Trade Agent - tests/helpers/harness.js
 *
 * A disposable, fully deterministic trading stack for tests.
 *
 * Everything a test needs to exercise a SAFETY PROPERTY is assembled here:
 *   config -> database -> audit chain -> repositories -> paper account
 *          -> mock broker -> risk engine -> sentinel -> adapter -> firewall
 *
 * Design constraints (these are the rules the whole suite obeys):
 *
 *  - NO NETWORK. The mock broker is in-process and never opens a socket. The
 *    dashboard tests bind to an ephemeral port on 127.0.0.1 and immediately
 *    close it.
 *  - NO CREDENTIALS. `loadConfig` runs the same `assertNoCredentialsPresent` and
 *    `assertLiveTradingDisabled` guards the worker runs, so a polluted
 *    environment fails the suite rather than being quietly tolerated.
 *  - ISOLATION. Each harness gets its own temp directory, its own SQLite file
 *    and its own instance id, and `cleanup()` removes all of it. No test may
 *    touch `./data` or `./logs`.
 *  - DETERMINISM. Time comes from a `ManualClock`; the market comes from a
 *    seeded RNG. Two harnesses with the same seed produce identical results.
 *
 * The harness does NOT stub out the layers under test. Risk, Sentinel, adapter
 * and broker are the real production objects. Where a test needs an abnormal
 * condition (stale data, a disconnected feed, a runaway price) it produces it
 * through the real mechanism - `broker.injectFailure`, an aged quote, a
 * manipulated mark - rather than by replacing an object.
 */

import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/core/config.js';
import { ManualClock } from '../../src/core/clock.js';
import { openDatabase } from '../../src/database/db.js';
import { migrate } from '../../src/database/migrate.js';
import { AuditChain } from '../../src/database/audit-chain.js';
import { Repos } from '../../src/database/repositories/index.js';
import { PaperAccount } from '../../src/paper/paper-account.js';
import { MockBroker } from '../../src/broker/mock/mock-broker.js';
import { RiskEngine } from '../../src/risk/risk-engine.js';
import { Sentinel } from '../../src/execution/sentinel.js';
import { ExecutionAdapter } from '../../src/execution/execution-adapter.js';
import { ExecutionFirewall } from '../../src/execution/firewall.js';
import { sealDecision, decisionToRow } from '../../src/agent/decision.js';
import { permissionsFor, STATES } from '../../src/agent/state.js';
import { makeSignal } from '../../src/agent/strategies/strategy.interface.js';
import { WorkerLock } from '../../src/worker/lock.js';
import { newId } from '../../src/core/ids.js';
import { roundTo, roundEgp } from '../../src/core/money.js';
import { createLogger as makeLogger } from '../../src/core/logger.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * A REAL production logger, writing into the harness temp directory.
 *
 * Tests that drive the `Worker` need one, and a hand-rolled
 * `{ info(){}, warn(){} }` object is not enough: `Worker#start()` calls
 * `logger.child(...)`, so a stub missing that method fails with
 * "this[#logger].child is not a function" - a test-harness artefact that looks
 * like a production bug. `echo: false` keeps the suite output clean; the JSONL
 * log is still written, so a failing run can be inspected.
 */
export function createLogger(harness, name = 'test') {
  return makeLogger({ logDir: harness.logDir, clock: harness.clock, echo: false, name });
}

/** A fixed epoch so every test starts at the same instant. */
export const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * A fresh temp directory, unique per call. Removed by `cleanup()`.
 */
export function makeTempDir(prefix = 'teos-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Build the whole stack.
 *
 * @param {object} opts
 * @param {'PAPER'|'BACKTEST'} opts.mode
 * @param {object} opts.overrides   deep config overrides (see config.merge)
 * @param {number} opts.seed        market RNG seed
 * @param {number} opts.startMs     ManualClock start
 * @param {boolean} opts.loadSchema run the migration
 * @param {boolean} opts.withRun     insert a RUNNING `runs` row for the harness
 * @returns {object} harness
 */
export function createHarness({
  mode = 'PAPER',
  overrides = {},
  seed = 4242,
  startMs = EPOCH,
  loadSchema = true,
  withRun = true,
} = {}) {
  const dir = makeTempDir();
  const dataDir = join(dir, 'data');
  const logDir = join(dir, 'logs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // A sanitised env: the guards run for real, but the tests point the paths at
  // their own temp directory instead of the repository's ./data.
  const env = { ...process.env, TEOS_DATA_DIR: dataDir, TEOS_LOG_DIR: logDir };
  delete env.TEOS_MODE;
  delete env.TEOS_LIVE_TRADING_ENABLED;
  delete env.TEOS_DASHBOARD_TOKEN;

  const config = loadConfig({ path: join(REPO_ROOT, 'config', 'default.json'), overrides, env });
  const clock = new ManualClock(startMs);
  const instanceId = newId('inst');

  const db = openDatabase(config.paths.dbFile);
  if (loadSchema) migrate(db, clock);

  const chain = new AuditChain(db);
  const repos = new Repos(db, chain, { mode, instanceId });

  const runId = newId('run');
  repos.setRun(runId, instanceId);
  // The `runs` row is what `Worker#start()` uses to tell a cold start from a
  // resume, and it records the instance that owns the run. A harness that
  // pre-inserted a RUNNING row would therefore be adopted by the first worker
  // to start - which silently made a "cold start" into a resume of the
  // harness's own run, and made restart tests assert the wrong instance.
  // `withRun: false` leaves the table empty so the worker's own first start is
  // the genuine cold start it would be in production.
  if (withRun) {
    repos.createRun({
      runId, mode, instanceId,
      strategyId: config.strategies.active,
      startingCapitalEgp: config.account.startingCapitalEgp,
      config: { profile: config.profileName, mode },
      clock,
    });
  }

  const account = new PaperAccount({
    repos, clock, startingCapitalEgp: config.account.startingCapitalEgp,
  });
  account.loadOpenPositions();

  const broker = new MockBroker({ config, clock, repos, account, mode, seed });
  broker.connect();

  const riskEngine = new RiskEngine({ config, repos, clock });
  const sentinel = new Sentinel({ config, repos, clock });
  const adapter = new ExecutionAdapter({ broker, repos, clock, config });
  const firewall = new ExecutionFirewall({
    riskEngine, sentinel, adapter, repos, clock, mode, account,
  });

  const lockPath = join(dataDir, `teos-${mode.toLowerCase()}.lock`);
  const extraHandles = [];

  return {
    // --- wiring ---
    dir, dataDir, logDir, config, clock, instanceId, runId, lockPath, mode,
    db, chain, repos, account, broker, riskEngine, sentinel, adapter, firewall,

    /** Limits actually in force, for assertions that must not drift from config. */
    get limits() { return riskEngine.limits; },
    get instrument() { return config.instruments[0]; },

    /**
     * One tick of the world, mirroring the order `Worker#tick()` uses.
     *
     * Two details are load-bearing, and both were wrong in an earlier draft:
     *
     * 1. SNAPSHOTS ARE RECORDED. The PRICE_SANITY rule derives its reference
     *    price from `lastSnapshotBefore(...)`. With no snapshots stored, the
     *    reference is null, the abnormal-movement check can never fire, and a
     *    test of it passes against an entirely unperturbed market.
     *
     * 2. THE CLOCK IS NOT ADVANCED. The worker records a snapshot stamped with
     *    the current clock time and only then advances; the risk engine asks for
     *    `lastSnapshotBefore(nowMs - 1)`, which deliberately excludes this
     *    tick's own snapshot and so compares against the PREVIOUS tick's price.
     *    If the helper advanced the clock first, the reference would become the
     *    current quote, every measured move would be exactly zero bps, and the
     *    abnormal-movement rule would be unreachable. Use `advance()` to move
     *    time on, exactly as `Worker#run()` does between ticks.
     */
    tickMarket() {
      const quotes = broker.tick();
      if (quotes.length > 0) {
        repos.db.tx(() => {
          for (const q of quotes) {
            repos.recordSnapshot({
              symbol: q.symbol, bid: q.bid, ask: q.ask, last: q.mid, mid: q.mid,
              spreadBps: q.spreadBps, source: q.source, seq: q.seq, clock,
            });
          }
        });
      }
      // 3. The account's equity curve is advanced, which is what actually writes
      //    the `balances` and `equity_curve` rows. Without this the tables stayed
      //    empty in every harness test, so `latestBalance()` returned null and
      //    any assertion that cash reconciles with the fills was reading nothing
      //    at all. `Worker#tick()` does this on every tick; the harness is
      //    supposed to be a small Worker.
      account.tickEquity({ reason: 'test tick' });
      return quotes;
    },

    /** Move time on by one market tick, as the worker loop does between ticks. */
    advance(ms = config.market.tickMs) {
      return clock.advance(ms);
    },

    /**
     * The newest quote for a symbol, exactly as the broker reports it.
     *
     * The stored `tsMs` is PRESERVED. An earlier draft overwrote it with
     * `clock.now()`, which quietly made every quote look infinitely fresh - so
     * the staleness rules could never fire in any test that used this helper,
     * and the staleness scenario "passed" for the wrong reason. The broker
     * stamps `tsMs` when a quote is produced; ageing the clock is what makes
     * data stale, and the helper must not interfere with that.
     */
    quote(symbol = config.instruments[0].symbol) {
      return broker.getMarketData(symbol);
    },

    /** A quote with a chosen mid, not necessarily the simulator's. */
    syntheticQuote({ symbol = config.instruments[0].symbol, mid, spreadBps = 6, tsMs = null } = {}) {
      const half = (mid * spreadBps) / 20_000;
      return {
        symbol,
        bid: roundTo(mid - half, 8),
        ask: roundTo(mid + half, 8),
        last: roundTo(mid, 8),
        mid: roundTo(mid, 8),
        spreadBps,
        seq: 1,
        ts: new Date(tsMs ?? clock.now()).toISOString(),
        tsMs: tsMs ?? clock.now(),
        source: 'test',
        isStale: false,
      };
    },

    /**
     * The kill switch, derived from the database exactly as `Worker#killSwitch()`
     * derives it.
     *
     * An earlier draft hard-coded `{ engaged: false }`. That made every
     * stop-related scenario lie: the risk engine saw a clear switch and allowed
     * the order through, and only the adapter's own `activeStop()` check caught
     * it - which surfaces as an FAILED outcome (an exception) instead of a
     * BLOCKED one. Production never sees that path, because the worker reports
     * the real stop. The harness must do the same or it is testing a
     * configuration the agent cannot be in.
     */
    killSwitch() {
      const stop = repos.sessionStop(mode);
      return stop
        ? { engaged: true, trigger: stop.trigger, reason: stop.reason }
        : { engaged: false, trigger: null, reason: null };
    },

    /**
     * Engage a real emergency stop through the same repository call the risk
     * engine makes, so the durable record, the `EMERGENCY_STOP` control flag and
     * the audit chain are all written exactly as they are in production. A
     * hand-inserted stop row would leave the flag and the audit trail behind,
     * and the "the stop is auditable" scenarios would then be asserting
     * something the harness itself fabricated.
     */
    // `scope` is constrained by the schema to 'NEW_ORDERS' | 'HALT_ALL', so the
    // default here is the stricter of the two. A stop that only blocks entries
    // still allows exits; HALT_ALL is what "no trading at all" means.
    engageStop({ trigger, severity = 'CRITICAL', scope = 'HALT_ALL', reason = 'test stop', details = null } = {}) {
      return repos.engageStop({ trigger, severity, scope, reason, details, clock });
    },

    /**
     * Clear a stop the way an operator does: explicitly, with an actor on record.
     *
     * `Repos.clearStop` only flips the `EMERGENCY_STOP` control flag once the
     * LAST stop is cleared, so setting the flag here as well would be fabricating
     * a state the production path never produces. The call is made and the flag
     * it produces is asserted instead.
     */
    clearStop(stopId, clearedBy = 'test:operator') {
      return repos.clearStop(stopId, clearedBy, clock);
    },

    /**
     * Fire one tick of the FULL firewall pipeline for a decision.
     *
     * `extra.dailyLoss` and `extra.brokerHealth` let a caller present the
     * firewall with a stressed market or account without hand-building a
     * verdict, so scenario tests exercise the real rule path rather than
     * stubbing the engine's output.
     *
     * The decision insert is idempotent. `agent_decisions.decision_id` is
     * UNIQUE, which is itself a guarantee worth having: a sealed decision is
     * immutable and recorded exactly once. Re-presenting the same decision -
     * which is what the duplicate-prevention scenarios do - must therefore
     * re-use the existing row rather than trip the constraint, or the test
     * would be measuring SQLite instead of the order pipeline.
     */
    async submit(decision, extra = {}) {
      const existing = db.get(
        'SELECT decision_id FROM agent_decisions WHERE decision_id = ?', decision.decisionId,
      );
      if (!existing) repos.insertDecision(decisionToRow(decision), clock);

      // Key-presence, not `??`. A caller must be able to pass an EXPLICIT null
      // quote - "the symbol has no market data at all" is a condition the risk
      // engine must handle, and `null ?? this.quote()` silently replaces it with
      // a live quote, making the test assert nothing.
      const pick = (key, fallback) => (key in extra ? extra[key] : fallback);
      // The fallback quote must be for the DECISION'S symbol. Using the first
      // instrument regardless meant a perfectly valid EUR/EGP order was
      // presented to the risk engine priced in USD/EGP, and it was then
      // correctly refused by PRICE_SANITY as an 836bps move - a failure that
      // looks like a real defect and is entirely the harness's fault. The
      // `Worker` looks the quote up by symbol, so the harness must too.
      //
      // A symbol the simulator does not carry yields `null` rather than a throw:
      // "no market data for this instrument" is exactly the condition the
      // pipeline must survive, and `MockBroker.getMarketData` throwing a
      // ValidationError is a low-level detail the firewall never sees.
      const fallbackQuote = broker.simulator.has(decision.symbol)
        ? this.quote(decision.symbol)
        : null;
      return firewall.execute({
        decision,
        account,
        dailyLoss: pick('dailyLoss', { realizedEgp: 0, unrealizedEgp: 0 }),
        brokerHealth: pick('brokerHealth', broker.health()),
        killSwitch: pick('killSwitch', this.killSwitch()),
        quote: pick('quote', fallbackQuote),
        orderCounts: pick('orderCounts', { day: 0, bySymbol: {} }),
      });
    },

    /** Build a valid, sealed BUY decision. */
    buyDecision(opts = {}) {
      const symbol = opts.symbol ?? config.instruments[0].symbol;
      const price = opts.price ?? 48.75;
      const stopPrice = opts.stopPrice ?? roundTo(price * 0.985, 8);
      const signalObj = makeSignal({
        signal: 'BUY',
        confidence: opts.confidence ?? 0.8,
        reason: opts.reason ?? 'test entry signal',
        features: { mid: price },
        stopPrice,
        targetPrice: opts.targetPrice ?? roundTo(price * 1.01, 8),
        stopDistancePct: opts.stopDistancePct ?? 1.5,
        riskRewardRatio: opts.riskRewardRatio ?? 1.0,
        meta: { riskPctPerTrade: opts.riskPctPerTrade ?? 0.5, intent: 'ENTRY' },
      });
      return sealDecision({
        symbol,
        strategyId: opts.strategyId ?? 'test_strategy',
        price,
        signalObj,
        risk: {
          riskBudgetEgp: opts.riskBudgetEgp ?? 2.5,
          maxLossEgp: opts.maxLossEgp ?? 2.5,
          stopPrice,
          sizePctOfEquity: opts.sizePctOfEquity ?? 10,
          feeBpsEstimate: config.fees.takerBps,
          expectedSlippageBps: 5,
          expectedSlippageEgp: 0.05,
        },
        quantity: opts.quantity ?? 1,
        notionalEgp: opts.notionalEgp ?? price,
        expectedExecutionPrice: opts.expectedExecutionPrice ?? price,
        stopCondition: opts.stopCondition ?? `Stop at ${stopPrice}`,
        action: opts.action ?? 'PLACE_ORDER',
        agentState: opts.agentState ?? 'HEALTHY',
        clock,
        permissions: opts.permissions ?? PERMISSIONS_HEALTHY,
      });
    },

    /** Build a valid, sealed SELL (exit) decision. */
    sellDecision(opts = {}) {
      const symbol = opts.symbol ?? config.instruments[0].symbol;
      const price = opts.price ?? 48.75;
      const signalObj = makeSignal({
        signal: 'SELL',
        confidence: opts.confidence ?? 1,
        reason: opts.reason ?? 'test exit signal',
        features: { mid: price },
        stopPrice: null,
        targetPrice: null,
        stopDistancePct: null,
        riskRewardRatio: null,
        meta: { intent: opts.intent ?? 'EXIT' },
      });
      return sealDecision({
        symbol,
        strategyId: opts.strategyId ?? 'test_strategy:stop',
        price,
        signalObj,
        risk: { riskBudgetEgp: 0, maxLossEgp: 0, stopPrice: null, sizePctOfEquity: 0 },
        quantity: opts.quantity ?? 1,
        notionalEgp: opts.notionalEgp ?? price,
        expectedExecutionPrice: opts.expectedExecutionPrice ?? price,
        // A SELL carries a stop condition too. `sealDecision` requires one for
        // any non-HOLD order, and the production engine writes exactly this
        // wording for a stop-loss exit (see `buildStopExitDecision`).
        stopCondition: opts.stopCondition
          ?? 'The stop that produced this decision has already been breached; the position is being closed at market. No further stop applies.',
        action: opts.action ?? 'PLACE_ORDER',
        agentState: opts.agentState ?? 'HEALTHY',
        clock,
        permissions: opts.permissions ?? PERMISSIONS_HEALTHY,
      });
    },

    /**
     * Register an EXTRA database handle for closing at cleanup.
     *
     * A test that opens a second connection over the same file - which is what a
     * restart is - must register it here. On Windows an open handle keeps the
     * file locked, so an unregistered handle turns the next `cleanup()` into
     * `EBUSY: resource busy or locked` and masks the real test failure behind a
     * filesystem error. Cleanup must never be the thing that fails a test.
     */
    trackDb(handle) {
      extraHandles.push(handle);
      return handle;
    },

    /** Remove every temp artefact. Safe to call more than once. */
    cleanup() {
      // Close in reverse order of opening, so dependents go before dependencies.
      for (const handle of [...extraHandles].reverse()) {
        try { handle.close(); } catch { /* already closed */ }
      }
      extraHandles.length = 0;
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The PRODUCTION permission matrices, imported rather than re-invented.
 *
 * An earlier draft of this harness hand-wrote a plausible-looking matrix
 * (`{ canOpenPosition: true, ... }`). The risk engine reads `openPosition` and
 * `reduceOnly`, so the invented object silently denied every entry and the first
 * order was blocked by AGENT_STATE. The rule is simple: never restate a
 * production constant in a test - import it, or the test asserts the harness.
 */
export const PERMISSIONS_HEALTHY = permissionsFor('HEALTHY');
export const PERMISSIONS_DEGRADED = permissionsFor('DEGRADED');
export const PERMISSIONS_HALTED = permissionsFor('HALTED');
export const PERMISSIONS_NONE = permissionsFor('NOT_A_REAL_STATE');

/**
 * Settle a submitted order by driving broker ticks until it is no longer
 * working, or the budget runs out.
 *
 * A MARKET order in this system is not filled at submission - it rests until the
 * NEXT `broker.tick()`. Tests that assert on cash, positions or P&L must settle
 * first; asserting on a resting order proves nothing about execution.
 *
 * @returns {number} the tick the order reached terminal status on
 */
export function settle(harness, orderId, { maxTicks = 40 } = {}) {
  if (!orderId) throw new Error('settle: no order id was supplied');
  for (let i = 1; i <= maxTicks; i += 1) {
    harness.tickMarket();
    harness.advance();
    const order = harness.broker.getOrder(orderId);
    if (order && TERMINAL_STATUSES.has(order.status)) return i;
  }
  const last = harness.broker.getOrder(orderId);
  throw new Error(
    `settle: order ${orderId} did not reach a terminal status in ${maxTicks} ticks `
    + `(last status: ${last?.status ?? 'MISSING_FROM_BOOK'})`,
  );
}

const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

/**
 * The order id out of whatever a stage returned.
 *
 * The firewall hands back the repository ROW (snake_case: `order_id`), while the
 * broker hands back the book record (camelCase: `orderId`). Reading the wrong
 * one yields `undefined`, which then surfaces much later as a baffling "order
 * undefined did not reach a terminal status". Both spellings are accepted so
 * callers never have to know which stage they are holding.
 */
export function orderIdOf(order) {
  if (!order) return null;
  return order.order_id ?? order.orderId ?? null;
}

/**
 * Submit a decision and settle it, returning both halves of the story.
 *
 * The order id is read with `orderIdOf`, not `res.order.orderId`: the firewall
 * hands back the repository ROW, which is snake_case. The earlier version read
 * the camelCase spelling, got `undefined`, and then failed inside `settle` with
 * a message about an order that "did not reach a terminal status" - pointing at
 * the exchange rather than at the harness.
 *
 * @param {object} harness
 * @param {object} decision
 * @param {object} [extra]   overrides for `submit`
 * @param {object} [settleOpts]  e.g. `{ maxTicks: 20 }`
 */
export async function submitAndSettle(harness, decision, extra = {}, settleOpts = {}) {
  const res = await harness.submit(decision, extra);
  const ticks = res.order && res.outcome === 'EXECUTED'
    ? settle(harness, orderIdOf(res.order), settleOpts)
    : 0;
  return { ...res, settledAfterTicks: ticks };
}

/** All rows of a table for this mode, newest last. */
export function rows(harness, table, { where = null, params = [], orderBy = 'rowid ASC' } = {}) {
  const sql = `SELECT * FROM ${table} WHERE mode = ?${where ? ` AND ${where}` : ''} ORDER BY ${orderBy}`;
  return harness.db.all(sql, harness.repos.mode, ...params);
}

/** A lock file that looks live right now. Used to prove a second worker cannot
 * start. `fresh: false` ages it past `staleAfterMs` so it is reclaimable.
 */
export function writeLiveLock(path, instanceId, nowMs, { fresh = true } = {}) {
  const body = { instanceId, pid: process.pid, hostname: 'test-host', lastHeartbeatMs: fresh ? nowMs : nowMs - 10 * 60_000 };
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return body;
}

/** Inspect a lock file without acquiring it. */
export function inspectLock(path) {
  return WorkerLock.inspect(path);
}

/**
 * Assert the two invariants that must hold after ANY sequence of fills.
 * Uses the real PaperAccount, not a recomputed model, so a bug in the account
 * cannot hide behind the same bug in the assertion.
 */
export function assertAccountInvariants(account, { capitalEgp = 500 } = {}) {
  // The account computes its own exposure through `portfolioPnl`, exactly as
  // production does. Re-deriving it here from raw rows would duplicate that
  // implementation, and a bug shared by both copies would go unnoticed.
  const snap = account.snapshot();
  const positions = account.getPositions();

  assert.ok(snap.cashEgp >= 0, `cash must never be negative (was ${snap.cashEgp})`);

  // The DEFINITION of equity, asserted exactly:
  //
  //     equity = cash + costBasis + unrealized
  //
  // Cash is debited when a position opens, so the acquired asset has to be
  // added back at its current value. `portfolioPnl` computes exactly this, so
  // comparing against it is a tautology and proves nothing. What is worth
  // asserting is the independent restatement below.
  const byDefinition = roundEgp(snap.cashEgp + snap.costBasisEgp + snap.unrealizedPnlEgp);
  assert.ok(
    Math.abs(roundEgp(snap.equityEgp) - byDefinition) <= 0.01,
    `equity ${roundEgp(snap.equityEgp)} != cash + costBasis + unrealized = ${byDefinition}`,
  );

  // The INDEPENDENT form: cash plus the mark-to-market value of the open
  // positions, i.e. cash + exposure. Algebraically the same thing, but derived
  // from a different accumulation path inside `portfolioPnl` (per-position
  // rounded unrealized terms vs one rounded sum), so it catches an error in
  // either.
  //
  // Tolerance is two piastres, not one, because of double rounding: unrealized
  // is rounded per position and costBasis once, so the two paths can differ by
  // a single piastre per open position. Two piastres on a 3-position book is
  // still exact to the precision the money type can represent, and any real
  // defect is orders of magnitude larger.
  const byExposure = roundEgp(snap.cashEgp + snap.exposureEgp);
  assert.ok(
    Math.abs(roundEgp(snap.equityEgp) - byExposure) <= 0.02,
    `equity invariant: equity ${roundEgp(snap.equityEgp)} != cash ${roundEgp(snap.cashEgp)} + exposure ${roundEgp(snap.exposureEgp)} = ${byExposure}`,
  );

  assert.ok(
    roundEgp(snap.equityEgp) <= capitalEgp + 0.01,
    `equity ${roundEgp(snap.equityEgp)} must never exceed the EGP ${capitalEgp} paper ceiling`,
  );
  for (const p of positions) {
    assert.ok(p.quantity >= 0, `position ${p.symbol} quantity must not be negative`);
  }
  return {
    cashEgp: snap.cashEgp,
    exposureEgp: roundEgp(snap.exposureEgp),
    equityEgp: roundEgp(snap.equityEgp),
  };
}

/**
 * Count rows in a table for this mode, honouring run scoping.
 *
 * `table` must be a real table name; a typo would otherwise surface as
 * "no such table" and look like a production defect. The list is derived from
 * the schema, not typed from memory.
 */
export function countRows(harness, table, { runScoped = true } = {}) {
  const { repos } = harness;
  const known = repos.db
    .all("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name);
  if (!known.includes(table)) {
    throw new Error(`countRows: unknown table "${table}". Known: ${known.join(', ')}`);
  }
  const hasRunId = repos.db.all(`PRAGMA table_info(${table})`).some((c) => c.name === 'run_id');
  if (runScoped && hasRunId && repos.decisionScopeRunId) {
    return repos.db.count(
      `SELECT COUNT(*) AS c FROM ${table} WHERE mode = ? AND run_id = ?`,
      repos.mode, repos.decisionScopeRunId,
    );
  }
  return repos.db.count(`SELECT COUNT(*) AS c FROM ${table} WHERE mode = ?`, repos.mode);
}

export { assert, roundEgp, roundTo, STATES, REPO_ROOT };
