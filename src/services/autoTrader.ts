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
import { estimatedShares, sellTargetFromFill, type PriceSignal } from '@/domain/pockets';
import { computePnL } from '@/domain/pockets';
import { kisOrderBlocked, placeDomesticOrder } from '@/services/broker/kis';
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
  const { session, tier } = useAuth();
  const [lastEvent, setLastEvent] = useState<AutoTradeEvent | null>(null);

  // 최신 값 참조 (폴링 콜백에서 stale closure 방지)
  const projectRef = useRef(project);
  projectRef.current = project;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const tierRef = useRef(tier);
  tierRef.current = tier;

  // KIS 계좌 캐시: undefined = 아직 안 불러옴, null = 없음
  const accountRef = useRef<BrokerAccount | null | undefined>(undefined);
  // 포켓+방향별 처리중 잠금 (중복 주문 방지)
  const inFlightRef = useRef<Set<string>>(new Set());

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

          // 주문가 = 포켓 목표가(지정가), 수량 계산
          const limitPrice = sig.targetPrice;
          let qty: number;
          if (sig.kind === 'buy') {
            qty = estimatedShares(sig.pocket.budget, limitPrice);
            if (qty <= 0) throw new Error('배분 예산이 없거나 1주 살 금액이 안 돼요. 프로젝트 예산을 확인하세요.');
          } else {
            const pocketTrades = tradesRef.current.filter((t) => t.pocket_id === sig.pocket.id);
            qty = Math.floor(computePnL(pocketTrades, null).totalQtyOpen);
            if (qty <= 0) throw new Error('보유 수량이 없어 매도 주문을 건너뛰었어요.');
          }

          // KIS 주문 전송
          const result = await placeDomesticOrder(account, {
            side: sig.kind,
            symbol: proj.symbol,
            quantity: qty,
            price: limitPrice,
          });

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

          // 체결 기록 + 포켓 상태 갱신 (수동 입력과 동일한 흐름)
          await supabase.from('trades').insert({
            user_id: uid,
            project_id: proj.id,
            pocket_id: sig.pocket.id,
            side: sig.kind,
            price: limitPrice,
            quantity: qty,
            executed_at: new Date().toISOString(),
            note: `자동주문(KIS ${result.orderNo || '-'})`,
          });
          if (sig.kind === 'buy') {
            await supabase
              .from('pockets')
              .update({
                status: 'bought',
                sell_target_price: sellTargetFromFill(limitPrice, Number(proj.sell_target_pct)),
              })
              .eq('id', sig.pocket.id);
          } else {
            await supabase.from('pockets').update({ status: 'sold' }).eq('id', sig.pocket.id);
          }

          await report(
            { at: Date.now(), kind: sig.kind, pocketIdx: sig.pocket.idx, ok: true, message: result.message },
            `🤖 자동 ${label} 주문 완료 · ${proj.symbol}`,
            `${proj.name} · 포켓 ${sig.pocket.idx + 1} · ${qty}주 @ ${limitPrice} (주문번호 ${result.orderNo || '-'})`
          );
          onExecuted?.();
        } catch (e: any) {
          const msg = typeof e?.message === 'string' ? e.message : '자동주문에 실패했어요.';
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
