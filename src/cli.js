#!/usr/bin/env node
/**
 * TEOS Trade Agent - cli.js
 *
 * The single entry point. Every command is safe to run: none of them can place a
 * real order, because no live execution adapter exists in this codebase at all.
 *
 * There is deliberately no "live" command. Adding one would require writing one;
 * its absence is the guarantee, not an oversight.
 *
 * Usage:  node src/cli.js <command> [options]
 *         node src/cli.js help
 */

import { openDatabase } from './database/db.js';
import { migrate } from './database/migrate.js';
import { AuditChain } from './database/audit-chain.js';
import { Repos } from './database/repositories/index.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { systemClock } from './core/clock.js';
import { roundEgp } from './core/money.js';
import { newId } from './core/ids.js';

const BANNER = [
  'TEOS TRADE AGENT - PHASE 1',
  'Paper simulation only. No real money, no real accounts, no live execution.',
  'Long-only, cash-funded, no leverage, no borrowing, no derivatives.',
].join('\n');

/** Open the database read-only for inspection commands, migrating if needed. */
function openForRead(config, mode) {
  const db = openDatabase(config.paths.dbFile);
  migrate(db, systemClock);
  const chain = new AuditChain(db);
  const repos = new Repos(db, chain, { mode, instanceId: 'cli' });
  return { db, chain, repos };
}

function table(rows) {
  if (rows.length === 0) return '  (none)';
  const w = Math.max(...rows.map((r) => String(r[0]).length));
  return rows.map(([k, v]) => `  ${String(k).padEnd(w)}  ${v}`).join('\n');
}

const egp = (v) => (Number.isFinite(v) ? `EGP ${Number(v).toFixed(2)}` : 'n/a');

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      opts[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (rest[i + 1] && !rest[i + 1].startsWith('--')) {
      opts[key] = rest[i + 1];
      i += 1;
    } else {
      opts[key] = true;
    }
  }
  return { cmd, opts };
}

const HELP = `${BANNER}

USAGE
  node src/cli.js <command> [options]

COMMANDS
  worker              Run the 24/7 paper trading worker (foreground)
  dashboard           Serve the read-only dashboard on 127.0.0.1:8787
  backtest            Replay a recorded price history through the full pipeline
  status              Print account, agent and risk state
  health              Print the heartbeat probe and latched stops
  kill-switch         Latch an emergency stop; refuses all new orders
  reset-stop          Clear a latched emergency stop
  hold                Set the TRADING_HOLD flag (blocks entries, allows exits)
  resume              Clear the TRADING_HOLD flag
  verify              Run the integrity checks over a mode's database

COMMON OPTIONS
  --mode BACKTEST|PAPER   Which isolated database to act on (default PAPER)
  --json                 Machine-readable output where supported
  --ticks N              worker/backtest: stop after N ticks
  --seed N               backtest: price-history seed
  --warmup N             backtest: ticks of replay before trading starts
  --strategy ID          Override the active strategy for this process

SAFETY
  Live trading is not implemented and cannot be enabled. There is no live
  execution adapter in this codebase, no live credentials are read, and
  attempting to set a live-trading environment variable is a hard startup error.
`;

// ---------------------------------------------------------------- commands

async function cmdWorker(opts) {
  const { Worker } = await import('./worker/worker.js');
  const config = loadConfig({ overrides: { mode: 'PAPER' } });
  const logger = createLogger({
    level: opts.log ?? 'info', name: 'cli', logDir: config.paths.logDir,
  });
  const worker = new Worker({ config, logger, strategyId: opts.strategy ?? null });

  const boot = worker.start({ resume: true });
  logger.info('Worker online.', {
    kind: boot.kind, runId: boot.runId, cashEgp: boot.restoredCashEgp, openPositions: boot.openPositions,
  });

  // A SIGINT/SIGTERM must leave the database in a state the next start can
  // resume from: an in-flight order left unrecorded is what turns a restart
  // into a duplicate.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutdown signal received; stopping cleanly.', { signal });
    await worker.stop({ reason: `SIG:${signal}` });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('INT'));
  process.on('SIGTERM', () => shutdown('TERM'));

  await worker.run({ maxTicks: opts.ticks ? Number(opts.ticks) : Infinity });
  await worker.stop({ reason: 'tick budget exhausted' });
  process.exit(0);
}

async function cmdDashboard(opts) {
  const { DashboardServer } = await import('./dashboard/server.js');
  const config = loadConfig({ overrides: { mode: 'PAPER' } });
  const server = new DashboardServer(config);
  await server.listen();
  console.log(`${BANNER}\nDashboard listening on http://${config.dashboard.host}:${config.dashboard.port}`);
  console.log('Read-only. Binds to loopback only. Press Ctrl+C to stop.');
  const shutdown = () => { server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {}); // run until signalled
}

async function cmdBacktest(opts) {
  const { runBacktest } = await import('./backtest/engine.js');
  const config = loadConfig({ overrides: { mode: 'BACKTEST' } });
  const result = await runBacktest({
    config,
    ticks: Number(opts.ticks ?? 4000),
    seed: opts.seed === undefined ? null : Number(opts.seed),
    strategyId: opts.strategy ?? null,
    warmupTicks: Number(opts.warmup ?? 0),
    persist: true,
  });
  if (opts.json) {
    const { toBacktestSummary } = await import('./backtest/report.js');
    console.log(JSON.stringify(toBacktestSummary(result), null, 2));
  } else {
    console.log(result.report);
  }
}

async function cmdSimulate(opts) {
  // A simulate run IS a backtest: same pipeline, same fills, same fees. The
  // separate name exists because "run it for a bit and see" and "measure it and
  // keep the report" are different intents, and collapsing them hides which
  // database the rows went into.
  return cmdBacktest({ ...opts, ticks: opts.ticks ?? 2000 });
}

async function cmdStatus(opts) {
  const mode = opts.mode ?? 'PAPER';
  const config = loadConfig({ overrides: { mode } });
  const { db, repos, chain } = openForRead(config, mode);
  const account = repos.latestBalance(mode);
  const positions = repos.listOpenPositions(mode);
  const stop = repos.sessionStop(mode);
  const hold = repos.getFlag('TRADING_HOLD', 'false', mode) === 'true';
  const heartbeat = repos.latestHeartbeat(mode);
  const lastRun = repos.latestRun(mode);

  if (opts.json) {
    console.log(JSON.stringify({
      mode, lastRun, balance: account, openPositions: positions,
      emergencyStop: stop, tradingHold: hold, heartbeat,
    }, null, 2));
    db.close();
    return;
  }

  console.log(BANNER);
  console.log(`\nMODE: ${mode}   database: ${config.paths.dbFile}\n`);
  console.log('ACCOUNT');
  console.log(table([
    ['starting capital', egp(config.account.startingCapitalEgp)],
    ['cash', egp(account?.cash_egp)],
    ['equity', egp(account?.equity_egp)],
    ['exposure', egp(account?.exposure_egp)],
    ['realised P&L', egp(account?.realized_pnl_egp)],
    ['unrealised P&L', egp(account?.unrealized_pnl_egp)],
    ['fees paid', egp(account?.fees_paid_egp)],
    ['slippage paid', egp(account?.slippage_cost_egp)],
    ['open positions', String(positions.length)],
  ]));
  console.log('\nAGENT');
  console.log(table([
    ['run id', lastRun?.run_id ?? 'none'],
    ['run status', lastRun?.status ?? 'none'],
    ['strategy', lastRun?.strategy_id ?? '-'],
    ['agent state', heartbeat?.agent_state ?? 'no heartbeat'],
    ['last heartbeat', heartbeat?.ts ?? 'never'],
    ['ticks', String(heartbeat?.tick_count ?? 0)],
    ['decisions', String(heartbeat?.decision_count ?? 0)],
    ['orders', String(heartbeat?.order_count ?? 0)],
    ['errors', String(heartbeat?.error_count ?? 0)],
  ]));
  console.log('\nRISK');
  console.log(table([
    ['emergency stop', stop ? `ENGAGED (${stop.trigger})` : 'clear'],
    ['trading hold', hold ? 'ON - new entries blocked' : 'off'],
    ['max loss / trade', egp(config.risk.maxLossPerTradeEgp)],
    ['daily loss limit', egp(config.risk.dailyLossLimitEgp)],
    ['max exposure', egp(config.risk.maxPortfolioExposureEgp)],
    ['max position', egp(config.risk.maxPositionSizeEgp)],
    ['max open positions', String(config.risk.maxOpenPositions)],
    ['leverage', 'none - structurally impossible (long-only, cash-funded)'],
  ]));
  if (positions.length > 0) {
    console.log('\nOPEN POSITIONS');
    console.log(table(positions.map((p) => [
      p.symbol, `qty ${p.quantity} @ ${Number(p.avg_entry_price).toFixed(4)}`,
    ])));
  }
  const chains = ['decision', 'risk', 'sentinel', 'order']
    .map((s) => ({ stream: s, ...chain.verify(s, mode) }));
  console.log('\nAUDIT');
  console.log(table(chains.map((c) => [c.stream, c.ok ? `intact (${c.checked} records)` : `BROKEN: ${c.reason}`])));
  db.close();
}

async function cmdHealth(opts) {
  const mode = opts.mode ?? 'PAPER';
  const config = loadConfig({ overrides: { mode } });
  const { db, repos } = openForRead(config, mode);
  const { Heartbeat } = await import('./worker/heartbeat.js');
  const probe = new Heartbeat({ repos, clock: systemClock, intervalMs: config.worker.heartbeatMs, staleAfterMs: config.worker.heartbeatStaleAfterMs }).probe();
  const stop = repos.sessionStop(mode);
  const errors = repos.listEvents({ mode, level: 'ERROR', limit: 10 });
  const fatals = repos.listEvents({ mode, level: 'FATAL', limit: 10 });

  if (opts.json) {
    console.log(JSON.stringify({ mode, probe, emergencyStop: stop, errors, fatals }, null, 2));
    db.close();
    return;
  }

  console.log(BANNER);
  console.log(`\nHEALTH (${mode})\n`);
  console.log(table([
    ['status', probe.status],
    ['alive', String(probe.alive)],
    ['detail', probe.detail ?? '-'],
    ['last heartbeat age', probe.ageMs === undefined ? 'n/a' : `${Math.round(probe.ageMs / 1000)} s`],
    ['ticks', String(probe.counters?.ticks ?? 0)],
    ['decisions', String(probe.counters?.decisions ?? 0)],
    ['orders', String(probe.counters?.orders ?? 0)],
    ['errors recorded', String(probe.counters?.errors ?? 0)],
    ['emergency stop', stop ? `ENGAGED (${stop.trigger})` : 'clear'],
  ]));
  if (errors.length || fatals.length) {
    console.log('\nRECENT ERRORS');
    for (const e of [...fatals, ...errors].slice(0, 10)) {
      console.log(`  [${e.level}] ${e.category}: ${e.message}`);
    }
  }
  db.close();
  if (!probe.alive) process.exitCode = 1;
}

async function cmdKillSwitch(opts) {
  const mode = opts.mode ?? 'PAPER';
  const config = loadConfig({ overrides: { mode } });
  const { db, repos } = openForRead(config, mode);
  const reason = opts.reason ?? 'operator engaged the kill switch from the CLI';
  const run = repos.latestRun(mode);
  repos.setRun(run?.run_id ?? newId('run'), 'cli');
  const stopId = repos.engageStop({
    trigger: opts.trigger ?? 'OPERATOR_KILL_SWITCH',
    severity: 'CRITICAL',
    scope: 'NEW_ORDERS',
    reason,
    details: { source: 'cli' },
    clock: systemClock,
  });
  repos.logEvent({
    level: 'WARN', category: 'kill_switch', clock: systemClock, mode,
    message: `Operator engaged the kill switch: ${reason}`, details: { stopId },
  });
  console.log(`Emergency stop engaged (${stopId}). All new orders are refused until it is cleared with 'reset-stop'.`);
  db.close();
}

async function cmdResetStop(opts) {
  const mode = opts.mode ?? 'PAPER';
  const config = loadConfig({ overrides: { mode } });
  const { db, repos } = openForRead(config, mode);
  const stop = repos.sessionStop(mode);
  if (!stop) {
    console.log('No active emergency stop. Nothing to clear.');
    db.close();
    return;
  }
  const remaining = repos.clearStop(stop.stop_id, 'cli-operator', systemClock);
  repos.logEvent({
    level: 'WARN', category: 'kill_switch', clock: systemClock, mode,
    message: `Operator cleared emergency stop ${stop.stop_id} (${stop.trigger}).`,
    details: { stopId: stop.stop_id, trigger: stop.trigger, remaining },
  });
  console.log(`Cleared emergency stop ${stop.stop_id} (${stop.trigger}). ${remaining} still active.`);
  console.log('NOTE: clearing a stop does not resolve its cause. Check `status` and the audit log first.');
  db.close();
}

async function cmdHold(opts) {
  const mode = opts.mode ?? 'PAPER';
  const config = loadConfig({ overrides: { mode } });
  const { db, repos } = openForRead(config, mode);
  const value = opts.off ? 'false' : 'true';
  repos.setFlag('TRADING_HOLD', value, systemClock, 'cli-operator', opts.reason ?? 'operator hold', mode);
  repos.logEvent({
    level: 'WARN', category: 'control', clock: systemClock, mode,
    message: `TRADING_HOLD set to ${value}.`, details: { value },
  });
  console.log(value === 'true'
    ? 'TRADING_HOLD engaged: new entries are blocked. Risk-reducing exits are still allowed.'
    : 'TRADING_HOLD cleared: the agent may open new positions again.');
  db.close();
}

async function cmdResume(opts) {
  return cmdHold({ ...opts, off: true });
}

async function cmdVerify(opts) {
  const { runVerification } = await import('../scripts/verify.js');
  const mode = opts.mode ?? 'PAPER';
  const result = await runVerification({ mode, configPath: opts.config ?? null });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.report);
  }
  process.exitCode = result.ok ? 0 : 1;
}

// ------------------------------------------------------------------- main

const COMMANDS = {
  worker: cmdWorker,
  dashboard: cmdDashboard,
  backtest: cmdBacktest,
  simulate: cmdSimulate,
  status: cmdStatus,
  health: cmdHealth,
  'kill-switch': cmdKillSwitch,
  'reset-stop': cmdResetStop,
  hold: cmdHold,
  resume: cmdResume,
  verify: cmdVerify,
};

const { cmd, opts } = parseArgs(process.argv.slice(2));

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`Unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exit(1);
}

handler(opts).catch((err) => {
  // A crash must say what happened, never print a stack containing a secret.
  console.error(`\n${cmd} failed: ${err.message}`);
  if (process.env.TEOS_DEBUG === '1') console.error(err.stack);
  process.exit(1);
});
