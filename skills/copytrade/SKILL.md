name: teos_copytrade
version: 1.0.0
description: One-click copy top paper traders
capabilities:
    - list_leaders: GET /api/leaders
    - copy_agent: POST /api/copy {leader_id, capital_ert: <=500}
    - risk: inherits Sentinel firewall + audit chain
rules:
    - paper_only: true
    - max_copy_capital: EGP_500
    - every_copy_logged: true