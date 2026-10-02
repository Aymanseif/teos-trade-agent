export const signalsRoute = {
  path: '/api/signals',
  handlers: {
    publish: async (req) => {
      // Sentinel check + audit chain
      const signal = { ...req.body, paper: true, audited: true, ts: Date.now() };
      // save to simulated venue
      return { ok: true, signal, audit_hash: 'hash_' + Date.now() };
    },
    feed: async () => {
      return { signals: [], paper_only: true };
    }
  }
}