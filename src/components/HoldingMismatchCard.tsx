// 보유수량 불일치 경고 (프로젝트탭·포켓탭·매매일지 공용)
//
// 앱에 기록된 보유수량과 증권사 계좌가 어긋나면 어느 화면에서든 바로 알아채고
// 그 자리에서 맞출 수 있어야 한다. 계좌 잔고를 스스로 조회해 판단하므로
// 화면 쪽은 <HoldingMismatchCard onFixed={load} /> 한 줄만 놓으면 된다.
//
// 세 탭이 동시에 떠 있어도 증권사를 여러 번 두드리지 않도록 60초 캐시를 둔다.

import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/ui';
import { FixHoldingModal, type FixTarget } from '@/components/FixHoldingModal';
import { colors, money, radius, spacing } from '@/theme';
import { computePnL } from '@/domain/pockets';
import { findHoldingMismatches, type HoldingMismatch } from '@/services/pendingOrders';
import type { BrokerAccount, Pocket, Project, Trade } from '@/types/db';

const TTL_MS = 60_000;
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
    setMismatches(await loadMismatches((data as BrokerAccount) ?? null));
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

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

  if (mismatches.length === 0) return null;

  return (
    <>
      <Card style={{ borderColor: colors.warn, backgroundColor: 'rgba(251,191,36,0.08)' }}>
        <Text style={{ color: colors.warn, fontWeight: '900', fontSize: 14 }}>⚠️ 보유수량이 계좌와 달라요</Text>
        <Text style={{ color: colors.textDim, fontSize: 11, marginBottom: 4, lineHeight: 16 }}>
          계좌가 많으면 앱 밖에서 샀거나 체결을 놓친 거예요 — ‘바로잡기’로 그 수량을 포켓에 채워 넣으세요.{'\n'}
          앱이 많으면 앱 밖에서 팔았거나(바로잡기) 체결이 중복 기록된 거예요(매매일지에서 그 기록 삭제).{'\n'}
          매매일지의 ‘＋ 수동 입력’은 프로젝트에 붙지 않는 독립 기록이라 이 경고를 없애지 못해요.
        </Text>
        {mismatches.map((m) => (
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
