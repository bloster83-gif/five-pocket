// 가치분석용 재무 데이터 — Financial Modeling Prep(FMP) 무료 API 사용.
// 키: EXPO_PUBLIC_FMP_KEY (없으면 화면에서 안내 카드로 방어).
// 한국주식은 '005930.KS'/'.KQ' 형태 심볼을 그대로 사용(FMP도 동일 포맷).
const BASE = 'https://financialmodelingprep.com/api/v3';

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

async function fmp<T>(path: string): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}apikey=${key}`);
    if (!res.ok) return null;
    const json = await res.json();
    // FMP 는 요청 초과/에러 시 { "Error Message": ... } 객체를 준다
    if (json && !Array.isArray(json) && (json['Error Message'] || json['error'])) return null;
    return json as T;
  } catch {
    return null;
  }
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

const numOrNull = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : v === 0 ? 0 : Number.isFinite(n) ? n : null;
};

/** 지표 카드 + 5년 재무제표 + 5년 PER 을 한 번에 조회 */
export async function getStockFinancials(symbol: string, market?: string): Promise<StockFinancials> {
  const sym = fmpSymbol(symbol, market);
  const currency = market === 'KRX' ? 'KRW' : 'USD';
  const empty: StockFinancials = { fundamentals: null, revenue: [], operatingIncome: [], netIncome: [], perHistory: [] };
  if (!apiKey()) return empty;

  const [quoteArr, ratiosTtmArr, incomeArr, ratiosArr] = await Promise.all([
    fmp<any[]>(`/quote/${encodeURIComponent(sym)}`),
    fmp<any[]>(`/ratios-ttm/${encodeURIComponent(sym)}`),
    fmp<any[]>(`/income-statement/${encodeURIComponent(sym)}?period=annual&limit=5`),
    fmp<any[]>(`/ratios/${encodeURIComponent(sym)}?period=annual&limit=5`),
  ]);

  const q = quoteArr?.[0] ?? null;
  const r = ratiosTtmArr?.[0] ?? null;

  const fundamentals: StockFundamentals | null =
    q || r
      ? {
          price: numOrNull(q?.price),
          marketCap: numOrNull(q?.marketCap),
          per: numOrNull(q?.pe) ?? numOrNull(r?.priceEarningsRatioTTM),
          pbr: numOrNull(r?.priceToBookRatioTTM),
          peg: numOrNull(r?.priceEarningsToGrowthRatioTTM),
          eps: numOrNull(q?.eps) ?? numOrNull(r?.netIncomePerShareTTM),
          roe: r?.returnOnEquityTTM != null ? Math.round(Number(r.returnOnEquityTTM) * 1000) / 10 : null,
          debtToEquity: r?.debtEquityRatioTTM != null ? Math.round(Number(r.debtEquityRatioTTM) * 1000) / 10 : null,
          currency,
        }
      : null;

  // 최근 5년(오래된 순으로 정렬해 그래프가 좌→우 시간순이 되게)
  const income = (incomeArr ?? []).slice().reverse();
  const toYV = (rows: any[], field: string): YearValue[] =>
    rows
      .filter((x) => x && x[field] != null && x.calendarYear)
      .map((x) => ({ year: String(x.calendarYear), value: Number(x[field]) }));

  const perHistory = ((ratiosArr ?? [])
    .slice()
    .reverse()
    .filter((x) => x && x.priceEarningsRatio != null && x.calendarYear)
    .map((x) => ({ year: String(x.calendarYear), value: Math.round(Number(x.priceEarningsRatio) * 100) / 100 }))) as YearValue[];

  return {
    fundamentals,
    revenue: toYV(income, 'revenue'),
    operatingIncome: toYV(income, 'operatingIncome'),
    netIncome: toYV(income, 'netIncome'),
    perHistory,
  };
}

/** 가격 차트용 최근 종가 시계열 (기본 6개월) */
export async function getPriceHistory(symbol: string, market?: string, days = 130): Promise<YearValue[]> {
  const sym = fmpSymbol(symbol, market);
  if (!apiKey()) return [];
  const data = await fmp<{ historical?: { date: string; close: number }[] }>(
    `/historical-price-full/${encodeURIComponent(sym)}?timeseries=${days}`
  );
  const rows = data?.historical ?? [];
  // FMP 는 최신→과거 순 → 과거→최신으로 뒤집어 시간순 라인
  return rows
    .slice()
    .reverse()
    .map((d) => ({ year: d.date, value: Number(d.close) }));
}
