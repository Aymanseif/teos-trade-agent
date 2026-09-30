# TEOS Trade Agent

**An autonomous trading agent that runs 24/7 against a simulated venue, with a risk firewall, a Sentinel oversight layer, and a hash-chained audit log.**

Phase 1 is **paper-only**. It cannot trade real money, and it is built so that it *cannot* — not by policy, but by the schema, the configuration loader, and the Sentinel each refusing independently.

```
┌─ MODE ───────────────────────────────────────────────┐
│  BACKTEST   historical replay        implemented     │
│  PAPER      simulated execution     implemented     │
│  LIVE       real money              NOT IMPLEMENTED  │
└──────────────────────────────────────────────────────┘
```

> **Read this before anything else.**
> This system has never traded a real instrument, has no exchange connectivity, and
> has no live execution path. Every number it produces comes from a synthetic price
> generator running in-process. EGP 500 is a **configured ceiling on a paper
> account**, not capital. The strategy is **currently loss-making** — see
> [Measured results](#measured-results). Nothing here is investment advice, a
> forecast, or a claim of profitability.

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [The three modes](#the-three-modes)
- [How a tick flows](#how-a-tick-flows)
- [Safety properties](#safety-properties)
- [Testing](#testing)
- [Measured results](#measured-results)
- [Operator commands](#operator-commands)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Known gaps and limitations](#known-gaps-and-limitations)
- [Roadmap to public release](#roadmap-to-public-release)
- [Status](#status)

---

## What it is

A trading agent that would be unsafe to deploy, built carefully enough that you can
find out *exactly* why — and so that you can prove it.

The interesting part is not the strategy. It is that every safety property is
**enforced and tested** rather than asserted in a comment:

- A **19-rule risk firewall** evaluates orders in a fixed order and fails closed.
  The first blocking rule wins, and it is recorded which one.
- A **14-rule Sentinel** sits above the risk engine and can *quarantine* a decision
  for a human. It can never upgrade a risk block into an approval.
- **Four SHA-256 hash chains** — decision, risk, sentinel, order — make the audit
  log tamper-*evident*: altering or removing a historical record breaks every
  subsequent link, and `verify` says so.
- An **emergency stop** latches and refuses orders, scoped so that one backtest run
  can never be halted by a stop that a different run latched.
- The **dashboard is read-only and loopback-only**, enforced twice: by a predicate
  that resolves no DNS name, and again against the address the socket actually bound.

Zero runtime dependencies. Zero dev dependencies. No build step, no bundler, no
framework, no CDN. `node:sqlite`, `node:test`, `node:http`.

## Quick start

Requires **Node >= 22.5.0** (uses the built-in `node:sqlite`). Nothing to install —
there is no `npm install` step, because there are no dependencies.

```bash
git clone https://github.com/Aymanseif/teos-trade-agent.git
cd teos-trade-agent

npm test        # 211 tests, expect: pass 211, fail 0
npm run verify  # 14 integrity checks over the database
```

Then, in order:

```bash
# 1. Replay history and print the result. Finishes in seconds.
node src/cli.js backtest --ticks 2500

# 2. Look at the account, the run, the risk state, the stop state.
node src/cli.js status

# 3. Run the agent against the simulated venue. Real-time: one tick per second.
node src/cli.js worker --ticks 40

# 4. Read-only dashboard on http://127.0.0.1:8787
node src/cli.js dashboard
```

> On Windows, if PowerShell's execution policy blocks `npm.ps1`, use
> `npm.cmd test` and `npm.cmd run verify`. The project itself is unaffected.

`npm run verify` reports `no balance rows yet` on a fresh checkout, which is a pass —
it means there is nothing to contradict. Run a backtest first if you want the
accounting checks to have something to chew on.

## The three modes

| | **BACKTEST** | **PAPER** | **LIVE** |
|---|---|---|---|
| What it is | historical replay | simulated execution | real money |
| Status | implemented | implemented | **not implemented** |
| Market data | seeded synthetic path | seeded synthetic path | — |
| Venue | in-process mock | in-process mock | — |
| Database | `data/teos-backtest.db` | `data/teos-paper.db` | — |
| Run isolation | one account per run | one continuous account | — |
| Stop scoping | per run | per mode | — |

Modes are isolated by **separate database files** *and* a `mode` column with a
`CHECK` constraint on every table. A backtest result cannot be written into the paper
ledger even by mistake at the storage layer.

The mode badge on the dashboard always reads the real mode. A backtest is never
displayed as a paper trade — that is the single most misleading thing this system
could show, and it has a dedicated regression test.

## How a tick flows

```
  ticks the seeded simulator
            │
            ▼
   ┌─────────────────┐
   │  AgentEngine    │  builds a decision (or HOLD)
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  RiskEngine     │  re-sizes the order from the risk budget,
   │  (19 rules)     │  then checks it; first blocking rule wins
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  Sentinel       │  14 rules, highest-ranked verdict wins;
   │                 │  may BLOCK / REVIEW / WARN / ALLOW
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │ ExecutionAdapter│  last-chance kill-switch check, then submit
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  MockBroker     │  matches, applies fees and slippage, fills
   └────────┬────────┘
            ▼
   rows + four hash chains sealed in SQLite
```

The decision's own quantity is an **input, not an instruction**. `RiskEngine` re-sizes
every order from the risk budget before it is checked, so a strategy that asks for too
much gets a smaller order or a refusal — never an oversized one.

## Safety properties

Each of these is a test, not a promise.

| Property | How it is enforced |
|---|---|
| No real money | No live adapter exists. Three independent refusals: schema `CHECK`, config loader, Sentinel `MODE_GUARD`. |
| No borrowing | Cash may not go negative; enforced by a risk rule and re-derived by `verify`. |
| No leverage | Long-only, cash-funded, fully settled. Equity cannot exceed the configured ceiling. |
| Fails closed | A missing price, a missing portfolio, a missing instrument — all refuse rather than default. |
| No duplicate orders | Deterministic `client_order_id = H(decision_id)`, `UNIQUE`, plus a Sentinel rule. |
| Tamper-evident audit | Four SHA-256 chains; a refused write cannot consume a chain position. |
| Bounded blast radius | A run's stop can only halt that run in BACKTEST; PAPER stays halted by any stop. |
| Read-only dashboard | Method gate (405) *and* a read-only SQLite connection. |
| Loopback only | Host predicate that never resolves a name, re-checked against the bound address. |
| No silent errors | `ERROR`/`FATAL` events are reported by `verify`, not swallowed. |

## Testing

```
211 tests · 211 pass · 0 fail · 0 skipped · 0 todo
```

Run with `npm test` (`node --test --test-reporter=spec "tests/*.test.js"`).

**The 13 required safety scenarios**, one file each:

| # | Scenario | File |
|---|---|---|
| 1 | Insufficient balance | `tests/scenario-01-insufficient-balance.test.js` |
| 2 | Excessive position size | `tests/scenario-02-excessive-position-size.test.js` |
| 3 | Daily loss limit | `tests/scenario-03-daily-loss-limit.test.js` |
| 4 | Stale market data | `tests/scenario-04-stale-market-data.test.js` |
| 5 | Exchange / API failure | `tests/scenario-05-exchange-api-failure.test.js` |
| 6 | Duplicate order prevention | `tests/scenario-06-duplicate-order-prevention.test.js` |
| 7 | Restart recovery | `tests/scenario-07-restart-recovery.test.js` |
| 8 | Emergency stop | `tests/scenario-08-emergency-stop.test.js` |
| 9 | Sentinel block | `tests/scenario-09-sentinel-block.test.js` |
| 10 | Sentinel review | `tests/scenario-10-sentinel-review.test.js` |
| 11 | Invalid order | `tests/scenario-11-invalid-order.test.js` |
| 12 | Unexpected price | `tests/scenario-12-unexpected-price.test.js` |
| 13 | Database / audit integrity | `tests/scenario-13-database-audit-integrity.test.js` |

Plus required regressions A (`/api/snapshot` succeeds) and B (the mode badge reads the
real mode), 19 dashboard HTTP-safety tests, 15 execution/determinism tests, and 70 unit
tests covering every risk rule and Sentinel rule in isolation, their ordering, the
audit chain, the repositories, config, SQL arity, and money rounding.

**Testing principles this suite actually follows:**

- Test **observable safety properties**, not internals. No spies, no assertions on
  private members, no "this internal query ran" checks.
- **Import every constant; never retype it.** A test that hard-codes `500` will
  silently rot the day someone tunes the config.
- **Never weaken validation to make a test pass.** When a test disagreed with the
  code, the *test* was corrected — and the real behaviour documented in a comment.
- **Every regression test proves it can fail.** Each one was checked by reverting the
  fix and watching the intended test go red. A test that cannot detect its own bug is
  not a test.
- **No network, no exchange, no API keys, no external services.** No skipped tests and
  no broad exception swallowing — a swallowed failure is a silent hole.

## Measured results

The pinned canary — seed `20260928`, 2500 ticks, default config:

```
agent decisions          18
orders submitted         16
fills                    33
net P&L after costs    EGP -3.55
total return            -0.71%
annualised return       n/a (span too short to annualise)
```

**This is a plumbing check, not a performance claim.** It exists to prove the pipeline
is deterministic and the costs are actually charged — and the result is negative. Fees
and slippage are deducted on every fill, not assumed away.

The identical run reproduces exactly, byte for byte, and is asserted as a canary so
that any future change which moves these numbers fails the suite loudly. A **different
seed produces different prices from the very first tick** — that negative control is
what stops a "deterministic" test from passing against a frozen simulator.

Do not extrapolate from a single seed on a synthetic path. There is no statistical
significance here and no basis for a forward-looking statement.

## Operator commands

All of these were read out of `src/cli.js` and executed, not reconstructed from memory.

| Command | Does |
|---|---|
| `node src/cli.js worker` | Run the agent, one tick per second, until stopped |
| `node src/cli.js worker --ticks N` | …for N ticks, then shut down cleanly |
| `node src/cli.js dashboard` | Read-only dashboard on `127.0.0.1:8787` |
| `node src/cli.js backtest --ticks N` | Historical replay |
| `node src/cli.js simulate` | Replay without persisting |
| `node src/cli.js status` | Account, run, agent, risk and stop state |
| `node src/cli.js health` | Worker liveness and heartbeat staleness |
| `node src/cli.js kill-switch` | Latch an emergency stop — refuses all new orders |
| `node src/cli.js reset-stop` | Clear a latched stop (deliberate; check `status` first) |
| `node src/cli.js hold` | Set `TRADING_HOLD` — **blocks all orders, exits included** |
| `node src/cli.js resume` | Clear `TRADING_HOLD` |
| `node src/cli.js verify` | Run the 14 integrity checks |

`--mode BACKTEST\|PAPER` is honoured by `status`, `health`, `kill-switch`,
`reset-stop`, `hold`, `resume` and `verify`.

> **`hold` has no reduce-only exemption.** A stop-loss that triggers while the hold is
> on cannot execute, and the blocked exit latches a `STOP_EXIT_BLOCKED` emergency stop.
> To refuse new entries while still allowing exits, use the emergency stop, which is
> `NEW_ORDERS`-scoped. See [Known gaps](#known-gaps-and-limitations).

## Configuration

`config/default.json`, frozen at load. **No secrets are read or accepted** — the loader
calls `assertNoCredentialsPresent()` and refuses to start if any credential variable is
non-empty.

The paper envelope, all user-approved and all enforced by a risk rule:

| Limit | Value |
|---|---|
| Capital ceiling | EGP 500 |
| Max loss per trade | 1% (EGP 5) |
| Daily loss limit | 5% (EGP 25) |
| Max exposure | 50% (EGP 250) |
| Max position | 25% (EGP 125) |
| Max open positions | 3 |
| Max orders / day | 60 |
| Stop-loss required | yes, default 1.5% (min 0.25%, max 5.0%) |
| Min risk/reward | 0.8 |
| Price deviation limit | 150 bps |
| Max spread | 60 bps |
| Max data staleness | 15s |
| Halt after N consecutive failures | 3 |

Costs are charged, never assumed: 10 bps taker/maker, EGP 0.05 minimum fee, slippage
2 bps base scaling with impact up to 50 bps.

Data lives in `data/`, logs in `logs/`. Both, plus `*.db`, `*.lock` and `.env`, are
git-ignored.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The pipeline, the data model, the audit chain, module by module |
| [`docs/RISK_POLICY.md`](docs/RISK_POLICY.md) | Every limit, and **only the limits that are actually enforced** |
| [`docs/TRADING_POLICY.md`](docs/TRADING_POLICY.md) | What the agent may and may not do, per mode |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Credential policy, loopback binding, audit integrity, threat assumptions |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operating it: daily procedures, emergency stop, diagnostics, known failure modes |

## Known gaps and limitations

Listed honestly, because a public project that hides these is worse than one that
names them. The roadmap below says what happens to each.

**Will stop a user cold:**

- **`dashboard.tokenEnvVar` is misleading.** `config/default.json` advertises
  `tokenEnvVar: "TEOS_DASHBOARD_TOKEN"`, implying you can switch on authentication. You
  cannot — and setting that variable makes the application **refuse to start**, because
  Phase 1 forbids credentials. The key should be removed or the feature implemented.
- **The dashboard has no authentication.** Loopback-only binding is the mitigation, and
  it is enforced, but DNS-rebinding is a real threat class for loopback services and a
  Host-header check alone is a thin defence.

**Correctness and clarity:**

- **`hold` blocks stop-losses** (see above). It needs a reduce-only mode, or an
  explicit documented decision not to have one.
- **Four config keys are read by nothing**: `worker.heartbeatIntervalCycles`,
  `worker.maxDecisionsPerTick`, `autoResetDailyLossAtUtcMidnight`, and
  `sentinel.freshnessWarnPctOfLimit`. They look load-bearing and are not.
- **Money rounding tie rules disagree.** `roundEgp`/`toMinor` break a half-piastre tie
  toward +∞ for both signs; `roundTo` in the same module breaks it away from zero. It is
  bounded and cannot flip a sign, but reconciling it would re-round every stored figure
  in every existing database, so it needs a deliberate migration.
- **`sessionStop()` degrades silently.** A BACKTEST `Repos` with a null `runId` falls
  back to the mode-wide query and can be halted by another run's stop. Every production
  caller sets a run id, so it is a caller error — but nothing enforces it.
- **`--warmup` is accepted and then ignored.** `simulate` is missing from the CLI help.
- **An `ALLOW` verdict is attributed to the first rule in the registry**, so
  `trigger_rule` reads `MODE_GUARD` on every passing order. The data is misleading even
  though the behaviour is right.
- **`VERDICTS.REVIEW` is never emitted** by the risk engine, though the schema permits it.
- **Dead code**: `mock-broker.js` `reconcileOrphans()`, and a dead ternary in
  `firewall.js`.
- **No CI.** Nothing runs the suite on push.
- **`ExperimentalWarning: SQLite`** is printed on every command.
- **Stale documentation**: `docs/ARCHITECTURE.md` claims `SECURITY.md` does not exist,
  lists a `run` command that does not, and says `verify` runs ten checks when it runs
  fourteen. `docs/RUNBOOK.md` maintains a running list of code-vs-documentation
  discrepancies.
- **No `LICENSE`.** `package.json` says `UNLICENSED`, which means nobody may legally use
  this. A license must be chosen before publication.

**Not gaps, but worth stating:**

- The strategy is **loss-making** on the only long run anyone has measured.
- There is **no statistical study** — one seed, one path, one regime.
- The price generator is **synthetic**. It is not calibrated to any real instrument and
  has no fat tails, no gaps, and no regime changes beyond what it is scripted to produce.

## Roadmap to public release

The plan for taking this private repo public — **after you have run it and used it
yourself**, which is the right order. Public is a one-way door: once the code is
indexed and forked, the mistakes in it are permanent, and this project is exactly the
kind whose reputation depends on not overselling.

**The rule for this section: a public release must not make a single claim that the
code cannot defend.** Every item below is about making the code and the words agree.

### Stage 0 — You use it (no code changes)

Run it for a few weeks. Backtest across many seeds, not one. Watch the dashboard. Halt
it with the emergency stop and confirm it really stops. Restart it mid-run and confirm
recovery. Keep a list of every moment it confused you — **that list is the real
roadmap**, and it will be more accurate than anything below.

Exit criteria: you can explain, without looking at the code, what every number on the
dashboard means and what the agent is allowed to do.

### Stage 1 — Remove the traps (P0, before anyone else runs it)

- [ ] **Choose a license.** Blocks everything else legally. `UNLICENSED` is not a license.
- [ ] **Fix `dashboard.tokenEnvVar`** — delete the key, or implement the token.
- [ ] **Add GitHub Actions CI** running `npm test` and `npm run verify` on every push
      and PR, on Node 22.
- [ ] **Delete or wire the four dead config keys.** A knob that does nothing is a lie.
- [ ] **Reconcile the documentation** against the code, and add a test that fails when
      the two drift. `docs/RUNBOOK.md`'s discrepancy list should reach zero.
- [ ] **Suppress the `ExperimentalWarning`** and stop shipping a warning on every command.
- [ ] **Add `SECURITY.md` at the repo root** with a real disclosure route, and
      `CONTRIBUTING.md`.

Exit criteria: a stranger can clone, `npm test`, read the README, and not be misled by
anything they find.

### Stage 2 — Close the safety gaps (P1)

- [ ] **Decide `hold` semantics.** Recommend a reduce-only exemption: a hold that
      cannot stop a stop-loss is not a hold, it is a trap. If the answer is "no", make
      the refusal explicit and loud at the moment it happens, not just in the docs.
- [ ] **Guard `sessionStop()` against a null `runId` in BACKTEST** — throw rather than
      silently widen the scope.
- [ ] **Reconcile the money rounding tie rules**, with a migration and a test that
      pins the old stored values.
- [ ] **Fix the `ALLOW` attribution** so `trigger_rule` is `null`, not `MODE_GUARD`.
- [ ] **Remove the dead code**; make `--warmup` work or remove it; add `simulate` to help.
- [ ] **Harden the dashboard**: strict `Host` header validation against DNS-rebinding,
      and consider an optional local token. Loopback-only is necessary, not sufficient.
- [ ] **Emit or remove `VERDICTS.REVIEW`.**

Exit criteria: a reviewer cannot find a path where the system does something other than
what the documentation says.

### Stage 3 — Earn the right to a performance claim (P2)

- [ ] **A real evaluation harness**: many seeds, multiple regimes, walk-forward splits,
      and reported distributions — not one number.
- [ ] **Calibrate or replace the synthetic generator**, or state prominently and
      permanently that results are from a toy path.
- [ ] **Publish results whatever they are.** If the strategy is still negative after a
      proper study, the README says so, in the first screen, forever. A trading project
      that quietly deletes its losing backtest has become a scam with a commit history.
- [ ] **Add a `LIVE` design document** — still not a LIVE adapter. Specify what would
      have to be true, what would refuse to work, and what the kill switch means when
      the venue is real.

Exit criteria: any performance statement in the repo is backed by a script anyone can
re-run.

### Stage 4 — Publish (P3)

- [ ] Security review of the dashboard and the loopback surface by someone who did not
      write it.
- [ ] First tagged release, `v0.1.0`, with release notes that list every known gap
      rather than summarising them away.
- [ ] Keep the three refusals that make LIVE impossible. **They are the product.**

### Never, at any stage

- Do not market this as profitable until a study says so, and do not let a single good
  run stand in for a study.
- Do not add exchange connectivity without a written kill-switch design, a manual
  approval gate, and a hard cap that is enforced outside the agent's own process.
- Do not remove the `mode` column, the `CHECK` constraints, or the three independent LIVE
  refusals. They cost nothing and they are the reason the project is trustworthy.
- Do not let "autonomous" outrun "verifiable". If a claim cannot be turned into a test,
  it does not go in the README.

## Status

**Phase 1, private, pre-release.** 211 tests passing, 14 integrity checks passing,
13 safety scenarios covered, five operational documents written. No live execution, no
exchange connectivity, no real capital, no claim of profitability.

The strategy loses money on the only long run that has been measured. That is stated
here on purpose, and it will stay in the README whatever happens next.

---

*TEOS Trade Agent — Phase 1. Paper only. Long-only, cash-funded, no leverage, no
borrowing, no derivatives. LIVE is not implemented.*
