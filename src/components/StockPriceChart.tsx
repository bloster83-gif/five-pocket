// 가치분석 화면용 인터랙티브 가격 차트
//  · 두 손가락 핀치: 확대(최근 구간)·축소(전체)
//  · 꾹 누른 채 드래그: 크로스헤어로 날짜·가격 추적
//  · 상승=빨강(buy) / 하락=파랑(sell) — 한국 관례
import { useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { colors, formatPrice, num } from '@/theme';
import type { SeriesPoint } from '@/services/prices/yahooProvider';

const PAD_TOP = 14;
const PAD_BOT = 20;
const PAD_X = 6;
const MIN_VISIBLE = 15; // 최대 확대 시 보이는 포인트 수

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export function StockPriceChart({
  points,
  market,
  width,
  height = 210,
}: {
  points: SeriesPoint[];
  market: string;
  width: number;
  height?: number;
}) {
  const n = points.length;
  const [zoom, setZoom] = useState(1); // 1=전체, 커질수록 최근 구간 확대
  const [touchIdx, setTouchIdx] = useState<number | null>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const pinchBase = useRef(1);

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

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => {
          pinchBase.current = zoomRef.current;
        })
        .onUpdate((e) => {
          const maxZoom = Math.max(1, n / MIN_VISIBLE);
          setZoom(Math.min(maxZoom, Math.max(1, pinchBase.current * e.scale)));
        }),
    [n]
  );
  const track = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activateAfterLongPress(200) // 꾹 누르면 추적 시작 (스크롤과 충돌 방지)
        .onStart((e) => setTouchIdx(idxFromX(e.x)))
        .onUpdate((e) => setTouchIdx(idxFromX(e.x)))
        .onEnd(() => setTouchIdx(null))
        .onFinalize(() => setTouchIdx(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, plotW]
  );
  const gesture = useMemo(() => Gesture.Simultaneous(pinch, track), [pinch, track]);

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

      <GestureDetector gesture={gesture}>
        <View>
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

      <Text style={{ color: colors.textDim, fontSize: 10 }}>
        두 손가락으로 확대·축소 · 꾹 누른 채 움직이면 날짜별 가격 추적
      </Text>
    </View>
  );
}
