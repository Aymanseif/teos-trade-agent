/* TEOS Trade Agent - dashboard/app.js
 *
 * Vanilla ES2020, no framework, no CDN, no build step. Two local files are the
 * only things this page loads.
 *
 * Every value that comes from the database is written with `textContent`, never
 * `innerHTML`. A strategy reason string or an error message is attacker-shaped
 * data as far as the browser is concerned: the CSP blocks inline and remote
 * script, but the correct defence is not building HTML from strings at all.
 */

'use strict';

const state = {
  data: null,
  section: 'account',
  stream: 'orders',
  timer: null,
  failures: 0,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ formatting

const NBSP = '-';
const num = (v, dp = 2) => (typeof v === 'number' && isFinite(v)
  ? v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })
  : NBSP);

function egp(v) { return (typeof v === 'number' && isFinite(v)) ? `EGP ${num(v)}` : NBSP; }
function egpSigned(v) {
  if (typeof v !== 'number' || !isFinite(v)) return NBSP;
  return `${v >= 0 ? '+' : '-'}EGP ${num(Math.abs(v))}`;
}
function pct(v, dp = 2) { return (typeof v === 'number' && isFinite(v)) ? `${num(v, dp)}%` : NBSP; }
function shortTime(iso) {
  if (!iso) return NBSP;
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
function ago(ms) {
  if (typeof ms !== 'number') return NBSP;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function signedClass(v) {
  if (typeof v !== 'number' || !isFinite(v) || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

// -------------------------------------------------------- DOM primitives

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function card(k, v, sub, tone) {
  const c = el('div', `card${tone ? ` ${tone}` : ''}`);
  c.appendChild(el('div', 'k', k));
  c.appendChild(el('div', 'v', v));
  if (sub) c.appendChild(el('div', 's', sub));
  return c;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function kv(target, pairs) {
  clear(target);
  for (const [k, v, tone] of pairs) {
    target.appendChild(el('div', 'k', k));
    const val = el('div', `v${tone ? ` ${tone}` : ''}`, v === undefined || v === null ? NBSP : v);
    target.appendChild(val);
  }
}

const COLUMNS = {
  orders: [
    ['submitted_at', 'submitted', (r) => shortTime(r.submitted_at)],
    ['symbol', 'symbol', (r) => r.symbol],
    ['side', 'side', (r) => r.side, 'pill'],
    ['quantity', 'qty', (r) => r.quantity],
    ['filled_quantity', 'filled', (r) => r.filled_quantity],
    ['avg_fill_price', 'avg fill', (r) => num(r.avg_fill_price, 4)],
    ['status', 'status', (r) => r.status, 'pill'],
    ['client_order_id', 'client_order_id', (r) => r.client_order_id],
    ['decision_id', 'decision_id', (r) => r.decision_id],
    ['rejection_reason', 'rejection', (r) => r.rejection_reason ?? NBSP, null, true],
  ],
  decisions: [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['symbol', 'symbol', (r) => r.symbol],
    ['signal', 'signal', (r) => r.signal],
    ['action', 'action', (r) => r.action],
    ['price', 'price', (r) => num(r.price, 4)],
    ['quantity', 'qty', (r) => r.quantity],
    ['notional_egp', 'notional', (r) => egp(r.notional_egp)],
    ['confidence', 'conf', (r) => num(r.confidence, 3)],
    ['stop_price', 'stop', (r) => num(r.stop_price, 4)],
    ['agent_state', 'agent state', (r) => r.agent_state],
    ['decision_id', 'decision_id', (r) => r.decision_id],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
  ],
  riskDecisions: [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['verdict', 'verdict', (r) => r.verdict, 'pill'],
    ['blocked', 'blocked', (r) => (truthy(r.blocked) ? 'yes' : 'no')],
    ['failed_rule', 'failed rule', (r) => r.failed_rule ?? NBSP],
    ['passed_count', 'passed', (r) => r.passed_count],
    ['failed_count', 'failed', (r) => r.failed_count],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
    ['risk_decision_id', 'risk_decision_id', (r) => r.risk_decision_id],
  ],
  sentinelDecisions: [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['verdict', 'verdict', (r) => r.verdict, 'pill'],
    ['action_taken', 'action', (r) => r.action_taken],
    ['trigger_rule', 'trigger', (r) => r.trigger_rule ?? NBSP],
    ['policy_version', 'policy', (r) => r.policy_version],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
    ['sentinel_decision_id', 'sentinel_decision_id', (r) => r.sentinel_decision_id],
  ],
  fills: [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['symbol', 'symbol', (r) => r.symbol],
    ['side', 'side', (r) => r.side, 'pill'],
    ['quantity', 'qty', (r) => r.quantity],
    ['price', 'price', (r) => num(r.price, 4)],
    ['reference_price', 'ref', (r) => num(r.reference_price, 4)],
    ['notional_egp', 'notional', (r) => egp(r.notional_egp)],
    ['fee_egp', 'fee', (r) => egp(r.fee_egp)],
    ['slippage_cost_egp', 'slip', (r) => egp(r.slippage_cost_egp)],
    ['liquidity', 'liq', (r) => r.liquidity],
    ['fill_id', 'fill_id', (r) => r.fill_id],
  ],
  events: [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['level', 'level', (r) => r.level, 'pill'],
    ['category', 'category', (r) => r.category],
    ['message', 'message', (r) => r.message ?? NBSP, null, true],
    ['event_id', 'event_id', (r) => r.event_id],
  ],
};

function table(target, cols, rows) {
  clear(target);
  if (!rows || rows.length === 0) return;
  const t = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const c of cols) htr.appendChild(el('th', null, c[1]));
  thead.appendChild(htr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    for (const [key, , fn, cls, wrap] of cols) {
      const td = el('td', cls ?? null);
      if (wrap) td.classList.add('wrap');
      const v = fn(r);
      if (cls === 'pill') { const p = el('span', `pill ${v}`, v); td.appendChild(p); }
      else td.textContent = v === null || v === undefined || v === '' ? NBSP : String(v);
      if (key.includes('pnl')) td.classList.add(signedClass(r[key]));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  target.appendChild(t);
}

// ---------------------------------------------------------- equity chart

function drawEquity(series) {
  const canvas = $('equity-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!series || series.length < 2) {
    $('equity-note').textContent = series && series.length === 1
      ? 'One equity sample recorded. A curve needs at least two.'
      : 'No equity samples recorded yet.';
    return;
  }
  $('equity-note').textContent = `${series.length} most recent samples. `
    + 'Flat lines are genuine: the agent only acts on a signal, not on every tick.';

  const pad = { l: 62, r: 12, t: 12, b: 22 };
  const values = series.map((s) => s.equityEgp);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // Always include the capital ceiling so the chart cannot be read as
  // "growing" when it is merely noise inside a fixed envelope.
  hi = Math.max(hi, 500);
  lo = Math.min(lo, 500);
  const span = Math.max(hi - lo, 0.5);
  lo -= span * 0.1; hi += span * 0.1;

  const x = (i) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  ctx.strokeStyle = '#2a313c';
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k += 1) {
    const v = lo + ((hi - lo) * k) / 4;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(v.toFixed(2), 6, yy + 3);
  }

  // The EGP 500 capital ceiling, drawn as a hard reference line.
  const capY = Math.round(y(500)) + 0.5;
  ctx.strokeStyle = 'rgba(248,81,73,0.6)';
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(pad.l, capY); ctx.lineTo(W - pad.r, capY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f85149';
  ctx.fillText('capital ceiling 500', W - pad.r - 118, capY - 4);

  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((s, i) => { const px = x(i); const py = y(s.equityEgp); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  ctx.stroke();

  ctx.fillStyle = '#8b949e';
  const first = shortTime(series[0].ts);
  const last = shortTime(series[series.length - 1].ts);
  ctx.fillText(first, pad.l, H - 6);
  const lw = ctx.measureText(last).width;
  ctx.fillText(last, W - pad.r - lw, H - 6);
}

// ------------------------------------------------------------- rendering

function renderHeader(d) {
  // The badge reports the mode actually read, never a hard-coded string: a
  // BACKTEST database rendered under a "PAPER" badge would be a false claim.
  const badge = $('mode-badge');
  badge.textContent = d.mode ?? 'UNKNOWN';
  badge.className = `badge ${d.mode === 'BACKTEST' ? 'backtest' : 'paper'}`;
  const hb = d.agent?.heartbeat;
  const dot = $('health-dot');
  if (!hb) {
    dot.className = 'dot unknown';
    $('health-text').textContent = 'no heartbeat recorded - the worker has never run in this mode';
  } else if (hb.alive) {
    dot.className = 'dot ok';
    $('health-text').textContent = `worker ${hb.status ?? '?'} / ${hb.agentState ?? '?'} - ${ago(hb.ageMs)}`;
  } else {
    dot.className = 'dot stale';
    $('health-text').textContent = `heartbeat stale by ${ago(hb.ageMs)} (limit ${ago(hb.staleAfterMs)}) - worker not reporting`;
  }

  $('stop-flag').classList.toggle('hidden', !(d.risk?.emergencyStop?.engaged));
  if (d.risk?.emergencyStop?.engaged) {
    $('stop-flag').textContent = `EMERGENCY STOP: ${d.risk.emergencyStop.trigger}`;
  }
  $('hold-flag').classList.toggle('hidden', !(d.risk?.tradingHold?.engaged));
  $('updated').textContent = `updated ${shortTime(d.generatedAt)}`;
  $('footer-db').textContent = `mode ${d.mode ?? '?'} - read-only view`;
}

function renderAccount(d) {
  const a = d.account ?? {};
  const c = $('account-cards');
  clear(c);
  c.appendChild(card('starting capital', egp(a.startingCapitalEgp), `${a.baseAsset ?? 'EGP'}, cash only`));
  c.appendChild(card('cash', egp(a.cashEgp), 'never negative - no borrowing'));
  c.appendChild(card('equity', egp(a.equityEgp), `peak ${egp(a.peakEquityEgp)}`));
  c.appendChild(card('exposure', egp(a.exposureEgp), `${a.openPositionCount ?? 0} open position(s)`));
  c.appendChild(card('realised P&L', egpSigned(a.realizedPnlEgp), 'after fees and slippage', a.realizedPnlEgp > 0 ? 'ok' : (a.realizedPnlEgp < 0 ? 'bad' : '')));
  c.appendChild(card('unrealised P&L', egpSigned(a.unrealizedPnlEgp), 'mark to market', a.unrealizedPnlEgp > 0 ? 'ok' : (a.unrealizedPnlEgp < 0 ? 'bad' : '')));
  c.appendChild(card('fees + slippage', egp((a.feesPaidEgp ?? 0) + (a.slippagePaidEgp ?? 0)), 'drag the strategy must overcome'));
  c.appendChild(card('max drawdown', pct(a.maxDrawdownPct), 'peak to trough, this window'));
  const t = a.trades ?? {};
  c.appendChild(card('closed trades', String(t.total ?? 0), `${t.wins ?? 0}W / ${t.losses ?? 0}L`));
  c.appendChild(card('equity = cash + exposure', a.equityInvariant?.ok ? 'reconciles' : 'MISMATCH',
    `delta ${num(a.equityInvariant?.deltaEgp, 6)} EGP`, a.equityInvariant?.ok ? 'ok' : 'bad'));
  c.appendChild(card('equity <= 500 ceiling', a.capitalInvariant?.ok ? 'within' : 'BREACHED',
    a.capitalInvariant?.cashNonNegative ? 'cash non-negative' : 'NEGATIVE CASH',
    a.capitalInvariant?.ok ? 'ok' : 'bad'));

  drawEquity(a.equityCurve);
  table($('positions'), [
    ['symbol', 'symbol', (r) => r.symbol],
    ['quantity', 'qty', (r) => r.quantity],
    ['avgEntryPrice', 'avg entry', (r) => num(r.avgEntryPrice, 4)],
    ['realizedPnlEgp', 'realised', (r) => egpSigned(r.realizedPnlEgp)],
    ['feesPaidEgp', 'fees', (r) => egp(r.feesPaidEgp)],
    ['openedAt', 'opened', (r) => shortTime(r.openedAt)],
  ], a.positions);

  table($('market'), [
    ['symbol', 'symbol', (r) => r.symbol],
    ['bid', 'bid', (r) => num(r.bid, 4)],
    ['ask', 'ask', (r) => num(r.ask, 4)],
    ['mid', 'mid', (r) => num(r.mid, 4)],
    ['spreadBps', 'spread bps', (r) => num(r.spreadBps, 2)],
    ['source', 'source', (r) => r.source],
    ['ts', 'ts', (r) => shortTime(r.ts)],
  ], a.market);
}

function renderAgent(d) {
  const g = d.agent ?? {};
  const c = $('agent-cards');
  clear(c);
  c.appendChild(card('run status', g.run?.status ?? 'none', g.run?.runId ?? 'no run'));
  c.appendChild(card('strategy', g.strategy?.active ?? NBSP, `${(g.strategy?.enabled ?? []).join(', ')}`));
  c.appendChild(card('ticks', String(g.heartbeat?.tickCount ?? 0), 'this worker instance'));
  c.appendChild(card('decisions', String(g.counters?.decisions ?? 0), 'agent intents recorded'));
  c.appendChild(card('orders', String(g.counters?.orders ?? 0), 'submitted to the paper exchange'));
  c.appendChild(card('errors', String(g.counters?.errors ?? 0), 'ERROR + FATAL events',
    (g.counters?.errors ?? 0) > 0 ? 'bad' : 'ok'));
  c.appendChild(card('restarts', String((g.restarts ?? []).length), 'cold starts and resumes'));
  c.appendChild(card('agent state', g.heartbeat?.agentState ?? 'no heartbeat', g.heartbeat?.lastError ?? ''));

  kv($('agent-run'), [
    ['run id', g.run?.runId],
    ['status', g.run?.status],
    ['mode', g.run?.mode],
    ['strategy', g.run?.strategyId],
    ['instance', g.run?.instanceId],
    ['started', shortTime(g.run?.startedAt)],
    ['ended', shortTime(g.run?.endedAt)],
    ['starting capital', egp(g.run?.startingCapitalEgp)],
  ]);
  kv($('agent-params'), Object.entries(g.strategy?.params ?? {}).map(([k, v]) => [k, typeof v === 'number' ? num(v, 6) : String(v)]));

  table($('agent-restarts'), [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['kind', 'kind', (r) => r.kind, 'pill'],
    ['previous_instance', 'previous instance', (r) => r.previous_instance ?? NBSP],
    ['new_instance', 'new instance', (r) => r.new_instance],
    ['orphaned_orders', 'orphaned', (r) => r.orphaned_orders],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
  ], g.restarts);

  table($('agent-states'), [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['from_state', 'from', (r) => r.from_state],
    ['to_state', 'to', (r) => r.to_state, 'pill'],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
  ], g.stateHistory);

  table($('agent-backtests'), [
    ['created_at', 'created', (r) => shortTime(r.created_at)],
    ['backtest_id', 'backtest_id', (r) => r.backtest_id],
    ['strategy_id', 'strategy', (r) => r.strategy_id],
    ['bars', 'bars', (r) => r.bars],
    ['initial_equity_egp', 'initial', (r) => egp(r.initial_equity_egp)],
    ['final_equity_egp', 'final', (r) => egp(r.final_equity_egp)],
    ['status', 'status', (r) => r.status, 'pill'],
  ], g.backtests);
}

function renderRisk(d) {
  const r = d.agent ? d.risk : null;
  const risk = r ?? {};
  const c = $('risk-cards');
  clear(c);
  c.appendChild(card('emergency stop', risk.emergencyStop?.engaged ? 'ENGAGED' : 'clear',
    risk.emergencyStop?.engaged ? risk.emergencyStop.reason : 'no latched stop', risk.emergencyStop?.engaged ? 'bad' : 'ok'));
  c.appendChild(card('trading hold', risk.tradingHold?.engaged ? 'ON' : 'off', risk.tradingHold?.effect ?? ''));
  c.appendChild(card('max loss / trade', egp(risk.limits?.maxLossPerTradeEgp), pct(risk.limits?.maxLossPerTradePct)));
  c.appendChild(card('daily loss limit', egp(risk.limits?.dailyLossLimitEgp), pct(risk.limits?.dailyLossLimitPct)));
  c.appendChild(card('max exposure', egp(risk.limits?.maxPortfolioExposureEgp), pct(risk.limits?.maxPortfolioExposurePct)));
  c.appendChild(card('max position', egp(risk.limits?.maxPositionSizeEgp), pct(risk.limits?.maxPositionSizePct)));
  c.appendChild(card('max open positions', String(risk.limits?.maxOpenPositions ?? NBSP), 'no unlimited stacking'));
  c.appendChild(card('capital ceiling', egp(risk.limits?.maxStartingCapitalEgp), 'hard, config-validated'));
  const rec = risk.orderFillReconciliation ?? {};
  c.appendChild(card('order / fill agreement', rec.ok ? 'consistent' : `${(rec.problems ?? []).length} problem(s)`,
    `${rec.orders ?? 0} orders`, rec.ok ? 'ok' : 'bad'));
  const chains = risk.chainIntegrity ?? [];
  c.appendChild(card('audit chains', chains.every((x) => x.ok) ? 'intact' : 'BROKEN',
    chains.map((x) => `${x.stream}:${x.records}`).join(' '), chains.every((x) => x.ok) ? 'ok' : 'bad'));

  const L = risk.limits ?? {};
  kv($('risk-limits'), [
    ['max loss per trade', `${egp(L.maxLossPerTradeEgp)} (${pct(L.maxLossPerTradePct)})`],
    ['daily loss limit', `${egp(L.dailyLossLimitEgp)} (${pct(L.dailyLossLimitPct)})`],
    ['max portfolio exposure', `${egp(L.maxPortfolioExposureEgp)} (${pct(L.maxPortfolioExposurePct)})`],
    ['max position size', `${egp(L.maxPositionSizeEgp)} (${pct(L.maxPositionSizePct)})`],
    ['max open positions', String(L.maxOpenPositions)],
    ['max orders / day', String(L.maxOrdersPerDay)],
    ['max orders / symbol / day', String(L.maxOrdersPerSymbolPerDay)],
    ['price deviation limit', `${L.priceDeviationLimitBps} bps`],
    ['max spread', `${L.maxSpreadBps} bps`],
    ['max data staleness', `${Math.round((L.maxDataStalenessMs ?? 0) / 1000)} s`],
    ['min risk:reward', String(L.minRiskRewardRatio)],
    ['stop loss required', truthy(L.stopLossRequired) ? 'yes' : 'no', null, truthy(L.stopLossRequired) ? 'good' : 'bad'],
    ['capital ceiling', egp(L.maxStartingCapitalEgp)],
  ]);
  kv($('risk-policy'), [
    ['direction', 'long only', null, 'good'],
    ['leverage', risk.policy?.leverage, null, 'good'],
    ['negative cash', risk.policy?.allowNegativeCash === false ? 'prohibited' : 'ALLOWED', null,
      risk.policy?.allowNegativeCash === false ? 'good' : 'bad'],
    ['order types', (risk.policy?.allowedOrderTypes ?? []).join(', ')],
  ]);

  table($('risk-stops'), [
    ['ts', 'ts', (r) => shortTime(r.ts)],
    ['trigger', 'trigger', (r) => r.trigger],
    ['severity', 'severity', (r) => r.severity, 'pill'],
    ['active', 'active', (r) => (r.active ? 'ACTIVE' : 'cleared')],
    ['cleared_by', 'cleared by', (r) => r.cleared_by ?? NBSP],
    ['reason', 'reason', (r) => r.reason ?? NBSP, null, true],
  ], risk.stopHistory);

  table($('risk-inflight'), [
    ['submitted_at', 'submitted', (r) => shortTime(r.submittedAt)],
    ['symbol', 'symbol', (r) => r.symbol],
    ['side', 'side', (r) => r.side, 'pill'],
    ['status', 'status', (r) => r.status, 'pill'],
    ['quantity', 'qty', (r) => r.quantity],
    ['filledQuantity', 'filled', (r) => r.filledQuantity],
  ], risk.inFlightOrders);

  const recon = $('risk-recon');
  clear(recon);
  const note = el('p', 'note', rec.ok
    ? `All ${rec.orders ?? 0} order(s) agree with the append-only fill log.`
    : `${(rec.problems ?? []).length} order(s) disagree with their fills.`);
  recon.appendChild(note);
  if (!rec.ok) {
    table(recon, [
      ['orderId', 'order_id', (r) => r.orderId],
      ['problems', 'problems', (r) => r.problems.join('; '), null, true],
    ], rec.problems);
  }
}

function renderAudit(d) {
  const au = d.audit ?? {};
  const c = $('audit-cards');
  clear(c);
  for (const ch of au.chains ?? []) {
    c.appendChild(card(ch.stream, ch.ok ? 'intact' : 'BROKEN',
      `${ch.records} records, ${ch.hashedColumns} hashed columns`, ch.ok ? 'ok' : 'bad'));
  }
  c.appendChild(card('decisions', String((au.decisions ?? []).length), 'agent intents'));
  c.appendChild(card('risk verdicts', String((au.riskDecisions ?? []).length), 'including refusals'));
  c.appendChild(card('sentinel verdicts', String((au.sentinelDecisions ?? []).length), 'ALLOW/WARN/REVIEW/BLOCK'));
  c.appendChild(card('orders', String((au.orders ?? []).length), 'immutable intent'));
  c.appendChild(card('fills', String((au.fills ?? []).length), 'append only'));
  c.appendChild(card('system events', String((au.events ?? []).length), 'errors are never hidden'));

  table($('audit-chains'), [
    ['stream', 'stream', (r) => r.stream],
    ['ok', 'result', (r) => (r.ok ? 'intact' : 'BROKEN'), 'pill'],
    ['records', 'records', (r) => r.records],
    ['hashedColumns', 'hashed columns', (r) => r.hashedColumns],
    ['reason', 'detail', (r) => r.reason, null, true],
  ], au.chains);

  const cols = COLUMNS[state.stream] ?? COLUMNS.orders;
  const rows = au[state.stream] ?? [];
  $('audit-count').textContent = `showing ${rows.length} record(s) from the '${state.stream}' stream, newest first. `
    + 'Blocked and rejected records are listed here too: a refusal is a decision.';
  table($('audit-table'), cols, rows);
}

const RENDERERS = { account: renderAccount, agent: renderAgent, risk: renderRisk, audit: renderAudit };

function render() {
  const d = state.data;
  if (!d) return;
  renderHeader(d);
  for (const [name, fn] of Object.entries(RENDERERS)) fn(d);
}

// -------------------------------------------------------------- transport

async function poll() {
  try {
    const res = await fetch(`/api/snapshot?limit=${state.limit ?? 200}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    state.failures = 0;
    render();
  } catch (err) {
    state.failures += 1;
    $('health-dot').className = 'dot down';
    $('health-text').textContent = `dashboard cannot reach the agent database (${err.message})`;
  }
}

function schedule() {
  const interval = state.data?.agent?.heartbeat?.staleAfterMs
    ? Math.max(1000, Math.min(10000, state.data.agent.heartbeat.staleAfterMs / 5))
    : 2000;
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(poll, interval);
}

// ------------------------------------------------------------------ wiring

function selectSection(name) {
  state.section = name;
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.classList.toggle('active', t.dataset.section === name);
  }
  for (const p of document.querySelectorAll('main .panel')) {
    p.classList.toggle('active', p.id === `panel-${name}`);
  }
}

function selectStream(name) {
  state.stream = name;
  for (const t of document.querySelectorAll('#audit-streams .subtab')) {
    t.classList.toggle('active', t.dataset.stream === name);
  }
  renderAudit(state.data ?? {});
}

function init() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => selectSection(t.dataset.section));
  }
  for (const t of document.querySelectorAll('#audit-streams .subtab')) {
    t.addEventListener('click', () => selectStream(t.dataset.stream));
  }
  poll().then(schedule);
}

init();
