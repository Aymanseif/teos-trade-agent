/**
 * TEOS Trade Agent - core/config.js
 *
 * Loads, validates and freezes the runtime configuration.
 *
 * Validation is deliberately paranoid because these values are the hard
 * safety envelope: if `maxStartingCapitalEgp` is ever edited upward, or a
 * limit is left inconsistent, the process refuses to boot rather than
 * trading outside policy.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { ConfigError } from './errors.js';
import {
  requirePlainObject,
  requireArray,
  requireString,
  requireEnum,
  requireNumber,
} from './assert.js';
import { assertLiveTradingDisabled, assertNoCredentialsPresent, readMode } from './env.js';

export const MODES = ['BACKTEST', 'PAPER'];
export const SYMBOL_RE = /^[A-Z0-9._-]{1,10}\/[A-Z0-9._-]{1,10}$/;

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

function merge(base, override) {
  if (override === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

export function validateConfig(cfg) {
  requirePlainObject(cfg, 'config');
  requireNumber(cfg.configVersion, 'configVersion', { min: 1, integer: true });
  requireEnum(cfg.mode, 'mode', MODES, ConfigError);

  const a = requirePlainObject(cfg.account, 'config.account');
  requireNumber(a.startingCapitalEgp, 'account.startingCapitalEgp', { min: 1, max: 500 });
  requireEnum(a.baseAsset, 'account.baseAsset', ['EGP'], ConfigError);
  if (a.allowNegativeCash !== false) {
    throw new ConfigError('account.allowNegativeCash must be false. Borrowing is prohibited.', { allowNegativeCash: a.allowNegativeCash });
  }

  const r = requirePlainObject(cfg.risk, 'config.risk');
  requireNumber(r.maxStartingCapitalEgp, 'risk.maxStartingCapitalEgp', { min: 1, max: 500 });
  if (r.maxStartingCapitalEgp > 500) {
    throw new ConfigError('risk.maxStartingCapitalEgp may never exceed EGP 500 in this phase.', { value: r.maxStartingCapitalEgp });
  }
  if (a.startingCapitalEgp > r.maxStartingCapitalEgp) {
    throw new ConfigError('account.startingCapitalEgp exceeds risk.maxStartingCapitalEgp.', {
      startingCapitalEgp: a.startingCapitalEgp,
      maxStartingCapitalEgp: r.maxStartingCapitalEgp,
    });
  }

  const pctFields = [
    'maxLossPerTradePct', 'dailyLossLimitPct', 'maxPortfolioExposurePct', 'maxPositionSizePct',
    'defaultStopDistancePct', 'minStopDistancePct', 'maxStopDistancePct',
  ];
  for (const f of pctFields) requireNumber(r[f], `risk.${f}`, { min: 0, max: 100 });

  const egpFields = [
    'maxLossPerTradeEgp', 'dailyLossLimitEgp', 'maxPortfolioExposureEgp', 'maxPositionSizeEgp',
  ];
  for (const f of egpFields) requireNumber(r[f], `risk.${f}`, { min: 0, max: 500 });

  requireNumber(r.maxOpenPositions, 'risk.maxOpenPositions', { min: 0, max: 100, integer: true });
  requireNumber(r.maxOrdersPerDay, 'risk.maxOrdersPerDay', { min: 1, max: 10_000, integer: true });
  requireNumber(r.maxOrdersPerSymbolPerDay, 'risk.maxOrdersPerSymbolPerDay', { min: 1, max: 10_000, integer: true });
  requireNumber(r.priceDeviationLimitBps, 'risk.priceDeviationLimitBps', { min: 1, max: 10_000 });
  requireNumber(r.maxSpreadBps, 'risk.maxSpreadBps', { min: 1, max: 10_000 });
  requireNumber(r.maxDataStalenessMs, 'risk.maxDataStalenessMs', { min: 100, max: 3_600_000 });
  requireNumber(r.degradedDataFreshnessMs, 'risk.degradedDataFreshnessMs', { min: 100, max: 3_600_000 });
  requireNumber(r.minRiskRewardRatio, 'risk.minRiskRewardRatio', { min: 0, max: 100 });
  requireNumber(r.minOrderNotionalEgp, 'risk.minOrderNotionalEgp', { min: 0, max: 500 });
  requireNumber(r.consecutiveFailureHaltCount, 'risk.consecutiveFailureHaltCount', { min: 1, max: 100, integer: true });
  requireNumber(r.haltCooldownMs, 'risk.haltCooldownMs', { min: 0, max: 86_400_000 });
  if (r.stopLossRequired !== true) {
    throw new ConfigError('risk.stopLossRequired must be true: a stop condition is mandatory on every position.', {});
  }
  if (r.minStopDistancePct > r.defaultStopDistancePct || r.defaultStopDistancePct > r.maxStopDistancePct) {
    throw new ConfigError('Stop distance ordering is invalid: require min <= default <= max.', {
      min: r.minStopDistancePct, def: r.defaultStopDistancePct, max: r.maxStopDistancePct,
    });
  }
  if (r.degradedDataFreshnessMs > r.maxDataStalenessMs) {
    throw new ConfigError('risk.degradedDataFreshnessMs must be <= risk.maxDataStalenessMs.', {
      degraded: r.degradedDataFreshnessMs, max: r.maxDataStalenessMs,
    });
  }

  const f = requirePlainObject(cfg.fees, 'config.fees');
  requireNumber(f.makerBps, 'fees.makerBps', { min: 0, max: 1000 });
  requireNumber(f.takerBps, 'fees.takerBps', { min: 0, max: 1000 });
  requireNumber(f.minFeeEgp, 'fees.minFeeEgp', { min: 0, max: 100 });
  if (f.makerBps === 0 && f.takerBps === 0) {
    throw new ConfigError('Fees may not be zero. A zero-fee simulation is not a valid paper environment.', {});
  }

  const s = requirePlainObject(cfg.slippage, 'config.slippage');
  requireNumber(s.baseBps, 'slippage.baseBps', { min: 0, max: 1000 });
  requireNumber(s.impactBpsPerPctOfLimit, 'slippage.impactBpsPerPctOfLimit', { min: 0, max: 1000 });
  requireNumber(s.maxBps, 'slippage.maxBps', { min: 0, max: 10_000 });
  if (s.baseBps === 0 && s.impactBpsPerPctOfLimit === 0) {
    throw new ConfigError('Slippage may not be modelled as zero slippage.', {});
  }

  const m = requirePlainObject(cfg.market, 'config.market');
  requireNumber(m.seed, 'market.seed', { min: 0, integer: true });
  requireNumber(m.tickMs, 'market.tickMs', { min: 50, max: 600_000 });
  requireNumber(m.ticksPerCandle, 'market.ticksPerCandle', { min: 1, max: 10_000, integer: true });
  requireNumber(m.warmupCandles, 'market.warmupCandles', { min: 1, max: 100_000, integer: true });
  requireNumber(m.maxTickJumpBps, 'market.maxTickJumpBps', { min: 1, max: 10_000 });
  if (m.maxTickJumpBps >= r.priceDeviationLimitBps) {
    // Ordinary simulated volatility must stay inside the abnormal-price
    // threshold, otherwise the rule fires constantly and loses its meaning.
    throw new ConfigError(
      'market.maxTickJumpBps must be below risk.priceDeviationLimitBps so normal volatility is not treated as abnormal.',
      { maxTickJumpBps: m.maxTickJumpBps, priceDeviationLimitBps: r.priceDeviationLimitBps },
    );
  }

  const e = requirePlainObject(cfg.execution, 'config.execution');
  requireNumber(e.partialFillProbabilityPct, 'execution.partialFillProbabilityPct', { min: 0, max: 100 });
  requireNumber(e.minFillRatio, 'execution.minFillRatio', { min: 0.01, max: 1 });
  requireNumber(e.maxFillRatio, 'execution.maxFillRatio', { min: 0.01, max: 1 });
  if (e.minFillRatio > e.maxFillRatio) {
    throw new ConfigError('execution.minFillRatio must be <= execution.maxFillRatio.', {});
  }

  const sen = requirePlainObject(cfg.sentinel, 'config.sentinel');
  for (const [k, v] of Object.entries(sen)) {
    if (typeof v === 'boolean') {
      if (v !== true) throw new ConfigError(`sentinel.${k} may not be weakened below "true" in Phase 1.`, { [k]: v });
    } else {
      requireNumber(v, `sentinel.${k}`, { min: 0 });
    }
  }

  // The Sentinel is defence in depth: it may only catch what the risk engine
  // already limits. If its unusual-size thresholds sit BELOW the risk engine's
  // own position cap, then every correctly-sized order the sizer is permitted
  // to produce would be quarantined, and the agent could not trade at all.
  // Requiring the Sentinel threshold to be strictly above the risk cap makes
  // that contradiction impossible to reintroduce by editing the JSON.
  if (sen.unusualSizeReviewPctOfEquity <= r.maxPositionSizePct) {
    throw new ConfigError(
      'sentinel.unusualSizeReviewPctOfEquity must be greater than risk.maxPositionSizePct, otherwise '
      + 'the Sentinel would quarantine every order the risk engine legitimately permits.',
      { sentinelPct: sen.unusualSizeReviewPctOfEquity, riskMaxPositionSizePct: r.maxPositionSizePct },
    );
  }
  if (sen.unusualSizeReviewEgp <= r.maxPositionSizeEgp) {
    throw new ConfigError(
      'sentinel.unusualSizeReviewEgp must be greater than risk.maxPositionSizeEgp, otherwise the '
      + 'Sentinel would quarantine every order the risk engine legitimately permits.',
      { sentinelEgp: sen.unusualSizeReviewEgp, riskMaxPositionSizeEgp: r.maxPositionSizeEgp },
    );
  }

  const w = requirePlainObject(cfg.worker, 'config.worker');
  requireNumber(w.tickMs, 'worker.tickMs', { min: 50, max: 600_000 });
  requireNumber(w.heartbeatMs, 'worker.heartbeatMs', { min: 200, max: 3_600_000 });
  requireNumber(w.heartbeatStaleAfterMs, 'worker.heartbeatStaleAfterMs', { min: 1000, max: 86_400_000 });
  requireNumber(w.maxDecisionsPerTick, 'worker.maxDecisionsPerTick', { min: 1, max: 100, integer: true });

  const d = requirePlainObject(cfg.dashboard, 'config.dashboard');
  requireString(d.host, 'dashboard.host');
  requireNumber(d.port, 'dashboard.port', { min: 1, max: 65_535, integer: true });
  if (d.allowNonLoopbackBind === true) {
    throw new ConfigError('dashboard.allowNonLoopbackBind must be false in Phase 1.', {});
  }

  const st = requirePlainObject(cfg.strategies, 'config.strategies');
  requireArray(st.enabled, 'strategies.enabled', { minLength: 1 });
  requireString(st.active, 'strategies.active');
  if (!st.enabled.includes(st.active)) {
    throw new ConfigError('strategies.active must be present in strategies.enabled.', {
      active: st.active, enabled: st.enabled,
    });
  }
  requirePlainObject(st.params, 'strategies.params');
  for (const name of st.enabled) {
    if (!st.params[name]) throw new ConfigError(`Missing parameters for enabled strategy "${name}".`, { name });
    requirePlainObject(st.params[name], `strategies.params.${name}`);
  }

  const inst = requireArray(cfg.instruments, 'instruments', { minLength: 1 });
  const seen = new Set();
  for (const i of inst) {
    requirePlainObject(i, 'instrument');
    requireString(i.symbol, 'instrument.symbol');
    if (!SYMBOL_RE.test(i.symbol)) {
      throw new ConfigError(`instrument.symbol must look like BASE/QUOTE (got "${i.symbol}").`, { symbol: i.symbol });
    }
    if (seen.has(i.symbol)) throw new ConfigError(`Duplicate instrument "${i.symbol}".`, { symbol: i.symbol });
    seen.add(i.symbol);
    requireEnum(i.kind, `instrument[${i.symbol}].kind`, ['spot', 'index']);
    requireNumber(i.startPrice, `instrument[${i.symbol}].startPrice`, { min: 1e-6 });
    requireNumber(i.annualVolPct, `instrument[${i.symbol}].annualVolPct`, { min: 0.01, max: 500 });
    requireNumber(i.tickSize, `instrument[${i.symbol}].tickSize`, { min: 1e-8 });
    requireNumber(i.qtyStep, `instrument[${i.symbol}].qtyStep`, { min: 1e-8 });
    requireNumber(i.minQty, `instrument[${i.symbol}].minQty`, { min: 1e-8 });
    requireNumber(i.spreadBpsMin, `instrument[${i.symbol}].spreadBpsMin`, { min: 0 });
    requireNumber(i.spreadBpsMax, `instrument[${i.symbol}].spreadBpsMax`, { min: 0 });
    if (i.spreadBpsMin > i.spreadBpsMax) {
      throw new ConfigError(`instrument[${i.symbol}] spreadBpsMin exceeds spreadBpsMax.`, i.symbol);
    }
  }
  return cfg;
}

export function loadConfig({ path = null, overrides = {}, env = process.env } = {}) {
  assertNoCredentialsPresent(env);
  assertLiveTradingDisabled(env);

  const cfgPath = resolve(path ?? env.TEOS_CONFIG ?? './config/default.json');
  if (!existsSync(cfgPath)) throw new ConfigError(`Config file not found: ${cfgPath}`, { path: cfgPath });

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${err.message}`, { path: cfgPath });
  }

  const envMode = readMode(env);
  const merged = merge(merge(parsed, { mode: envMode }), overrides);
  // The EFFECTIVE mode, after overrides. It - not the env mode - decides which
  // database file this process opens. Deriving the path from the env mode while
  // the overrides said otherwise made a backtest write to the PAPER database.
  const mode = merged.mode;

  const dataDir = env.TEOS_DATA_DIR ?? './data';
  merged.paths = {
    configFile: cfgPath,
    dataDir: isAbsolute(dataDir) ? dataDir : resolve(dataDir),
    logDir: isAbsolute(env.TEOS_LOG_DIR ?? './logs') ? env.TEOS_LOG_DIR : resolve(env.TEOS_LOG_DIR ?? './logs'),
  };
  // Mode isolation: a BACKTEST process can never touch the PAPER database.
  merged.paths.dbFile = merged.paths.dataDir
    ? resolve(merged.paths.dataDir, `teos-${mode.toLowerCase()}.db`)
    : ':memory:';

  validateConfig(merged);
  return deepFreeze(merged);
}

/** Symbol metadata lookup, built once from validated config. */
export function instrumentMap(cfg) {
  const m = new Map();
  for (const i of cfg.instruments) m.set(i.symbol, Object.freeze({ ...i }));
  return m;
}
