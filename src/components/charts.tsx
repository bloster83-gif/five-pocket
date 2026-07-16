import { Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/theme';

export interface BarGroup {
  label: string;
  bars: { value: number; color: string }[];
}

/**
 * 의존성 없는 막대 그래프 (양수 값 전용 — 자산/수익률 등).
 * 그룹당 여러 막대를 그릴 수 있어 계획(빨강) vs 실제(검정) 비교에 사용.
 * 값이 많으면 가로 스크롤.
 */
export function BarChart({
  data,
  height = 170,
  onBarPress,
  selectedIndex,
}: {
  data: BarGroup[];
  height?: number;
  onBarPress?: (index: number) => void;
  selectedIndex?: number | null;
}) {
  const max = Math.max(1, ...data.flatMap((d) => d.bars.map((b) => b.value)));
  const plotH = height - 22;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 10, paddingVertical: 4 }}>
        {data.map((d, i) => (
          <Pressable
            key={i}
            onPress={onBarPress ? () => onBarPress(i) : undefined}
            style={{
              alignItems: 'center',
              gap: 3,
              minWidth: 34,
              backgroundColor: selectedIndex === i ? colors.cardAlt : 'transparent',
              borderRadius: 6,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: plotH, gap: 3 }}>
              {d.bars.map((b, j) => (
                <View
                  key={j}
                  style={{
                    width: d.bars.length > 1 ? 9 : 16,
                    height: Math.max(2, (Math.max(b.value, 0) / max) * plotH),
                    backgroundColor: b.color,
                    borderRadius: 3,
                  }}
                />
              ))}
            </View>
            <Text style={{ color: selectedIndex === i ? colors.text : colors.textDim, fontSize: 10 }}>{d.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
      {items.map((it, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: it.color }} />
          <Text style={{ color: colors.textDim, fontSize: 12 }}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}
