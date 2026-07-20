import React from 'react';
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
import { colors, radius, rawNumeric, spacing, withCommas } from '@/theme';

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  large,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'buy' | 'sell';
  loading?: boolean;
  disabled?: boolean;
  large?: boolean;
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
        large && { paddingVertical: 18 },
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.btnText, large && { fontSize: 17 }, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textDim}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

// 천단위 콤마를 자동으로 보여주는 숫자 입력 (value/onChangeText 는 콤마 없는 원문)
export function NumberField({
  label,
  value,
  onChangeText,
  decimals = false,
  ...props
}: Omit<TextInputProps, 'value' | 'onChangeText'> & {
  label: string;
  value: string;
  onChangeText: (raw: string) => void;
  decimals?: boolean;
}) {
  return (
    <Field
      label={label}
      value={withCommas(value, decimals)}
      onChangeText={(t) => onChangeText(rawNumeric(t, decimals))}
      keyboardType={decimals ? 'decimal-pad' : 'number-pad'}
      {...props}
    />
  );
}

export function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.row}>
      <Text style={{ color: colors.textDim }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.text, fontWeight: '600' }}>{value}</Text>
    </View>
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
  icon,
  activeColor = colors.buy,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: string;
  activeColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: active ? `${activeColor}24` : colors.card,
        borderWidth: 1,
        borderColor: active ? activeColor : colors.border,
      }}
    >
      {icon ? <Text style={{ fontSize: 12 }}>{icon}</Text> : null}
      <Text style={{ color: active ? activeColor : colors.textDim, fontWeight: '800', fontSize: 13 }}>
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
  btn: {
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: 16, fontWeight: '700' },
  label: { color: colors.textDim, fontSize: 13 },
  input: {
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
