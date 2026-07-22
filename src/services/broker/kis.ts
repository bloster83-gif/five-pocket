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

/**
 * KIS "초당 거래건수 초과"(EGW00201) 같은 일시적 호출제한 오류면 잠깐 쉬었다 자동 재시도.
 * (보유주식 조회처럼 짧은 순간 여러 요청이 몰릴 때 발생)
 */
function isRateLimitError(msg: string): boolean {
  return /EGW00201|초당\s?거래\s?건수|거래건수를?\s?초과/.test(msg);
}
async function retryOnRateLimit<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isRateLimitError(msg) && i < tries - 1) {
        await new Promise((r) => setTimeout(r, 300 * (i + 1) * (i + 1))); // 300 → 1200 → 2700ms
        continue;
      }
      throw e;
    }
  }
}

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
// 미국 주간거래(블루오션) 거래소 코드: 정규 거래소와 매핑
const DAYTIME_OF: Record<string, string> = { NAS: 'BAQ', NYS: 'BAY', AMS: 'BAA' };
const REGULAR_OF: Record<string, string> = { BAQ: 'NAS', BAY: 'NYS', BAA: 'AMS' };
const exchangeCache = new Map<string, string>(); // 정규 거래소 코드 캐시

// 미국 정규장(대략 09:30~16:00 ET)을 UTC로 판정. 겨울(EST)·여름(EDT) 모두 커버.
function usRegularOpenNow(): boolean {
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // 주말
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins <= 21 * 60; // 13:30~21:00 UTC
}

export interface OverseasQuote {
  price: number;
  previousClose?: number;
  currency: 'USD';
}

/**
 * 미국주식 현재가 조회 (KIS 해외주식 현재가, tr_id HHDFS00000300).
 * 정규장 시간엔 정규 거래소(NAS/NYS/AMS), 정규장 외(한국 주간 등)엔 주간거래
 * 거래소(BAQ/BAY/BAA)를 우선 조회해 '주간 현재가'도 반영한다. 실패 시 서로 폴백.
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
      // 성공한 거래소가 주간거래면 정규 코드로 환산해 캐시(주문은 정규 거래소 기준)
      exchangeCache.set(sym, REGULAR_OF[excd] ?? excd);
      return { price: last, previousClose: Number(json.output?.base) || undefined, currency: 'USD' };
    }
    return null;
  };

  const cached = exchangeCache.get(sym);
  const regular = cached ? [cached, ...US_EXCHANGES.filter((e) => e !== cached)] : [...US_EXCHANGES];
  const daytime = regular.map((e) => DAYTIME_OF[e] ?? e);
  // 정규장이면 정규 거래소 우선, 아니면 주간거래(BAQ/BAY/BAA) 우선 — 서로 폴백
  const order = usRegularOpenNow() ? [...regular, ...daytime] : [...daytime, ...regular];

  for (const excd of order) {
    const q = await tryExchange(excd);
    if (q) return q;
  }
  throw new Error('해외 시세를 불러오지 못했어요. (해외주식 서비스 신청 여부를 확인하세요)');
}

export interface DomesticQuote {
  price: number;
  previousClose?: number;
  currency: 'KRW';
}

/**
 * 국내주식 현재가 조회 (KIS 국내주식 현재가, tr_id FHKST01010100).
 * 시장구분(FID_COND_MRKT_DIV_CODE):
 *   UN = 통합(KRX+NXT 최우선/최신), NX = 넥스트레이드(NXT), J = KRX(정규)
 * 통합(UN)을 우선 조회해 NXT 장(프리마켓·애프터마켓 등 KRX 정규장 외) 시세도 반영한다.
 * 통합/NXT 미지원이면 KRX(J)로 폴백.
 */
export async function getDomesticPrice(account: BrokerAccount, symbol: string): Promise<DomesticQuote> {
  const token = await getValidToken(account);
  const code = toKisSymbol(symbol);

  const tryMkt = async (mkt: string): Promise<DomesticQuote | null> => {
    const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/quotations/inquire-price`);
    u.searchParams.set('FID_COND_MRKT_DIV_CODE', mkt);
    u.searchParams.set('FID_INPUT_ISCD', code);
    const res = await fetch(u.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: 'FHKST01010100',
        custtype: 'P',
      },
    });
    const json = await res.json();
    const price = Number(json?.output?.stck_prpr);
    if (json?.rt_cd === '0' && price > 0) {
      const prev = Number(json.output?.stck_sdpr) || undefined; // 기준가(전일 종가)
      return { price, previousClose: prev, currency: 'KRW' };
    }
    return null;
  };

  // 통합 → NXT → KRX 순 폴백
  for (const mkt of ['UN', 'NX', 'J']) {
    try {
      const q = await tryMkt(mkt);
      if (q) return q;
    } catch {
      /* 다음 시장구분으로 폴백 */
    }
  }
  throw new Error('국내 시세를 불러오지 못했어요.');
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

// --------------------------- 체결 조회 (실제 체결단가) ---------------------------

const DAILY_CCLD_TR = { real: 'TTTC8001R', virtual: 'VTTC8001R' } as const; // 국내 주문체결
const OVERSEAS_CCLD_TR = { real: 'TTTS3035R', virtual: 'VTTS3035R' } as const; // 해외 체결내역

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export interface OrderFill {
  avgPrice: number; // 체결 평균단가
  filledQty: number; // 총 체결수량
}

/**
 * 주문번호(ODNO)로 실제 체결 평균단가·수량을 조회. 지정가 주문이 실제로 얼마에 체결됐는지 반영용.
 * 아직 미체결이거나 조회 실패면 null → 호출측에서 지정가로 폴백.
 */
export async function getOrderFill(
  account: BrokerAccount,
  market: 'KRX' | 'US',
  orderNo: string,
  symbol?: string
): Promise<OrderFill | null> {
  if (!orderNo) return null;
  const token = await getValidToken(account);
  const ymd = todayYmd();
  try {
    if (market === 'US') {
      const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/overseas-stock/v1/trading/inquire-ccnl`);
      const params: Record<string, string> = {
        CANO: account.account_no,
        ACNT_PRDT_CD: account.account_product_code,
        PDNO: symbol ? toKisSymbol(symbol).toUpperCase() : '%',
        ORD_STRT_DT: ymd,
        ORD_END_DT: ymd,
        SLL_BUY_DVSN_CD: '00',
        CCLD_NCCS_DVSN: '01', // 체결
        OVRS_EXCG_CD: '',
        SORT_SQN: 'DS',
        ORD_DT: '',
        ORD_GNO_BRNO: '',
        ODNO: orderNo,
        CTX_AREA_FK200: '',
        CTX_AREA_NK200: '',
      };
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
      const res = await fetch(u.toString(), {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: account.app_key,
          appsecret: account.app_secret,
          tr_id: OVERSEAS_CCLD_TR[account.is_virtual ? 'virtual' : 'real'],
          custtype: 'P',
        },
      });
      const json = await res.json();
      const rows = (json?.output ?? []) as any[];
      const row = rows.find((r) => r.odno === orderNo) ?? rows[0];
      const qty = Number(row?.ft_ccld_qty ?? row?.ccld_qty ?? 0);
      const price = Number(row?.ft_ccld_unpr3 ?? row?.ccld_unpr ?? 0);
      if (qty > 0 && price > 0) return { avgPrice: price, filledQty: qty };
      return null;
    }
    // 국내
    const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`);
    const params: Record<string, string> = {
      CANO: account.account_no,
      ACNT_PRDT_CD: account.account_product_code,
      INQR_STRT_DT: ymd,
      INQR_END_DT: ymd,
      SLL_BUY_DVSN_CD: '00',
      INQR_DVSN: '00',
      PDNO: symbol ? toKisSymbol(symbol) : '',
      CCLD_DVSN: '01', // 체결만
      ORD_GNO_BRNO: '',
      ODNO: orderNo,
      INQR_DVSN_3: '00',
      INQR_DVSN_1: '',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    };
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: DAILY_CCLD_TR[account.is_virtual ? 'virtual' : 'real'],
        custtype: 'P',
      },
    });
    const json = await res.json();
    const rows = (json?.output1 ?? []) as any[];
    const row = rows.find((r) => r.odno === orderNo) ?? rows[0];
    const qty = Number(row?.tot_ccld_qty ?? 0);
    const amt = Number(row?.tot_ccld_amt ?? 0);
    const avg = Number(row?.avg_prvs ?? 0) || (qty > 0 ? amt / qty : 0);
    if (qty > 0 && avg > 0) return { avgPrice: avg, filledQty: qty };
    return null;
  } catch {
    return null;
  }
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
  return retryOnRateLimit(async () => {
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
    // 예수금: 매도대금 D+2 정산을 반영한 '가수도정산금액(prvs_rcdl_excc_amt)'을 우선 사용.
    // (dnca_tot_amt = D+0 예수금총금액은 매도분이 아직 안 잡혀 10만원 등으로 낮게 뜸)
    cash: Number(
      summary.prvs_rcdl_excc_amt ?? summary.nxdy_excc_amt ?? summary.dnca_tot_amt ?? 0
    ),
  };
  });
}

// 해외주식 잔고조회 TR ID (미국)
const OVERSEAS_BALANCE_TR = { real: 'TTTS3012R', virtual: 'VTTS3012R' } as const;

export interface KisOverseasBalance {
  holdings: KisHolding[];
  cash: number; // 외화 예수금(달러, best-effort)
  totalEval: number; // 평가금액 합계(달러)
  totalPnl: number; // 평가손익 합계(달러)
}

/** 미국주식 잔고(보유종목 + 달러 평가·예수금). 실패해도 국내 조회에 영향 없게 별도 함수. */
export async function getOverseasBalance(account: BrokerAccount): Promise<KisOverseasBalance> {
  return retryOnRateLimit(async () => {
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

  const holdings: KisHolding[] = ((json.output1 ?? []) as any[])
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

  // output2 는 단일 객체(요약). 외화 예수금은 계좌에 따라 필드가 없을 수 있어 best-effort.
  const s = (Array.isArray(json.output2) ? json.output2[0] : json.output2) ?? {};
  const cash = Number(s.frcr_dncl_amt1 ?? s.frcr_dncl_amt_2 ?? s.frcr_dncl_amt ?? 0);
  const totalEval = holdings.reduce((a, h) => a + h.evalAmount, 0);
  const totalPnl = holdings.reduce((a, h) => a + h.pnl, 0);
  return { holdings, cash, totalEval, totalPnl };
  });
}
