import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as ScreenOrientation from 'expo-screen-orientation';
import Svg, { G, Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { supabase } from '@/lib/supabase';
import { colors, formatPrice, spacing } from '@/theme';
import { fetchCandles, type Candle, type CandleMode } from '@/services/prices/yahooProvider';
import type { Pocket, Project, Trade } from '@/types/db';

const MODES: { key: CandleMode; label: string }[] = [
  { key: 'day', label: '일봉' },
  { key: 'week', label: '주봉' },
  { key: 'year', label: '년봉' },
];

const PAD_TOP = 16;
const PAD_BOT = 24;
const AXIS_W = 56;
const MIN_CANDLE_W = 3;
const MAX_CANDLE_W = 28;

export default function ChartScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currency, setCurrency] = useState<string | undefined>();
  const [mode, setMode] = useState<CandleMode>('day');
  const [candleW, setCandleW] = useState(9); // 확대/축소
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 가로/세로에 맞춰 차트 높이 조절 (가로로 돌리면 화면을 꽉 채움)
  const { width: winW, height: winH } = useWindowDimensions();
  const isLandscape = winW > winH;
  const chartH = isLandscape ? Math.max(200, winH - 170) : 320;
  const plotH = chartH - PAD_TOP - PAD_BOT;

  // 이 화면에서는 회전 허용, 나가면 다시 세로 고정
  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  // 두 손가락 핀치로 확대/축소 (네이버 증권 차트처럼)
  const candleWRef = useRef(candleW);
  candleWRef.current = candleW;
  const pinchBase = useRef(9);
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          pinchBase.current = candleWRef.current;
        })
        .onUpdate((e) => {
          const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, Math.round(pinchBase.current * e.scale)));
          if (w !== candleWRef.current) setCandleW(w);
        }),
    []
  );

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

  // 아직 체결 안 된 포켓의 목표가(점선 가이드)
  const guides = useMemo(
    () =>
      pockets.flatMap((k) => {
        if (k.status === 'waiting')
          return [{ price: k.buy_target_price, color: colors.buy, label: `P${k.idx + 1} 매수목표` }];
        if (k.status === 'bought' && k.sell_target_price != null)
          return [{ price: k.sell_target_price, color: colors.sell, label: `P${k.idx + 1} 매도목표` }];
        return [];
      }),
    [pockets]
  );

  const pocketIdx = useMemo(() => {
    const m: Record<string, number> = {};
    pockets.forEach((k) => (m[k.id] = k.idx));
    return m;
  }, [pockets]);

  const { minP, maxP } = useMemo(() => {
    if (candles.length === 0) return { minP: 0, maxP: 1 };
    let lo = Math.min(...candles.map((c) => c.l));
    let hi = Math.max(...candles.map((c) => c.h));
    trades.forEach((t) => {
      lo = Math.min(lo, t.price);
      hi = Math.max(hi, t.price);
    });
    guides.forEach((g) => {
      lo = Math.min(lo, g.price);
      hi = Math.max(hi, g.price);
    });
    const pad = (hi - lo) * 0.06 || 1;
    return { minP: lo - pad, maxP: hi + pad };
  }, [candles, trades, guides]);

  const priceToY = (p: number) => PAD_TOP + ((maxP - p) / (maxP - minP)) * plotH;
  const chartW = Math.max(candles.length * candleW, 10);

  // x축 날짜 라벨 — 캔들 폭에 맞춰 겹치지 않을 만큼 띄엄띄엄 표시
  const labelStep = Math.max(1, Math.round(52 / candleW));
  const fmtAxisDate = (ms: number) => {
    const d = new Date(ms);
    const YY = String(d.getFullYear()).slice(2);
    if (mode === 'year') return `${YY}/${d.getMonth() + 1}`; // 년봉(월 집계): 연/월
    return `${d.getMonth() + 1}/${d.getDate()}`; // 일·주봉: 월/일
  };

  // 매매 → 그 시점이 속한 캔들 인덱스 (t 이하의 마지막 캔들)
  const tradeIndex = (tradeTime: number): number => {
    let idx = -1;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].t <= tradeTime) idx = i;
      else break;
    }
    return idx;
  };

  const gridLines = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => minP + ((maxP - minP) * i) / n);
  }, [minP, maxP]);

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      {/* 일봉/주봉/년봉 + 확대축소 */}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {MODES.map((m) => (
          <Pressable
            key={m.key}
            onPress={() => setMode(m.key)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: mode === m.key ? colors.buy : colors.cardAlt,
            }}
          >
            <Text style={{ color: mode === m.key ? '#fff' : colors.textDim, fontWeight: '700', fontSize: 13 }}>{m.label}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setCandleW((w) => Math.max(MIN_CANDLE_W, w - 2))} style={zoomBtn}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>－</Text>
        </Pressable>
        <Pressable onPress={() => setCandleW((w) => Math.min(MAX_CANDLE_W, w + 2))} style={zoomBtn}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>＋</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ height: chartH, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.buy} />
        </View>
      ) : err ? (
        <View style={{ height: 120, justifyContent: 'center', gap: 4 }}>
          <Text style={{ color: colors.warn, textAlign: 'center' }}>{err}</Text>
          <Text style={{ color: colors.textDim, textAlign: 'center', fontSize: 12 }}>
            (웹에서는 CORS로 막힐 수 있어요. 폰에서 확인하세요.)
          </Text>
        </View>
      ) : (
        <GestureDetector gesture={pinch}>
          <View style={{ flexDirection: 'row' }}>
            <Svg width={AXIS_W} height={chartH}>
              {gridLines.map((p, i) => (
                <SvgText key={i} x={AXIS_W - 4} y={priceToY(p) + 3} fontSize={9} fill={colors.textDim} textAnchor="end">
                  {formatPrice(p, mkt)}
                </SvgText>
              ))}
            </Svg>
            <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
              <Svg width={chartW} height={chartH}>
              {gridLines.map((p, i) => (
                <Line key={i} x1={0} y1={priceToY(p)} x2={chartW} y2={priceToY(p)} stroke={colors.border} strokeWidth={0.5} />
              ))}
              {/* x축 날짜 라벨 + 세로 눈금 (하단) */}
              {candles.map((c, i) => {
                if (i % labelStep !== 0) return null;
                const x = i * candleW + candleW / 2;
                return (
                  <G key={`d${i}`}>
                    <Line
                      x1={x}
                      y1={PAD_TOP + plotH}
                      x2={x}
                      y2={PAD_TOP + plotH + 4}
                      stroke={colors.textDim}
                      strokeWidth={0.5}
                    />
                    <SvgText x={x} y={chartH - 8} fontSize={9} fill={colors.textDim} textAnchor="middle">
                      {fmtAxisDate(c.t)}
                    </SvgText>
                  </G>
                );
              })}
              {candles.map((c, i) => {
                const x = i * candleW + candleW / 2;
                const col = c.c >= c.o ? colors.buy : colors.sell;
                const bodyTop = priceToY(Math.max(c.o, c.c));
                const bodyH = Math.max(1, Math.abs(priceToY(c.o) - priceToY(c.c)));
                const bodyW = Math.max(2, candleW * 0.7);
                return <Rect key={`b${i}`} x={x - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={col} />;
              })}
              {candles.map((c, i) => {
                const x = i * candleW + candleW / 2;
                const col = c.c >= c.o ? colors.buy : colors.sell;
                return <Line key={`w${i}`} x1={x} y1={priceToY(c.h)} x2={x} y2={priceToY(c.l)} stroke={col} strokeWidth={1} />;
              })}

              {/* 아직 안 된 매수/매도 = 점선 가이드 */}
              {guides.map((g, i) => {
                const y = priceToY(g.price);
                return (
                  <G key={`g${i}`}>
                    <Line x1={0} y1={y} x2={chartW} y2={y} stroke={g.color} strokeWidth={1} strokeDasharray="5 4" opacity={0.9} />
                    <SvgText x={4} y={y - 3} fontSize={10} fontWeight="bold" fill={g.color}>
                      {g.label}
                    </SvgText>
                  </G>
                );
              })}

              {/* 체결된 매수/매도 = 포인트(포켓번호 표시) */}
              {trades.map((t) => {
                const di = tradeIndex(new Date(t.executed_at).getTime());
                if (di < 0) return null;
                const x = di * candleW + candleW / 2;
                const y = priceToY(t.price);
                const isBuy = t.side === 'buy';
                const col = isBuy ? colors.buy : colors.sell;
                const pnum = ((t.pocket_id ? pocketIdx[t.pocket_id] : undefined) ?? 0) + 1;
                const pts = isBuy
                  ? `${x},${y + 11} ${x - 8},${y + 25} ${x + 8},${y + 25}`
                  : `${x},${y - 11} ${x - 8},${y - 25} ${x + 8},${y - 25}`;
                const labelY = isBuy ? y + 36 : y - 28;
                return (
                  <G key={t.id}>
                    <Line x1={x} y1={y} x2={x} y2={isBuy ? y + 11 : y - 11} stroke={col} strokeWidth={1.5} />
                    <Polygon points={pts} fill={col} stroke="#fff" strokeWidth={1} />
                    <SvgText x={x} y={labelY} fontSize={11} fontWeight="bold" fill={col} textAnchor="middle">
                      P{pnum}
                    </SvgText>
                  </G>
                );
              })}
              </Svg>
            </ScrollView>
          </View>
        </GestureDetector>
      )}

      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Legend color={colors.buy} label="상승/매수" />
        <Legend color={colors.sell} label="하락/매도" />
      </View>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        ▲/▼ + P번호 = 체결한 매수·매도 지점 · 점선 = 아직 안 된 포켓의 매수/매도 목표가
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        좌우로 밀어 이동 · 두 손가락으로 벌리면 확대, 오므리면 축소 · ＋/－ 버튼도 가능
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        📱 폰을 가로로 돌리면 차트가 화면 가득 넓게 보여요. (약 15분 지연 · 년봉은 월봉 집계)
      </Text>
    </ScrollView>
  );
}

const zoomBtn = {
  width: 34,
  height: 30,
  borderRadius: 8,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.cardAlt,
  marginLeft: 4,
};

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ color: colors.textDim, fontSize: 12 }}>{label}</Text>
    </View>
  );
}
