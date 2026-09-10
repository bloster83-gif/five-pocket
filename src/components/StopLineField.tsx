// 프로젝트 마지노선 입력칸 (생성·수정 화면 공용)
//
// 포켓 마지노선이 '보유중 포켓 하나'의 손절선이라면, 프로젝트 마지노선은 '이 종목에서 손 뗄 선'이다.
// 정기매수법은 가격을 안 보고 계속 사기 때문에 하한선이 없으면 떨어지는 칼날을 끝까지 받는다 →
// 현재가가 이 선 이하면 보유 포켓은 팔고, 대기 포켓은 사지 않는다.

import { Text, View } from 'react-native';
import { Callout, NumberField } from '@/components/ui';
import { colors, formatPrice, spacing } from '@/theme';

export function StopLineField({
  market,
  value,
  onChange,
  price,
  editable = true,
}: {
  market: string;
  /** 마지노선 원문(콤마 없음). 빈 문자열 = 사용 안 함 */
  value: string;
  onChange: (raw: string) => void;
  /** 현재가(참고). 이미 마지노선 이하면 경고 */
  price?: number | null;
  editable?: boolean;
}) {
  const stop = Number(value) || 0;
  const below = stop > 0 && price != null && price > 0 && price <= stop;
  const pct = stop > 0 && price != null && price > 0 ? Math.round((stop / price - 1) * 1000) / 10 : null;
  return (
    <View style={{ gap: spacing.xs }}>
      <NumberField
        label="🛑 마지노선 (선택 · 이 가격 아래로는 손 뗀다)"
        value={value}
        onChangeText={onChange}
        decimals={market !== 'KRX'}
        editable={editable}
        placeholder={price != null && price > 0 ? `예: ${formatPrice(Math.round(price * 0.9), market)}` : '비워 두면 사용 안 함'}
      />
      <Callout tone={below ? 'danger' : stop > 0 ? 'warn' : 'neutral'}>
        <Text style={{ color: below ? colors.danger : stop > 0 ? colors.warn : colors.text, fontSize: 12, fontWeight: '800' }}>
          {stop > 0
            ? below
              ? `⚠️ 현재가(${formatPrice(price!, market)})가 이미 마지노선 이하예요 — 지금 만들면 가격이 선 위로 올라올 때까지 한 주도 사지 않아요.`
              : `마지노선 ${formatPrice(stop, market)}${pct != null ? ` (현재가 대비 ${pct}%)` : ''}`
            : '마지노선 없음 — 가격이 아무리 떨어져도 예정대로 계속 삽니다.'}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 11, lineHeight: 16 }}>
          현재가가 마지노선 이하로 내려가면{'\n'}
          ① 매수 예정(대기중) 포켓은 예정 시각이 와도 사지 않고 보류해요. 가격이 선 위로 돌아오면 밀린 매수부터 그대로 재개됩니다.{'\n'}
          ② 보유중 포켓은 현재가로 전량 매도해요(손절). 포켓별 🎯 수정에서 따로 넣은 마지노선이 있으면 그쪽이 우선이에요.{'\n'}
          자동매매(서버 24시간 포함)와 앱 알림 모두 같은 규칙으로 움직입니다.
        </Text>
      </Callout>
    </View>
  );
}
