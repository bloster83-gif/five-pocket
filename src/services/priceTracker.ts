import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { supabase } from '@/lib/supabase';
import { notifyNow } from '@/lib/notifications';
import { evaluateSignals, type PriceSignal } from '@/domain/pockets';
import type { BrokerAccount, Pocket, Project } from '@/types/db';
import { getOverseasPrice } from './broker/kis';
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

// 시세 폴링 주기. 야후는 15분 지연이고 서버 러너가 1분마다 자동매매를 돌리므로
// 촘촘히 돌 필요가 없다. 30초면 충분히 실시간처럼 보이면서 발열·배터리 소모를 크게 줄인다.
const POLL_MS = 30000;

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

  // 이 화면이 실제로 보이는 중일 때만 폴링 (다른 화면이 위에 덮이면 정지 → 발열 감소)
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!project || !enabled || !isFocused) {
      setStatus('loading');
      return;
    }
    let alive = true;
    setStatus('loading');
    setError(null);

    // 미국주식 + KIS 계좌 연결 시 실시간 시세용 계좌 로드 (네이티브만)
    // undefined=아직 안 불러옴, null=없음
    let account: BrokerAccount | null | undefined = undefined;
    const isUS = project.market === 'US' && Platform.OS !== 'web';

    const poll = async () => {
      if (!alive) return;
      try {
        // 미국주식: KIS 해외 실시간 시세 우선, 실패하면 Yahoo 로 폴백
        let q: { price: number; currency?: string; previousClose?: number; at: number } | null = null;
        if (isUS) {
          if (account === undefined) {
            const { data } = await supabase
              .from('broker_accounts')
              .select('*')
              .eq('user_id', project.user_id)
              .maybeSingle();
            account = (data as BrokerAccount) ?? null;
          }
          if (account) {
            try {
              const oq = await getOverseasPrice(account, project.symbol);
              q = { price: oq.price, currency: oq.currency, previousClose: oq.previousClose, at: Date.now() };
            } catch {
              /* KIS 실패 → Yahoo 폴백 */
            }
          }
        }
        if (!q) q = await priceProvider.getQuote(project.symbol);
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

    // 앱이 화면에 떠 있을 때(active)만 폴링. 백그라운드로 가면 멈춰서 발열·배터리 소모를 막는다.
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id != null) return;
      poll();
      id = setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') start();
      else stop();
    });
    if (AppState.currentState === 'active') start();

    return () => {
      alive = false;
      stop();
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.symbol, enabled, isFocused]);

  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePct =
    change != null && previousClose ? Math.round((change / previousClose) * 10000) / 100 : null;

  return { price, previousClose, currency, change, changePct, updatedAt, status, error, lastSignal };
}
