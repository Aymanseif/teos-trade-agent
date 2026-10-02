/**
 * TEOS Trade Agent - vercel/empty.js
 *
 * The truthful "there is nothing to show" projection.
 *
 * This file exists because the obvious implementation is wrong. The obvious
 * implementation is: make an empty repository object, hand it to
 * `dashboard/api.js`, and let the existing sections render. That produces
 * `cashEgp: 500`, `equityEgp: 500` and a green "equity invariant holds" badge.
 *
 * That is not an empty account. That is a fabricated one, and it would be a
 * fabricated one that looks *correct* - the invariant genuinely does hold,
 * because 500 = 500 + 0. `dashboard/api.js:117` falls back to
 * `config.account.startingCapitalEgp` when no balance row is found, which is
 * the right behaviour for a database that was briefly locked and the wrong
 * behaviour for a database that does not exist at all.
 *
 * So the empty path is written out longhand instead of being derived. Every
 * money field is `null`, which means "not known here", and which the existing
 * front end already renders as a blank rather than a number (`app.js:31`
 * returns a non-breaking space for a non-finite value). `ok` is `null` rather
 * than `true`, because an invariant over no data is not satisfied - it is
 * unevaluated.
 *
 * Everything that IS knowable is still reported: the configured capital
 * ceiling, the risk limits, the strategy inputs, the audit streams. Those are
 * policy constants read from configuration, not claims about trading activity,
 * so withholding them would make the page less useful without making it more
 * honest.
 */

import { redact } from '../core/env.js';
import { STREAMS } from '../database/audit-chain.js';
import { DEPLOYMENT, TRUTH } from './identity.js';

const AUDIT_STREAMS = [STREAMS.DECISION, STREAMS.RISK, STREAMS.SENTINENT, STREAMS.ORDER];

/** The exact wording the dashboard shows when it has nothing to render. */
export const NO_DATA_MESSAGE =
  'No persistent worker data available in this Vercel instance.';

/** `null` means "not known in this deployment". Never coerce it to a number. */
const UNKNOWN = null;

/**
 * The marker every empty payload carries. A client can branch on one field
 * instead of guessing from a pile of nulls.
 */
export const DATA_STATE = Object.freeze({
  /** A read-only snapshot database was found and read successfully. */
  SNAPSHOT: 'read-only-snapshot',
  /** Configured, but the database is not present in this environment. */
  NO_DATABASE: 'no-persistent-data',
  /** Present but unreadable, unopenable, or missing the schema. */
  UNREADABLE: 'database-unavailable',
  /** No configuration file could be read either. */
  NO_CONFIG: 'no-configuration',
  /** Configuration or credentials make serving unsafe; see `healthz`. */
  REFUSED: 'refused',
});

// ------------------------------------------------------------------ ACCOUNT

/**
 * Money that was never measured. `startingCapitalEgp` and
 * `capitalCeilingEgp` are excluded from that rule on purpose: they are the
 * configured envelope, they are the same numbers on every machine, and a page
 * that hid them would be hiding the safety limits rather than the results.
 */
export function emptyAccount(config) {
  const risk = config?.risk ?? {};
  const account = config?.account ?? {};
  return {
    startingCapitalEgp: account.startingCapitalEgp ?? UNKNOWN,
    capitalCeilingEgp: risk.maxStartingCapitalEgp ?? UNKNOWN,
    baseAsset: account.baseAsset ?? 'EGP',

    // Nothing below this line was measured, so nothing below it is a number.
    cashEgp: UNKNOWN,
    equityEgp: UNKNOWN,
    exposureEgp: UNKNOWN,
    realizedPnlEgp: UNKNOWN,
    unrealizedPnlEgp: UNKNOWN,
    feesPaidEgp: UNKNOWN,
    slippagePaidEgp: UNKNOWN,
    peakEquityEgp: UNKNOWN,
    maxDrawdownPct: UNKNOWN,
    openPositionCount: UNKNOWN,
    trades: UNKNOWN,

    // `ok: null`, not `ok: true`. An invariant over an empty set is unevaluated.
    equityInvariant: {
      ok: UNKNOWN,
      deltaEgp: UNKNOWN,
      formula: 'equity = cash + exposure',
      note: 'not evaluated: no balance row was read',
    },
    capitalInvariant: {
      ok: UNKNOWN,
      ceilingEgp: risk.maxStartingCapitalEgp ?? UNKNOWN,
      cashNonNegative: UNKNOWN,
      note: 'not evaluated: no balance row was read',
    },

    positions: [],
    market: [],
    equityCurve: [],
  };
}

// -------------------------------------------------------------------- AGENT

/**
 * There is no worker. `heartbeat: null` is not "the worker has not reported
 * yet" - it is "no worker was ever started by this deployment", which is a
 * stronger and more useful statement than a staleness timer could make.
 */
export function emptyAgent(config) {
  return {
    run: null,
    strategy: {
      active: config?.strategies?.active ?? UNKNOWN,
      enabled: config?.strategies?.enabled ?? [],
      params: config?.strategies?.params?.[config?.strategies?.active] ?? {},
    },
    heartbeat: null,
    counters: {
      decisions: UNKNOWN,
      orders: UNKNOWN,
      errors: UNKNOWN,
    },
    restarts: [],
    stateHistory: [],
    backtests: [],
    countersNote:
      'No worker runs in this environment. These counters are unknown here, not zero: '
      + 'they may be non-zero on the machine that does run the worker.',
  };
}

// --------------------------------------------------------------------- RISK

/**
 * The limits are real and are the most useful thing on the page. The stop and
 * hold states are `null` rather than `false`, because `false` is a claim:
 * "no emergency stop is engaged" is not something this deployment can know.
 */
export function emptyRisk(config) {
  const r = config?.risk ?? {};
  return {
    limits: {
      maxLossPerTradeEgp: r.maxLossPerTradeEgp ?? UNKNOWN,
      maxLossPerTradePct: r.maxLossPerTradePct ?? UNKNOWN,
      dailyLossLimitEgp: r.dailyLossLimitEgp ?? UNKNOWN,
      dailyLossLimitPct: r.dailyLossLimitPct ?? UNKNOWN,
      maxPortfolioExposureEgp: r.maxPortfolioExposureEgp ?? UNKNOWN,
      maxPortfolioExposurePct: r.maxPortfolioExposurePct ?? UNKNOWN,
      maxPositionSizeEgp: r.maxPositionSizeEgp ?? UNKNOWN,
      maxPositionSizePct: r.maxPositionSizePct ?? UNKNOWN,
      maxOpenPositions: r.maxOpenPositions ?? UNKNOWN,
      maxOrdersPerDay: r.maxOrdersPerDay ?? UNKNOWN,
      maxOrdersPerSymbolPerDay: r.maxOrdersPerSymbolPerDay ?? UNKNOWN,
      priceDeviationLimitBps: r.priceDeviationLimitBps ?? UNKNOWN,
      maxSpreadBps: r.maxSpreadBps ?? UNKNOWN,
      maxDataStalenessMs: r.maxDataStalenessMs ?? UNKNOWN,
      minRiskRewardRatio: r.minRiskRewardRatio ?? UNKNOWN,
      stopLossRequired: r.stopLossRequired ?? UNKNOWN,
      maxStartingCapitalEgp: r.maxStartingCapitalEgp ?? UNKNOWN,
    },
    policy: {
      longOnly: true,
      leverage: 'structurally impossible - no margin, no borrowing, no derivatives',
      allowNegativeCash: false,
      allowedOrderTypes: config?.execution?.allowedOrderTypes ?? ['LIMIT', 'MARKET'],
    },
    // `engaged: null`, not `false`. See above.
    emergencyStop: {
      engaged: UNKNOWN,
      stateUnknown: true,
      note: 'unknown: emergency-stop state is recorded by the local worker, not by this deployment',
    },
    tradingHold: {
      engaged: UNKNOWN,
      stateUnknown: true,
      effect: 'unknown: hold state is recorded by the local worker, not by this deployment',
    },
    stopHistory: [],
    inFlightOrders: [],
    orderFillReconciliation: {
      orders: UNKNOWN,
      ok: UNKNOWN,
      problems: [],
      note: 'not evaluated: no order or fill rows were read',
    },
    chainIntegrity: emptyChains('no database was read in this environment'),
  };
}

// -------------------------------------------------------------------- AUDIT

/** Per-stream chain verification with no database behind it. */
export function emptyChains(reason) {
  return AUDIT_STREAMS.map((stream) => ({
    stream,
    ok: UNKNOWN,
    records: UNKNOWN,
    hashedColumns: UNKNOWN,
    reason,
  }));
}

export function emptyAudit(reason) {
  return {
    chains: emptyChains(reason),
    decisions: [],
    riskDecisions: [],
    sentinelDecisions: [],
    orders: [],
    fills: [],
    events: [],
  };
}

// ------------------------------------------------------------------ ENVELOPE

/**
 * The full `/api/snapshot` payload when nothing can be read.
 *
 * `redact()` is applied for the same reason the local dashboard applies it:
 * this is the boundary where data leaves the process, and a redaction pass that
 * only exists in the config loader is one refactor away from being bypassed.
 * On the empty path there is nothing to redact, which is exactly the point -
 * it is here so that adding a field later cannot leak it by omission.
 */
export function emptySnapshot({ config, dataState, reason }) {
  return redact({
    generatedAt: new Date().toISOString(),
    mode: DEPLOYMENT.mode,
    dataState,
    noDataMessage: NO_DATA_MESSAGE,
    reason,
    deployment: { ...DEPLOYMENT, ...TRUTH },
    disclaimer: {
      paperOnly: true,
      liveTrading: DEPLOYMENT.liveTrading,
      leverage: DEPLOYMENT.leverage,
      currency: DEPLOYMENT.currency,
    },
    account: emptyAccount(config),
    agent: emptyAgent(config),
    risk: emptyRisk(config),
    audit: emptyAudit(reason),
  });
}

/** One section on its own, for clients that only want the account view. */
export function emptySection(config, name, dataState, reason) {
  switch (name) {
    case 'account': return emptyAccount(config);
    case 'agent': return emptyAgent(config);
    case 'risk': return emptyRisk(config);
    case 'audit': return emptyAudit(reason);
    default: return null;
  }
}

export { AUDIT_STREAMS };