# TEOS evaluation harness (`eval/`)

A measurement harness. Its purpose is to produce numbers that can be **reviewed
before anything is changed** in the trading system.

**It is not a trading system, not a deployable, and not a strategy.** It runs
PAPER=simulated backtests against synthetic price paths and prints tables.

---

## Hard rules this harness obeys

| Rule | How it is enforced |
|---|---|
| Call the real engine. No reimplementation of logic. | `eval/driver.js` is the only module that touches `src/`, and it constructs the real `generateHistory` → `ReplayFeed` → `BacktestEngine` → `Worker` → `RiskEngine` → `Sentinel` → `MatchingEngine` → `Ledger` pipeline. Entry logic, exit logic, risk sizing, execution and accounting all come from `src/`. |
| Never write `config/default.json`. | Every experimental condition is an in-memory override passed to `loadConfig({ overrides })`, which deep-merges and then deep-freezes. A run physically cannot mutate shipped policy. |
| One production change only. | See below. Everything else lives in `eval/`. |
| No parameter tuning. | Arms sweep and compare. Nothing is tuned, ranked for selection, or optimised. |

## The one production change

`Worker` built its `MockBroker` with `seed: this.#config.market.seed`
unconditionally, while `generateHistory` received a per-run seed. In a
multi-seed study the price path varied but **slippage jitter, partial-fill
ratios and spread noise replayed as one identical stream**, so the runs were not
independent.

`seed = null` was therefore threaded through `runBacktest` → `BacktestEngine` →
`Worker` → `MockBroker`. `null` falls back to `config.market.seed`, so every
existing caller is bit-identical. This is verified, not asserted: see
*Verification* below.

```
src/backtest/engine.js  +7 -2
src/worker/worker.js    +8 -2
```

## Running it

```bash
node eval/run.js --seeds 20 --workers 3 --json study.json
node eval/run.js --seeds 5 --groups stop-sweep,take-profit
node eval/run.js --seeds 200 --workers 3 --json full.json
node eval/run.js --render-from full.json      # re-render without re-running
```

| Flag | Meaning |
|---|---|
| `--seeds N` | independent price paths per arm |
| `--seed-base N` | first seed; runs `base .. base+N-1` |
| `--project-seeds N` | seed count the timing estimate is stated against (default 200). Affects only the printed estimate, never how many paths run. |
| `--ticks N` | ticks per path (default 2500) |
| `--workers N` | concurrent run **processes** |
| `--groups a,b` | restrict to arm groups |
| `--json PATH` | write the raw study (written *before* rendering) |
| `--render-from PATH` | re-render a saved study, run nothing |
| `--checkpoint PATH` | durable per-run record; **the authoritative progress store** |
| `--resume` | schedule only the `(arm, seed)` pairs not already completed |
| `--retry-failed` | with `--resume`, also rerun pairs whose last attempt failed (off by default) |
| `--force-new-study` | start a fresh checkpoint at the same path, discarding existing records |
| `--timeout-ms N` | per-run wall-clock limit (default 600000) |
| `--in-process` | debug only; leaks a SQLite handle per run on Windows |
| `--quiet` | suppress per-run progress. Never suppresses a failure diagnosis or a reconciliation count. |

### Recommended invocation

```bash
node eval/run.js --seeds 20 --workers 2 --checkpoint pilot20.ndjson \
  --json pilot20.json --project-seeds 200
# if interrupted, continue where it stopped:
node eval/run.js --seeds 20 --workers 2 --checkpoint pilot20.ndjson --resume \
  --json pilot20.json --project-seeds 200
```

## Durability: the checkpoint

The first 20-seed pilot completed **293 of 360 runs**, lost its parent process,
and produced **nothing**. Results were aggregated in memory and the JSON written
once at the end; progress lived only in a log file. A log is an event stream, not
a state store — once the writer is dead you cannot tell a completed run from a
pending one — so neither the results nor the progress could be recovered.

Every terminal outcome is therefore appended **synchronously**, before the next
job starts, so the bytes are on disk before any further compute happens.

### Format

`<path>` is newline-delimited JSON, one record per line, appended:

```jsonc
{ "kind": "run", "arm": "tp-2R", "seed": 20260941, "status": "completed",
  "at": "...", "attempt": 1, "durationMs": 34120, "telemetry": { /* ... */ },
  "result": { /* the run summary the study already used */ } }
{ "kind": "run", "arm": "tp-2R", "seed": 20260944, "status": "failed",
  "at": "...", "attempt": 1, "durationMs": 600000,
  "error": "timed out after 600000 ms", "exitCode": null, "signal": "SIGKILL",
  "timedOut": true, "stderr": "", "stderrUnavailable": true, "stdoutTail": "" }
{ "kind": "fatal", "reason": "uncaughtException", "completed": 293, "failed": 6,
  "pending": 61, "expected": 360, "checkpointPath": "...", "workers": 2 }
```

`<path>.meta.json` holds the study identity, written with atomic replacement.

### Rules

- **A completed result is immutable.** A second one for the same `(arm, seed)`
  throws `DuplicateResultError` rather than overwriting a measurement.
- **A failed pair is not retried by default.** `--retry-failed` is required. A
  silent retry would let one flaky path count as a second independent observation.
- **A torn final line is discarded, not fatal.** Only the last line can be torn;
  everything before it was already flushed. Corruption in the *middle* throws
  `CheckpointCorruptError`, because then it is unknown which records survived.
- **A foreign checkpoint is refused.** The identity is a hash of the arm set,
  the seeds and the tick count. It deliberately excludes worker count, checkpoint
  path and wall clock, so resuming a 3-worker crash at 2 workers still works —
  worker count changes throughput, not measurement.
- **`--quiet` cannot hide a failure.** A study that lost runs must be able to say
  so even when asked to be quiet.

### What it cannot do

Node cannot run code after `SIGKILL`, a power loss, or an OOM kill from outside
the process, so the `kind: "fatal"` record is a convenience, not a guarantee. The
per-run records are the guarantee — which is why each one is written on its own
rather than at the end. `eval/tests/durability.test.js` includes a test that
`SIGKILL`s a live study mid-run and asserts every recorded result survives and
the study resumes.

## Why one process per run

`Worker.stop()` releases the worker lock and disconnects the broker, but it
**never closes the SQLite handle**, and `Worker` exposes no `close()`. In one
long-lived process every run leaks an open database file: an 18-arm, 200-seed
study is 3,600 runs, ~4.2 MB of database each, so up to ~15 GB under `%TEMP%`.

Rather than edit production code to serve a measurement tool, each run gets its
own child process. Process exit closes the handle, after which the parent
deletes the run's directory. The same isolation makes the study embarrassingly
parallel. `eval/tests/isolation.test.js` pins both properties.

**The child must put its workspace INSIDE the parent's scratch directory.** The
first implementation had the child create its `TEOS_DATA_DIR` as a *sibling* of
the pool's scratch directory, so the parent's single cleanup removed the job and
result files but not the database. 340 runs leaked 309 databases — about
1.9 GB — and the first 20-seed pilot died at run 175/340 having produced no
report at all. `workspaceParent` now threads the scratch path into
`createWorkspace`, and the isolation test fails if any directory is left behind.

## Per-run database isolation

`AgentEngine.breachedStops()` picks the governing stop price with a query that
has **no `run_id` predicate**, and every backtest starts its `ManualClock` at
the same `startMs`, so `ts_ms` collides across runs. The query is **not** fixed
here — it is production behaviour. Instead each run gets its own `TEOS_DATA_DIR`
(own database *and* own worker lock), which makes the hazard unreachable.
`eval/tests/isolation.test.js` fails if anyone optimises that away.

## Arms

| Group | Arms | What it measures |
|---|---|---|
| `baseline` | `base` | production config, unmodified |
| `stop-sweep` | `stop-0.25` … `stop-5` | effective stop pinned to 0.25–5% of price |
| `stop-sweep-atr` | `atr-0.5` … `atr-4` | ATR-binding stops, with the policy floor **lowered via override only** |
| `take-profit` | `tp-1R`, `tp-1.5R`, `tp-2R` | does adding the missing target change anything? |
| `control` | `random-entry`, `buy-and-hold` | does the entry signal have any edge at all? |
| `control-v1` | `random-entry-v1` | **not a control.** The original, flawed `random-entry`, retained only so the report can show the measured size of the flaw |

An ATR stop is expressed as a percent of price by pinning the band to
`[x, x, x]`; the strategy still computes its ATR stop and the risk engine still
clamps it. The report prints the **measured** effective stop, so a stop clamped
up to the floor is visible rather than assumed.

### `random-entry` is the control, and a control must change exactly one thing

`random-entry` keeps the production exits and changes only the entry. That
forces three properties, and the first implementation of this arm had all three
wrong — in the same direction:

1. **the crossover's own entries must be suppressed.** The original returned
   sma_cross's `BUY` unchanged, so the "random" arm kept the crossover's edge;
2. **the random entry must carry the same stop a crossover entry would.** The
   original copied `stopPrice` off a `HOLD` signal, where sma_cross returns
   `null`, so the risk engine fell back to `defaultStopDistancePct` = 1.5% —
   six times wider than the 0.25% floor real entries are clamped to;
3. **entries must be able to recur.** The original had a one-shot `fired` latch,
   so at most one random entry occurred in the entire run.

All three biases made the control look *more* like the real strategy, so the
original understated how much of the loss comes from entry selection and
overstated how much comes from costs. `random-entry-v1` keeps the broken version
so section 5b of the report can show the gap, and `eval/tests/controls.test.js`
fails if either arm is relabelled or if the two are silently made equivalent.

### The three harness strategies are measurement overlays

`registerStrategy` is a public seam, so `take-profit`, `random-entry` and
`buy-and-hold` are registered from `eval/` and reach the real risk, Sentinel,
firewall, matching and accounting path. They are **not** shippable strategies:
a take-profit needs the entry's risk unit in memory, which a pure production
strategy is forbidden from keeping (`strategy.interface.js`). That deviation is
the honest cost of measuring the missing-target hypothesis.

## Things the report will tell you it cannot support

These are printed in every report, section 8, and are not decoration:

- The data is **synthetic**. Volatility comes from `instruments[].annualVolPct`
  in config, not from any market.
- A 2,500-tick path is **83 bars**, of which **43** can produce a decision
  (`minBars: 40`). At 1,200 ticks a run produces **literally zero trades**.
- Per-seed trade counts cannot support an expectancy estimate, so all trade
  statistics are **pooled across seeds** and per-seed figures are reported as
  distributions, never means.
- Stop distance does **not** control position size (size is bound by
  `maxPositionSizeEgp`), so the stop sweep measures exit timing and P&L, **not
  risk**.
- Regime tags are **percentile ranks within each synthetic path**, not measured
  market regimes. Absolute thresholds were rejected because absolute volatility
  here is a config value.

## Verification

```bash
node --test --test-reporter=tap "eval/tests/*.test.js"
```

46 tests. The ones that matter:

- `reproduction.test.js` — the harness recreates the protected canary
  (seed 20260928, 2500 ticks) **to the cent**: net −3.55, closed −3.47,
  −0.71%, 0.71% max DD, 7 trades, 0.00% win, expectancy −0.50, fees 2.45,
  slippage 1.05, and 18/16/33 decisions/orders/fills. **If this fails, no other
  number in this harness can be trusted.**
- `determinism.test.js` — same (arm, seed) is byte-identical; different seeds
  differ; and the *fee/slippage stream* differs, which proves the broker's RNG
  was reseeded rather than only the price path.
- `seed-threading.test.js` — `seed: null` reproduces an unseeded run exactly, and
  a run seeded with `config.market.seed` matches it too.
- `isolation.test.js` — no two runs share a database; the pool leaks no
  directories.
- `units.test.js` — the arithmetic, including that net expectancy is computed
  from net (not gross) P&L, and that a decomposition which swallows its own
  answer is flagged rather than presented as clean.

The full production suite (`node --test --test-reporter=tap "tests/*.test.js"`)
must also stay at 211/211.

## Layout

```
eval/
  run.js          CLI and study assembly
  pool.js         one child process per run, concurrency, failure reporting
  child.js        single-run entry point
  driver.js       THE ONLY module that calls src/
  workspace.js    per-run temp TEOS_DATA_DIR
  arms.js         arm definitions + the three harness strategies
  summary.js      full run -> compact JSON-serialisable record
  regimes.js      TREND/RANGE and HIGHVOL/LOWVOL percentile tagging
  stats.js        pooled and per-run statistics
  costs.js        gross vs net decomposition
  losses.js       ranked causes of loss, from measured EGP only
  report.js       text rendering
  checkpoint.js   durable per-run record, resume, study identity
  telemetry.js    lightweight host/parent/child resource snapshots
  tests/          96 tests
    checkpoint.test.js    the durability contract, unit
    durability.test.js    the CLI and pool, end to end
```
