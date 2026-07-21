import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { notify } from '@/lib/alert';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field } from '@/components/ui';
import { colors, spacing } from '@/theme';
import { formatPhone, isValidPhone, onlyDigits, sendPhoneOtp, verifyPhoneOtp } from '@/lib/phoneAuth';

// SNS 로그인(또는 번호 미등록) 후 실명 등록 + 휴대폰 인증을 요구하는 게이트 화면
export default function VerifyPhoneScreen() {
  const router = useRouter();
  const { session, profile, refreshProfile, signOut } = useAuth();

  const [name, setName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ? formatPhone(profile.phone) : '');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSend = async () => {
    setError(null);
    if (!isValidPhone(phone)) return setError('올바른 휴대폰 번호를 입력하세요.');
    setSending(true);
    try {
      const res = await sendPhoneOtp(phone);
      setOtpSent(true);
      setDevHint(res.devMode && res.devCode ? `테스트 코드: ${res.devCode} (문자 발송사 미설정)` : null);
    } catch (e: any) {
      setError(e?.message ?? '인증번호 발송에 실패했어요.');
    } finally {
      setSending(false);
    }
  };

  const onVerify = async () => {
    setError(null);
    if (!name.trim()) return setError('실명을 입력하세요.');
    if (onlyDigits(code).length !== 6) return setError('인증번호 6자리를 입력하세요.');
    setVerifying(true);
    try {
      await verifyPhoneOtp(phone, code); // 서버가 내 프로필의 phone/phone_verified 를 갱신
      // 실명 저장 (본인 프로필만 갱신 — RLS 'profiles self')
      if (session?.user?.id) {
        await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', session.user.id);
      }
      await refreshProfile();
      notify('가입을 환영합니다! 🎉', `${name.trim()}님, 5 Pocket Diary 가입이 완료되었어요.`);
      router.replace('/'); // 게이트 통과 → 앱으로
    } catch (e: any) {
      setError(e?.message ?? '인증에 실패했어요.');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <Text style={{ fontSize: 40 }}>📱</Text>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900' }}>실명 등록 · 휴대폰 인증</Text>
          <Text style={{ color: colors.textDim, textAlign: 'center', fontSize: 13 }}>
            안전한 이용을 위해 실명과 휴대폰 번호를 등록하고 인증해 주세요.{'\n'}완료해야 앱을 사용할 수 있습니다.
          </Text>
        </View>

        <Card>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>실명</Text>
          <Field
            label=""
            value={name}
            onChangeText={setName}
            placeholder="예: 홍길동"
            autoCapitalize="none"
          />
          <Text style={{ color: colors.textDim, fontSize: 13, marginTop: spacing.sm }}>휴대폰 번호</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Field
                label=""
                value={phone}
                onChangeText={(t) => setPhone(formatPhone(t))}
                keyboardType="phone-pad"
                placeholder="010-1234-5678"
              />
            </View>
            <Pressable
              onPress={onSend}
              disabled={sending || !isValidPhone(phone)}
              style={{
                height: 48,
                paddingHorizontal: 14,
                borderRadius: 10,
                justifyContent: 'center',
                backgroundColor: !isValidPhone(phone) ? colors.cardAlt : colors.primary,
              }}
            >
              <Text style={{ color: !isValidPhone(phone) ? colors.textDim : '#08131f', fontWeight: '800', fontSize: 13 }}>
                {sending ? '전송중…' : otpSent ? '재전송' : '인증번호'}
              </Text>
            </Pressable>
          </View>

          {otpSent && (
            <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
              <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Field
                    label=""
                    value={code}
                    onChangeText={(t) => setCode(onlyDigits(t).slice(0, 6))}
                    keyboardType="number-pad"
                    placeholder="인증번호 6자리"
                  />
                </View>
                <Pressable
                  onPress={onVerify}
                  disabled={verifying || onlyDigits(code).length !== 6}
                  style={{
                    height: 48,
                    paddingHorizontal: 14,
                    borderRadius: 10,
                    justifyContent: 'center',
                    backgroundColor: onlyDigits(code).length === 6 ? colors.buy : colors.cardAlt,
                  }}
                >
                  <Text style={{ color: onlyDigits(code).length === 6 ? '#fff' : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                    {verifying ? '확인중…' : '인증확인'}
                  </Text>
                </Pressable>
              </View>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>인증번호는 5분간 유효해요.</Text>
              {devHint && <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>🔧 {devHint}</Text>}
            </View>
          )}

          {error && (
            <View style={{ backgroundColor: 'rgba(248,113,113,0.12)', borderRadius: 8, padding: spacing.sm, marginTop: spacing.sm }}>
              <Text style={{ color: colors.danger }}>{error}</Text>
            </View>
          )}
        </Card>

        <Button title="다른 계정으로 로그인" variant="ghost" onPress={signOut} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
