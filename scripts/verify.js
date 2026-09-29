#!/usr/bin/env node
/**
 * TEOS Trade Agent - scripts/verify.js
 *
 * Independent integrity verification over a mode's database.
 *
 * The point of this file is that it does NOT trust the running agent. Every
 * check re-derives a quantity from the raw rows and compares it to the number
 * the system reported. An agent that has drifted out of agreement with its own
 * audit trail is exactly the failure this is written to catch, so a check that
 * asked the agent "are you consistent with yourself?" would be worthless.
 *
 * Checks:
 *   1. equity invariant        equity == cash + exposure, on every balance row
 *   2. cash reconstruction     starting capital + every fill == ledger cash
 *   3. order/fill agreement    filled_quantity == sum(fills), status agreement
 *   4. position reconciliation fills net to the open position quantity
 *   5. no impossible state     negative quantity/cash, duplicate open position
 *   6. orphan fills            a fill whose order does not exist
 *   7. audit chains            all four hash chains re-hash correctly
 *   8. duplicate submissions   one client_order_id per decision, ever
 *   9. capital invariant       equity never exceeds the configured maximum
 *  10. no silent errors        ERROR/FATAL events are reported, not hidden
 */

import { openDatabase } from '../src/database/db.js';
import { migrate } from '../src/database/migrate.js';
import { AuditChain } from '../src/database/audit-chain.js';
import { Repos } from '../src/database/repositories/index.js';
import { loadConfig } from '../src/core/config.js';
import { systemClock } from '../src/core/clock.js';
import { toMinor, fromMinor } from '../src/core/money.js';

const EPS = 0.011; // one piastre

function check(results, name, ok, detail) {
  results.push({ name, ok, detail });
  return ok;
}

/**
 * Re-derive cash from the fill log. This is the strongest single check in the
 * file: cash can only move through a fill, so if the ledger and the fill history
 * agree to the piastre, no cash was created or destroyed anywhere in between.
 */
function reconstructCash(rows) {
  let minor = 0;
  for (const f of rows) {
    const notional = Math.round(f.notional_egp * 100);
    const fee = Math.round(f.fee_egp * 100);
    minor += f.side === 'BUY' ? -(notional + fee) : (notional - fee);
  }
  return minor;
}

export async function runVerification({ mode = 'PAPER', configPath = null } = {}) {
  const config = loadConfig({ path: configPath, overrides: { mode } });
  const db = openDatabase(config.paths.dbFile);
  migrate(db, systemClock);
  const chain = new AuditChain(db);
  const repos = new Repos(db, chain, { mode, instanceId: 'verify' });
  const results = [];

  const balances = db.all('SELECT * FROM balances WHERE mode = ? ORDER BY ts_ms ASC, id ASC', mode);
  const fills = db.all('SELECT * FROM fills WHERE mode = ? ORDER BY ts_ms ASC, rowid ASC', mode);
  const orders = db.all('SELECT * FROM orders WHERE mode = ? ORDER BY submitted_ms ASC, rowid ASC', mode);
  const positions = db.all('SELECT * FROM positions WHERE mode = ? ORDER BY opened_ms ASC, rowid ASC', mode);

  // ---- ledger scope --------------------------------------------------------
  //
  // Two kinds of check live in this file, and only one of them needs scoping.
  //
  // ROW-LOCAL checks judge each row against itself: equity == cash + exposure on
  // a single balance, an order against its own fills, a fill against its own
  // order, a hash chain against its own links. Every row of the mode is
  // independently meaningful, so all of them stay mode-wide and get STRICTLY
  // more coverage from it. Nothing below is narrowed.
  //
  // LEDGER checks instead assume ONE continuous account with ONE opening
  // balance: "starting capital + every fill == ledger cash", and "fills net to
  // the open position". That is true of PAPER, which is a single long-lived
  // account, and false of BACKTEST, where every run is an independent experiment
  // that starts from the configured capital and books its own fills - and
  // `saveBacktest` APPENDS to the same tables, so the mode accumulates one such
  // ledger per run.
  //
  // Applied mode-wide, six backtests that each end holding 0.1 TEOS give net
  // fills of 0.6 against an open position of 0.1, and the checker reports a
  // reconciliation failure and a cash failure for ledgers that are perfectly
  // correct. It is not a near-miss: the second backtest ever run makes
  // `verify --mode BACKTEST` exit non-zero, permanently, with no way to pass.
  // A verifier that cries wolf is worse than no verifier, because it teaches the
  // operator to read FAIL as noise - the same argument that motivated the audit
  // chain's phantom-break fix.
  //
  // So the ledger is scoped exactly the way the dashboard scopes its view: to the
  // latest run for BACKTEST, to the whole mode for PAPER.
  const scopeRunId = mode === 'BACKTEST' ? (repos.latestRun(mode)?.run_id ?? null) : null;
  const ledger = (table, order) => (scopeRunId
    ? db.all(`SELECT * FROM ${table} WHERE mode = ? AND run_id = ? ORDER BY ${order}`, mode, scopeRunId)
    : db.all(`SELECT * FROM ${table} WHERE mode = ? ORDER BY ${order}`, mode));
  const ledgerBalances = ledger('balances', 'ts_ms ASC, id ASC');
  const ledgerFills = ledger('fills', 'ts_ms ASC, rowid ASC');
  const ledgerPositions = ledger('positions', 'opened_ms ASC, rowid ASC');
  const scopeNote = scopeRunId
    ? `scoped to the latest of ${db.get('SELECT COUNT(*) AS c FROM runs WHERE mode = ?', mode).c} `
      + `BACKTEST run(s), ${scopeRunId}; `
    : 'scoped to the whole PAPER account; ';

  // ---- 1. equity invariant -------------------------------------------------
  let worstEquity = 0;
  let worstEquityAt = null;
  for (const b of balances) {
    const expected = b.cash_egp + b.exposure_egp;
    const delta = Math.abs(b.equity_egp - expected);
    if (delta > worstEquity) { worstEquity = delta; worstEquityAt = b.ts; }
  }
  check(results, 'equity invariant (equity = cash + exposure)',
    balances.length === 0 || worstEquity < EPS,
    balances.length === 0
      ? 'no balance rows yet'
      : `max |equity - (cash + exposure)| = ${worstEquity.toFixed(6)} EGP over ${balances.length} rows${worstEquityAt ? ` (worst at ${worstEquityAt})` : ''}`);

  // ---- 2. cash reconstruction ---------------------------------------------
  const lastBalance = ledgerBalances.length ? ledgerBalances[ledgerBalances.length - 1] : null;
  if (lastBalance) {
    const startMinor = Math.round(config.account.startingCapitalEgp * 100);
    const expected = fromMinor(startMinor + reconstructCash(ledgerFills));
    const delta = Math.abs(lastBalance.cash_egp - expected);
    check(results, 'cash reconstructs exactly from the fill log',
      delta < EPS,
      `fills imply EGP ${expected.toFixed(2)}, ledger says EGP ${lastBalance.cash_egp.toFixed(2)} `
      + `(delta ${delta.toFixed(4)} EGP over ${ledgerFills.length} fills, ${scopeNote}one opening balance)`);
  } else {
    check(results, 'cash reconstructs exactly from the fill log', true, 'no balance rows yet');
  }

  // ---- 3. order / fill agreement ------------------------------------------
  const fillsByOrder = new Map();
  for (const f of fills) {
    if (!fillsByOrder.has(f.order_id)) fillsByOrder.set(f.order_id, []);
    fillsByOrder.get(f.order_id).push(f);
  }
  const orderProblems = [];
  for (const o of orders) {
    const fs = fillsByOrder.get(o.order_id) ?? [];
    const summed = fs.reduce((a, f) => a + f.quantity, 0);
    if (Math.abs(summed - o.filled_quantity) > 1e-8) {
      orderProblems.push(`${o.order_id}: filled_quantity ${o.filled_quantity} != sum(fills) ${summed}`);
    }
    if (o.status === 'REJECTED' && fs.length > 0) {
      orderProblems.push(`${o.order_id}: REJECTED but has ${fs.length} fill(s)`);
    }
    if (o.status === 'FILLED' && Math.abs(summed - o.quantity) > 1e-8) {
      orderProblems.push(`${o.order_id}: FILLED but only ${summed}/${o.quantity} filled`);
    }
    if (o.filled_quantity > o.quantity + 1e-8) {
      orderProblems.push(`${o.order_id}: over-filled ${o.filled_quantity} > ${o.quantity}`);
    }
  }
  check(results, 'order and fill records agree', orderProblems.length === 0,
    orderProblems.length === 0
      ? `${orders.length} orders consistent`
      : orderProblems.slice(0, 5).join('; '));

  // ---- 4. position reconciliation -----------------------------------------
  //
  // Fills net to the position they belong to. A quantity rounded with the wrong
  // helper (cash precision applied to units) shows up here first: the position
  // stops matching its own fill history and the difference appears as cash that
  // was never earned.
  const netBySymbol = new Map();
  for (const f of ledgerFills) {
    const signed = f.side === 'BUY' ? f.quantity : -f.quantity;
    netBySymbol.set(f.symbol, (netBySymbol.get(f.symbol) ?? 0) + signed);
  }
  const openBySymbol = new Map();
  for (const p of ledgerPositions) {
    if (p.status !== 'OPEN') continue;
    if (openBySymbol.has(p.symbol)) {
      openBySymbol.set(p.symbol, NaN); // flagged below as a duplicate
    } else {
      openBySymbol.set(p.symbol, p.quantity);
    }
  }
  const positionProblems = [];
  for (const p of ledgerPositions) {
    if (p.status !== 'OPEN') continue;
    if (p.quantity < -1e-9) positionProblems.push(`${p.symbol}: negative open quantity ${p.quantity}`);
    const net = netBySymbol.get(p.symbol);
    if (Number.isFinite(net) && Math.abs(net - p.quantity) > 1e-6) {
      positionProblems.push(`${p.symbol}: open quantity ${p.quantity} != net fills ${net.toFixed(8)}`);
    }
  }
  for (const [sym] of openBySymbol) {
    if (Number.isNaN(openBySymbol.get(sym))) positionProblems.push(`${sym}: more than one OPEN position row`);
  }
  check(results, 'positions reconcile with their fills', positionProblems.length === 0,
    positionProblems.length === 0
      ? `${ledgerPositions.filter((p) => p.status === 'OPEN').length} open position(s) match their fill `
        + `history (${scopeNote}${ledgerFills.length} fill(s) netted)`
      : positionProblems.slice(0, 5).join('; '));

  // ---- 5. orphan fills -----------------------------------------------------
  const orderIds = new Set(orders.map((o) => o.order_id));
  const orphans = fills.filter((f) => !orderIds.has(f.order_id));
  check(results, 'no orphan fills', orphans.length === 0,
    orphans.length === 0 ? 'every fill belongs to a recorded order' : `${orphans.length} orphan fill(s)`);

  // ---- 6. audit chains -----------------------------------------------------
  for (const stream of ['decision', 'risk', 'sentinel', 'order']) {
    const v = chain.verify(stream, mode);
    check(results, `audit chain intact: ${stream}`, v.ok,
      v.ok ? `${v.checked} records, ${v.columns} hashed columns` : `BROKEN at record ${v.checked}: ${v.reason}`);
  }

  // ---- 7. duplicate order prevention --------------------------------------
  const byClientId = new Map();
  for (const o of orders) {
    if (!byClientId.has(o.client_order_id)) byClientId.set(o.client_order_id, []);
    byClientId.get(o.client_order_id).push(o.order_id);
  }
  const dupes = [...byClientId.entries()].filter(([, ids]) => ids.length > 1);
  check(results, 'no duplicate client_order_id was ever submitted', dupes.length === 0,
    dupes.length === 0
      ? `${byClientId.size} distinct client_order_id(s), all unique`
      : `${dupes.length} duplicated: ${dupes.slice(0, 3).map(([k, v]) => `${k} x${v.length}`).join(', ')}`);

  // ---- 8. capital invariant -----------------------------------------------
  //
  // The hard Phase 1 constraint. Cash may never go negative (no borrowing) and
  // equity may never exceed the configured maximum (no leverage, no minting).
  let negativeCash = 0;
  let overCapital = 0;
  let worstCash = 0;
  for (const b of balances) {
    if (b.cash_egp < -EPS) { negativeCash += 1; worstCash = Math.min(worstCash, b.cash_egp); }
    if (b.equity_egp > config.risk.maxStartingCapitalEgp + EPS) overCapital += 1;
  }
  check(results, 'cash never negative (no borrowing)', negativeCash === 0,
    negativeCash === 0 ? 'no negative cash balance' : `${negativeCash} row(s) below zero, worst ${worstCash.toFixed(2)}`);
  check(results, `equity never exceeds EGP ${config.risk.maxStartingCapitalEgp} (no leverage)`,
    overCapital === 0,
    overCapital === 0 ? 'equity stayed within the capital ceiling' : `${overCapital} row(s) above the ceiling`);

  // ---- 9. errors are surfaced ---------------------------------------------
  const bad = db.all(
    "SELECT level, category, message FROM system_events WHERE mode = ? AND level IN ('ERROR','FATAL') ORDER BY ts_ms ASC LIMIT 20",
    mode,
  );
  check(results, 'no ERROR or FATAL events recorded', bad.length === 0,
    bad.length === 0
      ? 'clean'
      : bad.map((b) => `[${b.level}] ${b.category}: ${b.message}`).join(' | ').slice(0, 500));

  // ---- 10. every order carries a full audit trail ------------------------
  const untrailed = orders.filter((o) => !o.risk_decision_id || !o.sentinel_decision_id || !o.decision_id);
  check(results, 'every order has decision, risk and Sentinel records', untrailed.length === 0,
    untrailed.length === 0
      ? `${orders.length} order(s) fully linked`
      : `${untrailed.length} order(s) missing a link`);

  const ok = results.every((r) => r.ok);
  db.close();

  const report = [
    '='.repeat(78),
    `TEOS TRADE AGENT - VERIFICATION (${mode})`,
    '='.repeat(78),
    `database: ${config.paths.dbFile}`,
    `balances ${balances.length}  fills ${fills.length}  orders ${orders.length}  positions ${positions.length}`,
    '',
    ...results.map((r) => `  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}\n         ${r.detail}`),
    '',
    ok ? 'ALL CHECKS PASSED' : `${results.filter((r) => !r.ok).length} CHECK(S) FAILED`,
    '='.repeat(78),
  ].join('\n');

  return { ok, mode, results, report, counts: { balances: balances.length, fills: fills.length, orders: orders.length, positions: positions.length } };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/verify.js');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'PAPER';
  const json = args.includes('--json');
  runVerification({ mode })
    .then((r) => {
      console.log(json ? JSON.stringify(r, null, 2) : r.report);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`verification failed to run: ${e.message}`);
      if (process.env.TEOS_DEBUG === '1') console.error(e.stack);
      process.exit(1);
    });
}
