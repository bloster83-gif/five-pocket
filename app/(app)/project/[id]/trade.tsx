import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, formatPrice, money, radius, spacing } from '@/theme';
import { alignToKrxTick, estimatedShares, sellTargetFromFill } from '@/domain/pockets';
import type { TradeSide } from '@/types/db';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export default function TradeScreen() {
  const { id, pocket, idx, side: sideParam, sqty, sprice, budget, mkt } = useLocalSearchParams<{
    id: string;
    pocket: string;
    idx: string;
    side?: string;
    sqty?: string;
    sprice?: string;
    budget?: string;
    mkt?: string;
  }>();
  const router = useRouter();
  const { session } = useAuth();

  // 포켓 버튼에서 넘어온 매매구분으로 고정 (선택 토글 없음)
  const side: TradeSide = sideParam === 'sell' ? 'sell' : 'buy';
  const isBuy = side === 'buy';
  const accent = isBuy ? colors.buy : colors.sell;
  const market = mkt || 'KRX';

  // 예산(매수) / 보유수량(매도) — 수량은 수정 불가, 값만 참고
  const budgetN = budget && Number(budget) > 0 ? Number(budget) : 0;
  const heldQty = sqty && Number(sqty) > 0 ? Math.round(Number(sqty)) : 0;
  const initPrice = sprice && Number(sprice) > 0 ? String(Number(sprice)) : '';

  const [price, setPrice] = useState(initPrice);
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const priceN = Number(price) || 0;
  // 매수 = 예산으로 살 수 있는 수량(체결가 기준 자동 계산), 매도 = 보유 수량 전량 (부분매도 불가)
  const lockedQty = isBuy
    ? budgetN > 0 && priceN > 0
      ? estimatedShares(budgetN, priceN)
      : heldQty
    : heldQty;

  const onSubmit = async () => {
    if (!priceN || priceN <= 0) return notify('입력 필요', '체결가를 올바르게 입력하세요.');
    if (!lockedQty || lockedQty <= 0)
      return notify('수량 없음', isBuy ? '예산으로 살 수 있는 수량이 없어요. 체결가를 확인하세요.' : '매도할 보유 수량이 없어요.');
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
      quantity: lockedQty,
      executed_at: executed.toISOString(),
      note: note.trim() || null,
    });
    if (terr) {
      setSaving(false);
      return notify('저장 실패', terr.message);
    }

    if (isBuy) {
      const { data: proj } = await supabase.from('projects').select('sell_target_pct').eq('id', id).single();
      const rawSellTarget = proj ? sellTargetFromFill(priceN, Number(proj.sell_target_pct)) : null;
      const sellTarget = rawSellTarget != null && market === 'KRX' ? alignToKrxTick(rawSellTarget, 'sell') : rawSellTarget;
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

        {/* 수량 — 수정 불가 (매수: 예산 배분 수량 / 매도: 보유 전량) */}
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            {isBuy ? '매수 수량 (예산 자동 계산)' : '매도 수량 (보유 전량)'}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: isBuy ? colors.buyBg : colors.sellBg,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: accent,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.md,
            }}
          >
            <Text style={{ color: accent, fontSize: 24, fontWeight: '900' }}>{money(lockedQty, 0)}주</Text>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>🔒 수량 고정</Text>
          </View>
          {isBuy && budgetN > 0 && (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              배분 예산 {formatPrice(budgetN, market)} ÷ 체결가 → 살 수 있는 최대 수량으로 자동 계산돼요. 부분 매수/수량 조정은
              막혀 있어요.
            </Text>
          )}
          {!isBuy && (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>보유 수량 전량을 매도해요. 부분 매도는 할 수 없어요.</Text>
          )}
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
