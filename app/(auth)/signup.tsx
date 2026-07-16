import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field } from '@/components/ui';
import { colors, spacing } from '@/theme';

export default function SignupScreen() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력하세요.');
      return;
    }
    if (password.length < 6) {
      setError('비밀번호는 6자 이상이어야 합니다.');
      return;
    }
    setLoading(true);
    const { error: err, needsConfirm } = await signUp(
      email.trim(),
      password,
      name.trim() || email.split('@')[0]
    );
    setLoading(false);
    if (err) {
      setError(/already registered/i.test(err) ? '이미 가입된 이메일입니다. 로그인해 주세요.' : err);
      return;
    }
    if (needsConfirm) {
      setSentTo(email.trim());
    }
    // needsConfirm=false 이면 자동 로그인되어 루트 게이트가 홈으로 보냄
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
      <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'center' }}>
        회원가입
      </Text>
      <Card>
        <Field label="이름(표시용)" value={name} onChangeText={setName} placeholder="홍길동" />
        <Field
          label="이메일"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <Field
          label="비밀번호 (6자 이상)"
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
        <Button title="가입하기" onPress={onSubmit} loading={loading} />
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
