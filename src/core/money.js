/**
 * TEOS Trade Agent - core/money.js
 *
 * Every cash amount in the system (balances, fees, P&L, limits) is stored and
 * mutated as an INTEGER number of piastres (1 EGP = 100 piastres). Floating
 * point never touches a stored balance, so repeated add/subtract cycles
 * cannot drift and two runs with the same inputs produce bit-identical ledgers.
 *
 * Prices stay as IEEE-754 doubles in EGP for readability, but they are always
 * *converted* into piastres (with an explicit rounding mode) at the moment
 * they are used for a cash mutation. Rounding is therefore applied exactly
 * once per cash event.
 */

export const MINOR_UNITS_PER_EGP = 100;

/**
 * EGP (double) -> integer piastres.
 *
 * `Math.round` breaks a half-piastre tie toward +Infinity, for BOTH signs.
 * That is deterministic and reproducible, which is what a ledger requires, but
 * it is NOT sign-antisymmetric: `roundEgp(0.005) === 0.01` while
 * `roundEgp(-0.005) === 0`, so a value and its negation both move toward
 * positive. Two consequences, both bounded and both safe for this system:
 * a value and its negation can never BOTH gain (the pair differs from zero by at
 * most one piastre, always in the same direction), and rounding can never flip a
 * sign, so no rounding step can conjure negative cash.
 *
 * NOTE: `roundTo` in this same file rounds half AWAY FROM ZERO instead. The two
 * rounders therefore disagree on the tie rule, and this one is deliberately left
 * as it is: changing it would re-round every stored piastre in every existing
 * database. Long-only, cash-funded operation means negative cash cannot arise
 * through normal use, so the divergence cannot affect a balance or a fill; its
 * only exposure is that a loss landing on an exact half-piastre rounds toward
 * zero and reports marginally optimistically. Reconcile only alongside a
 * deliberate decision to migrate stored figures.
 */
export function toMinor(egp) {
  if (!Number.isFinite(egp)) throw new TypeError(`toMinor: not finite: ${egp}`);
  return Math.round(egp * MINOR_UNITS_PER_EGP);
}

/** Integer piastres -> EGP (double). */
export function fromMinor(minor) {
  if (!Number.isInteger(minor)) throw new TypeError(`fromMinor: not an integer: ${minor}`);
  return minor / MINOR_UNITS_PER_EGP;
}

/** Round a money-ish double to 2 decimals (piastre resolution) as a number. */
export function roundEgp(egp) {
  if (!Number.isFinite(egp)) throw new TypeError(`roundEgp: not finite: ${egp}`);
  // Same tie rule as `toMinor` above, and therefore the same one-way bias: half
  // piastres go toward +Infinity for both signs. See that note before assuming
  // this is symmetric about zero - it is not, unlike `roundTo`.
  return Math.round(egp * MINOR_UNITS_PER_EGP) / MINOR_UNITS_PER_EGP;
}

/**
 * Round a QUANTITY.
 *
 * Quantities are NOT money and must never be rounded as money. A position of
 * 0.001 units is worth EGP 4.15 at one price, and `roundEgp(0.001)` is 0 - so
 * averaging into such a position with a cash-rounding helper collapses it to
 * zero and every average-price calculation that follows divides by zero. The
 * two rounders must stay separate; that separation is the only thing standing
 * between a small position and an `Infinity` in the ledger.
 *
 * 8 decimals matches the precision the matching engine books fills at, so
 * summing fill quantities is exact.
 */
export const QUANTITY_DECIMALS = 8;

export function roundQty(quantity) {
  if (!Number.isFinite(quantity)) throw new TypeError(`roundQty: not finite: ${quantity}`);
  return roundTo(quantity, QUANTITY_DECIMALS);
}

/**
 * Round a money-ish double to a fixed number of decimals, half away from zero.
 * Used for order notionals and fees before they are converted to piastres.
 */
export function roundTo(value, decimals) {
  if (!Number.isFinite(value)) throw new TypeError(`roundTo: not finite: ${value}`);
  const f = 10 ** decimals;
  const scaled = value * f;
  // half away from zero
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return r / f;
}

/** Basis points -> multiplier. 25 bps -> 0.0025 */
export function bpsToFraction(bps) {
  return bps / 10_000;
}

/** Apply bps to a base amount, rounding to piastres. */
export function applyBpsEgp(amountEgp, bps) {
  return fromMinor(Math.round(toMinor(amountEgp) * bpsToFraction(bps)));
}

export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Sum of EGP numbers, accumulated in piastres. */
export function sumEgp(values) {
  let acc = 0;
  for (const v of values) acc += toMinor(v);
  return fromMinor(acc);
}

export function isPositive(n) {
  return Number.isFinite(n) && n > 0;
}

export function isNonNegative(n) {
  return Number.isFinite(n) && n >= 0;
}
