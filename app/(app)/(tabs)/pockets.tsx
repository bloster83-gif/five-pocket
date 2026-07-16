import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card, Row } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, signColor, spacing } from '@/theme';
import { computePnL } from '@/domain/pockets';
import type { Pocket, Project, Trade } from '@/types/db';

export default function PocketsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  const [onlyHolding, setOnlyHolding] = useState(false); // 보유중 스위치
  const [onlyRealized, setOnlyRealized] = useState(false); // 실현 스위치
  const [expanded, setExpanded] = useState<string | null>(null);

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
  const filtered = useMemo(() => {
    return pockets.filter((k) => {
      const proj = projMap[k.project_id];
      if (!proj) return false;
      const kt = tradesByPocket[k.id] ?? [];
      const hasSell = kt.some((t) => t.side === 'sell');
      const holding = k.status === 'bought';
      if (onlyHolding && onlyRealized) return holding || hasSell;
      if (onlyHolding) return holding;
      if (onlyRealized) return hasSell;
      return true;
    });
  }, [pockets, projMap, tradesByPocket, onlyHolding, onlyRealized]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 40 }}>
      {/* 예산 합산 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800' }}>프로젝트 예산 합계 (진행중)</Text>
        {Object.keys(budgetByMarket).length === 0 ? (
          <Text style={{ color: colors.textDim }}>예산이 설정된 프로젝트가 없어요.</Text>
        ) : (
          Object.entries(budgetByMarket).map(([mkt, v]) => (
            <Row key={mkt} label={mkt === 'KRX' ? '한국 (원화)' : '미국 (달러)'} value={formatMoney(v, mkt)} />
          ))
        )}
      </Card>

      {/* 필터 스위치 */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.buy, fontWeight: '700' }}>보유중만 보기 (매수 상태)</Text>
          <Switch value={onlyHolding} onValueChange={setOnlyHolding} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.sell, fontWeight: '700' }}>실현 완료만 보기 (매도 이력)</Text>
          <Switch value={onlyRealized} onValueChange={setOnlyRealized} />
        </View>
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
        const open = expanded === k.id;
        const statusMeta =
          k.status === 'bought'
            ? { text: '보유중', color: colors.buy, bg: colors.buyBg }
            : k.status === 'sold'
              ? { text: '매도 완료', color: colors.sell, bg: colors.sellBg }
              : { text: '대기', color: colors.textDim, bg: colors.cardAlt };
        return (
          <Pressable key={k.id} onPress={() => setExpanded(open ? null : k.id)}>
            <Card style={{ borderColor: open ? colors.accent : colors.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>
                    {proj.name} · 포켓 {k.idx + 1}
                  </Text>
                  <Text style={{ color: colors.textDim, fontSize: 12 }}>{proj.symbol}</Text>
                </View>
                <View style={{ backgroundColor: statusMeta.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: statusMeta.color, fontWeight: '800', fontSize: 12 }}>{statusMeta.text}</Text>
                </View>
              </View>

              {/* 요약: 보유수량/실현손익 */}
              <View style={{ flexDirection: 'row', gap: spacing.lg }}>
                {pnl.totalQtyOpen > 0 && (
                  <Text style={{ color: colors.text, fontSize: 13 }}>
                    보유 {money(pnl.totalQtyOpen, 0)}주 @ {formatPrice(pnl.avgOpenPrice, proj.market)}
                  </Text>
                )}
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
      })}
    </ScrollView>
  );
}
