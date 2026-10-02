name: teos_tradesync
version: 1.0.0
description: Sync paper signals across venues (simulated)
capabilities:
    - publish_signal: POST /api/signals {symbol, action, confidence, reasoning}
    - venues: [EGX30_SYNTH, NASDAQ100_REPLAY, ERT_SYNTH, BINANCE_MENA_PAPER]
    - audit: hash_chained
EOF