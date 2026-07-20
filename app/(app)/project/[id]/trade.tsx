import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, spacing, withCommas } from '@/theme';
import { sellTargetFromFill } from '@/domain/pockets';
import type { TradeSide } from '@/types/db';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export default function TradeScreen() {
  const { id, pocket, idx, side: sideParam, sqty, sprice } = useLocalSearchParams<{
    id: string;
    pocket: string;
    idx: string;
    side?: string;
    sqty?: string;
    sprice?: string;
  }>();
  const router = useRouter();
  const { session } = useAuth();

  // 포켓 버튼에서 넘어온 매매구분으로 고정 (선택 토글 없음)
  const side: TradeSide = sideParam === 'sell' ? 'sell' : 'buy';
  const isBuy = side === 'buy';
  const accent = isBuy ? colors.buy : colors.sell;

  const initQty = sqty && Number(sqty) > 0 ? String(Math.round(Number(sqty))) : '';
  const initPrice = sprice && Number(sprice) > 0 ? String(Number(sprice)) : '';

  const [price, setPrice] = useState(initPrice);
  const [qty, setQty] = useState(initQty);
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const stepQty = (delta: number) => {
    const n = Math.max(0, (Number(qty) || 0) + delta);
    setQty(String(n));
  };

  const onSubmit = async () => {
    const priceN = Number(price);
    const qtyN = Number(qty);
    if (!priceN || priceN <= 0) return notify('입력 필요', '체결가를 올바르게 입력하세요.');
    if (!qtyN || qtyN <= 0) return notify('입력 필요', '수량을 올바르게 입력하세요.');
    const executed = new Date(`${date}T12:00:00`);
    if (isNaN(executed.getTime())) return notify('날짜 오류', '체결 날짜를 YYYY-MM-DD 형식으로 입력하세요.');
    if (!session?.user?.id || !id || !pocket) return;

    setSaving(true);
    const { error: terr } = await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: id,
      pocket_id: pocket,
      side,
      price: priceN,
      quantity: qtyN,
      executed_at: executed.toISOString(),
      note: note.trim() || null,
    });
    if (terr) {
      setSaving(false);
      return notify('저장 실패', terr.message);
    }

    if (isBuy) {
      const { data: proj } = await supabase.from('projects').select('sell_target_pct').eq('id', id).single();
      const sellTarget = proj ? sellTargetFromFill(priceN, Number(proj.sell_target_pct)) : null;
      await supabase.from('pockets').update({ status: 'bought', sell_target_price: sellTarget }).eq('id', pocket);
    } else {
      await supabase.from('pockets').update({ status: 'sold' }).eq('id', pocket);
    }

    setSaving(false);
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {/* 매매구분 고정 표시 (토글 없음) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View style={{ backgroundColor: accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>{isBuy ? '매수' : '매도'}</Text>
        </View>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>
          포켓 {idx != null ? Number(idx) + 1 : ''} 체결 기록
        </Text>
      </View>

      <Card>
        <NumberField label="체결가" value={price} onChangeText={setPrice} decimals placeholder="실제 체결된 가격" />

        {/* 수량 + 증감 버튼 (제안 수량 자동 입력) */}
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            수량 (주){initQty ? `  · 제안 ${withCommas(initQty)}주` : ''}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Pressable onPress={() => stepQty(-1)} style={stepBtn}>
              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900' }}>－</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <NumberField label="" value={qty} onChangeText={setQty} placeholder="0" />
            </View>
            <Pressable onPress={() => stepQty(1)} style={stepBtn}>
              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900' }}>＋</Text>
            </Pressable>
          </View>
        </View>

        <Field label="체결 날짜" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
        <Field label="메모(선택)" value={note} onChangeText={setNote} placeholder="예: 분할매수 1차" />
      </Card>

      <Button
        title={isBuy ? '매수 기록 저장' : '매도 기록 저장'}
        variant={isBuy ? 'buy' : 'sell'}
        large
        onPress={onSubmit}
        loading={saving}
      />
    </ScrollView>
  );
}

const stepBtn = {
  width: 48,
  height: 48,
  borderRadius: 12,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.cardAlt,
  borderWidth: 1,
  borderColor: colors.border,
};
