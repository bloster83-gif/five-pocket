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

/**
 * KIS 시세 호출 동시성 제한.
 *
 * KIS 는 초당 호출수 제한(EGW00201)이 있는데, 레이더·포켓탭처럼 여러 종목을
 * Promise.all 로 한꺼번에 조회하면 이 제한에 걸린다. 그러면 시세 조회가 실패해
 * Yahoo(15분 지연 정규장 종가)로 폴백되면서 NXT·주간거래 가격이 사라진다.
 * 동시 요청 수를 제한하고 최소 간격을 두어 제한에 걸리지 않게 한다.
 */
const KIS_MAX_CONCURRENT = 2;
const KIS_MIN_GAP_MS = 70;
let kisActive = 0;
let kisLastAt = 0;
const kisWaiters: (() => void)[] = [];

async function withKisSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (kisActive >= KIS_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => kisWaiters.push(resolve));
  }
  kisActive++;
  try {
    const gap = Date.now() - kisLastAt;
    if (gap < KIS_MIN_GAP_MS) await new Promise((r) => setTimeout(r, KIS_MIN_GAP_MS - gap));
    kisLastAt = Date.now();
    return await fn();
  } finally {
    kisActive--;
    kisWaiters.shift()?.();
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
 * KRX 호가단위(틱) — 2023-01-25 개편 기준 (일반주식·리츠·ETF 공통).
 *  ~2,000:1 / ~5,000:5 / ~20,000:10 / ~50,000:50 / ~200,000:100 / ~500,000:500 / 그 이상:1,000
 * (ETF/ETN 은 5원 단위이므로, 아래 표의 틱(≥5,000 구간은 모두 5의 배수)로 정렬해도 항상 유효)
 */
export function krxTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** 지정가를 KRX 호가단위에 맞춰 정렬 (매수=내림, 매도=올림, 그 외=반올림) */
export function alignToKrxTick(price: number, side?: TradeSide): number {
  const p = Math.round(price);
  if (p <= 0) return 0;
  const t = krxTickSize(p);
  const aligned =
    side === 'buy' ? Math.floor(p / t) * t : side === 'sell' ? Math.ceil(p / t) * t : Math.round(p / t) * t;
  return Math.max(t, aligned); // 최소 1틱 보장
}

// 국내주식 주문 정정/취소 TR
const CANCEL_TR = { real: 'TTTC0803U', virtual: 'VTTC0803U' } as const;
// 정정취소가능주문조회 — 취소에 필요한 '주문채번지점번호·주문구분·거래소'를 증권사에서 그대로 받아온다.
// KIS 가 TR ID 를 개편하면서 신·구 두 가지가 통용된다 → 둘 다 시도한다.
const RVSECNCL_PSBL_TRS = {
  real: ['TTTC0084R', 'TTTC8036R'],
  virtual: ['VTTC0084R', 'VTTC8036R'],
} as const;

/** 정정·취소가 가능한 미체결 주문 1건 (취소 요청에 그대로 넣을 값들) */
interface CancelableOrder {
  odno: string; // 주문번호 (증권사 표기 그대로 — 앞자리 0 포함)
  branchNo: string; // ORD_GNO_BRNO → KRX_FWDG_ORD_ORGNO
  ordDvsn: string; // 원주문의 주문구분 (지정가 00 등)
  qty: number; // 취소 가능 수량
  excgId?: string; // 원주문의 거래소구분 (SOR/KRX/NXT)
}

/** 정정취소가능주문조회 결과 — 실패 원인을 그대로 사용자에게 보여줄 수 있도록 진단 정보를 함께 담는다 */
export interface CancelableLookup {
  ok: boolean; // KIS 호출 자체가 성공했는지
  rows: number; // 조회된 미체결 주문 수
  sampleOdnos: string[]; // 조회된 주문번호 (불일치 원인 확인용)
  message: string; // KIS 응답 메시지
  hit: CancelableOrder | null; // 이 주문번호와 일치한 행
}

/**
 * 미체결 주문 목록에서 이 주문번호에 해당하는 행을 찾는다.
 *
 * 취소 요청은 주문번호만으로는 부족하고 '주문채번지점번호(KRX_FWDG_ORD_ORGNO)'가 함께 있어야 한다.
 * 빈 값으로 보내면 KIS 가 "원주문번호가 존재하지 않습니다"로 거절한다.
 * (특히 SOR/넥스트레이드로 나간 주문은 거래소구분까지 원주문과 같아야 한다)
 */
export async function findCancelableOrder(account: BrokerAccount, orderNo: string): Promise<CancelableLookup> {
  const out: CancelableLookup = { ok: false, rows: 0, sampleOdnos: [], message: '', hit: null };
  const token = await getValidToken(account);
  for (const trId of RVSECNCL_PSBL_TRS[account.is_virtual ? 'virtual' : 'real']) {
    try {
      const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl`);
      const params: Record<string, string> = {
        CANO: account.account_no,
        ACNT_PRDT_CD: account.account_product_code,
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
        INQR_DVSN_1: '0', // 조회순
        INQR_DVSN_2: '0', // 전체(매도+매수)
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
      out.message = json.msg1 ?? `HTTP ${res.status}`;
      if (!res.ok || json.rt_cd !== '0') continue; // 다음 TR ID 로 재시도
      out.ok = true;
      const rows = (json.output ?? []) as any[];
      out.rows = rows.length;
      out.sampleOdnos = rows.slice(0, 8).map((r) => String(r.odno ?? ''));
      const hit = rows.find((r) => sameOrderNo(r.odno, orderNo) || sameOrderNo(r.orgn_odno, orderNo));
      if (hit) {
        out.hit = {
          odno: String(hit.odno ?? orderNo),
          branchNo: String(hit.ord_gno_brno ?? ''),
          ordDvsn: String(hit.ord_dvsn_cd ?? '00'),
          qty: Math.floor(Number(hit.psbl_qty ?? hit.ord_qty ?? 0)),
          excgId: hit.excg_id_dvsn_cd ? String(hit.excg_id_dvsn_cd) : undefined,
        };
      }
      return out;
    } catch (e: any) {
      out.message = e?.message ?? '조회 실패';
    }
  }
  return out;
}

/**
 * 국내주식 미체결 주문 취소.
 * 매수 주문가를 바꾸려면 '취소 후 새 가격으로 재주문'하는 방식을 쓴다.
 */
export async function cancelDomesticOrder(
  account: BrokerAccount,
  orderNo: string,
  quantity: number
): Promise<{ message: string }> {
  const token = await getValidToken(account);
  // 증권사가 알고 있는 원주문 정보를 먼저 받아온다 (지점번호·거래소가 맞아야 취소가 된다)
  const found = await findCancelableOrder(account, orderNo);

  const send = async (body: Record<string, string>) => {
    const res = await fetch(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/order-rvsecncl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: CANCEL_TR[account.is_virtual ? 'virtual' : 'real'],
        custtype: 'P',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { ok: res.ok && json.rt_cd === '0', msg: json.msg1 as string | undefined, status: res.status };
  };

  const base = {
    CANO: account.account_no,
    ACNT_PRDT_CD: account.account_product_code,
    RVSE_CNCL_DVSN_CD: '02', // 01 정정 / 02 취소
    ORD_UNPR: '0',
    QTY_ALL_ORD_YN: 'Y', // 잔량 전부 취소
  };

  // 시도 순서: ① 조회로 받은 정확한 값 ② 주문번호 10자리 0패딩 ③ 원본 그대로
  const attempts: Record<string, string>[] = [];
  if (found.hit) {
    const h = found.hit;
    attempts.push({
      ...base,
      KRX_FWDG_ORD_ORGNO: h.branchNo,
      ORGN_ODNO: h.odno,
      ORD_DVSN: h.ordDvsn,
      ORD_QTY: String(h.qty > 0 ? h.qty : Math.floor(quantity)),
      ...(h.excgId ? { EXCG_ID_DVSN_CD: h.excgId } : null),
    });
  }
  const padded = String(orderNo).trim().padStart(10, '0');
  const fallback = {
    ...base,
    KRX_FWDG_ORD_ORGNO: '',
    ORD_DVSN: '00',
    ORD_QTY: String(Math.floor(quantity)),
  };
  attempts.push({ ...fallback, ORGN_ODNO: padded });
  if (padded !== String(orderNo).trim()) attempts.push({ ...fallback, ORGN_ODNO: String(orderNo).trim() });

  let lastMsg = '주문 취소 실패';
  for (const body of attempts) {
    const r = await send(body);
    if (r.ok) return { message: r.msg ?? '주문이 취소됐어요.' };
    lastMsg = r.msg ?? `주문 취소 실패 (HTTP ${r.status})`;
  }

  // 왜 못 찾았는지를 그대로 보여준다 — 주문번호가 어긋난 건지, 조회 자체가 막힌 건지 구분되어야 한다.
  const diag = found.ok
    ? found.hit
      ? ''
      : `\n\n[진단] 증권사 미체결 ${found.rows}건 · 우리 주문번호 ${orderNo}` +
        (found.sampleOdnos.length ? `\n증권사 주문번호: ${found.sampleOdnos.join(', ')}` : '') +
        `\n→ 목록에 없으면 이미 체결·취소됐거나 전일 주문이에요.`
    : `\n\n[진단] 미체결 주문 조회 실패: ${found.message || '알 수 없음'}`;
  throw new Error(`${lastMsg}${diag}`);
}

// 해외주식(미국) 정정취소 TR — 정규장 / 주간거래(블루오션, 실전만)
const OVERSEAS_CANCEL_TR = { real: 'TTTT1004U', virtual: 'VTTT1004U' } as const;
const OVERSEAS_DAYTIME_CANCEL_TR = 'TTTS6038U';

/**
 * 미국주식 미체결 주문 취소.
 * 국내와 마찬가지로 '취소 후 새 가격으로 재주문' 방식에 쓴다.
 */
export async function cancelOverseasOrder(
  account: BrokerAccount,
  orderNo: string,
  symbol: string,
  quantity: number
): Promise<{ message: string }> {
  const token = await getValidToken(account);
  const sym = toKisSymbol(symbol).toUpperCase();
  const priceExch = await resolveUsExchange(account, sym);
  const ovrsExcg = ORDER_EXCH[priceExch] ?? 'NASD';
  // 주문할 때와 같은 기준으로 정규장/주간거래를 판정해 같은 창구로 취소한다.
  const useDaytime = !account.is_virtual && !usRegularOpenNow() && usDaytimeOpenNow();
  const path = useDaytime
    ? '/uapi/overseas-stock/v1/trading/daytime-order-rvsecncl'
    : '/uapi/overseas-stock/v1/trading/order-rvsecncl';
  const trId = useDaytime ? OVERSEAS_DAYTIME_CANCEL_TR : OVERSEAS_CANCEL_TR[account.is_virtual ? 'virtual' : 'real'];

  // 원주문번호는 증권사 표기가 10자리 0패딩이라 그대로 보내면 못 찾는 경우가 있다 → 패딩본 먼저 시도
  const raw = String(orderNo).trim();
  const candidates = Array.from(new Set([raw.padStart(10, '0'), raw]));

  let lastMsg = '해외 주문 취소 실패';
  for (const odno of candidates) {
    const res = await fetch(`${kisBaseUrl(account.is_virtual)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: trId,
        custtype: 'P',
      },
      body: JSON.stringify({
        CANO: account.account_no,
        ACNT_PRDT_CD: account.account_product_code,
        OVRS_EXCG_CD: ovrsExcg,
        PDNO: sym,
        ORGN_ODNO: odno, // 원주문번호
        RVSE_CNCL_DVSN_CD: '02', // 01 정정 / 02 취소
        ORD_QTY: String(Math.floor(quantity)),
        OVRS_ORD_UNPR: '0',
        ORD_SVR_DVSN_CD: '0',
      }),
    });
    const json = await res.json();
    if (res.ok && json.rt_cd === '0') return { message: json.msg1 ?? '주문이 취소됐어요.' };
    lastMsg = json.msg1 ?? `해외 주문 취소 실패 (HTTP ${res.status})`;
  }
  throw new Error(lastMsg);
}

/** 시장에 맞는 미체결 주문 취소 (국내/미국 공통 진입점) */
export async function cancelOrder(
  account: BrokerAccount,
  market: string,
  orderNo: string,
  symbol: string,
  quantity: number
): Promise<{ message: string }> {
  return market === 'US'
    ? cancelOverseasOrder(account, orderNo, symbol, quantity)
    : cancelDomesticOrder(account, orderNo, quantity);
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
  // KRX 는 가격대별 호가단위(틱)의 배수로만 주문 가능 → 목표가를 틱에 맞게 보정
  // (매수는 내림=목표가 이하, 매도는 올림=목표가 이상으로 정렬해 체결에 유리하게)
  const price = alignToKrxTick(input.price, input.side);
  if (qty <= 0) throw new Error('주문 수량이 0입니다.');

  const baseBody = {
    CANO: account.account_no, // 종합계좌번호 앞 8자리
    ACNT_PRDT_CD: account.account_product_code, // 계좌상품코드 뒤 2자리
    PDNO: toKisSymbol(input.symbol), // 종목코드 6자리
    ORD_DVSN: price > 0 ? '00' : '01', // 00 지정가 / 01 시장가
    ORD_QTY: String(qty),
    ORD_UNPR: String(price > 0 ? price : 0),
  };

  // 실전이면 통합(SOR: KRX+넥스트레이드 최선주문집행) 먼저 시도 → NXT 미지원/거부 시 KRX 로 폴백.
  // (모의투자는 NXT/통합 미지원이라 KRX 그대로)
  const venues: (string | undefined)[] = account.is_virtual ? [undefined] : ['SOR', undefined];
  let lastMsg = '주문 실패';
  for (const venue of venues) {
    const body = venue ? { ...baseBody, EXCG_ID_DVSN_CD: venue } : baseBody;
    const res = await fetch(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/trading/order-cash`, {
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
    });
    const json = await res.json();
    if (res.ok && json.rt_cd === '0') {
      return {
        orderNo: json.output?.ODNO ?? '',
        message: (json.msg1 ?? '주문 전송 완료') + (venue === 'SOR' ? ' (통합/NXT)' : ''),
      };
    }
    lastMsg = json.msg1 ?? `주문 실패 (HTTP ${res.status})`;
    // 통합(SOR) 거부면 다음 루프(KRX)로 폴백. 그 외(KRX도 실패)면 마지막에 throw.
  }
  throw new Error(lastMsg);
}

// --------------------------- 해외주식 실시간 시세 ---------------------------

// 미국 거래소 코드 (나스닥/뉴욕/아멕스). 종목별로 되는 거래소를 캐시해 재사용.
const US_EXCHANGES = ['NAS', 'NYS', 'AMS'] as const;
// 미국 주간거래(블루오션) 거래소 코드: 정규 거래소와 매핑
const DAYTIME_OF: Record<string, string> = { NAS: 'BAQ', NYS: 'BAY', AMS: 'BAA' };
const REGULAR_OF: Record<string, string> = { BAQ: 'NAS', BAY: 'NYS', BAA: 'AMS' };
const exchangeCache = new Map<string, string>(); // 정규 거래소 코드 캐시

/**
 * 현재 시각을 미국 동부시간(ET) 기준 요일·분으로 변환.
 * UTC 오프셋을 하드코딩하면 서머타임(EDT/EST) 전환 때 1시간씩 어긋나므로
 * Intl 로 실제 뉴욕 시간을 얻는다.
 */
function etNow(): { day: number; mins: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(get('hour')) % 24; // en-US 는 자정을 24 로 주기도 함
  return { day: dayMap[get('weekday')] ?? 0, mins: hour * 60 + Number(get('minute')) };
}

/** 미국 정규장 (ET 09:30~16:00, 평일) */
function usRegularOpenNow(): boolean {
  const { day, mins } = etNow();
  if (day === 0 || day === 6) return false; // 주말
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
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
  return withKisSlot(() => retryOnRateLimit(() => getOverseasPriceRaw(account, symbol)));
}

async function getOverseasPriceRaw(account: BrokerAccount, symbol: string): Promise<OverseasQuote> {
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
  return withKisSlot(() => retryOnRateLimit(() => getDomesticPriceRaw(account, symbol)));
}

// 종목코드 → 시세가 나오는 시장구분(UN/NX/J) 캐시
const krxMktCache = new Map<string, string>();

async function getDomesticPriceRaw(account: BrokerAccount, symbol: string): Promise<DomesticQuote> {
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

  // 통합 → NXT → KRX 순 폴백.
  // 종목마다 되는 시장구분을 캐시해 매번 3번씩 호출하지 않게 한다
  // (호출수가 줄어야 KIS 초당 제한에 안 걸리고, 걸리면 NXT 가격이 사라진다)
  const cached = krxMktCache.get(code);
  const order = cached ? [cached, ...['UN', 'NX', 'J'].filter((m) => m !== cached)] : ['UN', 'NX', 'J'];
  for (const mkt of order) {
    try {
      const q = await tryMkt(mkt);
      if (q) {
        krxMktCache.set(code, mkt);
        return q;
      }
    } catch {
      /* 다음 시장구분으로 폴백 */
    }
  }
  throw new Error('국내 시세를 불러오지 못했어요.');
}

// 종목코드 → 넥스트레이드(NXT) 거래 종목 여부 캐시
const nxtListedCache = new Map<string, boolean>();

/**
 * 넥스트레이드에서 거래되는 종목인지 확인한다.
 *
 * NXT 시장구분('NX')으로 시세가 나오면 넥스트레이드 상장 종목이다.
 * 이 종목만 KRX 정규장 밖(프리 08:00~08:50 / 애프터 15:40~20:00)에 주문할 수 있다.
 * 조회에 실패하면 false — 안전하게 KRX 정규장에만 주문하도록 한다.
 */
export async function isNxtTradable(account: BrokerAccount, symbol: string): Promise<boolean> {
  const code = toKisSymbol(symbol);
  const cached = nxtListedCache.get(code);
  if (cached !== undefined) return cached;
  try {
    const ok = await withKisSlot(() =>
      retryOnRateLimit(async () => {
        const token = await getValidToken(account);
        const u = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/domestic-stock/v1/quotations/inquire-price`);
        u.searchParams.set('FID_COND_MRKT_DIV_CODE', 'NX');
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
        return json?.rt_cd === '0' && Number(json?.output?.stck_prpr) > 0;
      })
    );
    nxtListedCache.set(code, ok);
    return ok;
  } catch {
    return false; // 확인 실패 → 정규장에만 주문 (보수적)
  }
}

/** 종목의 미국 거래소 코드(NAS/NYS/AMS)를 확정 (캐시에 없으면 시세 조회로 탐색) */
export async function resolveUsExchange(account: BrokerAccount, symbol: string): Promise<string> {
  const sym = symbol.replace(/\.(KS|KQ)$/i, '').trim().toUpperCase();
  if (exchangeCache.has(sym)) return exchangeCache.get(sym)!;
  await getOverseasPrice(account, symbol); // 성공하면 exchangeCache 채워짐
  return exchangeCache.get(sym) ?? 'NAS';
}

// --------------------------- 해외주식 주문 ---------------------------

// 해외주식 현금주문 TR ID (미국 정규장)
const OVERSEAS_ORDER_TR = {
  real: { buy: 'TTTT1002U', sell: 'TTTT1006U' },
  virtual: { buy: 'VTTT1002U', sell: 'VTTT1001U' },
} as const;
// 미국 주간거래(블루오션) 현금주문 TR ID — 실전만 지원(모의투자는 주간거래 미지원)
const OVERSEAS_DAYTIME_ORDER_TR = {
  buy: 'TTTS6036U',
  sell: 'TTTS6037U',
} as const;
// 시세 거래소코드(NAS/NYS/AMS) → 주문 거래소코드(NASD/NYSE/AMEX)
const ORDER_EXCH: Record<string, string> = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' };

/**
 * 미국 주간거래(블루오션 ATS) 운영시간.
 * 실제 운영: 일~목 ET 20:00 ~ 다음날 ET 04:00 (한국시간으로는 평일 09:00~17:00 전후).
 * 예전엔 'KST 10:00~22:30' 으로 잡아 두어서, 블루오션이 이미 끝난 프리마켓 시간대
 * (ET 04:00~09:30 = KST 17:00~22:30)에도 주간거래로 주문을 보내
 * "주간거래 장운영시간이 아닙니다" 로 거부당했다.
 */
function usDaytimeOpenNow(): boolean {
  const { day, mins } = etNow();
  if (day >= 0 && day <= 4 && mins >= 20 * 60) return true; // 일~목 20:00 이후
  if (day >= 1 && day <= 5 && mins < 4 * 60) return true; // 월~금 04:00 이전
  return false;
}

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
    ORD_DVSN: '00', // 지정가 (주간거래도 지정가만 지원)
  };

  // 지금 시간대에 맞는 창구를 먼저 시도하고, 거부당하면 다른 창구로 폴백한다.
  //  · 주간거래(블루오션)  : 일~목 ET 20:00 ~ 04:00
  //  · 정규장 TR           : 정규장 + 프리/애프터 시간대 접수(브로커가 대기 처리)
  // 장 경계(개장 직전·직후)에는 KIS 판정과 1~2분 어긋날 수 있어 폴백이 필요하다.
  // 모의투자는 주간거래를 지원하지 않으므로 정규장 TR 만 쓴다.
  const daytimeFirst = !account.is_virtual && !usRegularOpenNow() && usDaytimeOpenNow();
  const regular = {
    daytime: false,
    trId: OVERSEAS_ORDER_TR[account.is_virtual ? 'virtual' : 'real'][input.side],
    path: '/uapi/overseas-stock/v1/trading/order',
  };
  const daytime = {
    daytime: true,
    trId: OVERSEAS_DAYTIME_ORDER_TR[input.side],
    path: '/uapi/overseas-stock/v1/trading/daytime-order',
  };
  const attempts = account.is_virtual ? [regular] : daytimeFirst ? [daytime, regular] : [regular, daytime];

  let lastMsg = '해외 주문 실패';
  for (const a of attempts) {
    const res = await fetch(`${kisBaseUrl(account.is_virtual)}${a.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: a.trId,
        custtype: 'P',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok && json.rt_cd === '0') {
      return {
        orderNo: json.output?.ODNO ?? '',
        message: (json.msg1 ?? '해외 주문 전송 완료') + (a.daytime ? ' (주간거래)' : ''),
      };
    }
    lastMsg = json.msg1 ?? `해외 주문 실패 (HTTP ${res.status})`;
  }
  throw new Error(lastMsg);
}

// --------------------------- 체결 조회 (실제 체결단가) ---------------------------

const DAILY_CCLD_TR = { real: 'TTTC8001R', virtual: 'VTTC8001R' } as const; // 국내 주문체결
const OVERSEAS_CCLD_TR = { real: 'TTTS3035R', virtual: 'VTTS3035R' } as const; // 해외 체결내역

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 오늘 ± offset일 YYYYMMDD — 해외 체결내역은 미국 현지 날짜 기준이라 범위를 넓혀 조회 */
function ymdOffset(days: number): string {
  const d = new Date(Date.now() + days * 86400 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export interface OrderFill {
  avgPrice: number; // 체결 평균단가
  filledQty: number; // 총 체결수량 (부분체결이면 지금까지의 누계)
  orderQty: number; // 원 주문수량 — filledQty 와 다르면 아직 남아 있는 주문
}

/**
 * KIS 주문번호 비교.
 * 주문 응답의 ODNO 와 체결조회의 odno 는 앞자리 0 패딩이 다르게 오는 경우가 있어
 * ('0005466100' vs '5466100') 단순 문자열 비교로는 같은 주문을 놓친다.
 */
function sameOrderNo(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => String(v ?? '').trim().replace(/^0+/, '');
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

export interface OrderFillDiag {
  ok: boolean; // KIS 호출 자체가 성공했는지
  rows: number; // 조회된 체결행 수
  matched: boolean; // 이 주문번호와 일치하는 행을 찾았는지
  message: string; // KIS msg1 또는 예외 메시지
  sampleOdnos: string[]; // 조회된 주문번호 샘플 (패딩·형식 확인용)
  fill: OrderFill | null;
}

/**
 * 체결 조회 + 진단 정보.
 *
 * 요청에 ODNO 를 필터로 넣지 않는다 — KIS 가 저장한 주문번호와 패딩·형식이 조금만
 * 달라도 서버에서 0건이 돌아와, 클라이언트 비교(sameOrderNo)를 해볼 기회조차 없어진다.
 * 기간 전체를 받아온 뒤 앱에서 주문번호를 맞춘다.
 */
export async function inspectOrderFill(
  account: BrokerAccount,
  market: 'KRX' | 'US',
  orderNo: string,
  symbol?: string
): Promise<OrderFillDiag> {
  const base: OrderFillDiag = { ok: false, rows: 0, matched: false, message: '', sampleOdnos: [], fill: null };
  if (!orderNo) return { ...base, message: '주문번호가 없어요. (주문 시 KIS 가 주문번호를 주지 않았습니다)' };
  try {
    const token = await getValidToken(account);
    const isUs = market === 'US';
    const u = new URL(
      `${kisBaseUrl(account.is_virtual)}${
        isUs ? '/uapi/overseas-stock/v1/trading/inquire-ccnl' : '/uapi/domestic-stock/v1/trading/inquire-daily-ccld'
      }`
    );
    const params: Record<string, string> = isUs
      ? {
          CANO: account.account_no,
          ACNT_PRDT_CD: account.account_product_code,
          PDNO: '%', // 서버 필터를 걸지 않는다 (국내와 동일한 이유)
          // 미국 주문은 KIS 가 '미국 현지 날짜'로 기록 — 한국 날짜와 어긋나도 잡히게 범위 조회
          ORD_STRT_DT: ymdOffset(-7),
          ORD_END_DT: ymdOffset(1),
          SLL_BUY_DVSN_CD: '00',
          CCLD_NCCS_DVSN: '00', // 전체 → 앱에서 체결수량으로 판별
          OVRS_EXCG_CD: '',
          SORT_SQN: 'DS',
          ORD_DT: '',
          ORD_GNO_BRNO: '',
          ODNO: '', // ← 서버 필터를 걸지 않는다 (위 주석 참고)
          CTX_AREA_FK200: '',
          CTX_AREA_NK200: '',
        }
      : {
          CANO: account.account_no,
          ACNT_PRDT_CD: account.account_product_code,
          // 주문 당일에 체결이 안 잡히면 영영 못 찾으므로 최근 7일 범위 (TTTC8001R 은 3개월까지 가능)
          INQR_STRT_DT: ymdOffset(-7),
          INQR_END_DT: ymdOffset(0),
          SLL_BUY_DVSN_CD: '00',
          INQR_DVSN: '00',
          // 서버측 필터를 최소화한다 — 종목코드·체결구분·주문번호로 거르면
          // SOR/NXT 로 체결된 주문처럼 KIS 내부 표기가 다른 건이 통째로 빠진다.
          // (실제로 SOR 현금매수 체결이 '조회할 내용이 없습니다'로 0건 반환됐다)
          PDNO: '',
          CCLD_DVSN: '00', // 전체(체결+미체결) → 앱에서 체결수량으로 판별
          ORD_GNO_BRNO: '',
          ODNO: '',
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
        tr_id: isUs
          ? OVERSEAS_CCLD_TR[account.is_virtual ? 'virtual' : 'real']
          : DAILY_CCLD_TR[account.is_virtual ? 'virtual' : 'real'],
        custtype: 'P',
      },
    });
    const json = await res.json();
    const msg = String(json?.msg1 ?? '').trim();
    if (!res.ok || (json?.rt_cd !== undefined && json.rt_cd !== '0')) {
      return { ...base, message: msg || `조회 실패 (HTTP ${res.status})` };
    }
    const rows = ((isUs ? json?.output : json?.output1) ?? []) as any[];
    const sampleOdnos = rows.slice(0, 8).map((r) => String(r?.odno ?? ''));
    const row = rows.find((r) => sameOrderNo(r.odno, orderNo));
    if (!row) {
      return { ...base, ok: true, rows: rows.length, message: msg || '조회는 됐지만 이 주문번호의 체결이 없어요.', sampleOdnos };
    }
    const qty = isUs ? Number(row.ft_ccld_qty ?? row.ccld_qty ?? 0) : Number(row.tot_ccld_qty ?? 0);
    // 원 주문수량 — 체결수량과 다르면 부분체결이라 주문이 아직 살아 있다
    const ordQty = isUs ? Number(row.ft_ord_qty ?? row.ord_qty ?? 0) : Number(row.ord_qty ?? 0);
    const avg = isUs
      ? Number(row.ft_ccld_unpr3 ?? row.ccld_unpr ?? 0)
      : Number(row.avg_prvs ?? 0) || (qty > 0 ? Number(row.tot_ccld_amt ?? 0) / qty : 0);
    if (qty > 0 && avg > 0) {
      return {
        ok: true,
        rows: rows.length,
        matched: true,
        message: msg || '체결 확인',
        sampleOdnos,
        // 주문수량을 못 읽으면 체결수량을 그대로 써서 '전량 체결'로 본다 (예전 동작)
        fill: { avgPrice: avg, filledQty: qty, orderQty: ordQty > 0 ? ordQty : qty },
      };
    }
    return { ...base, ok: true, rows: rows.length, matched: true, message: '주문은 찾았지만 체결수량이 0이에요 (미체결).', sampleOdnos };
  } catch (e: any) {
    return { ...base, message: typeof e?.message === 'string' ? e.message : '조회 중 오류가 났어요.' };
  }
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
  return (await inspectOrderFill(account, market, orderNo, symbol)).fill;
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
  totalAsset?: number; // 계좌 총평가금액(tot_evlu_amt) — 증권사 앱에 찍히는 총자산 그대로
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
    // 계좌 총평가금액(총자산) — 증권사 앱과 동일한 수치
    totalAsset: Number(summary.tot_evlu_amt ?? 0) || undefined,
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
  exchangeRate?: number; // KIS 고시환율(USD→KRW, best-effort) — 원화 환산용
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
  let cash = Number(s.frcr_dncl_amt1 ?? s.frcr_dncl_amt_2 ?? s.frcr_dncl_amt ?? 0);
  let exchangeRate = 0;

  // '체결기준 현재잔고' TR 로 통화별 외화예수금 + KIS 고시환율(원화 환산용) 조회
  try {
    const u2 = new URL(`${kisBaseUrl(account.is_virtual)}/uapi/overseas-stock/v1/trading/inquire-present-balance`);
    const p2: Record<string, string> = {
      CANO: account.account_no,
      ACNT_PRDT_CD: account.account_product_code,
      WCRC_FRCR_DVSN_CD: '02', // 외화 기준
      NATN_CD: '840', // 미국
      TR_MKET_CD: '00',
      INQR_DVSN_CD: '00',
    };
    Object.entries(p2).forEach(([k, v]) => u2.searchParams.set(k, v));
    const res2 = await fetch(u2.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: account.app_key,
        appsecret: account.app_secret,
        tr_id: account.is_virtual ? 'VTRP6504R' : 'CTRP6504R',
        custtype: 'P',
      },
    });
    const j2 = await res2.json();
    if (res2.ok && j2.rt_cd === '0') {
      const rows: any[] = Array.isArray(j2.output2) ? j2.output2 : j2.output2 ? [j2.output2] : [];
      const usd = rows.find((r) => String(r?.crcy_cd ?? '').toUpperCase() === 'USD') ?? rows[0];
      const c2 = Number(usd?.frcr_dncl_amt_2 ?? usd?.frcr_drwg_psbl_amt_1 ?? usd?.frcr_dncl_amt1 ?? usd?.frcr_dncl_amt ?? 0);
      if (!(cash > 0) && c2 > 0) cash = c2;
      const fx = Number(usd?.frst_bltn_exrt ?? usd?.bass_exrt ?? 0);
      if (fx > 0) exchangeRate = fx;
    }
  } catch {
    /* 보강 실패 시 기존 값 유지 */
  }

  const totalEval = holdings.reduce((a, h) => a + h.evalAmount, 0);
  const totalPnl = holdings.reduce((a, h) => a + h.pnl, 0);
  return { holdings, cash, totalEval, totalPnl, exchangeRate: exchangeRate > 0 ? exchangeRate : undefined };
  });
}
