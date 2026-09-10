import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, num, radius, spacing } from '@/theme';
import { buildPocketSeeds, buildScheduleSeeds, clampPocketCount, estimatedShares, MAX_POCKET_COUNT, MIN_POCKET_COUNT, normalizeWeights, pocketBuyTarget, POCKET_COUNT, scheduleAt, type ScheduleUnit } from '@/domain/pockets';
import { searchSymbols } from '@/services/symbols';
import { getUnifiedQuote, loadBrokerAccount } from '@/services/prices/unified';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked } from '@/services/broker/kis';
import type { BrokerAccount, SymbolResult } from '@/types/db';
import { BackHeader } from '@/components/BackHeader';
import { WeightInput } from '@/components/WeightInput';
import { AutoBudgetField } from '@/components/AutoBudgetField';
import { useAllocMode } from '@/lib/allocMode';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 'YYYY-MM-DD' + 'HH:MM' → Date. 형식이 어긋나면 null */
function parseStart(date: string, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m || !t) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 예정 시각은 '폰의 시간대'로 해석해 절대 시각으로 저장한다.
 * 한국 폰이면 한국시간(KST)이고, 해외에서 시간대가 바뀐 폰이면 그 나라 시간이 된다 — 그걸 그대로 알려준다.
 */
function timezoneLabel(): string {
  const offsetMin = -new Date().getTimezoneOffset(); // KST = +540
  if (offsetMin === 540) return '한국시간(KST) 기준';
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `폰 시간대 기준 (UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, '0')}` : ''})`;
}

const UNITS: { key: ScheduleUnit; label: string }[] = [
  { key: 'day', label: '일' },
  { key: 'week', label: '주' },
  { key: 'month', label: '개월' },
];

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
    mode?: string; // 'schedule' 이면 정기매수법으로 연다 (프로젝트 복사)
  }>();

  // 종목 검색
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SymbolResult | null>(null);

  // 전략/예산
  const [basePrice, setBasePrice] = useState(''); // 정액매수법의 기준가 (직접 입력)
  const [livePrice, setLivePrice] = useState<number | null>(null); // 종목 현재가 (표시용·정기매수법 참고값)
  const [priceLoading, setPriceLoading] = useState(false);
  const [buyInterval, setBuyInterval] = useState('5');
  const [sellTarget, setSellTarget] = useState('10');
  const [totalBudget, setTotalBudget] = useState('');
  const [pocketCount, setPocketCount] = useState(POCKET_COUNT); // 기본 5, 6~10 가능

  // 매수 방식 — 'price'(목표가 도달) | 'schedule'(정해진 날짜·시각에 현재가로)
  const [buyMode, setBuyMode] = useState<'price' | 'schedule'>('price');
  const [startDate, setStartDate] = useState(todayStr());
  const [startTime, setStartTime] = useState('09:30');
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState<ScheduleUnit>('week');
  const [weights, setWeights] = useState<string[]>(Array(POCKET_COUNT).fill('20'));
  const [saving, setSaving] = useState(false);

  // 포켓 개수 변경 → 비중(또는 금액) 배열을 균등하게 재구성
  const changePocketCount = (n: number) => {
    const c = clampPocketCount(n);
    setPocketCount(c);
    setWeights(Array(c).fill(String(Math.round((100 / c) * 100) / 100)));
    // 금액 모드면 지금 총예산을 새 개수로 다시 나눠 담는다 (칸만 늘고 금액이 안 맞는 걸 방지)
    if (alloc.mode === 'amount') {
      const per = alloc.round((Number(totalBudget) || 0) / c);
      alloc.setAllAmounts(Array(c).fill(per > 0 ? String(per) : ''));
    } else if (alloc.mode === 'qty') {
      alloc.setAllQtys(alloc.equalQtys(Number(totalBudget) || 0, c));
    }
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
    if (params.mode === 'schedule') setBuyMode('schedule');
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

  /** 현재가 조회 (KIS 우선 — NXT·주간거래 반영, 실패하면 야후) */
  const fetchLive = async (r: SymbolResult) => {
    setPriceLoading(true);
    try {
      const account = await loadBrokerAccount();
      const q = await getUnifiedQuote(account, r.symbol, r.market);
      setLivePrice(q.price);
      return q.price;
    } catch {
      return null; // 웹 CORS 등 — 기준가는 직접 입력
    } finally {
      setPriceLoading(false);
    }
  };

  const onPick = async (r: SymbolResult) => {
    setSelected(r);
    setQuery(r.name);
    setResults([]);
    setLivePrice(null);
    const p = await fetchLive(r);
    // 정액매수법의 기준가 기본값 = 고른 순간의 현재가 (원하면 고쳐 쓴다)
    if (p != null) setBasePrice(String(p));
  };

  const parsed = {
    // 정액매수법 = 직접 입력한 기준가 / 정기매수법 = 기준가가 없으므로 현재가를 참고값으로
    basePrice: buyMode === 'schedule' ? (livePrice ?? 0) : Number(basePrice),
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

  const scheduleStart = useMemo(() => parseStart(startDate, startTime), [startDate, startTime]);
  const scheduleEvery = Math.max(1, Math.floor(Number(every) || 1));

  // 배분 방식 — 비중(%) / 금액 / 수량(주). 금액·수량 모드에서는 총예산 = 포켓 금액 합.
  // 수량 모드의 포켓 매수가: 정액매수법 = 포켓 목표가(기준가 − 간격%·i), 정기매수법 = 현재가
  const pocketPrice = (i: number) =>
    buyMode === 'schedule' ? parsed.basePrice : pocketBuyTarget(parsed.basePrice, parsed.buyIntervalPct, i, market);
  const alloc = useAllocMode(market, weights, setWeights, totalBudget, setTotalBudget, pocketPrice);
  const byAmount = alloc.mode === 'amount';
  const byQty = alloc.mode === 'qty';
  const byPct = alloc.mode === 'pct';

  const seeds = useMemo(() => {
    if (!parsed.basePrice || parsed.basePrice <= 0) return [];
    const input = { ...parsed, budgets: alloc.budgets };
    if (buyMode === 'schedule') {
      if (!scheduleStart) return [];
      return buildScheduleSeeds({
        ...input,
        schedule: { startAt: scheduleStart, every: scheduleEvery, unit, count: pocketCount },
      });
    }
    return buildPocketSeeds(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrice, livePrice, buyInterval, sellTarget, totalBudget, weights, alloc.budgets, pocketCount, market, buyMode, scheduleStart, scheduleEvery, unit]);

  const setWeight = (i: number, v: string) => {
    const next = [...weights];
    next[i] = v;
    setWeights(next);
  };

  const resetEqual = () => {
    if (byQty) return alloc.setAllQtys(alloc.equalQtys(Number(totalBudget) || 0, pocketCount));
    if (byAmount) {
      const per = alloc.round((Number(totalBudget) || 0) / pocketCount);
      return alloc.setAllAmounts(Array(pocketCount).fill(per > 0 ? String(per) : ''));
    }
    setWeights(Array(pocketCount).fill(String(Math.round((100 / pocketCount) * 100) / 100)));
  };

  /** '전액 입력' — 비중 모드는 총예산에, 금액·수량 모드는 포켓별로 균등하게 */
  const fillAll = (available: number) => {
    if (byQty) return alloc.setAllQtys(alloc.equalQtys(available, pocketCount));
    if (!byAmount) return setTotalBudget(String(market === 'KRX' ? Math.floor(available) : available));
    const per = alloc.round(available / pocketCount);
    alloc.setAllAmounts(Array(pocketCount).fill(per > 0 ? String(per) : ''));
  };

  const onSubmit = async () => {
    if (!selected) return notify('종목 선택 필요', '먼저 종목을 검색해서 선택하세요.');
    if (!parsed.basePrice || parsed.basePrice <= 0)
      return notify(
        '입력 필요',
        buyMode === 'schedule' ? '현재가를 불러오지 못했어요. 🔄 로 다시 조회해 주세요.' : '기준가를 올바르게 입력하세요.'
      );
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
        buy_mode: buyMode,
      })
      .select()
      .single();

    if (perr || !proj) {
      setSaving(false);
      if (perr && /buy_mode|42703|schema cache|PGRST204/i.test(`${perr.code} ${perr.message}`)) {
        return notify('DB 준비 필요', '정기 매수에 필요한 마이그레이션(20260909a)을 Supabase에서 먼저 실행해 주세요.');
      }
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
        ...(s.buy_at ? { buy_at: s.buy_at } : null),
      }));
    if (rows.length === 0) {
      setSaving(false);
      await supabase.from('projects').delete().eq('id', proj.id); // 방금 만든 빈 프로젝트 정리
      return notify('포켓 생성 불가', '예산·수량이 0보다 큰 포켓이 하나도 없어요. 예산 배분을 확인해주세요.');
    }
    const { error: kerr } = await supabase.from('pockets').insert(rows);
    setSaving(false);
    if (kerr) {
      // 마이그레이션(20260909a) 미실행이면 buy_at 컬럼이 없다
      if (/buy_at|buy_mode|42703|schema cache|PGRST204/i.test(`${kerr.code} ${kerr.message}`)) {
        await supabase.from('projects').delete().eq('id', proj.id);
        return notify('DB 준비 필요', '정기 매수에 필요한 마이그레이션(20260909a)을 Supabase에서 먼저 실행해 주세요.');
      }
      return notify('포켓 생성 실패', kerr.message);
    }

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
      <BackHeader fallback="/" />
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
        {/* 실시간 현재가 (표시만) — 기준가 입력은 정액매수법을 골랐을 때 전략 카드에서 */}
        {selected && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: colors.cardAlt,
              borderRadius: radius.md,
              paddingHorizontal: spacing.md,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.textDim, fontSize: 13 }}>현재가</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {priceLoading ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Text style={{ color: num.live, fontWeight: '900', fontSize: 20 }}>
                  {livePrice != null ? formatPrice(livePrice, market) : '—'}
                </Text>
              )}
              <Pressable onPress={() => selected && void fetchLive(selected)} hitSlop={8}>
                <Text style={{ color: colors.primary, fontSize: 14 }}>🔄</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Card>

      {/* 전략 — 매수 방식(가격 분할 / 정기 매수) */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>매수 방식</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {([
            { key: 'price' as const, title: '📉 정액매수법', desc: '기준가에서 간격만큼 내려갈 때마다' },
            { key: 'schedule' as const, title: '📅 정기매수법', desc: '정해진 날짜·시각에 현재가로' },
          ]).map((o) => {
            const on = buyMode === o.key;
            return (
              <Pressable
                key={o.key}
                onPress={() => setBuyMode(o.key)}
                style={{
                  flex: 1,
                  gap: 2,
                  padding: spacing.md,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? colors.primary : colors.border,
                  backgroundColor: on ? 'rgba(34,211,166,0.12)' : colors.cardAlt,
                }}
              >
                <Text style={{ color: on ? colors.primary : colors.text, fontWeight: '900', fontSize: 13 }}>{o.title}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>{o.desc}</Text>
              </Pressable>
            );
          })}
        </View>

        {buyMode === 'price' ? (
          <>
            {/* 기준가 = 1번 포켓 매수가. 종목을 고르면 현재가가 들어오고, 원하면 고쳐 쓴다 */}
            <NumberField
              label={`기준가 (${market === 'KRX' ? '원' : '달러'}) · 1번 포켓 매수가`}
              value={basePrice}
              onChangeText={setBasePrice}
              decimals
              placeholder={livePrice != null ? String(livePrice) : '종목을 고르면 현재가가 들어와요'}
            />
            {livePrice != null && Number(basePrice) > 0 && Number(basePrice) !== livePrice && (
              <Pressable onPress={() => setBasePrice(String(livePrice))} hitSlop={6}>
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>
                  ↺ 현재가({formatPrice(livePrice, market)})로 맞추기
                </Text>
              </Pressable>
            )}
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Field label="매수 간격 %" value={buyInterval} onChangeText={setBuyInterval} keyboardType="decimal-pad" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="매도 목표 %" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" />
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1.4 }}>
                <Field label="첫 매수 날짜" value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="시각" value={startTime} onChangeText={setStartTime} placeholder="09:30" autoCapitalize="none" />
              </View>
            </View>
            {/* 시간대를 분명히 — 미국 주식이라도 여기 적는 시각은 한국시간이다 */}
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800', marginTop: -6 }}>
              🕘 {timezoneLabel()}
              {market === 'US' ? ' — 미국 주식도 한국시간으로 적어요 (미국 정규장 = 한국시간 밤 22:30~05:00, 서머타임엔 1시간 빠름)' : ''}
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-end' }}>
              <View style={{ width: 78 }}>
                <Field label="간격" value={every} onChangeText={setEvery} keyboardType="number-pad" />
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flex: 1, paddingBottom: 8 }}>
                {UNITS.map((u) => {
                  const on = unit === u.key;
                  return (
                    <Pressable
                      key={u.key}
                      onPress={() => setUnit(u.key)}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: on ? colors.primary : colors.border,
                        backgroundColor: on ? 'rgba(34,211,166,0.14)' : colors.cardAlt,
                      }}
                    >
                      <Text style={{ color: on ? colors.primary : colors.textDim, fontWeight: '800' }}>{u.label}마다</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Field label="매도 목표 %" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" />
              </View>
              <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 12 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>체결가 대비 이만큼 오르면 매도</Text>
              </View>
            </View>
            {/* 언제 얼마씩 사는지 미리보기 — 날짜가 틀리면 여기서 바로 드러난다 */}
            {scheduleStart ? (
              <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 3 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>매수 예정 ({pocketCount}회)</Text>
                {Array.from({ length: Math.min(pocketCount, 4) }, (_, i) => {
                  const d = scheduleAt(scheduleStart, scheduleEvery, unit, i);
                  const alloc = parsed.totalBudget ? (parsed.totalBudget * normalized[i]) / 100 : null;
                  return (
                    <Text key={i} numberOfLines={1} style={{ color: colors.text, fontSize: 12 }}>
                      포켓 {i + 1} · {d.getFullYear()}-{String(d.getMonth() + 1).padStart(2, '0')}-
                      {String(d.getDate()).padStart(2, '0')} {String(d.getHours()).padStart(2, '0')}:
                      {String(d.getMinutes()).padStart(2, '0')}
                      {alloc != null ? `  ·  ${formatPrice(alloc, market)}` : ''}
                    </Text>
                  );
                })}
                {pocketCount > 4 && (
                  <Text style={{ color: colors.textDim, fontSize: 11 }}>… 외 {pocketCount - 4}회</Text>
                )}
              </View>
            ) : (
              <Text style={{ color: colors.warn, fontSize: 12 }}>날짜는 YYYY-MM-DD, 시각은 HH:MM 형식으로 입력하세요.</Text>
            )}
          </>
        )}
        <Text style={{ color: colors.textDim, fontSize: 12 }}>
          {buyMode === 'price'
            ? '정액매수법 — 가격이 내려올 때마다 정해 둔 금액만큼 산다. 포켓 수는 5~10개.'
            : '정기매수법 — 포켓 하나가 매수 1회예요. 예정 시각이 되면 그때 현재가로, 배분 예산으로 살 수 있는 최대 수량을 주문합니다. (자동매매 ON + AUTO 등급 필요)'}
        </Text>
      </Card>

      {/* 예산 + 포켓별 비율 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>예산 & 포켓 비율</Text>
        {/* 금액·수량 모드에서는 총예산 = 포켓 금액 합 → 입력칸 대신 '자동 계산' 표시 */}
        {byPct ? (
          <NumberField
            label={`프로젝트 총 예산 (${market === 'KRX' ? '원' : '달러'}, 선택)`}
            value={totalBudget}
            onChangeText={setTotalBudget}
            decimals
            placeholder="예: 1,000,000"
          />
        ) : (
          <AutoBudgetField market={market} value={totalBudget} mode={byQty ? 'qty' : 'amount'} />
        )}
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
                  onPress={() => fillAll(availableBudget)}
                  style={{ backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}
                >
                  <Text style={{ color: '#04121A', fontSize: 12, fontWeight: '900' }}>전액 입력</Text>
                </Pressable>
              </View>
            </View>
            {/* 안내/경고는 높이를 고정 — 입력 중 줄 수가 바뀌면 아래 입력칸이 밀려 키보드가 닫힌다 */}
            <View style={{ minHeight: 30, justifyContent: 'center' }}>
              {overBudget ? (
                <Text numberOfLines={2} style={{ color: colors.danger, fontSize: 12, fontWeight: '800' }}>
                  ⚠️ 예산이 사용가능 예산을 초과했어요! 이 금액 이하로 낮춰야 프로젝트를 만들 수 있어요.
                </Text>
              ) : (
                <Text numberOfLines={2} style={{ color: colors.textDim, fontSize: 11 }}>
                  예수금에서 대기중인 포켓 예산(다른 프로젝트 포함)을 뺀, 실제로 쓸 수 있는 금액이에요.
                </Text>
              )}
            </View>
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

        {/* 배분 방식 — 비중(%)으로 나눌지, 금액을 직접 넣을지 */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: colors.textDim, fontSize: 13, marginRight: 2 }}>배분</Text>
          {(['pct', 'amount', 'qty'] as const).map((k) => (
            <Pressable
              key={k}
              onPress={() => alloc.changeMode(k)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: alloc.mode === k ? colors.primary : colors.border,
                backgroundColor: alloc.mode === k ? 'rgba(34,211,166,0.14)' : colors.cardAlt,
              }}
            >
              <Text style={{ color: alloc.mode === k ? colors.primary : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                {k === 'pct' ? '비중 %' : k === 'amount' ? `금액 ${market === 'KRX' ? '₩' : '$'}` : '수량 주'}
              </Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable onPress={resetEqual}>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>균등 분배</Text>
          </Pressable>
        </View>

        {/* 합계 안내는 한 줄로 고정 — 입력 중 '(자동 정규화됨)'이 붙으며 줄바꿈되면
            아래 입력칸들이 밀려 키보드에 가려진다 */}
        <Text numberOfLines={1} style={{ color: colors.textDim }}>
          {byQty ? (
            parsed.basePrice > 0 ? (
              <>
                총 {money(alloc.qtySum)}주 · {formatPrice(alloc.sum, market)}
                {buyMode === 'schedule' ? ' (현재가 기준)' : ' (포켓별 매수 목표가 기준)'}
              </>
            ) : (
              <Text style={{ color: colors.warn }}>
                {buyMode === 'schedule' ? '현재가를 불러온 뒤 수량을 넣을 수 있어요' : '기준가를 먼저 입력하면 수량으로 배분할 수 있어요'}
              </Text>
            )
          ) : byAmount ? (
            <>포켓 금액 합계: {formatPrice(alloc.sum, market)}</>
          ) : (
            <>
              포켓별 비중 합계: {money(weightSum, 1)}%{' '}
              {Math.abs(weightSum - 100) > 0.1 && <Text style={{ color: colors.warn }}>(자동 정규화됨)</Text>}
            </>
          )}
        </Text>

        {weights.map((w, i) => {
          const allocAmt = parsed.totalBudget ? (parsed.totalBudget * normalized[i]) / 100 : null;
          const s = seeds[i];
          // 예산 0 또는 매수 가능 수량 0주면 이 포켓은 생성되지 않음 (예산을 넣었을 때만 판정)
          const excluded =
            parsed.totalBudget != null &&
            !!s &&
            ((s.budget ?? 0) <= 0 || estimatedShares(s.budget, s.buy_target_price) <= 0);
          return (
            // 예산이 1주 값에 못 미치는 동안에도 입력칸은 그대로 둔다 —
            // 흐리게 처리하는 건 설명 글자만. 입력칸을 감싼 View 를 건드리면
            // 숫자를 치는 도중에 칸이 다시 그려지며 키보드가 닫힌다.
            <View key={i} style={{ gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <Text style={{ color: colors.text, width: 56, opacity: excluded ? 0.5 : 1 }}>포켓 {i + 1}</Text>
                <View style={{ width: byAmount ? 130 : 90 }}>
                  {byQty ? (
                    <WeightInput value={alloc.qtys[i] ?? ''} onChange={(v) => alloc.setQty(i, v)} commas decimals={false} />
                  ) : byAmount ? (
                    <WeightInput
                      value={alloc.amounts[i] ?? ''}
                      onChange={(v) => alloc.setAmount(i, v)}
                      commas
                      decimals={alloc.decimals}
                    />
                  ) : (
                    <WeightInput value={w} onChange={(v) => setWeight(i, v)} />
                  )}
                </View>
                {/* 설명은 항상 두 줄로 고정(비중 / 금액) — 한 줄에 다 넣으면 금액이 잘리고,
                    줄 수가 바뀌면 입력 중 레이아웃이 흔들려 키보드가 닫힌다 */}
                <View style={{ flex: 1, opacity: excluded ? 0.5 : 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.textDim }}>
                    {byQty ? `${formatPrice(Number(alloc.amounts[i]) || 0, market)} · ${normalized[i]}%` : `${normalized[i]}%`}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 12 }}>
                    {byQty
                      ? alloc.priceOf(i) > 0
                        ? `@${formatPrice(alloc.priceOf(i), market)}`
                        : ' '
                      : byAmount
                        ? ' '
                        : allocAmt != null
                          ? formatPrice(allocAmt, market)
                          : ' '}
                  </Text>
                </View>
              </View>
              {/* 생성 안 되는 이유는 잘리지 않게 아랫줄에 따로 (빨강) */}
              {excluded && (
                <Text style={{ color: colors.danger, fontSize: 11, fontWeight: '700', marginLeft: 56 + spacing.md }}>
                  1주도 살 수 없어 이 포켓은 생성되지 않아요
                </Text>
              )}
            </View>
          );
        })}
      </Card>

      <Button title="프로젝트 만들기" onPress={onSubmit} loading={saving} disabled={overBudget} />
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}
