import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Card, Field, NumberField } from '@/components/ui';
import { colors, spacing } from '@/theme';
import type { CashFlowType, Market } from '@/types/db';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const TYPES: { key: CashFlowType; label: string; color: string }[] = [
  { key: 'deposit', label: '입금', color: colors.buy },
  { key: 'withdrawal', label: '출금', color: colors.sell },
  { key: 'dividend', label: '배당금', color: colors.accent },
];

export default function CashFlowScreen() {
  const router = useRouter();
  const { session } = useAuth();
  // 통합 입력 메뉴에서 넘어온 종류 초기값 (?type=deposit|withdrawal|dividend)
  const { type: typeParam } = useLocalSearchParams<{ type?: string }>();

  const [type, setType] = useState<CashFlowType>(
    typeParam === 'withdrawal' || typeParam === 'dividend' ? typeParam : 'deposit'
  );
  const [amount, setAmount] = useState('');
  const [market, setMarket] = useState<Market>('KRX');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return notify('입력 필요', '금액을 입력하세요.');
    const occurred = new Date(`${date}T12:00:00`);
    if (isNaN(occurred.getTime())) return notify('날짜 오류', 'YYYY-MM-DD 형식으로 입력하세요.');
    if (!session?.user?.id) return;

    setSaving(true);
    const { error } = await supabase.from('cash_flows').insert({
      user_id: session.user.id,
      type,
      amount: amt,
      market,
      occurred_at: occurred.toISOString(),
      note: note.trim() || null,
    });
    setSaving(false);
    if (error) {
      if (/does not exist|schema cache|PGRST205|relation/i.test(`${error.code} ${error.message}`)) {
        return notify('DB 준비 필요', '현금흐름 기록에 필요한 마이그레이션(20260716d)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('저장 실패', error.message);
    }
    router.back();
  };

  const accent = TYPES.find((t) => t.key === type)!.color;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <Card>
        <Text style={{ color: colors.textDim }}>종류</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {TYPES.map((t) => {
            const on = type === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setType(t.key)}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: on ? t.color : colors.cardAlt }}
              >
                <Text style={{ color: on ? '#fff' : colors.text, fontWeight: '800', fontSize: 15 }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={{ color: colors.textDim }}>통화</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(['KRX', 'US'] as Market[]).map((m) => {
            const on = market === m;
            return (
              <Pressable
                key={m}
                onPress={() => setMarket(m)}
                style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: on ? colors.border : colors.cardAlt }}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>{m === 'KRX' ? '원화 ₩' : '달러 $'}</Text>
              </Pressable>
            );
          })}
        </View>

        <NumberField label="금액" value={amount} onChangeText={setAmount} decimals placeholder="예: 1,000,000" />
        <Field label="날짜" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
        <Field label="메모(선택)" value={note} onChangeText={setNote} placeholder="예: 배당 입금" />
      </Card>

      <Pressable
        onPress={onSubmit}
        disabled={saving}
        style={{ backgroundColor: accent, borderRadius: 12, paddingVertical: 18, alignItems: 'center', opacity: saving ? 0.6 : 1 }}
      >
        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 17 }}>
          {TYPES.find((t) => t.key === type)!.label} 기록 저장
        </Text>
      </Pressable>
      <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: spacing.xs }}>
        ✍️ 수기입력한 내용은 자동매매에 포함되지 않고, 매매일지·통계에만 반영돼요.
      </Text>
    </ScrollView>
  );
}
