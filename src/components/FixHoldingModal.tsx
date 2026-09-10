// 보유수량 불일치 바로잡기
//
// 앱에 기록된 보유수량과 증권사 계좌가 어긋났을 때, 그 차이만큼을
// 골라 둔 포켓에 체결 기록으로 붙여 계좌와 맞춘다.
//
//   · 계좌가 더 많다 → 앱 밖에서 매수했거나 체결을 놓친 것 → 그 수량만큼 '매수' 기록 추가
//   · 앱이 더 많다   → 앱 밖에서 매도했거나(→ '매도' 기록 추가)
//                      체결이 중복 기록된 것(→ 매매일지에서 그 기록을 지워야 한다)
//
// 매매일지의 수동 입력은 프로젝트에 붙지 않는 독립 기록이라 이 불일치를 고치지 못한다.
// 여기서만 project_id·pocket_id 를 달아 기록하므로 프로젝트 보유수량에 제대로 반영된다.

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { supabase } from '@/lib/supabase';
import { notify } from '@/lib/alert';
import { Field, NumberField } from '@/components/ui';
import { colors, formatPrice, money, num, radius, spacing } from '@/theme';
import { alignToKrxTick, computePnL, sellTargetFromFill } from '@/domain/pockets';
import type { HoldingMismatch } from '@/services/pendingOrders';
import type { Pocket, Project, Trade } from '@/types/db';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 이 종목에서 고를 수 있는 포켓 */
export interface FixTarget {
  pocket: Pocket;
  project: Project;
  openQty: number; // 지금 이 포켓에 남아 있는 보유수량
}

export function FixHoldingModal({
  mismatch,
  targets,
  trades,
  userId,
  onClose,
  onSaved,
}: {
  mismatch: HoldingMismatch | null;
  targets: FixTarget[];
  /** 포켓별 체결 기록 (저장 후 상태를 다시 계산하는 데 쓴다) */
  trades: Record<string, Trade[]>;
  userId: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const diff = mismatch ? mismatch.heldQty - mismatch.recordedQty : 0;
  const side: 'buy' | 'sell' = diff > 0 ? 'buy' : 'sell';
  const qty = Math.abs(diff);
  const market = targets[0]?.project.market ?? 'KRX';

  const [pocketId, setPocketId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(todayStr());
  const [saving, setSaving] = useState(false);

  // 열릴 때마다 초기화 — 매도는 보유분이 있는 포켓만 고를 수 있다
  useEffect(() => {
    if (!mismatch) return;
    const first = side === 'sell' ? targets.find((t) => t.openQty > 0) : targets[0];
    setPocketId(first?.pocket.id ?? null);
    setPrice('');
    setDate(todayStr());
  }, [mismatch?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mismatch) return null;

  const chosen = targets.find((t) => t.pocket.id === pocketId) ?? null;
  const priceN = Number(price) || 0;

  const onSubmit = async () => {
    if (!userId) return;
    if (!chosen) return notify('포켓 선택 필요', '기록을 붙일 포켓을 골라 주세요.');
    if (priceN <= 0) return notify('체결가 필요', '실제 체결된 가격을 입력하세요.');
    if (side === 'sell' && chosen.openQty < qty) {
      return notify('수량 부족', `이 포켓의 보유수량(${money(chosen.openQty, 0)}주)보다 많이 팔 수는 없어요.`);
    }
    const executed = new Date(`${date}T12:00:00`);
    if (isNaN(executed.getTime())) return notify('날짜 오류', 'YYYY-MM-DD 형식으로 입력하세요.');

    setSaving(true);
    const { error } = await supabase.from('trades').insert({
      user_id: userId,
      project_id: chosen.project.id,
      pocket_id: chosen.pocket.id,
      side,
      price: priceN,
      quantity: qty,
      executed_at: executed.toISOString(),
      note: `보유수량 바로잡기 (계좌 ${money(mismatch.heldQty, 0)}주 기준)`,
    });
    if (error) {
      setSaving(false);
      return notify('저장 실패', error.message);
    }

    // 매수로 채워 넣었으면 그만큼 예산도 늘린다.
    // 배분 예산은 그대로 둔 채 보유수량만 늘리면 '사용예산 < 평가금액' 같은
    // 앞뒤 안 맞는 숫자가 나온다 (총예산 = Σ 포켓 배분액 이라는 전제도 깨진다).
    if (side === 'buy') {
      const add = priceN * qty;
      await supabase
        .from('pockets')
        .update({ budget: Number(chosen.pocket.budget ?? 0) + add })
        .eq('id', chosen.pocket.id);
      await supabase
        .from('projects')
        .update({ total_budget: Number(chosen.project.total_budget ?? 0) + add })
        .eq('id', chosen.project.id);
    }

    // 포켓 상태를 남은 보유수량으로 다시 계산
    const after = computePnL(
      [
        ...(trades[chosen.pocket.id] ?? []),
        { side, price: priceN, quantity: qty, executed_at: executed.toISOString() } as Trade,
      ],
      null
    );
    const left = Math.floor(after.totalQtyOpen);
    if (left > 0) {
      const raw = sellTargetFromFill(after.avgOpenPrice, Number(chosen.project.sell_target_pct));
      await supabase
        .from('pockets')
        .update({
          status: 'bought',
          sell_target_price: chosen.project.market === 'KRX' ? alignToKrxTick(raw, 'sell') : raw,
        })
        .eq('id', chosen.pocket.id);
    } else {
      await supabase.from('pockets').update({ status: 'sold' }).eq('id', chosen.pocket.id);
    }

    setSaving(false);
    onSaved();
    onClose();
    notify(
      '바로잡았어요',
      `${mismatch.name} ${money(qty, 0)}주를 ${side === 'buy' ? '매수' : '매도'}로 기록했어요.` +
        (side === 'buy' ? `\n배분 예산도 ${formatPrice(priceN * qty, market)} 늘렸어요.` : '') +
        '\n잠시 후 경고가 사라집니다.'
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* 자판이 올라와도 아래 버튼이 가려지지 않도록 창을 밀어 올리고, 내용은 스크롤되게 둔다 */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable
          onPress={onClose}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.warn,
              maxHeight: '100%',
            }}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
            >
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>🩹 {mismatch.name} 보유수량 바로잡기</Text>

          <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 4 }}>
            <Row label="앱 기록" value={`${money(mismatch.recordedQty, 0)}주`} color={num.position} />
            <Row label="증권사 계좌" value={`${money(mismatch.heldQty, 0)}주`} color={num.live} />
            <Row
              label="차이"
              value={`${diff > 0 ? '+' : '-'}${money(qty, 0)}주`}
              color={diff > 0 ? colors.buy : colors.sell}
            />
          </View>

          <Text style={{ color: colors.textDim, fontSize: 12, lineHeight: 18 }}>
            {side === 'buy'
              ? `계좌에 ${money(qty, 0)}주가 더 있어요. 앱 밖에서 샀거나 체결을 놓친 거예요.\n그 수량을 매수 기록으로 붙여 계좌와 맞춥니다.`
              : `앱에 ${money(qty, 0)}주가 더 잡혀 있어요.\n앱 밖에서 파셨다면 매도 기록으로 붙여 맞춥니다. 체결이 중복 기록된 거라면 이 창을 닫고 매매일지에서 그 기록을 지워 주세요.`}
          </Text>

          {/* 어느 포켓에 붙일지 */}
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>어느 포켓의 체결인가요?</Text>
            <View style={{ gap: 6 }}>
                {targets.length === 0 && (
                  <Text style={{ color: colors.warn, fontSize: 12 }}>이 종목의 진행중 프로젝트가 없어요.</Text>
                )}
                {targets.map((t) => {
                  const on = t.pocket.id === pocketId;
                  const disabled = side === 'sell' && t.openQty <= 0;
                  return (
                    <Pressable
                      key={t.pocket.id}
                      onPress={() => !disabled && setPocketId(t.pocket.id)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: spacing.md,
                        paddingVertical: 9,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: on ? colors.primary : colors.border,
                        backgroundColor: on ? 'rgba(34,211,166,0.12)' : colors.cardAlt,
                        opacity: disabled ? 0.4 : 1,
                      }}
                    >
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }}>
                        {t.project.name} · 포켓 {t.pocket.idx + 1}
                      </Text>
                      <Text style={{ color: colors.textDim, fontSize: 12 }}>보유 {money(t.openQty, 0)}주</Text>
                    </Pressable>
                  );
                })}
            </View>
          </View>

          <NumberField
            label={`체결가 (${market === 'KRX' ? '원' : '달러'})`}
            value={price}
            onChangeText={setPrice}
            decimals
            placeholder="실제 체결된 가격"
          />
          <Field label="체결 날짜" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />

          {chosen && priceN > 0 && (
            <Text style={{ color: colors.textDim, fontSize: 12, lineHeight: 18 }}>
              {chosen.project.name} 포켓 {chosen.pocket.idx + 1}에 {formatPrice(priceN, market)} × {money(qty, 0)}주{' '}
              {side === 'buy' ? '매수' : '매도'} 기록이 추가돼요.
              {side === 'buy' && (
                <Text style={{ color: num.budget }}>
                  {'\n'}배분 예산도 {formatPrice(priceN * qty, market)} 늘어나요 (총예산에 함께 반영).
                </Text>
              )}
            </Text>
          )}

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Pressable
              onPress={onClose}
              style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: colors.textDim, fontWeight: '800' }}>닫기</Text>
            </Pressable>
            <Pressable
              onPress={onSubmit}
              disabled={saving || !chosen || priceN <= 0}
              style={{
                flex: 2,
                backgroundColor: !saving && chosen && priceN > 0 ? (side === 'buy' ? colors.buy : colors.sell) : colors.border,
                borderRadius: radius.md,
                paddingVertical: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>
                {saving ? '기록 중…' : `${money(qty, 0)}주 ${side === 'buy' ? '매수' : '매도'}로 기록`}
              </Text>
            </Pressable>
          </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ color: colors.textDim, fontSize: 12 }}>{label}</Text>
      <Text style={{ color, fontSize: 14, fontWeight: '800' }}>{value}</Text>
    </View>
  );
}
