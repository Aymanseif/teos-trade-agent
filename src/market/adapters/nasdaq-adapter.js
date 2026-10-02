export class NASDAQAdapter {
  constructor() { this.mode = 'PAPER_ONLY'; }
  async getPrice(symbol) {
    return { symbol, price: 150 + Math.random()*5, paper: true, replay: true };
  }
}