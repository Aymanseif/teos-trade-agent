/**
 * TEOS Trade Agent - risk/limits.js
 *
 * The immutable risk envelope. This object is snapshotted into every risk
 * decision record, so an audit reader can always see exactly which limits were
 * in force at the moment an order was permitted or refused.
 *
 * Percentages are stored alongside absolute EGP amounts. When both are
 * supplied the TIGHTER limit wins, so editing a percentage upward cannot
 * loosen the effective cap.
 */

import { roundEgp, roundTo } from '../core/money.js';

export class RiskLimits {
  constructor(cfg) {
    const r = cfg.risk;
    const equityRef = cfg.account.startingCapitalEgp;

    this.maxStartingCapitalEgp = r.maxStartingCapitalEgp;

    // --- per-trade loss ------------------------------------------------
    this.maxLossPerTradeEgp = roundEgp(Math.min(r.maxLossPerTradeEgp, equityRef * (r.maxLossPerTradePct / 100)));

    // --- daily loss ----------------------------------------------------
    this.dailyLossLimitEgp = roundEgp(Math.min(r.dailyLossLimitEgp, equityRef * (r.dailyLossLimitPct / 100)));

    // --- exposure ------------------------------------------------------
    this.maxPortfolioExposureEgp = roundEgp(
      Math.min(r.maxPortfolioExposureEgp, equityRef * (r.maxPortfolioExposurePct / 100)),
    );

    // --- position size -------------------------------------------------
    this.maxPositionSizeEgp = roundEgp(
      Math.min(r.maxPositionSizeEgp, equityRef * (r.maxPositionSizePct / 100)),
    );

    this.maxOpenPositions = r.maxOpenPositions;
    this.maxOrdersPerDay = r.maxOrdersPerDay;
    this.maxOrdersPerSymbolPerDay = r.maxOrdersPerSymbolPerDay;

    // --- stops ---------------------------------------------------------
    this.stopLossRequired = r.stopLossRequired === true;
    this.defaultStopDistancePct = r.defaultStopDistancePct;
    this.minStopDistancePct = r.minStopDistancePct;
    this.maxStopDistancePct = r.maxStopDistancePct;
    this.minRiskRewardRatio = r.minRiskRewardRatio;
    this.minOrderNotionalEgp = r.minOrderNotionalEgp;

    // --- data quality --------------------------------------------------
    this.maxDataStalenessMs = r.maxDataStalenessMs;
    this.degradedDataFreshnessMs = r.degradedDataFreshnessMs;
    this.priceDeviationLimitBps = r.priceDeviationLimitBps;
    this.maxSpreadBps = r.maxSpreadBps;
    this.consecutiveFailureHaltCount = r.consecutiveFailureHaltCount;
    this.haltCooldownMs = r.haltCooldownMs;

    // --- hard prohibitions (not configurable) --------------------------
    this.allowLeverage = false;
    this.allowBorrowing = false;
    this.allowShorting = false;
    this.allowDerivatives = false;
    this.allowNegativeCash = false;
    this.emergencyStopEngaged = false;

    Object.freeze(this);
  }

  /** Human/machine readable limits snapshot for the audit record. */
  toJSON() {
    return { ...this };
  }
}

/**
 * Effective loss budget for a single trade.
 *
 *   budget = min( configured per-trade cap,  strategy's requested % of equity )
 *
 * A strategy can always ask for LESS risk than the cap allows. It can never
 * ask for more. The cap is applied after the request.
 */
export function effectiveRiskBudget({ limits, equityEgp, requestedPct = 0 }) {
  const cap = limits.maxLossPerTradeEgp;
  const requested = requestedPct > 0 ? roundEgp(equityEgp * (requestedPct / 100)) : cap;
  return {
    budgetEgp: roundEgp(Math.max(0, Math.min(cap, requested))),
    cappedBy: requested > cap ? 'PER_TRADE_LIMIT' : 'STRATEGY_REQUEST',
    capEgp: cap,
  };
}
