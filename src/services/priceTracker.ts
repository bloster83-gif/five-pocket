import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { notifyNow } from '@/lib/notifications';
import { evaluateSignals, type PriceSignal } from '@/domain/pockets';
import type { Pocket, Project } from '@/types/db';
import { priceProvider } from './prices';

export type TrackerStatus = 'loading' | 'live' | 'error';

interface TrackerResult {
  price: number | null;
  previousClose: number | null;
  currency: string | null;
  change: number | null; // 전일 대비 금액
  changePct: number | null; // 전일 대비 %
  updatedAt: number | null;
  status: TrackerStatus;
  error: string | null;
  lastSignal: PriceSignal | null;
}

const POLL_MS = 4000;

/**
 * 프로젝트 하나의 실시간 시세를 폴링하며,
 * 매수/매도 포인트 도달 시 로컬 알림을 발송한다.
 * loading/live/error 상태를 노출해 화면에서 확실히 표시할 수 있게 한다.
 * onSignal 을 주면 (세션 내 중복 제거된) 신호마다 호출한다 — 자동매매 연동용.
 */
export function usePriceTracker(
  project: Project | null,
  pockets: Pocket[],
  enabled: boolean,
  onSignal?: (signal: PriceSignal) => void
): TrackerResult {
  const [price, setPrice] = useState<number | null>(null);
  const [previousClose, setPreviousClose] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<TrackerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastSignal, setLastSignal] = useState<PriceSignal | null>(null);

  const pocketsRef = useRef<Pocket[]>(pockets);
  pocketsRef.current = pockets;
  const sentRef = useRef<Set<string>>(new Set());
  const onSignalRef = useRef<typeof onSignal>(onSignal);
  onSignalRef.current = onSignal;

  useEffect(() => {
    if (!project || !enabled) {
      setStatus('loading');
      return;
    }
    let alive = true;
    setStatus('loading');
    setError(null);

    const poll = async () => {
      if (!alive) return;
      try {
        const q = await priceProvider.getQuote(project.symbol);
        if (!alive) return;
        setPrice(q.price);
        setCurrency(q.currency ?? null);
        setPreviousClose(q.previousClose ?? null);
        setUpdatedAt(q.at);
        setStatus('live');
        setError(null);

        const signals = evaluateSignals(pocketsRef.current, q.price);
        for (const sig of signals) {
          const key = `${sig.pocket.id}:${sig.kind}`;
          if (sentRef.current.has(key)) continue;
          sentRef.current.add(key);
          setLastSignal(sig);
          onSignalRef.current?.(sig);
          const label = sig.kind === 'buy' ? '매수' : '매도';
          await notifyNow(
            `${label} 포인트 도달 · ${project.symbol}`,
            `${project.name} · 포켓 ${sig.pocket.idx + 1} · 목표 ${sig.targetPrice} / 현재 ${sig.currentPrice}`
          );
          supabase
            .from('price_alerts')
            .insert({
              user_id: project.user_id,
              project_id: project.id,
              pocket_id: sig.pocket.id,
              kind: sig.kind,
              target_price: sig.targetPrice,
              triggered_price: sig.currentPrice,
            })
            .then(() => {});
        }
      } catch (e: any) {
        if (!alive) return;
        // 마지막 가격은 유지하되 상태만 error 로 (웹 CORS/일시적 오류 등)
        setStatus('error');
        setError(typeof e?.message === 'string' ? e.message : '시세를 불러오지 못했습니다.');
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.symbol, enabled]);

  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePct =
    change != null && previousClose ? Math.round((change / previousClose) * 10000) / 100 : null;

  return { price, previousClose, currency, change, changePct, updatedAt, status, error, lastSignal };
}
