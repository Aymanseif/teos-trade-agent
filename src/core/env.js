/**
 * TEOS Trade Agent - core/env.js  (SECURITY BOUNDARY)
 *
 * Phase 1 has NO credentials. This module exists to make that a hard,
 * testable invariant rather than a comment:
 *
 *  1. Secrets are only ever read from process environment variables.
 *  2. Any populated credential variable in Phase 1 is a CONFIG ERROR, because
 *     an unused credential is a latent leak.
 *  3. `describeEnv()` returns only a redacted allow-list. It is the ONLY thing
 *     permitted to reach the dashboard or a log line.
 *  4. Read-only market-data credentials and trading credentials live in
 *     separate namespaces and are never merged into one object.
 *  5. The trading-credentials accessor throws unconditionally in Phase 1.
 */

import { ConfigError, LiveTradingDisabledError, SecurityError } from './errors.js';

const CREDENTIAL_VARS = [
  'TEOS_MARKET_DATA_API_KEY',
  'TEOS_MARKET_DATA_API_SECRET',
  'TEOS_TRADING_API_KEY',
  'TEOS_TRADING_API_SECRET',
  'TEOS_TRADING_API_PASSPHRASE',
];

/** Variables safe to surface in a status/health payload. */
const SAFE_VARS = [
  'TEOS_MODE',
  'TEOS_DATA_DIR',
  'TEOS_LOG_DIR',
  'TEOS_CONFIG',
  'TEOS_DASHBOARD_HOST',
  'TEOS_DASHBOARD_PORT',
  'TEOS_LOG_LEVEL',
  'TEOS_LIVE_TRADING_ENABLED',
];

/** Values that are never allowed in Phase 1. */
const FORBIDDEN_NON_EMPTY = [...CREDENTIAL_VARS, 'TEOS_DASHBOARD_TOKEN'];

/** Secrets that look like secrets if they ever leak into a log. */
const REDACTION_PATTERNS = [
  /([A-Za-z0-9_]*(?:API_KEY|API_SECRET|PASSPHRASE|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*("?)([^\s",}]+)\2/gi,
  /\b(sk|pk|api|key|token|secret)[_-][A-Za-z0-9]{12,}\b/gi,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

export function redact(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    let out = input;
    for (const re of REDACTION_PATTERNS) {
      if (re.global) re.lastIndex = 0;
      out = out.replace(re, (m) => {
        if (re.source.startsWith('([A-Za-z0-9_]*')) return `${m.split(/[:=]/)[0]}=***REDACTED***`;
        return '***REDACTED***';
      });
    }
    return out;
  }
  if (Array.isArray(input)) return input.map(redact);
  if (input instanceof Error) return { name: input.name, message: redact(input.message) };
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (isSecretKey(k)) out[k] = '***REDACTED***';
      else out[k] = redact(v);
    }
    return out;
  }
  return input;
}

export function isSecretKey(key) {
  return /(KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD|CREDENTIAL)/i.test(String(key));
}

/**
 * Hard gate: refuse to boot if a credential is present. Run by config loader
 * and by every CLI entrypoint.
 */
export function assertNoCredentialsPresent(env = process.env) {
  const present = FORBIDDEN_NON_EMPTY.filter((k) => {
    const v = env[k];
    return typeof v === 'string' && v.trim() !== '';
  });
  if (present.length > 0) {
    throw new SecurityError(
      'Phase 1 must run without credentials. The following credential variables are set: '
        + present.join(', ')
        + '. Unset them. Phase 1 never contacts an exchange.',
      { present },
    );
  }
  return true;
}

export function readMode(env = process.env) {
  const mode = (env.TEOS_MODE ?? 'PAPER').toUpperCase();
  if (mode === 'LIVE') {
    throw new LiveTradingDisabledError(
      'TEOS_MODE=LIVE was requested. Live trading is not implemented and not permitted in Phase 1.',
    );
  }
  if (!['PAPER', 'BACKTEST'].includes(mode)) {
    throw new ConfigError(`Unknown TEOS_MODE "${mode}". Expected PAPER or BACKTEST.`, { mode });
  }
  return mode;
}

/**
 * LIVE trading gate. Throws in Phase 1 no matter what is configured, so a
 * config edit cannot switch on real-money execution.
 */
export function assertLiveTradingDisabled(env = process.env) {
  const flag = String(env.TEOS_LIVE_TRADING_ENABLED ?? 'false').toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') {
    throw new LiveTradingDisabledError(
      'TEOS_LIVE_TRADING_ENABLED is set, but this build contains no live execution path.',
    );
  }
  return true;
}

/** Read-only market-data credentials. Phase 1: always empty. */
export function loadMarketDataCredentials(env = process.env) {
  const key = env.TEOS_MARKET_DATA_API_KEY ?? '';
  const secret = env.TEOS_MARKET_DATA_API_SECRET ?? '';
  if (key.trim() || secret.trim()) {
    throw new SecurityError(
      'Phase 1 uses a local deterministic market simulator and must not receive '
        + 'market-data credentials. Unset TEOS_MARKET_DATA_API_KEY / TEOS_MARKET_DATA_API_SECRET.',
    );
  }
  return { provider: 'local-simulator', readOnly: true, apiKey: null, apiSecret: null };
}

/** Trading credentials. Phase 1: physically unavailable. */
export function loadTradingCredentials() {
  throw new LiveTradingDisabledError(
    'Trading credentials are not loadable in Phase 1. There is no live execution adapter.',
  );
}

export function describeEnv(env = process.env) {
  const out = {};
  for (const key of SAFE_VARS) {
    out[key] = env[key] === undefined ? null : redact(String(env[key]));
  }
  for (const key of CREDENTIAL_VARS) out[key] = env[key] ? 'SET(redacted)' : null;
  return out;
}
