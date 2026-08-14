import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Card } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import {
  getAutoPackages,
  lastPackagesDiagnostic,
  purchaseAuto,
  restoreAuto,
  purchasesSupported,
  type PurchasePackageInfo,
} from '@/lib/purchases';
import { BackHeader } from '@/components/BackHeader';
import { verifyEntitlement } from '@/services/entitlement';

const PRIVACY_URL = 'https://bloster83-gif.github.io/five-pocket/privacy-policy.html';
// 별도 EULA 가 없으면 Apple 표준 사용약관을 사용해도 됩니다.
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 심사 규정 2.3.10: 바이너리에 다른 플랫폼(스토어) 언급 금지 → 실행 중인 플랫폼의 스토어만 표기
const STORE_NAME = Platform.OS === 'ios' ? 'App Store' : 'Google Play';

export default function UpgradeScreen() {
  const { tier, profile, refreshProfile } = useAuth();
  const supported = purchasesSupported();
  const [packages, setPackages] = useState<PurchasePackageInfo[]>([]);
  const [diag, setDiag] = useState<string | null>(null); // 상품이 안 뜰 때 원인 안내
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // 구매 중인 패키지 id

  const isAuto = tier === 'auto';
  const expiry = profile?.tier === 'auto' ? profile.tier_expires_at?.slice(0, 10) : null;

  const load = useCallback(async () => {
    if (!supported) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const pkgs = await getAutoPackages();
    setPackages(pkgs);
    // 모듈 변수는 호출 후에 채워지므로 여기서 읽어 화면에 표시
    setDiag(pkgs.length === 0 ? lastPackagesDiagnostic : null);
    setLoading(false);
  }, [supported]);

  useEffect(() => {
    load();
  }, [load]);

  // 결제 후 등급 반영.
  //  ① 서버에 구독을 직접 검증시켜 즉시 반영 (웹훅이 실패해도 여기서 살아난다)
  //  ② 그래도 아직이면 웹훅이 도착할 시간을 두고 잠깐 폴링
  const syncTier = useCallback(async () => {
    const r = await verifyEntitlement();
    await refreshProfile();
    if (r.changed) return; // 검증으로 바로 반영됨
    for (let i = 0; i < 6; i++) {
      await sleep(2500);
      await refreshProfile();
    }
  }, [refreshProfile]);

  const onBuy = async (pkg: PurchasePackageInfo) => {
    if (busy) return;
    setBusy(pkg.id);
    try {
      const ent = await purchaseAuto(pkg.id);
      if (ent.active) {
        notify('결제 완료', 'AUTO 등급이 활성화되었어요! 반영까지 잠시 걸릴 수 있어요.');
        syncTier();
      } else {
        notify('결제 확인 중', '결제는 접수됐어요. 등급 반영까지 잠시만 기다려 주세요.');
        syncTier();
      }
    } catch (e: any) {
      if (e?.userCancelled) {
        // 사용자가 결제를 취소함 — 조용히 무시
      } else {
        notify('결제 실패', e?.message ?? '결제 중 문제가 발생했어요. 다시 시도해 주세요.');
      }
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    if (busy) return;
    setBusy('restore');
    try {
      const ent = await restoreAuto();
      if (ent.active) {
        notify('복원 완료', '구매 내역을 확인했어요. 등급을 반영합니다.');
        syncTier();
      } else {
        notify('복원할 구매 없음', '이 계정에서 복원할 AUTO 구매 내역이 없어요.');
      }
    } catch (e: any) {
      notify('복원 실패', e?.message ?? '구매 복원 중 문제가 발생했어요.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
      <BackHeader fallback="/my" />
      <Text style={{ color: colors.text, fontWeight: '900', fontSize: 20 }}>🚀 오토(AUTO) 회원 업그레이드</Text>

      {isAuto && (
        <Card style={{ borderColor: colors.buy, borderWidth: 1.5 }}>
          <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 15 }}>🤖 이미 AUTO 회원이에요</Text>
          {expiry && (
            <Text style={{ color: colors.textDim, fontSize: 13 }}>만료일: {expiry} (만료 시 다이어리로 자동 전환)</Text>
          )}
        </Card>
      )}

      {/* 등급 차이 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>회원 등급 차이</Text>

        <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 6 }}>
          <Text style={{ color: colors.textDim, fontWeight: '900', fontSize: 13 }}>📔 Diary (다이어리) · 무료</Text>
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

      {/* 구매 (인앱결제) */}
      <Card style={{ borderColor: colors.primary, borderWidth: 1.5 }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>이용권 구매</Text>

        {!supported ? (
          <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
            인앱결제는 설치된 앱({STORE_NAME} 정식 버전)에서만 이용할 수 있어요.
          </Text>
        ) : loading ? (
          <View style={{ paddingVertical: spacing.lg, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : packages.length === 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
              지금은 이용권을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.
            </Text>
            {diag && (
              <Text style={{ color: colors.warn, fontSize: 11, lineHeight: 16 }}>진단: {diag}</Text>
            )}
            <Pressable onPress={load} style={{ alignSelf: 'flex-start' }}>
              <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 13 }}>다시 불러오기</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {packages.map((p) => {
              const buying = busy === p.id;
              return (
                <Pressable
                  key={p.id}
                  disabled={!!busy}
                  onPress={() => onBuy(p)}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: colors.cardAlt,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: colors.border,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.md,
                    opacity: busy && !buying ? 0.5 : 1,
                  }}
                >
                  <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>
                    {p.period || p.title}
                  </Text>
                  {buying ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>{p.priceString}</Text>
                  )}
                </Pressable>
              );
            })}

            <Pressable onPress={onRestore} disabled={!!busy} style={{ alignSelf: 'center', paddingVertical: 6 }}>
              <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 13 }}>구매 복원</Text>
            </Pressable>
          </View>
        )}

        <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
          유료 서버를 24시간 운영하므로 오토 회원은 이용료가 부과됩니다.
        </Text>
      </Card>

      {/* 구독 고지 (스토어 심사 필수 문구) */}
      <View style={{ gap: 6, paddingHorizontal: 4 }}>
        <Text style={{ color: colors.textDim, fontSize: 11, lineHeight: 17 }}>
          · 결제는 구매 확정 시 {STORE_NAME} 계정으로 청구됩니다.{'\n'}
          · 자동 갱신 구독의 경우 현재 기간 종료 24시간 전까지 해지하지 않으면 자동 갱신되며, 동일 금액이 청구됩니다.{'\n'}
          · 구독 관리 및 해지는 기기의 스토어 계정 설정에서 할 수 있습니다.{'\n'}
          · 유효 기간이 만료되면 자동으로 다이어리(무료) 등급으로 전환됩니다.
        </Text>
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
          <Pressable onPress={() => Linking.openURL(TERMS_URL)}>
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>이용약관</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL(PRIVACY_URL)}>
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>개인정보 처리방침</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
