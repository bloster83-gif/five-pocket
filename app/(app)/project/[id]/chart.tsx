import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { supabase } from '@/lib/supabase';
import { colors, formatPrice, spacing } from '@/theme';
import { fetchCandles, type Candle, type CandleMode } from '@/services/prices/yahooProvider';
import type { Pocket, Project, Trade } from '@/types/db';
import { BackHeader } from '@/components/BackHeader';

const MODES: { key: CandleMode; label: string }[] = [
  { key: 'day', label: '일봉' },
  { key: 'week', label: '주봉' },
  { key: 'month', label: '월봉' },
];

// 이동평균선 — 네이버 증권 기본값(5·20·60·120)과 같은 기간.
// 색은 캔들의 빨강(상승)·파랑(하락)과 겹치지 않게 따로 골랐다.
const MA_LINES = [
  { n: 5, color: '#F59E0B' },
  { n: 20, color: '#A78BFA' },
  { n: 60, color: '#22D3A6' },
  { n: 120, color: '#94A3B8' },
] as const;

const PAD_TOP = 16;
const PAD_BOT = 24;
const AXIS_W = 56;
const MIN_CANDLE_W = 1.2;
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
  const insets = useSafeAreaInsets();
  const isLandscape = winW > winH;
  // '가로 보기' — 기기를 돌리지 않고 화면 안에서 90° 회전시켜 크게 본다.
  // (화면 회전 잠금을 켜 둔 사람도, 아직 세로 전용으로 빌드된 앱에서도 쓸 수 있다)
  const [wideView, setWideView] = useState(false);
  const chartH = wideView
    ? Math.max(200, winW - insets.left - insets.right - 120) // 회전 시에는 '기기 가로폭'이 차트 높이가 된다
    : isLandscape
      ? Math.max(200, winH - 170)
      : 320;
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
  // 손가락이 짚고 있던 캔들이 제자리에 남도록, 캔들 폭을 바꿀 때 스크롤 위치도 같이 옮긴다.
  const candleWRef = useRef(candleW);
  candleWRef.current = candleW;
  const scrollRef = useRef<ScrollView>(null);
  const scrollXRef = useRef(0);
  const [scrollX, setScrollX] = useState(0); // 보이는 구간 계산용 (그리기 최적화)
  const plotWRef = useRef(0);
  const countRef = useRef(0);
  countRef.current = candles.length;

  /** 새 캔들 폭 기준으로 가로 스크롤 위치를 옮긴다 (양 끝을 넘지 않게 보정) */
  const scrollToX = useCallback((x: number, w: number) => {
    const maxX = Math.max(0, countRef.current * w - plotWRef.current);
    const nx = Math.min(maxX, Math.max(0, x));
    scrollXRef.current = nx;
    setScrollX(nx);
    // 폭이 바뀐 내용이 그려진 다음에 옮겨야 끝까지 스크롤된다
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: nx, animated: false }));
  }, []);

  /** 기준점(focal)을 화면에 고정한 채 캔들 폭을 w 로 바꾼다 */
  const zoomAround = useCallback(
    (w: number, focal: number) => {
      const w0 = candleWRef.current;
      if (w === w0) return;
      const idx = (scrollXRef.current + focal) / w0; // 기준점이 짚고 있던 캔들(소수 포함)
      setCandleW(w);
      scrollToX(idx * w - focal, w);
    },
    [scrollToX]
  );

  const pinchBase = useRef({ w: 9, focal: 0 });
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart((e) => {
          // focalX 는 축(왼쪽 가격 눈금)을 포함한 좌표 → 차트 영역 기준으로 보정
          pinchBase.current = { w: candleWRef.current, focal: Math.max(0, e.focalX - AXIS_W) };
        })
        .onUpdate((e) => {
          const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, Math.round(pinchBase.current.w * e.scale * 10) / 10));
          zoomAround(w, pinchBase.current.focal);
        }),
    [zoomAround]
  );

  /** ＋/－ 버튼은 화면 한가운데를 기준으로 확대·축소 */
  const zoomByButton = useCallback(
    (delta: number) => {
      const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, candleWRef.current + delta));
      zoomAround(w, plotWRef.current / 2);
    },
    [zoomAround]
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

  // 체결된 매수·매도 가격선 (포켓·방향별로 가장 최근 체결가 하나씩)
  const fills = useMemo(() => {
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
    return Array.from(m.values());
  }, [trades, pocketIdx]);

  const [plotW, setPlotW] = useState(0); // 차트 그리기 영역의 실제 폭 (onLayout 으로 측정)

  // 화면에 보이는 봉 구간만 그린다 (10년치를 전부 그리면 SVG 요소가 수천 개가 되어 느려진다).
  // 양옆으로 조금 여유를 둬서 스크롤할 때 빈 칸이 보이지 않게 한다.
  const view = useMemo(() => {
    if (candles.length === 0 || plotW === 0) return { from: 0, to: candles.length };
    const pad = 30;
    const from = Math.max(0, Math.floor(scrollX / candleW) - pad);
    const to = Math.min(candles.length, Math.ceil((scrollX + plotW) / candleW) + pad);
    return { from, to };
  }, [candles.length, scrollX, candleW, plotW]);

  // 가격 축은 '보이는 구간' 기준으로 잡는다 → 10년 전 가격 때문에 최근 움직임이 눌리지 않는다
  const { minP, maxP } = useMemo(() => {
    if (candles.length === 0) return { minP: 0, maxP: 1 };
    const shown = candles.slice(view.from, view.to);
    const src = shown.length > 0 ? shown : candles;
    let lo = Math.min(...src.map((c) => c.l));
    let hi = Math.max(...src.map((c) => c.h));
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
  }, [candles, trades, guides, view]);

  const priceToY = (p: number) => PAD_TOP + ((maxP - p) / (maxP - minP)) * plotH;
  const chartW = Math.max(candles.length * candleW, 10);

  // x축 눈금 — 확대 정도에 따라 표기를 바꾸고, 라벨이 겹치지 않게 픽셀 간격으로 걸러낸다.
  //   축소: 월이 바뀌는 지점에 '연/월'    (예: 26/3)
  //   확대: 날짜 단위로 '연/월/일'         (예: 26/3/14)
  // 해가 바뀌는 지점에는 세로 점선 + 연도를 따로 표시한다.
  const DETAIL_ZOOM = 6; // 캔들 폭이 이보다 넓으면 '일'까지 표기
  const axis = useMemo(() => {
    const ticks: { i: number; label: string }[] = [];
    const years: { i: number; year: number }[] = [];
    if (candles.length === 0) return { ticks, years };
    const detailed = candleW >= DETAIL_ZOOM;
    const minGapPx = detailed ? 62 : 50;
    let lastX = -Infinity;
    for (let i = view.from; i < view.to; i++) {
      const d = new Date(candles[i].t);
      const prev = i > 0 ? new Date(candles[i - 1].t) : null;
      const newYear = !!prev && prev.getFullYear() !== d.getFullYear();
      const newMonth = !prev || newYear || prev.getMonth() !== d.getMonth();
      if (newYear) years.push({ i, year: d.getFullYear() });
      if (!detailed && !newMonth) continue; // 축소 상태에서는 월이 바뀌는 봉만 후보
      const x = i * candleW + candleW / 2;
      if (x - lastX < minGapPx) continue;
      lastX = x;
      const YY = String(d.getFullYear()).slice(2);
      ticks.push({
        i,
        label: detailed ? `${YY}/${d.getMonth() + 1}/${d.getDate()}` : `${YY}/${d.getMonth() + 1}`,
      });
    }
    return { ticks, years };
  }, [candles, candleW, view]);

  // 매매 → 그 시점이 속한 캔들 인덱스 (t 이하의 마지막 캔들)
  const tradeIndex = (tradeTime: number): number => {
    let idx = -1;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].t <= tradeTime) idx = i;
      else break;
    }
    return idx;
  };

  // 좌우로 밀어도 항상 보이도록, 가격선과 라벨은 스크롤되지 않는 오버레이에 그린다.
  // (예전에는 스크롤되는 SVG 안에 있어서 차트를 옮기면 라벨이 화면 밖으로 사라졌다)
  const overlayLines = useMemo(() => {
    const rows = [...fills, ...guides]
      .map((g) => ({ ...g, y: PAD_TOP + ((maxP - g.price) / (maxP - minP)) * plotH }))
      .sort((a, b) => a.y - b.y);
    // 가격이 가까우면 라벨이 겹치므로 아래로 조금씩 밀어 준다
    let last = -Infinity;
    return rows.map((r) => {
      const labelY = Math.max(r.y - 4, last + 13);
      last = labelY;
      return { ...r, labelY };
    });
  }, [fills, guides, minP, maxP, plotH]);

  // 이동평균 계산 (단순이동평균). 봉이 모자란 구간은 null → 그 지점부터 선이 시작된다.
  const [maOn, setMaOn] = useState<Record<number, boolean>>({ 5: true, 20: true, 60: true, 120: true });
  const maSeries = useMemo(() => {
    const closes = candles.map((c) => c.c);
    return MA_LINES.map(({ n, color }) => {
      const pts: (number | null)[] = [];
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= n) sum -= closes[i - n];
        pts.push(i >= n - 1 ? sum / n : null);
      }
      return { n, color, pts, has: closes.length >= n };
    });
  }, [candles]);

  // 처음 열면 가장 최근 봉(=현재가)이 보이도록 오른쪽 끝으로 맞춘다.
  // 봉 데이터·차트 폭이 준비된 뒤 한 번만 하고, 이후 확대/이동은 사용자에게 맡긴다.
  const didInitScroll = useRef(false);
  useEffect(() => {
    didInitScroll.current = false; // 봉 종류(일/주/년)·가로보기 전환·데이터 재조회 시 다시 맞춤
  }, [mode, wideView, candles.length]);
  useEffect(() => {
    if (didInitScroll.current) return;
    if (candles.length === 0 || plotW === 0) return;
    didInitScroll.current = true;
    // 데이터는 일봉 3년·주봉 5년치를 받아두고, 처음 화면에는 최근 1년치만 담는다.
    // (나머지는 왼쪽으로 밀면 나온다)
    const oneYear = mode === 'day' ? 250 : mode === 'week' ? 52 : 12; // 월봉은 12개월
    const visible = Math.max(1, Math.min(oneYear, candles.length));
    const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, Math.round((plotW / visible) * 10) / 10));
    setCandleW(w);
    candleWRef.current = w;
    scrollToX(candles.length * w - plotW, w);
  }, [candles.length, plotW, mode, scrollToX]);

  const gridLines = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => minP + ((maxP - minP) * i) / n);
  }, [minP, maxP]);

  const controls = (
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
        <Pressable onPress={() => zoomByButton(-2)} style={zoomBtn}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>－</Text>
        </Pressable>
        <Pressable onPress={() => zoomByButton(2)} style={zoomBtn}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>＋</Text>
        </Pressable>
        <Pressable onPress={() => setWideView((v) => !v)} style={{ ...zoomBtn, width: 44 }}>
          <Text style={{ color: wideView ? colors.buy : colors.text, fontWeight: '900', fontSize: 15 }}>
            {wideView ? '⤡' : '⤢'}
          </Text>
        </Pressable>
      </View>
  );

  const chartBlock = (
    <>
      {/* 이동평균선 켜기/끄기 — 봉 수가 모자란 기간은 흐리게 표시하고 눌러도 안 그려진다 */}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text style={{ color: colors.textDim, fontSize: 11 }}>이평선</Text>
        {maSeries.map((m) => (
          <Pressable
            key={m.n}
            onPress={() => m.has && setMaOn((v) => ({ ...v, [m.n]: !v[m.n] }))}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: maOn[m.n] && m.has ? m.color : colors.border,
              backgroundColor: maOn[m.n] && m.has ? 'rgba(255,255,255,0.06)' : 'transparent',
              opacity: m.has ? 1 : 0.35,
            }}
          >
            <View style={{ width: 10, height: 2, backgroundColor: m.color }} />
            <Text style={{ color: maOn[m.n] && m.has ? m.color : colors.textDim, fontSize: 11, fontWeight: '800' }}>
              {m.n}
            </Text>
          </Pressable>
        ))}
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
            <View
              style={{ flex: 1 }}
              onLayout={(e) => {
                setPlotW(e.nativeEvent.layout.width);
                plotWRef.current = e.nativeEvent.layout.width;
              }}
            >
            <ScrollView
              ref={scrollRef}
              horizontal
              showsHorizontalScrollIndicator
              scrollEventThrottle={16}
              onScroll={(e) => {
                scrollXRef.current = e.nativeEvent.contentOffset.x;
                setScrollX(e.nativeEvent.contentOffset.x);
              }}
            >
              <Svg width={chartW} height={chartH}>
              {gridLines.map((p, i) => (
                <Line key={i} x1={0} y1={priceToY(p)} x2={chartW} y2={priceToY(p)} stroke={colors.border} strokeWidth={0.5} />
              ))}
              {/* 해가 바뀌는 지점 — 세로 점선 + 연도 */}
              {axis.years.map((y) => {
                const x = y.i * candleW;
                return (
                  <G key={`y${y.i}`}>
                    <Line
                      x1={x}
                      y1={PAD_TOP}
                      x2={x}
                      y2={PAD_TOP + plotH}
                      stroke={colors.textDim}
                      strokeWidth={1}
                      strokeDasharray="3 5"
                      opacity={0.5}
                    />
                    <SvgText x={x + 3} y={PAD_TOP + 9} fontSize={10} fontWeight="bold" fill={colors.textDim}>
                      {y.year}
                    </SvgText>
                  </G>
                );
              })}
              {/* x축 날짜 라벨 + 세로 눈금 (하단) */}
              {axis.ticks.map((t) => {
                const x = t.i * candleW + candleW / 2;
                return (
                  <G key={`d${t.i}`}>
                    <Line
                      x1={x}
                      y1={PAD_TOP + plotH}
                      x2={x}
                      y2={PAD_TOP + plotH + 4}
                      stroke={colors.textDim}
                      strokeWidth={0.5}
                    />
                    <SvgText x={x} y={chartH - 8} fontSize={9} fill={colors.textDim} textAnchor="middle">
                      {t.label}
                    </SvgText>
                  </G>
                );
              })}
              {candles.slice(view.from, view.to).map((c, j) => {
                const i = view.from + j;
                const x = i * candleW + candleW / 2;
                const col = c.c >= c.o ? colors.buy : colors.sell;
                const bodyTop = priceToY(Math.max(c.o, c.c));
                const bodyH = Math.max(1, Math.abs(priceToY(c.o) - priceToY(c.c)));
                const bodyW = Math.max(1, candleW * 0.7);
                return <Rect key={`b${i}`} x={x - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={col} />;
              })}
              {candles.slice(view.from, view.to).map((c, j) => {
                const i = view.from + j;
                const x = i * candleW + candleW / 2;
                const col = c.c >= c.o ? colors.buy : colors.sell;
                return <Line key={`w${i}`} x1={x} y1={priceToY(c.h)} x2={x} y2={priceToY(c.l)} stroke={col} strokeWidth={1} />;
              })}


              {/* 이동평균선 — 캔들 위에 겹쳐 그린다 */}
              {maSeries.map((m) => {
                if (!m.has || !maOn[m.n]) return null;
                const pts = m.pts
                  .slice(view.from, view.to)
                  .map((v, j) =>
                    v == null ? null : `${(view.from + j) * candleW + candleW / 2},${priceToY(v)}`
                  )
                  .filter(Boolean)
                  .join(' ');
                if (!pts) return null;
                return <Polyline key={`ma${m.n}`} points={pts} fill="none" stroke={m.color} strokeWidth={1.2} />;
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
                // 가격선 라벨이 포켓을 알려주므로 마커는 '언제 체결됐는지'만 짚어주면 된다 → 작게
                const pts = isBuy
                  ? `${x},${y + 6} ${x - 4},${y + 14} ${x + 4},${y + 14}`
                  : `${x},${y - 6} ${x - 4},${y - 14} ${x + 4},${y - 14}`;
                const labelY = isBuy ? y + 23 : y - 17;
                return (
                  <G key={t.id}>
                    <Line x1={x} y1={y} x2={x} y2={isBuy ? y + 6 : y - 6} stroke={col} strokeWidth={1} />
                    <Polygon points={pts} fill={col} stroke="#fff" strokeWidth={0.8} />
                    <SvgText x={x} y={labelY} fontSize={9} fontWeight="bold" fill={col} textAnchor="middle">
                      P{pnum}
                    </SvgText>
                  </G>
                );
              })}
              </Svg>
            </ScrollView>

            {/* 가격선 + 라벨 오버레이 — 차트를 좌우로 밀어도 자리에 그대로 남는다 */}
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: plotW, height: chartH }}>
              <Svg width={plotW} height={chartH}>
                {overlayLines.map((g, i) => (
                  <G key={`o${i}`}>
                    <Line
                      x1={0}
                      y1={g.y}
                      x2={plotW}
                      y2={g.y}
                      stroke={g.color}
                      strokeWidth={1}
                      strokeDasharray="5 4"
                      opacity={0.9}
                    />
                    {/* 캔들 위에 겹쳐도 읽히도록 글자 뒤에 어두운 판을 깔아준다 */}
                    <Rect
                      x={3}
                      y={g.labelY - 10}
                      width={g.label.length * 7 + 8}
                      height={13}
                      rx={3}
                      fill={colors.bg}
                      opacity={0.72}
                    />
                    <SvgText x={7} y={g.labelY} fontSize={10} fontWeight="bold" fill={g.color}>
                      {g.label}
                    </SvgText>
                  </G>
                ))}
              </Svg>
            </View>
            </View>
          </View>
        </GestureDetector>
      )}

    </>
  );

  // 가로 보기 — 화면 전체를 덮고 내용을 90° 돌려 크게 보여준다
  if (wideView) {
    return (
      <Modal visible transparent={false} animationType="fade" onRequestClose={() => setWideView(false)}>
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View
            style={{
              position: 'absolute',
              top: (winH - winW) / 2,
              left: (winW - winH) / 2,
              width: winH,
              height: winW,
              transform: [{ rotate: '90deg' }],
              // 90° 돌린 좌표계라 기기의 상·하단(노치·홈 인디케이터)이 좌·우가 된다.
              // 그만큼 안쪽으로 밀어야 시계·배터리 표시와 겹치지 않는다.
              paddingLeft: insets.top + spacing.sm,
              paddingRight: insets.bottom + spacing.sm,
              paddingTop: insets.right + spacing.sm,
              paddingBottom: insets.left + spacing.sm,
              gap: spacing.sm,
            }}
          >
            {controls}
            {chartBlock}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <BackHeader fallback="/" />
      {controls}
      {chartBlock}

      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Legend color={colors.buy} label="상승/매수" />
        <Legend color={colors.sell} label="하락/매도" />
      </View>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        점선 = 가격선 (빨강 매수 · 파랑 매도) · 진한 라벨 = 체결가, 「목표」 라벨 = 아직 안 된 목표가{'\n'}▲/▼ + P번호 = 그 매매가 체결된 시점 · 이평선 = 5·20·60·120 단순이동평균
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        처음엔 최근 1년치가 보여요. 왼쪽으로 밀면 과거(최대 10년)까지 볼 수 있어요.{'\n'}두 손가락으로 벌리면 확대, 오므리면 축소 · ＋/－ 버튼도 가능
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        ⤢ 버튼을 누르면 화면을 가로로 돌려 크게 볼 수 있어요. (약 15분 지연)
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
