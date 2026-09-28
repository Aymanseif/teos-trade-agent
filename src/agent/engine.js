/**
 * TEOS Trade Agent - agent/engine.js
 *
 * The agent engine. Responsibilities, in order:
 *
 *   1. read market data from the broker abstraction
 *   2. update internal health (data freshness, connection, price sanity)
 *   3. evaluate the active strategy on every symbol
 *   4. size the position through the RISK ENGINE (the agent never sizes alone)
 *   5. emit a sealed, immutable Decision
 *
 * The engine does NOT place orders. It returns decisions to the worker, which
 * passes them to the execution firewall. That separation is what makes the
 * firewall unbypassable.
 *
 * Only ONE symbol is evaluated per call by default (maxDecisionsPerTick), so
 * the decision rate is bounded even with many instruments.
 */

import { getStrategy } from './strategies/registry.js';
import { sealDecision, decisionToRow } from './decision.js';
import { makeSignal } from './strategies/strategy.interface.js';
import { AgentStateMachine, STATES, permissionsFor } from './state.js';
import { newId } from '../core/ids.js';
import { roundEgp, roundTo } from '../core/money.js';
import { toErrorPayload } from '../core/errors.js';

export class AgentEngine {
  #config;
  #broker;
  #account;
  #repos;
  #clock;
  #logger;
  #state;
  #strategyId;
  #strategyParams;
  #riskEngine;
  #lastQuoteAt = new Map();
  #lastEmittedKey = new Map();
  #suppressedSignals = 0;
  #suppressedInFlight = 0;
  #haltedUntilMs = 0;
  #consecutiveFailures = 0;

  constructor({
    config, broker, account, repos, clock, logger, riskEngine,
    strategyId = null, params = null, state = null,
  }) {
    this.#config = config;
    this.#broker = broker;
    this.#account = account;
    this.#repos = repos;
    this.#clock = clock;
    this.#logger = logger;
    this.#riskEngine = riskEngine;
    this.#strategyId = strategyId ?? config.strategies.active;
    this.#strategyParams = params ?? config.strategies.params[this.#strategyId] ?? {};
    this.#state = state ?? new AgentStateMachine({ repos, clock });
    getStrategy(this.#strategyId); // fail fast on an unknown strategy id
  }

  get state() { return this.#state; }
  get stateName() { return this.#state.state; }
  get strategyId() { return this.#strategyId; }
  get strategy() { return getStrategy(this.#strategyId); }
  get suppressedSignalCount() { return this.#suppressedSignals; }
  get suppressedInFlightCount() { return this.#suppressedInFlight; }

  /**
   * The stop-distance band strategies must respect, taken from the risk policy
   * so there is exactly one source of truth for it.
   */
  get #stopBand() {
    return {
      minPct: this.#config.risk.minStopDistancePct,
      maxPct: this.#config.risk.maxStopDistancePct,
    };
  }

  setStrategy(id, params = null) {
    getStrategy(id);
    this.#strategyId = id;
    this.#strategyParams = params ?? this.#config.strategies.params[id] ?? {};
    // A different strategy reads the same market differently, so the
    // once-per-candle suppression state no longer applies to it.
    this.#lastEmittedKey.clear();
    this.#repos.logEvent({
      level: 'INFO', category: 'strategy_change', clock: this.#clock,
      message: `Active strategy set to ${id}.`, details: { strategyId: id, params: this.#strategyParams },
    });
    return this.#strategyId;
  }

  /**
   * The still-working order for a (symbol, side), or null.
   *
   * `broker.getOpenOrders()` is the source of truth, not a local flag: an order
   * is live at the exchange from the moment it is accepted until it is
   * FILLED, CANCELED or REJECTED, and only the exchange's book knows which.
   *
   * This is what closes the re-entrancy hole where two decisions for the same
   * position become two orders. A MARKET order is not filled at submission - it
   * is filled during the NEXT `broker.tick()` - and it may only be filled
   * PARTIALLY. In the window between "exit submitted" and "exit filled", the
   * position still looks open, so a second exit would be built for a position
   * that is already being closed. The first exit to fill would close it, and
   * the second would then have nothing to sell.
   *
   * Keyed on (symbol, side) rather than on symbol alone, deliberately: a cap on
   * new exposure must never trap existing risk, so a working SELL must not
   * block a stop-loss exit, and a working BUY must not block one either.
   */
  workingOrder(symbol, side) {
    try {
      return this.#broker.workingOrder(symbol, side) ?? null;
    } catch {
      return null;
    }
  }

  /** True when an order for (symbol, side) is already live at the exchange. */
  hasWorkingOrder(symbol, side) {
    return this.workingOrder(symbol, side) !== null;
  }

  /**
   * Health check. Maps broker/data conditions onto the agent state machine.
   * Returns { connected, dataFresh, abnormalPrice, undefinedState }.
   */
  assessHealth() {
    const health = this.#broker.health();
    const nowMs = this.#clock.now();
    let oldest = null;
    for (const inst of this.#config.instruments) {
      const q = this.#safeQuote(inst.symbol);
      if (!q) { oldest = null; continue; }
      const age = nowMs - (q.tsMs ?? 0);
      if (oldest === null || age > oldest) oldest = age;
    }
    const maxStale = this.#config.risk.maxDataStalenessMs;
    const connected = health.connected === true && health.consecutiveFailures < this.#config.risk.consecutiveFailureHaltCount;
    const dataFresh = oldest !== null && oldest <= maxStale;

    // Abnormal price: a single-tick move beyond the deviation limit.
    let abnormalPrice = false;
    for (const inst of this.#config.instruments) {
      const q = this.#safeQuote(inst.symbol);
      if (!q) continue;
      const prev = this.#repos.lastSnapshotBefore(inst.symbol, nowMs - 1, this.#repos.mode, this.#repos.decisionScopeRunId);
      if (!prev || !(prev.last > 0)) continue;
      const moveBps = Math.abs((q.mid - prev.last) / prev.last) * 10_000;
      if (moveBps > this.#config.risk.priceDeviationLimitBps) {
        abnormalPrice = true;
        this.#repos.logEvent({
          level: 'ERROR', category: 'abnormal_price', clock: this.#clock,
          message: `Abnormal price movement in ${inst.symbol}: ${moveBps.toFixed(1)}bps in one tick.`,
          details: { symbol: inst.symbol, moveBps, limitBps: this.#config.risk.priceDeviationLimitBps, from: prev.last, to: q.mid },
        });
        break;
      }
    }

    this.#state.applyHealth({ connected, dataFresh, abnormalPrice });
    return { connected, dataFresh, abnormalPrice, health, oldestQuoteAgeMs: oldest };
  }

  #safeQuote(symbol) {
    try {
      return this.#broker.getMarketData(symbol);
    } catch {
      return null;
    }
  }

  /**
   * Produce ONE decision.
   *
   * @returns {{ decision, quote, accountSnapshot, health } | null}
   */
  evaluateOnce({ symbols = null } = {}) {
    const nowMs = this.#clock.now();
    const h = this.assessHealth();
    const account = this.#account.snapshot();

    // 1. state gate: only HEALTHY may produce an order intent.
    if (!this.#state.can('evaluate')) {
      return {
        decision: null,
        reason: `AGENT_STATE_${this.#state.state}`,
        quote: null,
        accountSnapshot: account,
        health: h,
      };
    }

    // 2. persistence gate. Scoped to this session, not the whole mode: a stop
    // latched by an unrelated run must not silence this one, and a stop latched
    // by THIS run must survive a restart (a resumed run keeps its run_id).
    const activeStop = this.#repos.sessionStop();
    if (activeStop) {
      return {
        decision: null,
        reason: 'EMERGENCY_STOP_ACTIVE',
        stop: activeStop,
        quote: null,
        accountSnapshot: account,
        health: h,
      };
    }

    // 3. cooldown after a halt
    if (nowMs < this.#haltedUntilMs) {
      return {
        decision: null,
        reason: 'HALT_COOLDOWN',
        remainingMs: this.#haltedUntilMs - nowMs,
        quote: null,
        accountSnapshot: account,
        health: h,
      };
    }

    const strategy = this.strategy;
    const pool = symbols ?? this.#config.instruments.map((i) => i.symbol);
    const decision = this.#buildDecision({ strategy, pool, account, nowMs });
    return { decision, quote: decision?.__quote ?? null, accountSnapshot: account, health: h };
  }

  #buildDecision({ strategy, pool, account, nowMs }) {
    for (const symbol of pool) {
      const quote = this.#safeQuote(symbol);
      if (!quote) continue;
      const candles = this.#broker.candles(symbol);
      if (candles.length < strategy.minBars) {
        // Warm-up: record nothing as a trade, just note it. Warm-up is a
        // normal condition, not an event worth an audit row per tick.
        continue;
      }
      const position = this.#account.positionFor(symbol);

      let signalObj;
      try {
        signalObj = strategy.evaluate({
          symbol, candles, price: quote.mid, quote, position,
          params: this.#strategyParams, account, clock: this.#clock,
          stopBand: this.#stopBand,
        });
      } catch (err) {
        // An exception inside a strategy is an UNDEFINED state for the agent.
        this.#repos.logEvent({
          level: 'FATAL', category: 'strategy_error', clock: this.#clock,
          message: `Strategy ${strategy.id} threw on ${symbol}: ${err.message}. Agent entering FAILED state.`,
          details: { symbol, strategyId: strategy.id, error: toErrorPayload(err) },
        });
        this.#state.transition(STATES.FAILED, `STRATEGY_ERROR:${err.message}`);
        this.#repos.engageStop({
          trigger: 'STRATEGY_ERROR', severity: 'CATASTROPHIC', scope: 'NEW_ORDERS',
          reason: `Strategy ${strategy.id} threw: ${err.message}`,
          details: { symbol, error: toErrorPayload(err) }, clock: this.#clock,
        });
        return null;
      }

      if (!signalObj || signalObj.signal === 'HOLD') continue;

      // A signal is an EVENT, not a level. A crossover observed at tick 1 of a
      // 30-tick candle is still the same crossover at tick 29, and recording it
      // 30 times would put 30 identical "decisions" in the audit trail and 30
      // order intents through the firewall. Fire once per (symbol, candle, side);
      // the next candle can fire again.
      const candleKey = candles[candles.length - 1]?.ts ?? candles.length;
      const emitKey = `${symbol}|${candleKey}|${signalObj.signal}`;
      if (this.#lastEmittedKey.get(symbol) === emitKey) {
        this.#suppressedSignals += 1;
        continue;
      }
      // Claim this signal for the candle BEFORE the in-flight check below, so a
      // symbol whose order is still working does not re-evaluate (and re-log)
      // every tick for the remainder of the candle.
      this.#lastEmittedKey.set(symbol, emitKey);

      // An order for this (symbol, side) is already live at the exchange.
      // Building a second one would duplicate a position change that has not
      // happened yet. This is a normal condition, not an error: the working
      // order is the exchange's to fill or cancel.
      const working = this.workingOrder(symbol, signalObj.signal);
      if (working) {
        this.#suppressedInFlight += 1;
        this.#repos.logEvent({
          level: 'INFO', category: 'order_in_flight', clock: this.#clock,
          message: `${signalObj.signal} ${symbol} suppressed: order ${working.orderId} is still working (${working.status}, ${roundTo(working.filledQuantity ?? 0, 8)}/${roundTo(working.quantity, 8)}).`,
          details: {
            symbol, side: signalObj.signal, workingOrderId: working.orderId,
            workingStatus: working.status, filledQuantity: working.filledQuantity, orderQuantity: working.quantity,
          },
        });
        continue;
      }

      // Ask the RISK ENGINE for the authoritative size. The same pure
      // function is called again by the firewall, so the number in the
      // immutable decision record is exactly the number that is validated and
      // (if everything else passes) submitted. The agent cannot invent a size
      // the risk engine has not bounded.
      const proposal = this.#riskEngine.proposeOrder({
        decision: { ...signalObj, symbol, strategyMeta: signalObj.meta ?? {}, risk: { stopPrice: signalObj.stopPrice }, agentState: this.#state.state },
        account,
        quote,
        instrument: this.#config.instruments.find((i) => i.symbol === symbol),
      });

      // A zero-size proposal is not an order intent - it is the sizer reporting
      // that there is nothing legitimate to do here (no position to exit, or the
      // budget cannot buy the minimum lot). Record the SKIP and let the audit
      // trail show why, rather than submitting a quantity the risk engine has
      // already decided is invalid.
      const isEntry = signalObj.signal === 'BUY';
      const permissionOk = isEntry ? this.#state.can('openPosition') : this.#state.can('reduceOnly');
      const notAnOrder = !(proposal.quantity > 0);
      const action = (permissionOk && !notAnOrder) ? 'PLACE_ORDER' : 'SKIP';
      const skipReason = notAnOrder
        ? proposal.reason ?? 'SIZE_UNAVAILABLE'
        : (permissionOk ? null : `AGENT_STATE_${this.#state.state}_FORBIDS_${isEntry ? 'ENTRY' : 'EXIT'}`);

      // The EFFECTIVE stop is the risk engine's, not the strategy's raw intent:
      // the record must describe the order that is actually validated.
      const effectiveStopDistancePct = proposal.stopDistancePct ?? signalObj.stopDistancePct;
      const effectiveStopPrice = proposal.stopPrice ?? signalObj.stopPrice;

      const sealed = sealDecision({
        permissions: this.#state.permissions,
        symbol,
        strategyId: strategy.id,
        price: quote.mid,
        signalObj: skipReason
          ? { ...signalObj, reason: `${signalObj.reason} [no order: ${skipReason}]` }
          : signalObj,
        risk: {
          riskBudgetEgp: proposal.riskBudgetEgp,
          maxLossEgp: this.#config.risk.maxLossPerTradeEgp,
          stopPrice: effectiveStopPrice,
          stopDistancePct: effectiveStopDistancePct,
          riskRewardRatio: signalObj.riskRewardRatio,
          sizePctOfEquity: proposal.sizePctOfEquity ?? 0,
          feeBpsEstimate: this.#config.fees.takerBps,
          expectedSlippageBps: proposal.expectedSlippageBps ?? 0,
          expectedSlippageEgp: proposal.expectedSlippageEgp ?? 0,
        },
        quantity: proposal.quantity,
        notionalEgp: proposal.notionalEgp,
        positionSizeSource: `RISK_SIZED:${proposal.sizeBoundBy ?? proposal.sizeReason ?? 'N/A'}`,
        expectedExecutionPrice: quote.mid,
        stopCondition: isEntry && effectiveStopPrice
          ? `Stop loss at ${roundTo(effectiveStopPrice, 8)} (${roundTo(effectiveStopDistancePct ?? 0, 4)}% below entry)`
            + (proposal.stopClamped ? ', widened by the risk engine to the minimum policy distance' : '')
            + '. Long-only cash account; the position is closed at market on breach.'
          : 'Exit of an existing long position; no new stop required.',
        action,
        agentState: this.#state.state,
        clock: this.#clock,
      });

      this.#repos.insertDecision(decisionToRow(sealed), this.#clock);
      this.#lastQuoteAt.set(symbol, nowMs);
      return { ...sealed, __quote: quote, __proposal: proposal };
    }
    return null;
  }

  /** Called by the worker after a HALT, to reinstate evaluation later. */
  scheduleCooldown() {
    this.#haltedUntilMs = this.#clock.now() + this.#config.risk.haltCooldownMs;
    this.#consecutiveFailures = 0;
    return this.#haltedUntilMs;
  }

  noteFailure() {
    this.#consecutiveFailures += 1;
    return this.#consecutiveFailures;
  }

  /**
   * Build the decision that closes a position whose stop has been breached.
   *
   * A stop-loss exit is a REAL order, so it is a real Decision: it gets a
   * decision id, a risk evaluation, a Sentinel verdict, an order row and fills,
   * exactly like a strategy entry or exit. There is deliberately no second path
   * from "stop breached" to "position closed" - that path would be an order
   * bypassing the firewall, which the architecture forbids outright.
   *
   * Confidence is 1.0 because it is not a judgement: the stop has already
   * triggered. The reason the Sentinel's low-confidence review must not delay a
   * stop is therefore expressed in the data, not in a special case.
   *
   * @returns {object|null} sealed Decision, or null if there is nothing to close
   */
  buildStopExitDecision({ symbol, stopPrice, quote, account, position }) {
    if (!position || !(position.quantity > 0)) return null;
    const signalObj = makeSignal({
      signal: 'SELL',
      confidence: 1,
      reason: `Stop loss breached in ${symbol}: mid ${roundTo(quote.mid, 8)} is at or below the stop ${roundTo(stopPrice, 8)}. Closing the long immediately.`,
      features: { mid: quote.mid, stopPrice, avgEntryPrice: position.avg_entry_price, positionQuantity: position.quantity },
      stopPrice: null,
      targetPrice: null,
      stopDistancePct: null,
      riskRewardRatio: null,
      meta: { intent: 'STOP_LOSS_EXIT', stopPrice, symbol },
    });

    const proposal = this.#riskEngine.proposeOrder({
      decision: { ...signalObj, symbol, strategyMeta: signalObj.meta, risk: { stopPrice: null }, agentState: this.#state.state },
      account,
      quote,
      instrument: this.#config.instruments.find((i) => i.symbol === symbol),
    });

    return sealDecision({
      permissions: this.#state.permissions,
      symbol,
      strategyId: `${this.#strategyId}:stop`,
      price: quote.mid,
      signalObj,
      risk: {
        riskBudgetEgp: 0,
        maxLossEgp: 0,
        stopPrice: null,
        stopDistancePct: null,
        riskRewardRatio: null,
        sizePctOfEquity: account.equityEgp > 0 ? roundTo((proposal.notionalEgp / account.equityEgp) * 100, 6) : 0,
        feeBpsEstimate: this.#config.fees.takerBps,
        expectedSlippageBps: proposal.expectedSlippageBps ?? 0,
        expectedSlippageEgp: proposal.expectedSlippageEgp ?? 0,
      },
      quantity: proposal.quantity,
      notionalEgp: proposal.notionalEgp,
      positionSizeSource: 'RISK_SIZED:STOP_EXIT_FULL_POSITION',
      expectedExecutionPrice: quote.mid,
      stopCondition: 'The stop that produced this decision has already been breached; the position is being closed at market. No further stop applies.',
      action: 'PLACE_ORDER',
      agentState: this.#state.state,
      clock: this.#clock,
    });
  }

  /**
   * Validate an open position against its stop using the current market.
   * Returns the stop prices that are currently breached.
   */
  breachedStops() {
    const breaches = new Map();
    for (const pos of this.#account.getPositions()) {
      const decision = this.#repos.db.get(
        `SELECT stop_price FROM agent_decisions
         WHERE mode = ? AND symbol = ? AND signal = 'BUY' AND stop_price IS NOT NULL
         ORDER BY ts_ms DESC LIMIT 1`,
        this.#repos.mode, pos.symbol,
      );
      const stopPrice = decision?.stop_price;
      if (stopPrice == null) continue;
      const q = this.#safeQuote(pos.symbol);
      if (!q) continue;
      if (q.mid <= stopPrice) breaches.set(pos.symbol, stopPrice);
    }
    return breaches;
  }

  describe() {
    return {
      state: this.#state.toJSON(),
      strategy: {
        id: this.strategyId,
        description: this.strategy.description,
        params: this.#strategyParams,
        minBars: this.strategy.minBars,
      },
      suppression: {
        sameCandleSignals: this.#suppressedSignals,
        inFlightOrders: this.#suppressedInFlight,
      },
      lastQuoteAt: Object.fromEntries([...this.#lastQuoteAt]),
    };
  }
}

export { permissionsFor, roundEgp };
