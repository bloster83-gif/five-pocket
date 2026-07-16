// =====================================================================
// 24시간 무인 자동매매 러너 (Supabase Edge Function)
//
// 앱이 꺼져 있어도 서버가 대신 자동매매를 돌립니다.
// pg_cron 이 1분마다 이 함수를 호출하면:
//   1) AUTO 등급 회원의 자동매매 ON 프로젝트(KRX)를 모두 조회
//   2) 한국투자증권(KIS) 현재가 조회
//   3) 포켓 신호 판정 (waiting & 현재가<=매수목표 → 매수 / bought & 현재가>=매도목표 → 매도)
//   4) KIS 지정가 주문 → auto_orders/trades 기록 + 포켓 상태 갱신
//   5) Expo 푸시 알림 (profiles.expo_push_token 이 있으면)
//
// 장 운영시간(평일 09:00~15:30 KST) 외에는 아무 것도 하지 않습니다. (?force=1 로 강제 실행)
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
const PRICE_TR = 'FHKST01010100'; // 주식현재가 시세

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

// ----- KIS 국내주식 현금 지정가 주문 -----
async function placeOrder(
  acc: BrokerAccount,
  token: string,
  side: 'buy' | 'sell',
  symbol: string,
  qty: number,
  price: number
): Promise<{ orderNo: string; message: string }> {
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
    body: JSON.stringify({
      CANO: acc.account_no,
      ACNT_PRDT_CD: acc.account_product_code,
      PDNO: toKisSymbol(symbol),
      ORD_DVSN: '00', // 지정가
      ORD_QTY: String(Math.floor(qty)),
      ORD_UNPR: String(Math.round(price)),
    }),
  });
  const json = await res.json();
  if (!res.ok || json.rt_cd !== '0') {
    throw new Error(json.msg1 ?? `주문 실패 (HTTP ${res.status})`);
  }
  return { orderNo: json.output?.ODNO ?? '', message: json.msg1 ?? '주문 전송 완료' };
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

  if (!force && !isMarketOpen()) return json({ skipped: 'market-closed' });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // 1) 자동매매 대상 프로젝트 (KRX, 진행중, 추적 ON)
  const { data: projects, error: pErr } = await admin
    .from('projects')
    .select('id,user_id,symbol,name,sell_target_pct')
    .eq('auto_trade_enabled', true)
    .eq('is_active', true)
    .is('closed_at', null)
    .eq('market', 'KRX');
  if (pErr) return json({ error: pErr.message }, 500);
  if (!projects?.length) return json({ processed: 0, note: 'no projects' });

  // 2) AUTO 등급 회원 + KIS 계좌만
  const userIds = [...new Set(projects.map((p) => p.user_id))];
  const [{ data: profiles }, { data: accounts }] = await Promise.all([
    admin.from('profiles').select('id,tier,expo_push_token').in('id', userIds),
    admin.from('broker_accounts').select('*').in('user_id', userIds),
  ]);
  const autoUsers = new Map(
    (profiles ?? []).filter((p) => p.tier === 'auto').map((p) => [p.id, p])
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
  const results: Array<Record<string, unknown>> = [];

  for (const proj of targets) {
    const acc = accByUser.get(proj.user_id)!;
    const push = autoUsers.get(proj.user_id)?.expo_push_token as string | null | undefined;
    let token: string;
    let price: number;
    try {
      token = await getToken(admin, acc);
      const cacheKey = `${acc.is_virtual ? 'v' : 'r'}:${proj.symbol}`;
      if (priceCache.has(cacheKey)) {
        price = priceCache.get(cacheKey)!;
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
        limitPrice = Number(k.buy_target_price);
      } else if (
        k.status === 'bought' &&
        k.sell_target_price != null &&
        price >= Number(k.sell_target_price)
      ) {
        side = 'sell';
        limitPrice = Number(k.sell_target_price);
      }
      if (!side) continue;
      if (recentKeys.has(`${k.id}:${side}`)) continue; // 10분 내 이미 시도함

      // 수량 계산
      const qty =
        side === 'buy'
          ? Math.floor(Number(k.budget ?? 0) / limitPrice)
          : Math.floor(openQtyByPocket.get(k.id) ?? 0);
      const label = side === 'buy' ? '매수' : '매도';

      try {
        if (qty <= 0) {
          throw new Error(side === 'buy' ? '배분 예산이 부족해 1주도 살 수 없어요.' : '보유 수량이 없어요.');
        }
        const order = await placeOrder(acc, token, side, proj.symbol, qty, limitPrice);

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
        await admin.from('trades').insert({
          user_id: proj.user_id,
          project_id: proj.id,
          pocket_id: k.id,
          side,
          price: limitPrice,
          quantity: qty,
          executed_at: new Date().toISOString(),
          note: `자동주문·서버(KIS ${order.orderNo || '-'})`,
        });
        if (side === 'buy') {
          const sellTarget =
            Math.round(limitPrice * (1 + Number(proj.sell_target_pct) / 100) * 10000) / 10000;
          await admin
            .from('pockets')
            .update({ status: 'bought', sell_target_price: sellTarget })
            .eq('id', k.id);
          openQtyByPocket.set(k.id, (openQtyByPocket.get(k.id) ?? 0) + qty);
        } else {
          await admin.from('pockets').update({ status: 'sold' }).eq('id', k.id);
          openQtyByPocket.set(k.id, 0);
        }

        await pushNotify(
          push,
          `🤖 자동 ${label} 주문 완료 · ${proj.symbol}`,
          `${proj.name} · 포켓 ${k.idx + 1} · ${qty}주 @ ${limitPrice.toLocaleString()} (주문번호 ${order.orderNo || '-'})`
        );
        results.push({ project: proj.id, pocket: k.idx + 1, side, qty, price: limitPrice, orderNo: order.orderNo });
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

  return json({ processed: targets.length, currentPrices: Object.fromEntries(priceCache), results });
});
