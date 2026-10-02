import { EGXAdapter } from '../market/adapters/egx-adapter.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const tickRoute = {
  path: '/api/tick',
  handler: async (req, res) => {
    try {
      const adapter = new EGXAdapter();
      const priceData = await adapter.getPrice('COMI.CA');

      // Log to audit-proof.json
      const auditLogEntry = {
        timestamp: new Date().toISOString(),
        symbol: priceData.symbol,
        price: priceData.price,
        paper: priceData.paper
      };
      const auditPath = join(process.cwd(), 'eval', 'audit-proof.json');
      let auditLog = [];
      try {
        const auditData = await readFile(auditPath, 'utf8');
        auditLog = JSON.parse(auditData);
        if (!Array.isArray(auditLog)) auditLog = [];
      } catch (e) {
        // file doesn't exist or invalid json
        auditLog = [];
      }
      auditLog.push(auditLogEntry);
      await writeFile(auditPath, JSON.stringify(auditLog, null, 2));

      // Update leaderboard.json
      const leaderboardPath = join(process.cwd(), 'eval', 'leaderboard.json');
      let leaderboard = {};
      try {
        const leaderboardData = await readFile(leaderboardPath, 'utf8');
        leaderboard = JSON.parse(leaderboardData);
      } catch (e) {
        leaderboard = {};
      }
      leaderboard.last_tick = new Date().toISOString();
      leaderboard.last_price = priceData.price;
      await writeFile(leaderboardPath, JSON.stringify(leaderboard, null, 2));

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, priceData }));
    } catch (err) {
      console.error('Tick error:', err);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }
};