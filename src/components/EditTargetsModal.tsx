import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { colors, formatPrice, radius, rawNumeric, signColor, spacing } from '@/theme';
import { alignToKrxTick, estimatedShares } from '@/domain/pockets';
import { notify } from '@/lib/alert';
import type { Pocket } from '@/types/db';

// ---------------------------------------------------------------
// 목표 매수·매도가 수정 모달 — 시장 상황을 보며 직접 조정.
//   · 대기중 포켓: 매수 목표가 + 매도 목표가 모두 수정 가능
//   · 보유중 포켓: 이미 매수했으므로 매수 목표가는 '읽기 전용',
//                  매도 목표가 + 마지노선(손절) 가격 수정 가능
//   매수 목표가 → '현재가 대비율', 매도 목표가 → '매수가 대비 수익률' 표시.
//   KRX 는 호가단위(alignToKrxTick)로 정렬해 표시·저장(소수점 방지).
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
  onSave: (buyPrice: number, sellPrice: number | null, stopPrice: number | null) => Promise<void>;
}) {
  const isKrx = market === 'KRX';
  const dec = !isKrx; // 미국주식은 소수점 허용
  const held = avgBuy > 0; // 보유중이면 매수 목표가 수정 불가
  const [buyStr, setBuyStr] = useState('');
  const [sellStr, setSellStr] = useState('');
  const [stopStr, setStopStr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && pocket) {
      // 저장된 값을 KRX 호가단위로 정렬해 정수로 표시(40757.1 → 40800, 소수점/버그 방지)
      const b = pocket.buy_target_price;
      const s = pocket.sell_target_price;
      const st = pocket.stop_price;
      const bA = b != null ? (isKrx ? alignToKrxTick(b, 'buy') : b) : null;
      const sA = s != null ? (isKrx ? alignToKrxTick(s, 'sell') : s) : null;
      // 마지노선은 매도 주문이므로 매도 쪽 호가로 정렬
      const stA = st != null && Number(st) > 0 ? (isKrx ? alignToKrxTick(Number(st), 'sell') : Number(st)) : null;
      setBuyStr(bA != null ? String(bA) : '');
      setSellStr(sA != null ? String(sA) : '');
      setStopStr(stA != null ? String(stA) : '');
    }
  }, [visible, pocket?.buy_target_price, pocket?.sell_target_price, pocket?.stop_price, isKrx]);

  if (!pocket) return null;

  const buyInput = Number(rawNumeric(buyStr, dec)) || 0;
  const sellInput = Number(rawNumeric(sellStr, dec)) || 0;
  const stopInput = Number(rawNumeric(stopStr, dec)) || 0;

  // 실제 저장/주문에 쓰일 값 = KRX 호가단위 정렬
  const existingBuy =
    pocket.buy_target_price != null ? (isKrx ? alignToKrxTick(pocket.buy_target_price, 'buy') : pocket.buy_target_price) : 0;
  const buyVal = held ? existingBuy : isKrx ? alignToKrxTick(buyInput, 'buy') : buyInput;
  const sellVal = sellInput > 0 ? (isKrx ? alignToKrxTick(sellInput, 'sell') : sellInput) : 0;
  const stopVal = stopInput > 0 ? (isKrx ? alignToKrxTick(stopInput, 'sell') : stopInput) : 0;

  // 매수 목표가: 현재가 대비 (목표가가 현재가보다 얼마나 낮은지/높은지)
  const buyVsNow = price != null && price > 0 && buyVal > 0 ? Math.round((buyVal / price - 1) * 1000) / 10 : null;
  // 매도 목표가: 매수가 대비 수익률 (보유중=평단, 대기중=매수 목표가 기준)
  const refBuy = held ? avgBuy : buyVal;
  const sellProfit = refBuy > 0 && sellVal > 0 ? Math.round((sellVal / refBuy - 1) * 1000) / 10 : null;
  const cur = isKrx ? '₩' : '$';

  // 배분 예산으로 이 목표가에 몇 주를 살 수 있는지.
  // 0주가 되면 목록에서 숨겨져 포켓이 사라진 것처럼 보이므로 저장 자체를 막는다.
  // (보유중 포켓은 매수 목표가를 못 바꾸므로 검사 대상이 아니다)
  const buyableQty = held ? null : estimatedShares(pocket.budget, buyVal);
  const qtyBlocked = buyableQty != null && buyVal > 0 && buyableQty <= 0;

  // 마지노선 — 평균매수가 대비 손익률, 그리고 잘못 넣었을 때의 경고
  const stopProfit = avgBuy > 0 && stopVal > 0 ? Math.round((stopVal / avgBuy - 1) * 1000) / 10 : null;
  // 매도 목표가보다 높으면 매도가 아니라 손절이 먼저 걸려버린다
  const stopAboveSell = stopVal > 0 && sellVal > 0 && stopVal >= sellVal;
  // 이미 현재가가 마지노선 아래면 저장하는 순간 바로 매도된다
  const stopHitNow = stopVal > 0 && price != null && price > 0 && price <= stopVal;

  const submit = async () => {
    if (buyVal <= 0) return notify('입력 확인', '매수 목표가를 올바르게 입력해 주세요.');
    if (stopAboveSell) {
      return notify(
        '저장할 수 없어요',
        `마지노선(${formatPrice(stopVal, market)})이 매도 목표가(${formatPrice(sellVal, market)})보다 높아요.\n\n` +
          '마지노선은 매도 목표가보다 낮게 넣어 주세요.'
      );
    }
    if (qtyBlocked) {
      return notify(
        '저장할 수 없어요',
        `배분 예산 ${formatPrice(Number(pocket.budget ?? 0), market)}으로는 ${formatPrice(buyVal, market)}에 1주도 살 수 없어요.\n\n` +
          '매수 목표가를 낮추거나, 프로젝트 예산을 늘려 주세요.'
      );
    }
    setSaving(true);
    try {
      await onSave(buyVal, sellVal > 0 ? sellVal : null, stopVal > 0 ? stopVal : null);
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
              {held ? ` · 평균매수가 ${formatPrice(avgBuy, market)}` : ''}
            </Text>
          )}

          {/* 매수 목표가 — 대기중이면 수정 가능, 보유중이면 읽기 전용 */}
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.buy, fontSize: 13, fontWeight: '800' }}>매수 목표가</Text>
            {held ? (
              <>
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: colors.bg,
                    opacity: 0.7,
                  }}
                >
                  <Text style={{ color: colors.textDim, fontSize: 16, fontWeight: '800' }}>
                    {formatPrice(existingBuy, market)}
                  </Text>
                </View>
                <Text style={{ color: colors.textDim, fontSize: 12 }}>
                  이미 매수한 포켓이라 매수 목표가는 수정할 수 없어요 (매도 목표가만 조정)
                </Text>
              </>
            ) : (
              <>
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
              </>
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
                {held ? '평균매수가' : '매수 목표가'} 대비 수익률 {sellProfit > 0 ? '+' : ''}
                {sellProfit}%
              </Text>
            )}
            {isKrx && sellVal > 0 && sellInput !== sellVal && (
              <Text style={{ color: colors.textDim, fontSize: 11 }}>
                호가단위 정렬 → {formatPrice(sellVal, market)}(으)로 저장돼요
              </Text>
            )}
          </View>

          {/* 마지노선(손절) — 보유중 포켓만. 이 가격까지 떨어지면 무조건 전량 매도 */}
          {held && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.warn, fontSize: 13, fontWeight: '800' }}>🛑 마지노선 (손절가)</Text>
              <TextInput
                value={stopStr}
                onChangeText={(t) => setStopStr(rawNumeric(t, dec))}
                keyboardType="numeric"
                placeholder={`비워두면 사용 안 함 (${cur})`}
                placeholderTextColor={colors.textDim}
                style={{ ...inputStyle, borderColor: stopAboveSell ? colors.warn : colors.border }}
              />
              {stopProfit != null ? (
                <Text style={{ color: signColor(stopProfit), fontSize: 12, fontWeight: '700' }}>
                  평균매수가 대비 {stopProfit > 0 ? '+' : ''}
                  {stopProfit}%{stopProfit >= 0 ? ' · 최소 이익 확보' : ' · 손실 제한'}
                </Text>
              ) : (
                <Text style={{ color: colors.textDim, fontSize: 12 }}>
                  현재가가 이 가격 이하로 내려가면 자동으로 전량 매도해요.
                </Text>
              )}
              {stopAboveSell && (
                <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
                  ⚠️ 마지노선이 매도 목표가보다 높아요. 매도 목표가보다 낮게 넣어 주세요.
                </Text>
              )}
              {!stopAboveSell && stopHitNow && (
                <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
                  ⚠️ 현재가({formatPrice(price!, market)})가 이미 마지노선 이하예요. 저장하면 곧바로 매도 주문이 나갑니다.
                </Text>
              )}
              {isKrx && stopVal > 0 && stopInput !== stopVal && (
                <Text style={{ color: colors.textDim, fontSize: 11 }}>
                  호가단위 정렬 → {formatPrice(stopVal, market)}(으)로 저장돼요
                </Text>
              )}
            </View>
          )}

          {/* 매수 가능 수량 — 0주가 되면 목록에서 사라지므로 미리 경고한다 */}
          {buyableQty != null && buyVal > 0 && (
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: qtyBlocked ? colors.warn : colors.border,
                backgroundColor: qtyBlocked ? 'rgba(251,191,36,0.10)' : colors.cardAlt,
              }}
            >
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                매수 가능 수량 (배분 예산 {formatPrice(Number(pocket.budget ?? 0), market)})
              </Text>
              <Text style={{ color: qtyBlocked ? colors.warn : colors.buy, fontSize: 14, fontWeight: '900' }}>
                {buyableQty}주
              </Text>
            </View>
          )}
          {qtyBlocked && (
            <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
              ⚠️ 이 가격으로는 1주도 살 수 없어 저장할 수 없어요. 매수 목표가를 낮추거나 프로젝트 예산을 늘려 주세요.
            </Text>
          )}

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
            <Pressable
              onPress={onClose}
              style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center' }}
            >
              <Text style={{ color: colors.textDim, fontWeight: '800' }}>취소</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={saving || qtyBlocked || stopAboveSell}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: radius.md,
                backgroundColor: qtyBlocked || stopAboveSell ? colors.border : colors.primary,
                alignItems: 'center',
                opacity: saving ? 0.6 : 1,
              }}
            >
              <Text style={{ color: qtyBlocked || stopAboveSell ? colors.textDim : '#04121A', fontWeight: '900' }}>
                {saving ? '저장 중…' : '저장'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
