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
  pegComputed?: boolean; // true = 제공처 값이 아니라 연간 EPS 성장률로 직접 계산한 값
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

// =====================================================================
// 한국주식 — FMP 무료 플랜이 한국을 지원하지 않아 네이버 증권(모바일) API 사용.
// 키 불필요. 종목검색(symbols.ts)과 같은 소스라 앱에서 안정적으로 동작.
// =====================================================================
const NAVER_STOCK = 'https://m.stock.naver.com/api/stock';
const NAVER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** '005930' / '005930.KS' / '396500.KQ' → 6자리 코드 (아니면 null) */
function naverCode(symbol: string): string | null {
  const m = symbol.trim().toUpperCase().match(/^(\d{6})(\.(KS|KQ))?$/);
  return m ? m[1] : null;
}

/** '359조 4,190억' · '5,777원' · '13.29배' · '37.07%' · '2,368,070' → 숫자 */
function parseKoNum(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[,\s원배%주]/g, '');
  if (!t || t === '-' || t === 'N/A') return null;
  if (/[조억만]/.test(t)) {
    let total = 0;
    const neg = t.startsWith('-');
    const jo = t.match(/([\d.]+)조/);
    const eok = t.match(/([\d.]+)억/);
    const man = t.match(/([\d.]+)만/);
    if (jo) total += parseFloat(jo[1]) * 1e12;
    if (eok) total += parseFloat(eok[1]) * 1e8;
    if (man) total += parseFloat(man[1]) * 1e4;
    if (total === 0) return null;
    return neg ? -total : total;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * PEG = PER ÷ EPS 성장률(%) — 제공처에 PEG 가 없으면 연간 EPS 이력으로 직접 계산.
 * 성장률은 EPS 연평균성장률(CAGR). EPS 가 음수이거나 성장률이 0 이하면 의미가 없어 null.
 */
function computePeg(per: number | null, epsHist: YearValue[]): number | null {
  if (per == null || per <= 0 || epsHist.length < 2) return null;
  const first = epsHist[0].value;
  const last = epsHist[epsHist.length - 1].value;
  const years = epsHist.length - 1;
  if (first <= 0 || last <= 0) return null;
  const growthPct = (Math.pow(last / first, 1 / years) - 1) * 100;
  if (growthPct <= 0) return null;
  return Math.round((per / growthPct) * 100) / 100;
}

async function fetchNaverJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': NAVER_UA } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 네이버 증권으로 한국주식 지표 + 연간 재무(매출/영업이익/순이익/ROE/부채비율/PER) 조회 */
async function getKrxFinancialsFromNaver(code: string): Promise<StockFinancials> {
  const empty: StockFinancials = { fundamentals: null, revenue: [], operatingIncome: [], netIncome: [], perHistory: [] };
  const [integ, annual] = await Promise.all([
    fetchNaverJson(`${NAVER_STOCK}/${code}/integration`),
    fetchNaverJson(`${NAVER_STOCK}/${code}/finance/annual`),
  ]);

  // ---- 현재 지표 (totalInfos: [{code:'per', value:'13.29배'}, ...]) ----
  const infos: any[] = Array.isArray(integ?.totalInfos) ? integ.totalInfos : [];
  const info = (c: string) => parseKoNum(infos.find((x: any) => x?.code === c)?.value);

  // ---- 연간 재무제표 (financeInfo.trTitleList + rowList) ----
  const fi = annual?.financeInfo ?? annual ?? {};
  const titleList: any[] = Array.isArray(fi?.trTitleList) ? fi.trTitleList : [];
  const rowList: any[] = Array.isArray(fi?.rowList) ? fi.rowList : [];
  // 연도 컬럼(확정 실적만 — '(E)' 예상치는 제외)
  const yearCols = titleList
    .map((t: any) => ({ key: t?.key as string, title: String(t?.title ?? '') }))
    .filter((t) => t.key && /^\d{4}/.test(t.title) && !/E\)?\s*$/i.test(t.title));
  const findRow = (name: string) =>
    rowList.find((r: any) => String(r?.title ?? '').replace(/\s/g, '').startsWith(name));
  const series = (name: string, mul = 1): YearValue[] => {
    const r = findRow(name);
    if (!r) return [];
    const out: YearValue[] = [];
    for (const yc of yearCols) {
      const v = parseKoNum(r?.columns?.[yc.key]?.value);
      if (v != null) out.push({ year: yc.title.slice(0, 4), value: v * mul });
    }
    return out.slice(-5);
  };

  // 매출액·영업이익·당기순이익은 '억원' 단위 → 원으로 환산
  const revenue = series('매출액', 1e8);
  const operatingIncome = series('영업이익', 1e8);
  const netIncome = series('당기순이익', 1e8);
  const perHistory = series('PER');
  const roeHist = series('ROE');
  const debtHist = series('부채비율');
  const epsHist = series('EPS');
  const lastOf = (a: YearValue[]) => (a.length ? a[a.length - 1].value : null);

  const marketCap = info('marketValue');
  const per = info('per') ?? lastOf(perHistory);
  const pbr = info('pbr');
  const eps = info('eps') ?? lastOf(epsHist);
  const roe = lastOf(roeHist);
  const debt = lastOf(debtHist);

  const has =
    marketCap != null || per != null || pbr != null || eps != null || revenue.length > 0 || perHistory.length > 0;
  if (!has) return empty;

  const pegCalc = computePeg(per, epsHist);

  return {
    fundamentals: {
      price: null,
      marketCap,
      per,
      pbr,
      peg: pegCalc, // 네이버 미제공 → 연간 EPS 성장률로 직접 계산
      pegComputed: pegCalc != null,
      eps,
      roe: roe != null ? Math.round(roe * 10) / 10 : null, // 이미 %
      debtToEquity: debt != null ? Math.round(debt * 10) / 10 : null, // 이미 %
      currency: 'KRW',
    },
    revenue,
    operatingIncome,
    netIncome,
    perHistory,
  };
}

/** 지표 카드 + 5년 재무제표 + 5년 PER 을 한 번에 조회 */
export async function getStockFinancials(symbol: string, market?: string): Promise<StockFinancials> {
  const sym = fmpSymbol(symbol, market);
  const currency = market === 'KRX' ? 'KRW' : 'USD';
  const empty: StockFinancials = { fundamentals: null, revenue: [], operatingIncome: [], netIncome: [], perHistory: [] };

  // 한국주식은 네이버 증권 우선 (FMP 무료 플랜이 한국 미지원)
  if (market === 'KRX') {
    const code = naverCode(symbol);
    if (code) {
      const naver = await getKrxFinancialsFromNaver(code);
      if (naver.fundamentals || naver.revenue.length > 0) return naver;
    }
    // 네이버 실패 시 FMP 시도(키 있으면) — 대부분 무료 플랜에선 데이터 없음
  }
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

  // FMP 가 PEG 를 안 주면 연간 EPS(손익계산서)로 직접 계산
  if (fundamentals && fundamentals.peg == null) {
    fundamentals.peg = computePeg(fundamentals.per, toYV(income, 'eps'));
    fundamentals.pegComputed = fundamentals.peg != null;
  }

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
