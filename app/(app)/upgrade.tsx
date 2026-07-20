import { ScrollView, Text, View } from 'react-native';
import { Card } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';

// 다이어리 vs 오토 등급 차이
const DIARY = [
  '5분할 매수·매도 일지, 포켓 관리',
  '목표가 도달 알림 확인 후 직접(수동) 매매',
  '실시간 시세 추적 · 통계 · 인생목표 등 기본 기능',
];
const AUTO = [
  '다이어리 기능 전부 포함',
  '목표가 도달 시 한국투자증권(KIS)으로 자동 주문 (국내·미국)',
  '24시간 무인 자동매매 (서버 자동 실행)',
  '기간제(1개월·6개월·1년), 만료 시 다이어리로 자동 전환',
];

export default function UpgradeScreen() {
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
      <Text style={{ color: colors.text, fontWeight: '900', fontSize: 20 }}>🚀 오토(AUTO) 회원 업그레이드</Text>

      {/* 등급 차이 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>회원 등급 차이</Text>

        <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 6 }}>
          <Text style={{ color: colors.textDim, fontWeight: '900', fontSize: 13 }}>📔 Diary (다이어리) · 기본</Text>
          {DIARY.map((t) => (
            <Text key={t} style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>
              · {t}
            </Text>
          ))}
        </View>

        <View style={{ backgroundColor: colors.buyBg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.buy, padding: spacing.md, gap: 6 }}>
          <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 13 }}>🤖 AUTO (오토) · 자동매매</Text>
          {AUTO.map((t) => (
            <Text key={t} style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>
              · {t}
            </Text>
          ))}
        </View>
      </Card>

      {/* 이용료 (기간별) */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>이용료 (기간 선택)</Text>
        {[
          { period: '1개월', price: '30,000원', note: null as string | null },
          { period: '6개월', price: '170,000원', note: '5% 할인' },
          { period: '12개월', price: '324,000원', note: '10% 할인' },
        ].map((p) => (
          <View
            key={p.period}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: colors.cardAlt,
              borderRadius: radius.md,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>{p.period}</Text>
              {p.note && (
                <View style={{ backgroundColor: colors.buyBg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ color: colors.buy, fontWeight: '800', fontSize: 11 }}>{p.note}</Text>
                </View>
              )}
            </View>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>{p.price}</Text>
          </View>
        ))}
        <Text style={{ color: colors.textDim, fontSize: 11 }}>기간이 길수록 할인이 적용돼요. 만료 시 다이어리 등급으로 자동 전환됩니다.</Text>
      </Card>

      {/* 업그레이드 방법 */}
      <Card style={{ borderColor: colors.primary, borderWidth: 1.5 }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>업그레이드 방법</Text>
        <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
          원하는 기간의 이용료를 아래 계좌로 입금해 주세요. 입금 확인 후 관리자 승인으로 AUTO 등급으로 전환됩니다.
        </Text>

        <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>은행</Text>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>토스뱅크</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>계좌번호</Text>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>1002-6353-8789</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>예금주</Text>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>이지훈</Text>
          </View>
        </View>

        <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
          ※ 입금자명을 가입 시 실명과 동일하게 해주셔야 확인이 빨라요.
        </Text>
      </Card>

      {/* 환불 안내 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>환불 안내</Text>
        <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
          결제(입금) 후 <Text style={{ color: colors.text, fontWeight: '800' }}>2주(14일) 이내</Text> 해지 시 이미 이용한 일수를
          일할 계산하여 남은 금액을 환불합니다. <Text style={{ color: colors.text, fontWeight: '800' }}>2주(14일)를 초과</Text>한
          경우 환불이 불가합니다. (가입 동의서 기준)
        </Text>
      </Card>

      <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center' }}>
        입금 후에도 등급이 바뀌지 않으면 관리자에게 문의해 주세요.
      </Text>
    </ScrollView>
  );
}
