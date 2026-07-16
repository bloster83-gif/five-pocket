import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Row } from '@/components/ui';
import { BarChart } from '@/components/charts';
import { colors, formatMoney, signColor, spacing } from '@/theme';
import { computePnL } from '@/domain/pockets';
import type { Project, Trade } from '@/types/db';

export default function StatsScreen() {
  const { signOut } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState<number | 'all'>('all');

  const load = useCallback(async () => {
    const [{ data: p }, { data: t }] = await Promise.all([
      supabase.from('projects').select('*'),
      supabase.from('trades').select('*'),
    ]);
    if (p) setProjects(p as Project[]);
    if (t) setTrades(t as Trade[]);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const years = useMemo(() => {
    const s = new Set<number>();
    trades.forEach((t) => s.add(Number(t.executed_at.slice(0, 4))));
    return Array.from(s).sort((a, b) => b - a);
  }, [trades]);

  const yearTrades = useMemo(
    () => (year === 'all' ? trades : trades.filter((t) => Number(t.executed_at.slice(0, 4)) === year)),
    [trades, year]
  );

  const stats = useMemo(() => {
    const active = projects.filter((p) => !p.closed_at).length;
    const closed = projects.filter((p) => p.closed_at).length;
    const buys = yearTrades.filter((t) => t.side === 'buy').length;
    const sells = yearTrades.filter((t) => t.side === 'sell').length;

    const tradesByProj: Record<string, Trade[]> = {};
    yearTrades.forEach((t) => {
      if (t.project_id) (tradesByProj[t.project_id] ??= []).push(t);
    });
    const perProject = projects
      .map((p) => ({ project: p, realized: computePnL(tradesByProj[p.id] ?? [], null).realized }))
      .filter((x) => (tradesByProj[x.project.id] ?? []).length > 0);

    const realizedByMarket: Record<string, number> = {};
    perProject.forEach((x) => {
      realizedByMarket[x.project.market] = (realizedByMarket[x.project.market] ?? 0) + x.realized;
    });

    const buyByPocket: Record<string, Trade> = {};
    trades.filter((t) => t.side === 'buy').forEach((t) => {
      if (t.pocket_id) buyByPocket[t.pocket_id] = t;
    });
    let wins = 0;
    const sellTrades = yearTrades.filter((t) => t.side === 'sell');
    sellTrades.forEach((s) => {
      const b = s.pocket_id ? buyByPocket[s.pocket_id] : undefined;
      if (b && s.price > b.price) wins++;
    });
    const winRate = sellTrades.length ? Math.round((wins / sellTrades.length) * 100) : null;

    const byMonth: Record<string, number> = {};
    yearTrades.forEach((t) => {
      const key = year === 'all' ? t.executed_at.slice(0, 7) : t.executed_at.slice(5, 7) + '월';
      byMonth[key] = (byMonth[key] ?? 0) + 1;
    });
    const months = Object.keys(byMonth).sort();

    return { active, closed, buys, sells, perProject, realizedByMarket, winRate, months, byMonth };
  }, [projects, yearTrades, trades, year]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  const monthData = stats.months.map((m) => ({
    label: m.replace('월', '').slice(-2),
    bars: [{ value: stats.byMonth[m], color: colors.accent }],
  }));

  const chips: (number | 'all')[] = ['all', ...years];

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 40 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={signOut} hitSlop={10} style={{ paddingRight: spacing.lg }}>
              <Text style={{ color: colors.textDim }}>로그아웃</Text>
            </Pressable>
          ),
        }}
      />

      {/* 년도별 분류 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {chips.map((c) => (
          <Pressable
            key={String(c)}
            onPress={() => setYear(c)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 999,
              backgroundColor: year === c ? colors.buy : colors.cardAlt,
            }}
          >
            <Text style={{ color: year === c ? '#fff' : colors.textDim, fontWeight: '800' }}>
              {c === 'all' ? '전체' : `${c}년`}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <StatBox label="진행중 / 종료" value={`${stats.active} / ${stats.closed}`} />
        <StatBox label="승률" value={stats.winRate == null ? '-' : `${stats.winRate}%`} color={colors.buy} />
      </View>
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <StatBox label="매수 체결" value={`${stats.buys}건`} color={colors.buy} />
        <StatBox label="매도 체결" value={`${stats.sells}건`} color={colors.sell} />
      </View>

      <Card>
        <Text style={{ color: colors.text, fontWeight: '800' }}>
          실현 손익 (시장별){year !== 'all' ? ` · ${year}년` : ''}
        </Text>
        {Object.keys(stats.realizedByMarket).length === 0 ? (
          <Text style={{ color: colors.textDim }}>매도 체결이 쌓이면 실현 손익이 계산됩니다.</Text>
        ) : (
          Object.entries(stats.realizedByMarket).map(([mkt, v]) => (
            <Row key={mkt} label={mkt === 'KRX' ? '한국 (원화)' : '미국 (달러)'} value={formatMoney(v, mkt)} valueColor={signColor(v)} />
          ))
        )}
      </Card>

      {stats.perProject.length > 0 && (
        <Card>
          <Text style={{ color: colors.text, fontWeight: '800' }}>프로젝트별 실현손익</Text>
          {stats.perProject.map((x) => (
            <Row
              key={x.project.id}
              label={`${x.project.name} (${x.project.symbol})`}
              value={formatMoney(x.realized, x.project.market)}
              valueColor={signColor(x.realized)}
            />
          ))}
        </Card>
      )}

      {monthData.length > 0 && (
        <Card>
          <Text style={{ color: colors.text, fontWeight: '800' }}>{year === 'all' ? '월별' : '월별(당해)'} 매매 건수</Text>
          <BarChart data={monthData} height={140} />
        </Card>
      )}

      {projects.length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>프로젝트를 만들고 체결을 기록하면 통계가 표시됩니다.</Text>
        </Card>
      )}
    </ScrollView>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Card style={{ flex: 1 }}>
      <Text style={{ color: colors.textDim, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: color ?? colors.text, fontSize: 22, fontWeight: '900' }}>{value}</Text>
    </Card>
  );
}
