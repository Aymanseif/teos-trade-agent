# TEOS Trade Agent — Trading Policy

What the agent is permitted to do, in which modes those permissions exist, what
the strategy has actually produced, and what an operator can do about it. This
document describes what the code does. Where a source-file comment disagrees
with the code, the code is what is documented here.

Document status: accurate to `configVersion: 1`, profile
`phase1-paper-defaults`. Limits are described in `docs/RISK_POLICY.md` and are
not repeated here except where a trading decision turns on them. Every figure in
section 3 was read from `data/teos-backtest.db` or `data/teos-paper.db`.

---

## 0. Read this first

> **NO REAL MONEY, NO REAL ACCOUNT, NO REAL VENUE.**
>
> `src/` contains no outbound HTTP client, no socket, and no venue SDK. The only
> network import in the whole of `src/` is `createServer` from `node:http` in
> the dashboard (`src/dashboard/server.js:26`) — an inbound, loopback-bound,
> read-only listener. Nothing in this repository can reach an exchange.

Four statements belong at the top of a trading document.

1. **The agent trades simulated money in a simulated venue.** The ledger is real
   in the sense that it is a real SQLite database with real rows and a real
   hash-chained audit trail. The counterparty is not real: it is
   `src/broker/mock/mock-broker.js`. `registerBroker()` throws for any broker
   whose `kind` is not `'PAPER'`
   (`src/broker/broker.interface.js:59-63`), and `MockBroker` cannot even be
   constructed in LIVE mode (`src/broker/mock/mock-broker.js:48-51`).

2. **EGP 500 is a configured paper-account ceiling.** It is
   `account.startingCapitalEgp` and `risk.maxStartingCapitalEgp` — two numbers
   in a JSON file and two integers in a simulated ledger. Nothing was deposited,
   nothing can be withdrawn, and there is no account at any venue.

3. **The strategy is currently slightly loss-making.** Across the two reference
   runs in `data/teos-backtest.db` the net result is **−EGP 3.55 on EGP 500
   (−0.71%)**, with 7 closed trades and 0 winners. Section 3 gives the full
   figures and states what they do and do not establish.

4. **This document contains no plan for live trading.** Section 1.4 states what a
   LIVE mode would require, as a boundary — the list of things that do not exist
   — and nothing more.

### Terminology

These three words are used precisely and are not interchangeable.

| Term | Meaning here |
|------|--------------|
| **PAPER** | Simulated execution against the in-process market simulator, on a real clock, in the real time. A real process, a real database, a real order lifecycle. No real money, no external venue. |
| **BACKTEST** | Replay of a generated price path through the same worker loop, the same risk engine, the same Sentinel, the same adapter, the same matching engine, into a separate database. |
| **LIVE** | Real capital at a real venue. **Not implemented.** No adapter, no credential path, no network call. `TEOS_MODE=LIVE` throws at startup (`src/core/env.js:99-110`). |

PAPER and BACKTEST differ only in the price source, the clock and the database
file. Section 1.2 gives the exact list.

---

## 1. Modes

### 1.1 The three modes, and the two that exist

| Mode | Exists | Price source | Database | Started by | CLI can select it? |
|------|--------|--------------|----------|------------|-------------------|
| `PAPER` | yes | `MarketSimulator`, seeded from `market.seed` (`20260928`), generated tick by tick in-process | `data/teos-paper.db` | `node src/cli.js worker` | yes — `config.mode`, `TEOS_MODE`, or `--mode` |
| `BACKTEST` | yes | `ReplayFeed` over a generated history, replayed against a `ManualClock` | `data/teos-backtest.db` | `node src/cli.js backtest` (alias `simulate`) | yes — `--mode`, `--ticks`, `--seed`, `--warmup` |
| `LIVE` | **no** | — | — | no command exists | **no** — refused at every layer |

`config.mode` is validated against `MODES = ['BACKTEST', 'PAPER']`
(`src/core/config.js:24, 48`), and `TEOS_MODE` is checked separately by
`readMode()`, which throws `LiveTradingDisabledError` for `LIVE` and
`ConfigError` for anything else (`src/core/env.js:99-110`).

Two commands override the mode in code rather than accepting it as an option:
`worker` and `dashboard` hard-code `{ mode: 'PAPER' }`
(`src/cli.js:103, 135`) and `backtest` hard-codes `{ mode: 'BACKTEST' }`
(`src/cli.js:147`). A `--mode BACKTEST` on the `worker` command is therefore not
possible; the only way to run a worker against the backtest database is to
construct a `Worker` directly, which is what `BacktestEngine` does.

### 1.2 What separates PAPER from BACKTEST

Everything not in this table is the same code.

| Property | PAPER | BACKTEST | Source |
|----------|-------|----------|--------|
| Worker loop | `Worker.tick()` | `Worker.tick()` | `src/worker/worker.js:341-519` |
| Risk engine | 19 ordered rules | identical | `src/risk/rules/index.js` |
| Sentinel | 14 rules | identical | `src/execution/sentinel.js` |
| Adapter, validator, matching engine, fee model, slippage model | identical | identical | `src/execution/`, `src/broker/mock/` |
| Market source | `MarketSimulator` | `ReplayFeed` | `src/broker/mock/mock-broker.js:69`; `src/backtest/engine.js:97` |
| Clock | `systemClock` | `ManualClock` at the history's start timestamp, advanced one tick per replayed tick | `src/worker/worker.js:93`; `src/backtest/engine.js:79, 108` |
| Database file | `teos-paper.db` | `teos-backtest.db` | `src/core/config.js:254-255` |
| Lock file | `teos-paper.lock` | `teos-backtest.lock` | `src/worker/worker.js:114` |
| Order-rate counting scope | whole mode | this run only | `src/worker/worker.js:586` |
| Daily-loss window scope | whole mode | this run only | `src/worker/worker.js:554-565` |
| Emergency-stop scope | mode-wide | this run only | `src/database/repositories/index.js:680-682` |
| `DECISION_RATE` counting scope | mode | this run | `src/execution/sentinel.js:391-406` |
| Resume | a `RUNNING` run is resumed with its `run_id`, cash and open positions | always a fresh run; resuming is refused | `src/worker/worker.js:145-150`; `src/backtest/engine.js:90-92` |

The run-scoped columns in BACKTEST are not a restriction on the agent. They
exist because `teos-backtest.db` is reused across runs and every run replays
from the same epoch: an unscoped daily-loss sum would carry an earlier run's
realised P&L into the next run's budget, and an unscoped stop lookup would let
one backtest halt another. PAPER keeps the wider scope deliberately, so that a
latched stop and an order-rate count survive a worker restart.

### 1.3 Mode isolation at the storage layer

| Mechanism | Effect | Source |
|-----------|--------|--------|
| 18 tables carry `mode TEXT NOT NULL CHECK (mode IN ('BACKTEST','PAPER'))` | a row stamped with any other mode is rejected by SQLite | `src/database/schema.sql` |
| `backtest_runs` carries `CHECK (mode = 'BACKTEST')` | backtest reports cannot be written under PAPER | `src/database/schema.sql:352` |
| Repositories are constructed with a mode and every query filters on it | a backtest read or write cannot reach a PAPER row | `src/database/repositories/index.js` |
| The dashboard opens the database with `{ readonly: true }` | the read-only UI cannot mutate anything | `src/dashboard/server.js:98`; `src/database/db.js:43` |
| `allowNonLoopbackBind` must be `false` or the dashboard refuses to start | the UI is not reachable from the network | `src/dashboard/server.js:83-84` |
| Every write endpoint answers `The dashboard is read-only.` | there is no write path in the API | `src/dashboard/server.js:164-170` |

### 1.4 LIVE is intentionally unavailable

This is a design boundary, not a missing feature or a disabled flag. There is
nothing in this repository that is "off" and could be switched on.

| What LIVE would require | Present? | What actually happens instead |
|------------------------|----------|-------------------------------|
| A broker provider whose `kind` is not `PAPER` | no | `PROVIDER_KINDS = ['PAPER']`, with the source comment `// LIVE is absent in Phase 1.` (`src/broker/broker.interface.js:15`). `registerBroker()` throws `ModeNotAllowedError` (`:59-63`). |
| A broker that reports `isPaper() === false` | no | `assertBrokerShape()` throws `ModeNotAllowedError` (`:51-54`). |
| A construction path for that provider | no | `MockBroker`'s constructor throws for `mode === 'LIVE'` (`src/broker/mock/mock-broker.js:48-51`). No other broker class exists. |
| Trading credentials | no | `loadTradingCredentials()` throws unconditionally; the source calls it "physically unavailable" (`src/core/env.js:139-144`). There is no code path that returns credentials. |
| Somewhere to keep credentials | no | `assertNoCredentialsPresent()` aborts the boot with `SecurityError` if any of the five credential variables, or `TEOS_DASHBOARD_TOKEN`, is populated (`src/core/env.js:19-40, 83-97`). An unused credential is treated as a latent leak. |
| Read-only market-data credentials | no | `loadMarketDataCredentials()` throws if either is set, and otherwise returns a fixed `local-simulator` descriptor (`src/core/env.js:127-137`). |
| A mode value of `LIVE` | no | `readMode()` throws (`src/core/env.js:99-110`); `MODES` does not contain it (`src/core/config.js:24`). |
| A config flag to enable it | no | `assertLiveTradingDisabled()` throws if `TEOS_LIVE_TRADING_ENABLED` is `true`, `1` or `yes`, so that a config or shell edit cannot switch on real-money execution (`src/core/env.js:112-124`). |
| A database that could hold a live order | no | every `mode` CHECK constraint excludes `LIVE` (section 1.3). |
| A second line of defence at order time | yes, and it is already live | Sentinel `MODE_GUARD` returns `BLOCK` if `mode === 'LIVE'` or the mode is not in `[PAPER, BACKTEST]` (`src/execution/sentinel.js`, rule 1). |
| A CLI command | no | the CLI has no `live` command, and its header says so: `There is deliberately no "live" command. Adding one would require writing one; its absence is the guarantee, not an oversight.` (`src/cli.js:7-9`) |
| An outbound network client | no | the only `node:http` import is the dashboard's inbound listener. |

Nothing in that table is a stub, a `TODO`, or a branch that returns early on a
flag. Each row is either an absent module or a thrown exception.

---

## 2. What the agent may do in PAPER

### 2.1 The complete list of permitted actions

The agent is one component (`src/agent/engine.js`). It reads quotes, evaluates
the active strategy, asks the risk engine to size a position, and writes a
decision record. That is the whole of it.

| # | Permitted | Bound | Source |
|---|-----------|-------|--------|
| 1 | Read the current quote for a configured instrument | only the 5 symbols in `config.instruments` | `src/agent/engine.js:232-233` |
| 2 | Read candle history and the current long for a symbol | read-only | `src/agent/engine.js:234, 240` |
| 3 | Evaluate the active strategy on a symbol | at most one decision per tick, and only when the state permits `evaluate` | `src/agent/engine.js:186-195, 366` |
| 4 | Emit one of three signals: `BUY`, `SELL`, `HOLD` | `SIGNALS` is a frozen 3-element list; anything else throws | `src/agent/strategies/strategy.interface.js:29, 55-58` |
| 5 | Ask the risk engine to size the order | the agent never computes a quantity; it records `proposal.quantity` and a `positionSizeSource` of `RISK_SIZED:<bound>` | `src/agent/engine.js:306-311, 350-352` |
| 6 | Write a sealed, hash-chained decision record | sealed by `sealDecision()`; the record is immutable once written | `src/agent/engine.js:331-364`; `src/agent/decision.js` |
| 7 | Record a `SKIP` with a stated reason instead of an order | `BELOW_MIN_QTY`, `BELOW_MIN_NOTIONAL`, `SIZE_UNAVAILABLE`, or `AGENT_STATE_<X>_FORBIDS_<ENTRY\|EXIT>` | `src/agent/engine.js:318-324` |
| 8 | Suppress a repeated signal for the same (symbol, candle, side) | a crossover is an event, not a level | `src/agent/engine.js:266-281` |
| 9 | Suppress a signal while a working order exists for that (symbol, side) | keyed on side as well as symbol, so a working SELL never blocks a stop exit | `src/agent/engine.js:110-125, 283-299` |
| 10 | Build a stop-exit decision when a stop is breached | invoked by the worker, not spontaneously; `position.quantity > 0` required | `src/agent/engine.js:398-445`; `src/worker/worker.js:372-398` |
| 11 | Read a flag written by an operator | `TRADING_HOLD`, `EMERGENCY_STOP` | `src/agent/engine.js:200` (via the risk engine) |

Everything outside that list requires code that does not exist.

### 2.2 What the agent may never do

Each row names the component that makes the thing impossible. Where a thing is
impossible because of the shape of the account rather than a check, the row says
so.

| Prohibited | Because | Enforcing component and source |
|------------|---------|-------------------------------|
| Place an order | the agent has no broker reference that can submit; the engine returns a decision to the worker | `AgentEngine` never calls `placeOrder`. `firewall.execute()` is the only caller of `adapter.submit()` (`src/execution/firewall.js:152-165`); a test asserts no other module imports `placeOrder` (`src/execution/firewall.js:28`) |
| Size its own position | sizing is the risk engine's | `RiskEngine.proposeOrder()` — `src/risk/risk-engine.js:97-199`; called at `src/agent/engine.js:306` and again inside the firewall (`src/execution/firewall.js:95-97`) so the recorded quantity is the validated quantity |
| Short, or open a position larger than the cash it pays for | the account is long-only and cash-funded; there is no margin balance to draw on | `Ledger.applyBuyFill()` throws `InsufficientBalanceError` (`src/paper/ledger.js:68-81`); `PaperAccount.applyFill()` throws `NO_POSITION_TO_SELL` (`src/paper/paper-account.js:98-105`); Sentinel `SHORT_GUARD` (`src/execution/sentinel.js`); adapter hard-codes `shortRequested: false` (`src/execution/execution-adapter.js:85-90`); validator re-checks all four flags (`src/execution/validator.js:36-42`) |
| Use leverage, margin, borrowing, futures, options or derivatives | the account has no such capability | `NO_LEVERAGE` risk rule, `CATASTROPHIC`, latches a stop (`src/risk/rules/index.js:47-59`); `RiskLimits` exposes `allowLeverage`, `allowBorrowing`, `allowShorting`, `allowDerivatives`, `allowNegativeCash` as `false` on a frozen object (`src/risk/limits.js:58-66`); `MockBroker.placeOrder()` throws on `leverageRequested`/`borrowRequested` (`src/broker/mock/mock-broker.js:467-469`) |
| Hold negative cash | the ledger refuses the fill | `Ledger.applyBuyFill()`; `NO_NEGATIVE_CASH` rule compares integer piastres (`src/risk/rules/index.js:204-215`); validator refuses notional above cash (`src/execution/validator.js:87-92`); `node src/cli.js verify` re-derives it from the fill log (`scripts/verify.js:198`) |
| Open an entry without a stop | a stop is mandatory by configuration, not by preference | `validateConfig()` throws unless `risk.stopLossRequired === true` (`src/core/config.js:91-93`); `STOP_CONDITION` blocks a missing or inverted stop (`src/risk/rules/index.js:415-450`); Sentinel `STOP_REQUIRED` blocks independently (`src/execution/sentinel.js`, rule 13) |
| Enforce a stop without going through the pipeline | a stop is an order, not a setting | `buildStopExitDecision()` builds a first-class `Decision` (`src/agent/engine.js:398-445`) and the worker passes it to `firewall.execute()` (`src/worker/worker.js:403-411`). There is no second path from "stop breached" to "position closed". |
| Trade on stale, missing or non-positive data | fail closed | `DATA_FRESHNESS` (`src/risk/rules/index.js:130-149`), `PRICE_SANITY` (`:150-178`), `CONNECTION` (`:107-129`); all latching |
| Exceed the exposure, position, per-trade or daily-loss caps | the limits | `EXPOSURE`, `POSITION_SIZE`, `RISK_PER_TRADE`, `DAILY_LOSS`, `MIN_NOTIONAL`, `MAX_CAPITAL` — see `docs/RISK_POLICY.md` section 4 |
| Submit the same decision twice | one decision produces at most one order, across any number of restarts | `clientOrderId` is a deterministic hash of `decisionId` (`src/core/ids.js`) and `orders.client_order_id` is `UNIQUE`; `DUPLICATE_ORDER` in the risk rules (`src/risk/rules/index.js:451-463`) and in the Sentinel; the adapter's pre-submission lookup (`src/execution/execution-adapter.js:110-119`); `IdempotencyGuard` (`src/worker/idempotency.js:24-52`); `reconcileInFlight()` never resubmits anything (`:66-111`) |
| Trade while a stop is latched or a hold is set | three independent gates | `KILL_SWITCH` is rule 2 of the risk rules (`src/risk/rules/index.js:63-70`); Sentinel `KILL_SWITCH` and `MANUAL_HOLD` (`src/execution/sentinel.js`, rules 2 and 5); the adapter re-checks `sessionStop()` immediately before the broker call (`src/execution/execution-adapter.js:121-138`); `AgentEngine.evaluateOnce()` returns `EMERGENCY_STOP_ACTIVE` before producing a decision at all (`src/agent/engine.js:197-210`) |
| Trade while it does not know what state it is in | fail closed | `AGENT_STATE` blocks on an undefined state or a missing permission matrix (`src/risk/rules/index.js:72-103`); `permissionsFor()` returns all-`false` for an unrecognised state (`src/agent/state.js:51-54`) |
| Trade in `WARMUP`, `HALTED`, `STOPPED`, `FAILED` or `STARTING` | those states have `evaluate: false` | the permission matrix, `src/agent/state.js:41-49`; the agent returns before building a decision (`src/agent/engine.js:186-195`) |
| Open a new position in `DEGRADED` | a degradation must not be compounded | `DEGRADED` has `openPosition: false, reduceOnly: true` (`src/agent/state.js:45`); `AGENT_STATE` blocks the BUY on `permissions.openPosition !== true` |
| Raise a risk limit | the limits are frozen and the agent has no write path | `RiskLimits` is `Object.freeze`d at construction (`src/risk/limits.js:58-66`); the agent receives `config` read-only and never writes it |
| Retry, amend or cancel anything | no retry exists | a broker error becomes `REJECTED` with reason `BROKER_ERROR` and no retry (`src/execution/execution-adapter.js:166-176`); the risk engine's rule loop breaks on the first BLOCK and does not re-evaluate |
| Connect to anything | there is no outbound client | the only `node:http` import is the dashboard's inbound listener (`src/dashboard/server.js:26`) |
| Read a credential | no credential path exists | `assertNoCredentialsPresent()` (`src/core/env.js:83-97`); `loadTradingCredentials()` throws (`src/core/env.js:139-144`) |
| Write to the database outside the repositories | the repository layer is the only writer | `src/database/repositories/index.js`; the dashboard's connection is `readonly` (`src/dashboard/server.js:98`) |

### 2.3 Why each policy choice is the way it is

The reasons are in the source comments; they are collected here because a
trading policy that lists rules without reasons gets edited for the wrong
reasons.

| Policy choice | Reason, as stated in the code |
|---------------|--------------------------------|
| The agent proposes and the risk engine sizes | `The agent cannot invent a size the risk engine has not bounded` (`src/agent/engine.js:301-305`). A single sizing function runs twice — once for the record, once for the validated order — so the audit row cannot disagree with what was submitted. |
| One decision per tick | the tick is the decision budget. `#buildDecision` returns after the first signal (`src/agent/engine.js:366`). The comment at `src/agent/engine.js:16` attributes this to `worker.maxDecisionsPerTick`; that key is not read (see section 5.2). |
| A signal fires once per candle, not once per tick | `A signal is an EVENT, not a level. A crossover observed at tick 1 of a 30-tick candle is still the same crossover at tick 29` (`src/agent/engine.js:266-271`). |
| Working orders are keyed on (symbol, side) | `a cap on new exposure must never trap existing risk, so a working SELL must not block a stop-loss exit, and a working BUY must not block one either` (`src/agent/engine.js:110-112`). |
| Long-only, cash-funded | a position is only as large as the cash on hand; there is no margin balance to draw on and a short cannot exist, so there is nothing to owe (`docs/RISK_POLICY.md` section 2.2). |
| A stop is mandatory on every entry | a position with no defined invalidation point has no bounded risk. The config refuses to boot without it (`src/core/config.js:91-93`). |
| A stop must sit inside a distance band | `a stop inside ordinary tick noise is not a risk control`; a position sized to a loss it can never reach is not a bounded risk (`src/agent/strategies/strategy.interface.js:79-80`). |
| Caps on new exposure exempt exits | exposure is marked to market and drifts; refusing the sell that shrinks it would make the breach permanent (`src/risk/rules/index.js`; `docs/RISK_POLICY.md` section 4.4). |
| Backtest and paper share the pipeline | `A backtest that skipped those steps would report numbers the paper trader could never reproduce, which is worse than reporting nothing` (`src/backtest/engine.js:11-14`). |
| BACKTEST counters are run-scoped | every backtest replays from the same epoch, so an unscoped count would make the second run trip the daily order limit on its first order (`src/worker/worker.js:582-586`). |
| The agent restarts from `STARTING` after a process restart | the previous state is history, not a live state; a run that was `HALTED` or `FAILED` is resumed by re-deriving health, not by pretending to still be in that state. The emergency-stop table is what actually gates trading (`src/worker/worker.js:274-280`). |
| Cold start does not adopt orphan positions | the new run has its own EGP 500 and cannot fund them; the reset is recorded as a `WARN` event rather than done silently (`src/worker/worker.js:218-233`). |
| The Sentinel is a second line, not a first | it can never widen anything the risk engine limited, because `RISK_VERDICT` returns `BLOCK` whenever the risk engine blocked (`src/execution/sentinel.js`, rule 3). |

---

## 3. The active strategy and where it stands

### 3.1 What is running

| Setting | Value | Source |
|---------|-------|--------|
| `strategies.active` | `sma_cross` | `config/default.json:108` |
| `strategies.enabled` | `["sma_cross", "rsi_reversion", "donchian_breakout"]` | `config/default.json:107` |
| Registered strategies | all three, unconditionally, at import time | `src/agent/strategies/registry.js:27` |
| Instruments | `USD/EGP`, `EUR/EGP`, `GOLD/XAU`, `SILVER/XAG`, `TEOS/IDX` | `config/default.json:138-194` |
| `sma_cross` parameters | `fastPeriod` 10, `slowPeriod` 30, `atrPeriod` 14, `stopAtrMultiple` 1.5, `riskPctPerTrade` 0.5, `minConfidence` 0.3 | `config/default.json:110-117` |
| `rewardMultiple` | `1.5` — from `smaCross.defaultParams`, not from the config block | `src/agent/strategies/sma_cross.js:25` |
| `minBars` | `40`; the agent holds off until 40 candles exist for a symbol | `src/agent/strategies/sma_cross.js:19`, `src/agent/engine.js:235-239` |
| Entry | fast SMA crosses above slow SMA; stop at `price − 1.5 × ATR`, clamped into the policy band | `src/agent/strategies/sma_cross.js:61-82` |
| Exit | fast SMA crosses below slow SMA, and only if a long is held | `src/agent/strategies/sma_cross.js:84-104` |
| Market simulator seed | `20260928` | `config/default.json:56` |

`strategies.enabled` is validated (non-empty, and `active` must appear in it —
`src/core/config.js:188-193`) and is displayed on the dashboard
(`src/dashboard/api.js:207`). No trading component reads it. The registry
registers all three strategies regardless, and `--strategy` will select any of
them (`src/agent/engine.js:60, 81-82`). Editing `enabled` does not restrict what
can be traded; only `active` and the `--strategy` option do.

The strategy's own header states its standing without hedging
(`src/agent/strategies/sma_cross.js:5-10`): `It has no demonstrated edge in any
market; it is included to exercise the strategy interface, the sizer and the full
risk pipeline end to end.` The `confidence` value it emits is documented as
`a heuristic score, NOT a probability of profit`
(`src/agent/strategies/strategy.interface.js:15, 24-26`).

### 3.2 The reference runs

Two runs are stored in `data/teos-backtest.db`. They are byte-identical because
they replay the same seed over the same path.

| Field | Value |
|-------|-------|
| Backtest ids | `bt_01M3NBMCVATKQ2GYNSDR`, `bt_01M3NBPT15EAAFNP8V6P` |
| Run ids | `run_01M3NBJF0VZRGNN1GZ9Q`, `run_01M3NBMRPM9XZ7Q99KE7` |
| Strategy, parameters, seed | `sma_cross`; `fastPeriod` 10, `slowPeriod` 30, `atrPeriod` 14, `stopAtrMultiple` 1.5, `riskPctPerTrade` 0.5, `minConfidence` 0.3; seed `20260928` |
| Span | `2025-01-01T00:00:00.000Z` to `2025-01-01T00:41:40.000Z`; 2500 bars; `elapsedMs` 2,500,000 (≈41.7 min of simulated time) |
| Agent state log | `STARTING → WARMUP` (00:00:00) `→ HEALTHY` (00:20:00) `→ STOPPED` (00:41:40) |
| Status | `COMPLETED` |

**Result, identical in both runs.**

| Measure | Value |
|---------|-------|
| Starting capital | EGP 500.00 |
| Final equity | **EGP 496.45** |
| Net P&L (equity-based) | **−EGP 3.55 (−0.71%)** |
| of which closed trades | −EGP 3.47 |
| of which still open | −EGP 0.08 |
| Gross P&L before costs | **−EGP 0.05** |
| Fees paid | EGP 2.45 |
| Slippage cost | EGP 1.05 (pnl_events `SLIPPAGE` sums to −1.0452) |
| Total trading cost | EGP 3.50 |
| Closed trades | 7 — **0 wins, 7 losses, 0 flat** |
| Win rate | 0.00% |
| Gross profit / gross loss | EGP 0.00 / EGP 3.47 |
| Profit factor | 0.000 |
| Expectancy per trade | −EGP 0.50 |
| Largest single loss | −EGP 0.66 |
| Average hold | 176,571 ms ≈ 2 min 57 s |
| Observations | 251, sampled every 10,000 ms |
| Max drawdown | EGP 3.56 (0.71% of peak) |
| Max losing streak | 12 periods |
| Per-period Sharpe | −0.151504 |
| Per-period Sortino | −0.233535 |
| Annualised Sharpe, Sortino, volatility, CAGR | `null` — the span is 41.7 minutes, under the 30-day `MIN_ANNUALISABLE_DAYS` floor (`src/backtest/metrics.js:111, 239`) |

**Pipeline activity, identical in both runs.**

| Stage | Count |
|-------|-------|
| Agent decisions | 18 (9 `PLACE_ORDER` BUY, 7 `PLACE_ORDER` SELL, 2 `SKIP` BUY) |
| Risk evaluations | 18 — 16 `ALLOW`, 2 `BLOCK` |
| Both blocks | `ORDER_VALID`, `Quantity must be positive (got 0)` — a proposal the sizer had already reduced to nothing |
| Sentinel verdicts | 16 — 12 `ALLOW`/`PASS`, 4 `WARN`/`PASS_WITH_WARNING` |
| All four warnings | `EXPOSURE_PRESSURE`, `Projected exposure is at 99.9% of the cap` (the `80%` warn band, `src/execution/sentinel.js`, rule 11) |
| Orders submitted | 16, all `FILLED` |
| Fills | 33 (20 BUY, 13 SELL) |
| Quarantined | 0 |
| Emergency stops | 0 |
| Balance rows | 2501 per run |

Final book: cash EGP 246.91, exposure EGP 249.55, realised −EGP 1.02,
unrealised −EGP 0.06, 2 open positions — `TEOS/IDX` 0.1 @ 1250.50 and
`SILVER/XAG` 2.62 @ 47.54.

### 3.3 What those figures establish, and what they do not

Stated plainly, because a −0.71% line is easy to misread in either direction.

| The figures do establish | The figures do not establish |
|-------------------------|-----------------------------|
| The whole pipeline runs end to end and produces a complete, linked audit record: 18 decisions, 18 risk verdicts, 16 Sentinel verdicts, 16 orders, 33 fills, zero unhandled errors. | That the strategy works. It lost EGP 3.55 and won none of its 7 closed trades. |
| The risk limits were live and were reached: projected exposure hit 99.9% of the EGP 250.00 cap four times and the Sentinel warned on each. No limit was breached; the sizer kept every order inside the envelope. | Anything about a real market. The price path is generated by a seeded simulator and then replayed; it is not a capture of any instrument. |
| Costs dominate the loss: gross P&L before costs was −EGP 0.05, and the EGP 3.50 of fees and slippage turned it into −EGP 3.55. | That the strategy would be profitable with cheaper execution. That is a hypothesis about a cost model, not a measured result. |
| Drawdown stayed inside the envelope: EGP 3.56 peak-to-trough, against a EGP 25.00 daily loss limit. | That the risk limits are appropriate. They bound the damage; they do not improve the decision. |
| — | Any forward expectation. 41.7 minutes of one path, 7 trades, one seed. `compareRuns()` in `src/backtest/report.js:167-193` deliberately reports the **spread** across runs rather than a winner, for exactly this reason. |

The report module states the same caveat in its own output, and
`toBacktestSummary()` carries `isProfitabilityClaim: false` as a field
(`src/backtest/report.js:17-23, 157`).

### 3.4 The PAPER database as it stands

Read from `data/teos-paper.db` at the time of writing. This is the state an
operator finds on arrival, and it is the worked example for section 4.

| Field | Value |
|-------|-------|
| Run | `run_01M3NBR3YASHBMC28HA4`, status `RUNNING`, strategy `sma_cross`, started `2026-09-29T01:16:28.495Z` |
| Emergency stops | one, `stop_01M3NBQJVJ0DX9RZW68J`, trigger `OPERATOR_KILL_SWITCH`, severity `CRITICAL`, scope `NEW_ORDERS`, **`active = 1`** |
| `control_flags` | `EMERGENCY_STOP = 'true'` |
| `TRADING_HOLD` | **absent** — no row, so `isFlagSet` returns its `'false'` default |
| Latest balance | cash EGP 500.00, equity EGP 500.00, exposure EGP 0.00, 0 open positions, 0 fees, 0 slippage |
| Decisions / orders / fills / positions | 0 / 0 / 0 / 0 |
| Ticks recorded at the last heartbeat | 287; last heartbeat `agent_state` `WARMUP`, status `HALTED` |
| Balance rows, snapshots, heartbeats | 290, 1455, 58 |

Three things follow, and all three matter to an operator:

1. **The agent has never traded on PAPER.** 287 ticks produced 0 decisions
   because the agent never left `WARMUP`: leaving it requires 40 candles for
   **every** one of the five instruments (`src/worker/worker.js:543-546`), and
   287 ticks at 30 ticks per candle is about 9 candles each.
2. **The heartbeat reads `HALTED` purely because the stop is latched.** The
   agent state is `WARMUP`; `Heartbeat.#resolveStatus()` returns `HALTED` if
   `sessionStop()` is non-null, before it looks at the agent state at all
   (`src/worker/heartbeat.js:95-108`).
3. **The run row still says `RUNNING` while no process is alive.** The process
   was killed rather than shut down cleanly, so no shutdown record was written.
   `node src/cli.js health` will report the last heartbeat as `STALE` once it is
   older than 30,000 ms (`src/worker/heartbeat.js:123-128`) and exit non-zero.

---

## 4. Operator actions

### 4.1 The command surface

`node src/cli.js <command>`. Every command is safe to run and none can place an
order. `status`, `health`, `kill-switch`, `reset-stop`, `hold`, `resume` and
`verify` all accept `--mode BACKTEST|PAPER` and default to `PAPER`.

| Command | Reads | Writes | What it is for |
|---------|-------|--------|----------------|
| `worker` | — | the mode's database | Runs the trading loop in the foreground. Forced to `PAPER`. Handles `SIGINT`/`SIGTERM` by shutting down cleanly (`src/cli.js:117-127`). |
| `dashboard` | the mode's database, `readonly` | nothing | Read-only HTTP view on `127.0.0.1:8787`. Forced to `PAPER`. |
| `backtest` | generates its own price path | `teos-backtest.db` | Replays and reports. Accepts `--ticks` (default 4000), `--seed`, `--warmup`, `--strategy`, `--json`. Forced to `BACKTEST`. |
| `simulate` | as `backtest` | as `backtest` | Alias with `--ticks` default 2000 (`src/cli.js:165-171`). **Registered but absent from the `help` text** (`src/cli.js:68-97`). |
| `status` | balance, positions, stop, hold, heartbeat, audit chains | nothing | The first thing to run. Also verifies the four hash chains (`src/cli.js:236-239`). |
| `health` | heartbeat probe, stop, last 10 `ERROR`/`FATAL` events | nothing | Liveness. **Exits 1 if the probe is not alive** (`src/cli.js:279`). |
| `kill-switch` | — | `emergency_stops` + `control_flags.EMERGENCY_STOP` + a `WARN` event | Latch a stop. `--reason`, `--trigger` |
| `reset-stop` | active stop | `emergency_stops.active = 0` + `cleared_by`/`cleared_at` + a `WARN` event | Clear the stop. Prints `clearing a stop does not resolve its cause` (`src/cli.js:322`). |
| `hold` / `resume` | — | `control_flags.TRADING_HOLD` + a `WARN` event | Set/clear the hold flag. `--reason`, `--off` |
| `verify` | the whole mode database | nothing | Nine integrity checks. **Exits 1 on any failure** (`src/cli.js:355`). |

`verify` runs these checks (`scripts/verify.js`): the equity invariant
(`equity = cash + exposure`), cash reconstructed exactly from the fill log,
orders and fills agreeing, positions reconciling with their fills, no orphan
fills, the audit chain intact for all four streams, no duplicate
`client_order_id` ever submitted, cash never negative, equity never exceeding
EGP 500, no `ERROR`/`FATAL` events, and every order carrying decision, risk and
Sentinel records.

### 4.2 The two freezes, and how they differ

`kill-switch` and `hold` both stop new orders. They stop them at different
points, and the difference is the reason to prefer one over the other.

| | `kill-switch` | `hold` |
|---|---|---|
| Written to | `emergency_stops` row + `EMERGENCY_STOP` control flag | `TRADING_HOLD` control flag only |
| Read by | `KILL_SWITCH` risk rule (position 2); Sentinel `KILL_SWITCH`; the adapter's pre-broker check; `AgentEngine.evaluateOnce()` persistence gate; `Heartbeat.#resolveStatus()`; `status`; `health` | Sentinel `MANUAL_HOLD` only |
| Are decisions still produced? | **No.** `evaluateOnce()` returns `EMERGENCY_STOP_ACTIVE` before the strategy runs (`src/agent/engine.js:197-210`) | **Yes.** The strategy evaluates, the risk engine runs and writes its verdict, and the Sentinel then blocks |
| Heartbeat status | becomes `HALTED` | unchanged |
| Refuses a stop exit? | Yes, by the `KILL_SWITCH` rule | Yes, by `MANUAL_HOLD` |
| Survives a worker restart | Yes — in PAPER the stop is mode-scoped (`src/database/repositories/index.js:680-682`) | Yes — the flag is mode-scoped (`src/database/repositories/index.js:691-699`) |
| Cleared by | `reset-stop` | `resume` |

Both refuse **every** order, including risk-reducing exits. The CLI help text
(`src/cli.js:81`) and `hold`'s own output (`src/cli.js:337`) both say
`blocks entries, allows exits` and `Risk-reducing exits are still allowed`. That
is wrong: Sentinel `MANUAL_HOLD` returns `BLOCK` for every order. The same
error appears in `docs/ARCHITECTURE.md`. This document follows the rule.

The practical difference is visibility. `hold` lets the pipeline run and refuses
at the last gate, so `agent_decisions` and `risk_decisions` rows keep
accumulating and an operator can see what the agent *would* have done while
frozen. `kill-switch` suppresses decision generation entirely, so the audit
trail goes quiet. Use `hold` when the question is "what is it trying to do";
use `kill-switch` when the answer does not matter and everything should stop
now.

### 4.3 Neither freeze touches an open position

There is no CLI command that closes a position, and no CLI command that cancels
an order. `ExecutionAdapter.cancel()` exists and its comment says `Exposed for
the CLI (e.g. flatten on demand)` (`src/execution/execution-adapter.js:225-226`),
but no command in `src/cli.js` calls it.

| Open position situation | What the code does | What the operator can do |
|-------------------------|--------------------|--------------------------|
| Stop not breached | the position stays open until the strategy emits a `SELL`, i.e. until a fast/slow SMA cross down (`src/agent/strategies/sma_cross.js:84-104`) | nothing directly. A `hold` or `kill-switch` prevents the exit from executing. |
| Stop breached, nothing engaged | the worker builds a stop-exit decision on the very next tick and submits it through the firewall (`src/worker/worker.js:372-411`) | wait, or engage nothing |
| Stop breached, **hold or kill-switch engaged** | the exit decision is still built — worker step 4 does not consult the kill switch before submitting — and the firewall refuses it. The worker then latches a `STOP_EXIT_BLOCKED` `CATASTROPHIC` stop and records a `FATAL` event, leaving the position open (`src/worker/worker.js:427-440`) | clear the stop and let the exit execute, or accept the position stays open |
| Exit already working for that symbol | no second exit is built; an `INFO` event names the working order (`src/worker/worker.js:387-396`) | nothing; the working order is the venue's to fill |

**The consequence worth stating plainly: engaging `kill-switch` does not
de-risk the book, and if a stop is already breached it will, on the next tick,
record a second `CATASTROPHIC` stop for a condition the kill switch itself
created.** Inspect open positions with `status` *before* engaging either freeze.

### 4.4 In-flight orders

An order is live at the venue from acceptance until `FILLED`, `CANCELED` or
`REJECTED`. `AgentEngine.workingOrder()` reads that from the broker, not from a
local flag, precisely because only the venue's book knows
(`src/agent/engine.js:95-108`).

| Situation | Behaviour | Source |
|-----------|-----------|--------|
| A MARKET order is accepted but not yet filled | it fills during the **next** `broker.tick()`, and may fill only partially | `src/agent/engine.js:100-108` |
| The process dies with an order in flight | `reconcileInFlight()` runs at boot, **before** the loop can create new orders. No fills → `CANCELED` with reason `RECOVERED_UNFILLED_AFTER_RESTART`; complete → `FILLED`; partial → `CANCELED` for the remainder with the filled part standing. **Nothing is ever resubmitted.** | `src/worker/worker.js:200-202`; `src/worker/idempotency.js:66-111` |
| Recovery is reported | a `WARN` event with per-order resolution, and the details are stored on the restart record and returned by `worker.health().recovery` | `src/worker/idempotency.js:102-110`; `src/worker/worker.js:253-260` |
| The same decision is submitted twice | refused at four independent points and impossible at the fifth (`orders.client_order_id` is `UNIQUE`) | see section 2.2 |
| Cash does not reconcile with the fill log at boot | an `ERROR` event records expected, actual and delta. **The worker still starts.** | `src/worker/worker.js:204-216` |
| Two processes open the same database | a lock file prevents it; a lock older than `lockStaleAfterMs` is reclaimed and the takeover is recorded | `src/worker/worker.js:114, 138`; `src/worker/lock.js` |

The one class of in-flight problem this design cannot resolve is an order whose
true state is unknowable. It is left visibly `UNKNOWN` rather than guessed at,
and the design comment is explicit that resubmitting a possibly-live order is
`precisely the mistake this function exists to prevent`
(`src/worker/idempotency.js:56-64`).

### 4.5 Runbook: responding to an unexplained stop or an open loss

This is the order the code supports, not a preferred workflow. Steps 1 and 2
are read-only and should always precede any write.

| Step | Command | Why it comes here |
|------|---------|-------------------|
| 1 | `node src/cli.js status` | Establishes what is engaged (`emergency stop`, `trading hold`), what is open, the cash and equity, and whether all four audit chains verify. Nothing is written. |
| 2 | `node src/cli.js health` | Separates "the agent is halted" from "the process is dead". A `STALE` probe with a `HALTED` status means the worker is gone, not merely stopped. Exits 1 if not alive. |
| 3 | `node src/cli.js status` again, and read the open positions | **Before engaging anything.** Section 4.3: a freeze on a breached stop produces a second `CATASTROPHIC` stop. |
| 4 | `node src/cli.js kill-switch --reason "<what you see>"` | Stops decision generation and every order. `--reason` is written onto the stop row and into the `WARN` event, so the record explains itself later. Use `hold --reason ...` instead if you want the decision and risk records to keep accumulating. |
| 5 | `node src/cli.js verify` | Establishes whether the database is self-consistent before you draw conclusions from it. Exits 1 on failure. Checks cash reconstruction, position reconciliation, duplicate `client_order_id`, negative cash and the audit chains. |
| 6 | Read the specific stop's `reason` and `details_json`; read the `FATAL`/`ERROR` events `health` printed | The `reason` names the condition. The `details_json` carries the numbers. A stop that was latched by the risk engine has the same `reason` text as the rule that produced it. |
| 7 | Resolve the cause | The `reset-stop` output says it plainly: `clearing a stop does not resolve its cause` (`src/cli.js:322`). For a `DAILY_LOSS` or `EXPOSURE` stop the cause is the account, and the next tick will re-latch it if the condition still holds. |
| 8 | `node src/cli.js reset-stop`, then `node src/cli.js resume` if a hold is set | `reset-stop` clears the most recent active stop and reports how many remain (`src/cli.js:355-323`). It is safe to run when nothing is engaged: it prints `No active emergency stop.` |
| 9 | `node src/cli.js status` | Confirm the stop and the hold are both clear and the audit chains still verify. |

Restarting the worker is a separate decision and is not part of the runbook: a
`RUNNING` run row is resumed with its `run_id`, its cash and its open positions
(`src/worker/worker.js:145-179`), and a fresh `STARTING` state machine is built
from the current broker and data
(`src/worker/worker.js:274-287`). A cold start does **not** adopt positions left
`OPEN` by an earlier run; it records a `WARN` naming them
(`src/worker/worker.js:218-233`). That asymmetry is why restarting is not a
remedy for a stuck run.

### 4.6 The two controls, side by side

| | Trading hold | Emergency stop |
|---|---|---|
| Set by | `node src/cli.js hold` | the risk engine, the worker, the agent, or `node src/cli.js kill-switch` |
| Stored in | `control_flags.TRADING_HOLD` | `emergency_stops` + `control_flags.EMERGENCY_STOP` |
| Scope | mode-wide | mode-wide in PAPER; run-scoped in BACKTEST |
| Survives restart | yes | yes, if the run is resumed |
| Blocks entries | yes | yes |
| Blocks exits | **yes** (`MANUAL_HOLD`) | **yes** (`KILL_SWITCH`, rule 2) |
| Latches a second stop | no — it is a flag, not a stop | it is the stop |
| Cleared by | `resume` | `reset-stop` |
| Appears in `status` | `trading hold ON` | `emergency stop ENGAGED (<trigger>)` |

Neither one is scoped by `emergency_stops.scope`. `HALT_ALL` and `NEW_ORDERS`
are recorded, and both `KILL_SWITCH` rules block on `engaged` alone
(`src/risk/rules/index.js:63-70`; `src/execution/sentinel.js` rule 2), so the
`CATASTROPHIC`/`HALT_ALL` versus `CRITICAL`/`NEW_ORDERS` distinction is carried
in the record rather than in behaviour. `docs/RISK_POLICY.md` section 6.4 has
the full detail.

### 4.7 What an operator cannot do

| Not available | Consequence |
|---------------|-------------|
| Place an order by hand | There is no such command and no such code path. The only order producer is the strategy, through the firewall. |
| Close a position by hand | `ExecutionAdapter.cancel()` is documented as CLI-exposed and is not. A position closes when the strategy says so or when its stop is breached. |
| Cancel a working order | `MockBroker.cancelOrder()` exists (`src/broker/mock/mock-broker.js:487-495`) and is not reachable from the CLI. A working order resolves on the next `broker.tick()`. |
| Edit a risk limit at runtime | Limits are read from `config/default.json` at boot and frozen into `RiskLimits` (`src/risk/limits.js:58-66`). Changing them requires editing the file and restarting. |
| Approve a quarantined decision | The Sentinel `REVIEW` verdict writes a `REVIEW_PENDING` flag naming the decision (`src/execution/sentinel.js:370-376`) and the order is not submitted. Nothing reads that flag to release it. There is no approval path. |
| Change the active strategy at runtime | `AgentEngine.setStrategy()` exists (`src/agent/engine.js:81-93`) but no CLI command calls it. `--strategy` sets it for one process at boot. |
| Retroactively clear an audit record | Every record is hash-chained (`prev_hash`/`record_hash`) and `node src/cli.js status` verifies all four chains. |
| Trade on the backtest database with a live worker | `worker` hard-codes `mode: 'PAPER'` (`src/cli.js:103`). |

---

## 5. What this policy does not cover

### 5.1 Stated explicitly

| Not covered | Why |
|-------------|-----|
| Whether the strategy is profitable | It is not, on the only reference runs that exist: −EGP 3.55, 0 of 7 trades profitable (section 3.2). |
| Any real-market behaviour | The price path is a seeded random process. There is no venue, no latency, no order-book depth, no partial-fill reality, no reject codes, no session boundaries, no halts, no gaps beyond `market.maxTickJumpBps`. |
| Liquidity and market impact | Fills are produced against a single mid-derived price with a modelled spread and a modelled slippage, against a fixed `liquidityProxyEgp` of 250,000 (`src/broker/mock/mock-broker.js:71`). That proxy is four orders of magnitude above this account's exposure cap, so the slippage model is effectively operating in its constant-base regime. |
| Correlated or concentrated positions | The exposure cap is a notional cap across all symbols. `maxOpenPositions` is a count. There is no correlation model and no sector limit. |
| Overnight or gap risk | The path is generated tick by tick. There are no gaps. |
| Drawdown control | Drawdown is measured and reported (`src/paper/pnl.js:102-114`) but no rule in the risk engine treats it as a limit. |
| Operational risk | Backup and restore of the database files, host security, disk exhaustion, and dashboard access control are outside the trading policy. The dashboard binds to loopback and refuses a non-loopback bind. |
| Model risk in the limits themselves | The per-trade and daily limits are set for a simulated EGP 500 account and are not calibrated against any model. |
| The dashboard as a control surface | It is read-only. It can show a latched stop; it cannot clear one. |
| Anything a process other than this code wrote | `verify` re-derives quantities from raw rows rather than trusting the agent, but it reads the same database. |

### 5.2 Configured but not enforced

These settings pass `validateConfig()` and are compared by nothing. They are
listed so that section 2 and section 3 are not read as a wider policy than
exists. `docs/RISK_POLICY.md` section 9 has the full list with the same caveat;
the two entries that bear directly on *trading behaviour* are repeated here.

| Setting | Configured | Actual effect |
|---------|-----------|---------------|
| `strategies.enabled` | three ids | None on trading. Validated and displayed only (`src/core/config.js:188-193`; `src/dashboard/api.js:207`). The registry registers all three regardless. |
| `worker.maxDecisionsPerTick` | `1` | None. `src/agent/engine.js:16` attributes one-decision-per-tick to this key; the worker never reads it. The behaviour is real — `#buildDecision` returns after the first signal (`src/agent/engine.js:366`) — but it is not this setting. |
| `market.warmupCandles` | `60` | None. Warm-up is decided by the strategy's `minBars` against the candle count held in the broker (`src/worker/worker.js:543-546`). |
| `execution.fillLatencyMs` | `120` | None. Fills are produced during the next `broker.tick()` with no latency term. |
| `risk.haltCooldownMs` | `60000` | None. `AgentEngine.scheduleCooldown()` (`src/agent/engine.js:372-376`) has no caller, so the `HALT_COOLDOWN` gate at `:213-222` never trips. |
| `fees.settleFeeInCash`, `slippage.applyToMarketOrders` | `true`, `true` | None, and none is validated. Both behaviours are unconditional. |
| `worker.heartbeatIntervalCycles`, `worker.autoResetDailyLossAtUtcMidnight` | `5`, `true` | None, and neither is validated. The heartbeat interval is `worker.heartbeatMs`; the daily rollover is unconditional. |
| `sentinel.freshnessWarnPctOfLimit` | `60.0` | None. No Sentinel rule reads it; `DATA_FRESHNESS` uses `degradedDataFreshnessMs` in milliseconds. |

`execution.rejectsUnknownSymbol` looks similar and **is** used, at
`src/broker/mock/matching-engine.js:131`.

### 5.3 Comments in the source that disagree with the source

Listed because a reader who trusts a comment will get a different answer from a
reader who runs the code. This document follows the code in every case.

| Source | What it says | What it does |
|--------|--------------|--------------|
| `src/execution/firewall.js:13` | `RISK ENGINE (15 ordered rules)` | There are 19 (`src/risk/rules/index.js:45-464`). |
| `src/cli.js:81` and `src/cli.js:337` | `hold` "blocks entries, allows exits" | Sentinel `MANUAL_HOLD` blocks every order, including exits. Already noted in `docs/ARCHITECTURE.md` and in `docs/RISK_POLICY.md` section 8.5. |
| `src/agent/state.js:24-26` | `The risk engine's AGENT_STATE rule blocks any order unless the state is exactly HEALTHY` | The rule consults the permission matrix, which permits exits in `DEGRADED` and `HALTED` (`src/risk/rules/index.js:88-101`; `src/agent/state.js:45-46`). No comparison against `'HEALTHY'` exists. In practice `HALTED` cannot evaluate at all, so no exit is ever built there, but the rule as written is not an `=== 'HEALTHY'` test. |
| `src/agent/engine.js:16` | one decision per tick is `maxDecisionsPerTick` | the key is never read (section 5.2). |
| `src/execution/execution-adapter.js:225` | `Exposed for the CLI (e.g. flatten on demand)` | No CLI command calls it. |
| `src/paper/pnl.js:7-9` | realised P&L is `NET of nothing` | `src/backtest/metrics.js:150-155` `tradeNetPnl` subtracts fees and slippage. `portfolioPnl` returns `totalPnlEgp` and `netPnlAfterCostsEgp` computed identically (`src/paper/pnl.js:81-82`), so the two columns are equal rather than one being gross. |
| `src/agent/state.js:9` | a diagram showing `HALTED` returning to `HEALTHY` on cooldown expiry | `scheduleCooldown()` is never called (section 5.2). The actual recovery path is `applyHealth()`, which moves `HALTED → DEGRADED` on the next tick the health checks pass (`src/agent/state.js:129-137`). |
| `docs/ARCHITECTURE.md:221-222` | `MockBroker` rejects orders whose leverage/borrow/margin/short flags are "not literally false" | `placeOrder` checks only `leverageRequested` and `borrowRequested` (`src/broker/mock/mock-broker.js:467-469`). The other two are checked by the validator only. Moot in practice: the adapter is the sole caller and hard-codes all four (`src/execution/execution-adapter.js:85-90`). |
