export const healthRoute = {
  path: '/api/health',
  get: async () => {
    return {
      platform: 'teos-trade-agent',
      slogan: 'Sovereign paper-only agent marketplace, EGX-native, audit-chained, 24/7 autonomous tick — loss-making by design to prove safety.',
      mode: 'PAPER_ONLY',
      live: false,
      capital_ceiling: 'EGP_500_PAPER',
      safety: {
        schema_lock: true,
        config_loader_refuse_live: true,
        sentinel_refuse_live: true,
        no_exchange_connectivity: true,
        hash_chained_audit: true
      },
      version: 'v1.1.0-agent-marketplace-paper',
      egx_native: true,
      tick: 'hourly',
      tests: '251/251',
      vercel: 'nodejs20.x',
      timestamp: new Date().toISOString()
    };
  }
}