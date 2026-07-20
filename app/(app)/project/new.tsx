import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, spacing } from '@/theme';
import { buildPocketSeeds, normalizeWeights, POCKET_COUNT } from '@/domain/pockets';
import { searchSymbols } from '@/services/symbols';
import { priceProvider } from '@/services/prices';
import { getDomesticBalance, kisOrderBlocked } from '@/services/broker/kis';
import type { BrokerAccount, SymbolResult } from '@/types/db';

export default function NewProjectScreen() {
  const router = useRouter();
  const { session } = useAuth();

  // 종목 검색
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SymbolResult | null>(null);

  // 전략/예산
  const [basePrice, setBasePrice] = useState('');
  const [buyInterval, setBuyInterval] = useState('5');
  const [sellTarget, setSellTarget] = useState('10');
  const [totalBudget, setTotalBudget] = useState('');
  const [weights, setWeights] = useState<string[]>(Array(POCKET_COUNT).fill('20'));
  const [saving, setSaving] = useState(false);

  // 계좌 예수금(주문가능현금) — 예산이 예수금 초과 못하게 검사 (한투 계좌 연결 시)
  const [cash, setCash] = useState<number | null>(null);
  const [cashLoading, setCashLoading] = useState(false);

  const market = selected?.market ?? 'US';

  // 계좌가 있으면 예수금을 1회 조회 (네이티브 + KRX 계좌만)
  useEffect(() => {
    (async () => {
      if (!session?.user?.id || kisOrderBlocked('KRX')) return;
      const { data } = await supabase
        .from('broker_accounts')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (!data) return;
      setCashLoading(true);
      try {
        const bal = await getDomesticBalance(data as BrokerAccount);
        setCash(bal.cash);
      } catch {
        /* 조회 실패 시 예수금 검사 생략 */
      } finally {
        setCashLoading(false);
      }
    })();
  }, [session?.user?.id]);

  // 디바운스 검색
  useEffect(() => {
    if (selected && query === selected.name) return; // 선택 직후 재검색 방지
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchSymbols(q));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, selected]);

  const onPick = async (r: SymbolResult) => {
    setSelected(r);
    setQuery(r.name);
    setResults([]);
    // 현재가를 기준가로 자동 입력 (실패하면 사용자가 직접 입력)
    try {
      const q = await priceProvider.getQuote(r.symbol);
      setBasePrice(String(q.price));
    } catch {
      /* 웹 CORS 등: 수동 입력 */
    }
  };

  const parsed = {
    basePrice: Number(basePrice),
    buyIntervalPct: Number(buyInterval),
    sellTargetPct: Number(sellTarget),
    totalBudget: totalBudget ? Number(totalBudget) : null,
    weights: weights.map((w) => Number(w) || 0),
  };

  const normalized = useMemo(() => normalizeWeights(parsed.weights), [weights]);
  const weightSum = parsed.weights.reduce((a, b) => a + b, 0);

  // 예수금 초과 검사 (KRX + 예수금 조회 성공 시에만)
  const overBudget =
    market === 'KRX' && cash != null && parsed.totalBudget != null && parsed.totalBudget > cash;

  const seeds = useMemo(() => {
    if (!parsed.basePrice || parsed.basePrice <= 0) return [];
    return buildPocketSeeds(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrice, buyInterval, sellTarget, totalBudget, weights]);

  const setWeight = (i: number, v: string) => {
    const next = [...weights];
    next[i] = v;
    setWeights(next);
  };
  const resetEqual = () => setWeights(Array(POCKET_COUNT).fill('20'));

  const onSubmit = async () => {
    if (!selected) return notify('종목 선택 필요', '먼저 종목을 검색해서 선택하세요.');
    if (!parsed.basePrice || parsed.basePrice <= 0) return notify('입력 필요', '기준가를 올바르게 입력하세요.');
    if (overBudget)
      return notify('예산 초과', `예산이 계좌 예수금(${formatMoney(cash!, 'KRX')})을 초과했어요. 예수금 이하로 입력하세요.`);
    if (!session?.user?.id) return;

    setSaving(true);
    const { data: proj, error: perr } = await supabase
      .from('projects')
      .insert({
        user_id: session.user.id,
        name: selected.name,
        symbol: selected.symbol,
        market: selected.market,
        base_price: parsed.basePrice,
        buy_interval_pct: parsed.buyIntervalPct,
        sell_target_pct: parsed.sellTargetPct,
        pocket_count: POCKET_COUNT,
        total_budget: parsed.totalBudget,
      })
      .select()
      .single();

    if (perr || !proj) {
      setSaving(false);
      return notify('저장 실패', perr?.message ?? '알 수 없는 오류');
    }

    const rows = seeds.map((s) => ({
      project_id: proj.id,
      idx: s.idx,
      buy_target_price: s.buy_target_price,
      sell_target_price: s.sell_target_price,
      weight: s.weight,
      budget: s.budget,
      status: 'waiting' as const,
    }));
    const { error: kerr } = await supabase.from('pockets').insert(rows);
    setSaving(false);
    if (kerr) return notify('포켓 생성 실패', kerr.message);

    router.replace(`/project/${proj.id}`);
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      keyboardShouldPersistTaps="handled"
    >
      {/* 종목 검색 */}
      <Card>
        <Field
          label="종목 검색 (이름/티커)"
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (selected) setSelected(null);
          }}
          placeholder="예: 삼성전자, samsung, AAPL"
          autoCapitalize="none"
        />
        {searching && <ActivityIndicator color={colors.primary} />}
        {results.length > 0 && (
          <View style={{ gap: 1, backgroundColor: colors.border, borderRadius: 8, overflow: 'hidden' }}>
            {results.map((r) => (
              <Pressable
                key={r.symbol}
                onPress={() => onPick(r)}
                style={{ backgroundColor: colors.cardAlt, padding: spacing.md }}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>{r.name}</Text>
                <Text style={{ color: colors.textDim, fontSize: 12 }}>
                  {r.symbol} · {r.exchange} · {r.market === 'KRX' ? '한국' : '미국/기타'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {selected && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              backgroundColor: 'rgba(34,211,166,0.12)',
              borderRadius: 8,
              padding: spacing.sm,
            }}
          >
            <Text style={{ color: colors.primary, fontWeight: '800' }}>✓ {selected.symbol}</Text>
            <Text style={{ color: colors.textDim }}>
              {selected.market === 'KRX' ? '한국(원화)' : '미국(달러)'}
            </Text>
          </View>
        )}
        <NumberField
          label={`기준가 (${market === 'KRX' ? '원' : '달러'}) · 선택 시 현재가 자동입력`}
          value={basePrice}
          onChangeText={setBasePrice}
          decimals
          placeholder="1번 포켓 매수 기준가"
        />
      </Card>

      {/* 전략 — 포켓 수는 5개 고정 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>5분할 전략</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="매수 간격 %" value={buyInterval} onChangeText={setBuyInterval} keyboardType="decimal-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="매도 목표 %" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" />
          </View>
        </View>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>포켓 수는 5개로 고정됩니다.</Text>
      </Card>

      {/* 예산 + 포켓별 비율 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>예산 & 포켓 비율</Text>
        <NumberField
          label={`프로젝트 총 예산 (${market === 'KRX' ? '원' : '달러'}, 선택)`}
          value={totalBudget}
          onChangeText={setTotalBudget}
          decimals
          placeholder="예: 1,000,000"
        />
        {/* 계좌 예수금 안내 (한투 계좌 연결 시) */}
        {cashLoading ? (
          <Text style={{ color: colors.textDim, fontSize: 12 }}>계좌 예수금 확인 중…</Text>
        ) : cash != null ? (
          <View style={{ backgroundColor: overBudget ? 'rgba(248,113,113,0.12)' : colors.cardAlt, borderRadius: 8, padding: spacing.sm }}>
            <Text style={{ color: overBudget ? colors.danger : colors.textDim, fontSize: 12, fontWeight: overBudget ? '800' : '400' }}>
              계좌 예수금(주문가능): {formatMoney(cash, 'KRX')}
              {overBudget ? ' · ⚠️ 예산이 예수금을 초과했어요' : ''}
            </Text>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.textDim }}>
            포켓별 비중 합계: {money(weightSum, 1)}%{' '}
            {Math.abs(weightSum - 100) > 0.1 && <Text style={{ color: colors.warn }}>(자동 정규화됨)</Text>}
          </Text>
          <Pressable onPress={resetEqual}>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>균등(20%)</Text>
          </Pressable>
        </View>
        {weights.map((w, i) => {
          const alloc = parsed.totalBudget ? (parsed.totalBudget * normalized[i]) / 100 : null;
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Text style={{ color: colors.text, width: 56 }}>포켓 {i + 1}</Text>
              <View style={{ width: 90 }}>
                <Field label="" value={w} onChangeText={(v) => setWeight(i, v)} keyboardType="decimal-pad" />
              </View>
              <Text style={{ color: colors.textDim, flex: 1 }}>
                {normalized[i]}% {alloc != null ? `· ${formatPrice(alloc, market)}` : ''}
              </Text>
            </View>
          );
        })}
      </Card>

      <Button title="프로젝트 만들기" onPress={onSubmit} loading={saving} disabled={overBudget} />
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}
