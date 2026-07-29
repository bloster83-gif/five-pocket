import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Row } from '@/components/ui';
import { colors, formatMoney, money, num, radius, signColor, spacing } from '@/theme';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked, type KisBalance, type KisHolding } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

// 보유주식 상세 — MY 탭의 '자세히 보기'에서 진입. 국내/미국 잔고를 한 페이지에 자세히.
export default function HoldingsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [account, setAccount] = useState<BrokerAccount | null | undefined>(undefined);
  const [balance, setBalance] = useState<KisBalance | null>(null);
  const [usHoldings, setUsHoldings] = useState<KisHolding[]>([]);
  const [usCash, setUsCash] = useState(0);
  const [usFx, setUsFx] = useState(0); // KIS 고시환율 (USD→KRW)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session?.user?.id) return;
    setLoading(true);
    setError(null);
    const { data } = await supabase.from('broker_accounts').select('*').eq('user_id', session.user.id).maybeSingle();
    const acc = (data as BrokerAccount) ?? null;
    setAccount(acc);
    if (!acc) {
      setLoading(false);
      return;
    }
    const blocked = kisOrderBlocked('KRX');
    if (blocked) {
      setError(blocked);
      setLoading(false);
      return;
    }
    // 국내·해외 병렬 조회 (미국주식이 국내 조회를 기다리지 않고 빠르게 반영)
    const pDom = getDomesticBalance(acc)
      .then((dom) => setBalance(dom))
      .catch((e) => setError(e?.message ?? '잔고를 불러오지 못했어요.'));
    const pOv = getOverseasBalance(acc)
      .then((ov) => {
        setUsHoldings(ov.holdings);
        setUsCash(ov.cash);
        setUsFx(ov.exchangeRate ?? 0);
      })
      .catch(() => {
        setUsHoldings([]);
        setUsCash(0);
        setUsFx(0);
      });
    await Promise.allSettled([pDom, pOv]);
    setLoading(false);
  }, [session?.user?.id]);

  // 진입할 때마다 최신 잔고로 새로고침
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const krHoldings = balance?.holdings ?? [];
  const usEval = usHoldings.reduce((s, h) => s + h.evalAmount, 0);
  const usPnl = usHoldings.reduce((s, h) => s + h.pnl, 0);
  // KIS 고시환율 우선 (계좌와 동일한 환산), 못 받으면 1500 폴백
  const USD_KRW = usFx > 0 ? usFx : 1500;
  const pctOf = (pnl: number, eval_: number) => {
    const cost = eval_ - pnl;
    return cost > 0 ? Math.round((pnl / cost) * 1000) / 10 : null; // 손익률(소수점 첫째)
  };
  const krEval = balance?.totalEval ?? 0;
  const krPnl = balance?.totalPnl ?? 0;
  const krCash = balance?.cash ?? 0;
  const krRate = pctOf(krPnl, krEval);
  const usRate = pctOf(usPnl, usEval);
  // 국내는 KIS 가 계산한 계좌 총평가금액(tot_evlu_amt)을 그대로 사용 (증권사 앱과 동일).
  // 필드가 없으면 기존 방식(평가+예수금)으로 폴백.
  const krTotal = balance?.totalAsset && balance.totalAsset > 0 ? balance.totalAsset : krEval + krCash;
  const totalAssetKRW = krTotal + (usEval + usCash) * USD_KRW;

  // 어떤 상태에서도 항상 안정적인 뒤로가기 버튼을 유지 (헤더 리렌더로 기본 < 가 씹히는 문제 방지)
  const screen = (
    <Stack.Screen
      options={{
        headerLeft: () => (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/my'))}
            hitSlop={20}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.cardAlt,
              borderWidth: 1,
              borderColor: colors.border,
              marginLeft: spacing.sm,
              marginRight: spacing.sm,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', marginTop: -3 }}>‹</Text>
          </Pressable>
        ),
      }}
    />
  );

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        {screen}
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  if (!account) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {screen}
        <Card>
          <Text style={{ color: colors.textDim }}>계좌를 연결하면 실제 보유주식을 볼 수 있어요.</Text>
        </Card>
      </ScrollView>
    );
  }

  if (error) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {screen}
        <Card>
          <Text style={{ color: colors.warn }}>{error}</Text>
          <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 4 }}>
            실계좌 잔고는 폰(네이티브)에서만 조회돼요.
          </Text>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
      {screen}
      {/* 총자산 (원화 환산) — 맨 위 + 새로고침 */}
      <Card style={{ borderColor: colors.primary, borderWidth: 1.5 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>💰 총 자산 (원화 환산)</Text>
          <Pressable onPress={load} style={{ backgroundColor: colors.cardAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>↻ 새로고침</Text>
          </Pressable>
        </View>
        <Text style={{ color: num.evalTotal, fontWeight: '900', fontSize: 26 }}>{formatMoney(totalAssetKRW, 'KRX')}</Text>
        <Text style={{ color: colors.textDim, fontSize: 11 }}>
          국내(계좌 총자산 그대로) + 미국(평가+예수금)×
          {usFx > 0 ? `고시환율 ₩${money(usFx, 2)}` : '환율 ₩1,500(고시환율 조회 실패 시)'}
        </Text>
      </Card>

      {/* 국내(원화) — 요약 + 종목을 흰색 테두리로 묶음 */}
      <View style={{ borderColor: colors.text, borderWidth: 1.5, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.sm }}>
        {/* 국내 요약 */}
        <Card>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>🇰🇷 국내 (원화)</Text>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>평가금액</Text>
              <Text style={{ color: num.evalTotal, fontWeight: '900', fontSize: 16 }}>{formatMoney(balance?.totalEval ?? 0, 'KRX')}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>평가손익{krRate != null ? ` (${krRate > 0 ? '+' : ''}${krRate}%)` : ''}</Text>
              <Text style={{ color: signColor(krPnl), fontWeight: '900', fontSize: 16 }}>
                {krPnl > 0 ? '+' : ''}
                {formatMoney(krPnl, 'KRX')}
              </Text>
            </View>
          </View>
          <Row label="예수금 (D+2 정산·원화)" value={formatMoney(krCash, 'KRX')} valueColor={num.budget} />
          <Row label="국내 보유 종목" value={`${krHoldings.length}종목`} />
        </Card>

        {/* 국내 종목 상세 */}
        <Card>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>🇰🇷 국내 종목 ({krHoldings.length})</Text>
          {krHoldings.length === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13 }}>보유 중인 국내 종목이 없어요.</Text>
          ) : (
            krHoldings.map((h) => <HoldingRow key={`KRX-${h.symbol}`} h={h} />)
          )}
        </Card>
      </View>

      {/* 미국(달러) — 요약 + 종목을 파란 테두리로 묶음 */}
      <View style={{ borderColor: colors.accent, borderWidth: 1.5, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.sm }}>
        {/* 미국 요약 */}
        <Card>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>🇺🇸 미국 (달러)</Text>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>평가금액</Text>
              <Text style={{ color: num.evalTotal, fontWeight: '900', fontSize: 16 }}>{formatMoney(usEval, 'US')}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>평가손익{usRate != null ? ` (${usRate > 0 ? '+' : ''}${usRate}%)` : ''}</Text>
              <Text style={{ color: signColor(usPnl), fontWeight: '900', fontSize: 16 }}>
                {usPnl > 0 ? '+' : ''}
                {formatMoney(usPnl, 'US')}
              </Text>
            </View>
          </View>
          <Row label="예수금 (주문가능·달러)" value={formatMoney(usCash, 'US')} valueColor={num.budget} />
          <Row label="미국 보유 종목" value={`${usHoldings.length}종목`} />
        </Card>

        {/* 미국 종목 상세 */}
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>🇺🇸 미국 종목 ({usHoldings.length})</Text>
            {usHoldings.length > 0 && (
              <Text style={{ color: signColor(usPnl), fontWeight: '800', fontSize: 12 }}>
                평가 {formatMoney(usEval, 'US')} · {usPnl > 0 ? '+' : ''}
                {formatMoney(usPnl, 'US')}
              </Text>
            )}
          </View>
          {usHoldings.length === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13 }}>보유 중인 미국 종목이 없어요.</Text>
          ) : (
            usHoldings.map((h) => <HoldingRow key={`US-${h.symbol}`} h={h} />)
          )}
        </Card>
      </View>

      <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: 2 }}>
        📌 보유주식은 현재 증권사 계좌에서 불러온 실제 잔고입니다.
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>
        {account.is_virtual ? '모의투자' : '실전'} 계좌 · 폰(네이티브)에서만 조회돼요. 국내/미국 요약 금액은 각 통화 기준입니다.
      </Text>
    </ScrollView>
  );
}

function HoldingRow({ h }: { h: KisHolding }) {
  const mkt = h.market;
  const cur = mkt === 'US' ? '$' : '₩';
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.text, fontWeight: '800', flex: 1 }} numberOfLines={1}>
          {h.name}
        </Text>
        <Text style={{ color: signColor(h.pnl), fontWeight: '800' }}>
          {h.pnl > 0 ? '+' : ''}
          {formatMoney(h.pnl, mkt)} ({h.pnlRate > 0 ? '+' : ''}
          {h.pnlRate}%)
        </Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>
          {money(h.quantity, 0)}주 · 평단 {cur}
          {money(h.avgPrice, mkt === 'US' ? 2 : 0)}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>평가 {formatMoney(h.evalAmount, mkt)}</Text>
      </View>
    </View>
  );
}
