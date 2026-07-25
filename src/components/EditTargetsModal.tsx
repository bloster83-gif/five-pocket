import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { colors, formatPrice, radius, rawNumeric, signColor, spacing } from '@/theme';
import { notify } from '@/lib/alert';
import type { Pocket } from '@/types/db';

// ---------------------------------------------------------------
// 목표 매수·매도가 수정 모달 — 시장 상황을 보며 직접 조정.
//   매수 목표가 입력 → '현재가 대비율'을 보여주고
//   매도 목표가 입력 → '매수가(보유 평단 또는 매수목표가) 대비 수익률'을 보여준다.
// (프로젝트 상세·포켓탭 공용)
// ---------------------------------------------------------------
export function EditTargetsModal({
  visible,
  onClose,
  pocket,
  market,
  price,
  avgBuy,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  pocket: Pocket | null;
  market: string;
  price: number | null;
  avgBuy: number; // 보유중이면 평균매수가, 대기중이면 0
  onSave: (buyPrice: number, sellPrice: number | null) => Promise<void>;
}) {
  const dec = market !== 'KRX'; // 미국주식은 소수점 허용
  const [buyStr, setBuyStr] = useState('');
  const [sellStr, setSellStr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && pocket) {
      setBuyStr(pocket.buy_target_price != null ? String(pocket.buy_target_price) : '');
      setSellStr(pocket.sell_target_price != null ? String(pocket.sell_target_price) : '');
    }
  }, [visible, pocket?.buy_target_price, pocket?.sell_target_price]);

  if (!pocket) return null;

  const buyVal = Number(rawNumeric(buyStr, dec)) || 0;
  const sellVal = Number(rawNumeric(sellStr, dec)) || 0;
  // 매수 목표가: 현재가 대비 (목표가가 현재가보다 얼마나 낮은지/높은지)
  const buyVsNow = price != null && price > 0 && buyVal > 0 ? Math.round((buyVal / price - 1) * 1000) / 10 : null;
  // 매도 목표가: 매수가 대비 수익률 (보유중=평단, 대기중=입력한 매수 목표가 기준)
  const refBuy = avgBuy > 0 ? avgBuy : buyVal;
  const sellProfit = refBuy > 0 && sellVal > 0 ? Math.round((sellVal / refBuy - 1) * 1000) / 10 : null;
  const cur = market === 'KRX' ? '₩' : '$';

  const submit = async () => {
    if (buyVal <= 0) return notify('입력 확인', '매수 목표가를 올바르게 입력해 주세요.');
    setSaving(true);
    try {
      await onSave(buyVal, sellVal > 0 ? sellVal : null);
    } catch (e: any) {
      notify('저장 실패', e?.message ?? '목표가를 저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800' as const,
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
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
            borderColor: colors.border,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 17 }}>🎯 포켓 {pocket.idx + 1} 목표가 수정</Text>
          {price != null && (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              현재가 {formatPrice(price, market)}
              {avgBuy > 0 ? ` · 평균매수가 ${formatPrice(avgBuy, market)}` : ''}
            </Text>
          )}

          {/* 매수 목표가 + 현재가 대비율 */}
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.buy, fontSize: 13, fontWeight: '800' }}>매수 목표가</Text>
            <TextInput
              value={buyStr}
              onChangeText={(t) => setBuyStr(rawNumeric(t, dec))}
              keyboardType="numeric"
              placeholder={`매수 목표가 (${cur})`}
              placeholderTextColor={colors.textDim}
              style={inputStyle}
            />
            {buyVsNow != null && (
              <Text style={{ color: signColor(buyVsNow), fontSize: 12, fontWeight: '700' }}>
                현재가 대비 {buyVsNow > 0 ? '+' : ''}
                {buyVsNow}%{buyVsNow < 0 ? ' (현재가보다 낮게 매수)' : buyVsNow > 0 ? ' (현재가보다 높게 매수)' : ''}
              </Text>
            )}
          </View>

          {/* 매도 목표가 + 매수가 대비 수익률 */}
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.sell, fontSize: 13, fontWeight: '800' }}>매도 목표가</Text>
            <TextInput
              value={sellStr}
              onChangeText={(t) => setSellStr(rawNumeric(t, dec))}
              keyboardType="numeric"
              placeholder={`매도 목표가 (${cur})`}
              placeholderTextColor={colors.textDim}
              style={inputStyle}
            />
            {sellProfit != null && (
              <Text style={{ color: signColor(sellProfit), fontSize: 12, fontWeight: '700' }}>
                {avgBuy > 0 ? '평균매수가' : '매수 목표가'} 대비 수익률 {sellProfit > 0 ? '+' : ''}
                {sellProfit}%
              </Text>
            )}
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
            <Pressable
              onPress={onClose}
              style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}
            >
              <Text style={{ color: colors.textDim, fontWeight: '800' }}>취소</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={saving}
              style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', opacity: saving ? 0.6 : 1 }}
            >
              <Text style={{ color: '#04121A', fontWeight: '900' }}>{saving ? '저장 중…' : '저장'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
