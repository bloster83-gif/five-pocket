import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field } from '@/components/ui';
import { colors, spacing } from '@/theme';
import { formatPhone, isValidPhone, onlyDigits, sendPhoneOtp, verifyPhoneOtp } from '@/lib/phoneAuth';

export default function SignupScreen() {
  const { signUp } = useAuth();
  const [name, setName] = useState(''); // 실명
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');

  // 휴대폰 인증 상태
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null); // 개발모드 안내
  const verifiedPhone = useRef(''); // 인증 완료된 번호 (이후 번호 바뀌면 무효화)

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onChangePhone = (t: string) => {
    setPhone(formatPhone(t));
    // 번호가 인증된 번호와 달라지면 인증 무효화
    if (phoneVerified && onlyDigits(t) !== verifiedPhone.current) {
      setPhoneVerified(false);
      setOtpSent(false);
      setCode('');
    }
  };

  const onSendOtp = async () => {
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

  const onVerifyOtp = async () => {
    setError(null);
    if (onlyDigits(code).length !== 6) return setError('인증번호 6자리를 입력하세요.');
    setVerifying(true);
    try {
      await verifyPhoneOtp(phone, code);
      setPhoneVerified(true);
      verifiedPhone.current = onlyDigits(phone);
      setDevHint(null);
    } catch (e: any) {
      setError(e?.message ?? '인증에 실패했어요.');
    } finally {
      setVerifying(false);
    }
  };

  const onSubmit = async () => {
    setError(null);
    if (!name.trim()) return setError('실명을 입력하세요.');
    if (!email.trim()) return setError('이메일을 입력하세요.');
    if (password.length < 6) return setError('비밀번호는 6자 이상이어야 합니다.');
    if (!isValidPhone(phone)) return setError('올바른 휴대폰 번호를 입력하세요.');
    if (!phoneVerified) return setError('휴대폰 인증을 완료하세요.');

    setLoading(true);
    const { error: err, needsConfirm } = await signUp(email.trim(), password, name.trim(), {
      fullName: name.trim(),
      phone: onlyDigits(phone),
    });
    setLoading(false);
    if (err) {
      setError(/already registered/i.test(err) ? '이미 가입된 이메일입니다. 로그인해 주세요.' : err);
      return;
    }
    if (needsConfirm) setSentTo(email.trim());
  };

  // 가입 성공 + 메일 인증 필요 → 안내 화면
  if (sentTo) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' }}>
        <Card style={{ borderColor: colors.primary }}>
          <Text style={{ color: colors.primary, fontSize: 18, fontWeight: '800' }}>✉️ 확인 메일을 보냈어요</Text>
          <Text style={{ color: colors.text }}>{sentTo}</Text>
          <Text style={{ color: colors.textDim }}>
            메일함에서 "Confirm your signup" 링크를 누르면 인증이 완료됩니다. 그 후 로그인하세요.
            (메일이 안 보이면 스팸함도 확인해 보세요.)
          </Text>
        </Card>
        <Link href="/login" style={{ color: colors.primary, fontWeight: '700', textAlign: 'center' }}>
          로그인 화면으로
        </Link>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, paddingTop: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'center' }}>회원가입</Text>

        <Card>
          <Field label="실명 *" value={name} onChangeText={setName} placeholder="홍길동" />
          <Field
            label="이메일 *"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@example.com"
          />
          <Field
            label="비밀번호 * (6자 이상)"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
          />

          {/* 휴대폰 + 인증 */}
          <View style={{ gap: spacing.xs }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>휴대폰 번호 *</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Field
                  label=""
                  value={phone}
                  onChangeText={onChangePhone}
                  keyboardType="phone-pad"
                  placeholder="010-1234-5678"
                  editable={!phoneVerified}
                />
              </View>
              <Pressable
                onPress={onSendOtp}
                disabled={phoneVerified || sending || !isValidPhone(phone)}
                style={{
                  height: 48,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  justifyContent: 'center',
                  backgroundColor: phoneVerified || !isValidPhone(phone) ? colors.cardAlt : colors.primary,
                }}
              >
                <Text style={{ color: phoneVerified || !isValidPhone(phone) ? colors.textDim : '#08131f', fontWeight: '800', fontSize: 13 }}>
                  {sending ? '전송중…' : otpSent ? '재전송' : '인증번호'}
                </Text>
              </Pressable>
            </View>

            {phoneVerified ? (
              <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 13 }}>✓ 휴대폰 인증 완료</Text>
            ) : (
              otpSent && (
                <View style={{ gap: spacing.xs }}>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
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
                      onPress={onVerifyOtp}
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
              )
            )}
          </View>

          {error && (
            <View style={{ backgroundColor: 'rgba(248,113,113,0.12)', borderRadius: 8, padding: spacing.sm }}>
              <Text style={{ color: colors.danger }}>{error}</Text>
            </View>
          )}
          <Button title="가입하기" onPress={onSubmit} loading={loading} />
          <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>* 표시는 필수 입력 항목입니다.</Text>
        </Card>

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
          <Text style={{ color: colors.textDim }}>이미 계정이 있으신가요?</Text>
          <Link href="/login" style={{ color: colors.primary, fontWeight: '700' }}>
            로그인
          </Link>
        </View>
        <View style={{ height: 120 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
