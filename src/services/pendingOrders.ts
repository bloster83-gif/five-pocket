// =====================================================================
// 미체결(주문완료) 주문 조회·취소
//
//  체결이 확인된 경우에만 trades 를 기록하므로, '매수 주문완료' 포켓은
//  보유수량·평균매수가가 없다. 대신 auto_orders(status='sent') 에 남은
//  주문가·수량을 읽어 카드에 보여주고, 원하면 취소 후 다른 가격으로
//  다시 주문할 수 있게 한다.
// =====================================================================

import { supabase } from '@/lib/supabase';
import { alignToKrxTick, computePnL, sellTargetFromFill } from '@/domain/pockets';
import { cancelOrder, getDomesticBalance, getOrderFill, getOverseasBalance, toKisSymbol } from '@/services/broker/kis';
import type { AutoOrder, BrokerAccount, Project, Trade } from '@/types/db';

/**
 * 잔고로 체결을 확인하는 보조 수단.
 *
 * 체결조회(inquire-daily-ccld)는 SOR/NXT 로 체결된 주문처럼 KIS 내부 표기가 다르면
 * 0건을 돌려주는 경우가 있다. 그럴 때도 '잔고에 실제로 들어와 있는 수량'은 정확하므로,
 *   계좌 보유수량 >= (앱에 이미 기록된 보유수량 + 이 주문 수량)
 * 이면 이 주문이 체결된 것으로 판단한다. (이미 기록된 만큼을 빼므로 중복 인정되지 않는다)
 *
 * 매도 주문은 이 방식으로 판단하면 위험하므로(수량이 줄어든 이유가 여러 가지) 매수만 다룬다.
 */
/**
 * 미체결 자동주문을 포켓별로 로드한다 (포켓당 가장 최근 1건).
 * auto_orders 테이블이 아직 없거나 조회 실패면 빈 객체 (화면은 그대로 동작).
 */
export async function loadPendingOrders(projectId?: string): Promise<Record<string, AutoOrder>> {
  let query = supabase.from('auto_orders').select('*').eq('status', 'sent').order('created_at');
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error || !data) return {};
  const m: Record<string, AutoOrder> = {};
  for (const o of data as AutoOrder[]) {
    if (o.pocket_id) m[o.pocket_id] = o; // created_at 오름차순 → 마지막(=최신)이 남는다
  }
  return m;
}

export interface HoldingCheck {
  heldQty: number; // 증권사 계좌 실제 보유수량
  heldAvg: number; // 계좌 평균단가
  recordedQty: number; // 앱에 기록된 순보유수량 (같은 종목, 모든 프로젝트 합산)
  ok: boolean; // 잔고 조회 성공 여부 (실패면 검증을 건너뛴다)
}

/**
 * 이 종목의 '증권사 실제 보유수량' 과 '앱에 기록된 보유수량' 을 함께 조회한다.
 * 체결 기록의 진위를 판단하는 기준으로 쓴다 — 계좌 잔고가 언제나 사실이다.
 */
export async function checkHolding(
  account: BrokerAccount,
  symbol: string,
  market: string
): Promise<HoldingCheck> {
  const base: HoldingCheck = { heldQty: 0, heldAvg: 0, recordedQty: 0, ok: false };
  const want = toKisSymbol(symbol).toUpperCase();
  try {
    const bal = market === 'US' ? await getOverseasBalance(account) : await getDomesticBalance(account);
    const h = bal.holdings.find((x) => toKisSymbol(x.symbol).toUpperCase() === want);
    base.heldQty = h ? Math.floor(h.quantity) : 0;
    base.heldAvg = h ? h.avgPrice : 0;
    base.ok = true;
  } catch {
    return base; // 잔고 조회 실패 → 검증 불가 (호출측에서 통과시킨다)
  }
  const { data: projRows } = await supabase.from('projects').select('id').eq('symbol', symbol);
  const projIds = ((projRows ?? []) as { id: string }[]).map((p) => p.id);
  if (projIds.length > 0) {
    const { data: tradeRows } = await supabase.from('trades').select('*').in('project_id', projIds);
    base.recordedQty = Math.floor(computePnL((tradeRows ?? []) as Trade[], null).totalQtyOpen);
  }
  return base;
}

/**
 * 잔고로 체결을 확인하는 보조 수단.
 *
 * 체결조회는 SOR/NXT 체결처럼 KIS 내부 표기가 다르면 0건을 돌려주는 경우가 있다.
 * 그럴 때도 '계좌에 실제로 남아 있는 수량'은 정확하므로 그것으로 판단한다.
 *
 *  매수: 계좌 보유수량 >= 앱 기록 + 주문수량   → 이 매수가 들어와 있다
 *  매도: 계좌 보유수량 <= 앱 기록 - 주문수량   → 이 매도가 빠져나갔다
 *
 * 어느 쪽도 '이미 기록된 수량'을 기준으로 계산하므로 같은 체결이 두 번 인정되지 않는다.
 */
function confirmByBalance(
  order: AutoOrder,
  chk: HoldingCheck
): { avgPrice: number; filledQty: number; orderQty: number; estimated: true } | null {
  if (!chk.ok) return null;
  const orderQty = Math.floor(Number(order.quantity));
  if (orderQty <= 0) return null;
  const limit = Number(order.order_price);
  if (limit <= 0) return null;

  if (order.side === 'buy') {
    if (chk.heldQty <= 0) return null;
    if (chk.heldQty < chk.recordedQty + orderQty) return null;
    // 체결가는 이 주문의 지정가를 쓴다.
    // 계좌 평단(heldAvg)은 이전 매수들이 섞인 혼합값이라 개별 주문의 체결가가 될 수 없다.
    // (실제로 $12.35 에 체결된 주문이 계좌 평단 $10.87 로 잘못 기록됐다)
    return { avgPrice: limit, filledQty: orderQty, orderQty, estimated: true };
  }

  // 매도: 앱에 기록된 보유분이 계좌에서 그만큼 빠져나갔으면 체결된 것
  if (chk.recordedQty <= 0) return null;
  if (chk.heldQty > chk.recordedQty - orderQty) return null;
  // 지정가 매도는 지정가 이상으로 체결 — 정확한 체결가는 알 수 없으므로 지정가로 기록(매매일지에서 수정 가능)
  return { avgPrice: limit, filledQty: orderQty, orderQty, estimated: true };
}

/**
 * 주문을 넣은 직후 확인한 체결을 auto_orders 에 반영한다.
 *  · 전량 체결 → status='filled' (더 추적하지 않는다)
 *  · 부분체결   → status='sent' 유지 + 체결 누계만 기록해, 남은 수량을 계속 추적한다
 * 누계를 남기지 않으면 나중에 동기화가 같은 체결을 또 세서 잔고 검증에 막힌다.
 */
export async function markOrderProgress(orderId: string, filledQty: number, fullyFilled: boolean): Promise<void> {
  const { error } = await supabase
    .from('auto_orders')
    .update({ filled_qty: filledQty, status: fullyFilled ? 'filled' : 'sent' })
    .eq('id', orderId);
  if (error && isMissingColumn(error)) {
    hasFilledQtyCol = false;
    // 컬럼이 없는 DB(마이그레이션 20260903a 미실행) — 상태만 예전처럼 처리
    if (fullyFilled) await supabase.from('auto_orders').update({ status: 'filled' }).eq('id', orderId);
  }
}

/**
 * 체결 누계를 키우며 주문을 '선점'한다 (동시 실행 중 한쪽만 이긴다).
 *
 * filled_qty 컬럼(마이그레이션 20260903a)이 없는 DB 에서는 예전 방식으로 물러난다 —
 * 부분체결을 구분하지 못하고 한 번만 기록하지만, 앱이 깨지지는 않는다.
 * 반환값 true = 내가 선점했으니 기록해도 된다.
 */
let hasFilledQtyCol = true;

async function claimOrder(o: AutoOrder, filledQty: number, fullyFilled: boolean): Promise<boolean> {
  if (hasFilledQtyCol) {
    const { data, error } = await supabase
      .from('auto_orders')
      .update({ filled_qty: filledQty, status: fullyFilled ? 'filled' : 'sent' })
      .eq('id', o.id)
      .eq('status', 'sent')
      .lt('filled_qty', filledQty)
      .select('id');
    if (!error) return !!data && data.length > 0;
    if (!isMissingColumn(error)) return false;
    hasFilledQtyCol = false; // 컬럼 없음 → 아래 예전 방식으로
  }
  const { data } = await supabase
    .from('auto_orders')
    .update({ status: 'filled' })
    .eq('id', o.id)
    .eq('status', 'sent')
    .select('id');
  return !!data && data.length > 0;
}

/** filled_qty 컬럼이 아직 없는 DB 인지 (마이그레이션 20260903a 미실행) */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return /42703|filled_qty|column .* does not exist|schema cache|PGRST204/i.test(
    `${error.code ?? ''} ${error.message ?? ''}`
  );
}

/**
 * 미체결(status='sent') 주문의 실제 체결 여부를 KIS 에 물어 반영한다.
 *  - 체결됨 → trades 기록(중복 방지) + 포켓 bought/sold + auto_orders filled
 *  - 미체결 → 그대로 둠
 * 반환값 true = 뭔가 바뀌었으니 화면을 다시 로드해야 함.
 *
 * 주문완료 상태가 오래 남아 있지 않도록 화면에서 짧은 주기로 호출한다.
 */
let inFlight: Promise<boolean> | null = null;

export async function reconcilePendingOrders(
  account: BrokerAccount | null,
  projectId?: string
): Promise<boolean> {
  if (!account) return false;
  // 여러 화면이 동시에 호출해도 실제 실행은 하나만 — 나머지는 그 결과를 함께 받는다.
  if (inFlight) return inFlight;
  inFlight = reconcileOnce(account, projectId).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function reconcileOnce(account: BrokerAccount, projectId?: string): Promise<boolean> {
  const orders = Object.values(await loadPendingOrders(projectId)).filter((o) => o.kis_order_no);
  if (orders.length === 0) return false;

  // 주문에 걸린 프로젝트 정보(시장·매도목표%)를 한 번에 로드
  const projectIds = Array.from(new Set(orders.map((o) => o.project_id).filter(Boolean))) as string[];
  if (projectIds.length === 0) return false;
  const { data: projRows } = await supabase
    .from('projects')
    .select('id,market,symbol,sell_target_pct')
    .in('id', projectIds);
  const projMap: Record<string, Pick<Project, 'id' | 'market' | 'symbol' | 'sell_target_pct'>> = {};
  for (const p of (projRows ?? []) as any[]) projMap[p.id] = p;

  let changed = false;
  for (const o of orders) {
    const p = o.project_id ? projMap[o.project_id] : null;
    if (!p) continue;
    let fill: { avgPrice: number; filledQty: number; orderQty?: number; estimated?: boolean } | null = null;
    try {
      fill = await getOrderFill(account, p.market === 'US' ? 'US' : 'KRX', o.kis_order_no!, p.symbol);
    } catch {
      /* 체결조회 실패 → 아래 잔고 확인으로 폴백 */
    }

    // 계좌 잔고를 함께 조회한다 — 체결조회의 폴백이자, 기록 전 검증 기준이 된다.
    const chk = await checkHolding(account, p.symbol, p.market);

    // 체결조회가 못 잡으면(SOR/NXT 체결 등) 잔고로 재확인
    if (!fill || fill.avgPrice <= 0 || fill.filledQty <= 0) {
      fill = confirmByBalance(o, chk);
    }
    if (!fill || fill.avgPrice <= 0 || fill.filledQty <= 0) continue;

    // ── 부분체결 판정 ────────────────────────────────────────────────
    // 15주를 주문했는데 5주만 체결되는 일이 있다. 체결분만 반영하고
    // 남은 수량은 주문을 'sent' 로 남겨 계속 추적한다(카드에 표시되고 취소도 된다).
    const orderQty = Math.floor(Number(fill.orderQty ?? o.quantity)) || Math.floor(Number(o.quantity));
    const prevFilled = Math.floor(Number(o.filled_qty ?? 0));
    const delta = fill.filledQty - prevFilled; // 이번에 새로 체결된 수량
    if (delta <= 0) continue; // 이미 반영한 체결
    const fullyFilled = orderQty > 0 ? fill.filledQty >= orderQty : true;

    // ── 기록 전 잔고 검증 ────────────────────────────────────────────
    // 계좌 잔고가 언제나 사실이다. 이 체결을 기록했을 때 앱의 보유수량이
    // 실제 계좌 보유수량을 넘어서면 = 이미 기록된 체결을 또 기록하려는 것이므로 막는다.
    // (잔고 조회에 실패했으면 검증하지 않고 통과 — 조회 장애로 정상 체결을 놓치면 안 되니까)
    // 이번에 '새로 늘어나는 만큼(delta)'으로 비교해야 부분체결이 반복돼도 어긋나지 않는다.
    const wouldOverRecord =
      chk.ok &&
      (o.side === 'buy' ? chk.recordedQty + delta > chk.heldQty : chk.recordedQty - delta < chk.heldQty);
    if (wouldOverRecord) {
      // 주문은 종결 처리해 매 주기마다 다시 조회하지 않게 한다.
      await supabase
        .from('auto_orders')
        .update({
          status: 'filled',
          error_message: `잔고 검증으로 중복 기록 차단 (계좌 ${chk.heldQty}주 / 기록 ${chk.recordedQty}주 / 이번 ${o.side === 'buy' ? '+' : '-'}${delta}주)`,
        })
        .eq('id', o.id)
        .eq('status', 'sent');
      continue;
    }

    // ── 주문을 '선점'한다 (중복 기록 방지) ──────────────────────────────
    // 이 동기화는 여러 화면(목록·포켓탭·상세)과 서버 러너에서 동시에 돌 수 있다.
    // '기록이 있나 읽고 → 없으면 쓴다'로는 두 실행이 동시에 "없다"고 판단해
    // 같은 체결을 두 번 기록해버린다(실제로 25주가 50주로 중복됨).
    // 체결 누계를 키운 쪽만 이기는 단일 UPDATE 는 DB 에서 원자적이라,
    // 갱신된 행이 0건이면 이미 다른 실행이 처리한 것이므로 건너뛴다.
    const claimed = await claimOrder(o, fill.filledQty, fullyFilled);
    if (!claimed) continue; // 다른 실행이 이미 선점함

    // 같은 주문번호의 체결 기록이 이미 있으면 실제 체결가·수량으로 갱신, 없으면 새로 기록
    const { data: existing } = await supabase
      .from('trades')
      .select('id')
      .eq('project_id', o.project_id!)
      .ilike('note', `%${o.kis_order_no}%`)
      .limit(1);
    if (existing && existing.length > 0) {
      // 부분체결이 이어지는 동안에는 같은 기록의 수량을 '누계'로 키운다
      await supabase
        .from('trades')
        .update({ price: fill.avgPrice, quantity: fill.filledQty })
        .eq('id', existing[0].id);
    } else {
      await supabase.from('trades').insert({
        user_id: o.user_id,
        project_id: o.project_id,
        pocket_id: o.pocket_id,
        side: o.side,
        price: fill.avgPrice,
        quantity: fill.filledQty,
        executed_at: new Date().toISOString(),
        note:
          `자동주문(KIS ${o.kis_order_no}) ${o.side === 'sell' ? '매도' : '매수'}` +
          // 잔고로 확인한 경우 체결가는 지정가 기준의 추정치 — 매매일지에서 확인·수정하도록 표시
          (fill.estimated ? ' · 체결가 추정(지정가)' : '') +
          (fullyFilled ? '' : ` · 부분체결 ${fill.filledQty}/${orderQty}주`),
      });
    }

    // 포켓 상태는 전량 체결된 뒤에 바꾼다. 부분체결 동안 '주문완료'로 두어야
    // 카드에 남은 수량이 보이고 취소도 할 수 있다.
    if (o.pocket_id && fullyFilled) {
      if (o.side === 'buy') {
        const rawSell = sellTargetFromFill(fill.avgPrice, Number(p.sell_target_pct));
        await supabase
          .from('pockets')
          .update({
            status: 'bought',
            sell_target_price: p.market === 'KRX' ? alignToKrxTick(rawSell, 'sell') : rawSell,
          })
          .eq('id', o.pocket_id);
      } else {
        await supabase.from('pockets').update({ status: 'sold' }).eq('id', o.pocket_id);
        // '매도 후 종료'를 예약해 둔 프로젝트라면, 남은 매도가 전부 끝났는지 보고 자동 종료
        await maybeAutoCloseProject(o.project_id!);
      }
    }
    changed = true;
  }
  return changed;
}

/**
 * '매도 후 종료'를 예약한 프로젝트(close_after_sell=true)를 마무리한다.
 * 보유·주문 중인 포켓이 하나도 남지 않았을 때만 실제로 종료한다.
 *
 * 마이그레이션(20260813a) 미실행이면 close_after_sell 이 없으므로 아무것도 하지 않는다.
 */
export async function maybeAutoCloseProject(projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const { data: proj } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle();
  const p = proj as (Project & { close_after_sell?: boolean }) | null;
  if (!p || p.closed_at || !p.close_after_sell) return false;

  const { data: pocketRows } = await supabase.from('pockets').select('status').eq('project_id', projectId);
  const busy = ((pocketRows ?? []) as { status: string }[]).some(
    (k) => k.status === 'bought' || k.status === 'buy_ordered' || k.status === 'sell_ordered'
  );
  if (busy) return false; // 아직 정리 안 된 포켓이 남아 있다

  await supabase
    .from('projects')
    .update({ closed_at: new Date().toISOString(), is_active: false, close_after_sell: false })
    .eq('id', projectId);
  return true;
}

export interface HoldingMismatch {
  symbol: string;
  name: string;
  recordedQty: number; // 앱 기록
  heldQty: number; // 증권사 계좌
}

/**
 * 앱에 기록된 보유수량과 증권사 계좌 보유수량을 종목별로 대조한다.
 * 어긋나면 체결이 중복 기록됐거나(앱이 많음), 앱 밖에서 매매했거나(계좌가 많음) 둘 중 하나다.
 * 화면에 경고로 띄워 사용자가 바로 알아챌 수 있게 한다.
 */
export async function findHoldingMismatches(account: BrokerAccount | null): Promise<HoldingMismatch[]> {
  if (!account) return [];
  const { data: projRows } = await supabase.from('projects').select('id,name,symbol,market').is('closed_at', null);
  const projects = (projRows ?? []) as Pick<Project, 'id' | 'name' | 'symbol' | 'market'>[];
  if (projects.length === 0) return [];

  const { data: tradeRows } = await supabase.from('trades').select('*');
  const trades = (tradeRows ?? []) as Trade[];

  // 종목별로 묶어 (같은 종목의 여러 프로젝트를 합산)
  const bySymbol = new Map<string, { name: string; market: string; projIds: string[] }>();
  for (const p of projects) {
    const e = bySymbol.get(p.symbol) ?? { name: p.name, market: p.market, projIds: [] };
    e.projIds.push(p.id);
    bySymbol.set(p.symbol, e);
  }

  // 잔고는 시장별로 한 번씩만 조회
  const balCache = new Map<string, Map<string, number>>();
  const loadBal = async (market: string): Promise<Map<string, number> | null> => {
    if (balCache.has(market)) return balCache.get(market)!;
    try {
      const bal = market === 'US' ? await getOverseasBalance(account) : await getDomesticBalance(account);
      const m = new Map<string, number>();
      bal.holdings.forEach((h) => m.set(toKisSymbol(h.symbol).toUpperCase(), Math.floor(h.quantity)));
      balCache.set(market, m);
      return m;
    } catch {
      return null;
    }
  };

  const out: HoldingMismatch[] = [];
  for (const [symbol, e] of bySymbol) {
    const recordedQty = Math.floor(
      computePnL(
        trades.filter((t) => t.project_id && e.projIds.includes(t.project_id)),
        null
      ).totalQtyOpen
    );
    const m = await loadBal(e.market);
    if (!m) continue; // 잔고 조회 실패 → 판단 보류
    const heldQty = m.get(toKisSymbol(symbol).toUpperCase()) ?? 0;
    if (recordedQty !== heldQty) out.push({ symbol, name: e.name, recordedQty, heldQty });
  }
  return out;
}

/**
 * 상태가 어긋난 포켓을 바로잡는다.
 * '매수 주문완료'인데 실제 체결(보유수량)이 있으면 = 이미 체결된 것이므로 '보유중'으로 승격.
 * (체결 감지가 늦었거나 서버 러너가 잠깐 멈춘 사이에 생기는 불일치를 화면을 열 때 조용히 정리)
 * 반환값 = 고친 포켓 수.
 */
export async function healBoughtPockets(staleIds: string[]): Promise<number> {
  if (staleIds.length === 0) return 0;
  const { error } = await supabase.from('pockets').update({ status: 'bought' }).in('id', staleIds);
  return error ? 0 : staleIds.length;
}

/**
 * 미체결 주문을 취소하고 포켓을 되돌린다.
 *  - 매수 주문 취소 → 포켓 '대기중'(매도목표가 초기화)
 *  - 매도 주문 취소 → 포켓 '보유중'
 * 증권사 취소가 실패하면 (이미 체결됐을 수 있으므로) 그대로 throw 하고 DB 는 건드리지 않는다.
 */
export async function cancelPendingOrder(
  order: AutoOrder,
  market: string,
  account: BrokerAccount | null
): Promise<void> {
  if (account && order.kis_order_no) {
    // 부분체결이면 아직 남아 있는 수량만 취소한다 (국내는 '잔량 전부' 플래그라 무관, 해외는 수량이 필요)
    const remaining = Math.max(1, Math.floor(Number(order.quantity) - Number(order.filled_qty ?? 0)));
    await cancelOrder(account, market, order.kis_order_no, order.symbol, remaining);
  }
  await supabase
    .from('auto_orders')
    .update({ status: 'failed', error_message: '사용자 취소 (주문가 변경)' })
    .eq('id', order.id);
  if (order.pocket_id) await restorePocketAfterCancel(order);
  // 매도 주문을 취소했다면 '체결되면 종료' 예약도 해제한다 (의도가 바뀐 것)
  if (order.side === 'sell' && order.project_id) {
    await supabase.from('projects').update({ close_after_sell: false }).eq('id', order.project_id);
  }
}

/**
 * 주문을 취소한 뒤 포켓 상태를 되돌린다.
 *
 *  · 매수 취소 — 한 주도 안 샀으면 '대기중'(목표가 초기화).
 *    부분체결로 이미 보유분이 있으면 '보유중'으로 두고 매도 목표가를 평균매수가 기준으로 다시 잡는다.
 *    ('대기중'으로 되돌리면 실제로 들고 있는 주식을 앱이 잊어버린다)
 *  · 매도 취소 — 남은 보유분이 있으므로 '보유중'.
 */
async function restorePocketAfterCancel(order: AutoOrder): Promise<void> {
  if (!order.pocket_id) return;
  if (order.side === 'sell') {
    await supabase.from('pockets').update({ status: 'bought' }).eq('id', order.pocket_id);
    return;
  }

  // 이 포켓에 실제로 남아 있는 보유분 (부분체결분이 기록돼 있다)
  const { data: tradeRows } = await supabase.from('trades').select('*').eq('pocket_id', order.pocket_id);
  const open = computePnL((tradeRows ?? []) as Trade[], null);
  if (open.totalQtyOpen <= 0) {
    await supabase
      .from('pockets')
      .update({ status: 'waiting', sell_target_price: null })
      .eq('id', order.pocket_id);
    return;
  }

  const { data: proj } = await supabase
    .from('projects')
    .select('market,sell_target_pct')
    .eq('id', order.project_id!)
    .maybeSingle();
  const pct = Number((proj as { sell_target_pct?: number } | null)?.sell_target_pct ?? 0);
  const market = (proj as { market?: string } | null)?.market ?? 'US';
  const rawSell = sellTargetFromFill(open.avgOpenPrice, pct);
  await supabase
    .from('pockets')
    .update({
      status: 'bought',
      sell_target_price: market === 'KRX' ? alignToKrxTick(rawSell, 'sell') : rawSell,
    })
    .eq('id', order.pocket_id);
}

/**
 * 증권사에는 손대지 않고 앱 기록만 정리한다.
 *
 * 증권사 앱에서 사용자가 직접 취소했는데 우리 쪽 주문번호로는 취소 API 가 실패하는 경우
 * ('원주문번호가 존재하지 않습니다' 등) 포켓이 영영 '주문완료'에 갇히지 않도록 하는 탈출구.
 * 실제 주문이 살아 있는데 이걸 쓰면 이중 주문이 될 수 있으므로 호출측에서 반드시 확인을 받는다.
 */
export async function releasePendingOrderLocally(order: AutoOrder): Promise<void> {
  await supabase
    .from('auto_orders')
    .update({ status: 'failed', error_message: '증권사에서 직접 취소 (앱 기록만 정리)' })
    .eq('id', order.id);
  if (order.pocket_id) await restorePocketAfterCancel(order);
  if (order.side === 'sell' && order.project_id) {
    await supabase.from('projects').update({ close_after_sell: false }).eq('id', order.project_id);
  }
}
