export const leadersRoute = {
  path: '/api/leaders',
  get: async () => {
    return {
      phase: '1-paper-only',
      capital_ceiling: 'EGP_500_PAPER',
      leaders: [],
      metrics: ['sharpe', 'drawdown', 'win_rate', 'audit_score'],
      transparency: 'loss_making_by_design'
    };
  }
}