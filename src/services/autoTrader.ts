// =====================================================================
// 자동매매 엔진 (AUTO 등급 전용)
//
//  - priceTracker 가 매수/매도 포인트 도달 신호를 주면,
//    한국투자증권(KIS) 계좌로 지정가 주문을 자동 전송한다.
//  - Diary 등급은 이 훅이 아무 동작도 하지 않는다 (기존 수동 알림 그대로).
//  - 주문 성공 시: auto_orders 이력 + trades 체결 기록 + 포켓 상태 갱신
//    (지정가 = 목표가이고 현재가가 이미 목표가를 지났으므로 즉시 체결을 가정.
//     실제 체결가와 다를 수 있으니 매매일지에서 수정 가능)
//  - 앱이 켜져 있는 동안(프로젝트 화면에서 추적 중) 동작하는 클라이언트 방식.
// =====================================================================

import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notifyNow } from '@/lib/notifications';
import { alignToKrxTick, estimatedShares, sellTargetFromFill, type PriceSignal } from '@/domain/pockets';
import { computePnL } from '@/domain/pockets';
import { getOrderFill, kisOrderBlocked, placeDomesticOrder, placeOverseasOrder } from '@/services/broker/kis';
import type { BrokerAccount, Project, Trade } from '@/types/db';

export interface AutoTradeEvent {
  at: number;
  kind: 'buy' | 'sell';
  pocketIdx: number;
  ok: boolean;
  message: string;
}

interface UseAutoTraderResult {
  /** usePriceTracker 의 onSignal 로 넘겨주세요 */
  handleSignal: (sig: PriceSignal) => void;
  /** 마지막 자동주문 결과 (화면 표시용) */
  lastEvent: AutoTradeEvent | null;
}

/**
 * 프로젝트 상세 화면에서 사용하는 자동매매 훅.
 * AUTO 등급 + 프로젝트 자동매매 ON + KIS 계좌 연결이 모두 갖춰졌을 때만 주문한다.
 */
export function useAutoTrader(
  project: Project | null,
  trades: Trade[],
  onExecuted?: () => void
): UseAutoTraderResult {
  const { session, tier, profile } = useAuth();
  const [lastEvent, setLastEvent] = useState<AutoTradeEvent | null>(null);

  // 최신 값 참조 (폴링 콜백에서 stale closure 방지)
  const projectRef = useRef(project);
  projectRef.current = project;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const tierRef = useRef(tier);
  tierRef.current = tier;
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // KIS 계좌 캐시: undefined = 아직 안 불러옴, null = 없음
  const accountRef = useRef<BrokerAccount | null | undefined>(undefined);
  // 포켓+방향별 처리중 잠금 (중복 주문 방지)
  const inFlightRef = useRef<Set<string>>(new Set());
  // 포켓+방향별 마지막 실패 사유·시각 — 같은 사유가 계속 나오면 알림·이력을 남기지 않는다.
  // (장 운영시간이 아닐 때처럼 조건이 바뀔 때까지 계속 실패하는 경우 알림이 도배되는 걸 방지)
  const lastFailRef = useRef<Map<string, { msg: string; at: number }>>(new Map());
  const FAIL_MUTE_MS = 30 * 60 * 1000; // 같은 사유는 30분에 한 번만 알림

  const report = useCallback(async (ev: AutoTradeEvent, title: string, bodyMsg: string) => {
    setLastEvent(ev);
    await notifyNow(title, bodyMsg);
  }, []);

  const handleSignal = useCallback(
    (sig: PriceSignal) => {
      void (async () => {
        const proj = projectRef.current;
        const uid = session?.user?.id;
        if (!proj || !uid) return;
        // Diary 등급이거나 자동매매가 꺼진 프로젝트면 아무 것도 하지 않음 (수동 버전 그대로)
        if (tierRef.current !== 'auto' || !proj.auto_trade_enabled) return;
        // AUTO 기간 만료 검사 — 앱을 켜둔 채 만료 시각이 지나도 주문을 차단
        const exp = profileRef.current?.tier_expires_at;
        if (exp && new Date(exp).getTime() <= Date.now()) return;

        // 매수 주문가: 현재가가 목표매수가보다 낮으면 현재가로 지정가 (더 싸게 체결)
        const buyPrice = Math.min(sig.targetPrice, sig.currentPrice);
        // 배분 예산으로 1주도 못 사는 포켓(매수 수량 0)은 자동 매수를 아예 건너뛴다 (실패 알람 반복 방지)
        if (sig.kind === 'buy' && estimatedShares(sig.pocket.budget, buyPrice) <= 0) return;

        const key = `${sig.pocket.id}:${sig.kind}`;
        if (inFlightRef.current.has(key)) return;
        inFlightRef.current.add(key);

        const label = sig.kind === 'buy' ? '매수' : '매도';
        try {
          const blocked = kisOrderBlocked(proj.market);
          if (blocked) throw new Error(blocked);

          // KIS 계좌 로드 (1회 캐시)
          if (accountRef.current === undefined) {
            const { data } = await supabase
              .from('broker_accounts')
              .select('*')
              .eq('user_id', uid)
              .maybeSingle();
            accountRef.current = (data as BrokerAccount) ?? null;
          }
          const account = accountRef.current;
          if (!account) {
            throw new Error('한국투자증권 계좌가 연결되지 않았어요. 계좌 연결 화면에서 설정하세요.');
          }

          // 주문가(지정가): 매수 = min(목표가, 현재가) — 더 싸게 / 매도 = max(목표가, 현재가) — 더 비싸게
          const limitPrice = sig.kind === 'buy' ? buyPrice : Math.max(sig.targetPrice, sig.currentPrice);
          let qty: number;
          if (sig.kind === 'buy') {
            qty = estimatedShares(sig.pocket.budget, limitPrice);
            if (qty <= 0) throw new Error('배분 예산이 없거나 1주 살 금액이 안 돼요. 프로젝트 예산을 확인하세요.');
          } else {
            const pocketTrades = tradesRef.current.filter((t) => t.pocket_id === sig.pocket.id);
            qty = Math.floor(computePnL(pocketTrades, null).totalQtyOpen);
            if (qty <= 0) throw new Error('보유 수량이 없어 매도 주문을 건너뛰었어요.');
          }

          // KIS 주문 전송 (한국=국내주문, 미국=해외주문)
          const orderInput = { side: sig.kind, symbol: proj.symbol, quantity: qty, price: limitPrice };
          const result =
            proj.market === 'US'
              ? await placeOverseasOrder(account, orderInput)
              : await placeDomesticOrder(account, orderInput);

          // 주문 이력 저장
          await supabase.from('auto_orders').insert({
            user_id: uid,
            project_id: proj.id,
            pocket_id: sig.pocket.id,
            side: sig.kind,
            symbol: proj.symbol,
            order_price: limitPrice,
            quantity: qty,
            status: 'sent',
            kis_order_no: result.orderNo,
          });

          // 실제 체결 여부·단가 확인: 잠시 후 체결내역 조회. 미체결이면 지정가로 기록하고 '주문완료' 상태.
          let fillPrice = limitPrice;
          let fillQty = qty;
          let filled = false;
          try {
            await new Promise((r) => setTimeout(r, 2500));
            const fill = await getOrderFill(account, proj.market === 'US' ? 'US' : 'KRX', result.orderNo, proj.symbol);
            if (fill && fill.filledQty > 0 && fill.avgPrice > 0) {
              filled = true;
              fillPrice = fill.avgPrice;
              fillQty = fill.filledQty;
            }
          } catch {
            /* 조회 실패 → 미체결로 간주(주문완료), 지정가 기록 */
          }

          // 체결 기록 + 포켓 상태 갱신
          //  매수·매도 모두 '체결이 확인된 경우에만' 기록한다.
          //  미체결이면 주문완료(buy_ordered/sell_ordered) 상태로만 두고,
          //  나중에 체결이 확인될 때(재조회·서버 러너) 체결 기록이 생성된다.
          if (filled) {
            await supabase.from('trades').insert({
              user_id: uid,
              project_id: proj.id,
              pocket_id: sig.pocket.id,
              side: sig.kind,
              price: fillPrice,
              quantity: fillQty,
              executed_at: new Date().toISOString(),
              note: `자동주문(KIS ${result.orderNo || '-'})`,
            });
          }
          if (sig.kind === 'buy') {
            await supabase
              .from('pockets')
              .update({
                status: filled ? 'bought' : 'buy_ordered',
                sell_target_price:
                  proj.market === 'KRX'
                    ? alignToKrxTick(sellTargetFromFill(fillPrice, Number(proj.sell_target_pct)), 'sell')
                    : sellTargetFromFill(fillPrice, Number(proj.sell_target_pct)),
              })
              .eq('id', sig.pocket.id);
          } else {
            await supabase.from('pockets').update({ status: filled ? 'sold' : 'sell_ordered' }).eq('id', sig.pocket.id);
          }

          await report(
            { at: Date.now(), kind: sig.kind, pocketIdx: sig.pocket.idx, ok: true, message: result.message },
            `🤖 자동 ${label} 주문 완료 · ${proj.symbol}`,
            `${proj.name} · 포켓 ${sig.pocket.idx + 1} · ${fillQty}주 @ ${fillPrice} (주문번호 ${result.orderNo || '-'})`
          );
          onExecuted?.();
        } catch (e: any) {
          const msg = typeof e?.message === 'string' ? e.message : '자동주문에 실패했어요.';
          // 같은 사유의 실패가 30분 안에 반복되면 조용히 넘어간다 (알림 도배 방지)
          const prev = lastFailRef.current.get(key);
          if (prev && prev.msg === msg && Date.now() - prev.at < FAIL_MUTE_MS) {
            setLastEvent({ at: Date.now(), kind: sig.kind, pocketIdx: sig.pocket.idx, ok: false, message: msg });
            return;
          }
          lastFailRef.current.set(key, { msg, at: Date.now() });
          // 실패 이력도 남긴다 (테이블이 아직 없으면 조용히 무시)
          await supabase
            .from('auto_orders')
            .insert({
              user_id: uid,
              project_id: proj.id,
              pocket_id: sig.pocket.id,
              side: sig.kind,
              symbol: proj.symbol,
              order_price: sig.targetPrice,
              quantity: 0,
              status: 'failed',
              error_message: msg,
            })
            .then(() => {});
          await report(
            { at: Date.now(), kind: sig.kind, pocketIdx: sig.pocket.idx, ok: false, message: msg },
            `⚠️ 자동 ${label} 주문 실패 · ${proj.symbol}`,
            `${proj.name} · 포켓 ${sig.pocket.idx + 1} · ${msg}`
          );
        } finally {
          inFlightRef.current.delete(key);
        }
      })();
    },
    [session?.user?.id, onExecuted, report]
  );

  return { handleSignal, lastEvent };
}
