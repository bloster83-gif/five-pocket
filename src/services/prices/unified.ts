// =====================================================================
// 통합 시세 헬퍼 — 앱 전체 '현재가' 표시의 단일 기준.
//   1순위: KIS 실시간 (국내 = 통합 UN→NXT→KRX 시세, 미국 = 주간거래 포함 해외시세)
//   2순위: Yahoo (KIS 계좌 미연결·웹·실패 시 폴백, 15분 지연)
// 새 화면에서 현재가가 필요하면 반드시 이 헬퍼를 사용할 것.
// =====================================================================
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getDomesticPrice, getOverseasPrice } from '@/services/broker/kis';
import { priceProvider } from './index';
import { getStoredQuote, setStoredQuote } from './quoteStore';
import type { BrokerAccount } from '@/types/db';

// ---- KIS 호출 폭주 방지 ----
// 여러 화면이 종목별 시세를 병렬로 쏘면(+서버 러너 매분) KIS 초당 거래건수
// 제한(EGW00201 '초당 거래건수를 초과')에 걸려 시세가 자주 빠진다.
//  1) 신선도 캐시: 2.5초 안에 받은 시세는 그대로 재사용 (네트워크 0회)
//  2) 동시요청 합치기: 같은 심볼을 여러 화면이 동시에 요청하면 1회만 호출
//  3) 전역 직렬 스로틀: KIS 호출 사이에 220ms 간격을 강제해 초당 건수를 억제
const FRESH_MS = 2500;
const KIS_GAP_MS = 220;

let kisChain: Promise<unknown> = Promise.resolve();
function throttleKis<T>(fn: () => Promise<T>): Promise<T> {
  const p = kisChain.then(
    () => fn(),
    () => fn()
  );
  // 다음 호출은 이번 호출이 끝나고 GAP 이 지난 뒤에 시작된다 (실패해도 간격 유지)
  kisChain = p.then(
    () => new Promise((r) => setTimeout(r, KIS_GAP_MS)),
    () => new Promise((r) => setTimeout(r, KIS_GAP_MS))
  );
  return p;
}

const inFlight = new Map<string, Promise<UnifiedQuote>>();

// KIS 계좌 1회 로드 캐시 (유저별)
let cachedAccount: BrokerAccount | null | undefined;
let cachedFor: string | null = null;

export async function loadBrokerAccount(userId?: string | null): Promise<BrokerAccount | null> {
  if (Platform.OS === 'web') return null;
  // userId 를 안 넘기면 현재 로그인 사용자로 조회
  if (!userId) {
    try {
      userId = (await supabase.auth.getUser()).data.user?.id ?? null;
    } catch {
      return null;
    }
    if (!userId) return null;
  }
  if (cachedFor === userId && cachedAccount !== undefined) return cachedAccount ?? null;
  try {
    const { data } = await supabase.from('broker_accounts').select('*').eq('user_id', userId).maybeSingle();
    cachedAccount = (data as BrokerAccount) ?? null;
    cachedFor = userId;
  } catch {
    cachedAccount = null;
  }
  return cachedAccount ?? null;
}

/** 심볼로 시장 추정 — '005930.KS'/'.KQ'/6자리 코드 = KRX, 그 외 = US */
export function marketOfSymbol(symbol: string): 'KRX' | 'US' {
  return /\.(KS|KQ)$/i.test(symbol) || /^\d{6}$/.test(symbol) ? 'KRX' : 'US';
}

export interface UnifiedQuote {
  price: number;
  previousClose?: number;
  changePct: number | null; // 전일 대비 %
}

/** KIS 우선 → Yahoo 폴백 현재가 1건 (신선도 캐시 + 동시요청 합치기 + KIS 스로틀) */
export async function getUnifiedQuote(
  account: BrokerAccount | null,
  symbol: string,
  market?: string
): Promise<UnifiedQuote> {
  // 1) 방금 받은 시세가 있으면 그대로 사용 (화면 여러 개가 겹쳐 불러도 네트워크 1회)
  const stored = getStoredQuote(symbol);
  if (stored && Date.now() - stored.at < FRESH_MS) {
    return { price: stored.price, previousClose: stored.previousClose, changePct: stored.changePct };
  }
  // 2) 같은 심볼 동시요청 합치기
  const existing = inFlight.get(symbol);
  if (existing) return existing;

  const p = fetchUnifiedQuote(account, symbol, market).finally(() => {
    inFlight.delete(symbol);
  });
  inFlight.set(symbol, p);
  return p;
}

async function fetchUnifiedQuote(
  account: BrokerAccount | null,
  symbol: string,
  market?: string
): Promise<UnifiedQuote> {
  const mkt = market === 'KRX' || market === 'US' ? market : marketOfSymbol(symbol);
  let price: number | null = null;
  let previousClose: number | undefined;
  if (account && Platform.OS !== 'web') {
    try {
      if (mkt === 'US') {
        const oq = await throttleKis(() => getOverseasPrice(account, symbol)); // 정규장+주간거래
        price = oq.price;
        previousClose = oq.previousClose;
      } else {
        const dq = await throttleKis(() => getDomesticPrice(account, symbol)); // 통합(UN)→NXT(NX)→KRX(J)
        price = dq.price;
        previousClose = dq.previousClose;
      }
    } catch {
      /* KIS 실패 → Yahoo 폴백 */
    }
  }
  if (price == null) {
    const yq = await priceProvider.getQuote(symbol);
    price = yq.price;
    previousClose = yq.previousClose;
  }
  const changePct =
    previousClose && previousClose > 0 ? Math.round(((price - previousClose) / previousClose) * 10000) / 100 : null;
  // 전역 캐시에 기록 — 모든 화면이 같은 '마지막 가격'을 공유
  setStoredQuote(symbol, { price, previousClose, changePct });
  return { price, previousClose, changePct };
}
