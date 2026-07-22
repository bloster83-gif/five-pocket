import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card, Chip, FilterBar, Row } from '@/components/ui';
import { BarChart } from '@/components/charts';
import { colors, formatMoney, radius, signColor, spacing } from '@/theme';
import { realizedEvents } from '@/domain/pockets';
import type { Project, Trade } from '@/types/db';

// 통계 화면 본문 (MY 탭 안에 임베드해서 사용 — 자체 ScrollView 없음)
export function StatsContent() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState<number | 'all'>('all');
  const [market, setMarket] = useState<'all' | 'KRX' | 'US'>('all');
  const [detailOpen, setDetailOpen] = useState(false); // 프로젝트별 실현손익 자세히 보기

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

  const projById = useMemo(() => {
    const m: Record<string, Project> = {};
    projects.forEach((p) => (m[p.id] = p));
    return m;
  }, [projects]);

  const marketOf = useCallback(
    (t: Trade) => (t.project_id ? projById[t.project_id]?.market : undefined) ?? t.market ?? 'US',
    [projById]
  );

  const yearTrades = useMemo(
    () =>
      trades.filter(
        (t) =>
          (year === 'all' || Number(t.executed_at.slice(0, 4)) === year) &&
          (market === 'all' || marketOf(t) === market)
      ),
    [trades, year, market, marketOf]
  );

  const stats = useMemo(() => {
    const active = projects.filter((p) => !p.closed_at).length;
    const closed = projects.filter((p) => p.closed_at).length;
    // 매수/매도 체결 "건수" (체결 1건당 1개로 카운팅)
    const buys = yearTrades.filter((t) => t.side === 'buy').length;
    const sells = yearTrades.filter((t) => t.side === 'sell').length;

    const events = realizedEvents(trades).filter(
      (ev) =>
        (year === 'all' || Number(ev.at.slice(0, 4)) === year) &&
        (market === 'all' || marketOf(ev.trade) === market)
    );

    const realizedByProj: Record<string, number> = {};
    const realizedByMarket: Record<string, number> = {};
    // 프로젝트별 매도 체결 상세 (자세히 보기용): 날짜·수량·체결가·실현손익
    const detailByProj: Record<string, { at: string; qty: number; price: number; amount: number }[]> = {};
    let wins = 0;
    events.forEach((ev) => {
      const proj = ev.trade.project_id ? projById[ev.trade.project_id] : undefined;
      const mkt = proj?.market ?? ev.trade.market ?? 'US';
      realizedByMarket[mkt] = (realizedByMarket[mkt] ?? 0) + ev.amount;
      if (ev.trade.project_id) {
        realizedByProj[ev.trade.project_id] = (realizedByProj[ev.trade.project_id] ?? 0) + ev.amount;
        (detailByProj[ev.trade.project_id] ??= []).push({
          at: ev.at,
          qty: ev.trade.quantity,
          price: ev.trade.price,
          amount: ev.amount,
        });
      }
      if (ev.amount > 0) wins++;
    });
    const perProject = projects
      .filter((p) => realizedByProj[p.id] != null)
      .map((p) => ({
        project: p,
        realized: realizedByProj[p.id],
        // 최신 체결 먼저
        detail: (detailByProj[p.id] ?? []).slice().sort((a, b) => (a.at < b.at ? 1 : -1)),
      }));
    const winRate = events.length ? Math.round((wins / events.length) * 100) : null;

    const byMonth: Record<string, number> = {};
    yearTrades.forEach((t) => {
      const key = year === 'all' ? t.executed_at.slice(0, 7) : t.executed_at.slice(5, 7) + '월';
      byMonth[key] = (byMonth[key] ?? 0) + 1;
    });
    const months = Object.keys(byMonth).sort();

    return { active, closed, buys, sells, perProject, realizedByMarket, winRate, months, byMonth };
  }, [projects, projById, yearTrades, trades, year, market, marketOf]);

  if (loading) {
    return <ActivityIndicator color={colors.buy} style={{ marginVertical: spacing.lg }} />;
  }

  const monthData = stats.months.map((m) => ({
    label: m.replace('월', '').slice(-2),
    bars: [{ value: stats.byMonth[m], color: colors.accent }],
  }));

  const chips: (number | 'all')[] = ['all', ...years];

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>📊 통계</Text>

      {/* 연도 + 시장 필터 */}
      <FilterBar>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {chips.map((c) => (
            <Pressable
              key={String(c)}
              onPress={() => setYear(c)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 999,
                backgroundColor: year === c ? colors.buy : colors.card,
              }}
            >
              <Text style={{ color: year === c ? '#fff' : colors.textDim, fontWeight: '800' }}>
                {c === 'all' ? '전체' : `${c}년`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>시장</Text>
          <Chip label="전체" active={market === 'all'} onPress={() => setMarket('all')} />
          <Chip label="한국" icon="🇰🇷" active={market === 'KRX'} onPress={() => setMarket('KRX')} />
          <Chip label="미국" icon="🇺🇸" active={market === 'US'} onPress={() => setMarket('US')} activeColor={colors.accent} />
        </View>
      </FilterBar>

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <StatBox label="진행중 / 종료 (프로젝트)" value={`${stats.active} / ${stats.closed}`} />
        <StatBox label="승률" value={stats.winRate == null ? '-' : `${stats.winRate}%`} color={colors.buy} hint="이익 난 매도 ÷ 전체 매도" />
      </View>
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <StatBox label="매수 체결 건수" value={`${stats.buys}건`} color={colors.buy} />
        <StatBox label="매도 체결 건수" value={`${stats.sells}건`} color={colors.sell} />
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
          <Pressable
            onPress={() => setDetailOpen(true)}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Text style={{ color: colors.text, fontWeight: '800' }}>프로젝트별 실현손익</Text>
            <Text style={{ color: colors.accent, fontWeight: '700', fontSize: 13 }}>자세히 보기 ›</Text>
          </Pressable>
          {stats.perProject.map((x) => (
            <View
              key={x.project.id}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
            >
              <Text style={{ color: colors.textDim, flex: 1 }} numberOfLines={1}>
                {x.project.name} <Text style={{ fontSize: 11 }}>({x.project.symbol})</Text>
              </Text>
              <Text style={{ color: signColor(x.realized), fontWeight: '700' }} numberOfLines={1}>
                {formatMoney(x.realized, x.project.market)}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {/* 프로젝트별 실현손익 자세히 보기 — 별도 창(모달) */}
      <ProjectRealizedModal
        visible={detailOpen}
        onClose={() => setDetailOpen(false)}
        rows={stats.perProject}
        periodLabel={year === 'all' ? '전체' : `${year}년`}
      />

      {monthData.length > 0 && (
        <Card>
          <Text style={{ color: colors.text, fontWeight: '800' }}>{year === 'all' ? '월별' : '월별(당해)'} 매매 건수</Text>
          <Text style={{ color: colors.textDim, fontSize: 11 }}>월별 매수·매도 체결 건수 합계</Text>
          <BarChart data={monthData} height={140} />
        </Card>
      )}

      {projects.length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>프로젝트를 만들고 체결을 기록하면 통계가 표시됩니다.</Text>
        </Card>
      )}
    </View>
  );
}

function StatBox({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <Card style={{ flex: 1 }}>
      <Text style={{ color: colors.textDim, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: color ?? colors.text, fontSize: 22, fontWeight: '900' }}>{value}</Text>
      {hint ? <Text style={{ color: colors.textDim, fontSize: 10, marginTop: 2 }}>{hint}</Text> : null}
    </Card>
  );
}

type ProjRealized = {
  project: Project;
  realized: number;
  detail: { at: string; qty: number; price: number; amount: number }[];
};

// 프로젝트별 실현손익 상세 — 별도 창(모달). 프로젝트마다 매도 체결별 실현손익을 보여준다.
function ProjectRealizedModal({
  visible,
  onClose,
  rows,
  periodLabel,
}: {
  visible: boolean;
  onClose: () => void;
  rows: ProjRealized[];
  periodLabel: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.card,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.lg,
            paddingBottom: spacing.xl,
            maxHeight: '85%',
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>
              프로젝트별 실현손익 <Text style={{ color: colors.textDim, fontSize: 13 }}>· {periodLabel}</Text>
            </Text>
            <Pressable onPress={onClose} hitSlop={10} style={{ paddingHorizontal: 6 }}>
              <Text style={{ color: colors.textDim, fontSize: 20, fontWeight: '900' }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ gap: spacing.md, paddingBottom: spacing.md }} showsVerticalScrollIndicator={false}>
            {rows.map((x) => (
              <View
                key={x.project.id}
                style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: 8 }}
              >
                {/* 프로젝트 헤더: 이름 + 합계 */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <Text style={{ color: colors.text, fontWeight: '800', flex: 1 }} numberOfLines={1}>
                    {x.project.name} <Text style={{ color: colors.textDim, fontSize: 12 }}>({x.project.symbol})</Text>
                  </Text>
                  <Text style={{ color: signColor(x.realized), fontWeight: '900', fontSize: 15 }} numberOfLines={1}>
                    {x.realized > 0 ? '+' : ''}
                    {formatMoney(x.realized, x.project.market)}
                  </Text>
                </View>
                {/* 매도 체결별 상세 */}
                {x.detail.length > 0 ? (
                  <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6, gap: 4 }}>
                    {x.detail.map((d, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ color: colors.textDim, fontSize: 12 }}>
                          {d.at.slice(0, 10)} · 매도 {formatMoney(d.price, x.project.market)} · {d.qty}주
                        </Text>
                        <Text style={{ color: signColor(d.amount), fontSize: 12, fontWeight: '700' }}>
                          {d.amount > 0 ? '+' : ''}
                          {formatMoney(d.amount, x.project.market)}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={{ color: colors.textDim, fontSize: 12 }}>매도 체결 상세가 없어요.</Text>
                )}
              </View>
            ))}
          </ScrollView>

          <Pressable
            onPress={onClose}
            style={{ backgroundColor: colors.buy, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center', marginTop: spacing.sm }}
          >
            <Text style={{ color: '#fff', fontWeight: '800' }}>닫기</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
