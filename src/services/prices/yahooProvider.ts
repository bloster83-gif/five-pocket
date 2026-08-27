import type { PriceProvider, Quote } from './types';

// =====================================================================
// 야후 파이낸스(비공식) 시세 제공자 — 키 불필요, 한국(.KS/.KQ)+미국 주식 지원
//  - getQuote: chart 엔드포인트에서 현재가/통화/전일종가 파싱
//  - subscribe: N초 폴링 (준실시간, 약 15분 지연 데이터)
//  - fetchCandles: 캔들차트용 일봉 OHLC
// 실기기(Expo Go/네이티브)에서 라이브 동작. 웹은 CORS로 막힘(EXPO_PUBLIC_YF_PROXY 필요).
// =====================================================================

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const PROXY = process.env.EXPO_PUBLIC_YF_PROXY;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function withProxy(url: string): string {
  if (!PROXY) return url;
  return PROXY.includes('=') ? PROXY + encodeURIComponent(url) : PROXY + url;
}

/** 한국 6자리 코드가 접미사 없이 저장된 경우 .KS 를 붙여 야후에서 조회 가능하게 */
export function normalizeSymbol(symbol: string): string {
  if (/^\d{6}$/.test(symbol)) return symbol + '.KS';
  return symbol;
}

// 두 호스트를 순서대로 시도
async function fetchJson(path: string): Promise<any> {
  let lastErr: any;
  for (const host of HOSTS) {
    try {
      const res = await fetch(withProxy(host + path), {
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) {
        lastErr = new Error(`yahoo ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('yahoo fetch failed');
}

const POLL_MS = 4000;

export interface Candle {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
}

export type CandleMode = 'day' | 'week' | 'month';

const MODE_CFG: Record<CandleMode, { interval: string; range: string }> = {
  day: { interval: '1d', range: '10y' }, // 일봉 10년치 (처음엔 1년만 보이고, 밀면 과거가 나온다)
  week: { interval: '1wk', range: '10y' }, // 주봉 10년치
  month: { interval: '1mo', range: '10y' }, // 월봉 10년치
};

/** 캔들차트용 OHLC (일봉/주봉/월봉) */
export async function fetchCandles(symbol: string, mode: CandleMode = 'day'): Promise<{ candles: Candle[]; currency?: string }> {
  const sym = normalizeSymbol(symbol);
  const { interval, range } = MODE_CFG[mode];
  const json = await fetchJson(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`);
  const result = json?.chart?.result?.[0];
  const ts: number[] = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if ([o, h, l, c].some((v) => v == null)) continue;
    candles.push({ t: ts[i] * 1000, o, h, l, c });
  }
  return { candles, currency: result?.meta?.currency };
}

// ---- 가치분석 화면용 종가 시계열 (기간 선택: 1개월~10년) ----
export type SeriesRange = '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | '10Y';

const RANGE_CFG: Record<SeriesRange, { interval: string; range: string }> = {
  '1M': { interval: '1d', range: '1mo' },
  '3M': { interval: '1d', range: '3mo' },
  '6M': { interval: '1d', range: '6mo' },
  '1Y': { interval: '1d', range: '1y' },
  '3Y': { interval: '1wk', range: '3y' },
  '5Y': { interval: '1wk', range: '5y' },
  '10Y': { interval: '1mo', range: '10y' },
};

export interface SeriesPoint {
  t: number; // epoch ms
  c: number; // close
}

/** 기간별 종가 시계열 — 한국(.KS/.KQ)·미국 모두 지원 (키 불필요) */
export async function fetchCloseSeries(
  symbol: string,
  rangeKey: SeriesRange
): Promise<{ points: SeriesPoint[]; currency?: string }> {
  const sym = normalizeSymbol(symbol);
  const { interval, range } = RANGE_CFG[rangeKey];
  const json = await fetchJson(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`);
  const result = json?.chart?.result?.[0];
  const ts: number[] = result?.timestamp ?? [];
  const close: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
  const points: SeriesPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null) continue;
    points.push({ t: ts[i] * 1000, c });
  }
  return { points, currency: result?.meta?.currency };
}

export class YahooPriceProvider implements PriceProvider {
  readonly name = 'yahoo';

  async getQuote(symbol: string): Promise<Quote> {
    const sym = normalizeSymbol(symbol);
    const json = await fetchJson(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      throw new Error('yahoo: no price in response');
    }
    return {
      symbol,
      price: meta.regularMarketPrice,
      at: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      currency: meta.currency,
      previousClose: meta.chartPreviousClose ?? meta.previousClose,
    };
  }

  subscribe(symbol: string, onQuote: (q: Quote) => void): () => void {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        onQuote(await this.getQuote(symbol));
      } catch {
        // 일시적 오류는 무시하고 다음 폴링에서 재시도
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }
}
