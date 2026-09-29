/**
 * TEOS Trade Agent - broker/mock/mock-broker.js
 *
 * The ONLY broker implementation in Phase 1.
 *
 * It implements the full broker interface against the deterministic market
 * simulator and the matching engine, and settles fills into the paper account.
 * It refuses to be constructed in any mode other than PAPER / BACKTEST, and it
 * never opens a network socket.
 *
 * Failure injection (for tests of the risk engine's CONNECTION rule and the
 * "API/data connection fails -> STOP trading" requirement):
 *   broker.injectFailure({ type: 'DISCONNECT' | 'DATA_STALL' | 'ABNORMAL_PRICE' })
 *   broker.clearFailure()
 */

import { MarketSimulator } from './market-simulator.js';
import { MatchingEngine, OPEN_STATUSES } from './matching-engine.js';
import { FeeModel } from './fees.js';
import { SlippageModel } from './slippage.js';
import { Rng } from './rng.js';
import {
  assertBrokerShape, registerBroker, getBroker,
} from '../broker.interface.js';
import { ConnectionError, MarketDataStaleError, ModeNotAllowedError, ValidationError } from '../../core/errors.js';
import { roundEgp, roundTo } from '../../core/money.js';
import { newId } from '../../core/ids.js';

export class MockBroker {
  #config;
  #clock;
  #repos;
  #account;
  #onFill;
  #onEvent;
  #rng;
  #connected = false;
  #lastErrorAt = null;
  #consecutiveFailures = 0;
  #lastQuoteMsBySymbol = new Map();
  #failure = null;
  #quotes = new Map();
  #ticksSinceCandle = 0;
  #instruments = new Map();
  #abnormalApplied = false;

  constructor({ config, clock, repos, account, mode = 'PAPER', seed = null, onFill = null, onEvent = null, marketSource = null }) {
    if (mode === 'LIVE') {
      throw new ModeNotAllowedError('MockBroker cannot be constructed in LIVE mode.', { mode });
    }
    this.providerId = 'mock-paper';
    this.kind = 'PAPER';
    this.mode = mode;
    this.#config = config;
    this.#clock = clock;
    this.#repos = repos;
    this.#account = account;
    this.#onFill = onFill;
    this.#onEvent = onEvent;

    const instruments = new Map(config.instruments.map((i) => [i.symbol, i]));
    this.#instruments = instruments;
    this.#rng = new Rng(seed ?? config.market.seed);
    // The market SOURCE is the only thing that differs between paper trading
    // and backtesting. Everything downstream of here - the matching engine, the
    // fee and slippage models, settlement, the risk engine, the Sentinel - is
    // the same code, which is what makes a backtest result comparable to paper
    // trading rather than a separate, more flattering simulation.
    this.simulator = marketSource ?? new MarketSimulator(config.market, config.instruments, { seed: seed ?? config.market.seed });
    this.feeModel = new FeeModel(config.fees);
    this.slippageModel = new SlippageModel(config.slippage, this.#rng, { liquidityProxyEgp: 250_000 });
    this.engine = new MatchingEngine({
      executionConfig: config.execution,
      feeModel: this.feeModel,
      slippageModel: this.slippageModel,
      rng: this.#rng,
      instruments,
    });
    // The engine does not know what a position is. This is the bridge: before
    // any fill is produced, the broker says whether the fill is still possible
    // given the long actually held. An exit order for a position that another
    // order already closed is cancelled here, with a reason, instead of
    // producing a fill the account would have to throw on.
    this.engine.setFillGuard((order, _quote, proposedQty) => this.#fillGuard(order, proposedQty));

    this.#connected = false;
    this.#lastErrorAt = null;
    this.#consecutiveFailures = 0;
    this.#lastQuoteMsBySymbol = new Map();
    this.#failure = null;
    this.#quotes = new Map();
    this.#ticksSinceCandle = 0;
  }

  isPaper() { return true; }

  /**
   * Replace the market source after construction.
   *
   * The backtest engine uses this to swap the live simulator for a recorded
   * history. The broker is constructed with a reference to the account and the
   * repositories, which only the worker has, so the source is swapped after
   * construction rather than injected. It is swapped BEFORE the first tick, and
   * every downstream component - matching engine, fees, slippage, settlement -
   * is untouched, which is exactly the property a backtest needs.
   */
  setMarketSource(source) {
    if (!source) throw new ValidationError('Market source may not be null.', {});
    for (const m of ['tick', 'rollCandle', 'candles', 'has']) {
      if (typeof source[m] !== 'function') throw new ValidationError(`Market source is missing ${m}().`, {});
    }
    if (!('sequence' in source)) throw new ValidationError('Market source is missing a sequence counter.', {});
    this.simulator = source;
    this.#ticksSinceCandle = 0;
    return this;
  }

  /**
   * LONG-ONLY, CASH-FUNDED account guard, applied to every proposed fill.
   *
   * A SELL can only ever reduce a long. If the long is gone (another exit
   * filled first, or a restart reconciled it away) the order cannot fill and is
   * cancelled. If the long is smaller than the order, the fill is capped to
   * what is actually held so the recorded fill and the position movement stay
   * in exact agreement.
   */
  #fillGuard(order, proposedQty) {
    if (order.side === 'SELL') {
      const pos = this.#account.positionFor(order.symbol);
      const available = pos ? pos.quantity : 0;
      if (!(available > 0)) {
        return { allowed: false, quantity: 0, reason: 'NO_POSITION_TO_SELL' };
      }
      if (proposedQty > available + 1e-9) {
        return { allowed: true, quantity: available, reason: 'FILL_CAPPED_TO_AVAILABLE_LONG' };
      }
      return { allowed: true, quantity: proposedQty, reason: null };
    }

    // BUY: the fill must be payable from cash on hand.
    //
    // Without this the broker accepts a BUY it cannot fund, and the failure
    // surfaces much later - inside `#settle`, from the ledger's own refusal to
    // go negative. The order is then CANCELED with
    // `SETTLEMENT_FAILED:INSUFFICIENT_BALANCE`, which is misleading: it reads
    // as an infrastructure fault rather than the order being unfundable, and
    // it increments `consecutiveFailures`, which is the counter that drives the
    // CONNECTION rule's halt. An over-budget order therefore masquerades as a
    // failing exchange and can stop trading for a condition that is purely
    // arithmetic.
    //
    // Capping to what cash can cover is the same treatment a SELL gets when the
    // long is smaller than the order: fill what is affordable, cancel the
    // remainder, and record why.
    const price = Number.isFinite(order.expectedPrice) && order.expectedPrice > 0
      ? order.expectedPrice
      : null;
    if (price == null) return { allowed: true, quantity: proposedQty, reason: null };

    const affordable = this.#affordableQuantity(order.symbol, price);
    if (!(affordable > 0)) {
      return { allowed: false, quantity: 0, reason: 'INSUFFICIENT_CASH_TO_FILL' };
    }
    if (proposedQty > affordable + 1e-9) {
      return { allowed: true, quantity: affordable, reason: 'FILL_CAPPED_TO_AVAILABLE_CASH' };
    }
    return { allowed: true, quantity: proposedQty, reason: null };
  }

  /**
   * Largest quantity of `symbol` buyable at `price` with cash on hand, net of
   * the taker fee and allowing for slippage. Rounded DOWN to the instrument's
   * quantity step, because a step-rounded-up quantity is not affordable.
   */
  #affordableQuantity(symbol, price) {
    const inst = this.#instruments.get(symbol) ?? null;
    const step = inst?.qtyStep && inst.qtyStep > 0 ? inst.qtyStep : 0.01;
    const cash = this.#account.cashEgp;
    if (!(cash > 0)) return 0;

    // Worst-case cost of one unit: the price plus the fee and a full slippage
    // allowance, so the cap cannot be exceeded by the fill actually pricing
    // slightly above `expectedPrice`.
    const worstCaseUnit = price * (1 + (this.#config.slippage.maxBps + this.#config.fees.takerBps) / 10_000);
    const raw = cash / worstCaseUnit;
    const qty = roundTo(Math.floor(raw / step) * step, 8);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }

  // ------------------------------------------------------------ lifecycle
  connect() {
    try {
      if (this.#failure?.type === 'DISCONNECT') {
        throw new ConnectionError('Simulated exchange connection failure.', { injected: true });
      }
      this.#connected = true;
      this.#consecutiveFailures = 0;
      this.#lastErrorAt = null;
      return { ok: true, detail: 'mock paper exchange connected', mode: this.mode };
    } catch (err) {
      this.#recordFailure(err);
      return { ok: false, detail: err.message };
    }
  }

  disconnect() {
    this.#connected = false;
    return { ok: true, detail: 'disconnected' };
  }

  #recordFailure(err) {
    this.#connected = false;
    this.#lastErrorAt = this.#clock.now();
    this.#consecutiveFailures += 1;
    this.#emit('error', 'broker_failure', err.message, { consecutiveFailures: this.#consecutiveFailures });
  }

  #emit(level, category, message, details) {
    if (this.#onEvent) {
      try { this.#onEvent({ level, category, message, details }); } catch { /* never throw from telemetry */ }
    }
  }

  health() {
    const now = this.#clock.now();
    let oldest = null;
    for (const [symbol, ms] of this.#lastQuoteMsBySymbol) {
      const age = now - ms;
      if (oldest === null || age > oldest.age) oldest = { symbol, age, tsMs: ms };
    }
    return {
      ok: this.#connected && this.#consecutiveFailures < this.#config.risk.consecutiveFailureHaltCount,
      connected: this.#connected,
      lastErrorAt: this.#lastErrorAt,
      consecutiveFailures: this.#consecutiveFailures,
      failure: this.#failure,
      oldestQuoteAgeMs: oldest?.age ?? null,
      oldestQuoteSymbol: oldest?.symbol ?? null,
      quotesReceived: this.#lastQuoteMsBySymbol.size,
      provider: this.providerId,
      mode: this.mode,
    };
  }

  injectFailure(failure) {
    this.#failure = failure;
    if (failure?.type === 'DISCONNECT') this.#connected = false;
    this.#emit('warn', 'failure_injected', `Injected failure: ${failure?.type ?? 'none'}`, failure ?? {});
    return this.health();
  }

  clearFailure() {
    this.#failure = null;
    this.#consecutiveFailures = 0;
    this.#connected = true;
    this.#abnormalApplied = false;
    return this.health();
  }

  // ---------------------------------------------------------- market data
  /**
   * Advance the simulation one tick, match resting orders, settle fills.
   * Returns the fresh quotes.
   */
  tick() {
    if (!this.#connected) {
      throw new ConnectionError('Broker is not connected.', { provider: this.providerId });
    }
    if (this.#failure?.type === 'DATA_STALL') {
      // Data stops advancing: the risk engine must see the feed go stale.
      this.#consecutiveFailures += 1;
      return [];
    }

    let quotes;
    try {
      quotes = this.simulator.tick();
    } catch (err) {
      this.#recordFailure(err);
      throw err;
    }

    // ABNORMAL_PRICE: corrupt ONE symbol's quote by a jump far beyond
    // `market.maxTickJumpBps`, leaving the rest of the feed intact.
    //
    // This injection point was documented on the class and honoured by
    // DISCONNECT and DATA_STALL, but had no implementation: `injectFailure`
    // accepted it and then nothing happened, so any test of the "abnormal
    // price" path silently passed against an unperturbed market. Fault
    // injection that does not inject is worse than none at all - it is a green
    // test that proves nothing.
    //
    // The shock MUST be applied before the loop below, which stores each quote
    // by symbol. Mutating the array inside the loop appears to work and then
    // does not: the iterator has already yielded the original element, so the
    // uncorrupted quote is written back and overwrites the shock.
    if (this.#failure?.type === 'ABNORMAL_PRICE' && !this.#abnormalApplied) {
      const target = this.#failure.symbol ?? this.simulator.symbols()[0];
      const jumpBps = this.#failure.bps ?? 10 * this.#config.market.maxTickJumpBps;
      const shocked = this.simulator.forceJump(target, jumpBps);
      if (shocked) {
        this.#abnormalApplied = true;
        const i = quotes.findIndex((x) => x.symbol === target);
        if (i >= 0) quotes[i] = shocked;
        else quotes.push(shocked);
      }
    }

    const now = this.#clock.now();
    for (const q of quotes) {
      q.tsMs = now;
      this.#quotes.set(q.symbol, q);
      this.#lastQuoteMsBySymbol.set(q.symbol, now);
      this.#account.mark(q.symbol, q.mid);
    }

    this.#ticksSinceCandle += 1;
    if (this.#ticksSinceCandle >= this.#config.market.ticksPerCandle) {
      this.#ticksSinceCandle = 0;
      this.simulator.rollCandle();
    }

    // Match resting orders and settle.
    for (const q of quotes) {
      const { fills, canceled } = this.engine.match(q);
      for (const c of canceled) this.#recordGuardCancel(c);
      for (const fill of fills) {
        try {
          this.#settle(fill, q);
        } catch (err) {
          // Settlement must never propagate out of tick(): a throw here would be
          // read by the worker as a fatal loop error and latch an emergency stop
          // for what is, in the end, an order-level condition. Record it, fail
          // the order, and let the failure counter surface it to the risk engine
          // if it ever becomes systemic.
          this.#onSettleFailure(fill, err);
        }
      }
    }
    return quotes;
  }

  /** An order the fill guard refused: cancel it in the book and in the ledger. */
  #recordGuardCancel(c) {
    try {
      this.#repos.updateOrderStatus(c.orderId, {
        status: 'CANCELED',
        filledQuantity: c.filledQuantity,
        rejectionReason: c.reason,
        terminal: true,
        clock: this.#clock,
      });
    } catch (err) {
      this.#emit('error', 'order_cancel_persist_failed', `Could not persist cancel of ${c.orderId}: ${err.message}`, c);
    }
    this.#emit('warn', 'order_canceled_unfillable',
      `Order ${c.orderId} canceled unfillable (${c.reason}); filled ${c.filledQuantity}, remaining ${c.remainingQuantity}.`,
      { orderId: c.orderId, reason: c.reason, filledQuantity: c.filledQuantity, remainingQuantity: c.remainingQuantity });
  }

  /**
   * Belt-and-braces: an unexpected settlement failure costs the order, not the
   * loop. The failure is counted so the CONNECTION rule can halt if this is
   * systemic rather than a one-off.
   */
  #onSettleFailure(fill, err) {
    this.#consecutiveFailures += 1;
    this.#lastErrorAt = this.#clock.now();
    try {
      const order = this.engine.getOrder(fill.orderId);
      this.engine.cancel(fill.orderId, this.#clock.now(), `SETTLEMENT_FAILED:${err.code ?? 'ERROR'}`);
      this.#repos.updateOrderStatus(fill.orderId, {
        status: 'CANCELED',
        rejectionReason: `SETTLEMENT_FAILED:${err.code ?? err.message}`,
        terminal: true,
        clock: this.#clock,
      });
      this.#emit('error', 'settlement_failed',
        `Settlement of fill on ${fill.orderId} failed: ${err.message}. Order canceled.`,
        { orderId: fill.orderId, symbol: fill.symbol, side: fill.side, error: err.message, code: err.code ?? null, priorStatus: order?.status ?? null, consecutiveFailures: this.#consecutiveFailures });
    } catch (nested) {
      this.#emit('error', 'settlement_failed', `Settlement of ${fill.orderId} failed and could not be recorded: ${nested.message}`, { original: err.message });
    }
  }

  #settle(fill, quote) {
    const order = this.engine.getOrder(fill.orderId);
    // Persist the fill, then update the order, then move the money.
    this.#repos.db.tx(() => {
      const fillId = this.#repos.insertFill({ ...fill, submittedTs: undefined }, this.#clock);
      fill.fillId = fillId;
      this.#repos.updateOrderStatus(fill.orderId, {
        status: order.status,
        filledQuantity: order.filledQuantity,
        avgFillPrice: order.avgFillPrice,
        terminal: order.status === 'FILLED',
        clock: this.#clock,
      });
      this.#account.applyFill({ ...fill, fillId }, { order });
    });
    this.#emit('info', 'fill', `fill ${fill.side} ${fill.quantity} ${fill.symbol} @ ${fill.price}`, {
      orderId: fill.orderId, feeEgp: fill.feeEgp, slippageBps: fill.slippageBps,
    });
    if (this.#onFill) {
      try { this.#onFill({ fill, quote }); } catch { /* observer must not break execution */ }
    }
  }

  getMarketData(symbol = null) {
    if (symbol) {
      const q = this.#quotes.get(symbol);
      if (!q) throw new ValidationError(`No market data for ${symbol}.`, { symbol });
      return { ...q, ts: this.#clock.nowIso(), mode: this.mode };
    }
    return [...this.#quotes.values()].map((q) => ({ ...q, ts: this.#clock.nowIso(), mode: this.mode }));
  }

  get_market_data(symbol = null) { return this.getMarketData(symbol); }

  /** Age of the newest quote for a symbol. -1 if never seen. */
  quoteAgeMs(symbol) {
    const ms = this.#lastQuoteMsBySymbol.get(symbol);
    if (ms === undefined) return -1;
    return this.#clock.now() - ms;
  }

  candles(symbol) { return this.simulator.candles(symbol); }

  /** Mark-to-market a symbol without advancing the simulation. */
  mark(symbol, price) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new ValidationError(`Invalid mark price for ${symbol}: ${price}`, { symbol, price });
    }
    return this.#account.mark(symbol, price);
  }

  // -------------------------------------------------------------- account
  getBalance() { return this.#account.getBalance(); }
  get_balance() { return this.#account.getBalance(); }

  getPositions() { return this.#account.getPositions(); }
  get_positions() { return this.#account.getPositions(); }

  getOpenOrders() { return this.engine.listOpenOrders(); }
  get_open_orders() { return this.getOpenOrders(); }

  /**
   * The oldest still-working order for a (symbol, side), or null.
   * Used to prevent a second order being created for a position that already
   * has an exit in flight.
   */
  workingOrder(symbol, side) { return this.engine.findWorkingOrder(symbol, side); }

  // ------------------------------------------------------------ execution
  /**
   * Place an order. This is the LAST point at which an order can be created.
   * The caller (ExecutionAdapter) has already passed the risk engine and the
   * Sentinel; this function performs local sanity checks only.
   *
   * Idempotency: a repeated client_order_id returns the ORIGINAL order with
   * `duplicate: true` and never creates a second order.
   */
  placeOrder(order) {
    if (!this.#connected) {
      throw new ConnectionError('Cannot place order: broker not connected.', { provider: this.providerId });
    }
    if (order.leverageRequested === true || order.borrowRequested === true) {
      throw new ValidationError('Leverage/borrowing requests are refused at the broker boundary.', { order });
    }
    const existing = this.engine.getOrderByClientId(order.clientOrderId);
    if (existing) {
      return { ...existing, duplicate: true, accepted: false, reason: 'DUPLICATE_CLIENT_ORDER_ID' };
    }
    if (!this.simulator.has(order.symbol)) {
      const res = this.engine.submit({ ...order, submittedTs: this.#clock.now() });
      return { status: 'REJECTED', rejectionReason: `UNKNOWN_SYMBOL:${order.symbol}`, accepted: false, duplicate: false };
    }
    const res = this.engine.submit({ ...order, submittedTs: this.#clock.now() });
    if (res.status === 'REJECTED') {
      return { status: 'REJECTED', rejectionReason: res.rejectionReason, accepted: false, duplicate: false };
    }
    return { ...res.order, accepted: true, duplicate: false, status: 'NEW' };
  }

  place_order(order) { return this.placeOrder(order); }

  cancelOrder(orderId) {
    const canceled = this.engine.cancel(orderId, this.#clock.now());
    if (canceled) {
      this.#repos.updateOrderStatus(orderId, { status: 'CANCELED', terminal: true, clock: this.#clock });
    }
    return { canceled, order: this.engine.getOrder(orderId) };
  }

  cancel_order(orderId) { return this.cancelOrder(orderId); }

  getOrder(orderId) { return this.engine.getOrder(orderId); }
  getFills(orderId = null) { return this.engine.listFills(orderId); }
  listAllOrders() { return this.engine.listAllOrders(); }

  /**
   * Restart recovery: mark in-flight orders UNKNOWN and reconcile with the
   * recorded fills. They are NEVER resubmitted.
   */
  reconcileOrphans() {
    const orphans = this.#repos.orphanOrders(this.mode);
    const recovered = [];
    for (const o of orphans) {
      const fills = this.#repos.listFills({ orderId: o.order_id, mode: this.mode });
      if (fills.length === 0) {
        this.#repos.updateOrderStatus(o.order_id, { status: 'UNKNOWN', terminal: false, clock: this.#clock });
        this.engine.markStatusUnknown(o.order_id, this.#clock.now());
        recovered.push({ orderId: o.order_id, resolution: 'UNKNOWN_NO_FILLS', resubmitted: false });
      } else {
        const filled = fills.reduce((a, f) => a + f.quantity, 0);
        const done = filled >= o.quantity - 1e-9;
        this.#repos.updateOrderStatus(o.order_id, {
          status: done ? 'FILLED' : 'PARTIALLY_FILLED',
          filledQuantity: roundTo(filled, 8),
          clock: this.#clock,
        });
        recovered.push({
          orderId: o.order_id,
          resolution: done ? 'FILLED' : 'PARTIALLY_FILLED',
          resubmitted: false,
        });
      }
    }
    return recovered;
  }

  get snapshot() {
    return {
      provider: this.providerId, mode: this.mode, seq: this.simulator.sequence,
      connected: this.#connected, failures: this.#consecutiveFailures,
      openOrders: this.getOpenOrders().length, quotes: this.#quotes.size,
    };
  }
}

/**
 * Static self-check of the broker interface, run once at import time without
 * constructing a broker: every method required by BROKER_INTERFACE must exist
 * on the prototype. This keeps the contract test honest and side-effect free.
 */
export function assertMockBrokerInterface() {
  return assertBrokerShape(Object.create(MockBroker.prototype));
}

assertMockBrokerInterface();

/** The provider id under which this broker is registered. */
export const MOCK_PROVIDER_ID = 'mock-paper';

export function registerMockBroker(broker) {
  return registerBroker(broker);
}

export function getMockBroker(providerId = MOCK_PROVIDER_ID) {
  return getBroker(providerId);
}
