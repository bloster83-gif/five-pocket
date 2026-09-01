// 가치분석 화면용 인터랙티브 가격 차트
//  · 두 손가락 핀치: 확대(최근 구간)·축소(전체)
//  · 꾹 누른 채 드래그: 크로스헤어로 날짜·가격 추적
//  · 그리기: 추세선·수평선을 직접 그어 저장 (종목별로 남는다)
//  · 상승=빨강(buy) / 하락=파랑(sell) — 한국 관례
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { colors, formatPrice, num, radius } from '@/theme';
import type { SeriesPoint } from '@/services/prices/yahooProvider';

const PAD_TOP = 14;
const PAD_BOT = 20;
const PAD_X = 6;
const MIN_VISIBLE = 15; // 최대 확대 시 보이는 포인트 수
const HIT_PX = 18; // 지우개가 선을 '집었다'고 보는 거리(px)

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// 그리기 도형
//
// 화면 좌표가 아니라 '시간·가격'으로 저장한다. 그래야 확대·축소하거나
// 기간을 바꿔도 선이 원래 가리키던 자리에 그대로 붙어 있다.
// ─────────────────────────────────────────────────────────────
export type Drawing =
  | { id: string; kind: 'trend'; t1: number; p1: number; t2: number; p2: number }
  | { id: string; kind: 'hline'; p: number };

type Tool = 'none' | 'trend' | 'hline' | 'erase';

const drawKey = (symbol: string) => `chartDrawings:${symbol}`;

async function loadDrawings(symbol: string): Promise<Drawing[]> {
  try {
    const raw = await AsyncStorage.getItem(drawKey(symbol));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as Drawing[]) : [];
  } catch {
    return [];
  }
}

async function saveDrawings(symbol: string, list: Drawing[]) {
  try {
    await AsyncStorage.setItem(drawKey(symbol), JSON.stringify(list));
  } catch {
    /* 저장 실패해도 화면은 그대로 — 다음에 다시 그리면 된다 */
  }
}

export function StockPriceChart({
  points,
  market,
  width,
  height = 210,
  symbol,
  drawable = true,
}: {
  points: SeriesPoint[];
  market: string;
  width: number;
  height?: number;
  /** 그린 선을 종목별로 저장하기 위한 키. 없으면 그리기 기능이 꺼진다 */
  symbol?: string;
  drawable?: boolean;
}) {
  const n = points.length;
  const [zoom, setZoom] = useState(1); // 1=전체, 커질수록 최근 구간 확대
  const [touchIdx, setTouchIdx] = useState<number | null>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const pinchBase = useRef(1);

  // 그리기
  const canDraw = drawable && !!symbol;
  const [tool, setTool] = useState<Tool>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  // 손가락으로 끄는 중인 임시 선 (화면 좌표)
  const [dragging, setDragging] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    loadDrawings(symbol).then((d) => alive && setDrawings(d));
    return () => {
      alive = false;
    };
  }, [symbol]);

  const commit = useCallback(
    (next: Drawing[]) => {
      setDrawings(next);
      if (symbol) saveDrawings(symbol, next);
    },
    [symbol]
  );

  // 확대하면 '최근' 구간을 보여준다 (오른쪽 고정)
  const visCount = Math.max(MIN_VISIBLE, Math.round(n / zoom));
  const vis = useMemo(() => points.slice(Math.max(0, n - visCount)), [points, n, visCount]);
  const m = vis.length;

  const plotW = width - PAD_X * 2;
  const plotH = height - PAD_TOP - PAD_BOT;
  const vals = vis.map((d) => d.c);
  const maxV = vals.length ? Math.max(...vals) : 1;
  const minV = vals.length ? Math.min(...vals) : 0;
  const range = maxV - minV || 1;
  const x = (i: number) => PAD_X + (m <= 1 ? 0 : (i / (m - 1)) * plotW);
  const y = (v: number) => PAD_TOP + (1 - (v - minV) / range) * plotH;

  const idxFromX = (px: number) => Math.max(0, Math.min(m - 1, Math.round(((px - PAD_X) / plotW) * (m - 1))));

  // 화면 좌표 ↔ 시간·가격
  const priceAt = (py: number) => minV + (1 - (py - PAD_TOP) / plotH) * range;
  const timeAt = (px: number) => {
    if (m < 2) return vis[0]?.t ?? 0;
    const f = ((px - PAD_X) / plotW) * (m - 1);
    const lo = Math.floor(f);
    if (lo < 0) return vis[0].t + f * (vis[1].t - vis[0].t); // 왼쪽 바깥은 간격으로 연장
    if (lo >= m - 1) return vis[m - 1].t + (f - (m - 1)) * (vis[m - 1].t - vis[m - 2].t);
    return vis[lo].t + (f - lo) * (vis[lo + 1].t - vis[lo].t);
  };
  const xOfTime = (t: number) => {
    if (m < 2) return PAD_X;
    if (t <= vis[0].t) {
      const step = vis[1].t - vis[0].t || 1;
      return x(0) + ((t - vis[0].t) / step) * (plotW / (m - 1));
    }
    if (t >= vis[m - 1].t) {
      const step = vis[m - 1].t - vis[m - 2].t || 1;
      return x(m - 1) + ((t - vis[m - 1].t) / step) * (plotW / (m - 1));
    }
    // 이분 탐색으로 t 를 감싸는 두 점을 찾아 그 사이를 비례 배분
    let lo = 0;
    let hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (vis[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const span = vis[hi].t - vis[lo].t || 1;
    return x(lo) + ((t - vis[lo].t) / span) * (x(hi) - x(lo));
  };

  // 점(px,py)에서 각 도형까지의 거리 — 지우개용
  const distTo = (d: Drawing, px: number, py: number): number => {
    if (d.kind === 'hline') return Math.abs(py - y(d.p));
    const ax = xOfTime(d.t1);
    const ay = y(d.p1);
    const bx = xOfTime(d.t2);
    const by = y(d.p2);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const eraseAt = (px: number, py: number) => {
    let best = -1;
    let bestD = HIT_PX;
    drawings.forEach((d, i) => {
      const dist = distTo(d, px, py);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    if (best >= 0) commit(drawings.filter((_, i) => i !== best));
  };

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .enabled(tool === 'none')
        .onStart(() => {
          pinchBase.current = zoomRef.current;
        })
        .onUpdate((e) => {
          const maxZoom = Math.max(1, n / MIN_VISIBLE);
          setZoom(Math.min(maxZoom, Math.max(1, pinchBase.current * e.scale)));
        }),
    [n, tool]
  );

  // 도구 없음: 꾹 눌러 크로스헤어 추적 / 추세선: 바로 끌어서 선 긋기
  const track = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(tool === 'none')
        .activateAfterLongPress(200) // 꾹 누르면 추적 시작 (스크롤과 충돌 방지)
        .onStart((e) => setTouchIdx(idxFromX(e.x)))
        .onUpdate((e) => setTouchIdx(idxFromX(e.x)))
        .onEnd(() => setTouchIdx(null))
        .onFinalize(() => setTouchIdx(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, plotW, tool]
  );

  const drawPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(tool === 'trend')
        .minDistance(2)
        .onStart((e) => setDragging({ x1: e.x, y1: e.y, x2: e.x, y2: e.y }))
        .onUpdate((e) => setDragging((p) => (p ? { ...p, x2: e.x, y2: e.y } : p)))
        .onEnd((e) => {
          setDragging((p) => {
            if (p && Math.hypot(e.x - p.x1, e.y - p.y1) > 8) {
              commit([
                ...drawings,
                {
                  id: `${Date.now()}`,
                  kind: 'trend',
                  t1: timeAt(p.x1),
                  p1: priceAt(p.y1),
                  t2: timeAt(e.x),
                  p2: priceAt(e.y),
                },
              ]);
            }
            return null;
          });
        })
        .onFinalize(() => setDragging(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, drawings, m, plotW, plotH, minV, range, commit]
  );

  // 수평선: 탭한 높이의 가격 / 지우개: 탭한 곳의 선 삭제
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .enabled(tool === 'hline' || tool === 'erase')
        .onEnd((e) => {
          if (tool === 'hline') commit([...drawings, { id: `${Date.now()}`, kind: 'hline', p: priceAt(e.y) }]);
          else eraseAt(e.x, e.y);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, drawings, plotH, minV, range, commit]
  );

  const gesture = useMemo(
    () => Gesture.Simultaneous(pinch, Gesture.Exclusive(drawPan, track, tap)),
    [pinch, drawPan, track, tap]
  );

  if (m < 2) {
    return (
      <View style={{ height: 80, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>가격 데이터를 불러오지 못했어요.</Text>
      </View>
    );
  }

  const first = vis[0];
  const last = vis[m - 1];
  const up = last.c >= first.c;
  const lineColor = up ? colors.buy : colors.sell;
  const changePct = Math.round((last.c / first.c - 1) * 1000) / 10;
  const path = vis.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d.c).toFixed(1)}`).join(' ');

  const tracked = touchIdx != null ? vis[touchIdx] : null;
  const labelIdx = [0, Math.floor((m - 1) / 2), m - 1];

  const hint =
    tool === 'trend'
      ? '차트 위를 끌어서 추세선을 그어요'
      : tool === 'hline'
        ? '차트를 탭하면 그 높이에 수평선이 그어져요'
        : tool === 'erase'
          ? '지울 선을 탭하세요'
          : '두 손가락으로 확대·축소 · 꾹 누른 채 움직이면 날짜별 가격 추적';

  return (
    <View style={{ gap: 4 }}>
      {/* 상단 정보줄 — 평소: 구간 등락 / 추적 중: 날짜·가격 (높이 고정으로 흔들림 방지) */}
      <View style={{ height: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {tracked ? (
          <>
            <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '700' }}>{fmtDate(tracked.t)}</Text>
            <Text style={{ color: num.live, fontSize: 13, fontWeight: '900' }}>{formatPrice(tracked.c, market)}</Text>
          </>
        ) : (
          <>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              {fmtDate(first.t)} ~ {fmtDate(last.t)}
            </Text>
            <Text style={{ color: lineColor, fontSize: 12, fontWeight: '800' }}>
              {changePct > 0 ? '+' : ''}
              {changePct}%
            </Text>
          </>
        )}
      </View>

      {/* 그리기 도구 */}
      {canDraw && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <ToolBtn label="추세선" icon="／" active={tool === 'trend'} color={colors.accent} onPress={() => setTool((t) => (t === 'trend' ? 'none' : 'trend'))} />
          <ToolBtn label="수평선" icon="─" active={tool === 'hline'} color={num.base} onPress={() => setTool((t) => (t === 'hline' ? 'none' : 'hline'))} />
          <ToolBtn label="지우개" icon="⌫" active={tool === 'erase'} color={colors.warn} onPress={() => setTool((t) => (t === 'erase' ? 'none' : 'erase'))} />
          <View style={{ flex: 1 }} />
          {drawings.length > 0 && (
            <>
              <ToolBtn label="되돌리기" icon="↶" active={false} color={colors.textDim} onPress={() => commit(drawings.slice(0, -1))} />
              <ToolBtn label="모두 지우기" icon="🗑" active={false} color={colors.textDim} onPress={() => commit([])} />
            </>
          )}
        </View>
      )}

      <GestureDetector gesture={gesture}>
        {/* 확대·축소로 그린 선이 밖으로 나가도 차트 안에서만 보이게 자른다 */}
        <View style={{ overflow: 'hidden', borderRadius: 4 }}>
          <Svg width={width} height={height}>
            {/* 최고·최저 가이드 */}
            <Line x1={PAD_X} y1={y(maxV)} x2={width - PAD_X} y2={y(maxV)} stroke={colors.border} strokeWidth={0.5} strokeDasharray="3 3" />
            <Line x1={PAD_X} y1={y(minV)} x2={width - PAD_X} y2={y(minV)} stroke={colors.border} strokeWidth={0.5} strokeDasharray="3 3" />
            <SvgText x={width - PAD_X} y={y(maxV) - 4} fill={colors.textDim} fontSize={9} textAnchor="end">
              {formatPrice(maxV, market)}
            </SvgText>
            {/* 최저 라벨은 점선 위로 올려 하단 날짜 라벨과 겹치지 않게 */}
            <SvgText x={width - PAD_X} y={y(minV) - 4} fill={colors.textDim} fontSize={9} textAnchor="end">
              {formatPrice(minV, market)}
            </SvgText>

            <Path d={path} stroke={lineColor} strokeWidth={2} fill="none" />

            {/* 내가 그린 선 */}
            {drawings.map((d) =>
              d.kind === 'hline' ? (
                <Line key={d.id} x1={PAD_X} y1={y(d.p)} x2={width - PAD_X} y2={y(d.p)} stroke={num.base} strokeWidth={1.5} />
              ) : (
                <Line key={d.id} x1={xOfTime(d.t1)} y1={y(d.p1)} x2={xOfTime(d.t2)} y2={y(d.p2)} stroke={colors.accent} strokeWidth={1.8} />
              )
            )}
            {/* 수평선 가격 라벨 */}
            {drawings.map((d) =>
              d.kind === 'hline' ? (
                <SvgText key={`l${d.id}`} x={PAD_X + 2} y={y(d.p) - 3} fill={num.base} fontSize={9} fontWeight="bold">
                  {formatPrice(d.p, market)}
                </SvgText>
              ) : null
            )}
            {/* 끄는 중인 추세선 미리보기 */}
            {dragging && (
              <Line
                x1={dragging.x1}
                y1={dragging.y1}
                x2={dragging.x2}
                y2={dragging.y2}
                stroke={colors.accent}
                strokeWidth={1.8}
                strokeDasharray="4 3"
              />
            )}

            {/* 크로스헤어 (꾹 누른 채 드래그) */}
            {tracked && touchIdx != null && (
              <>
                <Line x1={x(touchIdx)} y1={PAD_TOP} x2={x(touchIdx)} y2={PAD_TOP + plotH} stroke={colors.textDim} strokeWidth={1} strokeDasharray="3 3" />
                <Circle cx={x(touchIdx)} cy={y(tracked.c)} r={5} fill={lineColor} stroke="#fff" strokeWidth={1.5} />
              </>
            )}

            {/* 날짜 라벨 (처음·중간·끝) */}
            {labelIdx.map((i, k) => (
              <SvgText
                key={k}
                x={x(i)}
                y={height - 5}
                fill={colors.textDim}
                fontSize={9}
                textAnchor={i === 0 ? 'start' : i === m - 1 ? 'end' : 'middle'}
              >
                {fmtDate(vis[i].t).slice(2)}
              </SvgText>
            ))}
          </Svg>
        </View>
      </GestureDetector>

      <Text style={{ color: tool === 'none' ? colors.textDim : colors.accent, fontSize: 10 }}>{hint}</Text>
    </View>
  );
}

function ToolBtn({
  label,
  icon,
  active,
  color,
  onPress,
}: {
  label: string;
  icon: string;
  active: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: active ? color : colors.border,
        backgroundColor: active ? `${color}24` : colors.cardAlt,
      }}
    >
      <Text style={{ color: active ? color : colors.textDim, fontSize: 11, fontWeight: '900' }}>{icon}</Text>
      <Text style={{ color: active ? color : colors.textDim, fontSize: 11, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}
