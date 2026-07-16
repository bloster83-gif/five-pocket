// 시세 제공자 추상화 — 이 인터페이스만 지키면 목업/KIS/Finnhub 를 교체할 수 있다.

export interface Quote {
  symbol: string;
  price: number;
  at: number; // epoch ms
  currency?: string; // 'KRW' | 'USD' ...
  previousClose?: number; // 전일 종가 (등락률 계산용)
}

export interface PriceProvider {
  /** 이름 (디버깅/표시용) */
  readonly name: string;
  /** 단발성 현재가 조회 */
  getQuote(symbol: string): Promise<Quote>;
  /**
   * 실시간 구독. onQuote 콜백으로 새 시세를 흘려보내고,
   * 구독 해제 함수를 반환한다. (웹소켓이든 폴링이든 내부 구현은 자유)
   */
  subscribe(symbol: string, onQuote: (q: Quote) => void): () => void;
}
