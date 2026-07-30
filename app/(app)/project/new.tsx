import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, num, radius, spacing } from '@/theme';
import { buildPocketSeeds, clampPocketCount, estimatedShares, MAX_POCKET_COUNT, MIN_POCKET_COUNT, normalizeWeights, POCKET_COUNT } from '@/domain/pockets';
import { searchSymbols } from '@/services/symbols';
import { getUnifiedQuote, loadBrokerAccount } from '@/services/prices/unified';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked } from '@/services/broker/kis';
import type { BrokerAccount, SymbolResult } from '@/types/db';

export default function NewProjectScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const params = useLocalSearchParams<{
    copy?: string;
    name?: string;
    symbol?: string;
    market?: string;
    base?: string;
    buyInt?: string;
    sellTgt?: string;
    budget?: string;
  }>();

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
  const [pocketCount, setPocketCount] = useState(POCKET_COUNT); // 기본 5, 6~10 가능
  const [weights, setWeights] = useState<string[]>(Array(POCKET_COUNT).fill('20'));
  const [saving, setSaving] = useState(false);

  // 포켓 개수 변경 → 비중 배열을 균등하게 재구성
  const changePocketCount = (n: number) => {
    const c = clampPocketCount(n);
    setPocketCount(c);
    setWeights(Array(c).fill(String(Math.round((100 / c) * 100) / 100)));
  };

  // 계좌 예수금(주문가능현금) + 대기중 포켓 예산 — 가능 예산 = 예수금 − 대기중 포켓 예산 합
  const [cashKr, setCashKr] = useState<number | null>(null);
  const [cashUs, setCashUs] = useState<number | null>(null);
  const [waitingKr, setWaitingKr] = useState(0); // 진행중 프로젝트의 '대기중' 포켓 배분 예산 합 (원화)
  const [waitingUs, setWaitingUs] = useState(0); // (달러)
  const [cashLoading, setCashLoading] = useState(false);

  const market = selected?.market ?? 'US';

  // 종목이 파라미터로 넘어오면 미리 채우기 (프로젝트 복사 또는 관심종목 레이더에서 진입, 1회)
  useEffect(() => {
    if (!params.symbol) return;
    const mkt = params.market === 'KRX' ? 'KRX' : 'US';
    setSelected({ symbol: params.symbol, name: params.name ?? params.symbol, market: mkt, exchange: params.market ?? '' });
    setQuery(params.name ?? params.symbol);
    if (params.base) setBasePrice(params.base);
    if (params.buyInt) setBuyInterval(params.buyInt);
    if (params.sellTgt) setSellTarget(params.sellTgt);
    if (params.budget) setTotalBudget(params.budget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.copy, params.symbol]);

  // 계좌 예수금(국내·미국) + 대기중 포켓 예산 합을 1회 조회 (네이티브만)
  useEffect(() => {
    (async () => {
      if (!session?.user?.id) return;
      // 대기중 포켓 배분 예산 합 (진행중 프로젝트만) — 계좌 없이도 계산 가능
      try {
        const [{ data: pj }, { data: pk }] = await Promise.all([
          supabase.from('projects').select('id, market, closed_at'),
          supabase.from('pockets').select('project_id, status, budget'),
        ]);
        const projById = new Map(((pj as { id: string; market: string; closed_at: string | null }[]) ?? []).map((p) => [p.id, p]));
        let kr = 0;
        let us = 0;
        (((pk as { project_id: string; status: string; budget: number | null }[]) ?? []) || []).forEach((k) => {
          const proj = projById.get(k.project_id);
          if (!proj || proj.closed_at || k.status !== 'waiting' || k.budget == null) return;
          if (proj.market === 'US') us += Number(k.budget);
          else kr += Number(k.budget);
        });
        setWaitingKr(kr);
        setWaitingUs(us);
      } catch {
        /* 대기 예산 계산 실패 시 0 유지 */
      }
      if (kisOrderBlocked('KRX')) return; // 웹 등 — 예수금 조회 생략
      const { data } = await supabase
        .from('broker_accounts')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (!data) return;
      setCashLoading(true);
      try {
        const [dom, ov] = await Promise.allSettled([
          getDomesticBalance(data as BrokerAccount),
          getOverseasBalance(data as BrokerAccount),
        ]);
        if (dom.status === 'fulfilled') setCashKr(dom.value.cash);
        if (ov.status === 'fulfilled') setCashUs(ov.value.cash);
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
    // 현재가를 기준가로 자동 입력 (KIS 우선 — NXT·주간거래 반영, 실패하면 직접 입력)
    try {
      const account = await loadBrokerAccount();
      const q = await getUnifiedQuote(account, r.symbol, r.market);
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
    pocketCount,
    market,
  };

  const normalized = useMemo(() => normalizeWeights(parsed.weights), [weights]);
  const weightSum = parsed.weights.reduce((a, b) => a + b, 0);

  // 예수금 초과 검사 (KRX + 예수금 조회 성공 시에만)
  // 가능 예산 = 계좌 예수금 − 이미 대기중인 포켓들의 배분 예산 합 (시장별, 원/달러)
  const cash = market === 'KRX' ? cashKr : cashUs;
  const waitingBudget = market === 'KRX' ? waitingKr : waitingUs;
  const availableBudget = cash != null ? Math.max(0, cash - waitingBudget) : null;
  const overBudget =
    availableBudget != null && parsed.totalBudget != null && parsed.totalBudget > availableBudget;

  const seeds = useMemo(() => {
    if (!parsed.basePrice || parsed.basePrice <= 0) return [];
    return buildPocketSeeds(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrice, buyInterval, sellTarget, totalBudget, weights, pocketCount, market]);

  const setWeight = (i: number, v: string) => {
    const next = [...weights];
    next[i] = v;
    setWeights(next);
  };
  const resetEqual = () => setWeights(Array(pocketCount).fill(String(Math.round((100 / pocketCount) * 100) / 100)));

  const onSubmit = async () => {
    if (!selected) return notify('종목 선택 필요', '먼저 종목을 검색해서 선택하세요.');
    if (!parsed.basePrice || parsed.basePrice <= 0) return notify('입력 필요', '기준가를 올바르게 입력하세요.');
    if (overBudget)
      return notify(
        '예산 초과',
        `예산이 가능 예산(${formatMoney(availableBudget!, market)})을 초과했어요.\n가능 예산 = 예수금 − 대기중 포켓 예산 합. 이 금액 이하로 낮춰야 저장할 수 있어요.`
      );
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
        pocket_count: pocketCount,
        total_budget: parsed.totalBudget,
      })
      .select()
      .single();

    if (perr || !proj) {
      setSaving(false);
      return notify('저장 실패', perr?.message ?? '알 수 없는 오류');
    }

    // 배분 예산이 0이거나 매수 가능 수량이 0주인 포켓은 생성하지 않는다. (idx는 유지)
    const rows = seeds
      .filter((s) => (s.budget ?? 0) > 0 && estimatedShares(s.budget, s.buy_target_price) > 0)
      .map((s) => ({
        project_id: proj.id,
        idx: s.idx,
        buy_target_price: s.buy_target_price,
        sell_target_price: s.sell_target_price,
        weight: s.weight,
        budget: s.budget,
        status: 'waiting' as const,
      }));
    if (rows.length === 0) {
      setSaving(false);
      await supabase.from('projects').delete().eq('id', proj.id); // 방금 만든 빈 프로젝트 정리
      return notify('포켓 생성 불가', '예산·수량이 0보다 큰 포켓이 하나도 없어요. 예산 배분을 확인해주세요.');
    }
    const { error: kerr } = await supabase.from('pockets').insert(rows);
    setSaving(false);
    if (kerr) return notify('포켓 생성 실패', kerr.message);

    router.replace(`/project/${proj.id}`);
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 }}
      keyboardShouldPersistTaps="handled"
      // interactive 는 입력 중 리렌더로 스크롤이 살짝 움직일 때 키보드를 멋대로 닫아버림
      // (예산 배분 숫자 입력 불편) → 제거. 빈 곳 탭하면 키보드 닫히는 건 그대로.
      automaticallyAdjustKeyboardInsets
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
        {/* 사용가능 예산 = 계좌 예수금 − 대기중 포켓 예산 (한투 계좌 연결 시) */}
        {cashLoading ? (
          <Text style={{ color: colors.textDim, fontSize: 12 }}>사용가능 예산 계산 중…</Text>
        ) : availableBudget != null ? (
          <View
            style={{
              backgroundColor: overBudget ? 'rgba(248,113,113,0.14)' : colors.cardAlt,
              borderRadius: 8,
              padding: spacing.md,
              gap: 4,
              borderWidth: 1,
              borderColor: overBudget ? colors.danger : colors.primary,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '800' }}>💰 사용가능 예산</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: overBudget ? colors.danger : colors.primary, fontSize: 18, fontWeight: '900' }}>
                  {formatMoney(availableBudget, market)}
                </Text>
                <Pressable
                  onPress={() => setTotalBudget(String(market === 'KRX' ? Math.floor(availableBudget) : availableBudget))}
                  style={{ backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}
                >
                  <Text style={{ color: '#04121A', fontSize: 12, fontWeight: '900' }}>전액 입력</Text>
                </Pressable>
              </View>
            </View>
            {overBudget ? (
              <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '800' }}>
                ⚠️ 예산이 사용가능 예산을 초과했어요! 이 금액 이하로 낮춰야 프로젝트를 만들 수 있어요.
              </Text>
            ) : (
              <Text style={{ color: colors.textDim, fontSize: 11 }}>
                예수금에서 대기중인 포켓 예산(다른 프로젝트 포함)을 뺀, 실제로 쓸 수 있는 금액이에요.
              </Text>
            )}
          </View>
        ) : null}
        {/* 포켓 개수 선택 (기본 5, 특별 종목은 6~10) */}
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>포켓 개수 (기본 5 · 늘리면 6~10)</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {Array.from({ length: MAX_POCKET_COUNT - MIN_POCKET_COUNT + 1 }, (_, k) => MIN_POCKET_COUNT + k).map((n) => (
              <Pressable
                key={n}
                onPress={() => changePocketCount(n)}
                style={{
                  minWidth: 42,
                  alignItems: 'center',
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: pocketCount === n ? colors.primary : colors.border,
                  backgroundColor: pocketCount === n ? 'rgba(34,211,166,0.14)' : colors.cardAlt,
                }}
              >
                <Text style={{ color: pocketCount === n ? colors.primary : colors.textDim, fontWeight: '800' }}>{n}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.textDim }}>
            포켓별 비중 합계: {money(weightSum, 1)}%{' '}
            {Math.abs(weightSum - 100) > 0.1 && <Text style={{ color: colors.warn }}>(자동 정규화됨)</Text>}
          </Text>
          <Pressable onPress={resetEqual}>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>균등 분배</Text>
          </Pressable>
        </View>
        {weights.map((w, i) => {
          const alloc = parsed.totalBudget ? (parsed.totalBudget * normalized[i]) / 100 : null;
          const s = seeds[i];
          // 예산 0 또는 매수 가능 수량 0주면 이 포켓은 생성되지 않음 (예산을 넣었을 때만 판정)
          const excluded =
            parsed.totalBudget != null &&
            !!s &&
            ((s.budget ?? 0) <= 0 || estimatedShares(s.budget, s.buy_target_price) <= 0);
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, opacity: excluded ? 0.5 : 1 }}>
              <Text style={{ color: colors.text, width: 56 }}>포켓 {i + 1}</Text>
              <View style={{ width: 90 }}>
                <Field label="" value={w} onChangeText={(v) => setWeight(i, v)} keyboardType="decimal-pad" />
              </View>
              <Text style={{ color: colors.textDim, flex: 1 }}>
                {normalized[i]}% {alloc != null ? `· ${formatPrice(alloc, market)}` : ''}
                {excluded && <Text style={{ color: colors.warn, fontWeight: '800' }}>  · 생성 안 함</Text>}
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
