import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Switch,
  Text,
  View,
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card, Field } from '@/components/ui';
import { colors, formatMoney, signColor, spacing } from '@/theme';
import { computePnL } from '@/domain/pockets';
import { priceProvider } from '@/services/prices';
import type { Project, Trade } from '@/types/db';

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '-');

interface Metric {
  value: number | null; // 평가총액 (보유수량 * 현재가)
  pnl: number | null; // 평가손익 (미실현)
  realized: number; // 실현손익 (매도 완료분)
  market: string;
}

export default function ProjectsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metric>>({});
  const [loading, setLoading] = useState(true);

  const [showSearch, setShowSearch] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    const [{ data: projData }, { data: tradeData }] = await Promise.all([
      supabase.from('projects').select('*').order('created_at', { ascending: false }),
      supabase.from('trades').select('*'),
    ]);
    const projs = (projData as Project[]) ?? [];
    setProjects(projs);
    setLoading(false);

    // 프로젝트별 보유 포지션 계산 + 현재가로 평가총액/평가손익
    const tradesByProj: Record<string, Trade[]> = {};
    ((tradeData as Trade[]) ?? []).forEach((t) => {
      if (t.project_id) (tradesByProj[t.project_id] ??= []).push(t);
    });

    await Promise.all(
      projs.map(async (p) => {
        const base = computePnL(tradesByProj[p.id] ?? [], null);
        if (base.totalQtyOpen <= 0) {
          setMetrics((m) => ({ ...m, [p.id]: { value: 0, pnl: 0, realized: base.realized, market: p.market } }));
          return;
        }
        try {
          const qt = await priceProvider.getQuote(p.symbol);
          const mkt = qt.currency === 'KRW' ? 'KRX' : qt.currency === 'USD' ? 'US' : p.market;
          setMetrics((m) => ({
            ...m,
            [p.id]: {
              value: base.totalQtyOpen * qt.price,
              pnl: (qt.price - base.avgOpenPrice) * base.totalQtyOpen,
              realized: base.realized,
              market: mkt,
            },
          }));
        } catch {
          setMetrics((m) => ({ ...m, [p.id]: { value: null, pnl: null, realized: base.realized, market: p.market } }));
        }
      })
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (!showClosed && p.closed_at) return false; // 기본: 진행중만
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        if (!p.name.toLowerCase().includes(s) && !p.symbol.toLowerCase().includes(s)) return false;
      }
      const created = p.created_at.slice(0, 10);
      if (from && created < from) return false;
      if (to && created > to) return false;
      return true;
    });
  }, [projects, showClosed, q, from, to]);

  return (
    <View style={{ flex: 1 }}>
      {/* 툴바: 돋보기 (매매일지와 동일 서식) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Pressable
          onPress={() => setShowSearch((s) => !s)}
          style={{
            width: 44,
            height: 40,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: showSearch ? colors.buy : colors.cardAlt,
          }}
        >
          <Text style={{ fontSize: 18 }}>🔍</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.buy} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 96 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.buy} />}
          ListHeaderComponent={
            !showSearch ? null : (
            <Card style={{ marginBottom: spacing.xs }}>
              <Field label="검색 (종목명/티커)" value={q} onChangeText={setQ} placeholder="예: 삼성, AAPL" autoCapitalize="none" />
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="생성일 이후" value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" autoCapitalize="none" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="생성일 이전" value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" autoCapitalize="none" />
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: colors.text }}>지난(종료) 프로젝트 보기</Text>
                <Switch value={showClosed} onValueChange={setShowClosed} />
              </View>
            </Card>
            )
          }
          ListEmptyComponent={
            <Card>
              <Text style={{ color: colors.text, fontWeight: '700' }}>표시할 프로젝트가 없어요</Text>
              <Text style={{ color: colors.textDim }}>
                아래 + 버튼으로 종목과 5분할 전략을 등록하세요. 종료한 프로젝트는 위의 “지난 프로젝트 보기”로 확인할 수 있어요.
              </Text>
            </Card>
          }
          renderItem={({ item }) => {
            const closed = !!item.closed_at;
            const m = metrics[item.id];
            return (
              <Pressable onPress={() => router.push(`/project/${item.id}`)}>
                <Card
                  style={
                    closed
                      ? { backgroundColor: 'rgba(59,130,246,0.07)', borderColor: colors.sell, borderLeftWidth: 4 }
                      : undefined
                  }
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: closed ? colors.textDim : colors.text,
                          fontSize: 18,
                          fontWeight: '800',
                        }}
                      >
                        {item.name}
                      </Text>
                      <Text style={{ color: colors.textDim, marginTop: 2 }}>
                        {item.symbol} · {item.market === 'KRX' ? '한국' : '미국'}
                      </Text>
                      {/* 매수/매도 세팅값 */}
                      <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                        <View style={{ backgroundColor: colors.buyBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ color: colors.buy, fontSize: 12, fontWeight: '800' }}>
                            매수 -{item.buy_interval_pct}%
                          </Text>
                        </View>
                        <View style={{ backgroundColor: colors.sellBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                          <Text style={{ color: colors.sell, fontSize: 12, fontWeight: '800' }}>
                            매도 +{item.sell_target_pct}%
                          </Text>
                        </View>
                      </View>
                    </View>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 999,
                        backgroundColor: closed ? 'rgba(59,130,246,0.18)' : 'rgba(245,69,92,0.15)',
                      }}
                    >
                      <Text style={{ fontSize: 12 }}>{closed ? '🔒' : '🔴'}</Text>
                      <Text style={{ color: closed ? colors.sell : colors.buy, fontSize: 12, fontWeight: '800' }}>
                        {closed ? '종료' : '진행중'}
                      </Text>
                    </View>
                  </View>
                  {m && ((m.value != null && m.value > 0) || m.realized !== 0) && (
                    <View style={{ marginTop: spacing.sm, gap: 3 }}>
                      {m.value != null && m.value > 0 && (
                        <>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={{ color: colors.textDim }}>평가 총액</Text>
                            <Text style={{ color: colors.text, fontWeight: '800' }}>{formatMoney(m.value, m.market)}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={{ color: colors.textDim }}>평가 손익</Text>
                            <Text style={{ color: signColor(m.pnl ?? 0), fontWeight: '800' }}>
                              {m.pnl != null && m.pnl > 0 ? '+' : ''}
                              {formatMoney(m.pnl, m.market)}
                            </Text>
                          </View>
                        </>
                      )}
                      {m.realized !== 0 && (
                        // 실현손익: 확정 수익이라 배지 서식으로 구분
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: colors.textDim }}>실현 손익 ✓</Text>
                          <View
                            style={{
                              backgroundColor: m.realized >= 0 ? colors.buyBg : colors.sellBg,
                              borderRadius: 6,
                              paddingHorizontal: 8,
                              paddingVertical: 2,
                            }}
                          >
                            <Text style={{ color: signColor(m.realized), fontWeight: '900' }}>
                              {m.realized > 0 ? '+' : ''}
                              {formatMoney(m.realized, m.market)}
                            </Text>
                          </View>
                        </View>
                      )}
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs }}>
                    <Text style={{ color: colors.textDim, fontSize: 12 }}>생성 {fmtDate(item.created_at)}</Text>
                    {closed && <Text style={{ color: colors.textDim, fontSize: 12 }}>종료 {fmtDate(item.closed_at)}</Text>}
                  </View>
                </Card>
              </Pressable>
            );
          }}
        />
      )}

      <Link href="/project/new" asChild>
        <Pressable
          style={{
            position: 'absolute',
            right: spacing.lg,
            bottom: spacing.xl,
            backgroundColor: colors.buy,
            width: 60,
            height: 60,
            borderRadius: 30,
            alignItems: 'center',
            justifyContent: 'center',
            elevation: 4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 30, fontWeight: '800', marginTop: -2 }}>+</Text>
        </Pressable>
      </Link>
    </View>
  );
}
