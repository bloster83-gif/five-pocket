import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Row } from '@/components/ui';
import { colors, formatMoney, money, radius, signColor, spacing } from '@/theme';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked, type KisBalance, type KisHolding } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

// 보유주식 상세 — MY 탭의 '자세히 보기'에서 진입. 국내/미국 잔고를 한 페이지에 자세히.
export default function HoldingsScreen() {
  const { session } = useAuth();
  const [account, setAccount] = useState<BrokerAccount | null | undefined>(undefined);
  const [balance, setBalance] = useState<KisBalance | null>(null);
  const [usHoldings, setUsHoldings] = useState<KisHolding[]>([]);
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
    try {
      const dom = await getDomesticBalance(acc);
      setBalance(dom);
      try {
        setUsHoldings(await getOverseasBalance(acc));
      } catch {
        setUsHoldings([]);
      }
    } catch (e: any) {
      setError(e?.message ?? '잔고를 불러오지 못했어요.');
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const krHoldings = balance?.holdings ?? [];
  const usEval = usHoldings.reduce((s, h) => s + h.evalAmount, 0);
  const usPnl = usHoldings.reduce((s, h) => s + h.pnl, 0);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  if (!account) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Card>
          <Text style={{ color: colors.textDim }}>계좌를 연결하면 실제 보유주식을 볼 수 있어요.</Text>
        </Card>
      </ScrollView>
    );
  }

  if (error) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
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
      {/* 국내(원화) 요약 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>🇰🇷 국내 (원화)</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>평가금액</Text>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>{formatMoney(balance?.totalEval ?? 0, 'KRX')}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md }}>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>평가손익</Text>
            <Text style={{ color: signColor(balance?.totalPnl ?? 0), fontWeight: '900', fontSize: 16 }}>
              {(balance?.totalPnl ?? 0) > 0 ? '+' : ''}
              {formatMoney(balance?.totalPnl ?? 0, 'KRX')}
            </Text>
          </View>
        </View>
        <Row label="예수금 (주문가능현금)" value={formatMoney(balance?.cash ?? 0, 'KRX')} />
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

      {/* 미국(달러) 상세 */}
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

      <Text style={{ color: colors.textDim, fontSize: 11 }}>
        * {account.is_virtual ? '모의투자' : '실전'} 계좌 실시간 잔고 · 폰(네이티브)에서만 조회돼요. 국내/미국 요약 금액은 각
        통화 기준입니다.
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
