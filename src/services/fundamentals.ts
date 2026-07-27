// 가치분석용 재무 데이터 — Financial Modeling Prep(FMP) 무료 API 사용.
// 키: EXPO_PUBLIC_FMP_KEY (없으면 화면에서 안내 카드로 방어).
// 한국주식은 '005930.KS'/'.KQ' 형태 심볼을 그대로 사용(FMP도 동일 포맷).
// FMP 가 신규 '/stable/'(?symbol=) API 로 이전 중이라, stable 을 먼저 시도하고
// 실패하면 legacy '/api/v3/'(경로 심볼) 로 폴백한다. 필드명도 양쪽을 모두 대응.
const STABLE = 'https://financialmodelingprep.com/stable';
const V3 = 'https://financialmodelingprep.com/api/v3';

function apiKey(): string | null {
  const k = process.env.EXPO_PUBLIC_FMP_KEY;
  return k && k.length > 0 ? k : null;
}

export function fundamentalsConfigured(): boolean {
  return !!apiKey();
}

/** FMP용 심볼 정규화 — 6자리 한국코드는 .KS 를 붙인다(이미 접미사 있으면 그대로) */
function fmpSymbol(symbol: string, market?: string): string {
  const s = symbol.trim().toUpperCase();
  if (market === 'KRX' && /^\d{6}$/.test(s)) return s + '.KS';
  return s;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json && !Array.isArray(json) && (json['Error Message'] || json['error'])) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * stable(?symbol=) → v3(/path) 순으로 시도해 배열을 돌려준다.
 * @param stableEp  예: 'quote'  (stable: /stable/quote?symbol=X)
 * @param extra     추가 쿼리 (예: 'period=annual&limit=5')
 */
async function fmpArr(stableEp: string, sym: string, extra = ''): Promise<any[] | null> {
  const key = apiKey();
  if (!key) return null;
  const q = extra ? `&${extra}` : '';
  const stableUrl = `${STABLE}/${stableEp}?symbol=${encodeURIComponent(sym)}${q}&apikey=${key}`;
  const stable = await fetchJson(stableUrl);
  if (Array.isArray(stable) && stable.length > 0) return stable;
  // 폴백: v3 (심볼을 경로에)
  const extraQ = extra ? `?${extra}&` : '?';
  const v3Url = `${V3}/${stableEp}/${encodeURIComponent(sym)}${extraQ}apikey=${key}`;
  const v3 = await fetchJson(v3Url);
  if (Array.isArray(v3)) return v3;
  return Array.isArray(stable) ? stable : null;
}

export interface StockFundamentals {
  price: number | null;
  marketCap: number | null;
  per: number | null;
  pbr: number | null;
  peg: number | null;
  eps: number | null;
  roe: number | null; // %
  debtToEquity: number | null; // 부채비율(%) = 부채/자본 × 100
  currency: string; // 'KRW' | 'USD'
}

export interface YearValue {
  year: string;
  value: number;
}

export interface StockFinancials {
  fundamentals: StockFundamentals | null;
  revenue: YearValue[]; // 최근 5년 매출액
  operatingIncome: YearValue[]; // 최근 5년 영업이익
  netIncome: YearValue[]; // 최근 5년 순이익
  perHistory: YearValue[]; // 최근 5년 PER
}

/** 지표 카드 + 5년 재무제표 + 5년 PER 을 한 번에 조회 */
export async function getStockFinancials(symbol: string, market?: string): Promise<StockFinancials> {
  const sym = fmpSymbol(symbol, market);
  const currency = market === 'KRX' ? 'KRW' : 'USD';
  const empty: StockFinancials = { fundamentals: null, revenue: [], operatingIncome: [], netIncome: [], perHistory: [] };
  if (!apiKey()) return empty;

  const [quoteArr, ratiosTtmArr, incomeArr, ratiosArr] = await Promise.all([
    fmpArr('quote', sym),
    fmpArr('ratios-ttm', sym),
    fmpArr('income-statement', sym, 'period=annual&limit=5'),
    fmpArr('ratios', sym, 'period=annual&limit=5'),
  ]);

  const q = quoteArr?.[0] ?? null;
  const r = ratiosTtmArr?.[0] ?? null;
  // stable/v3 필드명이 달라 양쪽 이름을 모두 시도
  const pick = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && Number.isFinite(n)) return n;
    }
    return null;
  };

  const roeRaw = pick(r?.returnOnEquityTTM);
  const deRaw = pick(r?.debtToEquityRatioTTM, r?.debtEquityRatioTTM);

  const fundamentals: StockFundamentals | null =
    q || r
      ? {
          price: pick(q?.price),
          marketCap: pick(q?.marketCap, q?.marketCapitalization),
          per: pick(q?.pe, r?.priceToEarningsRatioTTM, r?.priceEarningsRatioTTM),
          pbr: pick(r?.priceToBookRatioTTM, r?.priceBookValueRatioTTM),
          peg: pick(r?.priceToEarningsGrowthRatioTTM, r?.priceEarningsToGrowthRatioTTM),
          eps: pick(q?.eps, r?.netIncomePerShareTTM),
          roe: roeRaw != null ? Math.round(roeRaw * 1000) / 10 : null, // 소수(0.15)→%
          debtToEquity: deRaw != null ? Math.round(deRaw * 1000) / 10 : null, // 배→%
          currency,
        }
      : null;

  const yearOf = (x: any): string => String(x?.calendarYear ?? x?.fiscalYear ?? (x?.date ? String(x.date).slice(0, 4) : ''));
  // 최근 5년(오래된 순으로 정렬해 그래프가 좌→우 시간순이 되게)
  const income = (incomeArr ?? []).slice().reverse();
  const toYV = (rows: any[], field: string): YearValue[] =>
    rows
      .filter((x) => x && x[field] != null && yearOf(x))
      .map((x) => ({ year: yearOf(x), value: Number(x[field]) }));

  const perHistory = ((ratiosArr ?? [])
    .slice()
    .reverse()
    .map((x) => ({ x, pe: x?.priceToEarningsRatio ?? x?.priceEarningsRatio }))
    .filter((o) => o.pe != null && yearOf(o.x))
    .map((o) => ({ year: yearOf(o.x), value: Math.round(Number(o.pe) * 100) / 100 }))) as YearValue[];

  return {
    fundamentals,
    revenue: toYV(income, 'revenue'),
    operatingIncome: toYV(income, 'operatingIncome'),
    netIncome: toYV(income, 'netIncome'),
    perHistory,
  };
}

/** 가격 차트용 최근 종가 시계열 (기본 약 6개월) */
export async function getPriceHistory(symbol: string, market?: string, days = 130): Promise<YearValue[]> {
  const key = apiKey();
  if (!key) return [];
  const sym = fmpSymbol(symbol, market);
  // stable: 배열 반환 / v3: { historical: [...] }
  const stable = await fetchJson(`${STABLE}/historical-price-eod/full?symbol=${encodeURIComponent(sym)}&apikey=${key}`);
  let rows: any[] = [];
  if (Array.isArray(stable)) rows = stable;
  else {
    const v3 = await fetchJson(`${V3}/historical-price-full/${encodeURIComponent(sym)}?timeseries=${days}&apikey=${key}`);
    rows = Array.isArray(v3?.historical) ? v3.historical : [];
  }
  // FMP 는 최신→과거 순 → 최근 days개만 잘라 과거→최신으로 뒤집어 시간순 라인
  return rows
    .slice(0, days)
    .reverse()
    .filter((d) => d && d.date != null && d.close != null)
    .map((d) => ({ year: String(d.date), value: Number(d.close) }));
}
