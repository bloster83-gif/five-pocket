// 보유수량 불일치 경고 (프로젝트탭·포켓탭·매매일지 공용)
//
// 앱에 기록된 보유수량과 증권사 계좌가 어긋나면 어느 화면에서든 바로 알아채고
// 그 자리에서 맞출 수 있어야 한다. 계좌 잔고를 스스로 조회해 판단하므로
// 화면 쪽은 <HoldingMismatchCard onFixed={load} /> 한 줄만 놓으면 된다.
//
// 세 탭이 동시에 떠 있어도 증권사를 여러 번 두드리지 않도록 60초 캐시를 둔다.

import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { confirmAction, notify } from '@/lib/alert';
import { adoptHolding } from '@/services/adoptHolding';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/ui';
import { FixHoldingModal, type FixTarget } from '@/components/FixHoldingModal';
import { colors, formatPrice, money, radius, spacing } from '@/theme';
import { computePnL } from '@/domain/pockets';
import { findHoldingMismatches, reconcilePendingOrders, type HoldingMismatch } from '@/services/pendingOrders';
import type { BrokerAccount, Pocket, Project, Trade } from '@/types/db';

const TTL_MS = 60_000;
// 프로젝트로 관리하지 않기로 한 종목 (장기보유 등) — 매번 알리면 잔소리가 된다
const IGNORE_KEY = 'ignoredHoldings';
let cache: { at: number; value: HoldingMismatch[] } | null = null;
let inflight: Promise<HoldingMismatch[]> | null = null;

/** 다음 조회가 캐시를 건너뛰게 한다 (바로잡은 직후) */
export function clearMismatchCache() {
  cache = null;
}

async function loadMismatches(account: BrokerAccount | null): Promise<HoldingMismatch[]> {
  if (!account) return [];
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  if (inflight) return inflight;
  const run = findHoldingMismatches(account)
    .then((v) => {
      cache = { at: Date.now(), value: v };
      return v;
    })
    .catch(() => [] as HoldingMismatch[]);
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

export function HoldingMismatchCard({ onFixed }: { onFixed?: () => void }) {
  const { session } = useAuth();
  const router = useRouter();
  const [ignored, setIgnored] = useState<string[]>([]);
  const [mismatches, setMismatches] = useState<HoldingMismatch[]>([]);
  const [fixTarget, setFixTarget] = useState<HoldingMismatch | null>(null);
  const [targets, setTargets] = useState<FixTarget[]>([]);
  const [tradesByPocket, setTradesByPocket] = useState<Record<string, Trade[]>>({});

  const refresh = useCallback(async () => {
    if (!session?.user?.id) return;
    const { data } = await supabase
      .from('broker_accounts')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle();
    const account = (data as BrokerAccount) ?? null;
    let found = await loadMismatches(account);
    // 살아 있는 주문으로 설명되는 차이라면 '체결이 늦게 확인된 것'일 뿐이다.
    // 겁주기 전에 체결 동기화를 한 번 돌려 스스로 해소해 본다.
    if (found.some((m) => m.explainedByOrders)) {
      try {
        if (await reconcilePendingOrders(account)) {
          clearMismatchCache();
          found = await loadMismatches(account);
        }
      } catch {
        /* 동기화 실패는 무시 — 아래에서 '체결 확인 중'으로 안내한다 */
      }
    }
    setMismatches(found);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      AsyncStorage.getItem(IGNORE_KEY)
        .then((raw) => {
          const arr = raw ? JSON.parse(raw) : [];
          if (Array.isArray(arr)) setIgnored(arr as string[]);
        })
        .catch(() => {});
    }, [refresh])
  );

  /** 이 종목은 앱으로 관리하지 않겠다 — 다시 알리지 않는다 */
  const ignoreSymbol = async (symbol: string) => {
    const next = Array.from(new Set([...ignored, symbol]));
    setIgnored(next);
    AsyncStorage.setItem(IGNORE_KEY, JSON.stringify(next)).catch(() => {});
  };

  /** '바로잡기'를 누른 종목의 포켓 목록을 그때 준비한다 (평소엔 굳이 안 읽는다) */
  const openFix = async (m: HoldingMismatch) => {
    const { data: projRows } = await supabase.from('projects').select('*').eq('symbol', m.symbol).is('closed_at', null);
    const projects = (projRows ?? []) as Project[];
    if (projects.length === 0) {
      setTargets([]);
      setFixTarget(m);
      return;
    }
    const ids = projects.map((p) => p.id);
    const [{ data: pocketRows }, { data: tradeRows }] = await Promise.all([
      supabase.from('pockets').select('*').in('project_id', ids).order('idx'),
      supabase.from('trades').select('*').in('project_id', ids),
    ]);
    const byPocket: Record<string, Trade[]> = {};
    ((tradeRows ?? []) as Trade[]).forEach((t) => {
      if (t.pocket_id) (byPocket[t.pocket_id] ??= []).push(t);
    });
    const projById = new Map(projects.map((p) => [p.id, p]));
    setTradesByPocket(byPocket);
    setTargets(
      ((pocketRows ?? []) as Pocket[])
        .flatMap((k) => {
          const project = projById.get(k.project_id);
          if (!project) return [];
          return [{ pocket: k, project, openQty: Math.floor(computePnL(byPocket[k.id] ?? [], null).totalQtyOpen) }];
        })
        .sort((a, b) => a.project.name.localeCompare(b.project.name) || a.pocket.idx - b.pocket.idx)
    );
    setFixTarget(m);
  };

  const visible = mismatches.filter((m) => !(m.unmanaged && ignored.includes(m.symbol)));
  if (visible.length === 0) return null;

  // 살아 있는 주문으로 설명되는 차이는 '체결 확인 중'일 뿐이라 경고하지 않는다.
  // (주문을 넣어 뒀는데 체결이 앱에 늦게 반영되는 구간 — 잠시 뒤 저절로 맞는다)
  const pendingOnly = visible.filter((m) => m.explainedByOrders && !m.unmanaged);
  const real = visible.filter((m) => !m.explainedByOrders && !m.unmanaged);
  const unmanaged = visible.filter((m) => m.unmanaged);

  /**
   * 계좌에만 있는 종목을 한 번에 프로젝트로 잡아온다.
   * 생성 화면으로 보내면 '사용가능 예산 초과'로 저장이 막힌다 —
   * 이미 산 주식이라 그 돈이 예수금에 없기 때문. 그래서 여기서 바로 만든다.
   */
  const adopt = (m: HoldingMismatch) => {
    const avg = m.avgPrice ?? 0;
    if (!session?.user?.id) return;
    if (avg <= 0) {
      // 평단을 못 읽으면 직접 입력하도록 생성 화면으로 (드문 경우)
      router.push(
        `/project/new?symbol=${encodeURIComponent(m.symbol)}&name=${encodeURIComponent(m.name)}&market=${m.market}`
      );
      return;
    }
    confirmAction(
      '프로젝트로 잡기',
      `${m.name} ${money(m.heldQty, 0)}주(평단 ${formatPrice(avg, m.market)})를 새 프로젝트로 만들고\n` +
        `포켓 1에 전부 보유중으로 잡을까요?\n\n` +
        `· 기준가 ${formatPrice(avg, m.market)} · 총예산 ${formatPrice(avg * m.heldQty, m.market)}\n` +
        `· 매수 간격 5% · 매도 목표 10% (나중에 포켓별 목표가 수정 가능)`,
      async () => {
        try {
          await adoptHolding({
            userId: session.user.id,
            symbol: m.symbol,
            name: m.name,
            market: m.market,
            qty: m.heldQty,
            avgPrice: avg,
          });
        } catch (e: any) {
          return notify('만들지 못했어요', e?.message ?? '잠시 후 다시 시도해 주세요.');
        }
        clearMismatchCache();
        await refresh();
        onFixed?.();
        notify(
          '프로젝트로 잡았어요',
          `${m.name} ${money(m.heldQty, 0)}주가 포켓 1에 보유중으로 들어갔어요.\n매도 목표가는 포켓 카드의 '🎯 목표가 수정'에서 바꿀 수 있어요.`
        );
      },
      '만들기'
    );
  };

  return (
    <>
      {pendingOnly.length > 0 && (
        <Card style={{ borderColor: colors.border }}>
          <Text style={{ color: colors.textDim, fontWeight: '800', fontSize: 13 }}>🕐 체결 확인 중</Text>
          <Text style={{ color: colors.textDim, fontSize: 11, lineHeight: 16 }}>
            넣어 둔 주문이 체결됐는데 앱이 아직 반영하지 못한 것 같아요. 잠시 뒤 저절로 맞춰져요.{'\n'}
            (주문 잔량으로 설명되는 차이라 문제로 보지 않아요)
          </Text>
          {pendingOnly.map((m) => (
            <View key={m.symbol} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                {m.name}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '800' }}>
                앱 {money(m.recordedQty, 0)}주 · 계좌 {money(m.heldQty, 0)}주
              </Text>
            </View>
          ))}
          <Pressable
            onPress={() => {
              clearMismatchCache();
              void refresh();
            }}
            hitSlop={6}
          >
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>🔄 지금 다시 확인</Text>
          </Pressable>
        </Card>
      )}

      {real.length > 0 && (
      <Card style={{ borderColor: colors.warn, backgroundColor: 'rgba(251,191,36,0.08)' }}>
        <Text style={{ color: colors.warn, fontWeight: '900', fontSize: 14 }}>⚠️ 보유수량이 계좌와 달라요</Text>
        <Text style={{ color: colors.textDim, fontSize: 11, marginBottom: 4, lineHeight: 16 }}>
          계좌가 많으면 앱 밖에서 샀거나 체결을 놓친 거예요 — ‘바로잡기’로 그 수량을 포켓에 채워 넣으세요.{'\n'}
          앱이 많으면 앱 밖에서 팔았거나(바로잡기) 체결이 중복 기록된 거예요(매매일지에서 그 기록 삭제).{'\n'}
          매매일지의 ‘＋ 수동 입력’은 프로젝트에 붙지 않는 독립 기록이라 이 경고를 없애지 못해요.
        </Text>
        {real.map((m) => (
          <View
            key={m.symbol}
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}
          >
            <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
              {m.name}
            </Text>
            <Text style={{ fontSize: 13, fontWeight: '800' }}>
              <Text style={{ color: m.recordedQty > m.heldQty ? colors.buy : colors.sell }}>
                앱 {money(m.recordedQty, 0)}주
              </Text>
              <Text style={{ color: colors.textDim }}> · 계좌 {money(m.heldQty, 0)}주</Text>
            </Text>
            <Pressable
              onPress={() => void openFix(m)}
              hitSlop={6}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.warn,
                backgroundColor: 'rgba(251,191,36,0.14)',
              }}
            >
              <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '900' }}>🩹 바로잡기</Text>
            </Pressable>
          </View>
        ))}
      </Card>
      )}

      {unmanaged.length > 0 && (
        <Card style={{ borderColor: colors.warn, backgroundColor: 'rgba(251,191,36,0.08)' }}>
          <Text style={{ color: colors.warn, fontWeight: '900', fontSize: 14 }}>⚠️ 앱이 모르는 보유 종목</Text>
          <Text style={{ color: colors.textDim, fontSize: 11, marginBottom: 4, lineHeight: 16 }}>
            계좌에는 있는데 진행중 프로젝트가 없어요. ‘바로잡기’를 누르면 프로젝트를 만들고 포켓 1에 전부 잡아요.{'\n'}
            (장기보유처럼 앱으로 관리하지 않는 종목이면 ‘숨기기’를 누르세요)
          </Text>
          {unmanaged.map((m) => (
            <View key={m.symbol} style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                  {m.name}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '800' }}>
                  계좌 {money(m.heldQty, 0)}주
                  {m.avgPrice ? ` · 평단 ${formatPrice(m.avgPrice, m.market)}` : ''}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md }}>
                <Pressable onPress={() => void ignoreSymbol(m.symbol)} hitSlop={6}>
                  <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '800' }}>숨기기</Text>
                </Pressable>
                <Pressable onPress={() => adopt(m)} hitSlop={6}>
                  <Text style={{ color: colors.warn, fontSize: 12, fontWeight: '900' }}>🩹 바로잡기</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </Card>
      )}

      <FixHoldingModal
        mismatch={fixTarget}
        targets={targets}
        trades={tradesByPocket}
        userId={session?.user?.id}
        onClose={() => setFixTarget(null)}
        onSaved={() => {
          clearMismatchCache(); // 방금 고쳤으니 캐시를 버리고 다시 본다
          void refresh();
          onFixed?.();
        }}
      />
    </>
  );
}
