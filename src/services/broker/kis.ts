// =====================================================================
// 한국투자증권(KIS) OpenAPI — 접근토큰 발급 + 국내주식 현금 매수/매도 주문
//
//  - 실전:  https://openapi.koreainvestment.com:9443
//  - 모의:  https://openapivts.koreainvestment.com:29443  (is_virtual=true)
//  - 접근토큰은 24시간 유효 + 발급이 분당 1회로 제한되므로
//    broker_accounts 테이블에 캐시해 두고 재사용한다.
//  - 웹(브라우저)은 KIS가 CORS를 막아 동작하지 않음 → 실기기/빌드에서만 사용.
// =====================================================================

import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import type { BrokerAccount, TradeSide } from '@/types/db';

const REAL_BASE = 'https://openapi.koreainvestment.com:9443';
const VTS_BASE = 'https://openapivts.koreainvestment.com:29443';

// 국내주식 현금주문 TR ID (실전 T…, 모의 V…)
const TR_ID = {
  real: { buy: 'TTTC0802U', sell: 'TTTC0801U' },
  virtual: { buy: 'VTTC0802U', sell: 'VTTC0801U' },
} as const;

export function kisBaseUrl(isVirtual: boolean): string {
  return isVirtual ? VTS_BASE : REAL_BASE;
}

/** Yahoo 식 심볼('005930.KS')을 KIS 종목코드('005930')로 변환 */
export function toKisSymbol(symbol: string): string {
  return symbol.replace(/\.(KS|KQ)$/i, '').trim();
}

/** KIS 주문이 가능한 환경/종목인지 검사. 문제가 있으면 사유를 반환 */
export function kisOrderBlocked(market: string | null): string | null {
  if (Platform.OS === 'web') {
    return '웹 브라우저에서는 한국투자증권 API가 차단(CORS)돼요. 폰(Expo Go/빌드)에서 실행해 주세요.';
  }
  if (market !== 'KRX') {
    return '자동주문은 현재 한국주식(KRX)만 지원해요.';
  }
  return null;
}

interface TokenResult {
  token: string;
  expiresAt: string; // ISO
}

/** 접근토큰 신규 발급 (분당 1회 제한 주의) */
async function issueToken(account: BrokerAccount): Promise<TokenResult> {
  const res = await fetch(`${kisBaseUrl(account.is_virtual)}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: account.app_key,
      appsecret: account.app_secret,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.msg1 ?? `토큰 발급 실패 (HTTP ${res.status})`);
  }
  const expiresInSec = Number(json.expires_in ?? 86400);
  return {
    token: json.access_token as string,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
}

/**
 * 유효한 접근토큰을 반환한다.
 * DB에 캐시된 토큰이 5분 이상 남아 있으면 재사용, 아니면 새로 발급해 캐시.
 */
export async function getValidToken(account: BrokerAccount): Promise<string> {
  if (
    account.access_token &&
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000
  ) {
    return account.access_token;
  }
  const { token, expiresAt } = await issueToken(account);
  await supabase
    .from('broker_accounts')
    .update({ access_token: token, token_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('user_id', account.user_id);
  account.access_token = token;
  account.token_expires_at = expiresAt;
  return token;
}

/** 계좌 연결 테스트 — 토큰 발급이 되는지 확인 */
export async function testConnection(account: BrokerAccount): Promise<void> {
  await getValidToken(account);
}

export interface KisOrderInput {
  side: TradeSide;
  symbol: string; // '005930' 또는 '005930.KS'
  quantity: number; // 주 (정수)
  price: number; // 지정가 (원). 0이면 시장가
}

export interface KisOrderResult {
  orderNo: string; // KIS 주문번호(ODNO)
  message: string; // KIS 응답 메시지
}

/**
 * 국내주식 현금 매수/매도 주문 (지정가).
 * 성공 시 주문번호를 반환하고, 실패 시 KIS 메시지로 throw.
 */
export async function placeDomesticOrder(
  account: BrokerAccount,
  input: KisOrderInput
): Promise<KisOrderResult> {
  const token = await getValidToken(account);
  const trId = TR_ID[account.is_virtual ? 'virtual' : 'real'][input.side];
  const qty = Math.floor(input.quantity);
  const price = Math.round(input.price); // KRX 는 원 단위 정수
  if (qty <= 0) throw new Error('주문 수량이 0입니다.');

  const body = {
    CANO: account.account_no, // 종합계좌번호 앞 8자리
    ACNT_PRDT_CD: account.account_product_code, // 계좌상품코드 뒤 2자리
    PDNO: toKisSymbol(input.symbol), // 종목코드 6자리
    ORD_DVSN: price > 0 ? '00' : '01', // 00 지정가 / 01 시장가
    ORD_QTY: String(qty),
    ORD_UNPR: String(price > 0 ? price : 0),
  };

  const res = await fetch(
    `${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/order-cash`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: trId,
        custtype: 'P', // 개인
      },
      body: JSON.stringify(body),
    }
  );
  const json = await res.json();
  // rt_cd '0' = 정상
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `주문 실패 (HTTP ${res.status})`);
  }
  return { orderNo: json.output?.ODNO ?? '', message: json.msg1 ?? '주문 전송 완료' };
}
