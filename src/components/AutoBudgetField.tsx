// 금액·수량 배분 모드에서의 '프로젝트 총 예산' 칸.
//
// 이 모드에서는 총예산 = 포켓 금액의 합이라 직접 고칠 수 없다.
// 비활성 입력칸으로 두면 '왜 안 쳐지지?'가 되므로, 입력칸이 아니라
// 자물쇠 + 점선 테두리의 '자동 계산' 표시로 바꿔 한눈에 읽기 전용임을 보여준다.

import { Text, View } from 'react-native';
import { colors, formatMoney, num, radius, spacing } from '@/theme';

export function AutoBudgetField({
  market,
  value,
  mode,
}: {
  market: string;
  /** 총예산 원문(콤마 없음). 비어 있으면 아직 포켓 금액이 없는 것 */
  value: string;
  mode: 'amount' | 'qty';
}) {
  const total = Number(value) || 0;
  const unit = market === 'KRX' ? '원' : '달러';
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.textDim, fontSize: 13 }}>
        프로젝트 총 예산 ({unit}) · <Text style={{ color: colors.warn, fontWeight: '800' }}>🔒 자동 계산</Text>
      </Text>
      <View
        style={{
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: colors.warn,
          borderRadius: radius.md,
          backgroundColor: 'rgba(251,191,36,0.08)',
          paddingHorizontal: spacing.md,
          paddingVertical: 10,
          minHeight: 48,
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <Text style={{ color: total > 0 ? num.budget : colors.textDim, fontSize: 18, fontWeight: '900' }}>
          {total > 0 ? formatMoney(total, market) : '아직 0'}
        </Text>
        <Text numberOfLines={2} style={{ color: colors.textDim, fontSize: 11 }}>
          {mode === 'qty' ? '포켓별 수량 × 매수가의 합' : '포켓별 금액의 합'}이에요. 여기서는 못 고치고, 아래 포켓 칸을 바꾸면
          따라와요. 총액을 직접 넣으려면 배분을 '비중 %'로 바꾸세요.
        </Text>
      </View>
    </View>
  );
}
