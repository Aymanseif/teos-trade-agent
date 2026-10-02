name: teos_market
version: 1.0.0
markets:
  EGX30_SYNTH: {source: synthetic_generator, hours: EGX, currency: EGP_PAPER}
  NASDAQ100_REPLAY: {source: historical_replay, currency: USD_PAPER}
  ERT_SYNTH: {source: fpbe_synthetic, currency: ERT_PAPER}
  BINANCE_MENA_PAPER: {source: binance_historical, currency: USDT_PAPER}
tools: [get_price, get_ohlcv, search_news, calc_indicators]
EOF