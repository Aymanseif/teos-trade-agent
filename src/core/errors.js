/**
 * TEOS Trade Agent - core/errors.js
 * Typed errors. The agent state machine treats an UNDEFINED state as a
 * stop-trading condition, so every unexpected throw must be classifiable.
 */

export class TeosError extends Error {
  constructor(message, code = 'TEOS_ERROR', details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.isTeos = true;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Configuration is invalid or a hard invariant of the config file is violated. */
export class ConfigError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'CONFIG_ERROR', details);
  }
}

/** Mode / live-trading guards. */
export class ModeNotAllowedError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'MODE_NOT_ALLOWED', details);
  }
}

export class LiveTradingDisabledError extends TeosError {
  constructor(detail = 'Live trading is not implemented in Phase 1.') {
    super(
      detail,
      'LIVE_TRADING_DISABLED',
      { phase: 1, mode: 'PAPER', note: 'No live execution path exists in this build.' },
    );
  }
}

export class SecurityError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'SECURITY_ERROR', details);
  }
}

/** Broker / exchange / market-data connectivity. */
export class ConnectionError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'CONNECTION_ERROR', details);
  }
}

export class MarketDataStaleError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'MARKET_DATA_STALE', details);
  }
}

export class AbnormalPriceError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'ABNORMAL_PRICE', details);
  }
}

/** Order construction / validation. */
export class ValidationError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

export class InvalidOrderError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'INVALID_ORDER', details);
  }
}

export class InsufficientBalanceError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'INSUFFICIENT_BALANCE', details);
  }
}

export class PositionSizeError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'POSITION_SIZE_EXCEEDED', details);
  }
}

export class DailyLossLimitError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'DAILY_LOSS_LIMIT', details);
  }
}

/** Persistence. */
export class DatabaseError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'DATABASE_ERROR', details);
  }
}

/** Emergency stop latch engaged. */
export class EmergencyStopError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'EMERGENCY_STOP', details);
  }
}

/** Worker lifecycle. */
export class WorkerError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'WORKER_ERROR', details);
  }
}

export class LockHeldError extends TeosError {
  constructor(message, details = {}) {
    super(message, 'LOCK_HELD', details);
  }
}

export function toErrorPayload(err) {
  if (err && err.isTeos) return err.toJSON();
  return {
    name: err?.name ?? 'Error',
    code: err?.code ?? 'UNKNOWN',
    message: err?.message ?? String(err),
    details: err?.details ?? {},
  };
}
