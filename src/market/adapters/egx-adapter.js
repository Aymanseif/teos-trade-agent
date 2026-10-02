export class EGXAdapter {
  constructor() { this.mode = 'PAPER_ONLY'; this.source = 'synthetic'; }
  async getPrice(symbol) {
    // Paper generator only - no exchange connection
    return { symbol, price: this.syntheticPrice(symbol), ts: Date.now(), paper: true };
  }
  async getOHLCV(symbol, period) {
    return { symbol, period, data: this.replayData(symbol, period), paper: true };
  }
  syntheticPrice(s) { return 100 + Math.sin(Date.now()/100000) * 10; }
  replayData(s, p) { return []; } // wire to your historical JSONL
}