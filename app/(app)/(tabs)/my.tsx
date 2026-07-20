import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { confirmAction, notify } from '@/lib/alert';
import { Button, Card, Field, Row } from '@/components/ui';
import { StatsContent } from '@/components/StatsContent';
import { colors, formatMoney, radius, signColor, spacing } from '@/theme';
import { formatPhone, isValidPhone, onlyDigits, sendPhoneOtp, verifyPhoneOtp } from '@/lib/phoneAuth';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked, type KisBalance, type KisHolding } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

export default function MyScreen() {
  const router = useRouter();
  const { profile, tier, isAdmin, session, signOut, refreshProfile } = useAuth();

  const [account, setAccount] = useState<BrokerAccount | null | undefined>(undefined);
  const [balance, setBalance] = useState<KisBalance | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);

  // 내 정보 수정
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  // 휴대폰 변경(재인증)
  const [newPhone, setNewPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null);
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);

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

  const [usHoldings, setUsHoldings] = useState<KisHolding[]>([]);

  const loadBalance = async () => {
    if (!account) return;
    const blocked = kisOrderBlocked('KRX');
    if (blocked) return setBalError(blocked);
    setBalLoading(true);
    setBalError(null);
    try {
      // 국내 잔고(원화) 조회 — 실패하면 에러
      const dom = await getDomesticBalance(account);
      setBalance(dom);
      // 해외 잔고(달러) 조회 — 실패해도 국내는 그대로 (해외 미신청 등)
      try {
        setUsHoldings(await getOverseasBalance(account));
      } catch {
        setUsHoldings([]);
      }
    } catch (e: any) {
      setBalError(e?.message ?? '잔고를 불러오지 못했어요.');
    } finally {
      setBalLoading(false);
    }
  };

  const tierExpiry = profile?.tier === 'auto' && profile?.tier_expires_at ? profile.tier_expires_at.slice(0, 10) : null;

  // 미국 보유 요약 (달러) — 종목별 상세는 '자세히 보기' 페이지에서
  const usEval = usHoldings.reduce((s, h) => s + h.evalAmount, 0);
  const usPnl = usHoldings.reduce((s, h) => s + h.pnl, 0);

  const startEdit = () => {
    setEditName(profile?.full_name ?? profile?.display_name ?? '');
    setNewPhone(profile?.phone ? formatPhone(profile.phone) : '');
    setOtpSent(false);
    setOtpCode('');
    setDevHint(null);
    setPhoneMsg(null);
    setEditing(true);
  };

  const saveName = async () => {
    if (!session?.user?.id) return;
    if (!editName.trim()) return notify('입력 필요', '실명을 입력하세요.');
    setSavingName(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: editName.trim(), display_name: editName.trim() })
      .eq('id', session.user.id);
    setSavingName(false);
    if (error) return notify('저장 실패', error.message);
    await refreshProfile();
    notify('저장 완료', '이름이 변경됐어요.');
  };

  // 휴대폰 변경: 새 번호로 인증번호 발송 → 확인되면 서버가 프로필 갱신
  const sendNewPhoneOtp = async () => {
    setPhoneMsg(null);
    if (!isValidPhone(newPhone)) return setPhoneMsg('올바른 휴대폰 번호를 입력하세요.');
    setPhoneBusy(true);
    try {
      const res = await sendPhoneOtp(newPhone);
      setOtpSent(true);
      setDevHint(res.devMode && res.devCode ? `테스트 코드: ${res.devCode}` : null);
    } catch (e: any) {
      setPhoneMsg(e?.message ?? '인증번호 발송 실패');
    } finally {
      setPhoneBusy(false);
    }
  };

  const verifyNewPhone = async () => {
    setPhoneMsg(null);
    if (onlyDigits(otpCode).length !== 6) return setPhoneMsg('인증번호 6자리를 입력하세요.');
    setPhoneBusy(true);
    try {
      await verifyPhoneOtp(newPhone, otpCode); // 서버가 내 프로필 phone/phone_verified 갱신
      await refreshProfile();
      setOtpSent(false);
      setOtpCode('');
      setDevHint(null);
      notify('변경 완료', '휴대폰 번호가 인증·변경됐어요.');
    } catch (e: any) {
      setPhoneMsg(e?.message ?? '인증 실패');
    } finally {
      setPhoneBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
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
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>내 정보</Text>
          <Pressable onPress={() => (editing ? setEditing(false) : startEdit())}>
            <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 13 }}>{editing ? '닫기' : '✏️ 수정'}</Text>
          </Pressable>
        </View>

        {!editing ? (
          <>
            <Row label="실명" value={profile?.full_name ?? '-'} />
            <Row label="이메일" value={profile?.email ?? '-'} />
            <Row
              label="휴대폰"
              value={profile?.phone ? `${formatPhone(profile.phone)}${profile.phone_verified ? '  ✓' : ''}` : '미등록'}
              valueColor={profile?.phone_verified ? colors.primary : colors.textDim}
            />
            <Row label="회원 등급" value={tier === 'auto' ? 'AUTO (자동매매)' : 'Diary (수동)'} />
            {tierExpiry && <Row label="AUTO 만료일" value={tierExpiry} valueColor={colors.warn} />}
          </>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {/* 실명 수정 */}
            <Field label="실명" value={editName} onChangeText={setEditName} placeholder="홍길동" />
            <Button title="이름 저장" onPress={saveName} loading={savingName} />

            {/* 이메일은 변경 불가 안내 */}
            <Text style={{ color: colors.textDim, fontSize: 12 }}>이메일: {profile?.email ?? '-'} (변경 불가)</Text>

            {/* 휴대폰 변경(재인증) */}
            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.xs }}>
              <Text style={{ color: colors.textDim, fontSize: 13 }}>휴대폰 번호 변경 (재인증)</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Field
                    label=""
                    value={newPhone}
                    onChangeText={(t) => setNewPhone(formatPhone(t))}
                    keyboardType="phone-pad"
                    placeholder="010-1234-5678"
                  />
                </View>
                <Pressable
                  onPress={sendNewPhoneOtp}
                  disabled={phoneBusy || !isValidPhone(newPhone)}
                  style={{
                    height: 48,
                    paddingHorizontal: 14,
                    borderRadius: 10,
                    justifyContent: 'center',
                    backgroundColor: !isValidPhone(newPhone) ? colors.cardAlt : colors.primary,
                  }}
                >
                  <Text style={{ color: !isValidPhone(newPhone) ? colors.textDim : '#08131f', fontWeight: '800', fontSize: 13 }}>
                    {phoneBusy ? '…' : otpSent ? '재전송' : '인증번호'}
                  </Text>
                </Pressable>
              </View>
              {otpSent && (
                <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label=""
                      value={otpCode}
                      onChangeText={(t) => setOtpCode(onlyDigits(t).slice(0, 6))}
                      keyboardType="number-pad"
                      placeholder="인증번호 6자리"
                    />
                  </View>
                  <Pressable
                    onPress={verifyNewPhone}
                    disabled={phoneBusy || onlyDigits(otpCode).length !== 6}
                    style={{
                      height: 48,
                      paddingHorizontal: 14,
                      borderRadius: 10,
                      justifyContent: 'center',
                      backgroundColor: onlyDigits(otpCode).length === 6 ? colors.buy : colors.cardAlt,
                    }}
                  >
                    <Text style={{ color: onlyDigits(otpCode).length === 6 ? '#fff' : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                      인증확인
                    </Text>
                  </Pressable>
                </View>
              )}
              {devHint && <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>🔧 {devHint}</Text>}
              {phoneMsg && <Text style={{ color: colors.danger, fontSize: 12 }}>{phoneMsg}</Text>}
            </View>
          </View>
        )}
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
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>💼 보유주식 현황</Text>
          {account && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Pressable
                onPress={loadBalance}
                disabled={balLoading}
                style={{ backgroundColor: colors.cardAlt, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}
              >
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>
                  {balLoading ? '조회중…' : balance ? '새로고침' : '조회'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/holdings')}
                style={{ backgroundColor: colors.buy, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>자세히 보기 →</Text>
              </Pressable>
            </View>
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

            {balance.holdings.length === 0 && usHoldings.length === 0 ? (
              <Text style={{ color: colors.textDim, fontSize: 13 }}>보유 중인 종목이 없어요.</Text>
            ) : (
              <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
                {/* 국내/미국 요약만 (종목 상세는 '자세히 보기'에서) */}
                <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 13 }}>🇰🇷</Text>
                    <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }}>국내 {balance.holdings.length}종목</Text>
                  </View>
                  <Text style={{ color: colors.textDim, fontSize: 13 }}>평가 {formatMoney(balance.totalEval, 'KRX')}</Text>
                </View>
                <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 13 }}>🇺🇸</Text>
                    <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }}>미국 {usHoldings.length}종목</Text>
                  </View>
                  {usHoldings.length > 0 ? (
                    <Text style={{ color: signColor(usPnl), fontSize: 13, fontWeight: '700' }}>
                      평가 {formatMoney(usEval, 'US')} ({usPnl > 0 ? '+' : ''}
                      {formatMoney(usPnl, 'US')})
                    </Text>
                  ) : (
                    <Text style={{ color: colors.textDim, fontSize: 13 }}>없음</Text>
                  )}
                </View>
              </View>
            )}
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              * {account.is_virtual ? '모의투자' : '실전'} 계좌 실시간 잔고 · 폰(네이티브)에서만 조회돼요. 종목별 상세는 오른쪽
              위 ‘자세히 보기’에서 확인하세요.
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.textDim, fontSize: 13 }}>‘조회’를 누르면 실제 계좌의 보유주식을 불러와요.</Text>
        )}
      </Card>

      {/* 통계 (MY 탭에 통합) */}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm, paddingTop: spacing.lg }}>
        <StatsContent />
      </View>

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
