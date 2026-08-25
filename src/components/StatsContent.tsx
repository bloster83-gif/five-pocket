import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card, Chip, FilterBar, Row } from '@/components/ui';
import { BarChart } from '@/components/charts';
import { colors, formatKRW, formatMoney, num, radius, signColor, spacing } from '@/theme';
import { computePnL, realizedEvents } from '@/domain/pockets';
import { fetchCloseSeries } from '@/services/prices/yahooProvider';
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

    return { active, closed, buys, sells, perProject, realizedByMarket, winRate };
  }, [projects, projById, yearTrades, trades, year, market, marketOf]);

  if (loading) {
    return <ActivityIndicator color={colors.buy} style={{ marginVertical: spacing.lg }} />;
  }

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

      <MonthlyStatsCard trades={trades} projById={projById} marketOf={marketOf} year={year} market={market} />

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

// =====================================================================
// 월별 통계 카드 — 지표 버튼(건수/실현손익/평가손익/평가금액) + 1~12월 고정
// 막대를 누르면 그 달의 정확한 수치가 표시된다.
// 평가금액·평가손익은 "그 달 말 종가 × 그 시점 보유수량"으로 계산 (월봉 종가 사용).
// =====================================================================

type MonthMetric = 'count' | 'realized' | 'evalPnl' | 'evalValue';

const METRIC_META: Record<MonthMetric, { label: string; sub: string }> = {
  count: { label: '매매 건수', sub: '월별 매수·매도 체결 건수 합계' },
  realized: { label: '실현손익', sub: '그 달에 매도한 건들의 실현손익 합계' },
  evalPnl: { label: '평가손익', sub: '월말 기준 보유분 평가손익 (월말 종가 × 수량 − 매입원가)' },
  evalValue: { label: '평가금액', sub: '월말 기준 보유분 평가총액 (월말 종가 × 수량)' },
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function MonthlyStatsCard({
  trades,
  projById,
  marketOf,
  year,
  market,
}: {
  trades: Trade[];
  projById: Record<string, Project>;
  marketOf: (t: Trade) => string;
  year: number | 'all';
  market: 'all' | 'KRX' | 'US';
}) {
  const [metric, setMetric] = useState<MonthMetric>('count');
  const [selMonth, setSelMonth] = useState<number | null>(null);
  // 심볼별 월말 종가: symbol → { 'YYYY-MM': close }
  const [closes, setCloses] = useState<Record<string, Record<string, number>>>({});
  const [closesLoading, setClosesLoading] = useState(false);
  const [closesError, setClosesError] = useState(false);

  const nowYear = new Date().getFullYear();
  const chartYear = year === 'all' ? nowYear : year;
  const nowMonthKey = `${nowYear}-${pad2(new Date().getMonth() + 1)}`;

  const symbolOf = useCallback(
    (t: Trade) => (t.project_id ? projById[t.project_id]?.symbol : undefined) ?? t.symbol ?? null,
    [projById]
  );

  // 시장 필터 적용된 체결 (연도는 지표별로 다르게 쓰므로 여기선 시장만)
  const mTrades = useMemo(
    () => trades.filter((t) => market === 'all' || marketOf(t) === market),
    [trades, market, marketOf]
  );

  // 평가 지표에 필요한 심볼들 (해당 시장의 체결이 있는 심볼 전부)
  const symbols = useMemo(() => {
    const s = new Set<string>();
    mTrades.forEach((t) => {
      const sym = symbolOf(t);
      if (sym) s.add(sym);
    });
    return Array.from(s);
  }, [mTrades, symbolOf]);

  // 평가 지표 선택 시 월봉 종가 지연 로드 (심볼당 1회, 10년치)
  useEffect(() => {
    if (metric !== 'evalPnl' && metric !== 'evalValue') return;
    const missing = symbols.filter((s) => !closes[s]);
    if (missing.length === 0) return;
    let alive = true;
    setClosesLoading(true);
    setClosesError(false);
    Promise.all(
      missing.map(async (sym) => {
        try {
          const { points } = await fetchCloseSeries(sym, '10Y');
          const m: Record<string, number> = {};
          points.forEach((p) => {
            const d = new Date(p.t);
            m[`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`] = p.c; // 같은 달이면 마지막 값 = 그 달 종가
          });
          return [sym, m] as const;
        } catch {
          return null;
        }
      })
    ).then((rs) => {
      if (!alive) return;
      const ok = rs.filter(Boolean) as (readonly [string, Record<string, number>])[];
      if (ok.length > 0) {
        setCloses((prev) => {
          const next = { ...prev };
          ok.forEach(([sym, m]) => (next[sym] = m));
          return next;
        });
      }
      if (ok.length < missing.length) setClosesError(true);
      setClosesLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, symbols]);

  // 12개월 값 계산 (null = 아직 안 온 달 / 데이터 없음)
  const values = useMemo<(number | null)[]>(() => {
    const out: (number | null)[] = Array(12).fill(null);

    if (metric === 'count') {
      for (let i = 0; i < 12; i++) out[i] = 0;
      mTrades.forEach((t) => {
        if (Number(t.executed_at.slice(0, 4)) !== chartYear) return;
        out[Number(t.executed_at.slice(5, 7)) - 1]! += 1;
      });
      return out;
    }

    if (metric === 'realized') {
      for (let i = 0; i < 12; i++) out[i] = 0;
      realizedEvents(mTrades).forEach((ev) => {
        if (Number(ev.at.slice(0, 4)) !== chartYear) return;
        out[Number(ev.at.slice(5, 7)) - 1]! += ev.amount;
      });
      return out;
    }

    // 평가금액 / 평가손익 — 월말 스냅샷
    const tradesBySym: Record<string, Trade[]> = {};
    mTrades.forEach((t) => {
      const sym = symbolOf(t);
      if (sym) (tradesBySym[sym] ??= []).push(t);
    });
    for (let i = 0; i < 12; i++) {
      const monthKey = `${chartYear}-${pad2(i + 1)}`;
      if (monthKey > nowMonthKey) continue; // 미래 달은 비움
      let sum = 0;
      let has = false;
      for (const [sym, ts] of Object.entries(tradesBySym)) {
        const upTo = ts.filter((t) => t.executed_at.slice(0, 7) <= monthKey);
        if (upTo.length === 0) continue;
        const pnl = computePnL(upTo, null);
        if (pnl.totalQtyOpen <= 0) continue;
        const close = closes[sym]?.[monthKey];
        if (close == null) continue; // 종가 없으면 이 심볼은 건너뜀
        has = true;
        sum += metric === 'evalValue' ? pnl.totalQtyOpen * close : pnl.totalQtyOpen * close - pnl.investedOpen;
      }
      out[i] = has ? Math.round(sum) : 0;
    }
    return out;
  }, [metric, mTrades, chartYear, nowMonthKey, symbolOf, closes]);

  // 금액 표기: 시장 필터에 따라 통화 결정 ('전체'는 ₩ 기준 단순 합산)
  const fmtVal = useCallback(
    (v: number) => {
      if (metric === 'count') return `${v}건`;
      const sign = v > 0 && metric !== 'evalValue' ? '+' : '';
      if (market === 'US') return sign + formatMoney(v, 'US');
      if (market === 'KRX') return sign + formatMoney(v, 'KRX');
      return sign + formatKRW(v);
    },
    [metric, market]
  );

  const barColor = (v: number) =>
    metric === 'count' ? colors.accent : metric === 'evalValue' ? num.evalTotal : signColor(v);

  const chartData = values.map((v, i) => ({
    label: `${i + 1}`,
    bars: [{ value: v == null ? 0 : Math.abs(v), color: v == null ? colors.border : barColor(v) }],
  }));

  const meta = METRIC_META[metric];
  const needsCloses = metric === 'evalPnl' || metric === 'evalValue';

  return (
    <Card>
      <Text style={{ color: colors.text, fontWeight: '800' }}>
        월별 {meta.label} <Text style={{ color: colors.textDim, fontSize: 12 }}>· {chartYear}년</Text>
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>{meta.sub}</Text>

      {/* 지표 선택 버튼 */}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Chip label="건수" active={metric === 'count'} onPress={() => { setMetric('count'); setSelMonth(null); }} activeColor={colors.accent} />
        <Chip label="실현손익" active={metric === 'realized'} onPress={() => { setMetric('realized'); setSelMonth(null); }} />
        <Chip label="평가손익" active={metric === 'evalPnl'} onPress={() => { setMetric('evalPnl'); setSelMonth(null); }} />
        <Chip label="평가금액" active={metric === 'evalValue'} onPress={() => { setMetric('evalValue'); setSelMonth(null); }} activeColor={num.evalTotal} />
      </View>

      {/* 선택한 달 수치 */}
      {selMonth != null && (
        <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.sm, padding: spacing.sm }}>
          <Text style={{ color: colors.text, fontWeight: '800' }}>
            {chartYear}년 {selMonth + 1}월 ·{' '}
            {values[selMonth] == null ? (
              <Text style={{ color: colors.textDim }}>데이터 없음</Text>
            ) : (
              <Text style={{ color: metric === 'count' ? colors.accent : metric === 'evalValue' ? num.evalTotal : signColor(values[selMonth]!) }}>
                {fmtVal(values[selMonth]!)}
              </Text>
            )}
          </Text>
        </View>
      )}

      {needsCloses && closesLoading ? (
        <View style={{ height: 140, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.buy} />
          <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: 6 }}>월말 종가 불러오는 중…</Text>
        </View>
      ) : (
        <BarChart data={chartData} height={150} onBarPress={setSelMonth} selectedIndex={selMonth} />
      )}

      <Text style={{ color: colors.textDim, fontSize: 10 }}>
        막대를 누르면 수치가 표시됩니다.
        {market === 'all' && metric !== 'count' ? ' · 시장 "전체"는 ₩·$ 금액 단순 합산(₩ 표기)' : ''}
        {needsCloses ? ' · 평가 지표는 월말 종가 기준(웹에서는 시세 차단으로 안 보일 수 있어요)' : ''}
      </Text>
      {needsCloses && closesError && (
        <Text style={{ color: colors.warn, fontSize: 11 }}>일부 종목의 종가를 불러오지 못해 제외됐어요.</Text>
      )}
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
      {/* 배경은 절대배치 Pressable, 시트는 View — Pressable 이 시트를 감싸면 스크롤 드래그를 가로챈다 */}
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} />
        <View
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
        </View>
      </View>
    </Modal>
  );
}
