import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { chooseAction, confirmAction, notify } from '@/lib/alert';
import { Card, Chip, Field, FilterBar } from '@/components/ui';
import { EditTargetsModal } from '@/components/EditTargetsModal';
import { PortfolioSummary, computeMarketSummaries } from '@/components/PortfolioSummary';
import { colors, formatChangePct, formatMoney, formatPrice, money, num, pocketColor, radius, rawNumeric, signColor, spacing, withCommas } from '@/theme';
import { alignToKrxTick, computePnL, estimatedShares, sellTargetFromFill, stopPriceOf } from '@/domain/pockets';
import { getUnifiedQuote } from '@/services/prices/unified';
import { getStoredQuotes } from '@/services/prices/quoteStore';
import { getOrderFill, isNxtTradable, kisOrderBlocked, placeDomesticOrder, placeOverseasOrder } from '@/services/broker/kis';
import { orderWindow } from '@/services/marketHours';
import { savePocketTargets, STOP_PRICE_MIGRATION_HINT } from '@/services/pocketTargets';
import { useAccountCash } from '@/services/deposits';
import { cancelPendingOrder, demoteEmptyBoughtPockets, findHoldingMismatches, healBoughtPockets, loadPendingOrders, reconcilePendingOrders, releasePendingOrderLocally, type HoldingMismatch } from '@/services/pendingOrders';
import type { AutoOrder, BrokerAccount, Pocket, Project, Trade } from '@/types/db';

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
  const [editPocket, setEditPocket] = useState<Pocket | null>(null); // 목표가 수정 대상 포켓
  const [q, setQ] = useState(''); // 종목명/티커 검색
  const [market, setMarket] = useState<'KRX' | 'US' | null>(null); // null = 전체 시장
  const [expanded, setExpanded] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, { price: number; changePct: number | null }>>({}); // symbol → 실시간가·등락률
  // 왼쪽 스와이프 자동주문(AUTO). pending 이 있으면 '주문가 변경'(취소 후 재주문) 모드.
  const [autoOrder, setAutoOrder] = useState<{ pocket: Pocket; proj: Project; pending?: AutoOrder } | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Record<string, AutoOrder>>({}); // pocket_id → 미체결 주문
  const [mismatches, setMismatches] = useState<HoldingMismatch[]>([]); // 앱 기록 ↔ 계좌 잔고 불일치

  const load = useCallback(async () => {
    const [{ data: p }, { data: k }, { data: t }, po] = await Promise.all([
      supabase.from('projects').select('*'),
      supabase.from('pockets').select('*').order('idx'),
      supabase.from('trades').select('*').order('executed_at'),
      loadPendingOrders(),
    ]);
    if (p) setProjects(p as Project[]);
    if (k) setPockets(k as Pocket[]);
    if (t) setTrades(t as Trade[]);
    setPendingOrders(po);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 프로젝트별 실시간 시세 — 앱 공통 통합 시세(KIS 우선, 전역 캐시 공유).
  // 진입 시 다른 화면이 받아둔 마지막 가격을 즉시 표시해 화면 간 가격 불일치를 없앤다.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const uniq = Array.from(new Map(projects.filter((p) => p.symbol).map((p) => [p.symbol, p])).values());
      // 1) 전역 캐시 프리필 (즉시, 네트워크 없이)
      const cached = getStoredQuotes(uniq.map((p) => p.symbol));
      if (Object.keys(cached).length > 0) {
        setPrices((m) => {
          const next = { ...m };
          for (const [sym, q] of Object.entries(cached)) next[sym] = { price: q.price, changePct: q.changePct };
          return next;
        });
      }
      // 2) 최신 시세로 갱신
      uniq.forEach(async (p) => {
        try {
          const q = await getUnifiedQuote(account ?? null, p.symbol, p.market);
          if (alive) setPrices((m) => ({ ...m, [p.symbol]: { price: q.price, changePct: q.changePct } }));
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

  // 미체결 자동주문 체결 감지 — 포켓탭을 보고 있는 동안 짧은 주기로 확인해
  // '매수 주문완료 → 보유중', '매도 주문완료 → 매도완료' 전환이 늦지 않게 한다.
  const hasPending = Object.keys(pendingOrders).length > 0;
  useEffect(() => {
    if (!account) return;
    let alive = true;
    const tick = async () => {
      try {
        if (await reconcilePendingOrders(account)) {
          if (alive) await load();
        }
      } catch {
        /* 조회 실패는 무시 — 다음 주기에 다시 시도 */
      }
    };
    void tick();
    const timer = hasPending ? setInterval(tick, 15000) : null; // 미체결이 있을 때만 15초마다
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, hasPending]);

  // 앱 기록 ↔ 증권사 잔고 대조 — 어긋나면 화면 위에 경고를 띄운다 (중복 기록·앱 밖 매매 감지)
  useEffect(() => {
    if (!account || loading) return;
    let alive = true;
    findHoldingMismatches(account)
      .then((m) => alive && setMismatches(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [account, loading, trades]);

  // 전체 요약 (한국/미국 열) — 프로젝트탭과 같은 표
  const cash = useAccountCash(account); // 총자산·사용가능 예산 (증권사 계좌 실제 금액)
  const summaries = useMemo(
    () =>
      computeMarketSummaries(projects, pockets, trades, (sym) => prices[sym]?.price ?? null).map((s) => ({
        ...s,
        deposit: cash[s.market]?.deposit ?? null,
        totalAsset: cash[s.market]?.totalAsset ?? null,
      })),
    [projects, pockets, trades, prices, cash]
  );

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

  // 상태 불일치 자동 정리 —
  //  ① '매수 주문완료'인데 실제 체결 기록이 있는 포켓 → '보유중'으로 승격
  //  ② '보유중'인데 매수 기록이 하나도 없는 포켓(잘못된 기록을 지운 뒤 등) → '대기중'으로 강등
  //     (미체결 주문이 걸려 있으면 건드리지 않는다)
  const healedRef = useRef(false);
  useEffect(() => {
    if (loading || healedRef.current) return;
    const stale = pockets
      .filter((k) => k.status === 'buy_ordered' && Math.floor(computePnL(tradesByPocket[k.id] ?? [], null).totalQtyOpen) > 0)
      .map((k) => k.id);
    const empty = pockets
      .filter(
        (k) =>
          k.status === 'bought' &&
          !pendingOrders[k.id] &&
          Math.floor(computePnL(tradesByPocket[k.id] ?? [], null).totalQtyOpen) <= 0
      )
      .map((k) => k.id);
    if (stale.length === 0 && empty.length === 0) return;
    healedRef.current = true;
    void Promise.all([healBoughtPockets(stale), demoteEmptyBoughtPockets(empty)]).then(([a, b]) => {
      if (a + b > 0) load();
    });
  }, [loading, pockets, tradesByPocket, pendingOrders, load]);

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

  // 매수 대기 예수금 (진행중 프로젝트에서 아직 보유하지 않고 '대기중'인 포켓의 배분 예산 합, 시장별)
  const waitingBudgetByMarket = useMemo(() => {
    const m: Record<string, number> = {};
    pockets.forEach((k) => {
      const proj = projMap[k.project_id];
      if (!proj || proj.closed_at) return;
      if (k.status !== 'waiting' || k.budget == null) return;
      m[proj.market] = (m[proj.market] ?? 0) + Number(k.budget);
    });
    return m;
  }, [pockets, projMap]);

  // 필터: 보유중 = 매수 상태, 실현 = 매도 체결이 1건 이상 있는 포켓
  //        포켓 번호 선택 시 해당 idx 의 포켓만 (null = 전체)
  const filtered = useMemo(() => {
    return pockets.filter((k) => {
      const proj = projMap[k.project_id];
      if (!proj) return false;
      if (proj.closed_at) return false; // 종료된 프로젝트의 포켓은 포켓탭에서 숨김(상세에서만 확인)
      // 배분 예산이 아예 없는 대기 포켓만 숨긴다 (거래 이력이 있으면 표시).
      // 예산은 있는데 목표가가 높아 0주가 된 포켓은 경고와 함께 보여준다 —
      // 숨기면 사라진 것처럼 보이는데 정작 목표가를 고칠 방법이 없어진다.
      {
        const kt0 = tradesByPocket[k.id] ?? [];
        if (k.status === 'waiting' && kt0.length === 0 && Number(k.budget ?? 0) <= 0) return false;
      }
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
      // 보유중 판정: status 필드가 아니라 실제 미매도 수량 기준(체결 감지 지연 방어)
      const holding = Math.floor(computePnL(kt, null).totalQtyOpen) > 0;
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
    // 익절/손절은 '지금 정리한다'는 뜻이므로 반드시 현재가로 주문한다.
    // 매도 목표가로 넣으면 현재가보다 훨씬 높아 영영 체결되지 않는다.
    let live: number | null = prices[proj.symbol]?.price ?? null;
    if (live == null || live <= 0) {
      try {
        live = (await getUnifiedQuote(account ?? null, proj.symbol, proj.market)).price;
      } catch {
        live = null;
      }
    }
    if (live == null || live <= 0) {
      return { ok: false, msg: '현재가를 확인할 수 없어 매도 주문을 넣지 않았어요' };
    }
    const sellPrice = proj.market === 'KRX' ? alignToKrxTick(live, 'sell') : live;
    if (sellPrice <= 0) return { ok: false, msg: '현재가를 확인할 수 없어요' };

    if (tier === 'auto' && account && !kisOrderBlocked(proj.market)) {
      const nxtTradable = proj.market === 'US' ? false : await isNxtTradable(account, proj.symbol);
      const win = orderWindow(proj.market, { nxtTradable, isVirtual: account.is_virtual });
      if (!win.canOrder) return { ok: false, msg: win.reason };
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

  // 미체결 매도 주문 취소 → 포켓을 '보유중'으로 되돌린다.
  // (엉뚱한 가격에 걸려 영영 체결되지 않는 주문을 풀고 현재가로 다시 익절/손절하기 위함)
  const cancelSellOrder = (k: Pocket, proj: Project, po: AutoOrder) => {
    confirmAction(
      '매도 주문 취소',
      `포켓 ${k.idx + 1}의 미체결 매도 주문(${formatPrice(Number(po.order_price), proj.market)} · ${money(
        Math.floor(Number(po.quantity)),
        0
      )}주)을 취소할까요?\n취소하면 다시 ‘보유중’으로 돌아가요.`,
      async () => {
        try {
          await cancelPendingOrder(po, proj.market, account);
        } catch (e: any) {
          await load();
          // 증권사 취소가 실패해도 사용자가 증권사 앱에서 직접 취소할 수 있다 → 기록만 정리하는 길
          return chooseAction(
            '주문 취소 실패',
            `${e?.message ?? '취소하지 못했어요.'}\n\n증권사 앱에서 직접 취소하셨다면 앱 기록만 정리할 수 있어요.\n(주문이 아직 살아 있는데 정리하면 이중 매도가 될 수 있으니 증권사 앱에서 먼저 확인해 주세요)`,
            [
              {
                text: '증권사에서 이미 취소했어요',
                style: 'destructive',
                onPress: async () => {
                  await releasePendingOrderLocally(po);
                  await load();
                  notify('기록 정리 완료', `포켓 ${k.idx + 1}이(가) 보유중으로 돌아갔어요.`);
                },
              },
              { text: '닫기', style: 'cancel' },
            ]
          );
        }
        await load();
        notify('매도 주문 취소됨', `포켓 ${k.idx + 1}이(가) 보유중으로 돌아갔어요.`);
      },
      '주문 취소'
    );
  };

  // 대기중 포켓 매수 주문 — 매수 목표가(또는 직접 입력가) 기준. 손절과 대칭.
  // 현재가가 목표가보다 낮으면 현재가로 주문해 더 싸게 체결.
  const buyPocket = async (k: Pocket, proj: Project, customPrice?: number): Promise<{ ok: boolean; msg?: string }> => {
    if (!session?.user?.id) return { ok: false };
    const isKrx = proj.market === 'KRX';
    const nowPrice = prices[proj.symbol]?.price;
    const rawBuy =
      customPrice && customPrice > 0
        ? customPrice
        : nowPrice != null && nowPrice > 0
          ? Math.min(k.buy_target_price, nowPrice)
          : k.buy_target_price;
    const buyPrice = isKrx ? alignToKrxTick(rawBuy, 'buy') : rawBuy;
    if (!buyPrice || buyPrice <= 0) return { ok: false, msg: '매수 가격이 없어요' };
    const qty = estimatedShares(k.budget, buyPrice);
    if (qty <= 0) return { ok: false, msg: '배분 예산으로 살 수 있는 수량이 없어요' };
    const rawSell = sellTargetFromFill(buyPrice, Number(proj.sell_target_pct));
    const sellTgt = isKrx ? alignToKrxTick(rawSell, 'sell') : rawSell;

    if (tier === 'auto' && account && !kisOrderBlocked(proj.market)) {
      // 거래 시간이 아니면 주문을 보내지 않는다 (증권사가 거부할 뿐이라 이유를 먼저 알려준다)
      const nxtTradable = proj.market === 'US' ? false : await isNxtTradable(account, proj.symbol);
      const win = orderWindow(proj.market, { nxtTradable, isVirtual: account.is_virtual });
      if (!win.canOrder) return { ok: false, msg: win.reason };
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
        // 체결이 확인된 경우에만 기록 (미체결은 '매수 주문완료' 상태로만 둠)
        if (filled) {
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
        }
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

  // 대기중 포켓 삭제 — 시장 상황이 바뀌어 의미 없어진 포켓을 정리한다.
  // 보유중/체결 이력이 있는 포켓은 손익 계산이 꼬이므로 삭제 불가.
  // 삭제하면 그 포켓의 배분 예산만큼 '사용가능 예산'이 다시 살아난다.
  const confirmDeletePocket = (k: Pocket, proj: Project) => {
    const kt = tradesByPocket[k.id] ?? [];
    if (Math.floor(computePnL(kt, null).totalQtyOpen) > 0 || kt.length > 0) {
      return notify('삭제할 수 없어요', '이미 매수(체결) 이력이 있는 포켓은 삭제할 수 없어요. 매도 후 정리해 주세요.');
    }
    const freed = k.budget != null ? formatPrice(Number(k.budget), proj.market) : null;
    confirmAction(
      `포켓 ${k.idx + 1} 삭제`,
      `${proj.name} 포켓 ${k.idx + 1}(대기중)을 삭제할까요?${freed ? `\n배분 예산 ${freed}이 프로젝트 예산에서 빠지고, 사용가능 예산으로 돌아가요.` : ''}`,
      async () => {
        const { error } = await supabase.from('pockets').delete().eq('id', k.id);
        if (error) return notify('삭제 실패', error.message);
        // 프로젝트 총 예산에서도 그 포켓의 배분액만큼 차감 (예산 합계가 어긋나지 않게)
        const freedAmt = Number(k.budget ?? 0);
        if (freedAmt > 0 && proj.total_budget != null) {
          const nextTotal = Math.max(0, Number(proj.total_budget) - freedAmt);
          await supabase.from('projects').update({ total_budget: nextTotal }).eq('id', proj.id);
        }
        await load();
      },
      '삭제'
    );
  };

  const confirmBuyPocket = (k: Pocket, proj: Project) => {
    // 현재가가 목표가보다 낮으면 현재가 기준으로 안내·주문
    const nowPrice = prices[proj.symbol]?.price;
    const eff = nowPrice != null && nowPrice > 0 ? Math.min(k.buy_target_price, nowPrice) : k.buy_target_price;
    const disp = proj.market === 'KRX' ? alignToKrxTick(eff, 'buy') : eff;
    confirmAction(
      `포켓 ${k.idx + 1} 매수`,
      `${proj.name} 포켓 ${k.idx + 1}을(를) ${formatPrice(disp, proj.market)}(현재가·목표가 중 낮은 가격) 기준으로 매수 주문할까요?${tier === 'auto' && account ? ' 실제 매수 주문이 전송됩니다.' : ''}`,
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
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm }}>
      {/* 🧺 포켓 번호 선택 + 검색 아이콘 — 한 줄에 모아 높이를 줄인다.
          라벨 줄을 없애고 돋보기를 같은 줄 왼쪽으로 올렸다(누르면 아래에 검색창). */}
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.buy,
          padding: 6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Pressable
          onPress={() => setShowSearch((v) => !v)}
          hitSlop={4}
          style={{
            width: 30,
            height: 30,
            borderRadius: radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: showSearch ? colors.buy : colors.cardAlt,
          }}
        >
          <Text style={{ fontSize: 13 }}>🔍</Text>
        </Pressable>
        <View style={{ width: 1, height: 18, backgroundColor: colors.border, marginHorizontal: 2 }} />
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
                flexBasis: 26,
                minWidth: 26,
                alignItems: 'center',
                paddingVertical: 7,
                borderRadius: radius.sm,
                backgroundColor: on ? c : colors.cardAlt,
                borderBottomWidth: 2,
                borderBottomColor: i == null || isPlus ? (on ? colors.buy : 'transparent') : pocketColor(i as number),
              }}
            >
              <Text style={{ color: on ? '#FFFFFF' : colors.textDim, fontWeight: '900', fontSize: 12 }}>
                {i == null ? '전체' : isPlus ? '6+' : (i as number) + 1}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 시장/상태 필터 (아이콘 칩) — 돋보기는 위 줄로 옮겨졌다 */}
      <FilterBar style={{ flexDirection: 'row', alignItems: 'center' }}>
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
      <PortfolioSummary summaries={summaries} />

      {/* 앱 기록 ↔ 증권사 계좌 대조 결과 — 어긋나면 바로 알 수 있게 경고 */}
      {mismatches.length > 0 && (
        <Card style={{ borderColor: colors.warn, backgroundColor: 'rgba(251,191,36,0.08)' }}>
          <Text style={{ color: colors.warn, fontWeight: '900', fontSize: 14 }}>⚠️ 보유수량이 계좌와 달라요</Text>
          <Text style={{ color: colors.textDim, fontSize: 11, marginBottom: 4 }}>
            앱 기록이 많으면 체결이 중복 기록된 것이고, 계좌가 많으면 앱 밖에서 매매한 거예요. 매매일지에서 바로잡을 수 있어요.
          </Text>
          {mismatches.map((m) => (
            <View key={m.symbol} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                {m.name}
              </Text>
              <Text style={{ fontSize: 13, fontWeight: '800' }}>
                <Text style={{ color: m.recordedQty > m.heldQty ? colors.buy : colors.sell }}>앱 {money(m.recordedQty, 0)}주</Text>
                <Text style={{ color: colors.textDim }}> · 계좌 {money(m.heldQty, 0)}주</Text>
              </Text>
            </View>
          ))}
        </Card>
      )}

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
        const stopRaw = stopPriceOf(k);
        const stopDisp = stopRaw != null ? (isKrx ? alignToKrxTick(stopRaw, 'sell') : stopRaw) : null;
        const open = expanded === k.id;
        // 상태 판정: 주문완료(미체결) 상태는 그대로 존중하고,
        // 그 외에는 실제 보유수량으로 보정한다(체결 감지 지연 방어).
        //  · buy_ordered  : 매수 주문만 넣고 아직 미체결 → '매수 주문완료'
        //  · sell_ordered : 매도 주문만 넣고 아직 미체결 → '매도 주문완료'
        //  (체결이 확인되면 체결 기록이 생기면서 bought/sold 로 바뀐다)
        //  · 매수 주문완료라도 실제 체결(보유수량)이 있으면 '보유중' — 프로젝트 상세와 같은 규칙
        //  · 매도 주문완료는 보유 중에 주문을 낸 상태라 보유수량이 있어도 '매도 주문완료' 유지
        const held = Math.floor(pnl.totalQtyOpen) > 0;
        const effStatus =
          k.status === 'sell_ordered'
            ? 'sell_ordered'
            : k.status === 'buy_ordered'
              ? held
                ? 'bought'
                : 'buy_ordered'
              : held
                ? 'bought'
                : k.status;
        const statusMeta =
          effStatus === 'bought'
            ? { text: '보유중', color: colors.buy, bg: colors.buyBg }
            : effStatus === 'buy_ordered' || effStatus === 'sell_ordered'
              ? { text: effStatus === 'buy_ordered' ? '매수 주문완료' : '매도 주문완료', color: colors.warn, bg: 'rgba(251,191,36,0.14)' }
              : effStatus === 'sold'
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
                <View style={{ flex: 1, marginRight: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ color: colors.text, fontWeight: '800', flexShrink: 1 }} numberOfLines={1}>
                      {proj.name}
                    </Text>
                    <Text style={{ color: pocketColor(k.idx), fontWeight: '900' }} numberOfLines={1}>
                      {' · 포켓 ' + (k.idx + 1)}
                    </Text>
                  </View>
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
                    {formatChangePct(changePct)}%
                  </Text>
                )}
              </View>

              {/* 목표 정보 — 현재가 아래. 대기: 매수목표+목표수량 / 보유: 매도목표만(매수가는 아래 박스 평균매수가로 표시) */}
              {effStatus === 'waiting' && (
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
              {effStatus === 'bought' && sellTargetDisp != null && (
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
              {/* 마지노선(손절) — 프로젝트 상세와 같이 선으로 가로질러 하한선처럼 보이게 */}
              {effStatus === 'bought' && stopDisp != null && (() => {
                const p =
                  pnl.avgOpenPrice > 0
                    ? Math.round(((stopDisp - pnl.avgOpenPrice) / pnl.avgOpenPrice) * 10000) / 100
                    : null;
                return (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: colors.warn, opacity: 0.5 }} />
                    <Text numberOfLines={1} style={{ color: colors.warn, fontWeight: '800', fontSize: 11 }}>
                      🛑 마지노선 {formatPrice(stopDisp, proj.market)}
                      {p != null ? ` (${p > 0 ? '+' : ''}${p}%)` : ''}
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: colors.warn, opacity: 0.5 }} />
                  </View>
                );
              })()}

              {/* 목표 매수·매도가 직접 수정 (시장 상황 보며 조정) */}
              {k.status !== 'sold' && (
                <Pressable onPress={() => setEditPocket(k)} style={{ alignSelf: 'flex-end' }} hitSlop={6}>
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>🎯 목표가 수정</Text>
                </Pressable>
              )}

              {/* 주문완료(미체결) 박스 — 체결 기록이 없어 보유 정보가 비는 구간을 주문 내역으로 채운다.
                  주문가·수량·주문금액·주문시각을 보여주고, 매수는 가격을 바꿔 재주문할 수 있다. */}
              {(effStatus === 'buy_ordered' || effStatus === 'sell_ordered') &&
                (() => {
                  const po = pendingOrders[k.id];
                  const ordPrice = po ? Number(po.order_price) : null;
                  const ordQty = po ? Math.floor(Number(po.quantity)) : null;
                  const isBuy = effStatus === 'buy_ordered';
                  return (
                    <View
                      style={{
                        backgroundColor: 'rgba(251,191,36,0.10)',
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: colors.warn,
                        paddingVertical: spacing.sm,
                        paddingHorizontal: spacing.md,
                        gap: 8,
                      }}
                    >
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ gap: 3 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: colors.textDim, fontSize: 11 }}>{isBuy ? '매수' : '매도'} 주문가</Text>
                            <Text style={{ color: isBuy ? colors.buy : colors.sell, fontSize: 15, fontWeight: '900' }}>
                              {ordPrice != null ? formatPrice(ordPrice, proj.market) : '—'}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                            <Text style={{ color: colors.textDim, fontSize: 11 }}>주문 수량</Text>
                            <Text style={{ color: num.position, fontSize: 13, fontWeight: '800' }}>
                              {ordQty != null ? `${money(ordQty, 0)}주` : '—'}
                            </Text>
                          </View>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: colors.textDim, fontSize: 11 }}>주문 금액</Text>
                          <Text style={{ color: num.position, fontSize: 16, fontWeight: '900' }}>
                            {ordPrice != null && ordQty != null ? formatMoney(ordPrice * ordQty, proj.market) : '—'}
                          </Text>
                        </View>
                      </View>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderTopWidth: 1,
                          borderTopColor: 'rgba(255,255,255,0.08)',
                          paddingTop: 6,
                          gap: spacing.sm,
                        }}
                      >
                        <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '800', flexShrink: 1 }}>
                          🕐 체결 대기중
                          {po?.created_at ? ` · ${po.created_at.slice(5, 16).replace('T', ' ')}` : ''}
                        </Text>
                        {isBuy && po && (
                          <Pressable onPress={() => setAutoOrder({ pocket: k, proj, pending: po })} hitSlop={6}>
                            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>✏️ 주문가 변경</Text>
                          </Pressable>
                        )}
                        {/* 매도 미체결 — 취소하면 '보유중'으로 돌아가 현재가로 다시 익절/손절할 수 있다 */}
                        {!isBuy && po && (
                          <Pressable onPress={() => cancelSellOrder(k, proj, po)} hitSlop={6}>
                            <Text style={{ color: colors.sell, fontSize: 12, fontWeight: '800' }}>🚫 매도 주문 취소</Text>
                          </Pressable>
                        )}
                      </View>
                      {/* 체결 감지 실패 대비 수동 입력 — 증권사에선 체결됐는데 앱이 못 잡을 때 직접 반영 */}
                      <Pressable
                        onPress={() =>
                          router.push(
                            `/project/${proj.id}/trade?pocket=${k.id}&idx=${k.idx}&side=${isBuy ? 'buy' : 'sell'}` +
                              `&sqty=${ordQty ?? estimatedShares(k.budget, buyTargetDisp)}` +
                              `&sprice=${ordPrice ?? price ?? buyTargetDisp}&budget=${k.budget ?? ''}&mkt=${proj.market}`
                          )
                        }
                        style={{ borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 6 }}
                        hitSlop={6}
                      >
                        <Text style={{ color: colors.textDim, fontSize: 11 }}>
                          증권사에선 이미 {isBuy ? '매수' : '매도'}됐나요?{' '}
                          <Text style={{ color: colors.primary, fontWeight: '800' }}>＋ 체결 직접 입력</Text>
                        </Text>
                      </Pressable>
                      {!po && (
                        <Text style={{ color: colors.textDim, fontSize: 11 }}>
                          주문 내역을 찾지 못했어요. 체결이 확인되면 자동으로 보유중으로 바뀌어요.
                        </Text>
                      )}
                    </View>
                  );
                })()}

              {/* 보유 중이면 강조 박스 (보유수량·평균매수가 / 매입총액·평가총액 / 평가손익) */}
              {pnl.totalQtyOpen > 0 &&
                (() => {
                  const buyTotal = pnl.avgOpenPrice * pnl.totalQtyOpen; // 매입 총액
                  const evalTotal = price != null ? price * pnl.totalQtyOpen : null; // 평가 총액 = 현재가 × 수량
                  const evalPnl = price != null ? (price - pnl.avgOpenPrice) * pnl.totalQtyOpen : null;
                  const evalRate = price != null && pnl.avgOpenPrice > 0 ? Math.round(((price - pnl.avgOpenPrice) / pnl.avgOpenPrice) * 1000) / 10 : null;
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
                          <Text style={{ color: num.position, fontSize: 16, fontWeight: '900' }}>{formatMoney(buyTotal, proj.market)}</Text>
                        </View>
                      </View>
                      {/* 평가 총액 */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 6 }}>
                        <Text style={{ color: colors.textDim, fontSize: 12 }}>평가 총액</Text>
                        <Text style={{ color: num.evalTotal, fontSize: 16, fontWeight: '900' }}>
                          {evalTotal != null ? formatMoney(evalTotal, proj.market) : '-'}
                        </Text>
                      </View>
                      {/* 평가손익 */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ color: colors.textDim, fontSize: 12 }}>평가손익</Text>
                        <Text style={{ color: evalPnl != null ? signColor(evalPnl) : colors.textDim, fontSize: 16, fontWeight: '900' }}>
                          {evalPnl != null
                            ? `${evalPnl > 0 ? '+' : ''}${formatMoney(evalPnl, proj.market)}${evalRate != null ? ` (${evalRate > 0 ? '+' : ''}${evalRate}%)` : ''}`
                            : '-'}
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
        return effStatus === 'bought' ? (
          <StopLossSwipe key={k.id} profit={inProfit} onStopLoss={() => confirmStopLossPocket(k, proj, inProfit)}>
            {cardEl}
          </StopLossSwipe>
        ) : effStatus === 'waiting' ? (
          (() => {
            // AUTO+계좌: 오른쪽 스와이프 → 가격 직접입력 자동주문 모달. 그 외: 목표가 매수주문.
            const isAuto = tier === 'auto' && !!account && !kisOrderBlocked(proj.market);
            return (
              <BuyOrderSwipe
                key={k.id}
                auto={isAuto}
                onBuy={() => (isAuto ? setAutoOrder({ pocket: k, proj }) : confirmBuyPocket(k, proj))}
                onDelete={() => confirmDeletePocket(k, proj)}
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
          // 주문가 변경: 기존 미체결 주문을 먼저 취소한 뒤 새 가격으로 다시 주문한다.
          if (t.pending) {
            try {
              await cancelPendingOrder(t.pending, t.proj.market, account);
            } catch (e: any) {
              await load();
              return notify('주문 취소 실패', e?.message ?? '이미 체결됐을 수 있어요. 잠시 후 다시 확인해 주세요.');
            }
          }
          const r = await buyPocket({ ...t.pocket, status: 'waiting' }, t.proj, customPrice);
          await load();
          if (r.ok)
            notify(
              t.pending ? '주문가 변경 완료' : '자동주문 전송',
              `포켓 ${t.pocket.idx + 1} · ${formatPrice(customPrice, t.proj.market)} 지정가로 ${t.pending ? '다시 주문했어요.' : '자동주문을 넣었어요.'}`
            );
          else notify(t.pending ? '재주문 실패' : '자동주문 실패', r.msg ?? '처리하지 못했어요.');
        }}
      />

      {/* 목표 매수·매도가 수정 모달 (🎯 목표가 수정 버튼으로 열림) */}
      {editPocket && (() => {
        const proj = projMap[editPocket.project_id];
        if (!proj) return null;
        const pnl = computePnL(tradesByPocket[editPocket.id] ?? [], null);
        return (
          <EditTargetsModal
            visible
            onClose={() => setEditPocket(null)}
            pocket={editPocket}
            market={proj.market}
            price={prices[proj.symbol]?.price ?? null}
            avgBuy={pnl.totalQtyOpen > 0 ? pnl.avgOpenPrice : 0}
            onSave={async (b, s, stop) => {
              const r = await savePocketTargets(editPocket.id, b, s, stop);
              await load();
              setEditPocket(null);
              if (!r.stopSaved && stop != null) notify('DB 준비 필요', STOP_PRICE_MIGRATION_HINT);
            }}
          />
        );
      })()}
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

// 대기중 포켓 — 보유중 포켓(손절)과 동일하게 왼쪽으로 스와이프하면 '매수주문' 실행 (AUTO는 가격 직접입력 모달, 다이어리는 목표가)
function BuyOrderSwipe({
  onBuy,
  onDelete,
  auto,
  children,
}: {
  onBuy: () => void;
  /** 오른쪽으로 밀면 포켓 삭제 (대기중 포켓만) */
  onDelete?: () => void;
  auto?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<Swipeable>(null);
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={48}
      leftThreshold={48}
      overshootRight={false}
      overshootLeft={false}
      renderLeftActions={
        onDelete
          ? () => (
              <View style={{ width: 84, paddingRight: spacing.sm }}>
                <View style={{ flex: 1, backgroundColor: colors.danger, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' }}>
                  {'포켓삭제'.split('').map((ch, i) => (
                    <Text key={i} style={{ color: '#fff', fontWeight: '900', fontSize: 14, lineHeight: 17 }}>
                      {ch}
                    </Text>
                  ))}
                </View>
              </View>
            )
          : undefined
      }
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
        ref.current?.close();
        if (dir === 'right') onBuy();
        else if (dir === 'left') onDelete?.();
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
  target: { pocket: Pocket; proj: Project; pending?: AutoOrder } | null;
  onClose: () => void;
  onSubmit: (price: number) => void;
}) {
  const [raw, setRaw] = useState('');
  const market = target?.proj.market ?? 'KRX';
  const changing = !!target?.pending; // 미체결 주문가 변경 모드
  // 변경 모드면 현재 주문가를, 새 주문이면 매수 목표가를 기본값으로.
  const basePrice = target ? (changing ? Number(target.pending!.order_price) : target.pocket.buy_target_price) : 0;
  const defaultPrice = target ? (market === 'KRX' ? alignToKrxTick(basePrice, 'buy') : basePrice) : 0;
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
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>
            {changing ? `✏️ 포켓 ${target.pocket.idx + 1} 매수 주문가 변경` : `🤖 포켓 ${target.pocket.idx + 1} 자동주문`}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            {changing
              ? `${target.proj.name} · 현재 미체결 주문(${formatPrice(Number(target.pending!.order_price), market)} · ${money(Math.floor(Number(target.pending!.quantity)), 0)}주)을 취소하고 새 가격으로 다시 주문합니다.`
              : `${target.proj.name} · 매수 가격을 직접 입력해 지정가 자동주문을 넣습니다.`}
          </Text>
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
              <Text style={{ color: '#fff', fontWeight: '800' }}>{changing ? '취소 후 이 가격으로 재주문' : '🤖 자동주문 넣기'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}