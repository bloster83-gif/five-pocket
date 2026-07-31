// =====================================================================
// 미체결(주문완료) 주문 조회·취소
//
//  체결이 확인된 경우에만 trades 를 기록하므로, '매수 주문완료' 포켓은
//  보유수량·평균매수가가 없다. 대신 auto_orders(status='sent') 에 남은
//  주문가·수량을 읽어 카드에 보여주고, 원하면 취소 후 다른 가격으로
//  다시 주문할 수 있게 한다.
// =====================================================================

import { supabase } from '@/lib/supabase';
import { alignToKrxTick, sellTargetFromFill } from '@/domain/pockets';
import { cancelOrder, getOrderFill } from '@/services/broker/kis';
import type { AutoOrder, BrokerAccount, Project } from '@/types/db';

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

/**
 * 미체결(status='sent') 주문의 실제 체결 여부를 KIS 에 물어 반영한다.
 *  - 체결됨 → trades 기록(중복 방지) + 포켓 bought/sold + auto_orders filled
 *  - 미체결 → 그대로 둠
 * 반환값 true = 뭔가 바뀌었으니 화면을 다시 로드해야 함.
 *
 * 주문완료 상태가 오래 남아 있지 않도록 화면에서 짧은 주기로 호출한다.
 */
export async function reconcilePendingOrders(
  account: BrokerAccount | null,
  projectId?: string
): Promise<boolean> {
  if (!account) return false;
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
    let fill: { avgPrice: number; filledQty: number } | null = null;
    try {
      fill = await getOrderFill(account, p.market === 'US' ? 'US' : 'KRX', o.kis_order_no!, p.symbol);
    } catch {
      continue; // 조회 실패 → 다음 주기에 다시 시도
    }
    if (!fill || fill.avgPrice <= 0 || fill.filledQty <= 0) continue;

    // 같은 주문번호의 체결 기록이 이미 있으면 실제 체결가·수량으로 갱신, 없으면 새로 기록
    const { data: existing } = await supabase
      .from('trades')
      .select('id')
      .eq('project_id', o.project_id!)
      .ilike('note', `%${o.kis_order_no}%`)
      .limit(1);
    if (existing && existing.length > 0) {
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
        note: `자동주문(KIS ${o.kis_order_no}) ${o.side === 'sell' ? '매도' : '매수'}`,
      });
    }

    if (o.pocket_id) {
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
      }
    }
    await supabase.from('auto_orders').update({ status: 'filled' }).eq('id', o.id);
    changed = true;
  }
  return changed;
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
    await cancelOrder(account, market, order.kis_order_no, order.symbol, Number(order.quantity));
  }
  await supabase
    .from('auto_orders')
    .update({ status: 'failed', error_message: '사용자 취소 (주문가 변경)' })
    .eq('id', order.id);
  if (order.pocket_id) {
    await supabase
      .from('pockets')
      .update(order.side === 'buy' ? { status: 'waiting', sell_target_price: null } : { status: 'bought' })
      .eq('id', order.pocket_id);
  }
}
