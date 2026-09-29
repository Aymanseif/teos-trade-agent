# TEOS Trade Agent — Risk Policy

The limits that are actually enforced on every simulated order, the order in
which they are evaluated, and the conditions under which the system refuses to
proceed. This document describes what the code does. Where a source-file comment
disagrees with the code, the code is what is documented here.

Document status: accurate to `configVersion: 1`, profile
`phase1-paper-defaults`. Every value in this document is either read from
`config/default.json` or derived from it by code cited inline.

---

## 0. Read this first

> **NO REAL MONEY, NO REAL ACCOUNT, NO REAL VENUE.**
>
> There is no component in this repository that can place an order with a real
> broker. The only broker that exists is an in-process simulator
> (`src/broker/mock/mock-broker.js`), and `registerBroker()` in
> `src/broker/broker.interface.js:59-63` throws for any broker whose
> `kind !== 'PAPER'`.

Three statements belong in the same place as the limits.

1. **EGP 500 is a configured paper-account ceiling.** It is
   `account.startingCapitalEgp` (the value a fresh PAPER account is seeded
   with) and `risk.maxStartingCapitalEgp` (the ceiling the risk engine enforces
   against). Both are numbers in a JSON file and integers in a simulated
   ledger. No EGP exists on either side of any trade in this system. Nothing has
   been deposited, nothing can be withdrawn, and there is no account at any
   venue to deposit into.

2. **Leverage, margin, borrowing, futures and derivatives are impossible by
   construction, not by configuration.** The account is long-only and
   cash-funded. The flags that would express them are hard-coded `false` in
   `src/execution/execution-adapter.js:85-90`, validated again in
   `src/execution/validator.js:36-42`, and refused again at the broker
   (`src/broker/mock/mock-broker.js:467-469`). No code path in this repository
   sets any of them to `true`. Section 2.2 gives the mechanism.

3. **This policy does not make the strategy profitable.** The active strategy
   is currently slightly loss-making on the reference runs. Risk limits bound
   the damage an order can do; they do not make the underlying decision
   correct. `docs/TRADING_POLICY.md` states the measured result.

### Terminology

These three words are used precisely and are not interchangeable.

| Term | Meaning here |
|------|--------------|
| **PAPER** | Simulated execution against the in-process market simulator. A real process, a real SQLite database, a real order lifecycle. No real money, no external venue. |
| **BACKTEST** | Replay of a generated or recorded price path through the same worker loop and the same pipeline, into a separate database. |
| **LIVE** | Real capital at a real venue. **Not implemented.** No adapter, no credential path, no network call. `TEOS_MODE=LIVE` throws at startup (`src/core/env.js:99-110`). |

Risk documents describe PAPER and BACKTEST identically: the same
`RiskEngine`, the same rules, the same limits. Only the price source and the
database file differ.

---

## 1. Where enforcement lives

Every order passes through four independent components. Each one can refuse on
its own, and a refusal at any one of them is final.

| # | Component | Source | Can refuse because |
|---|-----------|--------|--------------------|
| 1 | Risk engine, 19 ordered rules | `src/risk/risk-engine.js`, `src/risk/rules/index.js` | A limit is breached, data is unusable, or the account is inconsistent |
| 2 | TEOS Sentinel, 14 rules | `src/execution/sentinel.js` | The decision is odd, out of band, or the mode is wrong |
| 3 | Execution adapter + validator | `src/execution/execution-adapter.js`, `src/execution/validator.js` | The order shape is invalid, a feature is prohibited, or an emergency stop is active |
| 4 | Mock broker + matching engine | `src/broker/mock/mock-broker.js`, `.../matching-engine.js` | Leverage or borrowing is requested, the symbol is unknown, or the fill is impossible |

The pipeline that connects them is `ExecutionFirewall.execute()`
(`src/execution/firewall.js:85`), and it is the only exported function in the
repository that calls `adapter.submit()`.

---

## 2. The account envelope

### 2.1 The EGP 500 paper-account ceiling

| Setting | Value | Enforced by | What happens on breach |
|---------|-------|-------------|------------------------|
| `account.startingCapitalEgp` | `500` EGP | `validateConfig()` — `src/core/config.js:51` (`min: 1, max: 500`) | Boot refused if outside 1–500 |
| `risk.maxStartingCapitalEgp` | `500` EGP | `validateConfig()` — `src/core/config.js:58-61`; explicit `> 500` refusal at `:59` | Boot refused if above 500 |
| `account.startingCapitalEgp > risk.maxStartingCapitalEgp` | — | `src/core/config.js:62-67` | Boot refused |
| `Ledger` constructor | — | `src/paper/ledger.js:25` | Throws `InsufficientBalanceError` if starting capital is not positive |

`MAX_CAPITAL` (`src/risk/rules/index.js:181-203`) enforces the ceiling at
order time with three separate branches. They are ordered, and each has its own
severity:

| Order | Condition | Message basis | Outcome | Severity | Latches stop |
|-------|-----------|---------------|---------|----------|--------------|
| 1 | `equityEgp > 500 × 1.5` (i.e. `> 750.00`) | Equity is far above the cap; the account state is inconsistent | BLOCK | `CATASTROPHIC` | yes |
| 2 | `startingCapitalEgp > 500` | Starting capital exceeds the maximum | BLOCK | `CATASTROPHIC` | yes |
| 3 | `equityEgp <= 0` | Account is exhausted | BLOCK | `CRITICAL` | yes |

Branch 1 uses a `× 1.5` multiplier deliberately, so ordinary equity drift
(including a profitable run) does not trip it. Branch 2 catches a cap edit.
Branch 3 catches an exhausted account.

### 2.2 Long-only and cash-funded: the mechanism

"No leverage" and "no borrowing" are not two more configured limits sitting
next to the others. They are consequences of two design decisions, enforced in
four places.

**The two design decisions.**

| Decision | Where | Consequence |
|----------|-------|-------------|
| Cash is debited for the full notional plus fee on every BUY fill | `Ledger.applyBuyFill()` — `src/paper/ledger.js:68-81` | A position is only as large as the cash on hand. There is no margin balance to draw on. |
| A SELL reduces or closes an existing long, and throws if there is none | `PaperAccount.applyFill()` — `src/paper/paper-account.js:98-105` | A short position cannot exist, so there is nothing to owe. |

**The four enforcement points.**

| # | Point | Behaviour | Source |
|---|-------|-----------|--------|
| 1 | `NO_LEVERAGE` risk rule | BLOCK, `CATASTROPHIC`, latches a stop, if `leverageRequested \|\| borrowRequested \|\| derivative` | `src/risk/rules/index.js:47-59` |
| 2 | Adapter order construction | `leverageRequested`, `borrowRequested`, `marginRequested`, `shortRequested` are literal `false`; `instrumentType: 'SPOT'` | `src/execution/execution-adapter.js:85-90` |
| 3 | Order validator | Independent rejection of any of those four being `true`, and of `orderType === 'DERIVATIVE'`, `instrumentType` of `FUTURE` or `PERPETUAL` | `src/execution/validator.js:36-42` |
| 4 | Broker boundary | `MockBroker.placeOrder()` throws `ValidationError` if `leverageRequested === true \|\| borrowRequested === true` | `src/broker/mock/mock-broker.js:467-469` |

A fifth, structural point: the validator refuses any order whose
`quantity × expectedPrice` exceeds `account.cashEgp`
(`src/execution/validator.js:87-92`), and the broker's fill guard caps a BUY
fill to what cash can actually pay for
(`src/broker/mock/mock-broker.js:140-164`, reason
`FILL_CAPPED_TO_CASH` / `INSUFFICIENT_CASH_TO_FILL`).

The `RiskLimits` object exposes these as frozen, non-configurable fields
(`src/risk/limits.js:58-66`): `allowLeverage`, `allowBorrowing`,
`allowShorting`, `allowDerivatives`, `allowNegativeCash` are all `false`, and
the object is `Object.freeze`d at construction. There is no code path that
mutates them.

### 2.3 Sizing: the agent proposes, the risk engine sizes

The agent never chooses a quantity. `RiskEngine.proposeOrder()`
(`src/risk/risk-engine.js:97-199`) builds the concrete order:

| Step | Rule | Source |
|------|------|--------|
| Risk budget | `min(configured per-trade cap, equity × requested %)` | `effectiveRiskBudget()` — `src/risk/limits.js:83-91` |
| Stop price | Strategy stop, or `price × (1 − defaultStopDistancePct/100)`, then clamped into `[minStopDistancePct, maxStopDistancePct]` | `src/risk/risk-engine.js:155-161`, `clampStopToBand()` at `:59-68` |
| Quantity | `riskBudget / (price − stopPrice)`, floored to `qtyStep` | `sizePosition()` — `src/paper/pnl.js:130-166` |
| Notional cap | `min(maxPositionSizeEgp, maxPortfolioExposureEgp − exposureEgp, cashEgp)` | `src/risk/risk-engine.js:163-167` |
| Cash cap | `cash / (1 + feeBps/10000)`, so notional **and** fee must fit | `src/paper/pnl.js:141-143` |
| Rejections below minimum | `qty < minQty` → quantity 0, reason `BELOW_MIN_QTY`; `notional < minOrderNotionalEgp` → quantity 0, reason `BELOW_MIN_NOTIONAL` | `src/paper/pnl.js:153-159` |

The proposal records which bound applied (`RISK`, `MAX_NOTIONAL` or `CASH`) and
whether the stop was clamped. The same pure function is called again inside the
firewall, so the quantity in the immutable decision record is the quantity that
is validated and, if everything else passes, submitted.

---

## 3. How a configured limit becomes an effective limit

Four limits are configured twice: once in EGP and once as a percentage. The
percentage is resolved against `equityRef`, which is
`config.account.startingCapitalEgp` — **not** current equity
(`src/risk/limits.js:18`). The tighter of the two wins, so editing a
percentage upward cannot loosen the effective cap
(`src/risk/limits.js:8-11`).

| Configured keys | EGP value | Percentage value | Percentage equivalent at equityRef 500 | Effective |
|-----------------|-----------|------------------|----------------------------------------|-----------|
| `maxLossPerTradeEgp` / `maxLossPerTradePct` | `5.0` | `1.0` | `500 × 1.0% = 5.00` | `5.00` EGP |
| `dailyLossLimitEgp` / `dailyLossLimitPct` | `25.0` | `5.0` | `500 × 5.0% = 25.00` | `25.00` EGP |
| `maxPortfolioExposureEgp` / `maxPortfolioExposurePct` | `250.0` | `50.0` | `500 × 50% = 250.00` | `250.00` EGP |
| `maxPositionSizeEgp` / `maxPositionSizePct` | `125.0` | `25.0` | `500 × 25% = 125.00` | `125.00` EGP |

**In the shipped configuration all four pairs are exactly equal.** Which of the
two wins is therefore not observable today; the `min()` only becomes
load-bearing if a config is edited. Every effective value below is what the
code computes, not what one of the two inputs happens to say.

The `RiskLimits` instance is snapshotted into every `risk_decisions` row
(`limits_json`, `src/risk/risk-engine.js:317`), so an audit reader can see the
exact envelope in force at the moment an order was permitted or refused.

### Percentage comparison tolerance

`PCT_EPSILON = 1e-6` percentage points is applied to the `EXPOSURE` and
`STOP_CONDITION` band comparisons (`src/risk/rules/index.js:26-39`). The
reason is arithmetic, not slack: prices are stored rounded to 8 decimals and the
rules re-derive percentages from those prices, so a stop placed exactly at the
policy minimum lands a few `1e-8` points either side of the limit. `1e-6`
percentage points is `0.0001` bps; the smallest tick in the instrument universe
is `0.0001` on a price of `48.75`, which is `0.0002%` — two hundred times
larger — so the tolerance cannot mask a genuine breach.

`RISK_PER_TRADE` uses a separate absolute tolerance of `1e-9` EGP
(`src/risk/rules/index.js:401`).

---

## 4. Enforced limits

Every row below is a comparison that appears in code and has an observable
effect. Settings that are configured but never compared are in section 9.

### 4.1 Absolute prohibitions

| Rule | Condition | Outcome | Severity | Latches stop |
|------|-----------|---------|----------|--------------|
| `NO_LEVERAGE` | `leverageRequested \|\| borrowRequested \|\| derivative` | BLOCK | `CATASTROPHIC` | yes |
| `KILL_SWITCH` | `killSwitch.engaged` | BLOCK | `CATASTROPHIC` | **no** |
| `AGENT_STATE` | `agentState === 'UNDEFINED' \|\| agentState == null` | BLOCK | `CATASTROPHIC` | yes |
| `AGENT_STATE` | no permission matrix supplied on the decision | BLOCK | `CATASTROPHIC` | yes |
| `AGENT_STATE` | side `SELL` and `permissions.reduceOnly !== true` | BLOCK | `CRITICAL` | no |
| `AGENT_STATE` | side `BUY` and `permissions.openPosition !== true` | BLOCK | `CRITICAL` | no |

`NO_LEVERAGE` is first in the array and the risk engine always populates
`leverageRequested: false`, `borrowRequested: false`, `derivative: false` in
the rule context (`src/risk/risk-engine.js:229-231`), so in normal operation it
always passes. It is a backstop against a context constructed elsewhere.

`KILL_SWITCH` does not latch: the stop is already engaged by whatever latched
it, and the rule's job is only to report that fact.

The permission matrix is a frozen table in `src/agent/state.js:41-49`, and
`permissionsFor()` returns all-`false` for an unrecognised state
(`src/agent/state.js:51-54`), so an undefined state fails closed at the source
as well as in the rule.

| State | evaluate | open position | reduce only |
|-------|----------|---------------|-------------|
| `STARTING` | no | no | no |
| `WARMUP` | no | no | no |
| `HEALTHY` | yes | yes | yes |
| `DEGRADED` | yes | no | yes |
| `HALTED` | no | no | yes |
| `STOPPED` | no | no | no |
| `FAILED` | no | no | no |
| anything else | no | no | no |

### 4.2 Connectivity

`CONNECTION` — `src/risk/rules/index.js:107-129`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| no `brokerHealth` object at all | — | BLOCK | `CRITICAL` | yes |
| `consecutiveFailures >= consecutiveFailureHaltCount` | `3` | BLOCK | `CRITICAL` | yes |
| `brokerHealth.connected === false` | — | BLOCK | `CRITICAL` | yes |
| `consecutiveFailures > 0` and below the limit | `> 0` | WARN | `WARN` | no |
| otherwise | — | PASS | — | — |

The three BLOCK branches are checked in that order, so a count of `3` reports
the count rather than the disconnection.

### 4.3 Market data

`DATA_FRESHNESS` — `src/risk/rules/index.js:130-149`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `quote` is null | — | BLOCK | `CRITICAL` | yes |
| `nowMs − quote.tsMs > maxDataStalenessMs` | `15000` ms | BLOCK | `CRITICAL` | yes |
| `nowMs − quote.tsMs > degradedDataFreshnessMs` | `9000` ms | WARN | `WARN` | no |
| otherwise | — | PASS | — | — |

Config validation requires `degradedDataFreshnessMs <= maxDataStalenessMs`
(`src/core/config.js:99-103`), so the WARN band is always strictly inside the
BLOCK band.

`PRICE_SANITY` — `src/risk/rules/index.js:150-178`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `!(quote.mid > 0)` or `!Number.isFinite(quote.mid)` | — | BLOCK | `CATASTROPHIC` | yes |
| `quote.spreadBps > maxSpreadBps` | `60` bps | BLOCK | `CRITICAL` | yes |
| `moveBps > priceDeviationLimitBps` | `150` bps | BLOCK | `CRITICAL` | yes |
| `moveBps > priceDeviationLimitBps × 0.6` | `90` bps | WARN | `WARN` | no |
| otherwise | — | PASS | — | — |

`moveBps` is `|quote.mid − referencePrice| / referencePrice × 10000`, where
`referencePrice` is the previous persisted snapshot for that symbol
(`src/risk/risk-engine.js:215-216`). The deviation check is skipped entirely
when there is no positive reference price — a first observation is not a
movement.

`market.maxTickJumpBps` (`120`) is validated to be strictly below
`priceDeviationLimitBps` (`src/core/config.js:127-134`) so that ordinary
simulated volatility does not trip the abnormal-movement branch on every tick.

### 4.4 Account level

`NO_NEGATIVE_CASH` — `src/risk/rules/index.js:204-215`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `toMinor(cashEgp) < 0` | `0` piastres | BLOCK | `CATASTROPHIC` | yes |

The comparison is in integer piastres, not floating-point EGP, so a rounding
artefact cannot produce a negative-cash refusal.

`DAILY_LOSS` — `src/risk/rules/index.js:216-234`

`lossEgp = roundEgp(max(0, −(dailyLoss.realizedEgp + dailyLoss.unrealizedEgp)))`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `lossEgp >= dailyLossLimitEgp` | `25.00` EGP | BLOCK | `CATASTROPHIC` | yes |
| `lossEgp >= dailyLossLimitEgp × 0.8` | `20.00` EGP | WARN | `WARN` | no |
| otherwise | — | PASS | — | — |

The daily loss window is the UTC calendar day, taken from
`clock.dateKey()`. Realised P&L is summed from `pnl_events` rows of kind
`REALIZED` for that day; unrealised is the current mark-to-market of the day's
still-open positions (`src/worker/worker.js:548-578`). The window rolls at
UTC midnight and the rollover is logged (`src/worker/worker.js:606-616`); it
resets the window, not the account.

`EXPOSURE` — `src/risk/rules/index.js:235-273`

`projected = exposureEgp + notionalEgp` for a BUY, `exposureEgp − notionalEgp`
for a SELL. `exposureEgp` is the mark-to-market notional of all open positions
(`src/paper/pnl.js:61`).

| # | Condition | Limit | Outcome | Severity | Latches stop |
|---|-----------|-------|---------|----------|--------------|
| 1 | `exposureEgp > limit` **and** side is not `BUY` | `250.00` EGP | WARN — the exit is allowed and the breach is recorded loudly | `CRITICAL` | no |
| 2 | `exposureEgp > limit` **and** side is `BUY` | `250.00` EGP | BLOCK | `CRITICAL` | yes |
| 3 | side is `BUY` **and** `projected > limit` | `250.00` EGP | BLOCK | `CRITICAL` | no |
| 4 | otherwise | — | PASS | — | — |

Branch 1 is the deliberate exception: exposure is marked to market and can drift
above the cap between orders, so refusing the sell that shrinks it would make
the breach permanent. Branches 2 and 3 differ in latching — an account found
already over the cap is a systemic condition and latches; a single order that
would cross the cap is an arithmetic outcome and does not.

`OPEN_POSITIONS` — `src/risk/rules/index.js:274-292`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| side is not `BUY` | — | PASS (exempt) | — | — |
| `openPositions >= maxOpenPositions` | `3` | BLOCK | `CRITICAL` | no |
| otherwise | — | PASS | — | — |

The exemption is the same reasoning as `EXPOSURE` branch 1: a cap on taking on
new exposure must never trap exposure that is already open.

### 4.5 Order rate

`ORDER_RATE` — `src/risk/rules/index.js:293-314`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| side is not `BUY` | — | PASS (exempt) | — | — |
| `orderCounts.day >= maxOrdersPerDay` | `60` | BLOCK | `CRITICAL` | yes |
| `orderCounts[bySymbol][symbol] >= maxOrdersPerSymbolPerDay` | `20` | BLOCK | `CRITICAL` | yes |
| otherwise | — | PASS | — | — |

Both branches latch: a runaway order loop is a systemic failure, and an agent
that has hit 60 orders in a day should not be allowed to keep trying.

Counting scope differs by mode and is deliberate
(`src/worker/worker.js:580-593`): in BACKTEST the counts are scoped to the run
(`teos-backtest.db` is reused across runs and every run replays from the same
epoch, so an unscoped count would trip the limit on the first order); in PAPER
they are scoped to the whole mode, so the rate limit survives a restart.

### 4.6 Order shape and size

`ORDER_VALID` — `src/risk/rules/index.js:317-342`. Applies to both sides.

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| instrument not in the config | — | BLOCK | `CATASTROPHIC` | yes |
| `!(quantity > 0)` | `0` | BLOCK | `BLOCK` | no |
| `quantity < instrument.minQty` | per instrument | BLOCK | `BLOCK` | no |
| `!(expectedExecutionPrice > 0)` | `0` | BLOCK | `BLOCK` | no |
| `notionalEgp < 0` | `0` EGP | BLOCK | `CATASTROPHIC` | yes |
| otherwise | — | PASS | — | — |

Severity `BLOCK` is the default of the `block()` helper
(`src/risk/rules/index.js:23`) and is used where the condition is a property of
the order rather than of the account. The database column vocabulary is
`WARNING | CRITICAL | CATASTROPHIC` (`emergency_stops.severity` CHECK), so a
`BLOCK` severity on a rule result is not the same token as a `BLOCK` status;
the rule's `severity` is only written onto a stop row when `latchesStop` is
true.

Instrument minimums, from `config/default.json`:

| Symbol | `minQty` | `qtyStep` | `tickSize` |
|--------|----------|-----------|------------|
| `USD/EGP` | `0.01` | `0.01` | `0.0001` |
| `EUR/EGP` | `0.01` | `0.01` | `0.0001` |
| `GOLD/XAU` | `0.001` | `0.001` | `0.01` |
| `SILVER/XAG` | `0.01` | `0.01` | `0.001` |
| `TEOS/IDX` | `0.01` | `0.01` | `0.01` |

`MIN_NOTIONAL` — `src/risk/rules/index.js:343-354`. BUY only.

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `notionalEgp < minOrderNotionalEgp` | `5.00` EGP | BLOCK | `BLOCK` | no |
| otherwise | — | PASS | — | — |

The reason is cost, not risk: below EGP 5 the `minFeeEgp` of `0.05` and the
modelled slippage are a material fraction of the trade.

`SUFFICIENT_BALANCE` — `src/risk/rules/index.js:355-375`. BUY only.

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `toMinor(notional) + toMinor(fee) > toMinor(cashEgp)`, where `fee = notional × fees.takerBps / 10000` and `takerBps = 10.0` | available cash | BLOCK | `CRITICAL` | no |
| otherwise | — | PASS | — | — |

`POSITION_SIZE` — `src/risk/rules/index.js:376-392`. BUY only.

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `notionalEgp > maxPositionSizeEgp` | `125.00` EGP | BLOCK | `CRITICAL` | no |
| otherwise | — | PASS | — | — |

`RISK_PER_TRADE` — `src/risk/rules/index.js:393-414`. BUY only. `risk` is the
loss at the stop, `quantity × |price − stopPrice|`.

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| `risk > maxLossPerTradeEgp + 1e-9` | `5.00` EGP | BLOCK | `CRITICAL` | no |
| `risk / equityEgp × 100 > 2` | `2`% of equity | WARN | `WARN` | no |
| otherwise | — | PASS | — | — |

**The `2`% warning threshold is hard-coded in the rule**
(`src/risk/rules/index.js:408`) and is not configurable. At the reference
equity of EGP 500 it corresponds to EGP 10.00 of risk at the stop, which is
twice the EGP 5.00 per-trade cap. The cap is the binding constraint; the
warning is reachable only on an account far larger than EGP 500, or if the cap
is edited up.

### 4.7 Stop conditions

`STOP_CONDITION` — `src/risk/rules/index.js:415-450`. BUY only. `distPct` is
`|price − stopPrice| / price × 100`.

| # | Condition | Limit | Outcome | Severity | Latches stop |
|---|-----------|-------|---------|----------|--------------|
| 1 | `stopLossRequired` and no `stopPrice` | — | BLOCK | `CRITICAL` | yes |
| 2 | `distPct < minStopDistancePct − 1e-6` | `0.25`% | BLOCK | `BLOCK` | no |
| 3 | `distPct > maxStopDistancePct + 1e-6` | `5.0`% | BLOCK | `BLOCK` | no |
| 4 | `stopPrice >= price` | — | BLOCK | `CRITICAL` | yes |
| 5 | `riskRewardRatio != null && riskRewardRatio < minRiskRewardRatio` | `0.8` | **WARN only** | `WARN` | no |
| 6 | otherwise | — | PASS | — | — |

Branch 2 exists because a stop inside ordinary tick noise is not a risk
control. Branch 3 exists because a position sized to a loss it can never reach
is not a bounded risk. Branch 4 is the long-only direction check: the stop must
be below the entry.

Branch 5 is a warning and never a refusal. `riskRewardRatio` is nullable and
`null` skips the comparison entirely (`src/risk/rules/index.js:443`). The
active strategy's parameters in `config/default.json` do not set
`rewardMultiple`; the value comes from `sma_cross.defaultParams` (`1.5`) and is
therefore above the `0.8` threshold — this branch does not fire in the reference
runs.

`defaultStopDistancePct` (`1.5`%) is **not compared against anything in this
rule**. It is the fallback stop distance used by `proposeOrder()` when a
decision carries no stop (`src/risk/risk-engine.js:157-159`), and it is the
value the strategies pass through `resolveStop()`. Config validation enforces
`minStopDistancePct <= defaultStopDistancePct <= maxStopDistancePct`
(`src/core/config.js:94-98`).

A stop is mandatory by configuration, not by preference:
`validateConfig()` throws unless `risk.stopLossRequired === true`
(`src/core/config.js:91-93`), and the Sentinel's `STOP_REQUIRED` rule blocks
independently (section 8.4).

**A stop is an order, not a setting.** A breached stop becomes a first-class
`Decision` built by `buildStopExitDecision()`
(`src/agent/engine.js:398-445`) and goes through the same firewall as any
other order. There is no direct broker call for stop enforcement. If the
firewall refuses a stop exit, the worker latches a `STOP_EXIT_BLOCKED`
`CATASTROPHIC` stop and leaves the position open with a `FATAL` event
(`src/worker/worker.js:427-440`).

### 4.8 Idempotency

`DUPLICATE_ORDER` — `src/risk/rules/index.js:451-463`

| Condition | Limit | Outcome | Severity | Latches stop |
|-----------|-------|---------|----------|--------------|
| an order already exists for this `client_order_id` | — | BLOCK | `CRITICAL` | no |
| otherwise | — | PASS | — | — |

`clientOrderId` is derived deterministically from `decisionId`
(`clientOrderId()` in `src/core/ids.js`), so the check survives a restart: the
same decision always produces the same identifier. The same condition is
enforced three more times — Sentinel rule `DUPLICATE_ORDER` (section 8.4), the
adapter's pre-submission lookup
(`src/execution/execution-adapter.js:110-119`), and the broker's
`getOrderByClientId` (`src/broker/mock/mock-broker.js:470-473`).

---

## 5. Rule order, and what the order means

### 5.1 The order

Rules are evaluated top to bottom in the `RULES` array
(`src/risk/rules/index.js:45-464`).

```
 1 NO_LEVERAGE          8 NO_NEGATIVE_CASH     15 SUFFICIENT_BALANCE
 2 KILL_SWITCH          9 DAILY_LOSS           16 POSITION_SIZE
 3 AGENT_STATE         10 EXPOSURE             17 RISK_PER_TRADE
 4 CONNECTION          11 OPEN_POSITIONS       18 STOP_CONDITION
 5 DATA_FRESHNESS      12 ORDER_RATE           19 DUPLICATE_ORDER
 6 PRICE_SANITY        13 ORDER_VALID
 7 MAX_CAPITAL         14 MIN_NOTIONAL
```

The grouping is deliberate and stated in the source
(`src/risk/rules/index.js:41-44`): absolute prohibitions first, then
connectivity and data quality, then account-level limits, then order-specific
checks, with the cheapest and most absolute conditions evaluated first.

### 5.2 First blocking rule wins

`RiskEngine.check()` breaks out of the loop on the first `BLOCK`
(`src/risk/risk-engine.js:277-290`). The recorded `failedRule` is that rule
(`failedRule ??= result.rule`, `:279`), and the loop stops — later rules are
not evaluated at all.

Three consequences worth stating:

1. **The recorded reason is the first reason, not the strongest reason.** If an
   order is both stale-priced and oversized, the record names
   `DATA_FRESHNESS`, because that rule runs fifth. An audit reader must not
   read the recorded `failedRule` as a diagnosis of the only problem; it is
   the first problem the evaluator reached.
2. **Rules after the break are neither passed nor failed.** `rulesEvaluated`
   is carried in the verdict (`src/risk/risk-engine.js:321`) so a reader can
   see how much of the array ran. `rulesTotal` is `19`.
3. **A rule that throws is still a block.** The exception is caught per rule
   and converted to a `BLOCK` with `severity: 'CATASTROPHIC'`,
   `latchesStop: true` and the exception in `detail`
   (`src/risk/risk-engine.js:262-275`). A broken rule can never behave like a
   passing rule.

### 5.3 Cash and exposure move together, so neither can be the first blocker

This is a property of the sizer, and it needs stating because it is invisible
in any single rule.

`proposeOrder()` caps the notional at
`min(maxPositionSizeEgp, maxPortfolioExposureEgp − exposureEgp, cashEgp)`
(`src/risk/risk-engine.js:163-167`), and `sizePosition()` applies a second cash
cap of `cash / (1 + feeBps/10000)`
(`src/paper/pnl.js:141-143`) so that notional **and** fee both fit. The result
is that an order built by the risk engine cannot, by construction, exceed
available cash or exceed the remaining exposure headroom.

Therefore, for a proposal the risk engine sized itself from the same account
snapshot that `check()` is given:

| Rule | Position | Why it cannot normally be the first blocker |
|------|----------|----------------------------------------------|
| `NO_NEGATIVE_CASH` | 8 | A proposal cannot be funded from cash it does not have; if cash were already negative, the sizer would have produced quantity `0` |
| `EXPOSURE` branch 3 | 10 | The sizer already capped at `maxPortfolioExposureEgp − exposureEgp` |
| `SUFFICIENT_BALANCE` | 15 | The sizer already applied the `1 + feeBps/10000` cash cap |

`EXPOSURE` branch 1 (already over the cap, order is an exit) is the exception:
that branch is reached when the account is genuinely over the cap on entry, and
it returns a WARN rather than a block, so the run continues to
`SUFFICIENT_BALANCE`, `POSITION_SIZE`, `RISK_PER_TRADE` and `STOP_CONDITION`,
which are all exempt or size-checked for a SELL.

**The three rules are not redundant.** They are reachable when the proposal was
not produced by `proposeOrder()` sizing, or when the account snapshot supplied
to `check()` differs from the one used to size — for example a fill that landed
between sizing and evaluation inside the same tick. They remain enforced, and
they remain the operative reason when they fire. The statement above is about
which rule is usually reported first, not about which rules are live.

---

## 6. Block, warn, latch

### 6.1 Status

Every rule returns `status ∈ {PASS, WARN, BLOCK}`
(`src/risk/rules/index.js:6`). The verdict is derived in
`src/risk/risk-engine.js:293-296`:

| Condition | Verdict |
|-----------|---------|
| any rule returned `BLOCK` | `BLOCK` |
| otherwise, any rule returned `WARN` | `WARN` |
| otherwise | `ALLOW` |

A `WARN` does not reduce the order to anything. It is recorded, surfaced on the
dashboard, and the order proceeds. `ALLOW`, `WARN` and `BLOCK` are the three
verdicts the risk engine can produce; `REVIEW` exists in the `VERDICTS` object
(`src/risk/risk-engine.js:26`) and in the `risk_decisions` CHECK constraint,
but the risk engine never emits it. `REVIEW` belongs to the Sentinel.

### 6.2 Severity

`severity` is metadata on the result. It is written to a stop row when
`latchesStop` is true, and it is otherwise only carried in the persisted
`rules_json`.

| Value | Meaning in use |
|-------|----------------|
| `CATASTROPHIC` | The account, the data or the order is not trustworthy. Something structural is wrong. |
| `CRITICAL` | A real limit was breached. |
| `BLOCK` | The order itself is malformed. The default of the `block()` helper; a property of the order, not of the account. |
| `WARN` | Recorded, not acted on. |

`WARNING` is the fourth value in the `emergency_stops.severity` CHECK
constraint and the default for `Repos.engageStop()`. No risk rule in the
current `RULES` array emits it.

### 6.3 `latchesStop`

`latchesStop` decides whether a `BLOCK` also engages an emergency stop
(`src/risk/rules/index.js:280-288`). When it is true, the stop is written inside
the **same database transaction** as the verdict
(`src/risk/risk-engine.js:327-337`), so the refusal and the stop are atomic: it
is not possible to have one without the other.

Latching means the refusal survives the cause clearing. Once a stop is
latched, `KILL_SWITCH` (rule 2) blocks every subsequent order until an operator
clears it, regardless of whether the underlying condition has been fixed.

| Rule and branch | `latchesStop` | Rationale |
|-----------------|---------------|-----------|
| `NO_LEVERAGE` | yes | A prohibited feature reached the engine |
| `KILL_SWITCH` | no | The stop is already engaged; latching again adds nothing |
| `AGENT_STATE` undefined / no matrix | yes | The agent does not know what state it is in |
| `AGENT_STATE` permission denial | no | A known state legitimately forbids the order |
| `CONNECTION` (all three BLOCK branches) | yes | A connection that is failing will keep failing |
| `DATA_FRESHNESS` (both BLOCK branches) | yes | Stale data is a system-level condition, not a bad order |
| `PRICE_SANITY` (non-positive mid) | yes | A non-positive price means the feed is broken |
| `PRICE_SANITY` (spread, movement) | yes | Abnormal market conditions are not per-order |
| `MAX_CAPITAL` (all three branches) | yes | The account is outside policy |
| `NO_NEGATIVE_CASH` | yes | Negative cash is an invariant violation |
| `DAILY_LOSS` at the limit | yes | The trading day is over |
| `EXPOSURE` branch 1 (already over, BUY) | yes | The account is outside policy |
| `EXPOSURE` branch 3 (projected breach) | no | One order crossing the line is arithmetic |
| `ORDER_RATE` (both branches) | yes | A runaway loop is systemic |
| `ORDER_VALID` unknown instrument | yes | A misconfigured or hallucinated symbol |
| `ORDER_VALID` negative notional | yes | An impossible order shape |
| `ORDER_VALID` other branches | no | Malformed order, healthy account |
| `MIN_NOTIONAL` | no | A single undersized order |
| `SUFFICIENT_BALANCE` | no | The account is simply smaller than the order |
| `POSITION_SIZE` | no | One oversized order |
| `RISK_PER_TRADE` | no | One over-risk order |
| `STOP_CONDITION` missing stop / inverted stop | yes | Entries are arriving without a valid risk boundary |
| `STOP_CONDITION` distance band | no | One mis-placed stop |
| `DUPLICATE_ORDER` | no | A restart artefact, not a market condition |
| any rule that throws | yes | The engine cannot vouch for its own output |

### 6.4 Stop shape

`scope` is derived from severity, not stated by the rule
(`src/risk/risk-engine.js:284`):

| Severity | Scope written |
|----------|---------------|
| `CATASTROPHIC` | `HALT_ALL` |
| anything else | `NEW_ORDERS` |

`scope` is recorded on the stop row. It is **not** consulted by any rule: the
`KILL_SWITCH` risk rule and the `KILL_SWITCH` Sentinel rule both block on
`killSwitch.engaged` alone
(`src/risk/rules/index.js:63-70`, `src/execution/sentinel.js:56-61`). In the
current code the practical effect of a `CATASTROPHIC` stop and a `CRITICAL`
stop is the same — no new orders — and the distinction is carried in the record
rather than in behaviour. The same is true of the three worker-side latches,
which all pass `scope: 'NEW_ORDERS'`
(`src/worker/worker.js:435-439`, `:508-511`;
`src/agent/engine.js:257-261`).

Stops are read through `Repos.sessionStop(mode)`
(`src/database/repositories/index.js:653-655`), which encapsulates the scoping
policy: run-scoped in BACKTEST, mode-wide in PAPER. A resumed PAPER run keeps
its `run_id` and therefore keeps its stop; a new backtest does not inherit a
previous backtest's stop.

---

## 7. Fail-closed conditions

The controlling rule: an unknown outcome is never treated as success.

### 7.1 Enforced in the risk engine

| Condition | Where | Outcome |
|-----------|-------|---------|
| no quote for the symbol | `DATA_FRESHNESS` — `src/risk/rules/index.js:134-136` | BLOCK `CRITICAL`, latches |
| `quote.mid <= 0` or non-finite | `PRICE_SANITY` — `:153-157` | BLOCK `CATASTROPHIC`, latches |
| no `brokerHealth` object | `CONNECTION` — `:111-113` | BLOCK `CRITICAL`, latches |
| `cashEgp` negative in piastres | `NO_NEGATIVE_CASH` — `:207-212` | BLOCK `CATASTROPHIC`, latches |
| `equityEgp <= 0` | `MAX_CAPITAL` — `:197-200` | BLOCK `CRITICAL`, latches |
| unknown instrument | `ORDER_VALID` — `:321-324` | BLOCK `CATASTROPHIC`, latches |
| `quantity <= 0` | `ORDER_VALID` — `:325-327` | BLOCK |
| `expectedExecutionPrice <= 0` | `ORDER_VALID` — `:333-335` | BLOCK |
| no permission matrix on the decision | `AGENT_STATE` — `:83-87` | BLOCK `CATASTROPHIC`, latches |
| any rule throws | `src/risk/risk-engine.js:262-275` | BLOCK `CATASTROPHIC`, latches |
| `proposeOrder()` or `check()` throws | `src/execution/firewall.js:101-109` | Outcome `FAILED`, `risk_engine_error` event, nothing submitted |

The unknown-instrument path is deliberate. Without a guard in
`proposeOrder()`, an unknown symbol would reach
`sizePosition({ qtyStep: instrument.qtyStep })` and throw a bare `TypeError`;
the firewall would report `FAILED` with code `UNKNOWN`, no rule would fire and
nothing would latch. The order is still refused — it fails closed either way —
but the diagnosis would be wrong and the operator would learn nothing about a
misconfigured symbol (`src/risk/risk-engine.js:100-115`).

A zero-quantity proposal is a `BLOCKED` outcome at the firewall before the
Sentinel runs (`src/execution/firewall.js:113-121`). The risk record is still
written, which is the point: the refusal is as auditable as an execution.

### 7.2 Enforced outside the risk engine

| Condition | Component | Behaviour |
|-----------|-----------|-----------|
| Sentinel rule throws | `src/execution/sentinel.js:336-340` | Converted to `BLOCK` |
| Sentinel returns a verdict not in the enum | `:341-343` | Converted to `BLOCK` |
| `Sentinel.evaluate()` throws | `src/execution/firewall.js:134-142` | Outcome `FAILED`, `sentinel_error` event, nothing submitted |
| Sentinel verdict is not `ALLOW` or `WARN` | `src/execution/execution-adapter.js:24, 53-58` | `buildOrder()` throws `InvalidOrderError` |
| risk verdict is blocked | `src/execution/execution-adapter.js:59-64` | `buildOrder()` throws `InvalidOrderError` |
| order fails final validation | `src/execution/validator.js:104-110` | `InvalidOrderError`; outcome `BUILD_FAILED` |
| an emergency stop is active | `src/execution/execution-adapter.js:121-128` | `EmergencyStopError` immediately before the broker call |
| broker call throws | `src/execution/execution-adapter.js:166-176` | Order `REJECTED` with `BROKER_ERROR`; no retry |
| broker reports a duplicate | `:178-181` | Order `REJECTED` with `DUPLICATE_AT_BROKER` |
| broker rejects the order | `:183-193` | Order `REJECTED` with the broker's reason |
| order requests leverage or borrowing | `src/broker/mock/mock-broker.js:467-469` | `ValidationError` |
| unknown symbol at the broker | `src/broker/mock/matching-engine.js:130-133` | `REJECTED`, reason `UNKNOWN_SYMBOL:<symbol>` |
| fill is impossible (sell with no long, or a BUY that cash cannot fund) | `src/broker/mock/mock-broker.js:127-164` | Fill capped to the affordable quantity, or the order `CANCELED` with a recorded reason, before the matching engine produces it |
| fill guard itself throws | `src/broker/mock/matching-engine.js:68-70` | Treated as "do not fill" |
| SELL with no open long at the account | `src/paper/paper-account.js:98-105` | Throws `TeosError`, code `NO_POSITION_TO_SELL` |
| BUY fill would overdraw cash | `src/paper/ledger.js:68-81` | Throws `InsufficientBalanceError` |
| unexpected throw in a worker tick | `src/worker/worker.js:492-512` | Recorded `FATAL`, agent moved to `FAILED`, `UNHANDLED_ERROR` stop latched, loop continues |
| breached stop cannot be executed | `src/worker/worker.js:427-440` | `STOP_EXIT_BLOCKED` `CATASTROPHIC` latched, position left open and reported `FATAL` |
| strategy throws during evaluation | `src/agent/engine.js:250-263` | `FATAL` event, agent `FAILED`, `STRATEGY_ERROR` stop latched |
| an undefined target state is requested | `src/agent/state.js:100-107` | State becomes `FAILED` |
| an illegal transition is requested | `src/agent/state.js:111-113` | Throws — a bug in the caller, not a condition to absorb |
| broker connection fails at boot | `src/worker/worker.js:194-198` | Lock released, `WorkerError` thrown, the loop is not entered |
| cash does not reconcile with the fill log at boot | `src/worker/worker.js:204-216` | `ERROR` event with expected, actual and delta |
| a credential variable is populated | `src/core/env.js:83-97` | `SecurityError`; the process refuses to boot |
| `TEOS_LIVE_TRADING_ENABLED` is truthy | `src/core/env.js:116-124` | `LiveTradingDisabledError` |
| `TEOS_MODE=LIVE` | `src/core/env.js:99-110` | `LiveTradingDisabledError` |
| config declares zero fees or zero slippage | `src/core/config.js:109-119` | `ConfigError` |

### 7.3 Not enforced: an inverted quote

**There is no check that `bid <= ask`.** `PRICE_SANITY` tests
`quote.mid > 0` and `quote.spreadBps > maxSpreadBps`; a negative `spreadBps`
is below the limit, not above it, so an inverted book would not be refused by
the spread branch.

It also cannot arise from either quote producer in this repository:

| Producer | Construction | Result |
|----------|--------------|--------|
| `MarketSimulator.#quote()` — `src/broker/mock/market-simulator.js:123-139` | `half = (spreadBps / 2 / 10000) × mid`, `spreadBps` clamped to `[spreadBpsMin, spreadBpsMax]`, both `>= 0` by config validation (`src/core/config.js:217-218`) | `bid = max(mid − half, tickSize) <= mid <= ask` |
| `ReplayFeed` — `src/backtest/replay-feed.js:170-184` | `half` from a recorded `spreadBps` that was itself produced by the simulator above | `bid <= mid <= ask` |

So the absence of a check is not currently a defect, but it is an absence. A
future market-data source that did not guarantee a non-negative spread would not
be caught by the risk engine. It is recorded here rather than described as a
guarantee.

---

## 8. The TEOS Sentinel — the second line

### 8.1 Position and non-widening guarantee

The Sentinel sits between the risk engine and the execution adapter
(`src/execution/firewall.js:127-150`). It is defence in depth, not a
substitute, and it can never widen anything the risk engine has limited. The
guarantee is structural: Sentinel rule `RISK_VERDICT`
(`src/execution/sentinel.js:63-79`) returns `BLOCK` whenever
`riskVerdict.blocked` is true, and `BLOCK` is the top of the precedence order.
There is no Sentinel verdict that maps to a submission when the risk engine
refused.

`POLICY_VERSION` is `sentinel/1.0.0-phase1` and is stamped on every Sentinel
record (`src/execution/sentinel.js:31, 363`).

### 8.2 Precedence

All 14 rules are evaluated — the Sentinel does **not** break early, unlike the
risk engine. The winner is the highest-ranked verdict
(`src/execution/sentinel.js:33, 347-349`):

```
ALLOW  <  WARN  <  REVIEW  <  BLOCK
```

Rank is `SENTINEL_VERDICTS.indexOf(verdict)`. The reduce starts from `ALLOW`,
so an all-ALLOW evaluation yields `ALLOW`.

The recorded `triggerRule` is the **first** rule in evaluation order that
returned the winning verdict (`results.find(r => r.verdict === winner)`,
`:349`), not the strongest one. For a `BLOCK` that means the earliest blocking
rule in the list, which is why `MODE_GUARD` at position 1 will normally be
recorded ahead of a later cause.

### 8.3 The four actions

| Verdict | `actionTaken` | Effect |
|---------|---------------|--------|
| `ALLOW` | `PASS` | The adapter may build and submit the order |
| `WARN` | `PASS_WITH_WARNING` | The order is submitted; the warning is recorded and surfaced |
| `REVIEW` | `QUARANTINE` | The order is **not** submitted. It is recorded as a review item. |
| `BLOCK` | `REJECT` | The order is refused |

`REVIEW` writes the `REVIEW_PENDING` control flag carrying the quarantined
decision id (`src/execution/sentinel.js:370-376`) for the dashboard. It does
**not** latch a stop, and the source states why: the firewall already refuses
to execute a quarantined decision, and a global latch would let one odd order
stop the agent permanently with no recovery path
(`src/execution/sentinel.js:371-375`).

### 8.4 Sentinel rules

`src/execution/sentinel.js:39-280`, in evaluation order. Thresholds are from
`config/sentinel` in `config/default.json`.

| # | Rule | Condition | Threshold | Verdict |
|---|------|-----------|-----------|---------|
| 1 | `MODE_GUARD` | `mode === 'LIVE'` | — | BLOCK |
| 1 | `MODE_GUARD` | mode not in `[PAPER, BACKTEST]` | — | BLOCK |
| 2 | `KILL_SWITCH` | an emergency stop is engaged | — | BLOCK |
| 3 | `RISK_VERDICT` | `riskVerdict.blocked` | — | BLOCK |
| 3 | `RISK_VERDICT` | `riskVerdict.verdict === 'WARN'` | — | WARN |
| 4 | `DUPLICATE_ORDER` | order already exists for this `client_order_id` | — | BLOCK |
| 5 | `MANUAL_HOLD` | `TRADING_HOLD` flag is set | — | BLOCK |
| 6 | `PRICE_DRIFT` | `driftBps > priceDriftReviewBps` | `40` bps | REVIEW |
| 6 | `PRICE_DRIFT` | `driftBps > threshold × 0.5` | `20` bps | WARN |
| 6 | `PRICE_DRIFT` | `proposal.reduceOnly === true` | — | exempt, ALLOW |
| 6 | `PRICE_DRIFT` | either price is not positive | — | BLOCK |
| 7 | `UNUSUAL_SIZE` | notional `> unusualSizeReviewEgp` **or** `> unusualSizeReviewPctOfEquity`% of equity | `150.0` EGP **or** `30.0`% | REVIEW |
| 8 | `LOW_CONFIDENCE` | `confidence < lowConfidenceReview`, signal not `HOLD` | `0.3` | REVIEW |
| 9 | `WIDE_STOP` | stop distance `> wideStopWarnPct` | `3.0`% | WARN |
| 10 | `DAILY_LOSS_PRESSURE` | loss `>= 100`% of `dailyLossLimitEgp` | `25.00` EGP | BLOCK |
| 10 | `DAILY_LOSS_PRESSURE` | loss `>= dailyLossWarnPctOfLimit` of the limit | `80.0`% | WARN |
| 11 | `EXPOSURE_PRESSURE` | projected `> 100`% of cap, and the order reduces exposure | `250.00` EGP | WARN |
| 11 | `EXPOSURE_PRESSURE` | projected `> 100`% of cap, and the order is not a reduction | `250.00` EGP | BLOCK |
| 11 | `EXPOSURE_PRESSURE` | projected `>= exposureWarnPctOfLimit` of cap | `80.0`% | WARN |
| 12 | `DECISION_RATE` | decisions in the last 60 s `> maxDecisionsPerMinute` | `20` | REVIEW |
| 12 | `DECISION_RATE` | `proposal.reduceOnly === true` | — | exempt, ALLOW |
| 13 | `STOP_REQUIRED` | BUY with no `decision.stopCondition` and `stopRequiredBlocks === true` | — | BLOCK |
| 14 | `SHORT_GUARD` | SELL with no open long for that symbol | — | BLOCK |

Notes on individual rules:

- `PRICE_DRIFT` and `DECISION_RATE` exempt risk-reducing orders. Drift is why a
  stop exit exists; quarantining one because the market moved would defeat the
  stop (`src/execution/sentinel.js:115-119`).
- `UNUSUAL_SIZE` thresholds are validated to sit strictly **above** the risk
  engine's own position cap (`src/core/config.js:159-172`). If they were below
  it, every correctly-sized order the sizer is permitted to produce would be
  quarantined and the agent could not trade at all.
- `DECISION_RATE` counts `agent_decisions` rows in a 60 s window, run-scoped in
  BACKTEST so that a replayed clock does not count a previous run's decisions
  (`src/execution/sentinel.js:391-406`).
- `SHORT_GUARD` prefers the live account lookup and falls back to the
  snapshot's `openPositionDetails` (`src/execution/sentinel.js:263-269`).
- `LOW_CONFIDENCE` never sees a stop exit: `buildStopExitDecision()` sets
  `confidence: 1`, so the low-confidence REVIEW is expressed in the data rather
  than in a special case (`src/agent/engine.js:400-403`).

### 8.5 A `REVIEW` is not an operator hold

These are different controls and the difference is deliberate.

| | Sentinel `REVIEW` | Operator `TRADING_HOLD` |
|---|---|---|
| Set by | A rule, automatically, per decision | An operator, via `node src/cli.js hold` |
| Scope | Exactly one decision, named in the `REVIEW_PENDING` flag | Every order, until `resume` |
| Other trading | Continues | Stops |
| Latches a stop | No | No — it is a control flag, not an emergency stop |
| Clearing it | The next decision is evaluated afresh | `node src/cli.js resume` |
| Recorded as | `sentinel_decisions` with `action_taken = 'QUARANTINE'` | `control_flags` row, updated by `cli-operator` |

`MANUAL_HOLD` returns `BLOCK` for **every** order, including risk-reducing
exits. The CLI help text at `src/cli.js:81` says `hold` "blocks entries, allows
exits", and the command's own output at `src/cli.js:337` says the same. The
rule does not do that. The help text is wrong and this document follows the
rule. A consequence worth stating plainly: while a trading hold is engaged, a
breached stop exit is refused by `MANUAL_HOLD`, which is one of the conditions
that makes the worker latch a `STOP_EXIT_BLOCKED` stop
(`src/worker/worker.js:427-440`).

### 8.6 What a Sentinel `BLOCK` does not do

`Sentinel.evaluate()` writes a decision row, the `REVIEW_PENDING` flag for a
quarantine, and an event for `BLOCK` or `REVIEW`
(`src/execution/sentinel.js:368-386`). It does **not** call `engageStop()`.

A Sentinel `BLOCK` therefore refuses the order and stops nothing else. A
latched stop comes from the risk engine, the worker, or the agent — not from
this layer. The `RISK_VERDICT` rule is what makes a risk-engine block visible
here; the stop itself was already latched by the risk engine's transaction.

---

## 9. Configured but not enforced

These settings exist in `config/default.json`, pass
`validateConfig()`, and are read by no comparison in this repository. They are
listed so the envelope above is not read as wider than it is.

| Setting | Configured value | Validated at | Actual consumers |
|---------|------------------|--------------|------------------|
| `sentinel.freshnessWarnPctOfLimit` | `60.0` | `src/core/config.js:145-151` (generic loop) | **None.** No Sentinel rule reads it. `DATA_FRESHNESS` uses `degradedDataFreshnessMs` instead, in milliseconds. |
| `risk.haltCooldownMs` | `60000` ms | `src/core/config.js:90` | `AgentEngine.scheduleCooldown()` at `src/agent/engine.js:372`, which **no caller invokes**. The `#haltedUntilMs` gate at `src/agent/engine.js:213-222` therefore never trips in a running worker. |
| `worker.maxDecisionsPerTick` | `1` | `src/core/config.js:178` | **None.** `src/agent/engine.js:16` attributes the one-decision-per-tick behaviour to this key; the worker never reads it. The behaviour is real — `#buildDecision` returns after the first signal — but it is not this setting. |
| `worker.heartbeatIntervalCycles` | `5` | **Not validated** | **None.** The heartbeat is written every `worker.heartbeatMs` (`5000` ms) via `maybeWrite()`. |
| `worker.autoResetDailyLossAtUtcMidnight` | `true` | **Not validated** | **None.** The rollover at `src/worker/worker.js:606-616` is unconditional. |
| `execution.fillLatencyMs` | `120` | **Not validated** | **None.** Fills are produced during the next `broker.tick()` with no latency term. |
| `fees.settleFeeInCash` | `true` | **Not validated** | **None.** Fees are always debited from cash in `Ledger.applyBuyFill` / `applySellFill`. |
| `slippage.applyToMarketOrders` | `true` | **Not validated** | **None.** Slippage is applied to every fill unconditionally. |
| `market.warmupCandles` | `60` | `src/core/config.js:125` | **None.** Warm-up is decided by the strategy's `minBars` against the candle count held in the broker (`src/worker/worker.js:543-546`). |
| `market.annualVolPct` | `{ "*": 12.0 }` | `src/core/config.js` does not validate this object | **None.** The simulator reads the per-instrument `inst.annualVolPct` (`config/default.json:138-194`), which config validation does require (`src/core/config.js:213`). |

For contrast, one execution setting that looks similar **is** used:
`execution.rejectsUnknownSymbol` is read at
`src/broker/mock/matching-engine.js:131`.

Two further notes on how limits can be edited:

- `sentinel.*` booleans may not be set to `false` — `validateConfig()` throws
  (`src/core/config.js:145-151`). Every other Sentinel threshold may be
  lowered without limit, since the generic loop only checks `min: 0`.
- `risk.maxStartingCapitalEgp` and the four EGP/pct pairs are additionally
  bounded by `max: 500` in validation, so the ceiling cannot be raised by
  editing the file.

---

## 10. What this policy does not cover

Stated explicitly, because a risk document that lists only its limits invites
the reader to assume there are no others.

| Not covered | Why |
|-------------|-----|
| Whether the strategy's decision is correct | The risk engine bounds the consequence of a decision, never its quality. The active strategy is currently slightly loss-making; see `docs/TRADING_POLICY.md`. |
| Any real-market behaviour | There is no venue, no latency, no partial-fill reality, no order-book depth, no reject codes. `market.simulator` is a seeded random process. |
| Liquidity | Fills are produced against a single mid-derived price with a modelled spread and slippage. There is no order book, no queue position and no market impact beyond the configured slippage model. |
| Overnight or gap risk | The simulated path is generated tick by tick from a seeded process. There are no session boundaries, no halts and no gaps beyond `market.maxTickJumpBps`. |
| Operational risk | Credential handling, host security, backup and restore of the database files, and dashboard access control are outside the risk engine. The dashboard binds to loopback only and `allowNonLoopbackBind` must be `false` (`src/core/config.js:183-185`). |
| Correlated positions | The exposure cap is a notional cap across all symbols. There is no correlation model and no sector limit. `maxOpenPositions` is a count, not a concentration measure. |
| Drawdown control | `MAX_CAPITAL` and `NO_NEGATIVE_CASH` bound the account, not the peak-to-trough decline. Drawdown is measured and reported (`src/paper/pnl.js:102-114`) but is not a limit anywhere in the risk engine. |
| Model risk in the limits themselves | The per-trade and daily limits are set for a simulated EGP 500 account. They are not calibrated against any risk model, and no code checks that they remain appropriate as the account changes. `MAX_CAPITAL` branch 1 uses a `× 1.5` equity multiple specifically so that ordinary drift is not treated as a breach. |
| Annualisation | `MIN_ANNUALISABLE_DAYS = 30` (`src/backtest/metrics.js:111`) suppresses annualised risk figures below 30 days. It is a reporting floor, not a limit. |
| Anything in a database that was written by something other than this code | `verifyPipeline()` and `scripts/verify.js` re-derive quantities from raw rows rather than trusting the agent, but both read the same database. |
