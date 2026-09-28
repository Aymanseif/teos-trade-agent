/**
 * TEOS Trade Agent - backtest/persist.js
 *
 * Writes a completed backtest into the BACKTEST database.
 *
 * `backtest_runs.mode` has a `CHECK (mode = 'BACKTEST')` constraint and
 * `saveBacktest` hard-codes the literal, so a backtest result physically cannot
 * be written into the paper ledger even if a caller passes the wrong repos
 * object. This is the storage-level half of mode isolation; the
 * repositories' `mode` argument is the other half.
 */

import { roundEgp, roundTo } from '../core/money.js';

export function saveBacktestRun(result, repos, clock) {
  repos.saveBacktest({
    backtestId: result.backtestId,
    strategyId: result.strategyId,
    strategy: { id: result.strategyId, params: result.params, source: 'backtest' },
    params: result.params,
    fromTs: new Date(result.startedAtMs).toISOString(),
    toTs: new Date(result.endedAtMs).toISOString(),
    bars: result.ticks,
    initialEquityEgp: result.startingCapitalEgp,
    finalEquityEgp: result.finalEquityEgp,
    status: result.counts.emergencyStops > 0 ? 'COMPLETED_WITH_STOPS' : 'COMPLETED',
    metrics: result.metrics,
  }, clock);
  return result.backtestId;
}

export function saveBacktestTrades(result, repos) {
  let n = 0;
  for (const t of result.trades) {
    // A position row has no single "entry": it is the weighted average of
    // every BUY fill that built it. The average entry price is therefore the
    // honest single number to store, and the full fill history stays in the
    // fills table keyed by position.
    const qty = Number(t.quantity ?? 0);
    const avg = Number(t.avg_entry_price ?? 0);
    const realized = Number(t.realized_pnl_egp ?? 0);
    repos.saveBacktestTrade({
      backtestId: result.backtestId,
      symbol: t.symbol,
      side: 'LONG',
      entryTs: t.opened_at,
      entryPrice: roundTo(avg, 8),
      exitTs: t.closed_at ?? null,
      exitPrice: null,
      quantity: roundTo(qty, 8),
      pnlEgp: roundEgp(realized),
      feesEgp: roundEgp(t.fees_paid_egp ?? 0),
      reasonIn: 'strategy entry',
      reasonOut: 'strategy exit',
      exitReason: null,
    }, result.backtestId);
    n += 1;
  }
  return n;
}
