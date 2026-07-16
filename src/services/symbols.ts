import type { Market, SymbolResult } from '@/types/db';

// =====================================================================
// 종목 검색 (키 불필요) — 하이브리드
//  - 한글 입력  → Naver 자동완성 (국내/해외 모두, 한글명 지원)
//  - 영문/티커  → Yahoo 검색 (미국 + 로마자 한국명)
//  두 소스 모두 종목코드를 주므로, 야후 시세용 심볼('005930.KS' 등)로 정규화한다.
// =====================================================================

const YF_HOST = 'https://query1.finance.yahoo.com';
const NAVER_HOST = 'https://ac.stock.naver.com';
const PROXY = process.env.EXPO_PUBLIC_YF_PROXY;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function withProxy(url: string): string {
  if (!PROXY) return url;
  return PROXY.includes('=') ? PROXY + encodeURIComponent(url) : PROXY + url;
}

const hasHangul = (s: string) => /[가-힣㄰-㆏]/.test(s);

/** 야후 심볼/거래소로 우리 시장 코드 판별 */
export function marketFromSymbol(symbol: string, exchange?: string): Market {
  if (/\.(KS|KQ)$/i.test(symbol)) return 'KRX';
  if (exchange && /^(KSC|KOE|KRX)$/i.test(exchange)) return 'KRX';
  return 'US';
}

export async function searchSymbols(query: string): Promise<SymbolResult[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  return hasHangul(q) ? searchNaver(q) : searchYahoo(q);
}

// ---- Yahoo (영문/티커) ----
async function searchYahoo(q: string): Promise<SymbolResult[]> {
  const url = withProxy(`${YF_HOST}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`);
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`yahoo search ${res.status}`);
  const json: any = await res.json();
  return (json?.quotes ?? [])
    .filter((x: any) => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'))
    .map((x: any) => ({
      symbol: x.symbol as string,
      name: (x.longname || x.shortname || x.symbol) as string,
      market: marketFromSymbol(x.symbol, x.exchange),
      exchange: (x.exchDisp || x.exchange || '') as string,
    }));
}

// ---- Naver (한글) ----
async function searchNaver(q: string): Promise<SymbolResult[]> {
  const url = withProxy(
    `${NAVER_HOST}/ac?q=${encodeURIComponent(q)}&target=stock,index,marketindicator&_callback=`
  );
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`naver search ${res.status}`);
  const json: any = await res.json();
  const items: any[] = json?.items ?? [];
  return items
    .filter((it) => it.category === 'stock' && it.code)
    .map((it) => {
      const isKor = it.nationCode === 'KOR';
      const suffix = it.typeCode === 'KOSDAQ' ? '.KQ' : '.KS';
      return {
        symbol: isKor ? `${it.code}${suffix}` : (it.code as string),
        name: it.name as string,
        market: (isKor ? 'KRX' : 'US') as Market,
        exchange: (it.typeName || it.nationName || '') as string,
      };
    });
}
