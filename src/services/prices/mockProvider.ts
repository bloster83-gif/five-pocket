import type { PriceProvider, Quote } from './types';

// =====================================================================
// 목업 시세 제공자
//  - 종목별로 시드 가격을 정하고, 랜덤 워크로 가격을 움직인다.
//  - 실제 API 없이도 "실시간 추적 → 매수/매도 알림" 전체 흐름을 검증 가능.
//  - 나중에 KIS/Finnhub Provider 로 교체하면 됨 (index.ts 에서 스위칭).
// =====================================================================

const seeds = new Map<string, number>();

function seedPrice(symbol: string): number {
  if (seeds.has(symbol)) return seeds.get(symbol)!;
  // 심볼 문자열로 결정적인 시작가 생성 (같은 종목은 매번 비슷한 가격대)
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  const base = 50 + (h % 4500) / 10; // 대략 50 ~ 500
  seeds.set(symbol, base);
  return base;
}

function nextPrice(prev: number): number {
  // ±0.6% 랜덤 워크 + 아주 약한 평균회귀
  const drift = (Math.random() - 0.5) * 0.012;
  const p = prev * (1 + drift);
  return Math.max(0.01, Math.round(p * 100) / 100);
}

export class MockPriceProvider implements PriceProvider {
  readonly name = 'mock';
  private last = new Map<string, number>();

  async getQuote(symbol: string): Promise<Quote> {
    const seed = seedPrice(symbol);
    const prev = this.last.get(symbol) ?? seed;
    const price = nextPrice(prev);
    this.last.set(symbol, price);
    const currency = /\.(KS|KQ)$/i.test(symbol) ? 'KRW' : 'USD';
    return { symbol, price, at: Date.now(), currency, previousClose: seed };
  }

  subscribe(symbol: string, onQuote: (q: Quote) => void): () => void {
    // 2.5초마다 새 시세 방출 (준실시간 폴링 시뮬레이션)
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      onQuote(await this.getQuote(symbol));
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }
}
