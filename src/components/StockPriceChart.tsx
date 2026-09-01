// 가치분석 화면용 인터랙티브 가격 차트
//  · 두 손가락 핀치: 확대(최근 구간)·축소(전체)
//  · 꾹 누른 채 드래그: 크로스헤어로 날짜·가격 추적
//  · 그리기: 선·가로선·세로선·화살표·사각형·원 (종목별로 저장)
//  · 상승=빨강(buy) / 하락=파랑(sell) — 한국 관례
//
// 그린 도형은 매수 빨강·매도 파랑과 헷갈리지 않도록 전부 보라(num.base)로 그린다.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Ellipse, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { colors, formatPrice, num, radius } from '@/theme';
import type { SeriesPoint } from '@/services/prices/yahooProvider';

const PAD_TOP = 14;
const PAD_BOT = 20;
const PAD_X = 6;
const MIN_VISIBLE = 15; // 최대 확대 시 보이는 포인트 수
const HIT_PX = 18; // 지우개가 도형을 '집었다'고 보는 거리(px)
const DRAW = num.base; // 그린 도형 색 (보라 — 매수 빨강·매도 파랑과 구분)

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// 그리기 도형
//
// 화면 좌표가 아니라 '시간(t)·가격(p)'으로 저장한다. 그래야 확대·축소하거나
// 기간을 바꿔도 도형이 원래 가리키던 자리에 그대로 붙어 있다.
// ─────────────────────────────────────────────────────────────
type Box = { t1: number; p1: number; t2: number; p2: number };

export type Drawing =
  | ({ id: string; kind: 'line' } & Box) //   선
  | ({ id: string; kind: 'arrow' } & Box) //  화살표
  | ({ id: string; kind: 'rect' } & Box) //   사각형
  | ({ id: string; kind: 'circle' } & Box) // 원
  | { id: string; kind: 'hline'; p: number } //  가로선
  | { id: string; kind: 'vline'; t: number }; // 세로선

type Tool = 'none' | 'line' | 'hline' | 'vline' | 'arrow' | 'rect' | 'circle' | 'erase';

/** 화면에 보이는 도구 팔레트 (네이버 증권 그리기와 같은 구성) */
const TOOLS: { key: Exclude<Tool, 'none' | 'erase'>; icon: string; label: string }[] = [
  { key: 'line', icon: '↗', label: '선' },
  { key: 'hline', icon: '↔', label: '가로선' },
  { key: 'vline', icon: '↕', label: '세로선' },
  { key: 'arrow', icon: '➤', label: '화살표' },
  { key: 'rect', icon: '□', label: '사각형' },
  { key: 'circle', icon: '○', label: '원' },
];

const DRAG_TOOLS: Tool[] = ['line', 'arrow', 'rect', 'circle']; // 끌어서 그리는 도구
const TAP_TOOLS: Tool[] = ['hline', 'vline', 'erase']; // 탭하는 도구

const drawKey = (symbol: string) => `chartDrawings:${symbol}`;

async function loadDrawings(symbol: string): Promise<Drawing[]> {
  try {
    const raw = await AsyncStorage.getItem(drawKey(symbol));
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // 예전 이름('trend')으로 저장된 선, 지금은 뺀 자유선('free')을 정리한다
    return (arr as Record<string, unknown>[])
      .filter((d) => d?.kind !== 'free')
      .map((d) => (d.kind === 'trend' ? { ...d, kind: 'line' } : d)) as Drawing[];
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
  /** 그린 도형을 종목별로 저장하기 위한 키. 없으면 그리기 기능이 꺼진다 */
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  // 손가락으로 그리는 중인 임시 도형 (화면 좌표)
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

  /** 도형을 화면 좌표로 (사각형·원·선·화살표 공통) */
  const boxPx = (d: Box) => ({
    ax: xOfTime(d.t1),
    ay: y(d.p1),
    bx: xOfTime(d.t2),
    by: y(d.p2),
  });

  // ── 지우개용 거리 계산 ───────────────────────────────────────
  const distToSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const distTo = (d: Drawing, px: number, py: number): number => {
    if (d.kind === 'hline') return Math.abs(py - y(d.p));
    if (d.kind === 'vline') return Math.abs(px - xOfTime(d.t));
    const { ax, ay, bx, by } = boxPx(d);
    if (d.kind === 'line' || d.kind === 'arrow') return distToSeg(px, py, ax, ay, bx, by);
    if (d.kind === 'rect') {
      // 네 변 중 가장 가까운 변까지의 거리
      return Math.min(
        distToSeg(px, py, ax, ay, bx, ay),
        distToSeg(px, py, bx, ay, bx, by),
        distToSeg(px, py, bx, by, ax, by),
        distToSeg(px, py, ax, by, ax, ay)
      );
    }
    // 원(타원) — 중심에서 본 각도의 타원 위 점까지 거리
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const rx = Math.abs(bx - ax) / 2 || 1;
    const ry = Math.abs(by - ay) / 2 || 1;
    const ang = Math.atan2((py - cy) / ry, (px - cx) / rx);
    return Math.hypot(px - (cx + rx * Math.cos(ang)), py - (cy + ry * Math.sin(ang)));
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

  // ── 제스처 ──────────────────────────────────────────────────
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

  // 도구 없음: 꾹 눌러 크로스헤어 추적
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

  // 끌어서 그리는 도구 (선·화살표·사각형·원)
  const drawPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(DRAG_TOOLS.includes(tool))
        .minDistance(2)
        .onStart((e) => setDragging({ x1: e.x, y1: e.y, x2: e.x, y2: e.y }))
        .onUpdate((e) => setDragging((p) => (p ? { ...p, x2: e.x, y2: e.y } : p)))
        .onEnd((e) => {
          setDragging((p) => {
            // 손가락을 거의 안 움직였으면 실수로 찍은 것 — 만들지 않는다
            if (p && Math.hypot(e.x - p.x1, e.y - p.y1) > 8) {
              const box: Box = { t1: timeAt(p.x1), p1: priceAt(p.y1), t2: timeAt(e.x), p2: priceAt(e.y) };
              commit([...drawings, { id: `${Date.now()}`, kind: tool as 'line' | 'arrow' | 'rect' | 'circle', ...box }]);
            }
            return null;
          });
        })
        .onFinalize(() => setDragging(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, drawings, m, plotW, plotH, minV, range, commit]
  );

  // 탭하는 도구 (가로선·세로선·지우개)
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .enabled(TAP_TOOLS.includes(tool))
        .onEnd((e) => {
          const id = `${Date.now()}`;
          if (tool === 'hline') commit([...drawings, { id, kind: 'hline', p: priceAt(e.y) }]);
          else if (tool === 'vline') commit([...drawings, { id, kind: 'vline', t: timeAt(e.x) }]);
          else eraseAt(e.x, e.y);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, drawings, m, plotW, plotH, minV, range, commit]
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

  const HINTS: Record<Tool, string> = {
    none: '두 손가락으로 확대·축소 · 꾹 누른 채 움직이면 날짜별 가격 추적',
    line: '차트 위를 끌어서 선을 그어요',
    hline: '차트를 탭하면 그 높이에 가로선이 그어져요',
    vline: '차트를 탭하면 그 날짜에 세로선이 그어져요',
    arrow: '끝나는 쪽에 화살촉이 붙어요 — 끌어서 그려요',
    rect: '대각선으로 끌어서 사각형을 그려요',
    circle: '대각선으로 끌어서 원을 그려요',
    erase: '지울 도형을 탭하세요',
  };

  /** 화살촉 삼각형 좌표 */
  const arrowHead = (ax: number, ay: number, bx: number, by: number) => {
    const ang = Math.atan2(by - ay, bx - ax);
    const L = 9;
    const W = 0.42; // 벌어지는 각(rad)
    const p1 = `${bx},${by}`;
    const p2 = `${bx - L * Math.cos(ang - W)},${by - L * Math.sin(ang - W)}`;
    const p3 = `${bx - L * Math.cos(ang + W)},${by - L * Math.sin(ang + W)}`;
    return `${p1} ${p2} ${p3}`;
  };

  const renderShape = (d: Drawing) => {
    if (d.kind === 'hline') {
      return (
        <Line key={d.id} x1={PAD_X} y1={y(d.p)} x2={width - PAD_X} y2={y(d.p)} stroke={DRAW} strokeWidth={1.5} />
      );
    }
    if (d.kind === 'vline') {
      return (
        <Line key={d.id} x1={xOfTime(d.t)} y1={PAD_TOP} x2={xOfTime(d.t)} y2={PAD_TOP + plotH} stroke={DRAW} strokeWidth={1.5} />
      );
    }
    const { ax, ay, bx, by } = boxPx(d);
    if (d.kind === 'rect') {
      return (
        <Rect
          key={d.id}
          x={Math.min(ax, bx)}
          y={Math.min(ay, by)}
          width={Math.abs(bx - ax)}
          height={Math.abs(by - ay)}
          stroke={DRAW}
          strokeWidth={1.6}
          fill="none"
        />
      );
    }
    if (d.kind === 'circle') {
      return (
        <Ellipse
          key={d.id}
          cx={(ax + bx) / 2}
          cy={(ay + by) / 2}
          rx={Math.abs(bx - ax) / 2}
          ry={Math.abs(by - ay) / 2}
          stroke={DRAW}
          strokeWidth={1.6}
          fill="none"
        />
      );
    }
    // 선 · 화살표
    return (
      <React.Fragment key={d.id}>
        <Line x1={ax} y1={ay} x2={bx} y2={by} stroke={DRAW} strokeWidth={1.8} />
        {d.kind === 'arrow' && <Polygon points={arrowHead(ax, ay, bx, by)} fill={DRAW} />}
      </React.Fragment>
    );
  };

  /** 그리는 중인 미리보기 (점선) */
  const preview = () => {
    if (!dragging) return null;
    const { x1, y1, x2, y2 } = dragging;
    if (tool === 'rect') {
      return (
        <Rect
          x={Math.min(x1, x2)}
          y={Math.min(y1, y2)}
          width={Math.abs(x2 - x1)}
          height={Math.abs(y2 - y1)}
          stroke={DRAW}
          strokeWidth={1.6}
          strokeDasharray="4 3"
          fill="none"
        />
      );
    }
    if (tool === 'circle') {
      return (
        <Ellipse
          cx={(x1 + x2) / 2}
          cy={(y1 + y2) / 2}
          rx={Math.abs(x2 - x1) / 2}
          ry={Math.abs(y2 - y1) / 2}
          stroke={DRAW}
          strokeWidth={1.6}
          strokeDasharray="4 3"
          fill="none"
        />
      );
    }
    return (
      <>
        <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={DRAW} strokeWidth={1.8} strokeDasharray="4 3" />
        {tool === 'arrow' && <Polygon points={arrowHead(x1, y1, x2, y2)} fill={DRAW} />}
      </>
    );
  };

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

      {/* 그리기 — 평소엔 버튼 하나, 펼치면 도구 팔레트 */}
      {canDraw && (
        <View style={{ gap: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ToolBtn
              label={paletteOpen ? '그리기 닫기' : '그리기'}
              icon="✏"
              active={paletteOpen}
              color={DRAW}
              onPress={() => {
                setPaletteOpen((o) => !o);
                if (paletteOpen) setTool('none'); // 닫으면 확대·추적으로 복귀
              }}
            />
            {drawings.length > 0 && (
              <Text style={{ color: colors.textDim, fontSize: 10 }}>그린 도형 {drawings.length}개</Text>
            )}
          </View>
          {paletteOpen && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {TOOLS.map((t) => (
                <ToolBtn
                  key={t.key}
                  label={t.label}
                  icon={t.icon}
                  active={tool === t.key}
                  color={DRAW}
                  onPress={() => setTool((cur) => (cur === t.key ? 'none' : t.key))}
                />
              ))}
              <ToolBtn label="지우개" icon="⌫" active={tool === 'erase'} color={colors.warn} onPress={() => setTool((cur) => (cur === 'erase' ? 'none' : 'erase'))} />
              {drawings.length > 0 && (
                <>
                  <ToolBtn label="되돌리기" icon="↶" active={false} color={colors.textDim} onPress={() => commit(drawings.slice(0, -1))} />
                  <ToolBtn label="모두 지우기" icon="🗑" active={false} color={colors.textDim} onPress={() => commit([])} />
                </>
              )}
            </View>
          )}
        </View>
      )}

      <GestureDetector gesture={gesture}>
        {/* 확대·축소로 도형이 밖으로 나가도 차트 안에서만 보이게 자른다 */}
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

            {/* 내가 그린 도형 */}
            {drawings.map(renderShape)}
            {/* 가로선은 가격, 세로선은 날짜를 옆에 적어준다 */}
            {drawings.map((d) =>
              d.kind === 'hline' ? (
                <SvgText key={`l${d.id}`} x={PAD_X + 2} y={y(d.p) - 3} fill={DRAW} fontSize={9} fontWeight="bold">
                  {formatPrice(d.p, market)}
                </SvgText>
              ) : d.kind === 'vline' ? (
                <SvgText key={`l${d.id}`} x={xOfTime(d.t)} y={PAD_TOP - 4} fill={DRAW} fontSize={9} fontWeight="bold" textAnchor="middle">
                  {fmtDate(d.t).slice(2)}
                </SvgText>
              ) : null
            )}
            {preview()}

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

      <Text style={{ color: tool === 'none' ? colors.textDim : DRAW, fontSize: 10 }}>{HINTS[tool]}</Text>
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
