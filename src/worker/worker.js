/**
 * TEOS Trade Agent - worker/worker.js
 *
 * ===========================================================================
 *  THE 24/7 WORKER
 * ===========================================================================
 *
 *  A persistent supervisor that:
 *    - runs a bounded decision loop forever
 *    - holds a single-instance lock so two loops can never share a database
 *    - resumes state safely after a normal or abnormal restart
 *    - never duplicates an order after a restart (see worker/idempotency.js)
 *    - records EVERY decision and EVERY error
 *    - writes a heartbeat and exposes health status
 *    - shuts down gracefully, leaving a resumable checkpoint
 *
 *  TICK SEQUENCE (deterministic, one decision per tick by default):
 *
 *    1. lock.refresh()                 keep the single-instance claim fresh
 *    2. broker.tick()                  advance the market, match resting orders
 *    3. persist market snapshots       every quote, so staleness is provable
 *    4. enforce stops                  stop-loss exits are real orders
 *    5. assess health                  state machine: HEALTHY/DEGRADED/HALTED
 *    6. account.tickEquity()           equity curve + balance history
 *    7. agent.evaluateOnce()           -> a sealed Decision, or nothing
 *    8. firewall.execute()             risk -> sentinel -> adapter -> paper
 *    9. heartbeat.maybeWrite()         every heartbeatIntervalMs
 *   10. daily-loss rollover            at UTC midnight
 *
 *  Every step is wrapped so that an unexpected throw is recorded, counted and
 *  converted into a HALT rather than an unhandled crash of the loop.
 * ===========================================================================
 */

import { join } from 'node:path';
import { WorkerLock, newInstanceId } from './lock.js';
import { Heartbeat, HEALTH } from './heartbeat.js';
import { IdempotencyGuard, reconcileInFlight, reconcileCash } from './idempotency.js';
import { AgentEngine } from '../agent/engine.js';
import { decisionToRow } from '../agent/decision.js';
import { AgentStateMachine, STATES } from '../agent/state.js';
import { RiskEngine } from '../risk/risk-engine.js';
import { Sentinel } from '../execution/sentinel.js';
import { ExecutionAdapter } from '../execution/execution-adapter.js';
import { ExecutionFirewall } from '../execution/firewall.js';
import { MockBroker, registerMockBroker } from '../broker/mock/mock-broker.js';
import { registerBroker } from '../broker/broker.interface.js';
import { PaperAccount } from '../paper/paper-account.js';
import { Repos } from '../database/repositories/index.js';
import { AuditChain } from '../database/audit-chain.js';
import { migrate } from '../database/migrate.js';
import { openDatabase } from '../database/db.js';
import { newId } from '../core/ids.js';
import { systemClock } from '../core/clock.js';
import { roundEgp, roundTo } from '../core/money.js';
import { toErrorPayload, WorkerError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

export class Worker {
  #config;
  #clock;
  #logger;
  #db;
  #repos;
  #chain;
  #broker;
  #account;
  #risk;
  #sentinel;
  #adapter;
  #firewall;
  #agent;
  #heartbeat;
  #lock;
  #guard;
  #instanceId;
  #runId;
  #tickCount = 0;
  #running = false;
  #stopping = false;
  #lastSnapshotMs = 0;
  #lastDailyResetKey = null;
  #hostRecovery = null;
  #strategyId;
  #injectedBroker = null;

  constructor({ config, clock = null, db = null, mode = 'PAPER', logger = null, instanceId = null, strategyId = null, broker = null }) {
    this.#config = config;
    // Time comes from an injected clock and nowhere else. Defaulting to the
    // system clock here means a caller can never accidentally construct a
    // worker that reads `undefined.now()`; the backtest and the tests still
    // inject a ManualClock and remain fully deterministic.
    this.#clock = clock ?? systemClock;
    this.#mode = mode;
    this.#logger = logger ?? createLogger({ level: 'info', name: 'worker' });
    this.#instanceId = instanceId ?? newInstanceId();
    this.#strategyId = strategyId ?? config.strategies.active;
    // A pre-built broker is injected by the backtest engine so that BACKTEST
    // and PAPER run the IDENTICAL loop, risk engine, Sentinel, adapter and
    // matching engine, and differ only in where the prices come from and which
    // database they are written to. There is deliberately no second tick loop.
    this.#injectedBroker = broker;

    this.#db = db ?? openDatabase(config.paths.dbFile);
    migrate(this.#db, this.#clock);
    this.#chain = new AuditChain(this.#db);
    this.#repos = new Repos(this.#db, this.#chain, { mode, instanceId: this.#instanceId });

    this.#heartbeat = new Heartbeat({
      repos: this.#repos, clock: this.#clock,
      intervalMs: config.worker.heartbeatMs,
      staleAfterMs: config.worker.heartbeatStaleAfterMs,
    });
    this.#lock = new WorkerLock(join(config.paths.dataDir, `teos-${mode.toLowerCase()}.lock`), {
      staleAfterMs: config.worker.lockStaleAfterMs,
    });
    this.#guard = new IdempotencyGuard(this.#repos);
  }

  #mode;

  get instanceId() { return this.#instanceId; }
  get runId() { return this.#runId; }
  get repos() { return this.#repos; }
  get broker() { return this.#broker; }
  get account() { return this.#account; }
  get agent() { return this.#agent; }
  get heartbeat() { return this.#heartbeat; }
  get db() { return this.#db; }
  get running() { return this.#running; }

  /**
   * Boot: acquire the lock, restore or create the run, recover in-flight
   * orders, connect the broker. Returns a recovery report.
   */
  start({ resume = true } = {}) {
    const now = this.#clock.now();
    const lockResult = this.#lock.acquire(this.#instanceId, now);
    this.#logger.info('Worker starting.', {
      instanceId: this.#instanceId, mode: this.#mode, db: this.#config.paths.dbFile,
      lockReclaimed: lockResult.reclaimed, strategy: this.#strategyId,
    });

    // ---- determine cold start vs resume --------------------------------
    const lastRun = this.#repos.latestRun(this.#mode);
    const isResume = resume && lastRun != null && lastRun.status === 'RUNNING';
    const prevInstance = lastRun?.instance_id ?? null;
    const kind = lastRun == null ? 'COLD_START' : (isResume ? 'RESUME' : 'CRASH_RECOVERY');

    this.#runId = isResume ? lastRun.run_id : newId('run');
    // Every repository write is stamped with the run id. Without this the rows
    // were written with `run_id = NULL`, which silently broke every run-scoped
    // query (order/fill/trade counts, and the per-run emergency stop) while
    // still looking correct when queried by mode alone.
    this.#repos.setRun(this.#runId, this.#instanceId);

    // ---- build the portfolio, restoring cash on resume ------------------
    const lastBalance = this.#repos.latestBalance(this.#mode);
    const equityHistory = isResume ? this.#repos.equitySeries({ limit: 5000, mode: this.#mode }) : [];
    const restored = isResume && lastBalance
      ? {
        startingCapitalEgp: lastRun.starting_capital_egp,
        cashEgp: lastBalance.cash_egp,
        feesPaidEgp: lastBalance.fees_paid_egp,
        slippageCostEgp: lastBalance.slippage_cost_egp,
        equityHistory: equityHistory.map((r) => ({ tsMs: r.ts_ms, equityEgp: r.equity_egp, cashEgp: r.cash_egp, exposureEgp: r.exposure_egp })),
      }
      : null;

    this.#account = new PaperAccount({
      repos: this.#repos, clock: this.#clock,
      startingCapitalEgp: this.#config.account.startingCapitalEgp,
      restored,
    });
    // On resume, the open positions ARE the state being recovered. On a cold
    // start they are not: a row still marked OPEN belongs to a previous, ended
    // run, and adopting it would silently begin this run holding another run's
    // positions with a starting balance that does not fund them.
    if (isResume) this.#account.loadOpenPositions();

    // ---- broker ---------------------------------------------------------
    const previousSeq = this.#db.scalar('SELECT COALESCE(MAX(seq),0) AS s FROM market_snapshots WHERE mode = ?', this.#mode) ?? 0;
    if (this.#injectedBroker) {
      this.#broker = this.#injectedBroker;
      registerBroker(this.#broker);
    } else {
      this.#broker = new MockBroker({
        config: this.#config, clock: this.#clock, repos: this.#repos, account: this.#account, mode: this.#mode,
        seed: this.#config.market.seed,
        onEvent: (e) => this.#onBrokerEvent(e),
      });
      registerMockBroker(this.#broker);
    }
    const conn = this.#broker.connect();
    if (!conn.ok) {
      this.#lock.release();
      throw new WorkerError(`Broker connection failed at startup: ${conn.detail}`, { mode: this.#mode });
    }

    // ---- recover in-flight orders BEFORE the loop can create new ones ---
    const inFlight = reconcileInFlight({ repos: this.#repos, broker: this.#broker, clock: this.#clock });
    this.#hostRecovery = { inFlight, previousSeq };

    const cashCheck = reconcileCash({
      repos: this.#repos,
      startingCapitalEgp: lastRun?.starting_capital_egp ?? this.#config.account.startingCapitalEgp,
      cashEgp: this.#account.cashEgp,
      runId: this.#runId,
    });
    if (!cashCheck.ok) {
      this.#repos.logEvent({
        level: 'ERROR', category: 'integrity', clock: this.#clock,
        message: `Cash reconciliation mismatch: expected EGP ${cashCheck.expectedCashEgp} from fills, ledger says EGP ${cashCheck.actualCashEgp} (delta EGP ${cashCheck.deltaEgp}).`,
        details: cashCheck,
      });
    }

    // A run that was stopped GRACEFULLY with positions still open leaves rows
    // marked OPEN that this cold start deliberately does not adopt. That is the
    // correct accounting (the new run has its own EGP 500 and cannot fund
    // them), but it must never be silent: an operator who restarts the agent
    // after closing it down has to know the book was reset, not repaired.
    if (!isResume) {
      const orphans = this.#repos.listOpenPositions();
      if (orphans.length > 0) {
        this.#repos.logEvent({
          level: 'WARN', category: 'integrity', clock: this.#clock,
          message: `Cold start with ${orphans.length} position(s) still marked OPEN from a previous run; they were NOT adopted by this run.`,
          details: { positions: orphans.map((p) => ({ positionId: p.position_id, symbol: p.symbol, quantity: p.quantity })) },
        });
        this.#logger.warn('Cold start left orphan open positions behind; not adopted.', { count: orphans.length });
      }
    }

    // The state the previous process ended in. Read before the restart record is
    // written so the record can carry it. A restart always begins a FRESH state
    // machine at STARTING: the previous state is history, not a live state.
    const lastState = this.#repos.stateHistory({ limit: 1, mode: this.#mode })[0];
    const previousAgentState = lastState?.to_state ?? null;

    // ---- run record ------------------------------------------------------
    if (isResume) {
      this.#repos.updateRunStatus(this.#runId, 'RUNNING', this.#clock);
    } else {
      this.#repos.createRun({
        runId: this.#runId, mode: this.#mode, instanceId: this.#instanceId,
        strategyId: this.#strategyId,
        startingCapitalEgp: this.#config.account.startingCapitalEgp,
        config: this.#configSummary(), clock: this.#clock,
      });
    }

    this.#repos.recordRestart({
      previousInstance: prevInstance,
      newInstance: this.#instanceId,
      kind,
      reason: isResume ? 'worker resumed an in-progress run' : (kind === 'CRASH_RECOVERY' ? 'previous run was not closed cleanly' : 'first run on this database'),
      orphanedOrders: inFlight.orphans.length,
      recovery: { inFlight, cashCheck, previousSeq, previousAgentState },
    }, this.#clock, this.#mode);

    // ---- build the pipeline --------------------------------------------
    this.#risk = new RiskEngine({ config: this.#config, repos: this.#repos, clock: this.#clock });
    this.#sentinel = new Sentinel({ config: this.#config, repos: this.#repos, clock: this.#clock });
    this.#adapter = new ExecutionAdapter({
      broker: this.#broker, repos: this.#repos, clock: this.#clock, config: this.#config,
    });
    this.#firewall = new ExecutionFirewall({
      riskEngine: this.#risk, sentinel: this.#sentinel, adapter: this.#adapter,
      repos: this.#repos, clock: this.#clock, mode: this.#mode,
      account: this.#account,
    });

    // A process restart always begins a FRESH state machine at STARTING. The
    // state the previous process ended in is history, not a live state: a run
    // that was HALTED or FAILED is resumed by re-deriving health from the
    // current broker and data, not by pretending to still be in that state.
    // The previous terminal state is recorded in the restart row, and the
    // emergency-stop table is what actually gates trading.
    const state = new AgentStateMachine({ repos: this.#repos, clock: this.#clock, initial: STATES.STARTING });

    this.#agent = new AgentEngine({
      config: this.#config, broker: this.#broker, account: this.#account, repos: this.#repos,
      clock: this.#clock, logger: this.#logger.child('agent'), riskEngine: this.#risk,
      strategyId: this.#strategyId, state,
    });
    state.transition(STATES.WARMUP, isResume ? 'resumed; warming up' : 'cold start; warming up');

    this.#lastDailyResetKey = this.#clock.dateKey();
    this.#running = true;
    this.#stopping = false;

    this.#heartbeat.write({ instanceId: this.#instanceId, agentState: state.state, status: HEALTH.STARTING });
    this.#repos.logEvent({
      level: 'INFO', category: kind.toLowerCase(), clock: this.#clock,
      message: `Worker ${kind}: instance ${this.#instanceId}, run ${this.#runId}.`,
      details: { inFlight, cashCheck, isResume },
    });

    this.#logger.info('Worker ready.', {
      instanceId: this.#instanceId, runId: this.#runId, kind,
      cashEgp: this.#account.cashEgp, equityEgp: this.#account.equityEgp,
      openPositions: this.#account.getPositions().length,
      recoveredOrders: inFlight.orphans.length,
      cashReconciled: cashCheck.ok,
    });

    return {
      instanceId: this.#instanceId, runId: this.#runId, kind, isResume,
      restoredCashEgp: restored?.cashEgp ?? this.#config.account.startingCapitalEgp,
      startingCapitalEgp: this.#config.account.startingCapitalEgp,
      inFlight, cashCheck, previousSeq,
      openPositions: this.#account.getPositions().length,
    };
  }

  #configSummary() {
    return {
      version: this.#config.configVersion,
      mode: this.#mode,
      startingCapitalEgp: this.#config.account.startingCapitalEgp,
      risk: this.#config.risk,
      fees: this.#config.fees,
      slippage: this.#config.slippage,
      execution: this.#config.execution,
      sentinel: this.#config.sentinel,
      strategies: this.#config.strategies,
      instruments: this.#config.instruments.map((i) => i.symbol),
    };
  }

  #onBrokerEvent(e) {
    const level = (e.level ?? 'info').toLowerCase();
    this.#repos.logEvent({
      level: level.toUpperCase(), category: e.category, message: e.message, details: e.details ?? null, clock: this.#clock,
    });
    if (level === 'error' || level === 'fatal') this.#heartbeat.error(e.message);
  }

  /** One iteration of the loop. Async so the execution adapter may be async. */
  async tick() {
    if (!this.#running) throw new WorkerError('Worker is not running.', { instanceId: this.#instanceId });
    const clock = this.#clock;
    const step = { tick: this.#tickCount + 1, decision: null, outcome: null, errors: [] };

    try {
      // 1. keep the single-instance claim fresh
      this.#lock.refresh(clock.now());

      // 2. advance the market and match resting orders
      const quotes = this.#broker.tick();

      // 3. persist snapshots (needed to prove staleness and price sanity)
      if (quotes.length > 0) {
        this.#repos.db.tx(() => {
          for (const q of quotes) {
            this.#repos.recordSnapshot({
              symbol: q.symbol, bid: q.bid, ask: q.ask, last: q.mid, mid: q.mid,
              spreadBps: q.spreadBps, source: q.source, seq: q.seq, clock,
            });
          }
        });
        this.#lastSnapshotMs = clock.now();
      }

      // 4. enforce stop conditions as real exit orders
      //
      // A breached stop becomes a first-class Decision and goes through the
      // same firewall as any other order. There is no direct broker call here:
      // if the firewall refuses a stop exit, that is a CRITICAL condition, not
      // a silent no-op, so it latches an emergency stop and is logged loudly.
      const breached = this.#agent.breachedStops();
      if (breached.size > 0) {
        const accountSnapshot = this.#account.snapshot();
        const exits = [];
        for (const [symbol, stopPrice] of breached) {
          const quote = this.#broker.getMarketData(symbol);
          const position = this.#account.positionFor(symbol);
          if (!quote || !position) continue;

          // An exit for this position may already be working at the exchange
          // from an earlier tick - submitted, not yet filled, possibly only
          // partially filled. Issuing a second one would close the position
          // twice: the first to fill closes it, the second then has nothing to
          // sell. The working order is the exchange's to fill or cancel; this
          // is a normal condition and is NOT a blocked stop.
          const working = this.#agent.workingOrder(symbol, 'SELL');
          if (working) {
            this.#repos.logEvent({
              level: 'INFO', category: 'order_in_flight', clock,
              message: `Stop for ${symbol} still breached, but exit order ${working.orderId} is already working (${working.status}). No second exit submitted.`,
              details: { symbol, stopPrice, workingOrderId: working.orderId, workingStatus: working.status, filledQuantity: working.filledQuantity, orderQuantity: working.quantity },
            });
            exits.push({ symbol, stopPrice, mid: quote.mid, decisionId: null, outcome: 'SKIPPED', reason: 'EXIT_ALREADY_IN_FLIGHT', workingOrderId: working.orderId });
            continue;
          }

          const decision = this.#agent.buildStopExitDecision({ symbol, stopPrice, quote, account: accountSnapshot, position });
          if (!decision) continue;
          this.#repos.insertDecision(decisionToRow(decision), clock);
          this.#heartbeat.decision(decision.decisionId);

          const res = await this.#firewall.execute({
            decision,
            account: accountSnapshot,
            dailyLoss: this.#dailyLoss(),
            brokerHealth: this.#broker.health(),
            killSwitch: this.#killSwitch(),
            quote,
            orderCounts: this.#orderCounts(),
          });

          const exit = {
            symbol, stopPrice, mid: quote.mid, quantity: decision.positionSize,
            decisionId: decision.decisionId, outcome: res.outcome, reason: res.reason ?? null,
            orderId: res.order?.order_id ?? null,
          };
          exits.push(exit);

          if (res.outcome === 'EXECUTED') {
            this.#heartbeat.order();
            this.#repos.logEvent({
              level: 'WARN', category: 'stop_loss', clock,
              message: `Stop loss triggered for ${symbol} at mid ${roundTo(quote.mid, 6)} (stop ${stopPrice}); exit submitted.`,
              details: exit,
            });
          } else {
            // A stop that cannot be executed leaves risk on the table. Say so
            // loudly and stop opening anything new until it is resolved.
            this.#repos.logEvent({
              level: 'FATAL', category: 'stop_loss_failed', clock,
              message: `Stop loss for ${symbol} could NOT be executed (${res.outcome}: ${res.reason ?? 'no reason recorded'}). The position remains open.`,
              details: exit,
            });
            this.#repos.engageStop({
              trigger: 'STOP_EXIT_BLOCKED', severity: 'CATASTROPHIC', scope: 'NEW_ORDERS',
              reason: `A breached stop for ${symbol} could not be executed: ${res.reason ?? res.outcome}`,
              details: exit, clock,
            });
          }
        }
        step.stopExits = exits;
      }

      // 5. health / state machine
      const health = this.#agent.assessHealth();
      if (this.#agent.stateName === STATES.WARMUP && this.#warmupComplete()) {
        this.#agent.state.transition(STATES.HEALTHY, 'warm-up complete');
      }
      step.health = health;

      // 6. equity + balance history
      this.#account.tickEquity({ reason: 'tick' });

      // 7. daily loss rollover at UTC midnight
      step.dailyReset = this.#maybeResetDailyLoss();

      // 8. decision
      const evalResult = this.#agent.evaluateOnce();
      if (evalResult?.decision) {
        const d = evalResult.decision;
        this.#heartbeat.decision(d.decisionId);
        step.decision = {
          decisionId: d.decisionId, symbol: d.symbol, signal: d.signal,
          price: d.marketPrice, quantity: d.positionSize, notionalEgp: d.notionalEgp,
          reason: d.reason, confidence: d.confidence, stopCondition: d.stopCondition,
        };

        // 9. THE FIREWALL - the only path to execution
        const res = await this.#firewall.execute({
          decision: d,
          account: evalResult.accountSnapshot,
          dailyLoss: this.#dailyLoss(),
          brokerHealth: this.#broker.health(),
          killSwitch: this.#killSwitch(),
          quote: evalResult.quote,
          orderCounts: this.#orderCounts(),
        });
        step.outcome = { outcome: res.outcome, reason: res.reason ?? null, detail: res.detail ?? null, orderId: res.order?.order_id ?? null };
        if (res.outcome === 'EXECUTED') this.#heartbeat.order();
        if (res.outcome === 'FAILED') {
          step.errors.push(res.error);
          this.#heartbeat.error(`execution FAILED: ${res.error?.message ?? 'unknown'}`);
        }
      } else {
        step.decision = null;
        step.skipped = evalResult?.reason ?? 'NO_SIGNAL';
      }

      // 10. heartbeat
      this.#heartbeat.maybeWrite({ instanceId: this.#instanceId, agentState: this.#agent.stateName });
    } catch (err) {
      // A throw in the loop must be recorded and must stop trading, rather
      // than silently killing the process.
      const payload = toErrorPayload(err);
      step.errors.push(payload);
      this.#heartbeat.error(err);
      this.#repos.logEvent({
        level: 'FATAL', category: 'tick_error', clock,
        message: `Unhandled error in tick ${step.tick}: ${err.message}`,
        details: { tick: step.tick, error: payload },
      });
      try {
        this.#agent.noteFailure();
        if (this.#agent.stateName !== STATES.FAILED) {
          this.#agent.state.transition(STATES.FAILED, `UNHANDLED_ERROR:${err.message}`);
        }
        this.#repos.engageStop({
          trigger: 'UNHANDLED_ERROR', severity: 'CATASTROPHIC', scope: 'NEW_ORDERS',
          reason: `Unhandled worker error: ${err.message}`, details: { tick: step.tick, error: payload }, clock,
        });
      } catch { /* the error path must never itself throw */ }
    } finally {
      this.#tickCount += 1;
      this.#heartbeat.tick();
    }

    return step;
  }

  /**
   * Run the loop until `stop()` is called or `maxTicks` is reached.
   * `maxTicks` exists for tests and the `simulate` command.
   */
  async run({ maxTicks = Infinity, signal = null } = {}) {
    const interval = this.#config.worker.tickMs;
    this.#logger.info('Loop started.', { intervalMs: interval, maxTicks: Number.isFinite(maxTicks) ? maxTicks : 'unbounded' });
    let ticks = 0;
    while (this.#running && ticks < maxTicks) {
      if (signal?.aborted) break;
      const t0 = this.#clock.now();
      await this.tick();
      ticks += 1;
      const elapsed = this.#clock.now() - t0;
      const wait = Math.max(0, interval - elapsed);
      if (wait > 0) await this.#clock.sleep(wait);
      else await this.#clock.sleep(0);
    }
    this.#logger.info('Loop finished.', { ticks });
    return { ticks };
  }

  #warmupComplete() {
    const need = this.#agent.strategy.minBars;
    return this.#config.instruments.every((i) => this.#broker.candles(i.symbol).length >= need);
  }

  #dailyLoss() {
    const dateKey = this.#clock.dateKey();
    // Run-scoped in BACKTEST for the same reason as the order counters: every
    // backtest replays from the same epoch, so an unscoped sum would carry an
    // earlier run's realised P&L into this one's daily-loss budget and could
    // halt it before it placed a single order.
    const scopeRunId = this.#repos.decisionScopeRunId;
    const rows = scopeRunId
      ? this.#repos.db.all(
        `SELECT kind, COALESCE(SUM(amount_egp),0) AS total FROM pnl_events
         WHERE mode = ? AND run_id = ? AND substr(ts,1,10) = ? GROUP BY kind`,
        this.#mode, scopeRunId, dateKey,
      )
      : this.#repos.db.all(
        `SELECT kind, COALESCE(SUM(amount_egp),0) AS total FROM pnl_events
         WHERE mode = ? AND substr(ts,1,10) = ? GROUP BY kind`,
        this.#mode, dateKey,
      );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
    const realized = roundEgp(byKind.REALIZED ?? 0);
    // Unrealised is the current mark-to-market of today's still-open positions.
    const account = this.#account.snapshot();
    return {
      dateKey,
      realizedEgp: realized,
      unrealizedEgp: account.unrealizedPnlEgp,
      totalEgp: roundEgp(realized + account.unrealizedPnlEgp),
      feesEgp: account.feesPaidEgp,
      equityEgp: account.equityEgp,
    };
  }

  #orderCounts() {
    const dateKey = this.#clock.dateKey();
    // BACKTEST counts are per-run: the ManualClock replays from a fixed epoch,
    // so every backtest in the database shares a date key and an unscoped count
    // would make the second run trip the daily order limit on the first order.
    // PAPER keeps the whole-mode view, so the rate limit survives a restart.
    const runId = this.#mode === 'BACKTEST' ? this.#runId : null;
    return {
      day: this.#repos.countOrdersToday(dateKey, this.#mode, runId),
      bySymbol: Object.fromEntries(
        this.#config.instruments.map((i) => [i.symbol, this.#repos.countOrdersForSymbolToday(i.symbol, dateKey, this.#mode, runId)]),
      ),
    };
  }

  #killSwitch() {
    // Scoping policy lives in `repos.sessionStop()` so the worker and the agent
    // can never disagree about whether a stop applies to this run.
    const stop = this.#repos.sessionStop(this.#mode);
    if (!stop) return { engaged: false };
    return {
      engaged: true, trigger: stop.trigger, reason: stop.reason,
      since: stop.ts, scope: stop.scope, stopId: stop.stop_id, severity: stop.severity,
    };
  }

  #maybeResetDailyLoss() {
    const key = this.#clock.dateKey();
    if (key === this.#lastDailyResetKey) return null;
    const previous = this.#lastDailyResetKey;
    this.#lastDailyResetKey = key;
    this.#repos.logEvent({
      level: 'INFO', category: 'daily_reset', clock: this.#clock,
      message: `Daily loss window rolled from ${previous} to ${key}.`, details: { previous, current: key },
    });
    return { previous, current: key };
  }

  /** Graceful shutdown: checkpoint, release the lock, mark the run stopped. */
  async stop({ reason = 'shutdown' } = {}) {
    if (!this.#running) return { stopped: false };
    this.#stopping = true;
    this.#running = false;
    try {
      if (this.#agent && this.#agent.stateName !== STATES.FAILED) {
        this.#agent.state.transition(STATES.STOPPED, reason);
      }
      this.#account?.tickEquity({ reason: 'shutdown' });
      this.#repos.updateRunStatus(this.#runId, 'STOPPED', this.#clock);
      this.#heartbeat.write({ instanceId: this.#instanceId, agentState: STATES.STOPPED, status: HEALTH.STOPPED });
      this.#repos.logEvent({
        level: 'INFO', category: 'shutdown', clock: this.#clock,
        message: `Worker stopped: ${reason}.`, details: { ticks: this.#tickCount, runId: this.#runId },
      });
    } finally {
      this.#lock.release();
      this.#broker?.disconnect();
    }
    this.#logger.info('Worker stopped.', { reason, ticks: this.#tickCount });
    return { stopped: true, ticks: this.#tickCount, runId: this.#runId };
  }

  /** Health payload for the dashboard. */
  health() {
    return {
      worker: this.#heartbeat.probe(),
      instanceId: this.#instanceId,
      runId: this.#runId,
      running: this.#running,
      tickCount: this.#tickCount,
      lockHeld: this.#lock.held,
      lockPath: this.#lock.path,
      killSwitch: this.#killSwitch(),
      recovery: this.#hostRecovery,
    };
  }
}