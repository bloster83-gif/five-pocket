// =====================================================================
// 전역 시세 캐시 — 앱의 모든 화면이 같은 '마지막 가격'을 공유한다.
// 어떤 화면이든 시세를 새로 받으면 여기 기록하고, 다른 화면은 진입 즉시
// 이 값을 먼저 보여준 뒤 자기 갱신 주기로 업데이트한다.
// → 프로젝트 목록 ↔ 상세 ↔ 포켓 ↔ 레이더 가격이 어긋나 보이는 문제 해결.
// =====================================================================

export interface StoredQuote {
  price: number;
  previousClose?: number;
  changePct: number | null;
  at: number; // 받은 시각(ms)
}

const store = new Map<string, StoredQuote>();

/** 최신 시세 기록 (unified 헬퍼·priceTracker 가 자동 호출) */
export function setStoredQuote(symbol: string, q: Omit<StoredQuote, 'at'> & { at?: number }): void {
  store.set(symbol, { ...q, at: q.at ?? Date.now() });
}

/** 마지막으로 알려진 시세 (없으면 null) — 화면 진입 시 초기값으로 사용 */
export function getStoredQuote(symbol: string): StoredQuote | null {
  return store.get(symbol) ?? null;
}

/** 여러 심볼의 마지막 시세를 한 번에 (화면 초기 프리필용) */
export function getStoredQuotes(symbols: string[]): Record<string, StoredQuote> {
  const out: Record<string, StoredQuote> = {};
  for (const s of symbols) {
    const q = store.get(s);
    if (q) out[s] = q;
  }
  return out;
}
