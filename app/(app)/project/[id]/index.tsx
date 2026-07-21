import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, ChartIcon, Row } from '@/components/ui';
import { BottomTabsBar } from '@/components/BottomTabsBar';
import { colors, formatMoney, formatPrice, money, pocketColor, radius, signColor, spacing } from '@/theme';
import { computePnL, estimatedShares, pnlPct, realizedEvents } from '@/domain/pockets';
import { chooseAction, confirmAction, notify } from '@/lib/alert';
import { usePriceTracker } from '@/services/priceTracker';
import { useAutoTrader } from '@/services/autoTrader';
import { kisOrderBlocked, placeDomesticOrder, placeOverseasOrder } from '@/services/broker/kis';
import type { BrokerAccount, Pocket, Project, Trade } from '@/types/db';

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { tier, session } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [account, setAccount] = useState<BrokerAccount | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const [{ data: p }, { data: k }, { data: t }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('pockets').select('*').eq('project_id', id).order('idx'),
      supabase.from('trades').select('*').eq('project_id', id).order('executed_at'),
    ]);
    if (p) setProject(p as Project);
    if (k) setPockets(k as Pocket[]);
    if (t) setTrades(t as Trade[]);
    setLoading(false);
  }, [id]);

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

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 자동매매 (AUTO 등급 + 프로젝트 자동매매 ON 일 때만 실제 주문)
  const { handleSignal, lastEvent } = useAutoTrader(project, trades, load);

  const { price, change, changePct, updatedAt, status, error, currency } = usePriceTracker(
    project,
    pockets,
    !!project?.is_active,
    handleSignal
  );
  const pnl = computePnL(trades, price);
  const pct = pnlPct(pnl);

  // 실시간 시세의 통화로 시장을 자동 보정 (예: 삼성전자가 달러로 잘못 저장된 경우 원화로)
  const liveMarket = currency === 'KRW' ? 'KRX' : currency === 'USD' ? 'US' : null;
  useEffect(() => {
    if (project && liveMarket && liveMarket !== project.market) {
      setProject((p) => (p ? { ...p, market: liveMarket } : p));
      supabase.from('projects').update({ market: liveMarket }).eq('id', project.id).then(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMarket]);

  // 포켓별 실제 체결가(매수/매도) 매핑
  const buyByPocket = useMemo(() => {
    const m = new Map<string, Trade>();
    trades.filter((t) => t.side === 'buy').forEach((t) => {
      if (t.pocket_id) m.set(t.pocket_id, t); // 시간순이라 마지막(=현재 순환) 매수가 남음
    });
    return m;
  }, [trades]);

  // 포켓별 완료된 순환 횟수 (= 매도 체결 수)
  const cyclesByPocket = useMemo(() => {
    const m = new Map<string, number>();
    trades
      .filter((t) => t.side === 'sell')
      .forEach((t) => {
        if (t.pocket_id) m.set(t.pocket_id, (m.get(t.pocket_id) ?? 0) + 1);
      });
    return m;
  }, [trades]);

  // 매도별 실현손익 매핑 (체결 id → 실현액)
  const realizedByTrade = useMemo(() => {
    const m = new Map<string, number>();
    realizedEvents(trades).forEach((e) => m.set(e.trade.id, e.amount));
    return m;
  }, [trades]);

  // 포켓별 전체 체결 내역 (재시작 이전 순환 포함) — 최신 먼저
  const historyByPocket = useMemo(() => {
    const m = new Map<string, Trade[]>();
    trades.forEach((t) => {
      if (!t.pocket_id) return;
      const arr = m.get(t.pocket_id);
      if (arr) arr.push(t);
      else m.set(t.pocket_id, [t]);
    });
    m.forEach((arr) => arr.sort((a, b) => (a.executed_at < b.executed_at ? 1 : -1)));
    return m;
  }, [trades]);

  // 매도 완료된 포켓을 다시 매수 대기로 (기존 기록은 그대로 유지)
  const restartPocket = async (k: Pocket) => {
    const { error } = await supabase
      .from('pockets')
      .update({ status: 'waiting', sell_target_price: null })
      .eq('id', k.id);
    if (error) return notify('처리 실패', error.message);
    load();
  };

  // 포켓 1개 손절 (전량 매도). AUTO+계좌+네이티브면 실제 KIS 주문, 그 외엔 체결 기록만.
  const stopLossPocket = async (k: Pocket): Promise<{ ok: boolean; msg?: string }> => {
    if (!project || !session?.user?.id) return { ok: false };
    const pocketTrades = trades.filter((t) => t.pocket_id === k.id);
    const qty = Math.floor(computePnL(pocketTrades, null).totalQtyOpen);
    if (qty <= 0) return { ok: false, msg: '보유 수량 없음' };
    const sellPrice = price ?? k.sell_target_price ?? buyByPocket.get(k.id)?.price ?? 0;
    if (sellPrice <= 0) return { ok: false, msg: '현재가를 확인할 수 없어요' };

    // AUTO 등급 + 계좌 + 네이티브면 실제 매도 주문 전송
    if (tier === 'auto' && account && !kisOrderBlocked(project.market)) {
      try {
        const input = { side: 'sell' as const, symbol: project.symbol, quantity: qty, price: sellPrice };
        const r = project.market === 'US' ? await placeOverseasOrder(account, input) : await placeDomesticOrder(account, input);
        supabase
          .from('auto_orders')
          .insert({
            user_id: session.user.id,
            project_id: project.id,
            pocket_id: k.id,
            side: 'sell',
            symbol: project.symbol,
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

    // 매도 체결 기록 + 포켓 상태 갱신
    const note = sellPrice >= computePnL(pocketTrades, null).avgOpenPrice ? '익절' : '손절';
    await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: project.id,
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

  // 포켓 익절/손절 확인(스와이프에서 호출)
  const confirmStopLossPocket = (k: Pocket, profit: boolean) => {
    const word = profit ? '익절' : '손절';
    confirmAction(
      `포켓 ${word}`,
      `포켓 ${k.idx + 1}을(를) 지금 전량 ${word}(매도)할까요?${tier === 'auto' && account ? ' 실제 매도 주문이 전송됩니다.' : ''}`,
      async () => {
        const r = await stopLossPocket(k);
        await load();
        if (!r.ok) notify(`${word} 실패`, r.msg ?? '처리하지 못했어요.');
      },
      word
    );
  };

  // 프로젝트 종료 — 보유 포켓이 있으면 손절 여부를 물어봄
  const promptClose = () => {
    if (!project) return;
    const held = pockets.filter((k) => k.status === 'bought');
    if (held.length === 0) {
      return confirmAction(
        '프로젝트 종료',
        `"${project.name}"을(를) 종료할까요? 종료하면 목록에서 숨겨지고, “지난 프로젝트 보기”로 다시 찾을 수 있어요.`,
        () => setClosed(true),
        '종료'
      );
    }
    chooseAction(
      '프로젝트 종료',
      `보유 중인 포켓이 ${held.length}개 있어요. 전량 매도(이익=익절·손실=손절) 주문을 넣고 종료할까요?`,
      [
        {
          text: '매도 후 종료',
          style: 'destructive',
          onPress: async () => {
            let done = 0;
            let failMsg = '';
            for (const k of held) {
              const r = await stopLossPocket(k);
              if (r.ok) done++;
              else failMsg = r.msg ?? failMsg;
            }
            await setClosed(true);
            notify('종료 완료', `${held.length}개 중 ${done}개 손절 처리했어요.${failMsg ? ` (일부 실패: ${failMsg})` : ''}`);
          },
        },
        { text: '그냥 종료', onPress: () => setClosed(true) },
        { text: '취소', style: 'cancel' },
      ]
    );
  };

  const toggleActive = async (val: boolean) => {
    if (!project) return;
    setProject({ ...project, is_active: val });
    await supabase.from('projects').update({ is_active: val }).eq('id', project.id);
  };

  const toggleAutoTrade = async (val: boolean) => {
    if (!project) return;
    const prev = project;
    setProject({ ...project, auto_trade_enabled: val });
    const { error } = await supabase
      .from('projects')
      .update({ auto_trade_enabled: val })
      .eq('id', project.id);
    if (error) {
      setProject(prev);
      if (/42703|auto_trade_enabled|does not exist|schema cache|PGRST204/i.test(`${error.code} ${error.message}`)) {
        notify('DB 준비 필요', '자동매매에 필요한 컬럼이 아직 없어요. 마이그레이션(20260716e)을 Supabase에서 실행하면 켜집니다.');
      } else {
        notify('처리 실패', error.message);
      }
    }
  };

  const setClosed = async (close: boolean) => {
    if (!project) return;
    const prev = project;
    const closed_at = close ? new Date().toISOString() : null;
    // 종료하면 실시간 추적도 끔
    const is_active = close ? false : project.is_active;
    setProject({ ...project, closed_at, is_active });
    const { error } = await supabase.from('projects').update({ closed_at, is_active }).eq('id', project.id);
    if (error) {
      setProject(prev); // 롤백
      if (/42703|closed_at|does not exist|schema cache|PGRST205/i.test(`${error.code} ${error.message}`)) {
        notify('DB 준비 필요', '프로젝트 종료 기능에 필요한 컬럼이 아직 없어요. 최신 마이그레이션(20260716b)을 Supabase에서 실행하면 켜집니다.');
      } else {
        notify('처리 실패', error.message);
      }
    }
  };

  if (loading || !project) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const mkt = liveMarket ?? project.market;
  const marketLabel = mkt === 'KRX' ? '한국' : '미국';

  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
    >
      <Stack.Screen
        options={{
          title: project.name,
          // 실시간 추적 중 헤더 리렌더로 기본 < 버튼이 씹히는 경우가 있어, 넉넉한 터치영역 + 폴백을 가진 커스텀 버튼 사용
          headerLeft: () => (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              hitSlop={20}
              style={{ ...headerIconStyle, marginLeft: spacing.sm, marginRight: spacing.sm }}
            >
              <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', marginTop: -3 }}>‹</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/project/${project.id}/chart`)}
              hitSlop={10}
              style={{ ...headerIconStyle, marginRight: spacing.sm }}
            >
              <ChartIcon size={16} />
            </Pressable>
          ),
        }}
      />

      {/* 실시간 시세 */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.textDim }}>
              {project.symbol} · {marketLabel}
            </Text>
            <Text style={{ color: colors.text, fontSize: 38, fontWeight: '900', marginTop: 2 }}>
              {price != null ? formatPrice(price, mkt) : '—'}
            </Text>
            {change != null && changePct != null && (
              <Text style={{ color: signColor(change), fontSize: 16, fontWeight: '800', marginTop: 2 }}>
                {change > 0 ? '▲' : change < 0 ? '▼' : ''} {formatMoney(Math.abs(change), mkt)} ({changePct > 0 ? '+' : ''}
                {changePct}%)
              </Text>
            )}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>실시간 추적</Text>
            <Switch value={project.is_active} onValueChange={toggleActive} />
          </View>
        </View>

        {/* 기준가 (전략 기준점) */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.cardAlt, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 6 }}>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>기준가 (포켓1 매수 기준)</Text>
          <Text style={{ color: colors.text, fontWeight: '800' }}>{formatPrice(project.base_price, mkt)}</Text>
        </View>

        {/* 상태 표시 (#7 확실한 실시간 표기) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {!project.is_active ? (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>추적이 꺼져 있어요</Text>
          ) : status === 'live' ? (
            <>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.buy }} />
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                실시간 · {updatedAt ? new Date(updatedAt).toLocaleTimeString() : ''} 업데이트
              </Text>
            </>
          ) : status === 'loading' ? (
            <>
              <ActivityIndicator size="small" color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12 }}>시세 불러오는 중…</Text>
            </>
          ) : (
            <Text style={{ color: colors.warn, fontSize: 12 }}>
              시세를 불러오지 못했어요. 폰(Expo Go)에서 실행하거나 프록시/목업 설정이 필요해요.
            </Text>
          )}
        </View>
      </Card>

      {/* 자동매매 켜기/끄기만 (상세 설정·계좌연결은 프로젝트 목록/MY 탭에서) */}
      {tier === 'auto' && (
        <Card style={project.auto_trade_enabled ? { borderColor: colors.buy } : undefined}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>🤖 자동매매</Text>
              <Text style={{ color: project.auto_trade_enabled ? colors.buy : colors.textDim, fontSize: 12 }}>
                {project.auto_trade_enabled ? 'ON · 목표가 도달 시 자동 주문' : 'OFF · 수동 매매'}
              </Text>
            </View>
            <Switch value={project.auto_trade_enabled} onValueChange={toggleAutoTrade} />
          </View>
          {lastEvent && (
            <View
              style={{
                backgroundColor: lastEvent.ok ? colors.buyBg : 'rgba(251,191,36,0.12)',
                borderRadius: 8,
                padding: spacing.sm,
              }}
            >
              <Text style={{ color: lastEvent.ok ? colors.buy : colors.warn, fontSize: 12, fontWeight: '700' }}>
                {lastEvent.ok ? '✅' : '⚠️'} 포켓 {lastEvent.pocketIdx + 1} 자동 {lastEvent.kind === 'buy' ? '매수' : '매도'} ·{' '}
                {lastEvent.message}
              </Text>
            </View>
          )}
        </Card>
      )}

      {/* 손익 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>손익</Text>
        <Row
          label="보유 수량 / 평단"
          value={`${money(pnl.totalQtyOpen, 0)}주  ·  평단 ${formatPrice(pnl.avgOpenPrice, mkt)}`}
        />
        <Row
          label="평가 총액"
          value={price != null ? formatMoney(pnl.totalQtyOpen * price, mkt) : '-'}
        />
        <Row label="평가 손익 (미매도분)" value={formatMoney(pnl.unrealized, mkt)} valueColor={signColor(pnl.unrealized)} />
        <Row label="평가 수익률" value={`${pct > 0 ? '+' : ''}${pct}%`} valueColor={signColor(pct)} />
        <Row label="실현 손익 (매도분)" value={formatMoney(pnl.realized, mkt)} valueColor={signColor(pnl.realized)} />
      </Card>

      {/* 포켓 */}
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>🧺 5포켓</Text>
          <View style={{ backgroundColor: colors.buyBg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.buy }}>
            <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 13 }}>매수간격 ▼{project.buy_interval_pct}%</Text>
          </View>
          <View style={{ backgroundColor: colors.sellBg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.sell }}>
            <Text style={{ color: colors.sell, fontWeight: '900', fontSize: 13 }}>매도목표 ▲{project.sell_target_pct}%</Text>
          </View>
        </View>
        {project.total_budget != null && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
            <Text style={{ color: colors.textDim }}>💰 프로젝트 예산</Text>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>{formatMoney(project.total_budget, mkt)}</Text>
          </View>
        )}
        {pockets.map((k) => {
          const card = (
            <PocketCard
              pocket={k}
              market={mkt}
              price={price}
              buyIntervalPct={Number(project.buy_interval_pct)}
              sellTargetPct={Number(project.sell_target_pct)}
              buyTrade={buyByPocket.get(k.id) ?? null}
              cycles={cyclesByPocket.get(k.id) ?? 0}
              history={historyByPocket.get(k.id) ?? []}
              realizedByTrade={realizedByTrade}
              autoMode={tier === 'auto'}
              autoTradeOn={project.auto_trade_enabled}
              buyFailMsg={
                lastEvent && !lastEvent.ok && lastEvent.kind === 'buy' && lastEvent.pocketIdx === k.idx
                  ? lastEvent.message
                  : null
              }
              sellFailMsg={
                lastEvent && !lastEvent.ok && lastEvent.kind === 'sell' && lastEvent.pocketIdx === k.idx
                  ? lastEvent.message
                  : null
              }
              onRestart={() => restartPocket(k)}
              onTrade={(side, sqty, sprice, budget) =>
                router.push(
                  `/project/${project.id}/trade?pocket=${k.id}&idx=${k.idx}&side=${side}&sqty=${sqty}&sprice=${sprice}&budget=${budget ?? ''}&mkt=${mkt}`
                )
              }
            />
          );
          // 현재가 >= 평균매수가면 이익(익절), 아니면 손실(손절)
          const pocketOpen = computePnL(trades.filter((t) => t.pocket_id === k.id), null);
          const inProfit = price != null && pocketOpen.avgOpenPrice > 0 && price >= pocketOpen.avgOpenPrice;
          // 보유중(매수 완료) 포켓만 왼쪽으로 스와이프하면 익절/손절
          return k.status === 'bought' ? (
            <StopLossSwipe key={k.id} profit={inProfit} onStopLoss={() => confirmStopLossPocket(k, inProfit)}>
              {card}
            </StopLossSwipe>
          ) : (
            <View key={k.id}>{card}</View>
          );
        })}
      </View>

      {/* 수정 / 삭제 (프로젝트 종료 버튼 바로 위) */}
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Button title="수정" variant="primary" onPress={() => router.push(`/project/${project.id}/edit`)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="삭제"
            variant="danger"
            onPress={() =>
              confirmAction(
                '프로젝트 삭제',
                `"${project.name}"과(와) 모든 포켓·거래 기록이 삭제됩니다. 계속할까요?`,
                async () => {
                  await supabase.from('projects').delete().eq('id', project.id);
                  router.replace('/');
                },
                '삭제'
              )
            }
          />
        </View>
      </View>

      {project.closed_at ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center' }}>
            {project.closed_at.slice(0, 10)}에 종료된 프로젝트입니다.
          </Text>
          <Button title="프로젝트 재개" variant="primary" onPress={() => setClosed(false)} />
        </View>
      ) : (
        <Button title="프로젝트 종료 (매매 완료)" variant="sell" onPress={promptClose} />
      )}

    </ScrollView>
    <BottomTabsBar active="index" />
    </View>
  );
}

// 포켓 강조 애니메이션
//  full   : 포켓 전체가 깜박임 (매수/매도 포인트 도달)
//  border : 외곽선만 깜박임 (도달했으나 자동 매매 실패)
//  none   : 애니메이션 없음
function PocketAlert({ mode, accent, children }: { mode: 'full' | 'border' | 'none'; accent: string; children: ReactNode }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (mode === 'none') {
      op.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: mode === 'full' ? 0.35 : 0.1, duration: 550, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [mode, op]);

  if (mode === 'full') return <Animated.View style={{ opacity: op }}>{children}</Animated.View>;
  if (mode === 'border')
    return (
      <View>
        {children}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderWidth: 2.5,
            borderColor: accent,
            borderRadius: radius.lg,
            opacity: op,
          }}
        />
      </View>
    );
  return <>{children}</>;
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

// 헤더 우측 아이콘 버튼 공통 스타일 (수정·삭제·차트)
const headerIconStyle = {
  width: 34,
  height: 34,
  borderRadius: 17,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.cardAlt,
  borderWidth: 1,
  borderColor: colors.border,
};

// 자동매매 중일 때 보이는 작은 수동 입력 버튼
function ManualEntryButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: colors.cardAlt,
      }}
    >
      <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '700' }}>✍️ 수동으로 입력</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------
// 포켓 카드 — 상태에 따라 표시가 달라진다.
//  waiting: 매수 목표가 강조(빨강) + 매수 체결 버튼
//  bought : 음영으로 "가득 참" 표현 + 매도 목표가 크게(파랑) + 매도 체결 버튼
//  sold   : 거래 완료
// ---------------------------------------------------------------
function PocketCard({
  pocket: k,
  market,
  price,
  buyIntervalPct,
  sellTargetPct,
  buyTrade,
  cycles,
  history,
  realizedByTrade,
  autoMode,
  autoTradeOn,
  buyFailMsg,
  sellFailMsg,
  onRestart,
  onTrade,
}: {
  pocket: Pocket;
  market: string;
  price: number | null;
  buyIntervalPct: number; // 매수 간격 % (포켓별 -할인율 표시용)
  sellTargetPct: number; // 매도 목표 % (매도가 +표시용)
  buyTrade: Trade | null;
  cycles: number;
  history: Trade[]; // 이 포켓의 전체 체결(모든 순환) — 최신 먼저
  realizedByTrade: Map<string, number>; // 매도 체결 id → 실현손익
  autoMode: boolean; // AUTO 등급 → 자동체결 안내 + 수동 입력 버튼을 작게
  autoTradeOn: boolean; // 이 프로젝트의 자동매매 스위치 상태 (안내 문구용)
  buyFailMsg: string | null; // 자동 매수 실패 사유 (있으면 깜박이며 표시)
  sellFailMsg: string | null; // 자동 매도 실패 사유
  onRestart: () => void;
  onTrade: (side: 'buy' | 'sell', sqty: number, sprice: number, budget?: number) => void;
}) {
  const [showLog, setShowLog] = useState(false);
  // 이 포켓에서 실현된 손익 합계 (모든 순환)
  const pocketRealized = history.reduce((s, t) => s + (t.side === 'sell' ? realizedByTrade.get(t.id) ?? 0 : 0), 0);
  // 포켓별 기준가 대비 할인율 (포켓1=0%=기준가, 포켓2=-5%, …)
  const buyDiscPct = Math.round(k.idx * buyIntervalPct * 100) / 100;
  const buyReady = k.status === 'waiting' && price != null && price <= k.buy_target_price;
  const sellReady =
    k.status === 'bought' && k.sell_target_price != null && price != null && price >= k.sell_target_price;

  // 매수가능 수량: 배분액 / (현재가 또는 매수목표가)
  const refPrice = price ?? k.buy_target_price;
  const buyableQty = estimatedShares(k.budget, refPrice);

  const statusPill =
    k.status === 'bought'
      ? { text: '보유중', color: colors.buy }
      : k.status === 'buy_ordered'
        ? { text: '매수 주문완료', color: colors.warn }
        : k.status === 'sell_ordered'
          ? { text: '매도 주문완료', color: colors.warn }
          : k.status === 'sold'
            ? { text: '매도 완료', color: colors.sell }
            : { text: '대기중', color: colors.textDim };

  // 주문완료(체결 대기) 안내 단어
  const pendingWord = k.status === 'buy_ordered' ? '매수' : k.status === 'sell_ordered' ? '매도' : null;
  // 보유 정보/매도목표를 보여줄 상태 (보유중 + 매도주문완료 + 매수주문완료)
  const heldLike = k.status === 'bought' || k.status === 'buy_ordered' || k.status === 'sell_ordered';

  // 음영(가득 참) 배경 + 포켓 번호별 고유 색 띠
  const cardStyle = {
    ...(k.status === 'bought'
      ? { backgroundColor: colors.buyBg, borderColor: colors.buy }
      : pendingWord
        ? { borderColor: colors.warn }
        : k.status === 'sold'
          ? { backgroundColor: colors.sellBg, borderColor: colors.sell }
          : { borderColor: buyReady ? colors.buy : colors.border }),
    borderLeftWidth: 5,
    borderLeftColor: pocketColor(k.idx),
  };

  // 매수/매도 포인트 도달·실패 모두 외곽선 깜박임으로 강조 (실패 시 사유 문구는 고정 표시)
  const reached = k.status === 'waiting' ? buyReady : k.status === 'bought' ? sellReady : false;
  const failed = k.status === 'waiting' ? !!buyFailMsg : k.status === 'bought' ? !!sellFailMsg : false;
  const alertMode: 'full' | 'border' | 'none' = reached || failed ? 'border' : 'none';
  const alertAccent = k.status === 'bought' ? colors.sell : colors.buy;

  return (
    <PocketAlert mode={alertMode} accent={alertAccent}>
    <Card style={cardStyle as any}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: pocketColor(k.idx), fontWeight: '900', fontSize: 16 }}>포켓 {k.idx + 1}</Text>
          {cycles > 0 && (
            <View style={{ backgroundColor: colors.cardAlt, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '700' }}>{cycles}회 순환</Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {k.status === 'bought' && <Text style={{ fontSize: 14 }}>🔴</Text>}
          {pendingWord && <Text style={{ fontSize: 14 }}>🕐</Text>}
          <Text style={{ color: statusPill.color, fontWeight: '800', fontSize: 12 }}>{statusPill.text}</Text>
        </View>
      </View>

      {k.status === 'waiting' && (
        <>
          {/* 매수 목표가 크게 (빨강) + 기준가 대비 할인율 배지 */}
          <View style={{ marginTop: spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>💰 매수 목표가</Text>
              <View style={{ backgroundColor: colors.buyBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 }}>
                <Text style={{ color: colors.buy, fontSize: 11, fontWeight: '800' }}>
                  {k.idx === 0 ? '기준가' : `기준가 -${buyDiscPct}%`}
                </Text>
              </View>
            </View>
            <Text style={{ color: colors.buy, fontSize: 26, fontWeight: '900' }}>
              {formatPrice(k.buy_target_price, market)}
            </Text>
          </View>
          {k.budget != null && (
            <Row label={`배분 예산 (비중 ${k.weight}%)`} value={formatPrice(k.budget, market)} />
          )}
          {k.budget != null && (
            <Row label="매수 가능 수량" value={`${money(buyableQty, 0)}주`} valueColor={colors.buy} />
          )}
          {(buyReady || buyFailMsg) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
              <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 15 }}>● 매수포인트 도달</Text>
              {buyFailMsg && (
                <Text style={{ color: colors.warn, fontWeight: '800', fontSize: 12 }}>· 매수 실패: {buyFailMsg}</Text>
              )}
            </View>
          )}
          {autoMode ? (
            <View style={{ marginTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
              <Text style={{ color: autoTradeOn ? colors.buy : colors.textDim, fontSize: 12, flex: 1 }}>
                {autoTradeOn ? '🤖 목표가 도달 시 자동 매수' : '🤖 자동매매 스위치를 켜면 자동 매수돼요'}
              </Text>
              <ManualEntryButton onPress={() => onTrade('buy', buyableQty, price ?? k.buy_target_price)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매수 체결 입력"
                variant="buy"
                large
                onPress={() => onTrade('buy', buyableQty, price ?? k.buy_target_price)}
              />
            </View>
          )}
        </>
      )}

      {heldLike && (
        <>
          {/* 보유 정보 — 2×2 그리드 (보유수량 · 평균매수가 · 평가총액 · 평가손익) */}
          {buyTrade &&
            (() => {
              const qty = buyTrade.quantity;
              const avg = buyTrade.price;
              const evalTotal = (price ?? avg) * qty;
              const evalPnl = price != null ? (price - avg) * qty : null;
              return (
                <View
                  style={{
                    marginTop: spacing.xs,
                    backgroundColor: colors.buyBg,
                    borderRadius: radius.sm,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.md,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>보유 수량</Text>
                      <Text style={{ color: colors.buy, fontSize: 15, fontWeight: '900' }}>{money(qty, 0)}주</Text>
                    </View>
                    <View style={{ flex: 1, alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>평균 매수가</Text>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '900' }}>{formatPrice(avg, market)}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>평가 총액</Text>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '900' }}>{formatMoney(evalTotal, market)}</Text>
                    </View>
                    <View style={{ flex: 1, alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>평가손익</Text>
                      <Text style={{ color: evalPnl != null ? signColor(evalPnl) : colors.textDim, fontSize: 15, fontWeight: '900' }}>
                        {evalPnl != null ? `${evalPnl > 0 ? '+' : ''}${formatMoney(evalPnl, market)}` : '-'}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })()}

          {/* 매도 목표가 크게 (파랑) + 매수가 대비 +수익률 배지 */}
          <View style={{ marginTop: spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>매도 목표가</Text>
              <View style={{ backgroundColor: colors.sellBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 }}>
                <Text style={{ color: colors.sell, fontSize: 11, fontWeight: '800' }}>매수가 +{sellTargetPct}%</Text>
              </View>
            </View>
            <Text style={{ color: colors.sell, fontSize: 26, fontWeight: '900' }}>
              {k.sell_target_price != null ? formatPrice(k.sell_target_price, market) : '-'}
            </Text>
          </View>
          {(sellReady || sellFailMsg) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
              <Text style={{ color: colors.sell, fontWeight: '900', fontSize: 15 }}>● 매도포인트 도달</Text>
              {sellFailMsg && (
                <Text style={{ color: colors.warn, fontWeight: '800', fontSize: 12 }}>· 매도 실패: {sellFailMsg}</Text>
              )}
            </View>
          )}
          {pendingWord ? (
            <View
              style={{
                marginTop: spacing.sm,
                backgroundColor: 'rgba(251,191,36,0.12)',
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.warn,
                padding: spacing.sm,
              }}
            >
              <Text style={{ color: colors.warn, fontWeight: '800', fontSize: 13 }}>🕐 {pendingWord} 주문완료 · 체결 대기중</Text>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>
                체결이 확인되면 자동으로 {pendingWord === '매수' ? '보유중' : '매도완료'}으로 바뀌어요.
              </Text>
            </View>
          ) : autoMode ? (
            <View style={{ marginTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
              <Text style={{ color: autoTradeOn ? colors.sell : colors.textDim, fontSize: 12, flex: 1 }}>
                {autoTradeOn ? '🤖 목표가 도달 시 자동 매도' : '🤖 자동매매 스위치를 켜면 자동 매도돼요'}
              </Text>
              <ManualEntryButton onPress={() => onTrade('sell', buyTrade?.quantity ?? 0, price ?? k.sell_target_price ?? 0)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매도 체결 입력"
                variant="sell"
                large
                onPress={() => onTrade('sell', buyTrade?.quantity ?? 0, price ?? k.sell_target_price ?? 0)}
              />
            </View>
          )}
        </>
      )}

      {k.status === 'sold' && (
        <View style={{ marginTop: spacing.xs, gap: spacing.sm }}>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            이 포켓은 매도까지 완료됐어요. 다시 시작하면 새 매수 대기 상태가 되고, 이전 기록은 그대로 남습니다.
          </Text>
          <Button
            title="🔄 포켓 재시작 (다시 매수 대기)"
            variant="buy"
            large
            onPress={onRestart}
          />
        </View>
      )}

      {/* 체결 내역 (탭하면 펼침) — 재시작 이전 순환 기록도 모두 보존 */}
      {history.length > 0 && (
        <View style={{ marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm }}>
          <Pressable
            onPress={() => setShowLog((s) => !s)}
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }}>
              🧾 체결 내역 {history.length}건 {showLog ? '▲' : '▼'}
            </Text>
            {pocketRealized !== 0 && (
              <Text style={{ color: signColor(pocketRealized), fontWeight: '800', fontSize: 13 }}>
                실현 {pocketRealized > 0 ? '+' : ''}
                {formatMoney(pocketRealized, market)}
              </Text>
            )}
          </Pressable>
          {showLog && (
            <View style={{ marginTop: spacing.sm, gap: 6 }}>
              {history.map((t) => {
                const realized = t.side === 'sell' ? realizedByTrade.get(t.id) : undefined;
                return (
                  <View key={t.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: t.side === 'buy' ? colors.buy : colors.sell, fontWeight: '700', fontSize: 13 }}>
                      {t.side === 'buy' ? '매수' : '매도'} · {t.executed_at.slice(0, 10)}
                    </Text>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.text, fontSize: 13 }}>
                        {formatPrice(t.price, market)} · {money(t.quantity, 0)}주
                      </Text>
                      {realized != null && realized !== 0 && (
                        <Text style={{ color: signColor(realized), fontSize: 11, fontWeight: '800' }}>
                          실현 {realized > 0 ? '+' : ''}
                          {formatMoney(realized, market)}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
    </Card>
    </PocketAlert>
  );
}
