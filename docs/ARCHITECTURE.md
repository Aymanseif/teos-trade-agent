# TEOS Trade Agent — Phase 1 Architecture

Operational description of the Phase 1 TEOS Trade Agent as it is implemented in
this repository. This document describes what the code does, not what it is
intended to do. Where a source-file comment disagrees with the code, the code is
what is documented here.

Document status: accurate to `configVersion: 1`, profile `phase1-paper-defaults`.

---

## 0. Read this first

> **PHASE 1 HAS NO LIVE EXECUTION ADAPTER.**
>
> There is no component in this repository that can place an order on a real
> exchange or with a real broker. The only broker implementation that exists is
> an in-process paper-exchange simulator. The environment layer refuses to
> construct any other kind, and the process refuses to start in `LIVE` mode.

Three additional statements belong in the same place.

1. **The strategy is currently slightly loss-making.** The active strategy is a
   moving-average crossover with configured costs that include fees and
   slippage. No component of this system demonstrates an edge, and no
   profitability is claimed. Backtest and paper results are descriptions of one
   simulated price path, not forecasts.

2. **EGP 500 is a configured paper-account ceiling, not deployed capital.** It
   is the `account.startingCapitalEgp` value in `config/default.json` and the
   `risk.maxStartingCapitalEgp` cap. It is simulated. No real EGP exists
   anywhere in this system on either side of a trade.

3. **Leverage, margin, borrowing and futures are impossible by construction.**
   The account is long-only and cash-funded. Orders are hard-coded
   `leverageRequested: false`, `borrowRequested: false`, `marginRequested:
   false`, `shortRequested: false`, and `instrumentType: 'SPOT'` in
   `src/execution/execution-adapter.js`. A SELL with no open long is refused
   before it becomes an order. There is no code path that can set any of those
   flags to true.

### Terminology

These three words are used precisely and are **not interchangeable**.

| Term | Meaning in this document |
|------|--------------------------|
| **PAPER** | Simulated execution against the in-process market simulator. A real process, a real SQLite database, a real order lifecycle — but no real money and no external venue. Mode string `PAPER`. |
| **BACKTEST** | Replay of a recorded or generated historical price path through the *same* worker loop and the *same* pipeline, writing to a separate database. Mode string `BACKTEST`. |
| **LIVE** | Real capital at a real venue. **Not implemented.** There is no adapter, no credential path and no network call to any exchange. Mode string `LIVE` is rejected at startup. |

### Diagrams

Diagrams are fenced ASCII. The pipeline is drawn in section 1; the worker loop in
section 5.

---

## 1. The execution pipeline

An order can only reach the paper exchange through one function:
`ExecutionFirewall.execute()` in `src/execution/firewall.js`. That function is the
only caller of `ExecutionAdapter.submit()`, which is the only caller of
`MockBroker.placeOrder()`. The chain is fixed and has no bypass.

```
  ┌─────────┐   ┌────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────────────┐   ┌────────────────┐
  │  AGENT  │──▶│ SIGNAL │──▶│ RISK ENGINE  │──▶│ SENTINEL │──▶│ EXECUTION ADAPTER│──▶│ PAPER EXCHANGE │
  └─────────┘   └────────┘   └──────────────┘   └──────────┘   └──────────────────┘   └────────────────┘
   engine.js    strategies   risk-engine.js     sentinel.js     execution-adapter.js    mock-broker.js
   state.js     *.js         rules/index.js                                        + matching-engine.js
   decision.js               limits.js                                               market-simulator.js
                                                                                    slippage.js / fees.js
        ▲                                                                                     │
        └─────────────────────────── fills / positions / P&L ◀───────────────────────────────┘
                         (src/paper/paper-account.js, ledger.js, pnl.js)
```

The single orchestrator is `src/execution/firewall.js`. It advances a decision
through the stages below and returns one of `EXECUTED`, `BLOCKED`,
`QUARANTINED` or `FAILED` (`OUTCOMES` in that file).

### 1.1 AGENT → a sealed Decision

- **Modules:** `src/agent/engine.js` (`AgentEngine.evaluateOnce()`),
  `src/agent/state.js` (`AgentStateMachine`), `src/agent/decision.js`
  (`decisionToRow`, the sealed `Decision` shape).
- **Inputs:** the broker's candle history and current quote for one symbol; the
  paper account snapshot; the current `AgentState`; the risk engine (passed in
  so the strategy's stop distance can be resolved against policy).
- **Outputs:** one immutable `Decision` object, or no decision. A decision
  carries `decisionId`, `symbol`, `signal` (`BUY` / `SELL` / `HOLD`), `price`,
  `positionSize`, `notionalEgp`, `confidence`, `stopPrice`, `stopCondition`,
  `strategyMeta`, `agentState` and the permission matrix. The decision is
  persisted (`agent_decisions`) and emitted to the heartbeat.
- **Refusal / stop conditions:** the agent returns no executable decision when
  the state machine forbids opening positions, when the strategy returns a
  HOLD, or when warm-up bars are insufficient. One symbol is evaluated per
  call; there is no loop over instruments inside a single call.

### 1.2 SIGNAL → strategy output

- **Modules:** `src/agent/strategies/strategy.interface.js` (`makeSignal`,
  `hold`, `resolveStop`, `hasLongToExit`), the three strategy modules, and
  `src/agent/indicators.js` (pure indicator functions).
- **Inputs:** the decision context — candles, current price, existing position,
  resolved stop band, grant/deny permissions.
- **Outputs:** a signal object `{ signal, confidence, stopPrice, targetPrice,
  stopDistancePct, riskRewardRatio, features, reason, meta }` or a HOLD.
  Registered strategies are `sma_cross` (active), `rsi_reversion` and
  `donchian_breakout`; the registry is `src/agent/strategies/registry.js`.
- **Refusal conditions:** warm-up (`minBars`), indicators not yet defined, and
  `hasLongToExit(ctx.position) === false` on a SELL (long-only: a crossover
  down with no long is a HOLD, not an order).
- **Confidence is a relative strength score in 0..1, not a probability of
  profit.** The strategy comments state this explicitly.

### 1.3 RISK ENGINE → a risk verdict

- **Modules:** `src/risk/risk-engine.js` (`proposeOrder`, `check`),
  `src/risk/rules/index.js` (19 rules), `src/risk/limits.js`
  (`RiskLimits`, `effectiveRiskBudget`).
- **Inputs:** the decision, a portfolio *snapshot* (never the live account
  object, so a rule cannot mutate the portfolio), the quote, daily P&L, broker
  health, the kill-switch state, order counts, and the previous snapshot used as
  the reference price for the abnormal-movement check.
- **Outputs:** a `RiskVerdict` `{ riskDecisionId, verdict, blocked, reason,
  failedRule, rules, passedCount, failedCount, account, limits, clientOrderId,
  stopToLatch }`. Every evaluation is persisted, including BLOCK verdicts.
- **Sizing:** the agent never chooses a quantity. `proposeOrder()` derives it
  from the stop distance and the requested risk percentage through
  `sizePosition()` in `src/paper/pnl.js`, capped by
  `maxPositionSizeEgp`, remaining portfolio exposure and available cash.
- **Refusal conditions:** the first rule returning `BLOCK` stops the run of
  rules (fail-fast). Rules that latch (`latchesStop: true`) engage an emergency
  stop in the same transaction as the verdict write. A rule that **throws** is
  converted to a `CATASTROPHIC` BLOCK with `latchesStop: true` — fail-closed,
  never a pass.
- **Special refusal:** a `BUY` with quantity `<= 0` (nothing to size) and a
  `SELL` with no position to reduce both produce a zero-quantity proposal; the
  firewall treats `proposal.quantity <= 0` as `BLOCKED` before the Sentinel runs.

The 19 rules, in evaluation order:

```
 1 NO_LEVERAGE          11 OPEN_POSITIONS
 2 KILL_SWITCH          12 ORDER_RATE
 3 AGENT_STATE          13 ORDER_VALID
 4 CONNECTION           14 MIN_NOTIONAL
 5 DATA_FRESHNESS       15 SUFFICIENT_BALANCE
 6 PRICE_SANITY         16 POSITION_SIZE
 7 MAX_CAPITAL          17 RISK_PER_TRADE
 8 NO_NEGATIVE_CASH     18 STOP_CONDITION
 9 DAILY_LOSS           19 DUPLICATE_ORDER
10 EXPOSURE
```

### 1.4 SENTINEL → an independent second opinion

- **Module:** `src/execution/sentinel.js` (14 rules, `Sentinel.evaluate()`).
- **Inputs:** the decision, the risk proposal, the risk verdict, the account
  snapshot *and* the live account reference (read-only; the SHORT_GUARD needs to
  know whether a long exists), daily P&L, kill-switch state, quote and mode.
- **Outputs:** a `SentinelVerdict` `{ sentinelDecisionId, verdict, actionTaken,
  reason, triggerRule, rules, thresholds, policyVersion }`. The verdict is one
  of `ALLOW`, `WARN`, `REVIEW`, `BLOCK`.
- **Refusal conditions:** the first `BLOCK` refuses the order. `REVIEW`
  quarantines the decision for human approval and does **not** submit it. The
  Sentinel record is persisted for every verdict, including ALLOW.

The 14 rules, in evaluation order:

```
 1 MODE_GUARD           8 LOW_CONFIDENCE
 2 KILL_SWITCH          9 WIDE_STOP
 3 RISK_VERDICT        10 DAILY_LOSS_PRESSURE
 4 DUPLICATE_ORDER     11 EXPOSURE_PRESSURE
 5 MANUAL_HOLD         12 DECISION_RATE
 6 PRICE_DRIFT         13 STOP_REQUIRED
 7 UNUSUAL_SIZE        14 SHORT_GUARD
```

`MANUAL_HOLD` blocks **every** order while `TRADING_HOLD` is set, including
risk-reducing exits. See the discrepancy note in the final report.

### 1.5 EXECUTION ADAPTER → a persisted, idempotent order

- **Modules:** `src/execution/execution-adapter.js` (`buildOrder`, `submit`),
  `src/execution/validator.js` (`assertValidOrder`).
- **Inputs:** the decision, the risk proposal and verdict, the Sentinel verdict,
  the quote and the account snapshot.
- **Outputs:** `{ submitted, order, duplicate, reason?, warnings? }`. On success
  the order row moves `PENDING_NEW → NEW`.
- **Refusal conditions:**
  - `buildOrder()` throws `InvalidOrderError` unless the Sentinel verdict is
    `ALLOW` or `WARN` (the `SUBMITTABLE` set), and unless risk is not blocked.
  - An unknown instrument is refused.
  - `assertValidOrder()` performs a final shape validation, including
    `leverageRequested === false` and `borrowRequested !== true`.
  - A duplicate `client_order_id` (deterministic, derived from `decisionId`) is
    refused at the storage layer (`UNIQUE`) and re-checked in `submit()`.
  - An active emergency stop immediately before the broker call throws
    `EmergencyStopError` and nothing is submitted.
- **Idempotency:** `clientOrderId(decisionId)` is
  `TEOS-` + the first 24 uppercase hex characters of
  `sha256('teos|' + decisionId + '|' + attempt)`. The adapter persists the
  intent as `PENDING_NEW` **before** calling `broker.placeOrder()`, so a crash
  between submit and fill still leaves an auditable row.

### 1.6 PAPER EXCHANGE → simulated fills

- **Modules:** `src/broker/mock/mock-broker.js` (`MockBroker`),
  `src/broker/mock/matching-engine.js`, `src/broker/mock/market-simulator.js`,
  `src/broker/mock/slippage.js` (`SlippageModel`), `src/broker/mock/fees.js`
  (`FeeModel`), `src/broker/mock/rng.js` (seeded mulberry32 PRNG).
  The interface is `src/broker/broker.interface.js`.
- **Inputs:** a validated order, the current simulated quote and book, the
  seeded random stream.
- **Outputs:** an acknowledgement and, over time, fills; the fills are applied
  to the paper account and the append-only `fills` table.
- **Refusal conditions:** `MockBroker` rejects any order whose
  `leverageRequested` / `borrowRequested` / `marginRequested` / `shortRequested`
  is not literally false, and its `#fillGuard` caps or cancels impossible fills
  before the matching engine can produce them. Fees are never zero (config
  validation rejects a zero-fee environment) and slippage is applied to market
  orders.
- **Determinism:** every stochastic element (price path, spread, slippage
  jitter, partial-fill behaviour) is drawn from one seeded stream, so a seed
  plus a tick count reproduces a run.

---

## 2. Module responsibilities

Every module under `src/`. The table is grouped by directory.

### `src/` (entrypoint)

| Module | Responsibility |
|---|---|
| `cli.js` | Operator command surface: `run`, `simulate`, `backtest`, `status`, `hold` / `resume`, `kill-switch` / `reset-stop`, `verify`, dashboard start, and the other commands in its help text. Parses arguments, builds config, constructs the worker, and prints or exits. |

### `src/core/`

| Module | Responsibility |
|---|---|
| `config.js` | Loads `config/default.json`, merges environment overrides, validates every field (numbers, enums, non-zero fees), resolves `paths` (`dataDir`, `logDir`, `dbFile = teos-<mode>.db`). |
| `env.js` | Environment access and the mode guard. `assertNoCredentialsPresent`, `assertLiveTradingDisabled`; `loadTradingCredentials()` throws unconditionally; `redact` strips secret-shaped values. `TEOS_MODE=LIVE` throws. |
| `clock.js` | The `Clock` abstraction: `systemClock` for real runs and `ManualClock` for deterministic tests and the backtest. |
| `errors.js` | Typed error classes (`ConfigError`, `InvalidOrderError`, `ValidationError`, `EmergencyStopError`, `WorkerError`, …) and `toErrorPayload` for structured logging. |
| `assert.js` | Validation helpers used at trust boundaries (`assert`, `requireNumber`, `requireString`, `requireEnum`, `requireValidOrderShape`, …). Order-shape failures are `InvalidOrderError`. |
| `ids.js` | Identifier generation (`newId`) and the deterministic `clientOrderId(decisionId)` used for order idempotency. |
| `money.js` | Integer-piastre money arithmetic (1 EGP = 100 piastres), rounding, and basis-point conversion, so long runs do not drift. |
| `logger.js` | Structured JSONL logging with hard secret redaction applied to the final string form. A broken sink or log directory never breaks the agent. |

### `src/database/`

| Module | Responsibility |
|---|---|
| `db.js` | Opens SQLite (`openDatabase`), sets pragmas, exposes `tx`, `all`, `get`, `count`, `scalar`. A `readonly` option is used by the dashboard. |
| `schema.sql` | The full schema. Every table except `schema_migrations` carries `mode` constrained to `('BACKTEST','PAPER')`; `backtest_runs` adds `CHECK (mode = 'BACKTEST')`. |
| `migrate.js` | Applies `schema.sql` and versioned migrations via the `schema_migrations` table. |
| `audit-chain.js` | The four per-mode hash chains (`STREAMS`, `STREAM_COLUMNS`, `seal`, `verify`). See section 8. |
| `repositories/index.js` | The only writer of the database. All inserts, updates, queries, transition tables, stop scoping and restart records live here. |

### `src/agent/`

| Module | Responsibility |
|---|---|
| `engine.js` | `AgentEngine`. Builds the decision context, calls the strategy, seals a `Decision`, exposes `breachedStops`, `workingOrder`, `assessHealth`, `evaluateOnce`, `buildStopExitDecision`. |
| `state.js` | `AgentStateMachine` and `STATES`. Tracks STARTING / WARMUP / HEALTHY / DEGRADED / HALTED / FAILED / STOPPED and writes `agent_state_log`. |
| `decision.js` | The sealed decision shape and `decisionToRow` for persistence. |
| `indicators.js` | Pure indicator functions (SMA, EMA, RSI, ATR, true range, Donchian, standard deviation, slope, trend strength). No state, no clock, no side effects. |
| `strategies/strategy.interface.js` | Shared strategy contract: `makeSignal`, `hold`, `resolveStop` (stop band clamping), `hasLongToExit`. |
| `strategies/registry.js` | Maps strategy id to implementation; resolves the configured `active` strategy. |
| `strategies/sma_cross.js` | Active strategy. Fast/slow SMA crossover, ATR stop, fixed reward multiple; confidence is a relative strength score. |
| `strategies/rsi_reversion.js` | RSI(14) mean reversion with ATR stop, long-only. |
| `strategies/donchian_breakout.js` | Donchian channel breakout with ATR stop, long-only. |

### `src/risk/`

| Module | Responsibility |
|---|---|
| `risk-engine.js` | `proposeOrder` (sizing) and `check` (19 ordered rules, fail-closed, latching). Persists every verdict and latches stops atomically. |
| `rules/index.js` | The 19 risk rules. |
| `limits.js` | `RiskLimits` (validated bound on every risk value) and `effectiveRiskBudget`. |

### `src/execution/`

| Module | Responsibility |
|---|---|
| `firewall.js` | The pipeline orchestrator and the only caller of `adapter.submit()`. Returns EXECUTED / BLOCKED / QUARANTINED / FAILED and can `verifyPipeline(decisionId)`. |
| `sentinel.js` | The 14 Sentinel rules and `evaluate()`; second, independent gate. |
| `execution-adapter.js` | The only component that may call `broker.placeOrder()`. Builds the order, enforces idempotency, validates, persists intent before submission. |
| `validator.js` | `assertValidOrder`: final order-shape and plausibility validation. |

### `src/broker/`

| Module | Responsibility |
|---|---|
| `broker.interface.js` | The broker contract and `registerBroker`, which refuses any broker whose `kind !== 'PAPER'`. |
| `mock/mock-broker.js` | `MockBroker` (`providerId: 'mock-paper'`, `kind: 'PAPER'`). The paper exchange: connect, tick, placeOrder, cancelOrder, getMarketData, candles, health. The constructor throws in LIVE mode. |
| `mock/market-simulator.js` | Generates the seeded simulated price path and spreads, builds candles. |
| `mock/matching-engine.js` | Matches resting orders against the simulated book and produces fills (including partial fills). |
| `mock/slippage.js` | `SlippageModel`: half-spread + base + size impact + seeded jitter, capped at `maxBps`. |
| `mock/fees.js` | `FeeModel`: maker/taker basis points with a minimum fee, computed in piastres. Fees are never zero. |
| `mock/rng.js` | Deterministic mulberry32 PRNG plus Box-Muller normal; the single source of all simulated randomness. |

### `src/paper/`

| Module | Responsibility |
|---|---|
| `paper-account.js` | The long-only paper portfolio: cash, positions, `applyFill`, `snapshot`, `loadOpenPositions`, `tickEquity`, `positionFor`. Throws on a SELL with no open long. |
| `ledger.js` | Mutates cash in integer piastres for each fill. |
| `pnl.js` | P&L, `sizePosition`, `drawdown` and trade accounting helpers. |
| `equity-curve.js` | Builds and stores the equity/balance history series. |

### `src/worker/`

| Module | Responsibility |
|---|---|
| `worker.js` | `Worker`: lock, boot, the tick loop, the health/state machine, the firewall call, heartbeat, graceful stop. See section 5. |
| `lock.js` | `WorkerLock` and `newInstanceId`. Single-instance lock with reclaim logic. See section 7. |
| `heartbeat.js` | `Heartbeat` and `HEALTH`. Periodic heartbeat rows, health state resolution, and `probe()` for the dashboard. |
| `idempotency.js` | `IdempotencyGuard`, `reconcileInFlight` (restart recovery of in-flight orders) and `reconcileCash` (fill-history cash reconstruction). |

### `src/backtest/`

| Module | Responsibility |
|---|---|
| `engine.js` | `BacktestEngine`. Reuses the identical `Worker` loop with a swapped market source, forces `mode = BACKTEST` and `resume: false`, scopes every count to the run, persists results. |
| `replay-feed.js` | `generateHistory` and `ReplayFeed`: the historical/generated candle source that replaces the live simulator. |
| `persist.js` | Writes backtest runs and trades (`backtest_runs`, `backtest_trades`). |
| `metrics.js` | Pure performance metrics (returns, Sharpe, profit factor, win rate, …). Reads no clock, database or config. |
| `report.js` | Renders the backtest result as terminal text or JSON, opening every output with the simulation disclaimer. |

### `src/dashboard/`

| Module | Responsibility |
|---|---|
| `server.js` | Read-only loopback HTTP server. GET/HEAD only, a frozen static allow-list, read-only SQLite, CSP and security headers, bind-host checks. |
| `api.js` | Pure view builders for the four sections (account, agent, risk, audit) plus `snapshot`, `section`, `SECTIONS` and audit-chain integrity. |
| `public/index.html` | The single page; the safety banner is part of the markup. |
| `public/app.js` | Vanilla ES2020 front end. Writes database values with `textContent`, never `innerHTML`. |
| `public/style.css` | Styling, including the paper-mode badge, banner and flags. |

---

## 3. Database boundaries and ownership

SQLite is the system of record. There are two databases, one per mode, selected
by `config.paths.dbFile = teos-<mode>.db`. PAPER and BACKTEST never share a
database file.

### 3.1 Ownership

`src/database/repositories/index.js` is the **only** module that writes to the
database. The worker, agent, risk engine, Sentinel, adapter and paper account all
go through a `Repos` instance. The one deliberate exception is the dashboard,
which opens the same file with `readonly: true` and only reads.

`AuditChain` (`src/database/audit-chain.js`) owns the hash columns; it is called
by `Repos` when it seals a decision, risk verdict, Sentinel verdict or order.

### 3.2 Tables and the mode column

Every table except `schema_migrations` carries
`mode TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER'))`. `backtest_runs`
additionally carries `CHECK (mode = 'BACKTEST')`. There is no `LIVE` value in the
schema. Adding one would require a migration (see section 12).

| Table | Contents | Scoping |
|---|---|---|
| `schema_migrations` | Applied migration versions. | global |
| `runs` | One row per worker run; startup capital, strategy, config summary, status, instance. | mode |
| `system_events` | Structured event log rows (levels, categories). | mode |
| `market_snapshots` | Every persisted quote, with `seq`, bid/ask/mid and spread. | mode (+ run for BACKTEST) |
| `agent_decisions` | Sealed agent decisions; head of the decision chain. | mode, run |
| `risk_decisions` | One risk verdict per decision, including BLOCKs. | mode, run |
| `sentinel_decisions` | One Sentinel verdict per decision. | mode, run |
| `orders` | Order lifecycle; **mutable** status columns plus immutable intent. | mode, run |
| `fills` | Append-only fills; the source of truth for positions and cash. | mode, run |
| `positions` | Open and closed positions derived from fills. | mode, run |
| `balances` | Cash / fees / slippage balance history. | mode, run |
| `pnl_events` | Realised P&L events, used for the daily-loss window. | mode, run |
| `equity_curve` | Equity history points. | mode, run |
| `emergency_stops` | Kill-switch stops (trigger, severity, scope, active flag). | mode, run |
| `control_flags` | Operator flags including `TRADING_HOLD` and `EMERGENCY_STOP`. | mode |
| `worker_heartbeats` | Heartbeat rows: status, agent state, pid, host, counters. | mode |
| `restarts` | One row per start: kind, previous/new instance, orphan count, recovery JSON. | mode |
| `backtest_runs` | Backtest run records (`mode = 'BACKTEST'` only). | BACKTEST only |
| `backtest_trades` | Per-trade backtest records. | BACKTEST only |
| `agent_state_log` | State-machine transitions. | mode |

### 3.3 Scoping policy

`Repos` exposes `decisionScopeRunId`. The policy differs by mode and is
deliberate:

- **BACKTEST is run-scoped.** Every count, P&L window and report query is scoped
  by `run_id`, because a backtest database is reused across runs and the
  `ManualClock` replays from a fixed epoch (so an unscoped daily window would
  carry a previous run's P&L or trip a rate limit).
- **PAPER is mode-wide.** Counts and the daily-loss window are scoped by mode,
  not run, so a rate limit or loss budget survives a restart.

A comment in `worker.js` notes that a past defect wrote rows with
`run_id = NULL`, which silently broke run-scoped queries while still looking
correct when queried by mode alone. `setRun()` stamps every repository write.

---

## 4. PAPER / BACKTEST isolation

PAPER and BACKTEST run the **same** loop, the same risk engine, the same
Sentinel, the same adapter and the same matching engine. They differ in exactly
two things: where prices come from, and which database the rows are written to.

```
                    ┌─────────────────────────────────────────┐
                    │            Worker (one loop)             │
                    │  lock → broker.tick → stops → health →  │
                    │  equity → daily reset → decision →       │
                    │  firewall → heartbeat                   │
                    └───────────────────┬─────────────────────┘
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              │                                                   │
     ┌────────▼─────────┐                              ┌──────────▼──────────┐
     │ PAPER            │                              │ BACKTEST            │
     │ market-simulator │                              │ replay-feed         │
     │ teos-paper.db    │                              │ teos-backtest.db    │
     │ mode='PAPER'     │                              │ mode='BACKTEST'     │
     │ mode-wide scope  │                              │ run-scoped          │
     │ resume = true    │                              │ resume = false      │
     └──────────────────┘                              └─────────────────────┘
```

`BacktestEngine` (`src/backtest/engine.js`):

- refuses to construct unless `config.mode === 'BACKTEST'` ("Refusing to mix
  modes");
- injects a pre-built broker based on the `ReplayFeed` into the `Worker`, so
  there is deliberately no second tick loop;
- calls `worker.start({ resume: false })` and throws if the worker resumed an
  existing run ("A backtest always starts from EGP 500");
- scopes every count and report query to the new `runId`.

### PAPER continuity

PAPER is one continuous account across restarts. `Worker.start({ resume: true })`
on a `RUNNING` run:

- reuses the run's `run_id`;
- restores cash, fees paid, slippage cost and equity history from the last
  `balances` and `equity_curve` rows;
- adopts the open positions (`account.loadOpenPositions()`).

A **cold** start does *not* adopt leftover `OPEN` positions. A row still marked
OPEN belongs to a previous, ended run with a different starting balance; adopting
it would silently open this run holding another run's positions. The cold start
logs a `WARN` listing the orphan positions and then continues with a fresh book.

Because `MockBroker` throws in LIVE mode, because `registerBroker` refuses any
`kind !== 'PAPER'`, and because `config.mode` is validated against the database
filename and the schema `CHECK`, a PAPER process cannot write BACKTEST rows and a
BACKTEST process cannot write PAPER rows.

---

## 5. Worker lifecycle

`Worker` in `src/worker/worker.js` is a persistent supervisor with three
lifecycle phases.

### 5.1 Boot — `start({ resume })`

1. Acquire the single-instance lock (`lock.acquire`).
2. Classify the start: `COLD_START` (no prior run), `RESUME` (a `RUNNING` run
   exists and `resume` is true), or `CRASH_RECOVERY` (a prior run exists but is
   not `RUNNING`).
3. Set the run id and stamp repository writes (`setRun`).
4. Restore or create the paper account (section 6).
5. Build the broker (injected for BACKTEST, `MockBroker` otherwise) and connect.
   A failed connection releases the lock and throws.
6. **Recover in-flight orders before the loop can create new ones**
   (`reconcileInFlight`).
7. Reconcile the fill history against cash (`reconcileCash`) and log loudly on a
   mismatch.
8. Start a fresh `AgentStateMachine` at `STARTING` (a restart never resumes a
   previous terminal state; the emergency-stop table is what actually gates
   trading), then transition to `WARMUP`.
9. Write the `restarts` row and the first heartbeat; return a recovery report
   `{ instanceId, runId, kind, isResume, restoredCashEgp, startingCapitalEgp,
   inFlight, cashCheck, previousSeq, openPositions }`.

### 5.2 The tick loop

The header comment in `worker.js` numbers the steps 1–10. The **actual** order in
`tick()` is below (the daily-loss rollover runs *before* the decision, not after
the heartbeat — see the final report's discrepancy list).

```
 1. lock.refresh(now)                    keep the single-instance claim fresh
 2. broker.tick()                        advance market, match resting orders
 3. persist market snapshots             every quote (staleness + price sanity)
 4. enforce breached stops               stop exits are first-class Decisions
 5. health / state machine               HEALTHY / DEGRADED / HALTED
 6. account.tickEquity()                 equity curve + balance history
 7. daily-loss rollover                  at UTC midnight
 8. agent.evaluateOnce()                 one sealed Decision, or nothing
 9. firewall.execute()                   risk → sentinel → adapter → paper
10. heartbeat.maybeWrite()               gated by heartbeatMs (5000)
```

(Every step is wrapped so an unexpected throw is recorded, counted and converted
into a HALT; see section 11.)

Notes on the tick:

- **Step 4**, stop enforcement: a breached stop becomes a real `Decision` and
  goes through the same firewall. If an exit order for that position is already
  working, no second exit is submitted (logged as `order_in_flight`, outcome
  `SKIPPED`). If the firewall refuses a breached stop, that is a CRITICAL
  condition: the position stays open and the worker latches a
  `STOP_EXIT_BLOCKED` emergency stop.
- **Step 8**, the decision: one symbol per call by construction. The config keys
  `worker.maxDecisionsPerTick` (1) and `worker.heartbeatIntervalCycles` (5) exist
  and are validated/loaded, but the worker does not read either one.
- **Step 10**, the heartbeat: `maybeWrite` returns early unless
  `heartbeatMs` has elapsed.

`run({ maxTicks, signal })` repeats `tick()` at the configured `tickMs` (1000),
subtracting elapsed time so the cadence does not drift. `maxTicks` exists for
tests and the `simulate` command.

### 5.3 Stop — `stop({ reason })`

Graceful shutdown:

1. transition the agent state to `STOPPED` (unless it is already `FAILED`);
2. write a final equity point;
3. mark the run `STOPPED`;
4. write a final heartbeat;
5. release the lock and disconnect the broker.

The in-memory `running` flag is cleared, so the loop ends. No order is left
half-submitted: the adapter persists intent before submission, so a crash
between submit and fill is recovered on the next boot (section 6).

---

## 6. Restart recovery

Three mechanisms combine so that a restart is safe.

### 6.1 Start classification

`kind` is `COLD_START`, `RESUME` or `CRASH_RECOVERY`, written to the `restarts`
table with `orphaned_orders` and a `recovery_json` payload carrying the in-flight
report, the cash check and the last agent state.

### 6.2 In-flight order reconciliation

`reconcileInFlight` (`src/worker/idempotency.js`) runs at boot, before the loop.
It deliberately **never resubmits**. For each in-flight order:

| Fills found | Action | Recorded resolution |
|---|---|---|
| none | mark `CANCELED`, reason `RECOVERED_UNFILLED_AFTER_RESTART`, terminal | `CANCELED_UNFILLED` |
| complete | mark `FILLED`, terminal | `FILLED` |
| partial | mark `CANCELED`, keep the filled part, terminal | `PARTIAL_CANCELED_REMAINDER` |

The invariant is: **one decision produces at most one order, forever, across any
number of restarts.** Two independent mechanisms enforce it — a deterministic
`client_order_id` derived from the decision id, constrained `UNIQUE` at the
storage layer, and the reconciliation above, which refuses to resubmit.

### 6.3 Cash reconciliation

`reconcileCash` rebuilds cash from the fill history for the current run
(`runId`-scoped) and compares it to the ledger. A mismatch is an integrity defect
and is logged at ERROR with the expected and actual balances. The tolerance is
under one piastre. This is one of the checks in `scripts/verify.js`.

### 6.4 State restoration

A restart always begins a **fresh** state machine at `STARTING`. The previous
terminal state (HALTED, FAILED, STOPPED) is history and is recorded in the
restart row; it does not resume as a live state. Health is re-derived from the
current broker and data. The emergency-stop table, not the state machine, is what
actually gates trading after a restart.

---

## 7. Heartbeat and single-instance lock

### 7.1 Heartbeat

`Heartbeat` (`src/worker/heartbeat.js`) writes a row carrying status, agent
state, pid, host, version, uptime, and counters for ticks, decisions, orders and
errors, plus the last decision id and last error.

Health states:

```
HEALTHY   heartbeat current, agent HEALTHY, no kill switch
DEGRADED  heartbeat current but agent DEGRADED (cannot open positions)
HALTED    agent HALTED or an emergency stop is engaged
STALE     last heartbeat older than the staleness threshold (process presumed dead)
STOPPED   the worker shut down cleanly
STARTING  booting
FAILED    an unrecoverable error
```

`maybeWrite()` writes at most once per `heartbeatMs` (5000) and is called at the
**end** of each tick. `probe()` is the read side used by the dashboard: it returns
`STALE` when the last heartbeat age exceeds `heartbeatStaleAfterMs` (30000), and
`ok: false, alive: false` for `STOPPED`. This lets a dead process be detected
even when nobody is around to restart it.

### 7.2 Single-instance lock

`WorkerLock` (`src/worker/lock.js`) writes
`data/teos-<mode>.lock` and holds it for the life of the run. Two loops must
never share one database.

Reclaim semantics (this is the operational hazard worth understanding):

```
age   = nowMs - existing.heartbeatMs
fresh = age >= 0 && age <= staleAfterMs
alive = sameHost ? pidAlive(existing.pid) : fresh
```

- **On one host, a live PID means the lock is held regardless of heartbeat age.**
  A process that is wedged but alive blocks a restart indefinitely.
- A **dead** PID allows reclaim even if the lock file was written moments ago.
- A **negative** age (clock skew) is treated as *not* fresh.
- A **corrupt** lock file is treated as absent and is reclaimed.

`lock.refresh(now)` is called as step 1 of every tick so the on-disk heartbeat
timestamp stays current; that timestamp is what the cross-host path uses.

---

## 8. The four audit chains

`src/database/audit-chain.js` maintains four independent hash chains, one per
stream, **per mode**:

| Stream | Table | Sealed when |
|---|---|---|
| `decision` | `agent_decisions` | a decision is persisted |
| `risk` | `risk_decisions` | a risk verdict is persisted (including BLOCK) |
| `sentinel` | `sentinel_decisions` | a Sentinel verdict is persisted (including ALLOW) |
| `order` | `orders` | an order intent is persisted |

Each row's hash is:

```
sha256('<stream>|<mode>|<prevHash or GENESIS>|<canonicalJson(body)>')
```

Canonical JSON means sorted keys, no whitespace, and `undefined` values dropped.
`STREAM_COLUMNS` fixes, per stream, exactly which columns are hashed and in what
order. The chain cursor is loaded at start-up, validated against the database and
advanced on each append.

**The `orders` stream is the only stream with mutable columns.** Its lifecycle
columns (`status`, `filled_quantity`, `avg_fill_price`, `updated_at`,
`terminal_at`, `rejection_reason`) are deliberately excluded from the hash,
because hashing a column that later changes legitimately would make `verify()`
report tampering on every fill, and a chain that always reports "broken" trains
operators to ignore it. Those columns are instead protected by:

- the order state machine in `Repos.updateOrderStatus`, which rejects illegal
  transitions, and
- reconciliation against the append-only `fills` table
  (`Repos.auditOrderFills`).

The order's immutable `status_at_submit` **is** hashed, so what the chain proves
about an order is that the intent — which decision it came from and the side,
symbol, quantity and price it asked for — was never rewritten after the fact.

`scripts/verify.js` runs ten independent integrity checks, including chain
verification for all four streams, the cash reconstruction and the order/fill
reconciliation.

---

## 9. Dashboard

`src/dashboard/server.js` and `src/dashboard/api.js`.

- **Loopback only.** The bind host is checked against a loopback allow-list
  (`127.0.0.0/8`, `::1`, `localhost`). `0.0.0.0` is explicitly not accepted.
  `dashboard.allowNonLoopbackBind !== false` is a hard refusal, and after
  `listen()` the bound address is re-checked.
- **Read-only.** The database is opened with `readOnly: true`, so SQLite itself
  refuses a write.
- **GET/HEAD only**, a maximum URL length of 2048, and a frozen allow-list of
  three static files. Security headers include a Content-Security-Policy that
  blocks inline and remote script.
- **Auth:** none, by design, because it is loopback-only. The health payload
  points at a `SECURITY.md` that does not exist in this repository (see the
  final report).
- Config: host `127.0.0.1`, port `8787`, poll interval 2000 ms, page size 200.
  The token environment variable is declared but the environment layer throws if
  a token is actually set, so no auth path is active.

Routes:

```
GET /                       the page
GET /index.html             the page
GET /app.js                 front end
GET /style.css              styling
GET /healthz                health payload (calls the advertised "see SECURITY.md")
GET /api/snapshot           all four sections in one envelope
GET /api/env                mode / environment summary
GET /api/section/<name>     account | agent | risk | audit
GET /api/audit/chains       per-stream chain integrity
```

The four sections (`SECTIONS = ['account', 'agent', 'risk', 'audit']`) show
account state, agent decision activity, risk/Sentinel outcomes and the audit
chains. Every database-derived value is written with `textContent`, never
`innerHTML`. The page carries a persistent banner stating that this is
simulation only, with no real money, no live execution adapter, long-only,
cash-funded and no leverage.

---

## 10. Kill switch

The kill switch is the `emergency_stops` table plus the `EMERGENCY_STOP` control
flag. It is written by `Repos.engageStop()` and cleared by `Repos.clearStop()`,
which clears the `EMERGENCY_STOP` flag only when no active stops remain.

Shape:

- **Severities:** `WARNING`, `CRITICAL`, `CATASTROPHIC`.
- **Scopes:** `NEW_ORDERS`, `HALT_ALL`.
- **Read via** `Repos.sessionStop(mode)`, which encapsulates the mode policy
  (BACKTEST run-scoped, PAPER mode-wide) so the worker and the agent cannot
  disagree about whether a stop applies.
- **CLI:** `kill-switch` engages, `reset-stop` clears.

Two independent gates refuse when a stop is active:

- risk rule `KILL_SWITCH` (severity `CATASTROPHIC`, `latchesStop: false`), and
- Sentinel rule `KILL_SWITCH` (`BLOCK`).

The adapter also performs a last-chance check immediately before
`broker.placeOrder()` and throws `EmergencyStopError` if a stop is active, so an
order cannot slip through between the gates and the broker call.

Stops are latched automatically for:

| Trigger | Where |
|---|---|
| any rule that throws (CATASTROPHIC) | risk engine |
| a rule with `latchesStop: true` | risk engine |
| `STOP_EXIT_BLOCKED` — a breached stop could not be executed | worker tick |
| `UNHANDLED_ERROR` — an unexpected throw in the tick | worker tick |
| `STRATEGY_ERROR` | agent |

### `TRADING_HOLD` (separate from the kill switch)

`TRADING_HOLD` is an operator control set by the CLI `hold` and cleared by
`resume`. It is not an emergency stop. The Sentinel `MANUAL_HOLD` rule returns
`BLOCK` for **every** order while the flag is set. The CLI help text says
"blocks entries, allows exits", but the rule blocks exits as well. This is a
comment/help-versus-code discrepancy and is reported rather than documented as
intended.

---

## 11. Failure paths — fail-closed

Every stage refuses rather than proceeds when it cannot prove the safe answer.

| Stage | Failure | Behaviour |
|---|---|---|
| Risk rule | rule throws | converted to a CATASTROPHIC BLOCK with `latchesStop: true`; the evaluation is still persisted |
| Risk engine | `proposeOrder` or `check` throws | firewall records `FAILED` and a `risk_engine_error` event; nothing is submitted |
| Sentinel | rule or `evaluate()` throws | firewall records `FAILED` and a `sentinel_error` event; nothing is submitted |
| Sentinel | verdict `BLOCK` | order refused |
| Sentinel | verdict `REVIEW` | decision quarantined for human approval; **not** submitted |
| Adapter | build/validation failure | `BUILD_FAILED`; nothing is submitted |
| Adapter | active emergency stop | throws `EmergencyStopError`; nothing is submitted |
| Adapter | broker throws | order marked `REJECTED` with `BROKER_ERROR`; nothing else is retried |
| Adapter | broker reports duplicate | order marked `REJECTED` with `DUPLICATE_AT_BROKER` |
| Adapter | broker rejects | order marked `REJECTED` with the broker's reason |
| Broker | order carries leverage/borrow/margin/short | rejected by `MockBroker` |
| Broker | impossible fill (e.g. sell with no long) | `#fillGuard` caps or cancels before the matching engine produces it |
| Paper account | SELL with no open long | throws |
| Worker tick | any unexpected throw | recorded as FATAL, agent marked `FAILED`, `UNHANDLED_ERROR` stop latched; the loop does not crash |
| Stop enforcement | breached stop cannot be executed | `STOP_EXIT_BLOCKED` CATASTROPHIC stop latched; position stays open and is reported |
| Boot | broker connection fails | lock released, `WorkerError` thrown, process does not enter the loop |
| Boot | cash reconciliation mismatch | logged at ERROR with expected/actual/delta |
| Config | zero fees | rejected by validation |
| Config | mode `LIVE` | rejected by `env.js` |
| Config | credentials present | rejected; `loadTradingCredentials()` throws unconditionally |

The controlling principle: an unknown outcome is never treated as success. An
in-flight order whose true state is unknowable is cancelled or marked, never
resubmitted.

---

## 12. What would have to change for LIVE

This section is deliberately short. LIVE is **not** a configuration flag in this
system; it is an absence of capability. Enabling it would require, at minimum:

1. **A live broker adapter** implementing the `broker.interface.js` contract
   (`connect`, `tick`, `placeOrder`, `cancelOrder`, `getMarketData`, `candles`,
   `health`) against a real venue, with real acknowledgement and fill streams.
2. **Relaxing the paper-only gates**, all of which currently refuse by design:
   - `registerBroker` refuses any broker whose `kind !== 'PAPER'`;
   - `MockBroker`'s constructor throws in LIVE mode;
   - `env.js` throws on `TEOS_MODE=LIVE`, refuses to load credentials and
     rejects any credential presence;
   - `RiskEngine` rule `NO_LEVERAGE` and the adapter's hard-coded false flags are
     part of a long-only, cash-funded design, not an overridable switch.
3. **A schema migration.** Every table has
   `CHECK (mode IN ('BACKTEST','PAPER'))`, and `backtest_runs` has
   `CHECK (mode = 'BACKTEST')`. A `LIVE` mode would require widening those
   constraints and auditing every mode-scoped query.
4. **Reconciliation against a real broker**, not just against the local `fills`
   table: startup position and balance reconciliation with the venue, and a
   handling policy for orders the venue reports but the database does not know.
5. **A real risk and kill-switch review.** The current limits are calibrated for
   a simulated EGP 500 account. Real capital, real losses and real latency would
   need their own bounds, and the stop-latching behaviour would need to be
   re-validated against venue behaviour.
6. **An authentication and transport security review** for any non-loopback
   dashboard or control surface, and a real `SECURITY.md`.
7. **A documented operational procedure** for credentials, key rotation,
   incident response and a human on-call, none of which exist for PAPER because
   none are needed.

Until every one of those exists and is reviewed, the correct statement remains
the one at the top of this document: **Phase 1 has no live execution adapter.**
