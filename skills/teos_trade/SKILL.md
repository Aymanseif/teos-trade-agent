# TEOS Trade Agent - Skill Definition
# Compatible with HKUDS AI-Trader (ai4trade)

name: teos_trade
version: 1.0.0-phase1-paper-only
description: Sovereign paper-only autonomous trading agent. No live execution path.
author: Elmahrosa / TEOS

capabilities:
    - mode: [BACKTEST, PAPER] # LIVE is intentionally blocked by schema + config + Sentinel
    - markets: [EGX30_SYNTH, NASDAQ100_REPLAY, ERT_SYNTH]
    - capital_ceiling: EGP 500 (paper, not real)
    - safety: [schema_lock, config_loader_refuse, sentinel_refuse, hash_chained_audit]

tools:
    - get_price: { from: "synthetic_generator", not: "exchange" }
    - submit_order: { to: "simulated_venue", risk_firewall: true }
    - audit_log: { type: "hash_chained", layer: "sentinel" }

rules:
    1. NEVER allow LIVE mode
    2. NEVER connect to exchange
    3. EVERY tick must be audited
    4. Strategy is loss-making by default - transparency required

registration:
  endpoint: https://teos-trade-agent.vercel.app/api/register
  mcp_compatible: true
  ai_trader_compatible: true