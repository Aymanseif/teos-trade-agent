# TEOS Trade Agent — Operator Runbook

Phase 1. What a human does, in what order, when something goes wrong.

Every command in this document was read out of `src/cli.js`, `package.json`,
`scripts/verify.js` or the dashboard source before it was written here. Where
this document and the code disagree, the code is what is described and the
disagreement is listed in section 11. If a command is not in this document, it
was not verified and you should not type it.

---

## 0. Read this first

> **PHASE 1 HAS NO LIVE EXECUTION ADAPTER.**
>
> There is no component in this repository that can place an order on a real
> exchange or with a real broker. The only broker that exists is an in-process
> paper-exchange simulator. The process refuses to start in `LIVE` mode, the
> environment layer refuses to load credentials, and the database schema has no
> `LIVE` value to write.

Three more statements belong in the same place.

1. **The strategy is currently slightly loss-making.** The active strategy is
   `sma_cross` with configured fees and slippage. No component of this system
   demonstrates an edge and no profitability is claimed. A backtest describes one
   simulated price path; it is not a forecast.
2. **EGP 500 is a configured paper-account ceiling, not deployed capital.** It is
   `account.startingCapitalEgp` in `config/default.json` and it is also the hard
   cap on `risk.maxStartingCapitalEgp`. Config validation refuses a value above
   500. No real EGP exists anywhere in this system.
3. **Leverage, margin, borrowing, futures and derivatives are impossible by
   construction.** The account is long-only and cash-funded.

This document is about operating a simulation safely. It is not a claim that the
simulation is ready for anything else.

---

## 1. Prerequisites

| Requirement | Value | Where it comes from |
|---|---|---|
| Node.js | **>= 22.5.0** | `package.json` `engines.node`. The floor is `node:sqlite`, used by `src/database/db.js:12`. |
| npm dependencies | **none** | `package.json` `dependencies: {}` and `devDependencies: {}`. |
| Build step | **none** | No bundler, no transpile, no codegen. |
| Network access | **none required, none used** | The only listener is the dashboard, on loopback. There is no outbound call anywhere. |
| Working directory | **the repository root** | Config is resolved from `./config/default.json`, data from `./data`, logs from `./logs` (`src/core/config.js:230,247-256`). |

- **Do not run `npm install`.** There is nothing to install. The project uses
  only the Node standard library. Running it is harmless but pointless.
- Run every command from the repository root, or the relative paths for the
  config file, `data/` and `logs/` will not resolve.
- `.gitignore` excludes `data/`, `logs/`, `*.db`, `*.lock`, `.env` and key files.
  Those directories are runtime state, not source. Do not commit them.

---

## 2. Mode is the first thing

Confirm the mode **before** you read any number this system prints. A BACKTEST
result presented as a PAPER trade is the single most misleading thing this system
could do, and it is treated as a defect by the regression suite.

| Mode | What it is | Database | Orders reach a real venue? |
|---|---|---|---|
| `BACKTEST` | Historical replay through the same worker loop, risk engine, Sentinel, adapter and matching engine. Deterministic from a seed. | `data/teos-backtest.db` | No. Simulated, and scoped to one run. |
| `PAPER` | **Simulated** execution against the in-process market simulator. A real process, a real SQLite database, a real order lifecycle. | `data/teos-paper.db` | No. Simulated, and scoped to the whole mode. |
| `LIVE` | **NOT IMPLEMENTED.** | — | Impossible. `TEOS_MODE=LIVE` throws at startup; `--mode LIVE` is rejected by config validation. |

### 2.1 How to confirm which mode you are in

**Authoritative check — the header line of `status`:**

```bash
npm run status
```

```
MODE: PAPER   database: .../teos-trade-agent/data/teos-paper.db
```

That line is the ground truth. The database path is derived from the *effective*
mode after all overrides are applied (`src/core/config.js:245-256`), not from an
environment variable. If the mode or the file is not what you expected, you are
reading the wrong database. Stop and fix that before drawing any conclusion.

**Same check on the other side:**

```bash
npm run status -- --mode BACKTEST
```

```
MODE: BACKTEST   database: .../teos-trade-agent/data/teos-backtest.db
```

**Dashboard badge.** The page renders the mode from the `/api/snapshot` payload,
not from a literal. `tests/regression-dashboard.test.js` asserts that a BACKTEST
payload contains no field claiming mode `PAPER` and that the client script
contains no hard-coded `PAPER` badge.

### 2.2 The dashboard is PAPER-only

`node src/cli.js dashboard` hard-codes `mode: 'PAPER'` (`src/cli.js:135`) and
`DashboardServer` defaults to `PAPER` when no mode is passed
(`src/dashboard/server.js:98`). **There is no flag that points the dashboard at a
BACKTEST database.** To inspect a backtest, use
`npm run status -- --mode BACKTEST` and the backtest report. Do not read a
BACKTEST run off the dashboard, and do not expect the dashboard to show one.

### 2.3 EGP 500

`EGP 500` in any output is the simulated paper-account ceiling. It is the
starting capital of the simulation and the maximum equity any balance row may
reach (`config/default.json:8,15`; enforced at `src/core/config.js:51,58-61` and
by the `equity never exceeds` check in `scripts/verify.js`). It is not real
money, not a deposit, and not available capital.

---

## 3. Command reference

`src/cli.js` exports `COMMANDS` at line 360. That list — not the help text, not
this table — is what actually runs. Cross-checked against `package.json`
`scripts` (lines 11-25).

| npm script | CLI subcommand | What it does | Changes state? |
|---|---|---|---|
| `npm start` | `worker` | Alias for `npm run worker`. | writes |
| `npm run worker` | `worker` | Run the 24/7 PAPER loop in the foreground. | writes |
| `npm run dashboard` | `dashboard` | Serve the read-only dashboard on `127.0.0.1:8787`. | reads only |
| `npm run backtest` | `backtest` | Replay a generated price history; print and persist a report. | writes `data/teos-backtest.db` |
| `npm run simulate` | `simulate` | Identical to `backtest` but `--ticks` defaults to 2000. | writes `data/teos-backtest.db` |
| `npm run status` | `status` | Print account, agent, risk and audit-chain state. | reads only |
| `npm run health` | `health` | Print the heartbeat probe and latched stops. Exit 1 if not alive. | reads only |
| `npm run kill-switch` | `kill-switch` | Latch an emergency stop. **State-changing.** | writes |
| `npm run reset` | **`reset-stop`** | Clear a latched emergency stop. **State-changing.** | writes |
| `npm run hold` | `hold` | Set `TRADING_HOLD`. **State-changing.** | writes |
| `npm run resume` | `resume` | Clear `TRADING_HOLD`. **State-changing.** | writes |
| `npm test` | *(none)* | Node's own test runner over `tests/*.test.js`. | writes to a temp dir, cleans up |
| `npm run verify` | `verify` | Independent integrity checks over a mode's database. | reads only |

Pass extra arguments after `--`: `npm run status -- --mode BACKTEST`.

### 3.1 Name mismatches between `package.json` and `COMMANDS`

- **`npm run reset` runs `node src/cli.js reset-stop`.** The subcommand is
  `reset-stop` (`src/cli.js:305,368`). `node src/cli.js reset` is an **unknown
  command** and exits 1 with `Unknown command: reset`.
- **`npm start` is an alias for `npm run worker`.** There is no `start` subcommand.
- **`npm test` is the Node test runner.** It has no CLI subcommand counterpart.
- **`simulate` is a real subcommand** (`src/cli.js:364`) but it is **absent from
  the CLI help text** (`src/cli.js:73-83`). Use `node src/cli.js simulate`.

### 3.2 Options, and which commands honour them

Verified against `src/cli.js`.

| Option | Honoured by | Notes |
|---|---|---|
| `--mode PAPER\|BACKTEST` | `status`, `health`, `kill-switch`, `reset-stop`, `hold`, `resume`, `verify` | Ignored by `worker`, `dashboard`, `backtest`, `simulate` — those hard-code their mode. `--mode LIVE` is rejected by config validation. |
| `--json` | `status`, `health`, `backtest`, `verify` | Machine-readable output. |
| `--ticks N` | `worker` (stop after N ticks), `backtest` (default 4000), `simulate` (default 2000) | |
| `--seed N` | `backtest` | Default is `config.market.seed` = `20260928` (`src/backtest/replay-feed.js:51`). |
| `--strategy ID` | `worker`, `backtest` | `sma_cross` (active), `rsi_reversion`, `donchian_breakout`. |
| `--off` | `hold` | Sets `TRADING_HOLD` to false. `resume` is exactly `hold --off`. |
| `--reason TEXT` | `kill-switch`, `hold` | Recorded on the flag/stop row and in a `WARN` event. |
| `--trigger NAME` | `kill-switch` | Default `OPERATOR_KILL_SWITCH`. |
| `--log LEVEL` | `worker` | Console log level. Read at `src/cli.js:105`; **not listed in the CLI help text.** |
| `--config PATH` | `verify` | Alternative config file. |
| ~~`--warmup N`~~ | **accepted, then silently ignored** | See section 11, item 2. Do not rely on it. |

### 3.3 Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. For `health`, the probe found a live worker. |
| `1` | `health`: the worker is not alive (or no stop, no — see below). `verify`: at least one check failed. Unknown command. A crashed handler. |

`health` sets `process.exitCode = 1` when `probe.alive` is false
(`src/cli.js:279`). A crashed command prints `<cmd> failed: <message>` to stderr
and exits 1; the stack is printed only when `TEOS_DEBUG=1` (`src/cli.js:388-392`).

---

## 4. First run, from a clean clone

Run these four commands, in this order, from the repository root.

### Step 1 — the test suite

```bash
npm test
```

Expected: 167 tests, all passing, roughly 45 seconds. Exit 0.

**If it fails, stop here.** Do not proceed to step 2. A red suite means the
pipeline you are about to operate is not in the state the other three documents
describe.

### Step 2 — the self-check

```bash
npm run verify
```

Expected, on a database with no trades in it:

```
==============================================================================
TEOS TRADE AGENT - VERIFICATION (PAPER)
==============================================================================
database: .../teos-trade-agent/data/teos-paper.db
balances 0  fills 0  orders 0  positions 0
...
ALL CHECKS PASSED
==============================================================================
```

Exit 0. See section 8.4 for what each check proves.

This command creates `data/teos-paper.db` and the schema if they do not exist.

### Step 3 — a backtest

```bash
npm run backtest -- --ticks 2500
```

Expected: the report opens with the simulation disclaimer, and the figures end
with `ALL ... ` blocks. With the default seed `20260928`, the observed result on
this build is:

- 18 agent decisions, 16 orders submitted, 33 fills
- net P&L **EGP -3.55**, total return **-0.71 %**

**Read that correctly.** It is negative. This run is a **plumbing check** — it
proves the whole chain from agent to fill to P&L to report executes and persists.
It is not evidence that the strategy works, and the report itself says so on its
first five lines. It is not a forecast, and repeating it will reproduce the same
number because the seed is fixed.

Writes to `data/teos-backtest.db` only. A backtest cannot read or write a single
PAPER row: the tables carry `CHECK (mode IN ('BACKTEST','PAPER'))` and the
backtest database file is a different file.

Each run **appends** to that file. Running a second backtest later is fine, but
it will make `npm run verify -- --mode BACKTEST` fail its cash and position
checks (discrepancy 15, section 11). That is a limit of the checker, not a
booking error.

### Step 4 — confirm the mode and the state

```bash
npm run status
```

Expected on a clean clone:

```
TEOS TRADE AGENT - PHASE 1
Paper simulation only. No real money, no real accounts, no live execution.
Long-only, cash-funded, no leverage, no borrowing, no derivatives.

MODE: PAPER   database: .../teos-trade-agent/data/teos-paper.db

ACCOUNT
  starting capital  EGP 500.00
  ...
RISK
  emergency stop      clear
  trading hold        off
```

Exit 0. If `MODE:` is not `PAPER`, or the emergency stop is not `clear`, stop and
read section 9 before running anything else.

---

## 5. Normal operations

### 5.1 Start the worker

```bash
npm run worker
```

Foreground process. It logs to the console and appends JSONL to
`logs/teos.jsonl`. On start it prints the boot classification, for example:

```
[INFO ] cli: Worker online. {"kind":"COLD_START","runId":"run_...","cashEgp":500,"openPositions":0}
```

`kind` is one of `COLD_START`, `RESUME` or `CRASH_RECOVERY` (section 10).

**The first ~30 minutes are quiet, and that is normal.** The active strategy
requires 40 candles (`sma_cross.minBars`) and candles are 30 ticks each, so the
agent stays in `WARMUP` for about 1 800 ticks at one tick per second. Until it
leaves `WARMUP` it cannot open a position, so `decisions` stays at 0. That is the
designed behaviour, not a stall.

### 5.2 Stop the worker

Press **Ctrl+C** in the worker's terminal. `SIGINT` triggers a graceful stop
(`src/cli.js:118-126`): the agent transitions to `STOPPED`, a final equity point
is written, the run is marked `STOPPED`, a final heartbeat is written, and the
single-instance lock is released.

**Never kill the worker with a hard kill unless you have no alternative.** A
`SIGKILL` leaves a lock file behind and a run row still marked `RUNNING`. The
system recovers from that correctly (section 10) — but the next start is
classified `RESUME` rather than a clean start, and you should know that is why.

### 5.3 Start the dashboard

```bash
npm run dashboard
```

```
Dashboard listening on http://127.0.0.1:8787
Read-only. Binds to loopback only. Press Ctrl+C to stop.
```

Open `http://127.0.0.1:8787` in a browser on the same machine. **From another
machine it will not connect, and that is the design.** Non-loopback binds are a
hard refusal, not a warning.

To stop it, press **Ctrl+C**.

### 5.4 What a healthy session looks like

```bash
npm run health
```

```
HEALTH (PAPER)

  status              HEALTHY
  alive               true
  detail              -
  last heartbeat age  2 s
  ticks               1240
  decisions           0
  orders              0
  errors recorded     0
  emergency stop      clear
```

- `status` is `HEALTHY`, or `STARTING` while the agent is still in `WARMUP`.
- `alive` is `true`.
- `last heartbeat age` is well under 30 000 ms (the staleness threshold,
  `config.worker.heartbeatStaleAfterMs`). The worker writes a heartbeat every
  5 000 ms (`config.worker.heartbeatMs`).
- `emergency stop` is `clear`.
- `errors recorded 0` is worth watching; it is cumulative for the run and it
  should not climb.

If `errors recorded` is non-zero and rising, read section 9.

### 5.5 Where things live

| Path | What it is |
|---|---|
| `data/teos-paper.db` | The PAPER database. System of record for cash, positions, orders, fills, decisions, audit chains. |
| `data/teos-paper.db-wal`, `-shm` | SQLite write-ahead log and shared memory. Normal. |
| `data/teos-backtest.db` | The BACKTEST database, same schema, `mode = 'BACKTEST'` rows only. |
| `data/teos-paper.lock` | The single-instance lock: `{instanceId, pid, host, acquiredMs, heartbeatMs}`. Its `pid` is how you find a wedged worker. |
| `logs/teos.jsonl` | Structured JSONL log, one object per line, secrets redacted before write. |
| `data/`, `logs/`, `*.db`, `*.lock` | All git-ignored. Runtime state, never source. |

Neither directory is committed. Both are created on first use.

---

## 6. Daily operator procedures

### 6.1 Trading hold and resume

**This is a full stop, not a "no new entries" switch.** Read section 6.1.1 before
you use it.

```bash
npm run hold -- --reason "investigating a data anomaly"
```

Expected output:

```
TRADING_HOLD engaged: new entries are blocked. Risk-reducing exits are still allowed.
```

**State change:** writes `control_flags.TRADING_HOLD = 'true'` and a `WARN`
event. Survives a restart — it lives in the database, not in process memory.

```bash
npm run resume
```

Expected output:

```
TRADING_HOLD cleared: the agent may open new positions again.
```

**State change:** writes `control_flags.TRADING_HOLD = 'false'` and a `WARN`
event. `resume` is exactly `hold --off`.

Confirm either one with:

```bash
npm run status
```

```
  trading hold        ON - new entries blocked
```

or

```
  trading hold        off
```

#### 6.1.1 What `hold` actually does, per the code

**The output message above is wrong, and so is the CLI help.** It says exits are
still allowed. They are not.

- `src/cli.js:81` — help: `hold  Set the TRADING_HOLD flag (blocks entries, allows exits)`
- `src/cli.js:337` — output: `Risk-reducing exits are still allowed.`
- `src/cli.js:222` — status label: `ON - new entries blocked`
- `src/execution/sentinel.js:95-111` — the `MANUAL_HOLD` rule returns
  `BLOCK` for **every** order while the flag is set. It is rule 5 of 14 and it
  has no exemption for a risk-reducing order.

**Operational consequence.** If a position is open and its stop is breached while
a hold is engaged:

1. The worker converts the breached stop into a real Decision
   (`src/worker/worker.js:372-411`).
2. The risk engine passes it, the Sentinel blocks it on `MANUAL_HOLD`.
3. The firewall returns `BLOCKED`.
4. The worker treats a blocked stop exit as a CRITICAL condition: it logs a
   `FATAL` `stop_loss_failed` event and **latches a `STOP_EXIT_BLOCKED`
   CATASTROPHIC emergency stop** (`src/worker/worker.js:427-440`).

So a hold with an open position can escalate into a latched emergency stop on its
own. Check `status` after engaging a hold, not just before.

**There is no "block entries, allow exits" mode in this build.** The Sentinel's
`PRICE_DRIFT`, `DECISION_RATE` and `EXPOSURE_PRESSURE` rules *do* carry explicit
risk-reducing exemptions (`src/execution/sentinel.js:118`, `:210`, `:237`).
`MANUAL_HOLD` deliberately does not.

#### 6.1.2 If you want to stop trading without that risk

**Stop the process.** Ctrl+C in the worker's terminal. The market does not
advance, so no stop can breach, and nothing can be submitted. On restart the
account resumes from the database. This is the cleaner halt.

### 6.2 Kill switch versus hold

| | `hold` | `kill-switch` |
|---|---|---|
| Writes | `control_flags.TRADING_HOLD` | an `emergency_stops` row + `EMERGENCY_STOP` flag |
| Blocks exits | Yes (`MANUAL_HOLD`) | Yes (`KILL_SWITCH`, in both the risk engine and the Sentinel) |
| Survives restart | Yes | Yes |
| Health resolves to | unchanged | `HALTED` |
| Cleared by | `resume` | `reset-stop` |
| Intended for | a deliberate pause | an emergency |

Use the kill switch (section 7) when you need the halt to be visible to the risk
engine, the Sentinel, the adapter and the dashboard. Use `hold` for a quiet
pause. Neither is a "close my positions" tool — nothing in this system closes a
position on operator demand.

### 6.3 Daily checklist

1. `npm run health` — `alive true`, `emergency stop clear`, `errors recorded` not
   climbing.
2. `npm run status` — `trading hold off`, no open `BROKEN` audit chain, `AUDIT`
   rows all read `intact (N records)`.
3. `npm run verify` — `ALL CHECKS PASSED`.
4. If any of the above is not true, go to section 9. Do not clear anything to
   make a check pass.

---

## 7. Emergency stop

A **latched, deliberate, operator-initiated halt**. It is a row in the
`emergency_stops` table, not a flag in process memory. It does not clear itself
when the condition that raised it goes away. That is the whole point of a kill
switch.

### 7.1 Latch it

```bash
npm run kill-switch -- --reason "market data looks wrong; halting entries"
```

Expected output:

```
Emergency stop engaged (stop_01M3NBQJVJ0DX9RZW68J). All new orders are refused until it is cleared with 'reset-stop'.
```

**State change:** inserts an `emergency_stops` row with
`trigger = OPERATOR_KILL_SWITCH`, `severity = CRITICAL`, `scope = NEW_ORDERS`,
and sets the `EMERGENCY_STOP` control flag. Also writes a `WARN` event. The
command creates a run row if the database has none, so that the stop is attached
to a run.

**That message understates the effect.** "All new orders" is the string the CLI
prints, and `scope` is stored as `NEW_ORDERS`, but no code path consults `scope`
to decide whether an exit is exempt. Risk rule `KILL_SWITCH`
(`src/risk/rules/index.js:61-71`) blocks every order, **including risk-reducing
exits**, and Sentinel rule `KILL_SWITCH` blocks them again. Asserted directly in
`tests/scenario-08-emergency-stop.test.js:50-55`.

Treat `kill-switch` as "everything stops", not "new orders stop".

### 7.2 Confirm it is engaged

Any of these:

```bash
npm run status
```

```
  emergency stop      ENGAGED (OPERATOR_KILL_SWITCH)
```

```bash
npm run health
```

```
  emergency stop      ENGAGED (OPERATOR_KILL_SWITCH)
```

```bash
npm run verify
```

The `health` and `verify` commands both exit 1 once the heartbeat is stale, but
they still print the stop state first. Read the output, not just the exit code.

On the dashboard, `GET /healthz` returns `"emergencyStopEngaged": true`, and the
RISK section shows the stop with its id, trigger, severity, scope and the time it
engaged.

### 7.3 What stops when it is engaged

The worker **keeps ticking**. It does not exit, and it does not stop writing
heartbeats. What stops is execution, at three independent gates:

1. **Risk rule 2, `KILL_SWITCH`** — the first rule to see it, refuses the order.
2. **Sentinel rule 2, `KILL_SWITCH`** — refuses it again, independently.
3. **The execution adapter** — performs a last check immediately before
   `broker.placeOrder()` and throws `EmergencyStopError` if a stop is active, so
   an order cannot slip through between the gates and the broker call.

The heartbeat status resolves to `HALTED` (`src/worker/heartbeat.js:101`).

A stop latched by the risk engine or the worker persists across a restart: a
resumed PAPER run keeps its `run_id`, and PAPER stops are looked up mode-wide.

### 7.4 What latches a stop on its own

You will meet these in `status` without having run `kill-switch`. They are the
system protecting itself:

| Trigger | Meaning |
|---|---|
| `OPERATOR_KILL_SWITCH` | You ran `kill-switch`. |
| `STOP_EXIT_BLOCKED` | A breached stop could not be executed. The position is still open. **Investigate before clearing.** |
| `UNHANDLED_ERROR` | An unexpected throw in the tick loop. The agent was marked `FAILED`. |
| `STRATEGY_ERROR` | The strategy threw. |
| `DAILY_LOSS_LIMIT` | The daily loss budget was reached. |
| `KILL_SWITCH`-latching rule names | A risk rule with `latchesStop: true` failed. |

### 7.5 Clear it

**This is a decision, not a reflex.** The command says so itself:

```bash
npm run reset
```

which runs `node src/cli.js reset-stop`. Expected output:

```
Cleared emergency stop stop_01M3NBQJVJ0DX9RZW68J (OPERATOR_KILL_SWITCH). 0 still active.
NOTE: clearing a stop does not resolve its cause. Check `status` and the audit log first.
```

If no stop is engaged:

```
No active emergency stop. Nothing to clear.
```

**State change:** sets `active = 0` on the stop row with a `cleared_at` and
`cleared_by`, writes a `WARN` event, and releases the `EMERGENCY_STOP` flag
**only when no active stops remain**. If it reports `N still active` with
`N > 0`, another stop is latched and you have not finished.

Before you clear:

1. `npm run status` — read the trigger and the reason.
2. `npm run health` — look at `RECENT ERRORS`.
3. If the trigger is `STOP_EXIT_BLOCKED`, the position is still open and its stop
   still cannot execute. Clear it only if you understand why the exit was refused.
4. If the trigger is `DAILY_LOSS_LIMIT`, the loss budget is the cause. Clearing
   the stop does not restore the budget for that day.

---

## 8. Diagnostics

### 8.1 `health` — is the worker alive?

```bash
npm run health
```

Prints the heartbeat probe: status, alive, detail, heartbeat age, tick /
decision / order / error counters, and the latched stop. If there are ERROR or
FATAL events it lists the last 10.

**Exit code 1 means "not alive"** (`src/cli.js:279`). It does not mean the command
failed to run. It is the intended signal for a supervisor.

To get the `pid` and `host` of the last heartbeat — which is how you find a
wedged process — use the JSON form:

```bash
npm run health -- --json
```

The probe object carries `pid`, `host`, `instanceId`, `version`, `uptimeMs`,
`lastHeartbeatIso` and `countersLive`.

### 8.2 `status` — full state

```bash
npm run status
npm run status -- --json
npm run status -- --mode BACKTEST
```

Sections: `ACCOUNT` (cash, equity, exposure, realised and unrealised P&L, fees,
slippage, open positions), `AGENT` (run id, run status, strategy, agent state,
last heartbeat, counters), `RISK` (stop, hold, and every configured limit),
`OPEN POSITIONS`, and `AUDIT` (all four hash chains).

**Read the `AUDIT` block every time.** Four lines, each either
`intact (N records)` or `BROKEN: <reason>`.

### 8.3 The dashboard's read-only endpoints

All `GET`/`HEAD` only, loopback only, SQLite opened `readOnly: true`.

| Route | What it returns |
|---|---|
| `GET /` and `GET /index.html` | The page. |
| `GET /app.js`, `GET /style.css` | The two local assets. Nothing remote is referenced. |
| `GET /healthz` | `{status, mode, readOnly: true, loopbackOnly: true, auth, emergencyStopEngaged, equityEgp, auditStreams}`. |
| `GET /api/snapshot` | All four sections in one envelope, plus `mode` and the disclaimer. |
| `GET /api/env` | The redacted allow-list of environment variables. Never a credential value. |
| `GET /api/section/account\|agent\|risk\|audit` | One section. An unknown name is a 404 that lists the real ones. |
| `GET /api/audit/chains` | Per-stream chain integrity for all four streams. |

**Expected refusals. These are the system working, not bugs:**

| You do | You get | Meaning |
|---|---|---|
| `POST` (or `PUT`/`PATCH`/`DELETE`/`OPTIONS`/`TRACE`) anything | **405** with `Allow: GET, HEAD` and a JSON body naming the CLI as the control surface | Read-only. There is no write handler to enable. |
| `GET` an unknown path | **404** `{"error":"not found"}` | Routing is an allow-list. |
| `GET` a traversal path such as `/../../.env` | **404**, no file content | Static files resolve from a frozen list of three names. No request string is ever joined to a path. |
| `GET` a URL over 2048 characters | **414** `{"error":"URL too long"}` | Refused before parsing. |

The method check runs before routing, so a `POST` to a static asset is a 405,
not a file. Verified in `tests/regression-dashboard.test.js`.

There is **no authentication**, by design, because the listener is loopback-only.
The environment layer throws if a dashboard token variable is set at all. Do not
try to reach the dashboard from another machine; it is meant to be unreachable.

### 8.4 `verify` — independent integrity checks

```bash
npm run verify
npm run verify -- --mode BACKTEST
npm run verify -- --json
```

This does **not** ask the running agent whether it is consistent with itself. It
re-derives every quantity from the raw rows and compares. On success it prints
`ALL CHECKS PASSED` and exits 0. On failure it prints `N CHECK(S) FAILED` and
exits 1.

**Scope: one run, not one database.** `verify` assumes a single run's ledger. It
reads every `balance`, `fill` and `position` row for the mode and re-derives cash
from *one* EGP 500 starting point. On `PAPER` that is right, because PAPER holds
one continuous account. On `BACKTEST` it only holds for a database that has
persisted exactly one backtest: each backtest run restarts from EGP 500 but
appends to the same tables, so a second run makes checks 2 and 4 fail against
correctly-booked rows. Reproduced on a clean directory — one run then `verify`
passes, a second run then `verify` reports `2 CHECK(S) FAILED`. If you need to
re-verify a backtest, give it its own directory (`TEOS_DATA_DIR`). See the
failure-mode table in section 9.

The code emits **14** checks. What each one proves:

| # | Check | Proves |
|---|---|---|
| 1 | equity invariant | `equity == cash + exposure` on every balance row, to under one piastre. |
| 2 | cash reconstruction | Starting capital plus every fill equals the ledger cash. Cash only moves through a fill, so this is the strongest single check in the file. |
| 3 | order and fill agreement | `filled_quantity` equals the sum of that order's fills; no `REJECTED` order has fills; no `FILLED` order is short; nothing is over-filled. |
| 4 | position reconciliation | Open positions equal the net of their own fills. This is what catches a quantity rounded with the wrong precision helper. |
| 5 | no orphan fills | Every fill belongs to a recorded order. |
| 6-9 | audit chain intact: `decision`, `risk`, `sentinel`, `order` | Each stream re-hashes correctly end to end. |
| 10 | no duplicate `client_order_id` | One decision has never produced two orders, ever. |
| 11 | cash never negative | No borrowing. |
| 12 | equity never exceeds EGP 500 | No leverage, no minting. |
| 13 | no ERROR or FATAL events | Errors are surfaced, not hidden. **This one fails whenever the system has ever recorded an error**, which is usually worth reading, not worth deleting rows over. |
| 14 | every order fully linked | Every order has a decision, a risk verdict and a Sentinel verdict. |

On an empty database, checks 1 and 2 report `no balance rows yet` and pass
vacuously. **An empty database passing is not evidence of health** — it is
evidence there is nothing to check.

### 8.5 What a broken audit chain means

Each record in a stream stores `sha256('<stream>|<mode>|<prevHash or GENESIS>|<canonicalJson(body)>')`
over a fixed list of columns. Walking the chain detects any retroactive edit,
deletion or insertion.

A `BROKEN` line means one of two things:

1. **A record was altered, deleted or inserted after it was written.** That is an
   integrity incident. The chain is the alarm.
2. **A genuine bug** rewrote a hashed column.

**What to do:** stop writing to that database (stop the worker), copy `data/`
aside before doing anything else, and preserve the file. **Do not run
`reconcile`/fix-up tooling, do not delete the row, and do not re-seal the chain.**
A re-seal destroys the only evidence that something was wrong. Escalate.

**What the chain does not cover.** The `orders` stream deliberately excludes the
lifecycle columns `status`, `filled_quantity`, `avg_fill_price`, `updated_at`,
`terminal_at` and `rejection_reason`, because those legitimately change on
every fill and a chain that always reports "broken" trains operators to ignore
it. They are protected instead by checks 3 and 14, by the order state machine in
`Repos.updateOrderStatus` which rejects illegal transitions, and by the
append-only `fills` table. The order's immutable `status_at_submit` **is**
hashed, so what the chain proves about an order is that its *intent* — which
decision, which side, symbol, quantity and price — was never rewritten.

**Tamper-evident, not tamper-proof.** An attacker with write access to the
database can rewrite a row and recompute every hash after it. The chain makes
silent, partial, historical edits detectable. It does not make the database
unforgeable and it does not protect against an attacker who rewrites the whole
chain. There is no signing key and no external anchor.

---

## 9. Known failure modes, and what to do

Many of the entries below describe **the system working correctly**. A refusal is
usually a policy doing its job. Do not "fix" a refusal by loosening
configuration — config validation already refuses most of the loosenings.

| Symptom | What it means | Safe next step |
|---|---|---|
| `health`: `status STALE`, `alive false`, `detail: last heartbeat Nms ago exceeds the 30000ms threshold` | The loop is not running. The process died, hung, or was killed. | Read the worker terminal. If the process is gone, start it again. If it is alive, it is wedged — see the lock row below. |
| `status`: `run status RUNNING` but `health` says `STALE` | The process died without a clean stop. The run row was never closed. | Normal after a `SIGKILL`. Restart; the worker classifies it `RESUME` and reconciles. See section 10. |
| Worker exits immediately: `LockHeldError`, `code LOCK_HELD` | A second instance owns `data/teos-paper.lock`. On one host, a **live PID holds the lock regardless of heartbeat age**, so a wedged-but-alive process blocks a restart indefinitely. | `npm run health -- --json` gives the pid. Terminate that process, then start the worker again. Do not delete the lock file while the pid is alive. |
| `status`: `emergency stop ENGAGED (something-you-did-not-set)` | An automatic latch. See the trigger table in section 7.4. | Read the trigger. Investigate the cause. Clear with `npm run reset` only once you understand it. |
| `status`: `trading hold ON` and you did not set it | `TRADING_HOLD` is durable in the database. It survived a restart, or someone set it. | `npm run resume` to clear. Then confirm with `npm run status`. |
| `status` `AUDIT`: a stream reads `BROKEN` | See section 8.5. | Stop the worker, copy `data/` aside, escalate. Do not re-seal. |
| `verify`: `CHECK(S) FAILED` | One of 14 checks did not hold. | Read the failing line — it names the check and the numbers. Preserve the database. See 9.1. |
| `verify`: `no ERROR or FATAL events recorded` FAILs | The system has recorded an error at some point. This check reports history, it is not a live fault. | Read the message. It names the category and the text of the most recent 20. |
| `verify` on a database you have never run | All checks pass vacuously with `no balance rows yet`. | That is expected on a clean clone. It proves nothing about a system that has been running. |
| `verify --mode BACKTEST` FAILs `cash reconstructs exactly from the fill log` and `positions reconcile with their fills` | **You have run more than one backtest against the same database.** Each run appends to the shared BACKTEST ledger, but `verify` re-derives cash from a single EGP 500 starting point across *all* of them, so the totals no longer agree. It is a limit of the checker, not evidence that a trade was mis-booked. | Reproduced: one backtest then `verify` passes; a second backtest then `verify` fails 2 checks. Do not re-seal and do not "fix" the ledger. To re-check a single run, point at a fresh data directory: `TEOS_DATA_DIR=./data-scratch` for the backtest, then `verify --mode BACKTEST`. |
| `status` shows a mode you did not expect | You are reading the wrong database file. The mode and the file are printed together on one line. | Use `--mode BACKTEST` to read the backtest file. Never infer the mode from the numbers. |
| A refusal named `DAILY_LOSS`, `EXPOSURE`, `POSITION_SIZE`, `MAX_CAPITAL`, `MIN_NOTIONAL`, `SUFFICIENT_BALANCE`, `ORDER_RATE` | The risk engine blocked. This is the policy. Blocked decisions are recorded, including the BLOCK verdict. | Do nothing. Read `failed_rule` and `reason` in the risk section of the dashboard. The limits are in section 7.1 of `RISK_POLICY.md`. |
| A refusal named `KILL_SWITCH` and you did not latch one | **Another run's stop.** PAPER stops are looked up mode-wide, so a stop latched by an earlier PAPER run still applies to this one. BACKTEST stops are run-scoped, so a previous backtest's stop does *not* apply. | `npm run status` and read the trigger. `npm run reset` when you have decided to. |
| A refusal named `MANUAL_HOLD` | The trading hold is on. It blocks exits too (section 6.1.1). | `npm run resume` — but check for open positions first. |
| A refusal named `PRICE_SANITY`, `DATA_FRESHNESS`, `CONNECTION` | The market or the feed is not trustworthy right now. | Look at the agent state in `status`. `DEGRADED` means it cannot open positions; this is correct. |
| Every order is refused right after a restart, and `status` shows `RESUME` | An emergency stop from the previous run is still latched and PAPER looks it up mode-wide. | Expected. `npm run reset`. |
| `dashboard` will not start: `Refusing to bind the dashboard to "0.0.0.0"` | `dashboard.host` is not a loopback address. Non-loopback is a hard refusal. | Set `dashboard.host` to `127.0.0.1` in `config/default.json`. Do not work around it. |
| `dashboard` will not start: `Refusing to start: dashboard.allowNonLoopbackBind is not false.` | The escape-hatch flag was opened. | Set it back to `false`. `loadConfig` refuses it too, so this is the second independent guard. |
| `status` or `health` prints `ExperimentalWarning: SQLite is an experimental feature` on stderr | Node's own warning about `node:sqlite`. | Harmless noise. It is not an error and does not affect exit codes. |
| `node src/cli.js reset` → `Unknown command: reset` | The subcommand is `reset-stop`. | Use `npm run reset`, or `node src/cli.js reset-stop`. |
| `npm` fails to run at all in PowerShell | A local Windows execution policy is blocking `npm.ps1`. **This is a property of that machine, not of this project.** | Use `npm.cmd run <script>` instead of `npm run <script>`. |

### 9.1 A refusal is not a bug

The overwhelming majority of "the agent did not do what I wanted" cases in this
system are the risk engine or the Sentinel refusing, for a documented reason, and
recording the refusal. The refusal is written to `risk_decisions` and
`sentinel_decisions` with the rule that produced it.

Before treating a refusal as a defect, check all four of these:

1. Is a stop engaged? (`status`)
2. Is a hold engaged? (`status`)
3. Is the agent `DEGRADED` or `HALTED`? (`status`)
4. Is the market data fresh and sane? (`health`, and the agent section)

If none of those explains it, the backtest report's `blocked by risk engine` and
`quarantined by Sentinel` counts tell you how often it is happening in normal
operation.

---

## 10. Restart and recovery

### 10.1 What survives a restart

**Everything in the database.** Cash and fees and slippage, positions, orders and
their lifecycle, fills, P&L events, the equity curve, the daily-loss window,
`TRADING_HOLD`, `EMERGENCY_STOP`, every latched emergency stop, the heartbeat
history, the restart history, and all four audit chains.

**What does not survive:** in-memory agent state. A restart **always begins a
fresh state machine at `STARTING`** (`src/worker/worker.js:274-287`). A previous
terminal state (`HALTED`, `FAILED`, `STOPPED`) is history, recorded in the
restart row; it is not resumed as a live state. Health is re-derived from the
current broker and data. The emergency-stop table, not the state machine, is what
gates trading after a restart.

### 10.2 How a start is classified

| `kind` | When |
|---|---|
| `COLD_START` | No prior run on this database. |
| `RESUME` | A prior run is still marked `RUNNING`. Same `run_id`, cash and open positions restored. |
| `CRASH_RECOVERY` | A prior run exists but is not `RUNNING`. A fresh `run_id`. |

A **cold** start does *not* adopt leftover `OPEN` positions. A row still marked
OPEN belongs to a previous, ended run with a different starting balance;
adopting it would mean starting this run holding another run's positions. The
cold start logs a `WARN` naming the orphans and continues with a fresh book
(`src/worker/worker.js:223-233`).

### 10.3 In-flight orders are never resent

At boot, **before** the loop can create a new order, `reconcileInFlight`
(`src/worker/idempotency.js`) walks every order left in flight:

| Fills found | What it does |
|---|---|
| none | marks it `CANCELED`, reason `RECOVERED_UNFILLED_AFTER_RESTART`, terminal |
| complete | marks it `FILLED`, terminal |
| partial | marks it `CANCELED`, keeps the filled part, terminal |

It **never resubmits**. The invariant is: one decision produces at most one
order, forever, across any number of restarts. Two independent mechanisms enforce
it — a deterministic `client_order_id` derived from the decision id and
constrained `UNIQUE` in storage, and this reconciliation.

Cash is rebuilt from the fill history for the current run and compared to the
ledger. A mismatch is logged at `ERROR` with expected, actual and delta, and
`verify` will also catch it.

### 10.4 Confirming the system came back coherent

`tests/scenario-07-restart-recovery.test.js` is the authority for this, and it
asserts all of the following. Do the same four checks by hand:

```bash
npm run status
npm run health
npm run verify
```

1. **`status` shows a new `run id`** and `run status RUNNING`. If it says
   `RESUME` you continued the same run; if the run id changed, it was a
   `CRASH_RECOVERY`.
2. **`health` shows `alive true`** and a heartbeat age well under 30 s.
3. **`verify` prints `ALL CHECKS PASSED`.** This is the one that matters: it
   re-derives cash from the fill log and re-hashes all four chains. If
   `cash reconstructs exactly from the fill log` fails, the restart lost or
   duplicated money movement and the database is not trustworthy.
4. **The restart was recorded.** The dashboard's AGENT section lists the last 20
   restarts with their `kind`, the previous and new `instance`, and
   `orphaned_orders`. A large `orphaned_orders` with orders that should have
   filled is the signal to investigate.

---

## 11. Known discrepancies

Code-versus-documentation mismatches that were found by reading the source while
writing this runbook. They are recorded rather than papered over, because an
operator who trusts the wrong line of a document acts on it.

**1. `hold` is documented as allowing exits. It does not.**
`src/cli.js:81` (help), `src/cli.js:337` (the message it prints) and
`src/cli.js:222` (the `status` label) all say a trading hold blocks entries and
allows exits. `src/execution/sentinel.js:95-111` — the `MANUAL_HOLD` rule —
returns `BLOCK` for every order with no risk-reducing exemption, and it runs
before any order reaches the adapter. **Verdict: the code blocks exits.** The
help text and the printed message are wrong.

**2. `--warmup` is accepted and silently ignored.**
`src/cli.js:90` advertises it, `src/cli.js:154` parses it and passes
`warmupTicks` to `runBacktest`. But `runBacktest` (`src/backtest/engine.js:192`)
does not destructure `warmupTicks`, and `engine.run({ maxTicks, persist })` at
line 197 does not forward it. `BacktestEngine.run()` supports the parameter
(`src/backtest/engine.js:71`); nothing ever supplies a value. **Consequence: a
backtest always replays with zero warm-up ticks.** Do not rely on `--warmup`.
(`docs/TRADING_POLICY.md:70,376` documents it as working.)

**3. The risk engine has 19 rules, not 15.**
`src/execution/firewall.js:13` prints `RISK ENGINE (15 ordered rules,
fail-closed)` in its own header. `src/risk/rules/index.js:45` exports 19
(`NO_LEVERAGE` … `DUPLICATE_ORDER`). `docs/ARCHITECTURE.md:143-156` and
`docs/RISK_POLICY.md` correctly say 19. (The rules module's own header carries no
count, so the stale "15" lives in `firewall.js`.)

**4. The worker tick-sequence comment is out of order.**
`src/worker/worker.js:17-28` puts daily-loss rollover at step 10 and the
heartbeat at step 9. `tick()` actually runs the rollover at step 7
(`src/worker/worker.js:456`) and the heartbeat at step 10 (line 491). The header
also says the heartbeat runs "every heartbeatIntervalMs"; the real interval is
`config.worker.heartbeatMs` (5 000 ms). `docs/ARCHITECTURE.md:503-514` documents
the real order.

**5. `MockBroker.reconcileOrphans()` is dead code.**
Defined at `src/broker/mock/mock-broker.js:505`. Grepped across the whole
repository, it is never called from `src/` or `tests/`. The live restart path is
`reconcileInFlight` in `src/worker/idempotency.js`, which resolves an unfilled
orphan to `CANCELED` rather than to the non-terminal `UNKNOWN` this dead method
would write. Do not read it as the recovery behaviour.

**6. `verify` runs 14 checks; two places say ten.**
`scripts/verify.js:13-24` enumerates 10 in its header comment;
`runVerification` emits 14. `docs/ARCHITECTURE.md:686` repeats "ten independent
integrity checks". Section 8.4 of this document lists the 14 that actually run.

**7. The kill-switch message and stored scope both understate the effect.**
`src/cli.js:301` prints "All new orders are refused", and `src/cli.js:292` stores
`scope: 'NEW_ORDERS'`. No rule consults `scope`; risk rule `KILL_SWITCH`
(`src/risk/rules/index.js:61-71`) blocks every order including exits, as
`tests/scenario-08-emergency-stop.test.js:50-55` asserts directly.

**8. `simulate` is a real command that the help text does not list.**
`src/cli.js:364` registers it; `src/cli.js:73-83` omits it. `COMMANDS` has 11
entries and `HELP` lists 10.

**9. `SECURITY.md` now exists; `ARCHITECTURE.md` still says it does not.**
`src/dashboard/server.js:228` advertises `auth: 'none (loopback-only by design;
see SECURITY.md)'`. `docs/SECURITY.md` exists and documents exactly that.
`docs/ARCHITECTURE.md:706-707` still says the file "does not exist in this
repository". The dashboard string is correct; the architecture document is stale.

**10. Two worker config keys are read by nothing.**
- `config/default.json:94` `worker.heartbeatIntervalCycles` (`5`) is read by
  **nothing at all** — not the worker, not the config validator, not a test. The
  heartbeat interval is `config.worker.heartbeatMs`.
- `config/default.json:92` `worker.maxDecisionsPerTick` (`1`) is validated at
  `src/core/config.js:178` and named in a comment at `src/agent/engine.js:16`,
  but is never used as a control value. One-decision-per-tick is real, and it
  comes from `AgentEngine` returning after the first signal — not from this key.
- `config/default.json:93` `worker.autoResetDailyLossAtUtcMidnight` (`true`) is
  also read by nothing. `Worker#maybeResetDailyLoss` is unconditional.

**11. `docs/ARCHITECTURE.md:241` lists a `run` command.** There is no `run`
subcommand in `COMMANDS`. The listed command is `worker`.

**12. A test writes a flag nothing reads.**
`tests/scenario-08-emergency-stop.test.js:78` sets `MANUAL_HOLD`, but the
Sentinel reads `TRADING_HOLD` (`src/execution/sentinel.js:309`). The assertion
still holds — the emergency stop is what blocks the order, not the flag — but the
test does not do what its comment describes.

**13. A dead ternary in the firewall.**
`src/execution/firewall.js:158`: `const outcome = res.duplicate ? 'BLOCKED' :
'BLOCKED';` — both branches are identical. Harmless, but it is not a distinction.

**14. `node:sqlite` still emits an `ExperimentalWarning` on Node 22.23.3.**
Every CLI command prints it to stderr. It is not a fault and does not change an
exit code, but it looks like one.

**15. `verify` cannot check a BACKTEST database that holds more than one run.**
`scripts/verify.js:64-67` selects every `balance`, `fill`, `order` and `position`
row for the mode, and check 2 (`scripts/verify.js:86-87`) adds *all* of them to a
single `config.account.startingCapitalEgp` starting point. But
`saveBacktestRun` / `saveBacktestTrades` (`src/backtest/persist.js:16,43`) append
each completed backtest to the same tables (`src/backtest/persist.js:15,32`), and
every run begins again from
EGP 500. One run reconciles; a second run cannot, because the fills of two
independent runs are summed against one opening balance. Check 4 fails for the
same reason, and can additionally report "more than one OPEN position row".
Reproduced on a clean `TEOS_DATA_DIR`: backtest → `verify` exit 0; backtest again
→ `verify` exit 1 with exactly these two checks failing. **The rows are
correctly booked; the checker's model of the ledger is wrong for this shape.**
Nothing documents this: `docs/ARCHITECTURE.md:686` describes `verify` as
mode-scoped. The `PAPER` path is unaffected, because PAPER is one continuous
account.

---

## 12. What this system does not do

Stated plainly, because the gaps are the point.

- **It does not trade live.** There is no live execution adapter, no credential
  path, no network call to any exchange or broker. `LIVE` is not a flag that is
  off; it is an absence of capability.
- **It does not connect to an exchange or any external service.** The price
  source is a local, seeded, deterministic simulator. There is no egress.
- **It does not have an edge.** The active strategy is currently loss-making. No
  profitability is demonstrated or claimed. A backtest number describes one
  simulated price path under one cost model at one size. It is not a forecast and
  not evidence of future results.
- **It does not use real money.** EGP 500 is a simulated account ceiling.
- **It does not use leverage, margin, borrowing, futures or derivatives.** These
  are impossible by construction, not merely disabled.
- **It does not short.** A SELL with no open long is refused before it becomes an
  order.
- **It is not production-ready.** It has no authentication, no transport
  security beyond loopback, no credential rotation, no incident-response
  procedure, no on-call, and no deployment story.
- **It does not close positions on operator demand.** There is no "flatten" or
  "close all" command. `hold` and `kill-switch` stop new orders; neither
  liquidates the book.
- **It does not have a configurable "no new entries, but allow exits" mode.** The
  Sentinel's `MANUAL_HOLD` blocks everything. See section 6.1.1.
- **It is not tamper-proofing.** The audit chains are tamper-*evident*. An
  attacker with write access can rewrite a row and recompute the whole chain.
- **It does not guarantee any risk limit is appropriate for anything.** The
  limits are calibrated for a simulated EGP 500 account.
- **It has no multi-process, multi-host or clustered operation.** One loop, one
  database, one lock file.
- **It does not report P&L for a live market, because it has no live market.**

The correct summary remains the one at the top of this document and at the top of
`ARCHITECTURE.md`: **Phase 1 has no live execution adapter.**
