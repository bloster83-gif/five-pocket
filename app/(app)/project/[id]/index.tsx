import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Modal, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, ChartIcon, Row } from '@/components/ui';
import { BottomTabsBar } from '@/components/BottomTabsBar';
import { EditTargetsModal } from '@/components/EditTargetsModal';
import { colors, formatMoney, formatPrice, money, num, pocketColor, radius, rawNumeric, signColor, spacing, withCommas } from '@/theme';
import { alignToKrxTick, computePnL, estimatedShares, pnlPct, realizedEvents, sellTargetFromFill } from '@/domain/pockets';
import { chooseAction, confirmAction, notify } from '@/lib/alert';
import { usePriceTracker } from '@/services/priceTracker';
import { useAutoTrader } from '@/services/autoTrader';
import { getOrderFill, kisOrderBlocked, placeDomesticOrder, placeOverseasOrder } from '@/services/broker/kis';
import type { BrokerAccount, Pocket, Project, Trade } from '@/types/db';

export default function ProjectDetailScreen() {
  const { id, close: closeParam } = useLocalSearchParams<{ id: string; close?: string }>();
  const router = useRouter();
  const { tier, session } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [account, setAccount] = useState<BrokerAccount | null>(null);
  const [autoOrderPocket, setAutoOrderPocket] = useState<Pocket | null>(null); // 왼쪽 스와이프 → 가격 직접입력 자동주문(AUTO)
  const [loading, setLoading] = useState(true);
  const [budgetOpen, setBudgetOpen] = useState(false); // 예산 배너 펼침(포켓별 배분)

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

  // 화면 열 때 자동으로 미체결 자동주문을 실제 체결가로 조용히 동기화 (버튼 없이)
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (!account || !id || reconciledRef.current) return;
    reconciledRef.current = true;
    (async () => {
      const { data: orders } = await supabase.from('auto_orders').select('*').eq('project_id', id).eq('status', 'sent');
      let changed = false;
      for (const o of (orders ?? []) as any[]) {
        if (!o.kis_order_no) continue;
        const proj = await supabase.from('projects').select('market,symbol,sell_target_pct').eq('id', id).single();
        const p = proj.data as { market: string; symbol: string; sell_target_pct: number } | null;
        if (!p) continue;
        const fill = await getOrderFill(account, p.market === 'US' ? 'US' : 'KRX', o.kis_order_no, p.symbol);
        if (!fill || fill.avgPrice <= 0) continue;
        // 이 주문에 해당하는 체결 기록이 이미 있는지 확인 (중복 방지)
        const { data: existing } = await supabase
          .from('trades')
          .select('id')
          .eq('project_id', id)
          .ilike('note', `%${o.kis_order_no}%`)
          .limit(1);
        if (existing && existing.length > 0) {
          // 이미 기록 있으면 실제 체결가/수량으로 갱신 (주로 매수)
          await supabase
            .from('trades')
            .update({ price: fill.avgPrice, quantity: fill.filledQty })
            .eq('project_id', id)
            .ilike('note', `%${o.kis_order_no}%`);
        } else {
          // 기록이 없으면(=주문완료 매도 등 체결 시점에 기록) 지금 체결 기록을 생성
          await supabase.from('trades').insert({
            user_id: o.user_id,
            project_id: id,
            pocket_id: o.pocket_id,
            side: o.side,
            price: fill.avgPrice,
            quantity: fill.filledQty,
            executed_at: new Date().toISOString(),
            note: `자동주문(KIS ${o.kis_order_no}) ${o.side === 'sell' ? '매도' : '매수'}`,
          });
        }
        if (o.pocket_id) {
          if (o.side === 'buy') {
            await supabase
              .from('pockets')
              .update({
                status: 'bought',
                sell_target_price:
                  p.market === 'KRX'
                    ? alignToKrxTick(sellTargetFromFill(fill.avgPrice, Number(p.sell_target_pct)), 'sell')
                    : sellTargetFromFill(fill.avgPrice, Number(p.sell_target_pct)),
              })
              .eq('id', o.pocket_id);
          } else {
            await supabase.from('pockets').update({ status: 'sold' }).eq('id', o.pocket_id);
          }
        }
        await supabase.from('auto_orders').update({ status: 'filled' }).eq('id', o.id);
        changed = true;
      }
      if (changed) load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, id]);

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
  const pct = Math.round(pnlPct(pnl) * 10) / 10; // 평가 수익률 (소수점 첫째)

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

  // 포켓 1개 익절/손절 (전량 매도).
  //  - AUTO 등급 + 계좌 + 네이티브: 실제 KIS 매도 주문을 자동 전송하고 '자동주문'으로 기록
  //    (체결 확인되면 '보유완료→매도완료(sold)', 미체결이면 '매도 주문완료(sell_ordered)' 상태.
  //     서버 러너/재조회가 나중에 실제 체결가로 자동 동기화)
  //  - 그 외(다이어리 수동): 현재가로 매도 체결만 기록('익절'/'손절')
  const stopLossPocket = async (k: Pocket): Promise<{ ok: boolean; msg?: string }> => {
    if (!project || !session?.user?.id) return { ok: false };
    const pocketTrades = trades.filter((t) => t.pocket_id === k.id);
    const qty = Math.floor(computePnL(pocketTrades, null).totalQtyOpen);
    if (qty <= 0) return { ok: false, msg: '보유 수량 없음' };
    const sellPrice = price ?? k.sell_target_price ?? buyByPocket.get(k.id)?.price ?? 0;
    if (sellPrice <= 0) return { ok: false, msg: '현재가를 확인할 수 없어요' };
    const word = sellPrice >= computePnL(pocketTrades, null).avgOpenPrice ? '익절' : '손절';

    // AUTO 등급 + 계좌 + 네이티브면 실제 매도 주문 전송 (자동주문 흐름과 동일)
    if (tier === 'auto' && account && !kisOrderBlocked(project.market)) {
      try {
        const input = { side: 'sell' as const, symbol: project.symbol, quantity: qty, price: sellPrice };
        const r = project.market === 'US' ? await placeOverseasOrder(account, input) : await placeDomesticOrder(account, input);
        await supabase.from('auto_orders').insert({
          user_id: session.user.id,
          project_id: project.id,
          pocket_id: k.id,
          side: 'sell',
          symbol: project.symbol,
          order_price: sellPrice,
          quantity: qty,
          status: 'sent',
          kis_order_no: r.orderNo,
        });

        // 실제 체결 여부·단가 확인 (미체결이면 지정가로 기록하고 '매도 주문완료' 상태)
        let fillPrice = sellPrice;
        let fillQty = qty;
        let filled = false;
        try {
          await new Promise((res) => setTimeout(res, 2500));
          const fill = await getOrderFill(account, project.market === 'US' ? 'US' : 'KRX', r.orderNo, project.symbol);
          if (fill && fill.filledQty > 0 && fill.avgPrice > 0) {
            filled = true;
            fillPrice = fill.avgPrice;
            fillQty = fill.filledQty;
          }
        } catch {
          /* 조회 실패 → 미체결로 간주(주문완료), 지정가 기록 */
        }

        // 매도는 '체결'되어야 매매일지에 기록(실현손익 반영). 미체결(주문완료)이면 기록하지 않음.
        // (체결 대기중엔 여전히 보유 상태이므로 매수 기록만 남고, 체결되면 재조회가 매도 기록을 생성)
        if (filled) {
          await supabase.from('trades').insert({
            user_id: session.user.id,
            project_id: project.id,
            pocket_id: k.id,
            side: 'sell',
            price: fillPrice,
            quantity: fillQty,
            executed_at: new Date().toISOString(),
            note: `자동주문(KIS ${r.orderNo || '-'}) ${word}`,
          });
        }
        await supabase.from('pockets').update({ status: filled ? 'sold' : 'sell_ordered' }).eq('id', k.id);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, msg: e?.message ?? '주문 실패' };
      }
    }

    // 다이어리(수동): 현재가로 매도 체결만 기록
    await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: project.id,
      pocket_id: k.id,
      side: 'sell',
      price: sellPrice,
      quantity: qty,
      executed_at: new Date().toISOString(),
      note: word,
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

  // 대기중 포켓 매수 주문 — 매수 목표가(지정가) 기준. 손절과 대칭.
  //  AUTO+계좌: 실제 매수 주문 전송, Diary: 매수 목표가로 체결 기록.
  const buyPocket = async (k: Pocket, customPrice?: number): Promise<{ ok: boolean; msg?: string }> => {
    if (!project || !session?.user?.id) return { ok: false };
    const isKrx = project.market === 'KRX';
    // 매수 가격: 직접 입력(customPrice)이 있으면 그 값, 없으면 매수 목표가. KRX 는 호가단위 내림 정렬.
    const rawBuy = customPrice && customPrice > 0 ? customPrice : k.buy_target_price;
    const buyPrice = isKrx ? alignToKrxTick(rawBuy, 'buy') : rawBuy;
    if (!buyPrice || buyPrice <= 0) return { ok: false, msg: '매수 가격이 없어요' };
    const qty = estimatedShares(k.budget, buyPrice);
    if (qty <= 0) return { ok: false, msg: '배분 예산으로 살 수 있는 수량이 없어요' };
    const rawSell = sellTargetFromFill(buyPrice, Number(project.sell_target_pct));
    const sellTgt = isKrx ? alignToKrxTick(rawSell, 'sell') : rawSell;

    // AUTO 등급 + 계좌 + 네이티브면 실제 매수 주문 전송 (자동주문 흐름과 동일)
    if (tier === 'auto' && account && !kisOrderBlocked(project.market)) {
      try {
        const input = { side: 'buy' as const, symbol: project.symbol, quantity: qty, price: buyPrice };
        const r = project.market === 'US' ? await placeOverseasOrder(account, input) : await placeDomesticOrder(account, input);
        await supabase.from('auto_orders').insert({
          user_id: session.user.id,
          project_id: project.id,
          pocket_id: k.id,
          side: 'buy',
          symbol: project.symbol,
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
          const fill = await getOrderFill(account, project.market === 'US' ? 'US' : 'KRX', r.orderNo, project.symbol);
          if (fill && fill.filledQty > 0 && fill.avgPrice > 0) {
            filled = true;
            fillPrice = fill.avgPrice;
            fillQty = fill.filledQty;
          }
        } catch {
          /* 조회 실패 → 미체결(주문완료)로 간주, 지정가 기록 */
        }

        // 매수는 주문 시점에 기록(보유 표시용). 미체결이면 'buy_ordered'.
        await supabase.from('trades').insert({
          user_id: session.user.id,
          project_id: project.id,
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
            sell_target_price: (() => {
              const rs = sellTargetFromFill(fillPrice, Number(project.sell_target_pct));
              return isKrx ? alignToKrxTick(rs, 'sell') : rs;
            })(),
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
      project_id: project.id,
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

  const confirmBuyPocket = (k: Pocket) => {
    confirmAction(
      `포켓 ${k.idx + 1} 매수`,
      `포켓 ${k.idx + 1}을(를) 매수 목표가 ${formatPrice(mkt === 'KRX' ? alignToKrxTick(k.buy_target_price, 'buy') : k.buy_target_price, mkt)} 기준으로 매수 주문할까요?${tier === 'auto' && account ? ' 실제 매수 주문이 전송됩니다.' : ''}`,
      async () => {
        const r = await buyPocket(k);
        await load();
        if (!r.ok) notify('매수 실패', r.msg ?? '처리하지 못했어요.');
      },
      '매수'
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

  // 목록에서 스와이프로 종료 시(?close=1) 상세를 열자마자 종료 흐름(보유 포켓 익절/손절 질문)을 띄운다.
  const closePromptedRef = useRef(false);
  useEffect(() => {
    if (closeParam === '1' && project && !closePromptedRef.current) {
      closePromptedRef.current = true;
      promptClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeParam, project]);

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

      {/* 틀고정: 실시간 시세 카드는 아래 포켓을 스크롤해도 상단에 계속 고정 */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm }}>
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.textDim }}>
                {project.symbol} · {marketLabel}
              </Text>
              <Text style={{ color: num.live, fontSize: 38, fontWeight: '900', marginTop: 2 }}>
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
            <Text style={{ color: num.base, fontWeight: '800' }}>{formatPrice(project.base_price, mkt)}</Text>
          </View>

          {/* 상태 표시 */}
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
      </View>

    <ScrollView
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
    >

      {/* 종료된 프로젝트 표시 (상단 배너) */}
      {project.closed_at && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: colors.cardAlt,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
          }}
        >
          <Text style={{ fontSize: 16 }}>🔒</Text>
          <Text style={{ color: colors.textDim, fontWeight: '800', fontSize: 13, flex: 1 }}>
            종료된 프로젝트 · {project.closed_at.slice(0, 10)} · 아래 ‘재개’ 후 편집 가능
          </Text>
        </View>
      )}


      {/* 종료된 프로젝트: 실시간 추적 스위치·재개만 살리고, 나머지(자동매매 스위치·매수/매도·수정·삭제 등)는 흐리게(선글라스) + 터치 비활성화 */}
      <View style={{ gap: spacing.lg, opacity: project.closed_at ? 0.5 : 1 }} pointerEvents={project.closed_at ? 'none' : 'auto'}>

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
          valueColor={num.position}
        />
        <Row
          label="매입 총액"
          value={formatMoney(pnl.totalQtyOpen * pnl.avgOpenPrice, mkt)}
          valueColor={num.position}
        />
        <Row
          label="평가 총액"
          value={price != null ? formatMoney(pnl.totalQtyOpen * price, mkt) : '-'}
          valueColor={num.evalTotal}
        />
        <Row
          label="평가 손익 (미매도분)"
          value={`${formatMoney(pnl.unrealized, mkt)}${pnl.investedOpen > 0 ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}`}
          valueColor={signColor(pnl.unrealized)}
        />
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
          <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, overflow: 'hidden' }}>
            {/* 탭하면 아래로 펼쳐지며 포켓별 배분 예산을 보여줌 */}
            <Pressable
              onPress={() => setBudgetOpen((o) => !o)}
              style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
            >
              <Text style={{ color: colors.textDim }}>💰 프로젝트 예산 {budgetOpen ? '▲' : '▼'}</Text>
              <Text style={{ color: num.budget, fontWeight: '900', fontSize: 16 }}>{formatMoney(project.total_budget, mkt)}</Text>
            </Pressable>
            {budgetOpen && (
              <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 6 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>포켓별 배분 예산 (비중)</Text>
                {[...pockets]
                  .sort((a, b) => a.idx - b.idx)
                  .map((k) => {
                    const w =
                      project.total_budget && project.total_budget > 0 && k.budget != null
                        ? Math.round((k.budget / project.total_budget) * 1000) / 10
                        : null;
                    return (
                      <View key={k.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ color: colors.text, fontSize: 13 }}>
                          포켓 {k.idx + 1}
                          {w != null ? <Text style={{ color: colors.textDim, fontSize: 11 }}>  ·  {w}%</Text> : null}
                        </Text>
                        <Text style={{ color: num.budget, fontWeight: '800', fontSize: 14 }}>
                          {k.budget != null ? formatMoney(k.budget, mkt) : '-'}
                        </Text>
                      </View>
                    );
                  })}
              </View>
            )}
          </View>
        )}
        {pockets
          // 매수 가능 수량이 0주인 대기 포켓은 숨김 (거래 이력이 있으면 표시)
          .filter(
            (k) =>
              k.status !== 'waiting' ||
              (cyclesByPocket.get(k.id) ?? 0) > 0 ||
              estimatedShares(k.budget, k.buy_target_price) > 0
          )
          .map((k) => {
          // 이 포켓의 현재 순환 순 보유(미매도) 포지션 — 여러 번 매수해도 합산해서 실제 수량/평단 계산
          const pocketOpen = computePnL(trades.filter((t) => t.pocket_id === k.id), null);
          const card = (
            <PocketCard
              pocket={k}
              market={mkt}
              price={price}
              buyIntervalPct={Number(project.buy_interval_pct)}
              sellTargetPct={Number(project.sell_target_pct)}
              buyTrade={buyByPocket.get(k.id) ?? null}
              openQty={Math.floor(pocketOpen.totalQtyOpen)}
              openAvg={pocketOpen.avgOpenPrice}
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
              projectClosed={!!project.closed_at}
              onUpdateTargets={async (buyP, sellP) => {
                await supabase
                  .from('pockets')
                  .update({ buy_target_price: buyP, sell_target_price: sellP })
                  .eq('id', k.id);
                await load();
              }}
              onTrade={(side, sqty, sprice, budget) =>
                router.push(
                  `/project/${project.id}/trade?pocket=${k.id}&idx=${k.idx}&side=${side}&sqty=${sqty}&sprice=${sprice}&budget=${budget ?? ''}&mkt=${mkt}`
                )
              }
            />
          );
          // 현재가 >= 평균매수가면 이익(익절), 아니면 손실(손절)
          const inProfit = price != null && pocketOpen.avgOpenPrice > 0 && price >= pocketOpen.avgOpenPrice;
          // 보유중=왼쪽 스와이프로 익절/손절, 대기중=오른쪽 스와이프로 매수주문 (매수 목표가 기준)
          // 매수 주문완료여도 실제 보유 수량이 있으면 보유중처럼 익절/손절 가능
          const heldForSwipe = k.status === 'bought' || (k.status === 'buy_ordered' && Math.floor(pocketOpen.totalQtyOpen) > 0);
          return heldForSwipe ? (
            <StopLossSwipe key={k.id} profit={inProfit} onStopLoss={() => confirmStopLossPocket(k, inProfit)}>
              {card}
            </StopLossSwipe>
          ) : k.status === 'waiting' ? (
            (() => {
              // AUTO+계좌: 오른쪽 스와이프 → 가격 직접입력 자동주문 모달. 그 외: 목표가 매수주문.
              const isAuto = tier === 'auto' && !!account && !kisOrderBlocked(project.market);
              return (
                <BuyOrderSwipe
                  key={k.id}
                  auto={isAuto}
                  onBuy={() => (isAuto ? setAutoOrderPocket(k) : confirmBuyPocket(k))}
                >
                  {card}
                </BuyOrderSwipe>
              );
            })()
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

      {/* 하단: 포켓 왼쪽 스와이프 안내 문구 */}
      {!project.closed_at && (
        <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: spacing.xs }}>
          💡 포켓을 왼쪽으로 밀면 — 대기중은 <Text style={{ color: colors.buy, fontWeight: '800' }}>매수주문</Text>, 보유중은{' '}
          <Text style={{ color: colors.buy, fontWeight: '800' }}>익절</Text>/<Text style={{ color: colors.sell, fontWeight: '800' }}>손절</Text>{' '}
          할 수 있어요.
        </Text>
      )}

    </ScrollView>
    <BottomTabsBar active="index" />

    {/* AUTO 자동주문 — 매수 가격 직접입력 모달 (왼쪽 스와이프로 열림) */}
    <AutoOrderModal
      pocket={autoOrderPocket}
      market={mkt}
      defaultPrice={
        autoOrderPocket
          ? mkt === 'KRX'
            ? alignToKrxTick(autoOrderPocket.buy_target_price, 'buy')
            : autoOrderPocket.buy_target_price
          : 0
      }
      budget={autoOrderPocket?.budget ?? null}
      onClose={() => setAutoOrderPocket(null)}
      onSubmit={async (customPrice) => {
        const k = autoOrderPocket;
        setAutoOrderPocket(null);
        if (!k) return;
        const r = await buyPocket(k, customPrice);
        await load();
        if (r.ok) notify('자동주문 전송', `포켓 ${k.idx + 1} · ${formatPrice(customPrice, mkt)} 지정가 자동주문을 넣었어요.`);
        else notify('자동주문 실패', r.msg ?? '처리하지 못했어요.');
      }}
    />
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
        Animated.timing(op, { toValue: mode === 'full' ? 0.35 : 0.08, duration: 420, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 420, useNativeDriver: true }),
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
        {/* 더 두껍고 강하게 깜박이는 외곽선 (매수/매도 포인트 도달 강조) */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderWidth: 3.5,
            borderColor: accent,
            borderRadius: radius.lg,
            opacity: op,
          }}
        />
      </View>
    );
  return <>{children}</>;
}

// 텍스트/점 등 작은 요소를 깜박이게 하는 래퍼 (active 일 때만 동작)
function Blink({ active, children }: { active: boolean; children: ReactNode }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      op.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0.15, duration: 420, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 420, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [active, op]);
  return <Animated.View style={{ opacity: op }}>{children}</Animated.View>;
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

// 대기중 포켓 — 보유중 포켓(손절)과 동일하게 왼쪽으로 스와이프하면 '매수주문' 버튼이 나타나고, 끝까지 밀면 실행
//  (AUTO 등급은 가격 직접입력 모달, 다이어리는 목표가 매수 — onBuy 안에서 분기)
function BuyOrderSwipe({ onBuy, auto, children }: { onBuy: () => void; auto?: boolean; children: ReactNode }) {
  const ref = useRef<Swipeable>(null);
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={() => (
        <View style={{ width: 84, paddingLeft: spacing.sm }}>
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
        if (dir === 'right') {
          ref.current?.close();
          onBuy();
        }
      }}
    >
      {children}
    </Swipeable>
  );
}

// AUTO 등급 자동주문 — 매수 가격을 직접 입력해 지정가 주문을 넣는 모달
function AutoOrderModal({
  pocket,
  market,
  defaultPrice,
  budget,
  onClose,
  onSubmit,
}: {
  pocket: Pocket | null;
  market: string;
  defaultPrice: number;
  budget: number | null;
  onClose: () => void;
  onSubmit: (price: number) => void;
}) {
  const [raw, setRaw] = useState('');
  useEffect(() => {
    if (pocket) setRaw(String(Math.round(defaultPrice)));
  }, [pocket, defaultPrice]);
  if (!pocket) return null;
  const price = Number(rawNumeric(raw)) || 0;
  const aligned = market === 'KRX' ? alignToKrxTick(price, 'buy') : price;
  const qty = estimatedShares(budget, aligned);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg }}>
        <Pressable
          onPress={() => {}}
          style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.primary }}
        >
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>🤖 포켓 {pocket.idx + 1} 자동주문</Text>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>매수 가격을 직접 입력해 지정가 자동주문을 넣습니다.</Text>
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
  openQty,
  openAvg,
  cycles,
  history,
  realizedByTrade,
  autoMode,
  autoTradeOn,
  buyFailMsg,
  sellFailMsg,
  onRestart,
  projectClosed,
  onUpdateTargets,
  onTrade,
}: {
  pocket: Pocket;
  market: string;
  price: number | null;
  buyIntervalPct: number; // 매수 간격 % (포켓별 -할인율 표시용)
  sellTargetPct: number; // 매도 목표 % (매도가 +표시용)
  buyTrade: Trade | null;
  openQty: number; // 이 포켓 현재 순환의 순 보유 수량 (여러 매수 합산)
  openAvg: number; // 순 보유분 평균 매수가
  cycles: number;
  history: Trade[]; // 이 포켓의 전체 체결(모든 순환) — 최신 먼저
  realizedByTrade: Map<string, number>; // 매도 체결 id → 실현손익
  autoMode: boolean; // AUTO 등급 → 자동체결 안내 + 수동 입력 버튼을 작게
  autoTradeOn: boolean; // 이 프로젝트의 자동매매 스위치 상태 (안내 문구용)
  buyFailMsg: string | null; // 자동 매수 실패 사유 (있으면 깜박이며 표시)
  sellFailMsg: string | null; // 자동 매도 실패 사유
  onRestart: () => void;
  projectClosed: boolean; // 프로젝트 종료 시 재시작 버튼 숨김
  onUpdateTargets: (buyPrice: number, sellPrice: number | null) => Promise<void>; // 목표 매수·매도가 직접 수정
  onTrade: (side: 'buy' | 'sell', sqty: number, sprice: number, budget?: number) => void;
}) {
  // 종료된 프로젝트는 본문이 터치 비활성(pointerEvents=none)이라 토글을 못 누름
  // → 종료 시에는 체결 내역을 기본 펼침으로 두어 바로 볼 수 있게 한다.
  const [showLog, setShowLog] = useState(projectClosed);
  const [editOpen, setEditOpen] = useState(false); // 목표 매수·매도가 수정 모달
  // 이 포켓에서 실현된 손익 합계 (모든 순환)
  const pocketRealized = history.reduce((s, t) => s + (t.side === 'sell' ? realizedByTrade.get(t.id) ?? 0 : 0), 0);
  // 포켓별 기준가 대비 할인율 (포켓1=0%=기준가, 포켓2=-5%, …)
  const buyDiscPct = Math.round(k.idx * buyIntervalPct * 100) / 100;
  // KRX 는 목표가를 호가단위(매수 내림·매도 올림)에 맞춰 표시·계산 (그래야 주문가와 일치)
  const isKrx = market === 'KRX';
  const buyTargetDisp = isKrx ? alignToKrxTick(k.buy_target_price, 'buy') : k.buy_target_price;
  const sellTargetDisp =
    k.sell_target_price != null ? (isKrx ? alignToKrxTick(k.sell_target_price, 'sell') : k.sell_target_price) : null;
  const buyReady = k.status === 'waiting' && price != null && price <= buyTargetDisp;
  const sellReady =
    k.status === 'bought' && sellTargetDisp != null && price != null && price >= sellTargetDisp;

  // 매수가능 수량: 배분액 / 매수목표가(호가단위 정렬).
  //  실제 자동/수동 주문이 매수목표가(지정가) 기준으로 수량을 잡으므로 동일하게 목표가로 계산해야
  //  현재가가 목표가보다 높을 때 수량이 과소 표시되지 않는다.
  const buyableQty = estimatedShares(k.budget, buyTargetDisp);

  // 매수 주문완료여도 실제 보유(체결 기록)가 있으면 '보유중'으로 취급 —
  // 해외 지연체결 등으로 pocket.status 갱신이 늦어도 다른 화면(리스트·포켓탭)과 일관되게 표시.
  const effectivelyBought = k.status === 'bought' || (k.status === 'buy_ordered' && openQty > 0);

  const statusPill = effectivelyBought
    ? { text: '보유중', color: colors.buy }
    : k.status === 'buy_ordered'
      ? { text: '매수 주문완료', color: colors.warn }
      : k.status === 'sell_ordered'
        ? { text: '매도 주문완료', color: colors.warn }
        : k.status === 'sold'
          ? { text: '매도 완료', color: colors.sell }
          : { text: '대기중', color: colors.textDim };

  // 주문완료(체결 대기) 안내 단어 — 매수는 실제 보유가 없을 때만 '체결 대기'로 표시
  const pendingWord =
    k.status === 'buy_ordered' && !effectivelyBought ? '매수' : k.status === 'sell_ordered' ? '매도' : null;
  // 보유 정보/매도목표를 보여줄 상태 (보유중 + 매도주문완료 + 매수주문완료)
  const heldLike = k.status === 'bought' || k.status === 'buy_ordered' || k.status === 'sell_ordered';

  // 음영(가득 참) 배경 + 포켓 번호별 고유 색 띠
  const cardStyle = {
    ...(effectivelyBought
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
          {effectivelyBought && <Text style={{ fontSize: 14 }}>🔴</Text>}
          {pendingWord && <Text style={{ fontSize: 14 }}>🕐</Text>}
          <Text style={{ color: statusPill.color, fontWeight: '800', fontSize: 12 }}>{statusPill.text}</Text>
        </View>
      </View>

      {/* 목표 매수·매도가 직접 수정 (시장 상황 보며 조정) — 대기중/보유중일 때 */}
      {!projectClosed && k.status !== 'sold' && (
        <Pressable onPress={() => setEditOpen(true)} style={{ alignSelf: 'flex-end', marginTop: 2 }} hitSlop={6}>
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>🎯 목표가 수정</Text>
        </Pressable>
      )}
      <EditTargetsModal
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        pocket={k}
        market={market}
        price={price}
        avgBuy={heldLike && openQty > 0 ? openAvg : 0}
        onSave={async (b, s) => {
          await onUpdateTargets(b, s);
          setEditOpen(false);
        }}
      />

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
              {formatPrice(buyTargetDisp, market)}
            </Text>
          </View>
          {k.budget != null && (
            <Row label={`배분 예산 (비중 ${k.weight}%)`} value={formatPrice(k.budget, market)} valueColor={num.budget} />
          )}
          {k.budget != null && (
            <Row label="매수 가능 수량" value={`${money(buyableQty, 0)}주`} valueColor={num.position} />
          )}
          {(buyReady || buyFailMsg) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
              <Blink active={buyReady}>
                <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 15 }}>● 매수포인트 도달</Text>
              </Blink>
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
              <ManualEntryButton onPress={() => onTrade('buy', buyableQty, price ?? buyTargetDisp)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매수 체결 입력"
                variant="buy"
                large
                onPress={() => onTrade('buy', buyableQty, price ?? buyTargetDisp)}
              />
            </View>
          )}
        </>
      )}

      {heldLike && (
        <>
          {/* 보유 정보 그리드 (보유수량·평균매수가 / 매입총액·평가총액 / 평가손익) */}
          {(() => {
              // 여러 번 매수한 경우 합산한 순 보유 수량/평단 사용. (매도주문완료 등 순보유 0이면 마지막 매수로 폴백)
              const qty = openQty > 0 ? openQty : buyTrade?.quantity ?? 0;
              const avg = openQty > 0 ? openAvg : buyTrade?.price ?? 0;
              const buyTotal = avg * qty; // 매입 총액 = 평균 매수가 × 보유 수량
              const evalTotal = price != null ? price * qty : null; // 평가 총액 = 현재가 × 보유 수량
              const evalPnl = price != null ? (price - avg) * qty : null; // 평가손익 = 평가총액 - 매입총액
              const evalRate = price != null && avg > 0 ? Math.round(((price - avg) / avg) * 1000) / 10 : null; // 손익률(%)
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
                  {/* 상단: 좌측 보유수량·평균매수가(작게) / 우측 매입 총액(크게) */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ gap: 3 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        <Text style={{ color: colors.textDim, fontSize: 11 }}>보유 수량</Text>
                        <Text style={{ color: num.position, fontSize: 13, fontWeight: '800' }}>{money(qty, 0)}주</Text>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        <Text style={{ color: colors.textDim, fontSize: 11 }}>평균 매수가</Text>
                        <Text style={{ color: num.position, fontSize: 13, fontWeight: '800' }}>{formatPrice(avg, market)}</Text>
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: colors.textDim, fontSize: 11 }}>매입 총액</Text>
                      <Text style={{ color: num.position, fontSize: 16, fontWeight: '900' }}>{formatMoney(buyTotal, market)}</Text>
                    </View>
                  </View>
                  {/* 평가 총액 */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 6 }}>
                    <Text style={{ color: colors.textDim, fontSize: 12 }}>평가 총액</Text>
                    <Text style={{ color: num.evalTotal, fontSize: 16, fontWeight: '900' }}>
                      {evalTotal != null ? formatMoney(evalTotal, market) : '-'}
                    </Text>
                  </View>
                  {/* 평가손익 */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.textDim, fontSize: 12 }}>평가손익</Text>
                    <Text style={{ color: evalPnl != null ? signColor(evalPnl) : colors.textDim, fontSize: 16, fontWeight: '900' }}>
                      {evalPnl != null
                        ? `${evalPnl > 0 ? '+' : ''}${formatMoney(evalPnl, market)}${evalRate != null ? ` (${evalRate > 0 ? '+' : ''}${evalRate}%)` : ''}`
                        : '-'}
                    </Text>
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
              {sellTargetDisp != null ? formatPrice(sellTargetDisp, market) : '-'}
            </Text>
          </View>
          {(sellReady || sellFailMsg) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
              <Blink active={sellReady}>
                <Text style={{ color: colors.sell, fontWeight: '900', fontSize: 15 }}>● 매도포인트 도달</Text>
              </Blink>
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
              <ManualEntryButton onPress={() => onTrade('sell', openQty > 0 ? openQty : buyTrade?.quantity ?? 0, price ?? sellTargetDisp ?? 0)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매도 체결 입력"
                variant="sell"
                large
                onPress={() => onTrade('sell', openQty > 0 ? openQty : buyTrade?.quantity ?? 0, price ?? sellTargetDisp ?? 0)}
              />
            </View>
          )}
        </>
      )}

      {k.status === 'sold' &&
        (projectClosed ? (
          // 종료된 프로젝트에서는 재시작 없이 완료 안내만
          <Text style={{ color: colors.textDim, fontSize: 12, marginTop: spacing.xs }}>
            이 포켓은 매도까지 완료됐어요. (종료된 프로젝트)
          </Text>
        ) : (
          <View style={{ marginTop: spacing.xs, gap: spacing.sm }}>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              이 포켓은 매도까지 완료됐어요. 다시 시작하면 새 매수 대기 상태가 되고, 이전 기록은 그대로 남습니다.
            </Text>
            <Button title="🔄 포켓 재시작 (다시 매수 대기)" variant="buy" large onPress={onRestart} />
          </View>
        ))}

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
