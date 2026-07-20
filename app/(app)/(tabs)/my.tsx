import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/alert';
import { Card, Row } from '@/components/ui';
import { colors, formatMoney, money, radius, signColor, spacing } from '@/theme';
import { formatPhone } from '@/lib/phoneAuth';
import { getDomesticBalance, kisOrderBlocked, type KisBalance } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

export default function MyScreen() {
  const router = useRouter();
  const { profile, tier, isAdmin, session, signOut, refreshProfile } = useAuth();

  const [account, setAccount] = useState<BrokerAccount | null | undefined>(undefined);
  const [balance, setBalance] = useState<KisBalance | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    if (!session?.user?.id) return;
    const { data } = await supabase.from('broker_accounts').select('*').eq('user_id', session.user.id).maybeSingle();
    setAccount((data as BrokerAccount) ?? null);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      refreshProfile();
      loadAccount();
    }, [loadAccount]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  const loadBalance = async () => {
    if (!account) return;
    const blocked = kisOrderBlocked('KRX');
    if (blocked) return setBalError(blocked);
    setBalLoading(true);
    setBalError(null);
    try {
      setBalance(await getDomesticBalance(account));
    } catch (e: any) {
      setBalError(e?.message ?? '잔고를 불러오지 못했어요.');
    } finally {
      setBalLoading(false);
    }
  };

  const tierExpiry = profile?.tier === 'auto' && profile?.tier_expires_at ? profile.tier_expires_at.slice(0, 10) : null;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }}>
      {/* 프로필 카드 */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: colors.cardAlt,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 26 }}>👤</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>
                {profile?.full_name ?? profile?.display_name ?? '회원'}
              </Text>
              {isAdmin && <Text style={{ fontSize: 14 }}>👑</Text>}
            </View>
            <View
              style={{
                alignSelf: 'flex-start',
                marginTop: 3,
                backgroundColor: tier === 'auto' ? colors.buyBg : colors.cardAlt,
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 2,
                borderWidth: 1,
                borderColor: tier === 'auto' ? colors.buy : colors.border,
              }}
            >
              <Text style={{ color: tier === 'auto' ? colors.buy : colors.textDim, fontWeight: '800', fontSize: 11 }}>
                {tier === 'auto' ? `AUTO 등급${tierExpiry ? ` · ~${tierExpiry}` : ''}` : 'Diary 등급'}
              </Text>
            </View>
          </View>
        </View>
      </Card>

      {/* 내 정보 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>내 정보</Text>
        <Row label="실명" value={profile?.full_name ?? '-'} />
        <Row label="이메일" value={profile?.email ?? '-'} />
        <Row
          label="휴대폰"
          value={profile?.phone ? `${formatPhone(profile.phone)}${profile.phone_verified ? '  ✓' : ''}` : '미등록'}
          valueColor={profile?.phone_verified ? colors.primary : colors.textDim}
        />
        <Row label="회원 등급" value={tier === 'auto' ? 'AUTO (자동매매)' : 'Diary (수동)'} />
        {tierExpiry && <Row label="AUTO 만료일" value={tierExpiry} valueColor={colors.warn} />}
      </Card>

      {/* 증권사 계좌 */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>🏦 한국투자증권 계좌</Text>
          <Pressable onPress={() => router.push('/broker')}>
            <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 13 }}>
              {account ? '변경 →' : '연결 →'}
            </Text>
          </Pressable>
        </View>
        {account ? (
          <>
            <Row label="계좌번호" value={`${account.account_no}-${account.account_product_code}`} />
            <Row
              label="모드"
              value={account.is_virtual ? '모의투자' : '실전투자'}
              valueColor={account.is_virtual ? colors.primary : colors.buy}
            />
          </>
        ) : (
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            아직 계좌가 연결되지 않았어요. 자동매매를 쓰려면 계좌를 연결하세요.
          </Text>
        )}
      </Card>

      {/* 보유주식 현황 (KIS 잔고) */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>📊 보유주식 현황</Text>
          {account && (
            <Pressable
              onPress={loadBalance}
              disabled={balLoading}
              style={{ backgroundColor: colors.cardAlt, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>
                {balLoading ? '조회중…' : balance ? '새로고침' : '조회'}
              </Text>
            </Pressable>
          )}
        </View>

        {!account ? (
          <Text style={{ color: colors.textDim, fontSize: 13 }}>계좌를 연결하면 실제 보유주식을 볼 수 있어요.</Text>
        ) : balLoading ? (
          <ActivityIndicator color={colors.buy} style={{ marginVertical: spacing.md }} />
        ) : balError ? (
          <Text style={{ color: colors.warn, fontSize: 12 }}>{balError}</Text>
        ) : balance ? (
          <>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>평가금액</Text>
                <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>{formatMoney(balance.totalEval, 'KRX')}</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>평가손익</Text>
                <Text style={{ color: signColor(balance.totalPnl), fontWeight: '900', fontSize: 16 }}>
                  {balance.totalPnl > 0 ? '+' : ''}
                  {formatMoney(balance.totalPnl, 'KRX')}
                </Text>
              </View>
            </View>
            <Row label="예수금 (주문가능현금)" value={formatMoney(balance.cash, 'KRX')} />

            {balance.holdings.length === 0 ? (
              <Text style={{ color: colors.textDim, fontSize: 13 }}>보유 중인 종목이 없어요.</Text>
            ) : (
              <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
                {balance.holdings.map((h) => (
                  <View
                    key={h.symbol}
                    style={{
                      borderTopWidth: 1,
                      borderTopColor: colors.border,
                      paddingTop: spacing.sm,
                    }}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ color: colors.text, fontWeight: '800' }}>{h.name}</Text>
                      <Text style={{ color: signColor(h.pnl), fontWeight: '800' }}>
                        {h.pnl > 0 ? '+' : ''}
                        {formatMoney(h.pnl, 'KRX')} ({h.pnlRate > 0 ? '+' : ''}
                        {h.pnlRate}%)
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ color: colors.textDim, fontSize: 12 }}>
                        {money(h.quantity, 0)}주 · 평단 ₩{money(h.avgPrice, 0)}
                      </Text>
                      <Text style={{ color: colors.textDim, fontSize: 12 }}>평가 {formatMoney(h.evalAmount, 'KRX')}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              * {account.is_virtual ? '모의투자' : '실전'} 계좌 실시간 잔고 · 폰(네이티브)에서만 조회돼요.
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.textDim, fontSize: 13 }}>‘조회’를 누르면 실제 계좌의 보유주식을 불러와요.</Text>
        )}
      </Card>

      {/* 관리자 바로가기 */}
      {isAdmin && (
        <Pressable onPress={() => router.push('/admin')}>
          <Card style={{ borderColor: colors.buy }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontWeight: '800' }}>👑 회원 관리 (관리자)</Text>
              <Text style={{ color: colors.accent }}>→</Text>
            </View>
          </Card>
        </Pressable>
      )}

      {/* 로그아웃 */}
      <Pressable
        onPress={() => confirmAction('로그아웃', '로그아웃할까요?', () => signOut(), '로그아웃')}
        style={{ alignItems: 'center', paddingVertical: spacing.md }}
      >
        <Text style={{ color: colors.textDim, fontWeight: '700' }}>로그아웃</Text>
      </Pressable>
    </ScrollView>
  );
}
