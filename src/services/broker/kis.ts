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
  if (market !== 'KRX' && market !== 'US') {
    return '자동주문은 한국·미국 주식만 지원해요.';
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

// --------------------------- 해외주식 실시간 시세 ---------------------------

// 미국 거래소 코드 (나스닥/뉴욕/아멕스). 종목별로 되는 거래소를 캐시해 재사용.
const US_EXCHANGES = ['NAS', 'NYS', 'AMS'] as const;
const exchangeCache = new Map<string, string>();

export interface OverseasQuote {
  price: number;
  previousClose?: number;
  currency: 'USD';
}

/**
 * 미국주식 현재가 조회 (KIS 해외주식 현재가, tr_id HHDFS00000300).
 * Yahoo(15분 지연) 대신 KIS 실시간에 가까운 시세를 준다. 거래소 코드는 자동 탐색.
 */
export async function getOverseasPrice(account: BrokerAccount, symbol: string): Promise<OverseasQuote> {
  const token = await getValidToken(account);
  const sym = symbol.replace(/\.(KS|KQ)$/i, '').trim().toUpperCase();

  const tryExchange = async (excd: string): Promise<OverseasQuote | null> => {
    const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/overseas-price/v1/quotations/price`);
    u.searchParams.set('AUTH', '');
    u.searchParams.set('EXCD', excd);
    u.searchParams.set('SYMB', sym);
    const res = await fetch(u.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: 'HHDFS00000300',
        custtype: 'P',
      },
    });
    const json = await res.json();
    const last = Number(json?.output?.last);
    if (json?.rt_cd === '0' && last > 0) {
      return { price: last, previousClose: Number(json.output?.base) || undefined, currency: 'USD' };
    }
    return null;
  };

  const cached = exchangeCache.get(sym);
  const order = cached ? [cached, ...US_EXCHANGES.filter((e) => e !== cached)] : [...US_EXCHANGES];
  for (const excd of order) {
    const q = await tryExchange(excd);
    if (q) {
      exchangeCache.set(sym, excd);
      return q;
    }
  }
  throw new Error('해외 시세를 불러오지 못했어요. (해외주식 서비스 신청 여부를 확인하세요)');
}

/** 종목의 미국 거래소 코드(NAS/NYS/AMS)를 확정 (캐시에 없으면 시세 조회로 탐색) */
export async function resolveUsExchange(account: BrokerAccount, symbol: string): Promise<string> {
  const sym = symbol.replace(/\.(KS|KQ)$/i, '').trim().toUpperCase();
  if (exchangeCache.has(sym)) return exchangeCache.get(sym)!;
  await getOverseasPrice(account, symbol); // 성공하면 exchangeCache 채워짐
  return exchangeCache.get(sym) ?? 'NAS';
}

// --------------------------- 해외주식 주문 ---------------------------

// 해외주식 현금주문 TR ID (미국 주간거래)
const OVERSEAS_ORDER_TR = {
  real: { buy: 'TTTT1002U', sell: 'TTTT1006U' },
  virtual: { buy: 'VTTT1002U', sell: 'VTTT1001U' },
} as const;
// 시세 거래소코드(NAS/NYS/AMS) → 주문 거래소코드(NASD/NYSE/AMEX)
const ORDER_EXCH: Record<string, string> = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' };

/**
 * 미국주식 지정가 주문 (해외주식 현금주문).
 * 거래소는 시세 캐시로 자동 확정. 가격은 달러(USD).
 */
export async function placeOverseasOrder(
  account: BrokerAccount,
  input: KisOrderInput
): Promise<KisOrderResult> {
  const token = await getValidToken(account);
  const sym = toKisSymbol(input.symbol).toUpperCase();
  const priceExch = await resolveUsExchange(account, sym);
  const ovrsExcg = ORDER_EXCH[priceExch] ?? 'NASD';
  const trId = OVERSEAS_ORDER_TR[account.is_virtual ? 'virtual' : 'real'][input.side];
  const qty = Math.floor(input.quantity);
  if (qty <= 0) throw new Error('주문 수량이 0입니다.');

  const body = {
    CANO: account.account_no,
    ACNT_PRDT_CD: account.account_product_code,
    OVRS_EXCG_CD: ovrsExcg,
    PDNO: sym,
    ORD_QTY: String(qty),
    OVRS_ORD_UNPR: input.price.toFixed(2), // 달러 지정가
    ORD_SVR_DVSN_CD: '0',
    ORD_DVSN: '00', // 지정가
  };

  const res = await fetch(`${kisBaseUrl(account.is_virtual)}/uapi/overseas-stock/v1/trading/order`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: account.app_key,
      appsecret: account.app_secret,
      tr_id: trId,
      custtype: 'P',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `해외 주문 실패 (HTTP ${res.status})`);
  }
  return { orderNo: json.output?.ODNO ?? '', message: json.msg1 ?? '해외 주문 전송 완료' };
}

// --------------------------- 잔고 조회 ---------------------------

// 국내주식 잔고조회 TR ID
const BALANCE_TR = { real: 'TTTC8434R', virtual: 'VTTC8434R' } as const;

export interface KisHolding {
  symbol: string; // 종목코드
  name: string; // 종목명
  quantity: number; // 보유수량
  avgPrice: number; // 매입평균가
  currentPrice: number; // 현재가
  evalAmount: number; // 평가금액
  pnl: number; // 평가손익
  pnlRate: number; // 평가손익률(%)
  market: 'KRX' | 'US'; // 통화 구분 (원/달러)
}

export interface KisBalance {
  holdings: KisHolding[];
  totalEval: number; // 유가증권 평가금액 합계 (원화)
  totalPnl: number; // 평가손익 합계 (원화)
  cash: number; // 예수금(주문가능현금, 원화)
  totalEvalUsd?: number; // 해외 평가금액 합계 (달러)
  totalPnlUsd?: number; // 해외 평가손익 합계 (달러)
}

/** 국내주식 잔고(보유종목 + 예수금)를 조회한다. 웹/미지원 환경이면 kisOrderBlocked 로 막힘. */
export async function getDomesticBalance(account: BrokerAccount): Promise<KisBalance> {
  const token = await getValidToken(account);
  const trId = BALANCE_TR[account.is_virtual ? 'virtual' : 'real'];

  const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/inquire-balance`);
  const params: Record<string, string> = {
    CANO: account.account_no,
    ACNT_PRDT_CD: account.account_product_code,
    AFHR_FLPR_YN: 'N', // 시간외단일가 여부
    OFL_YN: '', // 오프라인 여부
    INQR_DVSN: '02', // 조회구분(02 종목별)
    UNPR_DVSN: '01', // 단가구분
    FUND_STTL_ICLD_YN: 'N', // 펀드결제분 포함
    FNCG_AMT_AUTO_RDPT_YN: 'N', // 융자금액 자동상환
    PRCS_DVSN: '00', // 처리구분(00 전일매매포함)
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  };
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));

  const res = await fetch(u.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: account.app_key,
      appsecret: account.app_secret,
      tr_id: trId,
      custtype: 'P',
    },
  });
  const json = await res.json();
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `잔고 조회 실패 (HTTP ${res.status})`);
  }

  const holdings: KisHolding[] = ((json.output1 ?? []) as any[])
    .filter((h) => Number(h.hldg_qty) > 0)
    .map((h) => ({
      symbol: h.pdno,
      name: h.prdt_name,
      quantity: Number(h.hldg_qty),
      avgPrice: Number(h.pchs_avg_pric),
      currentPrice: Number(h.prpr),
      evalAmount: Number(h.evlu_amt),
      pnl: Number(h.evlu_pfls_amt),
      pnlRate: Number(h.evlu_pfls_rt),
      market: 'KRX' as const,
    }));

  const summary = (json.output2 ?? [])[0] ?? {};
  return {
    holdings,
    totalEval: Number(summary.scts_evlu_amt ?? 0), // 유가증권 평가금액
    totalPnl: Number(summary.evlu_pfls_smtl_amt ?? 0), // 평가손익 합계
    cash: Number(summary.dnca_tot_amt ?? summary.prvs_rcdl_excc_amt ?? 0), // 예수금
  };
}

// 해외주식 잔고조회 TR ID (미국)
const OVERSEAS_BALANCE_TR = { real: 'TTTS3012R', virtual: 'VTTS3012R' } as const;

/** 미국주식 잔고(보유종목 + 달러 평가). 실패해도 국내 조회에 영향 없게 별도 함수. */
export async function getOverseasBalance(account: BrokerAccount): Promise<KisHolding[]> {
  const token = await getValidToken(account);
  const trId = OVERSEAS_BALANCE_TR[account.is_virtual ? 'virtual' : 'real'];

  // 미국 전체 거래소 통합 조회 (NASD 지정 + 통화 USD)
  const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/overseas-stock/v1/trading/inquire-balance`);
  const params: Record<string, string> = {
    CANO: account.account_no,
    ACNT_PRDT_CD: account.account_product_code,
    OVRS_EXCG_CD: 'NASD', // 미국전체
    TR_CRCY_CD: 'USD',
    CTX_AREA_FK200: '',
    CTX_AREA_NK200: '',
  };
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));

  const res = await fetch(u.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: account.app_key,
      appsecret: account.app_secret,
      tr_id: trId,
      custtype: 'P',
    },
  });
  const json = await res.json();
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `해외 잔고 조회 실패 (HTTP ${res.status})`);
  }

  return ((json.output1 ?? []) as any[])
    .filter((h) => Number(h.ovrs_cblc_qty) > 0)
    .map((h) => ({
      symbol: h.ovrs_pdno,
      name: h.ovrs_item_name,
      quantity: Number(h.ovrs_cblc_qty),
      avgPrice: Number(h.pchs_avg_pric),
      currentPrice: Number(h.now_pric2),
      evalAmount: Number(h.ovrs_stck_evlu_amt),
      pnl: Number(h.frcr_evlu_pfls_amt),
      pnlRate: Number(h.evlu_pfls_rt),
      market: 'US' as const,
    }));
}
