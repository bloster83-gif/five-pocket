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
import type { BrokerAccount } from '@/types/db';

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

/** KIS 우선 → Yahoo 폴백 현재가 1건 */
export async function getUnifiedQuote(
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
        const oq = await getOverseasPrice(account, symbol); // 정규장+주간거래
        price = oq.price;
        previousClose = oq.previousClose;
      } else {
        const dq = await getDomesticPrice(account, symbol); // 통합(UN)→NXT(NX)→KRX(J)
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
  return { price, previousClose, changePct };
}
