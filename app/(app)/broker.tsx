import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Switch, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';
import { testConnection } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

function isMissingSchema(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const s = `${err.code ?? ''} ${err.message ?? ''}`;
  return /42703|42P01|PGRST204|PGRST205|does not exist|schema cache/i.test(s);
}

export default function BrokerScreen() {
  const { session, tier } = useAuth();
  const uid = session?.user?.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [hasAccount, setHasAccount] = useState(false);

  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [productCode, setProductCode] = useState('01');
  const [isVirtual, setIsVirtual] = useState(true);

  const load = useCallback(async () => {
    if (!uid) return;
    const { data, error } = await supabase
      .from('broker_accounts')
      .select('*')
      .eq('user_id', uid)
      .maybeSingle();
    setMigrationNeeded(!!error && isMissingSchema(error));
    if (data) {
      const a = data as BrokerAccount;
      setAppKey(a.app_key);
      setAppSecret(a.app_secret);
      setAccountNo(a.account_no);
      setProductCode(a.account_product_code);
      setIsVirtual(a.is_virtual);
      setHasAccount(true);
    }
    setLoading(false);
  }, [uid]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const buildAccount = (): BrokerAccount | null => {
    if (!uid) return null;
    if (!appKey.trim() || !appSecret.trim()) {
      notify('입력 필요', 'AppKey와 AppSecret을 입력하세요.');
      return null;
    }
    const cano = accountNo.replace(/[^0-9]/g, '');
    if (cano.length !== 8) {
      notify('입력 필요', '종합계좌번호 앞 8자리를 입력하세요. (하이픈 앞부분)');
      return null;
    }
    return {
      user_id: uid,
      broker: 'KIS',
      app_key: appKey.trim(),
      app_secret: appSecret.trim(),
      account_no: cano,
      account_product_code: productCode.trim() || '01',
      is_virtual: isVirtual,
      access_token: null,
      token_expires_at: null,
      created_at: '',
      updated_at: '',
    };
  };

  const save = async () => {
    const acc = buildAccount();
    if (!acc) return;
    setSaving(true);
    const { error } = await supabase.from('broker_accounts').upsert(
      {
        user_id: acc.user_id,
        broker: acc.broker,
        app_key: acc.app_key,
        app_secret: acc.app_secret,
        account_no: acc.account_no,
        account_product_code: acc.account_product_code,
        is_virtual: acc.is_virtual,
        // 설정이 바뀌면 기존 토큰 캐시는 무효화
        access_token: null,
        token_expires_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    setSaving(false);
    if (error) {
      if (isMissingSchema(error)) {
        setMigrationNeeded(true);
        return notify('DB 준비 필요', '마이그레이션(20260716e)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('저장 실패', error.message);
    }
    setHasAccount(true);
    notify('저장 완료', '한국투자증권 계좌 정보가 저장됐어요.');
  };

  const onTest = async () => {
    const acc = buildAccount();
    if (!acc) return;
    setTesting(true);
    try {
      await testConnection(acc);
      notify('연결 성공 ✅', `${isVirtual ? '모의투자' : '실전투자'} 서버에서 접근토큰을 발급받았어요.`);
    } catch (e: any) {
      notify('연결 실패', e?.message ?? '토큰 발급에 실패했어요. 키와 계좌번호를 확인하세요.');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {migrationNeeded && (
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>DB 마이그레이션이 필요해요</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            Supabase SQL Editor에서 마이그레이션(20260716e)을 실행하면 계좌 저장이 켜집니다.
          </Text>
        </Card>
      )}

      {tier !== 'auto' && (
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>현재 Diary 등급이에요</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            계좌 정보는 미리 저장할 수 있지만, 자동 매수/매도는 관리자가 AUTO 등급으로 인증한 뒤부터 동작합니다.
          </Text>
        </Card>
      )}

      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>🏦 한국투자증권 OpenAPI</Text>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>
          한국투자증권 홈페이지 → 트레이딩 → Open API에서 신청하면 AppKey/AppSecret을 받을 수 있어요.
          처음에는 반드시 모의투자로 테스트한 뒤 실전으로 전환하세요.
        </Text>

        <Field label="AppKey" value={appKey} onChangeText={setAppKey} autoCapitalize="none" placeholder="PSxxxxxxxx..." />
        <Field
          label="AppSecret"
          value={appSecret}
          onChangeText={setAppSecret}
          autoCapitalize="none"
          secureTextEntry
          placeholder="••••••••"
        />
        <Field
          label="종합계좌번호 (앞 8자리)"
          value={accountNo}
          onChangeText={setAccountNo}
          keyboardType="number-pad"
          placeholder="예: 12345678"
        />
        <Field
          label="계좌상품코드 (뒤 2자리, 보통 01)"
          value={productCode}
          onChangeText={setProductCode}
          keyboardType="number-pad"
          placeholder="01"
        />

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: isVirtual ? colors.primary : colors.buy, fontWeight: '800' }}>
              {isVirtual ? '모의투자 (안전)' : '⚠️ 실전투자'}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              {isVirtual ? '모의투자 서버로 주문합니다. 실제 돈이 나가지 않아요.' : '실제 계좌로 주문이 나갑니다!'}
            </Text>
          </View>
          <Switch value={!isVirtual} onValueChange={(v) => setIsVirtual(!v)} />
        </View>
      </Card>

      {/* 개인정보 수집 고지 (App Store 5.1.1 대응) — 수집 항목·목적·보관·삭제를 입력 화면에서 직접 안내 */}
      <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 4 }}>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800' }}>🔒 입력 정보 안내</Text>
        <Text style={{ color: colors.textDim, fontSize: 11, lineHeight: 16 }}>
          입력한 앱키·시크릿·계좌번호는 회원 본인 계정에만 안전하게 저장되며(사용자별 접근 제한), 본인 계좌의 시세·잔고
          조회와 본인이 실행하는 주문에만 사용됩니다. 다른 용도로 사용하거나 제3자에게 제공하지 않으며, 아래 ‘연동 해제’
          또는 회원 탈퇴 시 즉시 삭제됩니다. 자세한 내용은 개인정보 처리방침을 확인하세요.
        </Text>
      </View>

      <Button title="연결 테스트 (토큰 발급)" variant="ghost" onPress={onTest} loading={testing} />
      <Button title={hasAccount ? '계좌 정보 수정 저장' : '계좌 정보 저장'} onPress={save} loading={saving} large />

      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        * 웹 브라우저에서는 한국투자증권 API가 차단(CORS)되어 폰(Expo Go/빌드)에서만 주문이 동작해요.{'\n'}
        * 접근토큰 발급은 분당 1회로 제한돼요. 연결 테스트를 너무 자주 누르면 잠시 기다려야 합니다.
      </Text>
    </ScrollView>
  );
}
