// =====================================================================
// 24시간 무인 자동매매 러너 (Supabase Edge Function)
//
// 앱이 꺼져 있어도 서버가 대신 자동매매를 돌립니다.
// pg_cron 이 1분마다 이 함수를 호출하면:
//   1) AUTO 등급 회원의 자동매매 ON 프로젝트(KRX·US)를 모두 조회
//   2) 한국투자증권(KIS) 현재가 조회 (국내=국내시세 / 미국=해외시세, 거래소 자동탐색)
//   3) 포켓 신호 판정 (waiting & 현재가<=매수목표 → 매수 / bought & 현재가>=매도목표 → 매도)
//   4) KIS 지정가 주문 (국내=국내주문 / 미국=해외주문) → auto_orders/trades 기록 + 포켓 갱신
//   5) Expo 푸시 알림 (profiles.expo_push_token 이 있으면)
//
// 장 운영시간(국내 평일 09:00~15:30 KST / 미국 정규장 09:30~16:00 ET) 외에는
// 해당 시장 프로젝트를 건너뜁니다. (?force=1 로 강제 실행)
// ※ 미국은 정규장(한국 야간) + 주간거래(블루오션, KST 10:00~22:30, 실전만) 모두 지원.
//
// 배포:
//   supabase functions deploy auto-trade-runner
//   (verify_jwt 기본값 유지 — cron 이 service_role 키로 호출합니다)
// 스케줄 등록: supabase/migrations/20260716f_auto_trade_cron.sql 참고
// =====================================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const REAL_BASE = 'https://openapi.koreainvestment.com:9443';
const VTS_BASE = 'https://openapivts.koreainvestment.com:29443';
const ORDER_TR = {
  real: { buy: 'TTTC0802U', sell: 'TTTC0801U' },
  virtual: { buy: 'VTTC0802U', sell: 'VTTC0801U' },
} as const;
const PRICE_TR = 'FHKST01010100'; // 국내 주식현재가 시세
const OVERSEAS_PRICE_TR = 'HHDFS00000300'; // 해외 현재가
const US_EXCHANGES = ['NAS', 'NYS', 'AMS'] as const; // 시세 거래소
const ORDER_EXCH: Record<string, string> = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' }; // 주문 거래소
const OVERSEAS_ORDER_TR = {
  real: { buy: 'TTTT1002U', sell: 'TTTT1006U' },
  virtual: { buy: 'VTTT1002U', sell: 'VTTT1001U' },
} as const;
// 미국 주간거래(블루오션) 주문 TR — 실전만 지원(모의투자 미지원)
const OVERSEAS_DAYTIME_ORDER_TR = { buy: 'TTTS6036U', sell: 'TTTS6037U' } as const;
const DAILY_CCLD_TR = { real: 'TTTC8001R', virtual: 'VTTC8001R' } as const; // 국내 체결조회
const OVERSEAS_CCLD_TR = { real: 'TTTS3035R', virtual: 'VTTS3035R' } as const; // 해외 체결조회

interface BrokerAccount {
  user_id: string;
  app_key: string;
  app_secret: string;
  account_no: string;
  account_product_code: string;
  is_virtual: boolean;
  access_token: string | null;
  token_expires_at: string | null;
}

interface ProjectRow {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  sell_target_pct: number;
  market: 'KRX' | 'US';
}

interface PocketRow {
  id: string;
  project_id: string;
  idx: number;
  buy_target_price: number;
  sell_target_price: number | null;
  budget: number | null;
  status: 'waiting' | 'bought' | 'sold';
}

const baseUrl = (a: BrokerAccount) => (a.is_virtual ? VTS_BASE : REAL_BASE);
const toKisSymbol = (s: string) => s.replace(/\.(KS|KQ)$/i, '').trim();

// ----- 장 운영시간 (KST 평일 09:00 ~ 15:30) -----
function isMarketOpen(): boolean {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}

// ----- KIS 접근토큰 (broker_accounts 에 캐시) -----
async function getToken(admin: SupabaseClient, acc: BrokerAccount): Promise<string> {
  if (
    acc.access_token &&
    acc.token_expires_at &&
    new Date(acc.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000
  ) {
    return acc.access_token;
  }
  const res = await fetch(`${baseUrl(acc)}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: acc.app_key,
      appsecret: acc.app_secret,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(json.error_description ?? json.msg1 ?? `토큰 발급 실패 (HTTP ${res.status})`);
  }
  const expiresAt = new Date(Date.now() + Number(json.expires_in ?? 86400) * 1000).toISOString();
  await admin
    .from('broker_accounts')
    .update({ access_token: json.access_token, token_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('user_id', acc.user_id);
  acc.access_token = json.access_token;
  acc.token_expires_at = expiresAt;
  return json.access_token as string;
}

// ----- KIS 국내주식 현재가 -----
async function getPrice(acc: BrokerAccount, token: string, symbol: string): Promise<number> {
  const u = new URL(`${baseUrl(acc)}/uapi/domestic-stock/v1/quotations/inquire-price`);
  u.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  u.searchParams.set('FID_INPUT_ISCD', toKisSymbol(symbol));
  const res = await fetch(u.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: acc.app_key,
      appsecret: acc.app_secret,
      tr_id: PRICE_TR,
      custtype: 'P',
    },
  });
  const json = await res.json();
  const price = Number(json?.output?.stck_prpr);
  if (!price || Number.isNaN(price)) {
    throw new Error(json?.msg1 ?? `현재가 조회 실패 (${symbol})`);
  }
  return price;
}

// KRX 호가단위(틱) — 2023-01-25 개편 기준 (일반주식·리츠·ETF 공통)
function krxTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}
// 지정가를 호가단위에 맞춰 정렬 (매수=내림, 매도=올림)
function alignToKrxTick(price: number, side: 'buy' | 'sell'): number {
  const p = Math.round(price);
  if (p <= 0) return 0;
  const t = krxTickSize(p);
  const aligned = side === 'buy' ? Math.floor(p / t) * t : Math.ceil(p / t) * t;
  return Math.max(t, aligned);
}

// ----- KIS 국내주식 현금 지정가 주문 -----
async function placeOrder(
  acc: BrokerAccount,
  token: string,
  side: 'buy' | 'sell',
  symbol: string,
  qty: number,
  price: number
): Promise<{ orderNo: string; message: string }> {
  const baseBody = {
    CANO: acc.account_no,
    ACNT_PRDT_CD: acc.account_product_code,
    PDNO: toKisSymbol(symbol),
    ORD_DVSN: '00', // 지정가
    ORD_QTY: String(Math.floor(qty)),
    ORD_UNPR: String(alignToKrxTick(price, side)), // 호가단위 정렬
  };
  // 실전이면 통합(SOR: KRX+넥스트레이드 최선체결) 먼저, 실패/미지원이면 KRX 폴백. 모의는 KRX 그대로.
  const venues: (string | undefined)[] = acc.is_virtual ? [undefined] : ['SOR', undefined];
  let lastMsg = '주문 실패';
  for (const venue of venues) {
    const body = venue ? { ...baseBody, EXCG_ID_DVSN_CD: venue } : baseBody;
    const res = await fetch(`${baseUrl(acc)}/uapi/domestic-stock/v1/trading/order-cash`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: acc.app_key,
        appsecret: acc.app_secret,
        tr_id: ORDER_TR[acc.is_virtual ? 'virtual' : 'real'][side],
        custtype: 'P',
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
  }
  throw new Error(lastMsg);
}

// ----- 미국 정규장 (ET 평일 09:30~16:00) — Deno Intl 로 정확 판정 -----
function isUsRegularOpen(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hh = Number(parts.find((p) => p.type === 'hour')?.value);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value);
  const mins = hh * 60 + mm;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

// ----- 미국 주간거래(블루오션) 시간대 — 대략 KST 평일 10:00~22:30 (정규장 시작 전) -----
function isUsDaytimeOpen(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hh = Number(parts.find((p) => p.type === 'hour')?.value);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value);
  const mins = hh * 60 + mm;
  return mins >= 10 * 60 && mins < 22 * 60 + 30;
}

// ----- KIS 미국주식 현재가 + 거래소코드 자동 탐색 -----
async function getUsPrice(
  acc: BrokerAccount,
  token: string,
  symbol: string
): Promise<{ price: number; exch: string }> {
  const sym = toKisSymbol(symbol).toUpperCase();
  for (const excd of US_EXCHANGES) {
    const u = new URL(`${baseUrl(acc)}/uapi/overseas-price/v1/quotations/price`);
    u.searchParams.set('AUTH', '');
    u.searchParams.set('EXCD', excd);
    u.searchParams.set('SYMB', sym);
    const res = await fetch(u.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: acc.app_key,
        appsecret: acc.app_secret,
        tr_id: OVERSEAS_PRICE_TR,
        custtype: 'P',
      },
    });
    const json = await res.json();
    const last = Number(json?.output?.last);
    if (json?.rt_cd === '0' && last > 0) return { price: last, exch: excd };
  }
  throw new Error(`해외 현재가 조회 실패 (${symbol})`);
}

// ----- KIS 미국주식 지정가 주문 -----
async function placeUsOrder(
  acc: BrokerAccount,
  token: string,
  side: 'buy' | 'sell',
  symbol: string,
  exch: string,
  qty: number,
  price: number,
  daytime = false
): Promise<{ orderNo: string; message: string }> {
  // 주간거래 시간대(실전)면 블루오션 주문 TR/엔드포인트로, 그 외엔 정규장 주문
  const trId = daytime ? OVERSEAS_DAYTIME_ORDER_TR[side] : OVERSEAS_ORDER_TR[acc.is_virtual ? 'virtual' : 'real'][side];
  const path = daytime
    ? '/uapi/overseas-stock/v1/trading/daytime-order'
    : '/uapi/overseas-stock/v1/trading/order';
  const res = await fetch(`${baseUrl(acc)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: acc.app_key,
      appsecret: acc.app_secret,
      tr_id: trId,
      custtype: 'P',
    },
    body: JSON.stringify({
      CANO: acc.account_no,
      ACNT_PRDT_CD: acc.account_product_code,
      OVRS_EXCG_CD: ORDER_EXCH[exch] ?? 'NASD',
      PDNO: toKisSymbol(symbol).toUpperCase(),
      ORD_QTY: String(Math.floor(qty)),
      OVRS_ORD_UNPR: price.toFixed(2), // 달러 지정가
      ORD_SVR_DVSN_CD: '0',
      ORD_DVSN: '00', // 지정가 (주간거래도 지정가만)
    }),
  });
  const json = await res.json();
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `해외 주문 실패 (HTTP ${res.status})`);
  }
  return {
    orderNo: json.output?.ODNO ?? '',
    message: (json.msg1 ?? '해외 주문 전송 완료') + (daytime ? ' (주간거래)' : ''),
  };
}

// ----- 실제 체결단가 조회 (주문번호로 체결 평균가·수량) -----
function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 오늘 ± offset일 YYYYMMDD — 해외 체결내역은 미국 현지 날짜 기준 + 서버는 UTC 라 범위를 넓혀 조회 */
function ymdOffset(days: number): string {
  const d = new Date(Date.now() + days * 86400 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function getOrderFill(
  acc: BrokerAccount,
  token: string,
  market: 'KRX' | 'US',
  orderNo: string,
  symbol: string
): Promise<{ avgPrice: number; filledQty: number } | null> {
  if (!orderNo) return null;
  const ymd = todayYmd();
  try {
    if (market === 'US') {
      const u = new URL(`${baseUrl(acc)}/uapi/overseas-stock/v1/trading/inquire-ccnl`);
      const params: Record<string, string> = {
        CANO: acc.account_no,
        ACNT_PRDT_CD: acc.account_product_code,
        PDNO: toKisSymbol(symbol).toUpperCase(),
        // 미국 주문은 KIS 가 '미국 현지 날짜'로 기록 + 서버는 UTC — 하루 어긋나도 잡히게 범위 조회
        ORD_STRT_DT: ymdOffset(-3),
        ORD_END_DT: ymdOffset(1),
        SLL_BUY_DVSN_CD: '00',
        CCLD_NCCS_DVSN: '01',
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
          appkey: acc.app_key,
          appsecret: acc.app_secret,
          tr_id: OVERSEAS_CCLD_TR[acc.is_virtual ? 'virtual' : 'real'],
          custtype: 'P',
        },
      });
      const json = await res.json();
      const rows = (json?.output ?? []) as Array<Record<string, string>>;
      const row = rows.find((r) => r.odno === orderNo) ?? rows[0];
      const qty = Number(row?.ft_ccld_qty ?? row?.ccld_qty ?? 0);
      const price = Number(row?.ft_ccld_unpr3 ?? row?.ccld_unpr ?? 0);
      return qty > 0 && price > 0 ? { avgPrice: price, filledQty: qty } : null;
    }
    const u = new URL(`${baseUrl(acc)}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`);
    const params: Record<string, string> = {
      CANO: acc.account_no,
      ACNT_PRDT_CD: acc.account_product_code,
      INQR_STRT_DT: ymd,
      INQR_END_DT: ymd,
      SLL_BUY_DVSN_CD: '00',
      INQR_DVSN: '00',
      PDNO: toKisSymbol(symbol),
      CCLD_DVSN: '01',
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
        appkey: acc.app_key,
        appsecret: acc.app_secret,
        tr_id: DAILY_CCLD_TR[acc.is_virtual ? 'virtual' : 'real'],
        custtype: 'P',
      },
    });
    const json = await res.json();
    const rows = (json?.output1 ?? []) as Array<Record<string, string>>;
    const row = rows.find((r) => r.odno === orderNo) ?? rows[0];
    const qty = Number(row?.tot_ccld_qty ?? 0);
    const amt = Number(row?.tot_ccld_amt ?? 0);
    const avg = Number(row?.avg_prvs ?? 0) || (qty > 0 ? amt / qty : 0);
    return qty > 0 && avg > 0 ? { avgPrice: avg, filledQty: qty } : null;
  } catch {
    return null;
  }
}

// ----- 미체결로 기록된 자동주문을 실제 체결단가로 자동 동기화 (매 실행마다) -----
async function reconcilePendingFills(admin: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 2 * 86400 * 1000).toISOString(); // 최근 2일
  const { data: pending } = await admin
    .from('auto_orders')
    .select('id,user_id,project_id,pocket_id,side,symbol,kis_order_no')
    .eq('status', 'sent')
    .gte('created_at', since);
  if (!pending?.length) return 0;

  const uids = [...new Set(pending.map((o) => o.user_id))];
  const projIds = [...new Set(pending.map((o) => o.project_id))];
  const [{ data: accounts }, { data: projs }] = await Promise.all([
    admin.from('broker_accounts').select('*').in('user_id', uids),
    admin.from('projects').select('id,market,sell_target_pct').in('id', projIds),
  ]);
  const accByUser = new Map((accounts ?? []).map((a) => [a.user_id, a as BrokerAccount]));
  const projById = new Map((projs ?? []).map((p) => [p.id, p]));

  let updated = 0;
  for (const o of pending) {
    const acc = accByUser.get(o.user_id);
    const proj = projById.get(o.project_id);
    if (!acc || !proj || !o.kis_order_no) continue;
    try {
      const token = await getToken(admin, acc);
      const fill = await getOrderFill(acc, token, proj.market === 'US' ? 'US' : 'KRX', o.kis_order_no, o.symbol);
      if (!fill || fill.avgPrice <= 0) continue;
      // 이 주문의 체결 기록이 이미 있으면 실제 체결가로 갱신(주로 매수), 없으면(주문완료 매도 등) 생성.
      const { data: existing } = await admin
        .from('trades')
        .select('id')
        .eq('project_id', o.project_id)
        .ilike('note', `%${o.kis_order_no}%`)
        .limit(1);
      if (existing && existing.length > 0) {
        await admin
          .from('trades')
          .update({ price: fill.avgPrice, quantity: fill.filledQty })
          .eq('project_id', o.project_id)
          .ilike('note', `%${o.kis_order_no}%`);
      } else {
        await admin.from('trades').insert({
          user_id: o.user_id,
          project_id: o.project_id,
          pocket_id: o.pocket_id,
          side: o.side,
          price: fill.avgPrice,
          quantity: fill.filledQty,
          executed_at: new Date().toISOString(),
          note: `자동주문·서버(KIS ${o.kis_order_no}) ${o.side === 'sell' ? '매도' : '매수'}`,
        });
      }
      // 주문완료 → 체결 확인되면 보유중/매도완료로 전환
      if (o.pocket_id) {
        if (o.side === 'buy') {
          await admin
            .from('pockets')
            .update({
              status: 'bought',
              sell_target_price: Math.round(fill.avgPrice * (1 + Number(proj.sell_target_pct) / 100) * 10000) / 10000,
            })
            .eq('id', o.pocket_id);
        } else {
          await admin.from('pockets').update({ status: 'sold' }).eq('id', o.pocket_id);
        }
      }
      await admin.from('auto_orders').update({ status: 'filled' }).eq('id', o.id);
      updated++;
    } catch {
      /* 개별 실패는 무시하고 다음에 재시도 */
    }
  }
  return updated;
}

// ----- Expo 푸시 알림 -----
async function pushNotify(token: string | null | undefined, title: string, body: string) {
  if (!token) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default' }),
    });
  } catch {
    /* 푸시 실패는 무시 */
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  const krxOpen = isMarketOpen();
  const usOpen = isUsRegularOpen();
  const usDaytime = isUsDaytimeOpen(); // 미국 주간거래(블루오션) 시간대

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // 0) 기간제 AUTO 등급 만료 처리 — 만료된 회원은 diary 로 강등 (자동매매 차단)
  await admin
    .from('profiles')
    .update({ tier: 'diary', tier_expires_at: null })
    .eq('tier', 'auto')
    .lt('tier_expires_at', new Date().toISOString());

  // 0.5) 미체결로 남은 자동주문을 실제 체결단가로 자동 동기화 (장 시간과 무관하게 매 실행)
  const reconciled = await reconcilePendingFills(admin);

  // 국내(KST 09:00~15:30)·미국 정규장(ET 09:30~16:00)·미국 주간거래(KST 10:00~22:30) 중 하나라도 열려 있어야 신호처리
  if (!force && !krxOpen && !usOpen && !usDaytime) return json({ skipped: 'market-closed', reconciled });

  // 1) 자동매매 대상 프로젝트 (KRX·US, 진행중, 추적 ON)
  const { data: projects, error: pErr } = await admin
    .from('projects')
    .select('id,user_id,symbol,name,sell_target_pct,market')
    .eq('auto_trade_enabled', true)
    .eq('is_active', true)
    .is('closed_at', null)
    .in('market', ['KRX', 'US']);
  if (pErr) return json({ error: pErr.message }, 500);
  if (!projects?.length) return json({ processed: 0, note: 'no projects' });

  // 2) AUTO 등급 회원 + KIS 계좌만
  const userIds = [...new Set(projects.map((p) => p.user_id))];
  const [{ data: profiles }, { data: accounts }] = await Promise.all([
    admin.from('profiles').select('id,tier,tier_expires_at,expo_push_token').in('id', userIds),
    admin.from('broker_accounts').select('*').in('user_id', userIds),
  ]);
  const autoUsers = new Map(
    (profiles ?? [])
      .filter(
        (p) =>
          p.tier === 'auto' &&
          // 기간제 인증: 만료 시각이 지났으면 제외 (강등 쿼리가 놓친 경우 이중 방어)
          (!p.tier_expires_at || new Date(p.tier_expires_at).getTime() > Date.now())
      )
      .map((p) => [p.id, p])
  );
  const accByUser = new Map((accounts ?? []).map((a) => [a.user_id, a as BrokerAccount]));

  const targets = (projects as ProjectRow[]).filter(
    (p) => autoUsers.has(p.user_id) && accByUser.has(p.user_id)
  );
  if (!targets.length) return json({ processed: 0, note: 'no auto-tier users with broker account' });

  // 3) 포켓/체결/최근 주문(중복 방지: 같은 포켓+방향 10분 내 재주문 금지)
  const projIds = targets.map((p) => p.id);
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [{ data: pockets }, { data: trades }, { data: recentOrders }] = await Promise.all([
    admin.from('pockets').select('id,project_id,idx,buy_target_price,sell_target_price,budget,status').in('project_id', projIds),
    admin.from('trades').select('pocket_id,side,quantity').in('project_id', projIds),
    admin.from('auto_orders').select('pocket_id,side').gte('created_at', since),
  ]);
  const pocketsByProject = new Map<string, PocketRow[]>();
  (pockets as PocketRow[] | null)?.forEach((k) => {
    const arr = pocketsByProject.get(k.project_id) ?? [];
    arr.push(k);
    pocketsByProject.set(k.project_id, arr);
  });
  const openQtyByPocket = new Map<string, number>();
  (trades ?? []).forEach((t: { pocket_id: string | null; side: string; quantity: number }) => {
    if (!t.pocket_id) return;
    const cur = openQtyByPocket.get(t.pocket_id) ?? 0;
    openQtyByPocket.set(t.pocket_id, cur + (t.side === 'buy' ? 1 : -1) * Number(t.quantity));
  });
  const recentKeys = new Set((recentOrders ?? []).map((o: { pocket_id: string; side: string }) => `${o.pocket_id}:${o.side}`));

  // 4) 프로젝트별 처리 (심볼+계좌 단위 시세 캐시)
  const priceCache = new Map<string, number>();
  const usExchCache = new Map<string, string>();
  const results: Array<Record<string, unknown>> = [];

  for (const proj of targets) {
    const isUs = proj.market === 'US';
    const acc = accByUser.get(proj.user_id)!;
    // 미국 주간거래는 실전 계좌만. 정규장 아니고 주간거래 시간대 + 실전이면 주간거래로 주문.
    const useDaytime = isUs && !acc.is_virtual && !usOpen && usDaytime;
    // 해당 시장이 열려 있을 때만 처리 (force 면 무시)
    if (!force && (isUs ? !usOpen && !useDaytime : !krxOpen)) continue;

    const push = autoUsers.get(proj.user_id)?.expo_push_token as string | null | undefined;
    let token: string;
    let price: number;
    let usExch = 'NAS';
    try {
      token = await getToken(admin, acc);
      const cacheKey = `${acc.is_virtual ? 'v' : 'r'}:${proj.symbol}`;
      if (priceCache.has(cacheKey)) {
        price = priceCache.get(cacheKey)!;
        if (isUs) usExch = usExchCache.get(cacheKey) ?? 'NAS';
      } else if (isUs) {
        const r = await getUsPrice(acc, token, proj.symbol);
        price = r.price;
        usExch = r.exch;
        priceCache.set(cacheKey, price);
        usExchCache.set(cacheKey, r.exch);
      } else {
        price = await getPrice(acc, token, proj.symbol);
        priceCache.set(cacheKey, price);
      }
    } catch (e) {
      results.push({ project: proj.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    for (const k of pocketsByProject.get(proj.id) ?? []) {
      // 신호 판정
      let side: 'buy' | 'sell' | null = null;
      let limitPrice = 0;
      if (k.status === 'waiting' && price <= Number(k.buy_target_price)) {
        side = 'buy';
        // 현재가가 목표매수가보다 낮으면 현재가로 지정가 주문 (더 싸게 체결)
        limitPrice = Math.min(Number(k.buy_target_price), price);
      } else if (
        k.status === 'bought' &&
        k.sell_target_price != null &&
        price >= Number(k.sell_target_price)
      ) {
        side = 'sell';
        // 현재가가 목표매도가보다 높으면 현재가로 지정가 주문 (더 비싸게 체결)
        limitPrice = Math.max(Number(k.sell_target_price), price);
      }
      if (!side) continue;
      if (recentKeys.has(`${k.id}:${side}`)) continue; // 10분 내 이미 시도함

      // 수량 계산
      const qty =
        side === 'buy'
          ? Math.floor(Number(k.budget ?? 0) / limitPrice)
          : Math.floor(openQtyByPocket.get(k.id) ?? 0);
      // 배분 예산으로 1주도 못 사는 포켓(매수 수량 0)은 조용히 건너뛴다 (실패 기록·알람 반복 방지)
      if (side === 'buy' && qty <= 0) continue;
      const label = side === 'buy' ? '매수' : '매도';

      try {
        if (qty <= 0) {
          throw new Error(side === 'buy' ? '배분 예산이 부족해 1주도 살 수 없어요.' : '보유 수량이 없어요.');
        }
        const order = isUs
          ? await placeUsOrder(acc, token, side, proj.symbol, usExch, qty, limitPrice, useDaytime)
          : await placeOrder(acc, token, side, proj.symbol, qty, limitPrice);

        await admin.from('auto_orders').insert({
          user_id: proj.user_id,
          project_id: proj.id,
          pocket_id: k.id,
          side,
          symbol: proj.symbol,
          order_price: limitPrice,
          quantity: qty,
          status: 'sent',
          kis_order_no: order.orderNo,
        });

        // 실제 체결 여부·단가 확인 (미체결이면 지정가 기록 + '주문완료' 상태)
        let fillPrice = limitPrice;
        let fillQty = qty;
        let filledNow = false;
        await new Promise((r) => setTimeout(r, 2500));
        const fill = await getOrderFill(acc, token, proj.market, order.orderNo, proj.symbol);
        if (fill && fill.filledQty > 0 && fill.avgPrice > 0) {
          filledNow = true;
          fillPrice = fill.avgPrice;
          fillQty = fill.filledQty;
        }

        // 매수는 주문 시점 기록(보유 표시). 매도는 '체결'되어야 기록(실현손익은 체결 시점).
        // 미체결 매도(주문완료)는 기록하지 않고, reconcilePendingFills 가 체결 확인 시 생성.
        if (side === 'buy' || filledNow) {
          await admin.from('trades').insert({
            user_id: proj.user_id,
            project_id: proj.id,
            pocket_id: k.id,
            side,
            price: fillPrice,
            quantity: fillQty,
            executed_at: new Date().toISOString(),
            note: `자동주문·서버(KIS ${order.orderNo || '-'})`,
          });
        }
        if (side === 'buy') {
          const sellTarget =
            Math.round(fillPrice * (1 + Number(proj.sell_target_pct) / 100) * 10000) / 10000;
          await admin
            .from('pockets')
            .update({ status: filledNow ? 'bought' : 'buy_ordered', sell_target_price: sellTarget })
            .eq('id', k.id);
          openQtyByPocket.set(k.id, (openQtyByPocket.get(k.id) ?? 0) + fillQty);
        } else {
          await admin.from('pockets').update({ status: filledNow ? 'sold' : 'sell_ordered' }).eq('id', k.id);
          openQtyByPocket.set(k.id, 0);
        }

        await pushNotify(
          push,
          `🤖 자동 ${label} 주문 완료 · ${proj.symbol}`,
          `${proj.name} · 포켓 ${k.idx + 1} · ${fillQty}주 @ ${isUs ? '$' : '₩'}${fillPrice.toLocaleString()} (주문번호 ${order.orderNo || '-'})`
        );
        results.push({ project: proj.id, pocket: k.idx + 1, side, qty: fillQty, price: fillPrice, orderNo: order.orderNo });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await admin.from('auto_orders').insert({
          user_id: proj.user_id,
          project_id: proj.id,
          pocket_id: k.id,
          side,
          symbol: proj.symbol,
          order_price: limitPrice,
          quantity: 0,
          status: 'failed',
          error_message: msg,
        });
        await pushNotify(
          push,
          `⚠️ 자동 ${label} 주문 실패 · ${proj.symbol}`,
          `${proj.name} · 포켓 ${k.idx + 1} · ${msg}`
        );
        results.push({ project: proj.id, pocket: k.idx + 1, side, error: msg });
      }
      recentKeys.add(`${k.id}:${side}`);
    }
  }

  return json({ processed: targets.length, reconciled, currentPrices: Object.fromEntries(priceCache), results });
});
