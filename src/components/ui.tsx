import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { colors, fs, radius, rawNumeric, spacing, tint, withCommas } from '@/theme';

// =====================================================================
// 공용 UI 부품 — 화면들이 같은 모양을 쓰도록 여기 모아 둔다.
//   Card(제목 포함) · SectionTitle · Button · IconButton · Field/NumberField · Row
//   Pill(상태 배지) · Chip(필터) · Segmented(선택 토글) · Callout(안내 상자) · FilterBar
// 새 화면을 만들 때 인라인 스타일로 비슷한 걸 또 만들지 말고 이걸 쓸 것.
// =====================================================================

/** 안내·상태의 '톤' — 색 하나로 글자·테두리·옅은 배경을 한 번에 정한다 */
export type Tone = 'neutral' | 'primary' | 'buy' | 'sell' | 'warn' | 'danger' | 'accent';
export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'primary':
      return colors.primary;
    case 'buy':
      return colors.buy;
    case 'sell':
      return colors.sell;
    case 'warn':
      return colors.warn;
    case 'danger':
      return colors.danger;
    case 'accent':
      return colors.accent;
    default:
      return colors.textDim;
  }
}

/**
 * 카드. `title` 을 주면 카드 제목 줄(왼쪽 제목 · 오른쪽 `right`)이 같은 서식으로 들어간다.
 * 화면마다 <Text fontSize 16 fontWeight 800> 을 손으로 적지 않게.
 */
export function Card({
  children,
  style,
  title,
  subtitle,
  right,
  tone,
}: {
  children?: React.ReactNode;
  style?: ViewStyle;
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  /** 톤을 주면 테두리·배경이 옅게 물든다 (경고 카드 등) */
  tone?: Tone;
}) {
  const c = tone ? toneColor(tone) : null;
  return (
    <View style={[styles.card, c ? { borderColor: c, backgroundColor: tint(c, 0.08) } : null, style]}>
      {title ? <SectionTitle title={title} subtitle={subtitle} right={right} /> : null}
      {children}
    </View>
  );
}

/** 카드/화면 안의 구역 제목 — 왼쪽 제목(+부제), 오른쪽 작은 동작 */
export function SectionTitle({
  title,
  subtitle,
  right,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }, style]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.h2}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );
}

/** 카드 제목 오른쪽에 두는 작은 글자 동작 ('수정', '전체 보기 →') */
export function LinkText({ label, onPress, color = colors.accent }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ color, fontWeight: '800', fontSize: fs.sm + 1 }}>{label}</Text>
    </Pressable>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  large,
  small,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'buy' | 'sell';
  loading?: boolean;
  disabled?: boolean;
  large?: boolean;
  /** 카드 안의 보조 동작용 작은 버튼 */
  small?: boolean;
}) {
  const bgMap: Record<string, string> = {
    primary: colors.primary,
    danger: colors.danger,
    buy: colors.buy,
    sell: colors.sell,
    ghost: 'transparent',
  };
  const bg = bgMap[variant] ?? colors.primary;
  // 유색 버튼은 흰 글씨, ghost 는 본문색
  const fg = variant === 'ghost' ? colors.text : variant === 'primary' ? '#04121C' : '#FFFFFF';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        large && { minHeight: 56 },
        small && { minHeight: 38, paddingVertical: 8, paddingHorizontal: 14 },
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.btnText, large && { fontSize: 17 }, small && { fontSize: 13 }, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

/** 둥근 아이콘 버튼 (🔍 · 🔄 · ✕ 같은 한 글자 동작) — 크기·모양을 통일 */
export function IconButton({
  icon,
  onPress,
  active,
  size = 36,
  activeColor = colors.buy,
}: {
  icon: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  size?: number;
  activeColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? activeColor : colors.cardAlt,
        borderWidth: 1,
        borderColor: active ? activeColor : colors.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {typeof icon === 'string' ? <Text style={{ fontSize: Math.round(size * 0.42) }}>{icon}</Text> : icon}
    </Pressable>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textDim}
        style={[styles.input, props.editable === false && styles.inputDisabled]}
        {...props}
      />
    </View>
  );
}

// 천단위 콤마를 자동으로 보여주는 숫자 입력 (value/onChangeText 는 콤마 없는 원문)
//
// 입력 중에는 이 컴포넌트가 글자를 직접 들고 있는다.
// 예산 같은 값은 한 글자 칠 때마다 부모가 포켓 배분·수량·경고를 전부 다시 계산하는데,
// 그 리렌더가 입력칸까지 흔들어 키보드가 닫히던 문제를 막기 위함이다.
// (100,000 을 치려는데 '1'만 쳐도 1주도 못 사는 예산이 되어 화면이 요동치던 증상)
// 포커스가 없을 때만 부모 값을 따라간다 — '전액 입력' 같은 외부 변경은 그대로 반영된다.
export function NumberField({
  label,
  value,
  onChangeText,
  decimals = false,
  onFocus,
  onBlur,
  ...props
}: Omit<TextInputProps, 'value' | 'onChangeText'> & {
  label: string;
  value: string;
  onChangeText: (raw: string) => void;
  decimals?: boolean;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  return (
    <Field
      label={label}
      value={withCommas(text, decimals)}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        setText(value);
        onBlur?.(e);
      }}
      onChangeText={(t) => {
        const raw = rawNumeric(t, decimals);
        setText(raw);
        onChangeText(raw);
      }}
      keyboardType={decimals ? 'decimal-pad' : 'number-pad'}
      {...props}
    />
  );
}

/** 라벨 · 값 한 줄 */
export function Row({ label, value, valueColor, bold }: { label: string; value: string; valueColor?: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={{ color: colors.textDim, fontSize: fs.body - 1 }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.text, fontWeight: bold ? '800' : '700', fontSize: fs.body }}>{value}</Text>
    </View>
  );
}

/** 작은 상태 배지 — '보유중' '대기중' '한국' '자동' 처럼 한 단어 */
export function Pill({
  label,
  tone = 'neutral',
  icon,
  outline,
  size = 'sm',
}: {
  label: string;
  tone?: Tone;
  icon?: string;
  /** 테두리만 (배경 없이) */
  outline?: boolean;
  size?: 'xs' | 'sm';
}) {
  const c = toneColor(tone);
  const neutral = tone === 'neutral';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: size === 'xs' ? 6 : 8,
        paddingVertical: size === 'xs' ? 1 : 3,
        borderRadius: 999,
        backgroundColor: outline ? 'transparent' : neutral ? colors.cardAlt : tint(c, 0.16),
        borderWidth: outline ? 1 : 0,
        borderColor: c,
      }}
    >
      {icon ? <Text style={{ fontSize: size === 'xs' ? 10 : 11 }}>{icon}</Text> : null}
      <Text style={{ color: neutral ? colors.textDim : c, fontWeight: '800', fontSize: size === 'xs' ? 10 : fs.sm }}>{label}</Text>
    </View>
  );
}

/**
 * 선택 토글 — 배분(비중/금액/수량), 매수법, 간격 단위, 포켓 개수처럼 '하나를 고르는' 자리.
 * 화면마다 Pressable 로 칩을 따로 그리지 말고 이걸 쓴다. `desc` 를 주면 두 줄 카드형이 된다.
 */
export function Segmented<K extends string | number>({
  options,
  value,
  onChange,
  color = colors.primary,
  disabled,
  compact,
}: {
  options: { key: K; label: string; desc?: string }[];
  value: K;
  onChange: (k: K) => void;
  color?: string;
  disabled?: boolean;
  /** 좁은 칩 (숫자 선택처럼 개수가 많을 때) */
  compact?: boolean;
}) {
  const twoLine = options.some((o) => !!o.desc);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={String(o.key)}
            onPress={() => !disabled && onChange(o.key)}
            style={{
              flex: twoLine ? 1 : undefined,
              minWidth: compact ? 40 : undefined,
              alignItems: twoLine ? 'flex-start' : 'center',
              paddingHorizontal: compact ? 10 : 12,
              paddingVertical: twoLine ? 10 : 7,
              borderRadius: twoLine ? radius.md : 999,
              borderWidth: 1,
              borderColor: on ? color : colors.border,
              backgroundColor: on ? tint(color, 0.14) : colors.cardAlt,
              opacity: disabled ? 0.6 : 1,
              gap: 2,
            }}
          >
            <Text style={{ color: on ? color : colors.textDim, fontWeight: '800', fontSize: fs.sm + 1 }}>{o.label}</Text>
            {o.desc ? <Text style={{ color: colors.textDim, fontSize: fs.xs }}>{o.desc}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 안내 상자 — 설명·경고·성공을 같은 틀로. 왼쪽 색 띠 + 제목(선택) + 본문.
 * 'rgba(...) 배경 + 테두리' 박스를 화면마다 손으로 만들지 않게.
 */
export function Callout({
  tone = 'neutral',
  title,
  children,
  right,
  style,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  const c = toneColor(tone);
  const neutral = tone === 'neutral';
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          gap: 10,
          borderRadius: radius.md,
          backgroundColor: neutral ? colors.cardAlt : tint(c, 0.1),
          borderWidth: 1,
          borderColor: neutral ? colors.border : tint(c, 0.5),
          padding: spacing.md,
        },
        style,
      ]}
    >
      {!neutral && <View style={{ width: 3, borderRadius: 2, backgroundColor: c }} />}
      <View style={{ flex: 1, gap: 3 }}>
        {title ? <Text style={{ color: neutral ? colors.text : c, fontWeight: '800', fontSize: fs.sm + 1 }}>{title}</Text> : null}
        {typeof children === 'string' ? (
          <Text style={{ color: colors.textDim, fontSize: fs.sm, lineHeight: 17 }}>{children}</Text>
        ) : (
          children
        )}
      </View>
      {right ?? null}
    </View>
  );
}

// 미니 막대차트 아이콘 — 이모지(📈) 대체. 어느 기기에서나 동일하게 렌더링됨
export function ChartIcon({ size = 18 }: { size?: number }) {
  const w = Math.max(3, Math.round(size * 0.22));
  const gap = Math.max(2, Math.round(size * 0.12));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap, height: size }}>
      <View style={{ width: w, height: size * 0.45, backgroundColor: colors.accent, borderRadius: 2 }} />
      <View style={{ width: w, height: size, backgroundColor: colors.buy, borderRadius: 2 }} />
      <View style={{ width: w, height: size * 0.7, backgroundColor: colors.primary, borderRadius: 2 }} />
    </View>
  );
}

// 가위(손절) 아이콘 — 기본 흰색. 파란 손절 버튼 위에서 통일감 있게 표시.
export function ScissorsIcon({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={6} cy={17} r={3} stroke={color} strokeWidth={2} fill="none" />
      <Circle cx={18} cy={17} r={3} stroke={color} strokeWidth={2} fill="none" />
      <Line x1={8.2} y1={14.8} x2={20} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Line x1={15.8} y1={14.8} x2={4} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Circle cx={12} cy={10.6} r={1.1} fill={color} />
    </Svg>
  );
}

// 검색/필터 영역 공용 컨테이너 — 내용 카드(Card)와 확실히 구분되는 어두운 바
export function FilterBar({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.cardAlt,
          borderRadius: radius.lg,
          padding: spacing.sm,
          gap: spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// 빠른 검색/필터용 알약 버튼 (탭 상단 공용)
export function Chip({
  label,
  active,
  onPress,
  onLongPress,
  icon,
  activeColor = colors.buy,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** 길게 누르기 (레이더 그룹: 이름변경/삭제 메뉴) */
  onLongPress?: () => void;
  icon?: string;
  activeColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: active ? tint(activeColor, 0.14) : colors.card,
        borderWidth: 1,
        borderColor: active ? activeColor : colors.border,
      }}
    >
      {icon ? <Text style={{ fontSize: 11 }}>{icon}</Text> : null}
      <Text numberOfLines={1} style={{ color: active ? activeColor : colors.textDim, fontWeight: '800', fontSize: fs.sm }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  h2: { color: colors.text, fontWeight: '800', fontSize: fs.h2 },
  subtitle: { color: colors.textDim, fontSize: fs.sm, marginTop: 2 },
  btn: {
    borderRadius: radius.md,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: 15, fontWeight: '800' },
  label: { color: colors.textDim, fontSize: fs.sm + 1 },
  input: {
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    minHeight: 48, // 옆의 버튼(높이 48)과 정렬 맞춤
    color: colors.text,
    fontSize: 16,
  },
  inputDisabled: { opacity: 0.55 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
