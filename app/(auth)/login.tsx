import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { hasSupabaseConfig } from '@/lib/supabase';
import { completeNaverWebLogin, signInWithNaver, signInWithProvider, type SnsButton, type SnsProvider } from '@/lib/oauth';
import { Button, Card, Field } from '@/components/ui';
import { colors, spacing } from '@/theme';

// Supabase 영문 오류 메시지를 사용자 친화적 한국어로 변환
function friendly(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (/email not confirmed/i.test(msg))
    return '이메일 인증이 완료되지 않았습니다. 가입 시 받은 확인 메일의 링크를 먼저 눌러주세요.';
  if (/provider is not enabled/i.test(msg))
    return '아직 활성화되지 않은 SNS 로그인이에요. (Supabase 대시보드에서 provider를 켜야 합니다)';
  return msg;
}

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [snsLoading, setSnsLoading] = useState<SnsButton | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 웹에서 네이버 로그인 후 ?token_hash= 로 돌아온 경우 세션 수립
  useEffect(() => {
    completeNaverWebLogin().then((res) => {
      if (res?.error) setError(friendly(res.error));
    });
  }, []);

  const onSubmit = async () => {
    setError(null);
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력하세요.');
      return;
    }
    setLoading(true);
    const { error: err } = await signIn(email.trim(), password);
    setLoading(false);
    if (err) setError(friendly(err));
  };

  const onSns = async (provider: SnsProvider) => {
    setError(null);
    setSnsLoading(provider);
    const { error: err } = await signInWithProvider(provider);
    setSnsLoading(null);
    if (err) setError(friendly(err));
  };

  const onNaver = async () => {
    setError(null);
    setSnsLoading('naver');
    const { error: err } = await signInWithNaver();
    setSnsLoading(null);
    if (err) setError(friendly(err));
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: 'flex-start', paddingTop: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: spacing.xs, alignItems: 'center', marginBottom: spacing.sm }}>
          <Text style={{ color: colors.buy, fontSize: 30, fontWeight: '900' }}>5 Pocket Diary</Text>
          <Text style={{ color: colors.textDim }}>5분할 매수·매도 전략</Text>
        </View>

        {!hasSupabaseConfig && (
          <Card style={{ borderColor: colors.warn }}>
            <Text style={{ color: colors.warn, fontWeight: '700' }}>Supabase 설정 필요</Text>
            <Text style={{ color: colors.textDim }}>
              .env 파일에 EXPO_PUBLIC_SUPABASE_URL / ANON_KEY 를 넣어야 로그인이 동작합니다. (README 참고)
            </Text>
          </Card>
        )}

        <Card>
          <Field
            label="이메일"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@example.com"
          />
          <Field
            label="비밀번호"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            onSubmitEditing={onSubmit}
          />
          {error && (
            <View style={{ backgroundColor: 'rgba(248,113,113,0.12)', borderRadius: 8, padding: spacing.sm }}>
              <Text style={{ color: colors.danger }}>{error}</Text>
            </View>
          )}
          <Button title="로그인" onPress={onSubmit} loading={loading} />
        </Card>

        {/* SNS 로그인 — 처음이면 자동 회원가입 */}
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
            <Text style={{ color: colors.textDim, fontSize: 12 }}>또는 SNS로 시작</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
          </View>
          <Pressable
            onPress={() => onSns('google')}
            disabled={snsLoading != null}
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
              opacity: snsLoading && snsLoading !== 'google' ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 16 }}>🇬</Text>
            <Text style={{ color: '#1F2937', fontWeight: '800', fontSize: 15 }}>
              {snsLoading === 'google' ? '연결 중…' : 'Google로 계속하기'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onSns('kakao')}
            disabled={snsLoading != null}
            style={{
              backgroundColor: '#FEE500',
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
              opacity: snsLoading && snsLoading !== 'kakao' ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 16 }}>💬</Text>
            <Text style={{ color: '#191919', fontWeight: '800', fontSize: 15 }}>
              {snsLoading === 'kakao' ? '연결 중…' : '카카오로 계속하기'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onNaver}
            disabled={snsLoading != null}
            style={{
              backgroundColor: '#03C75A',
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
              opacity: snsLoading && snsLoading !== 'naver' ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '900', fontSize: 16 }}>N</Text>
            <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 15 }}>
              {snsLoading === 'naver' ? '연결 중…' : '네이버로 계속하기'}
            </Text>
          </Pressable>
          <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>
            SNS로 처음 로그인하면 자동으로 회원가입됩니다.
          </Text>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
          <Text style={{ color: colors.textDim }}>계정이 없으신가요?</Text>
          <Link href="/signup" style={{ color: colors.buy, fontWeight: '700' }}>
            이메일 회원가입
          </Link>
        </View>
        <View style={{ height: 120 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
