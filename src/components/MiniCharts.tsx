// 가치분석 화면용 경량 SVG 차트 (막대·라인). react-native-svg 사용.
import { View, Text, Dimensions } from 'react-native';
import Svg, { Rect, Path, Line, Circle, G, Text as SvgText } from 'react-native-svg';
import { colors, num } from '@/theme';
import type { YearValue } from '@/services/fundamentals';

const SCREEN = Dimensions.get('window').width;
const CHART_W = SCREEN - 32 - 28; // 화면폭 - 카드 좌우 패딩

/** 5년 막대그래프 — 손실(음수)은 0선 아래로, 색은 양수/음수 자동 */
export function BarChart5y({
  data,
  title,
  color,
  formatValue,
  height = 150,
}: {
  data: YearValue[];
  title: string;
  color?: string;
  formatValue: (n: number) => string;
  height?: number;
}) {
  if (!data.length) {
    return <EmptyChart title={title} />;
  }
  const w = CHART_W;
  const padTop = 22;
  const padBottom = 22;
  const plotH = height - padTop - padBottom;
  const vals = data.map((d) => d.value);
  const maxV = Math.max(0, ...vals);
  const minV = Math.min(0, ...vals);
  const range = maxV - minV || 1;
  const zeroY = padTop + (maxV / range) * plotH; // 0선의 y좌표
  const n = data.length;
  const slot = w / n;
  const barW = Math.min(slot * 0.5, 42);

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{title}</Text>
      <Svg width={w} height={height}>
        {/* 0선 */}
        <Line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke={colors.border} strokeWidth={1} />
        {data.map((d, i) => {
          const cx = slot * i + slot / 2;
          const barH = (Math.abs(d.value) / range) * plotH;
          const y = d.value >= 0 ? zeroY - barH : zeroY;
          const c = color ?? (d.value >= 0 ? colors.buy : colors.sell);
          return (
            <G key={d.year}>
              <Rect x={cx - barW / 2} y={y} width={barW} height={Math.max(barH, 1)} rx={3} fill={c} opacity={0.9} />
              {/* 값 라벨 */}
              <SvgText
                x={cx}
                y={(d.value >= 0 ? y : y + barH) + (d.value >= 0 ? -6 : 14)}
                fill={colors.textDim}
                fontSize={9}
                fontWeight="700"
                textAnchor="middle"
              >
                {formatValue(d.value)}
              </SvgText>
              {/* 연도 */}
              <SvgText x={cx} y={height - 6} fill={colors.textDim} fontSize={10} textAnchor="middle">
                {d.year.slice(2)}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

/** 라인차트 — PER 5년, 가격 시계열 등 */
export function LineChart({
  data,
  title,
  color = num.base,
  formatValue,
  showYearLabels = true,
  height = 150,
}: {
  data: YearValue[];
  title?: string;
  color?: string;
  formatValue?: (n: number) => string;
  showYearLabels?: boolean;
  height?: number;
}) {
  if (data.length < 2) {
    return title ? <EmptyChart title={title} /> : null;
  }
  const w = CHART_W;
  const padTop = 16;
  const padBottom = showYearLabels ? 20 : 8;
  const padX = 6;
  const plotH = height - padTop - padBottom;
  const vals = data.map((d) => d.value);
  const maxV = Math.max(...vals);
  const minV = Math.min(...vals);
  const range = maxV - minV || 1;
  const n = data.length;
  const x = (i: number) => padX + (i / (n - 1)) * (w - padX * 2);
  const y = (v: number) => padTop + (1 - (v - minV) / range) * plotH;
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ');
  const up = data[data.length - 1].value >= data[0].value;
  const lineColor = color === 'auto' ? (up ? colors.buy : colors.sell) : color;

  // 연도 라벨은 최대 5개만 (가격 시계열은 촘촘하니 첫·중간·끝 정도)
  const labelIdx = showYearLabels
    ? n <= 6
      ? data.map((_, i) => i)
      : [0, Math.floor(n / 2), n - 1]
    : [];

  return (
    <View style={{ gap: 6 }}>
      {title && <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{title}</Text>}
      <Svg width={w} height={height}>
        <Path d={path} stroke={lineColor} strokeWidth={2} fill="none" />
        {data.map((d, i) =>
          n <= 8 ? <Circle key={i} cx={x(i)} cy={y(d.value)} r={3} fill={lineColor} /> : null
        )}
        {/* 시작·끝 값 라벨 */}
        {formatValue && (
          <>
            <SvgText x={x(0)} y={y(data[0].value) - 6} fill={colors.textDim} fontSize={9} textAnchor="start">
              {formatValue(data[0].value)}
            </SvgText>
            <SvgText x={x(n - 1)} y={y(data[n - 1].value) - 6} fill={colors.textDim} fontSize={9} textAnchor="end">
              {formatValue(data[n - 1].value)}
            </SvgText>
          </>
        )}
        {labelIdx.map((i) => (
          <SvgText key={i} x={x(i)} y={height - 5} fill={colors.textDim} fontSize={10} textAnchor="middle">
            {data[i].year.length > 4 ? data[i].year.slice(5) : data[i].year.slice(2)}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

function EmptyChart({ title }: { title: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{title}</Text>
      <View style={{ height: 80, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>데이터 없음</Text>
      </View>
    </View>
  );
}
