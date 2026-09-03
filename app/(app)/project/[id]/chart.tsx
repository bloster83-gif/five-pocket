// 프로젝트 매매차트 — 캔들 + 체결가 가격선 + 매매 마커.
// 차트 자체는 관심종목 가치분석 화면과 똑같은 CandleChart 를 쓴다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme';
import { fetchCandles, type Candle, type CandleMode } from '@/services/prices/yahooProvider';
import type { Pocket, Project, Trade } from '@/types/db';
import { BackHeader } from '@/components/BackHeader';
import { CandleChart, type PriceLine, type TradeMarker } from '@/components/CandleChart';

export default function ChartScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currency, setCurrency] = useState<string | undefined>();
  const [mode, setMode] = useState<CandleMode>('day');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const [{ data: p }, { data: t }, { data: k }] = await Promise.all([
        supabase.from('projects').select('*').eq('id', id).single(),
        supabase.from('trades').select('*').eq('project_id', id).order('executed_at'),
        supabase.from('pockets').select('*').eq('project_id', id).order('idx'),
      ]);
      if (p) setProject(p as Project);
      if (t) setTrades(t as Trade[]);
      if (k) setPockets(k as Pocket[]);
    })();
  }, [id]);

  const loadCandles = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setErr(null);
    try {
      const { candles: c, currency: cur } = await fetchCandles(project.symbol, mode);
      setCandles(c);
      setCurrency(cur);
    } catch (e: any) {
      setErr(e?.message ?? '차트 데이터를 불러오지 못했어요');
    } finally {
      setLoading(false);
    }
  }, [project, mode]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  const mkt = currency === 'KRW' ? 'KRX' : currency === 'USD' ? 'US' : project?.market ?? 'US';

  const pocketIdx = useMemo(() => {
    const m: Record<string, number> = {};
    pockets.forEach((k) => (m[k.id] = k.idx));
    return m;
  }, [pockets]);

  // 아직 체결 안 된 포켓의 목표가(점선 가이드) + 체결된 매수·매도 가격선
  // (포켓·방향별로 가장 최근 체결가 하나씩)
  const lines: PriceLine[] = useMemo(() => {
    const guides = pockets.flatMap((k) => {
      if (k.status === 'waiting')
        return [{ price: k.buy_target_price, color: colors.buy, label: `P${k.idx + 1} 매수목표` }];
      if (k.status === 'bought' && k.sell_target_price != null)
        return [{ price: k.sell_target_price, color: colors.sell, label: `P${k.idx + 1} 매도목표` }];
      return [];
    });
    const m = new Map<string, { price: number; color: string; label: string; at: number }>();
    for (const t of trades) {
      const idx = t.pocket_id ? pocketIdx[t.pocket_id] : undefined;
      if (idx == null) continue;
      const at = new Date(t.executed_at).getTime();
      const key = `${idx}:${t.side}`;
      const prev = m.get(key);
      if (prev && prev.at >= at) continue;
      m.set(key, {
        price: t.price,
        color: t.side === 'buy' ? colors.buy : colors.sell,
        label: `P${idx + 1} ${t.side === 'buy' ? '매수' : '매도'}`,
        at,
      });
    }
    return [...Array.from(m.values()).map(({ at, ...rest }) => rest), ...guides];
  }, [trades, pockets, pocketIdx]);

  const markers: TradeMarker[] = useMemo(
    () =>
      trades.map((t) => ({
        id: t.id,
        at: new Date(t.executed_at).getTime(),
        price: t.price,
        side: t.side,
        label: `P${((t.pocket_id ? pocketIdx[t.pocket_id] : undefined) ?? 0) + 1}`,
      })),
    [trades, pocketIdx]
  );

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <BackHeader fallback="/" />
      <CandleChart
        symbol={project?.symbol ?? ''}
        name={project?.name}
        market={mkt}
        candles={candles}
        mode={mode}
        onMode={setMode}
        loading={loading || !project}
        error={err}
        lines={lines}
        markers={markers}
      />

      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Legend color={colors.buy} label="상승/매수" />
        <Legend color={colors.sell} label="하락/매도" />
      </View>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        점선 = 가격선 (빨강 매수 · 파랑 매도) · 진한 라벨 = 체결가, 「목표」 라벨 = 아직 안 된 목표가{'\n'}▲/▼ + P번호 = 그 매매가 체결된 시점 · 이평선 = 5·20·60·120 단순이동평균
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        처음엔 최근 3년치를 담고, 왼쪽 끝까지 밀면 5년 → 10년으로 이어져요.{'\n'}두 손가락으로 벌리면 확대, 오므리면 축소 · ＋/－ 버튼도 가능 · 꾹 누른 채 움직이면 날짜·종가 추적
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        ⤢ 버튼을 누르면 화면을 가로로 돌려 크게 볼 수 있어요. (약 15분 지연){'\n'}✏ 그리기로 선·가로선·세로선·화살표·사각형·원을 긋고, 그린 도형을 꾹 누르면 옮기거나 모양을 고칠 수 있어요.
      </Text>
    </ScrollView>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ color: colors.textDim, fontSize: 12 }}>{label}</Text>
    </View>
  );
}
