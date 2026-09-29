/**
 * TEOS Trade Agent - dashboard/api.js
 *
 * Read-only projections of the database into the four dashboard sections:
 * ACCOUNT, AGENT, RISK, AUDIT.
 *
 * Every function here is pure with respect to HTTP: it takes repositories and
 * returns a plain JSON-serialisable object. Nothing in this file opens a socket,
 * writes a row, or mutates state. That separation is what makes the dashboard
 * testable without a server, and it is what makes "the dashboard cannot place an
 * order" a structural claim rather than a promise: to write, code in this file
 * would have to call a mutating repository method, and there is no such call.
 *
 * Every payload is passed through `scrub()` before it leaves. The dashboard is
 * the one component that hands data to something outside the process, so it is
 * the right place for a last non-negotiable redaction pass, even though
 * `core/env.js` already refuses to boot with a credential set.
 */

import { STREAMS } from '../database/audit-chain.js';
import { redact } from '../core/env.js';

const AUDIT_STREAMS = [STREAMS.DECISION, STREAMS.RISK, STREAMS.SENTINEL, STREAMS.ORDER];

/** Binds a query string param to a bounded integer. */
function intParam(params, name, fallback, { min = 0, max = 5000 } = {}) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** A param that is only accepted from a fixed allow-list. Never interpolated. */
function enumParam(params, name, allowed, fallback) {
  const v = params.get(name);
  return allowed.includes(v) ? v : fallback;
}

/** Numbers that are not finite are shown as null, never as NaN in JSON. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strip the large JSON columns out of list rows; the UI never renders them. */
function lean(row, drop = []) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (drop.includes(k)) continue;
    out[k] = typeof v === 'number' && !Number.isFinite(v) ? null : v;
  }
  return out;
}

/**
 * Assemble the four sections into the envelope the client polls, and scrub it.
 *
 * The section builders are called once each, here, and their results are the
 * only thing that reaches `scrub()`. Repositories, config and chains are never
 * spread into the payload, so there is no path by which a live object graph
 * could be serialised by accident.
 */
function envelope(view, { limit = 200, equityLimit = 500 } = {}) {
  return scrub({
    generatedAt: new Date().toISOString(),
    mode: view.mode,
    disclaimer: {
      paperOnly: true,
      liveTrading: 'not implemented in Phase 1; no live execution adapter exists',
      leverage: 'impossible by construction: long-only, cash-funded, cash can never go negative',
      currency: 'EGP',
    },
    account: accountSection(view, { equityLimit }),
    agent: agentSection(view),
    risk: riskSection(view),
    audit: auditSection(view, { limit }),
  });
}

/**
 * The last gate before anything leaves the process.
 *
 * `core/env.js` already refuses to boot if a credential variable is set, so
 * this is belt-and-braces. It stays because the dashboard is the one component
 * that serialises data to something outside the process, and a redaction pass
 * that only exists in the config loader is one refactor away from being
 * bypassed. `redact()` also coerces `Error` instances, so a thrown object
 * cannot smuggle a stack frame (and whatever a future edit put in it) into a
 * response.
 */
function scrub(value) {
  return redact(value);
}

// ------------------------------------------------------------------ ACCOUNT

/**
 * ACCOUNT: money, positions, the equity curve, and the invariant that says the
 * money is real.
 *
 * `equityInvariantOk` is the headline. A dashboard that renders equity without
 * showing that equity reconciles to cash plus exposure is decoration; the
 * number is only trustworthy if the decomposition underneath it is displayed
 * next to it.
 */
export function accountSection(view, { equityLimit = 500 } = {}) {
  const { config, repos, mode } = view;
  const balance = repos.latestBalance(mode);
  const positions = repos.listOpenPositions(mode);
  const snapshots = repos.latestSnapshots(mode);
  const series = repos.equitySeries({ limit: equityLimit, mode, newest: true });
  const trades = repos.tradeStats(mode, view.scopeRunId);
  const realized = repos.realizedPnl(mode);
  const fees = repos.totalFees(mode);
  const slippage = repos.totalSlippageCost(mode);

  const cash = num(balance?.cash_egp) ?? config.account.startingCapitalEgp;
  const exposure = num(balance?.exposure_egp) ?? 0;
  const equity = num(balance?.equity_egp) ?? cash;
  const delta = Math.abs(equity - (cash + exposure));

  let peak = equity;
  let maxDrawdownPct = 0;
  for (const s of series) {
    if (s.equity_egp > peak) peak = s.equity_egp;
    const dd = peak > 0 ? ((peak - s.equity_egp) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    startingCapitalEgp: config.account.startingCapitalEgp,
    capitalCeilingEgp: config.risk.maxStartingCapitalEgp,
    baseAsset: config.account.baseAsset,
    cashEgp: cash,
    equityEgp: equity,
    exposureEgp: exposure,
    realizedPnlEgp: num(balance?.realized_pnl_egp) ?? realized,
    unrealizedPnlEgp: num(balance?.unrealized_pnl_egp) ?? 0,
    feesPaidEgp: num(balance?.fees_paid_egp) ?? fees,
    slippagePaidEgp: num(balance?.slippage_cost_egp) ?? slippage,
    openPositionCount: positions.length,
    // The invariant, shown rather than asserted in a comment.
    equityInvariant: {
      ok: delta <= 0.01,
      deltaEgp: Number(delta.toFixed(6)),
      formula: 'equity = cash + exposure',
    },
    capitalInvariant: {
      ok: equity <= config.risk.maxStartingCapitalEgp + 0.01,
      ceilingEgp: config.risk.maxStartingCapitalEgp,
      cashNonNegative: cash >= -0.01,
    },
    peakEquityEgp: Number(peak.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    trades,
    positions: positions.map((p) => ({
      positionId: p.position_id,
      symbol: p.symbol,
      quantity: p.quantity,
      avgEntryPrice: p.avg_entry_price,
      realizedPnlEgp: p.realized_pnl_egp,
      feesPaidEgp: p.fees_paid_egp,
      openedAt: p.opened_at,
      runId: p.run_id,
    })),
    market: snapshots.map((s) => ({
      symbol: s.symbol, bid: s.bid, ask: s.ask, last: s.last, mid: s.mid,
      spreadBps: s.spread_bps, source: s.source, ts: s.ts, isStale: s.is_stale,
    })),
    equityCurve: series.map((s) => ({
      ts: s.ts, tsMs: s.ts_ms, equityEgp: s.equity_egp, cashEgp: s.cash_egp,
      exposureEgp: s.exposure_egp, drawdownPct: s.drawdown_pct,
    })),
  };
}

// --------------------------------------------------------------------- AGENT

/**
 * AGENT: which run is live, whether it is alive, and what it has been doing.
 *
 * The health probe is computed here from the stored heartbeat rather than
 * fetched from the running process, so the dashboard reports the same thing a
 * `status` command run five minutes later would report.
 */
export function agentSection(view) {
  const { repos, mode, config } = view;
  const run = repos.latestRun(mode);
  const heartbeat = repos.latestHeartbeat(mode);
  const restarts = repos.listRestarts({ limit: 20, mode });
  const states = repos.stateHistory({ limit: 30, mode });
  const backtests = repos.listBacktests({ limit: 20 });

  const ageMs = heartbeat?.ts_ms ? Date.now() - heartbeat.ts_ms : null;
  const stale = ageMs === null || ageMs > config.worker.heartbeatStaleAfterMs;

  return {
    run: run
      ? {
        runId: run.run_id, status: run.status, strategyId: run.strategy_id, mode: run.mode,
        instanceId: run.instance_id, startedAt: run.started_at, endedAt: run.ended_at,
        startingCapitalEgp: run.starting_capital_egp, notes: run.notes,
      }
      : null,
    strategy: {
      active: config.strategies.active,
      enabled: config.strategies.enabled,
      // Strategy parameters are configuration, not a performance claim. The
      // UI must render them as inputs, never as achievements.
      params: config.strategies.params[config.strategies.active] ?? {},
    },
    heartbeat: heartbeat
      ? {
        ts: heartbeat.ts, ageMs, alive: !stale,
        status: heartbeat.status, agentState: heartbeat.agent_state,
        instanceId: heartbeat.instance_id, pid: heartbeat.pid,
        tickCount: heartbeat.tick_count, decisionCount: heartbeat.decision_count,
        orderCount: heartbeat.order_count, errorCount: heartbeat.error_count,
        lastError: heartbeat.last_error ?? null,
        staleAfterMs: config.worker.heartbeatStaleAfterMs,
      }
      : null,
    counters: {
      decisions: repos.countDecisions(mode, view.scopeRunId),
      orders: repos.countOrders(mode, view.scopeRunId),
      errors: repos.countErrors(mode),
    },
    restarts: restarts.map((r) => lean(r, ['recovery_json'])),
    stateHistory: states.map((s) => lean(s)),
    backtests: backtests.map((b) => lean(b, ['strategy_json', 'metrics_json', 'params_json'])),
  };
}

// ---------------------------------------------------------------------- RISK

/**
 * RISK: the hard limits, whether they have been breached, and what is currently
 * latched.
 *
 * `orderFillReconciliation` is the risk section's most useful number: the order
 * lifecycle is not in the audit hash, so agreement between `filled_quantity` and
 * the append-only fill log is what stands in for it.
 */
export function riskSection(view) {
  const { config, repos, chain, mode } = view;
  const stop = repos.sessionStop(mode);
  const hold = repos.getFlag('TRADING_HOLD', 'false', mode) === 'true';
  const stops = repos.listStops({ limit: 25, mode });
  const reconciliation = repos.auditOrderFills(mode);
  const badOrders = reconciliation.filter((r) => !r.ok);
  const orphaned = repos.orphanOrders(mode);

  return {
    limits: {
      maxLossPerTradeEgp: config.risk.maxLossPerTradeEgp,
      maxLossPerTradePct: config.risk.maxLossPerTradePct,
      dailyLossLimitEgp: config.risk.dailyLossLimitEgp,
      dailyLossLimitPct: config.risk.dailyLossLimitPct,
      maxPortfolioExposureEgp: config.risk.maxPortfolioExposureEgp,
      maxPortfolioExposurePct: config.risk.maxPortfolioExposurePct,
      maxPositionSizeEgp: config.risk.maxPositionSizeEgp,
      maxPositionSizePct: config.risk.maxPositionSizePct,
      maxOpenPositions: config.risk.maxOpenPositions,
      maxOrdersPerDay: config.risk.maxOrdersPerDay,
      maxOrdersPerSymbolPerDay: config.risk.maxOrdersPerSymbolPerDay,
      priceDeviationLimitBps: config.risk.priceDeviationLimitBps,
      maxSpreadBps: config.risk.maxSpreadBps,
      maxDataStalenessMs: config.risk.maxDataStalenessMs,
      minRiskRewardRatio: config.risk.minRiskRewardRatio,
      stopLossRequired: config.risk.stopLossRequired,
      maxStartingCapitalEgp: config.risk.maxStartingCapitalEgp,
    },
    policy: {
      longOnly: true,
      leverage: 'structurally impossible - no margin, no borrowing, no derivatives',
      allowNegativeCash: false,
      allowedOrderTypes: config.execution.allowedOrderTypes ?? ['LIMIT', 'MARKET'],
    },
    emergencyStop: stop
      ? {
        engaged: true, stopId: stop.stop_id, trigger: stop.trigger, severity: stop.severity,
        scope: stop.scope, reason: stop.reason, since: stop.ts, runId: stop.run_id,
      }
      : { engaged: false },
    tradingHold: {
      engaged: hold,
      // Stated as it behaves, not as it was once documented. MANUAL_HOLD has no
      // reduce-only exemption: it blocks every order, so claiming otherwise here
      // would tell an operator watching the dashboard that a stop-loss can still
      // execute while it cannot. A blocked exit latches a STOP_EXIT_BLOCKED
      // emergency stop, so the wording is deliberately blunt.
      effect: hold
        ? 'ALL orders blocked, including risk-reducing exits (no reduce-only exemption); a stop-loss '
          + 'triggered during a hold cannot execute and latches a STOP_EXIT_BLOCKED emergency stop'
        : 'entries allowed',
    },
    stopHistory: stops.map((s) => ({
      stopId: s.stop_id, trigger: s.trigger, severity: s.severity, active: s.active === 1,
      reason: s.reason, ts: s.ts, clearedAt: s.cleared_at, clearedBy: s.cleared_by, runId: s.run_id,
    })),
    orderFillReconciliation: {
      orders: reconciliation.length,
      ok: badOrders.length === 0,
      problems: badOrders.slice(0, 20).map((b) => ({ orderId: b.order_id, problems: b.problems })),
    },
    inFlightOrders: orphaned.map((o) => ({
      orderId: o.order_id, clientOrderId: o.client_order_id, symbol: o.symbol,
      side: o.side, status: o.status, quantity: o.quantity, filledQuantity: o.filled_quantity,
      submittedAt: o.submitted_at,
    })),
    chainIntegrity: AUDIT_STREAMS.map((stream) => {
      const v = chain.verify(stream, mode);
      return { stream, ok: v.ok, records: v.checked, hashedColumns: v.columns, reason: v.reason };
    }),
  };
}

// --------------------------------------------------------------------- AUDIT

/**
 * AUDIT: the four immutable streams, newest first.
 *
 * Refusals are shown as prominently as executions. A risk engine that blocks
 * 400 orders and shows only the 20 that filled has hidden its own behaviour.
 */
export function auditSection(view, { limit = 200 } = {}) {
  const { repos, chain, mode } = view;
  return {
    chains: AUDIT_STREAMS.map((stream) => {
      const v = chain.verify(stream, mode);
      return { stream, ok: v.ok, records: v.checked, hashedColumns: v.columns, reason: v.reason };
    }),
    decisions: repos.listDecisions({ limit, mode }).map((d) => lean(d)),
    riskDecisions: repos.listRiskDecisions({ limit, mode }).map((d) => lean(d)),
    sentinelDecisions: repos.listSentinelDecisions({ limit, mode }).map((d) => lean(d)),
    orders: repos.listOrders({ limit, mode }).map((o) => lean(o)),
    fills: repos.listFills({ limit, mode }).map((f) => lean(f)),
    events: repos.listEvents({ limit, mode }).map((e) => lean(e, ['details_json'])),
  };
}

// --------------------------------------------------------------- entry point

/** Build a view object. The server owns the lifetime of `db`, `chain`, `repos`. */
export function makeView({ config, repos, chain, mode }) {
  const latest = repos.latestRun(mode);
  // BACKTEST runs are isolated experiments and must be read run-scoped; PAPER
  // is one continuous account, so it reads the whole mode. This mirrors
  // `Repos.sessionStop()` exactly - a dashboard that disagreed with the
  // engine about scope would display another run's verdicts.
  const scopeRunId = mode === 'BACKTEST' ? latest?.run_id ?? null : null;

  // A SIDE EFFECT, and the reason it lives here instead of at each call site.
  // `Repos.sessionStop()` decides its scope from `repos.runId`, and it is the
  // single place that does. Every emergency-stop consumer on this server - the
  // risk section below, and `#health()` in server.js - reads it through that
  // method and has no runId of its own to pass. Leaving `repos.runId` null made
  // `sessionStop()` fall through to the UNSCOPED query, because a null runId is
  // indistinguishable from "no scoping requested": the page then showed one
  // run's decisions, orders and fills next to whichever run in the same mode
  // most recently latched a stop. The scope this view had already computed was
  // simply not reaching the one query that needed it. Setting it once here
  // makes the repository agree with `scopeRunId` for every current and future
  // reader, which is the only way to keep the engine and the display from
  // disagreeing about which run they are describing.
  //
  // For PAPER this stores null, which is correct: one continuous account, and
  // any active stop in that mode must be honoured.
  repos.setRun(scopeRunId);

  return { config, repos, chain, mode, scopeRunId };
}

/**
 * The full dashboard payload. `params` is a URLSearchParams; the caller decides
 * what a page size may be, and this function clamps everything again.
 */
export function snapshot(view, params = new URLSearchParams()) {
  return envelope(view, {
    limit: intParam(params, 'limit', 200, { min: 1, max: 1000 }),
    equityLimit: intParam(params, 'equity', 500, { min: 10, max: 5000 }),
  });
}
export const SECTIONS = Object.freeze(['account', 'agent', 'risk', 'audit']);

/** One section on its own, for tests and for small clients. */
export function section(view, name, params = new URLSearchParams()) {
  const limit = intParam(params, 'limit', 200, { min: 1, max: 1000 });
  switch (name) {
    case 'account': return accountSection(view, { equityLimit: intParam(params, 'equity', 500, { min: 10, max: 5000 }) });
    case 'agent': return agentSection(view);
    case 'risk': return riskSection(view);
    case 'audit': return auditSection(view, { limit });
    default: return null;
  }
}

export { AUDIT_STREAMS };
