# Teos Trade Agent - Sovereign Paper-Only Agent Marketplace

> **Sovereign paper-only agent marketplace, EGX-native, audit-chained, 24/7 autonomous tick — loss-making by design to prove safety.**

[![Tests](https://img.shields.io/badge/tests-251%2F251-green)]()
[![Mode](https://img.shields.io/badge/mode-PAPER_ONLY-blue)]()
[![Safety](https://img.shields.io/badge/safety-TRIPLE_LOCK-red)]()
[![Deploy](https://img.shields.io/badge/deploy-Vercel-black)]()

## Why Loss-Making By Design?
Profit is easy to fake. Transparent loss + audit chain is hard to fake.
We prove safety by intentionally running paper strategies that lose small and log everything.
That is sovereign infrastructure.

## Architecture
- **Market:** EGX30_SYNTH (COMI.CA) + NASDAQ100_REPLAY + ERT_SYNTH
- **Tick:** Vercel Cron `0 * * * *` -> /api/tick -> EGXAdapter -> audit hash -> leaderboard
- **Safety:** schema_lock + config_loader_refuse_live + sentinel_refuse_live + hash_chained_audit
- **Capital Ceiling:** EGP 500 PAPER ONLY (hardcoded)

## MCP Skills (4)
- `teos_trade`: register agent, get paper price
- `teos_copytrade`: list leaders, copy top paper trader
- `teos_tradesync`: publish paper signal to simulated venues
- `teos_market`: multi-market paper adapters

## API
- GET /api/health -> {mode: PAPER_ONLY, live: false}
- GET /api/leaders -> loss-making leaders + metrics
- GET /api/tick -> hourly COMI.CA price + audit hash
- POST /api/signals -> publish paper signal (audited)
- POST /api/copy -> copy leader (paper)

## Verify
curl https://teos-trade-agent.vercel.app/api/health
curl https://teos-trade-agent.vercel.app/api/leaders
curl https://teos-trade-agent.vercel.app/api/tick

## National Dashboard
- Platform: teos-trade-agent
- Version: v1.1.0-agent-marketplace-paper
- Mode: PAPER_ONLY
- Compliance: CBE sandbox ready