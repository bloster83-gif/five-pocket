import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { confirmAction, notify } from '@/lib/alert';
import { Card, Chip, Field, FilterBar } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, num, pocketColor, radius, rawNumeric, signColor, spacing, withCommas } from '@/theme';
import { alignToKrxTick, computePnL, estimatedShares, sellTargetFromFill } from '@/domain/pockets';
import { priceProvider } from '@/services/prices';
import { getDomesticPrice, getOrderFill, getOverseasPrice, kisOrderBlocked, placeDomesticOrder, placeOverseasOrder } from '@/services/broker/kis';
import type { BrokerAccount, Pocket, Project, Trade } from '@/types/db';

export default function PocketsScreen() {
  const router = useRouter();
  const { tier, session } = useAuth();
  const [account, setAccount] = useState<BrokerAccount | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  const [onlyHolding, setOnlyHolding] = useState(false); // 보유중 스위치
  const [onlyRealized, setOnlyRealized] = useState(false); // 실현 스위치
  // null = 전체, 0~4 = 포켓 1~5, 'plus' = 6번 이상(idx>=5) 합산
  const [pocketFilter, setPocketFilter] = useState<number | 'plus' | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState(''); // 종목명/티커 검색
  const [market, setMarket] = useState<'KRX' | 'US' | null>(null); // null = 전체 시장
  const [expanded, setExpanded] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, { price: number; changePct: number | null }>>({}); // symbol → 실시간가·등락률
  const [autoOrder, setAutoOrder] = useState<{ pocket: Pocket; proj: Project } | null>(null); // 왼쪽 스와이프 자동주문(AUTO)

  const load = useCallback(async () => {
    const [{ data: p }, { data: k }, { data: t }] = await Promise.all([
      supabase.from('projects').select('*'),
      supabase.from('pockets').select('*').order('idx'),
      supabase.from('trades').select('*').order('executed_at'),
    ]);
    if (p) setProjects(p as Project[]);
    if (k) setPockets(k as Pocket[]);
    if (t) setTrades(t as Trade[]);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 프로젝트별 실시간 시세 — 미국주식은 계좌 연결 시 KIS(주간가 포함) 우선, 아니면 야후
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const uniq = Array.from(new Map(projects.filter((p) => p.symbol).map((p) => [p.symbol, p])).values());
      uniq.forEach(async (p) => {
        try {
          let price: number;
          let previousClose: number | undefined;
          if (p.market === 'US' && account && Platform.OS !== 'web') {
            try {
              const ov = await getOverseasPrice(account, p.symbol);
              price = ov.price;
              previousClose = ov.previousClose;
            } catch {
              const q = await priceProvider.getQuote(p.symbol);
              price = q.price;
              previousClose = q.previousClose;
            }
          } else if (p.market === 'KRX' && account && Platform.OS !== 'web') {
            // 한국주식: KIS 통합(KRX+NXT) 시세 우선(NXT 장 반영), 실패 시 야후 폴백
            try {
              const dq = await getDomesticPrice(account, p.symbol);
              price = dq.price;
              previousClose = dq.previousClose;
            } catch {
              const q = await priceProvider.getQuote(p.symbol);
              price = q.price;
              previousClose = q.previousClose;
            }
          } else {
            const q = await priceProvider.getQuote(p.symbol);
            price = q.price;
            previousClose = q.previousClose;
          }
          const changePct =
            previousClose && previousClose > 0
              ? Math.round(((price - previousClose) / previousClose) * 10000) / 100
              : null;
          if (alive) setPrices((m) => ({ ...m, [p.symbol]: { price, changePct } }));
        } catch {
          /* 시세 실패는 무시 (— 표시) */
        }
      });
      return () => {
        alive = false;
      };
    }, [projects, account])
  );

  // 손절 주문용 증권사 계좌 (AUTO 등급)
  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from('broker_accounts')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setAccount((data as BrokerAccount) ?? null));
  }, [session?.user?.id]);

  const projMap = useMemo(() => {
    const m: Record<string, Project> = {};
    projects.forEach((p) => (m[p.id] = p));
    return m;
  }, [projects]);

  const tradesByPocket = useMemo(() => {
    const m: Record<string, Trade[]> = {};
    trades.forEach((t) => {
      if (t.pocket_id) (m[t.pocket_id] ??= []).push(t);
    });
    return m;
  }, [trades]);

  // 프로젝트 예산 합산 (진행중 프로젝트, 시장별)
  const budgetByMarket = useMemo(() => {
    const m: Record<string, number> = {};
    projects
      .filter((p) => !p.closed_at && p.total_budget)
      .forEach((p) => {
        m[p.market] = (m[p.market] ?? 0) + Number(p.total_budget);
      });
    return m;
  }, [projects]);

  // 필터: 보유중 = 매수 상태, 실현 = 매도 체결이 1건 이상 있는 포켓
  //        포켓 번호 선택 시 해당 idx 의 포켓만 (null = 전체)
  const filtered = useMemo(() => {
    return pockets.filter((k) => {
      const proj = projMap[k.project_id];
      if (!proj) return false;
      if (proj.closed_at) return false; // 종료된 프로젝트의 포켓은 포켓탭에서 숨김(상세에서만 확인)
      if (market && proj.market !== market) return false;
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        if (!proj.name.toLowerCase().includes(s) && !proj.symbol.toLowerCase().includes(s)) return false;
      }
      if (pocketFilter === 'plus') {
        if (k.idx < 5) return false; // 6번 이상(idx>=5)만
      } else if (pocketFilter != null && k.idx !== pocketFilter) return false;
      const kt = tradesByPocket[k.id] ?? [];
      const hasSell = kt.some((t) => t.side === 'sell');
      const holding = k.status === 'bought';
      if (onlyHolding && onlyRealized) return holding || hasSell;
      if (onlyHolding) return holding;
      if (onlyRealized) return hasSell;
      return true;
    });
  }, [pockets, projMap, tradesByPocket, onlyHolding, onlyRealized, pocketFilter, q, market]);

  // 포켓 1개 손절 (전량 매도). AUTO+계좌+네이티브면 실제 KIS 주문, 그 외엔 체결 기록만.
  const stopLossPocket = async (k: Pocket, proj: Project): Promise<{ ok: boolean; msg?: string }> => {
    if (!session?.user?.id) return { ok: false };
    const pocketTrades = tradesByPocket[k.id] ?? [];
    const openPnl = computePnL(pocketTrades, null);
    const qty = Math.floor(openPnl.totalQtyOpen);
    if (qty <= 0) return { ok: false, msg: '보유 수량 없음' };
    const sellPrice = prices[proj.symbol]?.price ?? k.sell_target_price ?? openPnl.avgOpenPrice ?? 0;
    if (sellPrice <= 0) return { ok: false, msg: '현재가를 확인할 수 없어요' };

    if (tier === 'auto' && account && !kisOrderBlocked(proj.market)) {
      try {
        const input = { side: 'sell' as const, symbol: proj.symbol, quantity: qty, price: sellPrice };
        const r = proj.market === 'US' ? await placeOverseasOrder(account, input) : await placeDomesticOrder(account, input);
        supabase
          .from('auto_orders')
          .insert({
            user_id: session.user.id,
            project_id: proj.id,
            pocket_id: k.id,
            side: 'sell',
            symbol: proj.symbol,
            order_price: sellPrice,
            quantity: qty,
            status: 'sent',
            kis_order_no: r.orderNo,
          })
          .then(() => {});
      } catch (e: any) {
        return { ok: false, msg: e?.message ?? '주문 실패' };
      }
    }

    const note = sellPrice >= openPnl.avgOpenPrice ? '익절' : '손절';
    await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: proj.id,
      pocket_id: k.id,
      side: 'sell',
      price: sellPrice,
      quantity: qty,
      executed_at: new Date().toISOString(),
      note,
    });
    await supabase.from('pockets').update({ status: 'sold' }).eq('id', k.id);
    return { ok: true };
  };

  const confirmStopLossPocket = (k: Pocket, proj: Project, profit: boolean) => {
    const word = profit ? '익절' : '손절';
    confirmAction(
      `포켓 ${word}`,
      `${proj.name} 포켓 ${k.idx + 1}을(를) 지금 전량 ${word}(매도)할까요?${tier === 'auto' && account ? ' 실제 매도 주문이 전송됩니다.' : ''}`,
      async () => {
        const r = await stopLossPocket(k, proj);
        await load();
        if (!r.ok) notify(`${word} 실패`, r.msg ?? '처리하지 못했어요.');
      },
      word
    );
  };

  // 대기중 포켓 매수 주문 — 매수 목표가(또는 직접 입력가) 기준. 손절과 대칭.
  const buyPocket = async (k: Pocket, proj: Project, customPrice?: number): Promise<{ ok: boolean; msg?: string }> => {
    if (!session?.user?.id) return { ok: false };
    const isKrx = proj.market === 'KRX';
    const rawBuy = customPrice && customPrice > 0 ? customPrice : k.buy_target_price;
    const buyPrice = isKrx ? alignToKrxTick(rawBuy, 'buy') : rawBuy;
    if (!buyPrice || buyPrice <= 0) return { ok: false, msg: '매수 가격이 없어요' };
    const qty = estimatedShares(k.budget, buyPrice);
    if (qty <= 0) return { ok: false, msg: '배분 예산으로 살 수 있는 수량이 없어요' };
    const rawSell = sellTargetFromFill(buyPrice, Number(proj.sell_target_pct));
    const sellTgt = isKrx ? alignToKrxTick(rawSell, 'sell') : rawSell;

    if (tier === 'auto' && account && !kisOrderBlocked(proj.market)) {
      try {
        const input = { side: 'buy' as const, symbol: proj.symbol, quantity: qty, price: buyPrice };
        const r = proj.market === 'US' ? await placeOverseasOrder(account, input) : await placeDomesticOrder(account, input);
        await supabase.from('auto_orders').insert({
          user_id: session.user.id,
          project_id: proj.id,
          pocket_id: k.id,
          side: 'buy',
          symbol: proj.symbol,
          order_price: buyPrice,
          quantity: qty,
          status: 'sent',
          kis_order_no: r.orderNo,
        });
        let fillPrice = buyPrice;
        let fillQty = qty;
        let filled = false;
        try {
          await new Promise((res) => setTimeout(res, 2500));
          const fill = await getOrderFill(account, proj.market === 'US' ? 'US' : 'KRX', r.orderNo, proj.symbol);
          if (fill && fill.filledQty > 0 && fill.avgPrice > 0) {
            filled = true;
            fillPrice = fill.avgPrice;
            fillQty = fill.filledQty;
          }
        } catch {
          /* 조회 실패 → 미체결로 간주 */
        }
        await supabase.from('trades').insert({
          user_id: session.user.id,
          project_id: proj.id,
          pocket_id: k.id,
          side: 'buy',
          price: fillPrice,
          quantity: fillQty,
          executed_at: new Date().toISOString(),
          note: `자동주문(KIS ${r.orderNo || '-'})`,
        });
        await supabase
          .from('pockets')
          .update({
            status: filled ? 'bought' : 'buy_ordered',
            sell_target_price: isKrx ? alignToKrxTick(sellTargetFromFill(fillPrice, Number(proj.sell_target_pct)), 'sell') : sellTargetFromFill(fillPrice, Number(proj.sell_target_pct)),
          })
          .eq('id', k.id);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, msg: e?.message ?? '주문 실패' };
      }
    }

    // 다이어리(수동): 매수 목표가로 체결만 기록
    await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: proj.id,
      pocket_id: k.id,
      side: 'buy',
      price: buyPrice,
      quantity: qty,
      executed_at: new Date().toISOString(),
      note: '매수',
    });
    await supabase.from('pockets').update({ status: 'bought', sell_target_price: sellTgt }).eq('id', k.id);
    return { ok: true };
  };

  const confirmBuyPocket = (k: Pocket, proj: Project) => {
    const disp = proj.market === 'KRX' ? alignToKrxTick(k.buy_target_price, 'buy') : k.buy_target_price;
    confirmAction(
      `포켓 ${k.idx + 1} 매수`,
      `${proj.name} 포켓 ${k.idx + 1}을(를) 매수 목표가 ${formatPrice(disp, proj.market)} 기준으로 매수 주문할까요?${tier === 'auto' && account ? ' 실제 매수 주문이 전송됩니다.' : ''}`,
      async () => {
        const r = await buyPocket(k, proj);
        await load();
        if (!r.ok) notify('매수 실패', r.msg ?? '처리하지 못했어요.');
      },
      '매수'
    );
  };

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* 상단 고정 헤더 — 포켓필터·검색은 스크롤 위치와 상관없이 항상 보이게 틀고정 */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md }}>
      {/* 🧺 포켓 번호 선택 — 맨 위, 화면 폭에 딱 맞는 균등 분할 버튼 (포켓탭 전용 서식) */}
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.buy,
          padding: spacing.sm,
          gap: spacing.xs,
        }}
      >
        <Text style={{ color: colors.buy, fontSize: 12, fontWeight: '800' }}>🧺 포켓 번호로 보기</Text>
        <View style={{ flexDirection: 'row', gap: 5 }}>
          {(() => {
            const hasPlus = pockets.some((k) => k.idx >= 5); // 6번 이상 포켓 존재 여부
            // 전체, 1~5, (6+) — 한 줄 유지 (늘어나지 않게)
            return [null, 0, 1, 2, 3, 4, ...(hasPlus ? (['plus'] as const) : [])] as (number | 'plus' | null)[];
          })().map((i) => {
            const on = pocketFilter === i;
            const isPlus = i === 'plus';
            const c = i == null ? colors.buy : isPlus ? colors.buy : pocketColor(i as number); // 포켓마다 고유 색
            return (
              <Pressable
                key={String(i)}
                onPress={() => setPocketFilter(i)}
                style={{
                  flexGrow: 1,
                  flexBasis: 30,
                  minWidth: 30,
                  alignItems: 'center',
                  paddingVertical: 12,
                  borderRadius: radius.md,
                  backgroundColor: on ? c : colors.cardAlt,
                  borderBottomWidth: 3,
                  borderBottomColor: i == null || isPlus ? (on ? colors.buy : 'transparent') : pocketColor(i as number),
                }}
              >
                <Text style={{ color: on ? '#FFFFFF' : colors.textDim, fontWeight: '900', fontSize: 14 }}>
                  {i == null ? '전체' : isPlus ? '6+' : (i as number) + 1}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 종목 검색 + 시장/상태 필터 (아이콘 칩) */}
      <FilterBar style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          onPress={() => setShowSearch((s) => !s)}
          style={{
            width: 40,
            height: 36,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: showSearch ? colors.buy : colors.card,
          }}
        >
          <Text style={{ fontSize: 16 }}>🔍</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, alignItems: 'center' }}>
          <Chip label="한국" icon="🇰🇷" active={market === 'KRX'} onPress={() => setMarket(market === 'KRX' ? null : 'KRX')} />
          <Chip label="미국" icon="🇺🇸" active={market === 'US'} onPress={() => setMarket(market === 'US' ? null : 'US')} activeColor={colors.accent} />
          <View style={{ width: 1, height: 22, backgroundColor: colors.border }} />
          <Chip label="보유중" icon="📌" active={onlyHolding} onPress={() => setOnlyHolding((v) => !v)} />
          <Chip label="실현완료" icon="✅" active={onlyRealized} onPress={() => setOnlyRealized((v) => !v)} activeColor={colors.sell} />
        </ScrollView>
      </FilterBar>

      {/* 종목 검색 입력 */}
      {showSearch && (
        <Card>
          <Field
            label="검색 (종목명/티커)"
            value={q}
            onChangeText={setQ}
            placeholder="예: 삼성, AAPL"
            autoCapitalize="none"
          />
        </Card>
      )}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
      {/* 예산 합산 — 강조 카드 (민트 테두리) */}
      <Card style={{ borderColor: colors.primary, borderWidth: 1.5, backgroundColor: 'rgba(34,211,166,0.06)' }}>
        <Text style={{ color: colors.primary, fontWeight: '900', fontSize: 15 }}>
          💰 프로젝트 예산 합계 (진행중)
        </Text>
        {Object.keys(budgetByMarket).length === 0 ? (
          <Text style={{ color: colors.textDim }}>예산이 설정된 프로젝트가 없어요.</Text>
        ) : (
          Object.entries(budgetByMarket).map(([mkt, v]) => (
            <View key={mkt} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.textDim }}>{mkt === 'KRX' ? '한국 (원화)' : '미국 (달러)'}</Text>
              <Text style={{ color: num.budget, fontWeight: '900', fontSize: 22 }}>{formatMoney(v, mkt)}</Text>
            </View>
          ))
        )}
        {Object.keys(budgetByMarket).length > 0 && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              paddingTop: spacing.sm,
              gap: 3,
            }}
          >
            <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '700' }}>
              🤖 자동주문을 쓰는 경우, 증권사 계좌에 위 예산과 동일한 금액을 미리 넣어두세요.
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              계좌 잔고가 예산보다 부족하면 목표가에 도달해도 프로젝트 설계대로 매수가 안 될 수 있어요.
            </Text>
          </View>
        )}
      </Card>

      {filtered.length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>조건에 맞는 포켓이 없어요.</Text>
        </Card>
      )}

      {filtered.map((k) => {
        const proj = projMap[k.project_id]!;
        const kt = tradesByPocket[k.id] ?? [];
        const pnl = computePnL(kt, null);
        const quote = prices[proj.symbol];
        const price = quote?.price ?? null;
        const changePct = quote?.changePct ?? null;
        // 현재가 >= 평균매수가면 이익(익절), 아니면 손실(손절)
        const inProfit = price != null && pnl.avgOpenPrice > 0 && price >= pnl.avgOpenPrice;
        // KRX 는 목표가를 호가단위(매수 내림·매도 올림)로 정렬해 표시
        const isKrx = proj.market === 'KRX';
        const buyTargetDisp = isKrx ? alignToKrxTick(k.buy_target_price, 'buy') : k.buy_target_price;
        const sellTargetDisp =
          k.sell_target_price != null ? (isKrx ? alignToKrxTick(k.sell_target_price, 'sell') : k.sell_target_price) : null;
        const open = expanded === k.id;
        const statusMeta =
          k.status === 'bought'
            ? { text: '보유중', color: colors.buy, bg: colors.buyBg }
            : k.status === 'buy_ordered' || k.status === 'sell_ordered'
              ? { text: k.status === 'buy_ordered' ? '매수 주문완료' : '매도 주문완료', color: colors.warn, bg: 'rgba(251,191,36,0.14)' }
              : k.status === 'sold'
                ? { text: '매도 완료', color: colors.sell, bg: colors.sellBg }
                : { text: '대기', color: colors.textDim, bg: colors.cardAlt };
        const cardEl = (
          <Pressable onPress={() => setExpanded(open ? null : k.id)}>
            <Card
              style={{
                borderColor: open ? colors.accent : colors.border,
                borderLeftWidth: 5,
                borderLeftColor: pocketColor(k.idx), // 포켓 번호별 고유 색 띠
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>
                    {proj.name}{' '}
                    <Text style={{ color: pocketColor(k.idx), fontWeight: '900' }}>· 포켓 {k.idx + 1}</Text>
                  </Text>
                  <Text style={{ color: colors.textDim, fontSize: 12 }}>{proj.symbol}</Text>
                </View>
                <View style={{ backgroundColor: statusMeta.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: statusMeta.color, fontWeight: '800', fontSize: 12 }}>{statusMeta.text}</Text>
                </View>
              </View>

              {/* 실시간 현재가 (한 줄) */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>현재가</Text>
                <Text style={{ color: num.live, fontWeight: '800', fontSize: 13 }}>
                  {price != null ? formatPrice(price, proj.market) : '—'}
                </Text>
                {changePct != null && (
                  <Text style={{ color: signColor(changePct), fontWeight: '800', fontSize: 12 }}>
                    {changePct > 0 ? '▲' : changePct < 0 ? '▼' : ''}
                    {changePct > 0 ? '+' : ''}
                    {changePct}%
                  </Text>
                )}
              </View>

              {/* 목표 정보 — 현재가 아래. 대기: 매수목표+목표수량 / 보유: 매도목표만(매수가는 아래 박스 평균매수가로 표시) */}
              {k.status === 'waiting' && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>매수목표</Text>
                    <Text style={{ color: colors.buy, fontWeight: '800', fontSize: 13 }}>
                      {formatPrice(buyTargetDisp, proj.market)}
                    </Text>
                  </View>
                  {k.budget != null && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>목표수량</Text>
                      <Text style={{ color: colors.buy, fontWeight: '800', fontSize: 13 }}>
                        {money(estimatedShares(k.budget, buyTargetDisp), 0)}주
                      </Text>
                    </View>
                  )}
                </View>
              )}
              {k.status === 'bought' && sellTargetDisp != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={{ color: colors.textDim, fontSize: 11 }}>매도목표</Text>
                  <Text style={{ color: colors.sell, fontWeight: '800', fontSize: 13 }}>
                    {formatPrice(sellTargetDisp, proj.market)}
                  </Text>
                  {pnl.avgOpenPrice > 0 && (
                    <Text style={{ color: colors.sell, fontWeight: '700', fontSize: 12 }}>
                      (예상 +{Math.round(((sellTargetDisp - pnl.avgOpenPrice) / pnl.avgOpenPrice) * 10000) / 100}%)
                    </Text>
                  )}
                </View>
              )}

              {/* 보유 중이면 강조 박스 (보유수량·평균매수가 / 매입총액·평가총액 / 평가손익) */}
              {pnl.totalQtyOpen > 0 &&
                (() => {
                  const buyTotal = pnl.avgOpenPrice * pnl.totalQtyOpen; // 매입 총액
                  const evalTotal = price != null ? price * pnl.totalQtyOpen : null; // 평가 총액 = 현재가 × 수량
                  const evalPnl = price != null ? (price - pnl.avgOpenPrice) * pnl.totalQtyOpen : null;
                  return (
                    <View
                      style={{
                        backgroundColor: colors.buyBg,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: colors.buy,
                        paddingVertical: spacing.sm,
                        paddingHorizontal: spacing.md,
                        gap: 8,
                      }}
                    >
                      {/* 상단: 좌측 보유수량·평균매수가(작게) / 우측 매입 총액(크게) */}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ gap: 3 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: colors.textDim, fontSize: 11 }}>보유 수량</Text>
                            <Text style={{ color: num.position, fontSize: 13, fontWeight: '800' }}>{money(pnl.totalQtyOpen, 0)}주</Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: colors.textDim, fontSize: 11 }}>평균 매수가</Text>
                            <Text style={{ color: num.position, fontSize: 13, fontWeight: '800' }}>{formatPrice(pnl.avgOpenPrice, proj.market)}</Text>
                          </View>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: colors.textDim, fontSize: 11 }}>매입 총액</Text>
                          <Text style={{ color: num.position, fontSize: 20, fontWeight: '900' }}>{formatMoney(buyTotal, proj.market)}</Text>
                        </View>
                      </View>
                      {/* 평가 총액 */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 6 }}>
                        <Text style={{ color: colors.textDim, fontSize: 12 }}>평가 총액</Text>
                        <Text style={{ color: num.evalTotal, fontSize: 15, fontWeight: '900' }}>
                          {evalTotal != null ? formatMoney(evalTotal, proj.market) : '-'}
                        </Text>
                      </View>
                      {/* 평가손익 */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ color: colors.textDim, fontSize: 12 }}>평가손익</Text>
                        <Text style={{ color: evalPnl != null ? signColor(evalPnl) : colors.textDim, fontSize: 16, fontWeight: '900' }}>
                          {evalPnl != null ? `${evalPnl > 0 ? '+' : ''}${formatMoney(evalPnl, proj.market)}` : '-'}
                        </Text>
                      </View>
                    </View>
                  );
                })()}

              {/* 실현손익 / 거래없음 요약 */}
              <View style={{ flexDirection: 'row', gap: spacing.lg }}>
                {pnl.realized !== 0 && (
                  <Text style={{ color: signColor(pnl.realized), fontSize: 13, fontWeight: '700' }}>
                    실현 {pnl.realized > 0 ? '+' : ''}
                    {formatMoney(pnl.realized, proj.market)}
                  </Text>
                )}
                {kt.length === 0 && <Text style={{ color: colors.textDim, fontSize: 13 }}>거래 없음</Text>}
              </View>

              {/* 펼치면 거래내역 */}
              {open && kt.length > 0 && (
                <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: 4 }}>
                  {kt.map((t) => (
                    <View key={t.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ color: t.side === 'buy' ? colors.buy : colors.sell, fontWeight: '700', fontSize: 13 }}>
                        {t.side === 'buy' ? '매수' : '매도'} · {t.executed_at.slice(0, 10)}
                      </Text>
                      <Text style={{ color: colors.text, fontSize: 13 }}>
                        {formatPrice(t.price, proj.market)} · {money(t.quantity, 0)}주
                      </Text>
                    </View>
                  ))}
                  <Pressable onPress={() => router.push(`/project/${proj.id}`)}>
                    <Text style={{ color: colors.accent, fontWeight: '700', marginTop: 4 }}>프로젝트로 이동 →</Text>
                  </Pressable>
                </View>
              )}
            </Card>
          </Pressable>
        );
        // 보유중=왼쪽 스와이프 익절/손절, 대기중=오른쪽 스와이프 매수주문(+AUTO는 왼쪽 스와이프 자동주문)
        return k.status === 'bought' ? (
          <StopLossSwipe key={k.id} profit={inProfit} onStopLoss={() => confirmStopLossPocket(k, proj, inProfit)}>
            {cardEl}
          </StopLossSwipe>
        ) : k.status === 'waiting' ? (
          (() => {
            // AUTO+계좌: 오른쪽 스와이프 → 가격 직접입력 자동주문 모달. 그 외: 목표가 매수주문.
            const isAuto = tier === 'auto' && !!account && !kisOrderBlocked(proj.market);
            return (
              <BuyOrderSwipe
                key={k.id}
                auto={isAuto}
                onBuy={() => (isAuto ? setAutoOrder({ pocket: k, proj }) : confirmBuyPocket(k, proj))}
              >
                {cardEl}
              </BuyOrderSwipe>
            );
          })()
        ) : (
          <View key={k.id}>{cardEl}</View>
        );
      })}
      </ScrollView>

      {/* AUTO 자동주문 — 매수 가격 직접입력 모달 (왼쪽 스와이프로 열림) */}
      <AutoOrderModal
        target={autoOrder}
        onClose={() => setAutoOrder(null)}
        onSubmit={async (customPrice) => {
          const t = autoOrder;
          setAutoOrder(null);
          if (!t) return;
          const r = await buyPocket(t.pocket, t.proj, customPrice);
          await load();
          if (r.ok) notify('자동주문 전송', `포켓 ${t.pocket.idx + 1} · ${formatPrice(customPrice, t.proj.market)} 지정가 자동주문을 넣었어요.`);
          else notify('자동주문 실패', r.msg ?? '처리하지 못했어요.');
        }}
      />
    </View>
  );
}

// 보유 포켓을 왼쪽으로 스와이프하면 익절/손절이 나타나고, 끝까지 밀면 확인
// 이익이면 '익절하기'(빨강), 손실이면 '손절하기'(파랑)
function StopLossSwipe({ onStopLoss, profit, children }: { onStopLoss: () => void; profit: boolean; children: ReactNode }) {
  const ref = useRef<Swipeable>(null);
  const label = profit ? '익절하기' : '손절하기';
  const bg = profit ? colors.buy : colors.sell;
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={() => (
        <View style={{ width: 80, paddingLeft: spacing.sm }}>
          <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' }}>
            {label.split('').map((ch, i) => (
              <Text key={i} style={{ color: '#fff', fontWeight: '900', fontSize: 15, lineHeight: 19 }}>
                {ch}
              </Text>
            ))}
          </View>
        </View>
      )}
      onSwipeableOpen={(dir) => {
        if (dir === 'right') {
          ref.current?.close();
          onStopLoss();
        }
      }}
    >
      {children}
    </Swipeable>
  );
}

// 대기중 포켓 — 오른쪽으로 스와이프하면 '매수주문' 실행 (AUTO는 가격 직접입력 모달, 다이어리는 목표가)
function BuyOrderSwipe({ onBuy, auto, children }: { onBuy: () => void; auto?: boolean; children: ReactNode }) {
  const ref = useRef<Swipeable>(null);
  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={48}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={{ width: 84, paddingRight: spacing.sm }}>
          <View style={{ flex: 1, backgroundColor: auto ? colors.primary : colors.buy, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' }}>
            {auto && <Text style={{ fontSize: 16, marginBottom: 2 }}>🤖</Text>}
            {(auto ? '자동주문' : '매수주문').split('').map((ch, i) => (
              <Text key={i} style={{ color: auto ? '#04121A' : '#fff', fontWeight: '900', fontSize: 14, lineHeight: 17 }}>
                {ch}
              </Text>
            ))}
          </View>
        </View>
      )}
      onSwipeableOpen={(dir) => {
        if (dir === 'left') {
          ref.current?.close();
          onBuy();
        }
      }}
    >
      {children}
    </Swipeable>
  );
}

// AUTO 자동주문 — 매수 가격 직접 입력 모달
function AutoOrderModal({
  target,
  onClose,
  onSubmit,
}: {
  target: { pocket: Pocket; proj: Project } | null;
  onClose: () => void;
  onSubmit: (price: number) => void;
}) {
  const [raw, setRaw] = useState('');
  const market = target?.proj.market ?? 'KRX';
  const defaultPrice =
    target ? (market === 'KRX' ? alignToKrxTick(target.pocket.buy_target_price, 'buy') : target.pocket.buy_target_price) : 0;
  useEffect(() => {
    if (target) setRaw(String(Math.round(defaultPrice)));
  }, [target, defaultPrice]);
  if (!target) return null;
  const price = Number(rawNumeric(raw)) || 0;
  const aligned = market === 'KRX' ? alignToKrxTick(price, 'buy') : price;
  const qty = estimatedShares(target.pocket.budget, aligned);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg }}>
        <Pressable
          onPress={() => {}}
          style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.primary }}
        >
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>🤖 포켓 {target.pocket.idx + 1} 자동주문</Text>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>{target.proj.name} · 매수 가격을 직접 입력해 지정가 자동주문을 넣습니다.</Text>
          <View>
            <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 4 }}>매수 가격 ({market === 'KRX' ? '₩' : '$'})</Text>
            <TextInput
              value={withCommas(raw)}
              onChangeText={(t) => setRaw(rawNumeric(t))}
              keyboardType="number-pad"
              placeholder={String(Math.round(defaultPrice))}
              placeholderTextColor={colors.textDim}
              style={{
                backgroundColor: colors.cardAlt,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: 12,
                color: colors.buy,
                fontSize: 22,
                fontWeight: '900',
                borderWidth: 1,
                borderColor: colors.border,
              }}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>예상 수량 (배분 예산 기준)</Text>
            <Text style={{ color: num.position, fontWeight: '800', fontSize: 14 }}>{money(qty, 0)}주</Text>
          </View>
          {market === 'KRX' && price > 0 && aligned !== price && (
            <Text style={{ color: colors.textDim, fontSize: 11 }}>호가단위 보정 → {formatPrice(aligned, market)}로 주문됩니다.</Text>
          )}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: 2 }}>
            <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: colors.textDim, fontWeight: '800' }}>취소</Text>
            </Pressable>
            <Pressable
              onPress={() => aligned > 0 && onSubmit(aligned)}
              disabled={aligned <= 0}
              style={{ flex: 2, backgroundColor: aligned > 0 ? colors.buy : colors.border, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>🤖 자동주문 넣기</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}