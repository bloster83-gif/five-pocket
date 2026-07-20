import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card, Chip, Field, FilterBar, Row } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, pocketColor, radius, signColor, spacing } from '@/theme';
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
  const [pocketFilter, setPocketFilter] = useState<number | null>(null); // null = 전체, 0~4 = 포켓 1~5
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState(''); // 종목명/티커 검색
  const [market, setMarket] = useState<'KRX' | 'US' | null>(null); // null = 전체 시장
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
  //        포켓 번호 선택 시 해당 idx 의 포켓만 (null = 전체)
  const filtered = useMemo(() => {
    return pockets.filter((k) => {
      const proj = projMap[k.project_id];
      if (!proj) return false;
      if (market && proj.market !== market) return false;
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        if (!proj.name.toLowerCase().includes(s) && !proj.symbol.toLowerCase().includes(s)) return false;
      }
      if (pocketFilter != null && k.idx !== pocketFilter) return false;
      const kt = tradesByPocket[k.id] ?? [];
      const hasSell = kt.some((t) => t.side === 'sell');
      const holding = k.status === 'bought';
      if (onlyHolding && onlyRealized) return holding || hasSell;
      if (onlyHolding) return holding;
      if (onlyRealized) return hasSell;
      return true;
    });
  }, [pockets, projMap, tradesByPocket, onlyHolding, onlyRealized, pocketFilter, q, market]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 40 }}>
      {/* 🧺 포켓 번호 선택 — 맨 위, 화면 폭에 딱 맞는 균등 분할 버튼 (포켓탭 전용 서식) */}
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.buy,
          padding: spacing.sm,
          gap: spacing.xs,
        }}
      >
        <Text style={{ color: colors.buy, fontSize: 12, fontWeight: '800' }}>🧺 포켓 번호로 보기</Text>
        <View style={{ flexDirection: 'row', gap: 5 }}>
          {([null, 0, 1, 2, 3, 4] as (number | null)[]).map((i) => {
            const on = pocketFilter === i;
            const c = i == null ? colors.buy : pocketColor(i); // 포켓마다 고유 색
            return (
              <Pressable
                key={String(i)}
                onPress={() => setPocketFilter(i)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 12,
                  borderRadius: radius.md,
                  backgroundColor: on ? c : colors.cardAlt,
                  borderBottomWidth: 3,
                  borderBottomColor: i == null ? (on ? colors.buy : 'transparent') : pocketColor(i),
                }}
              >
                <Text style={{ color: on ? '#FFFFFF' : colors.textDim, fontWeight: '900', fontSize: 14 }}>
                  {i == null ? '전체' : i + 1}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 종목 검색 + 시장 필터 (어두운 바 서식) */}
      <FilterBar style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          onPress={() => setShowSearch((s) => !s)}
          style={{
            width: 40,
            height: 36,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: showSearch ? colors.buy : colors.card,
          }}
        >
          <Text style={{ fontSize: 16 }}>🔍</Text>
        </Pressable>
        <Chip label="한국" icon="🇰🇷" active={market === 'KRX'} onPress={() => setMarket(market === 'KRX' ? null : 'KRX')} />
        <Chip label="미국" icon="🇺🇸" active={market === 'US'} onPress={() => setMarket(market === 'US' ? null : 'US')} activeColor={colors.accent} />
        {!showSearch && (onlyHolding || onlyRealized || q.trim() !== '') && (
          <Text style={{ color: colors.warn, fontSize: 11, fontWeight: '700' }}>● 필터 적용중</Text>
        )}
      </FilterBar>

      {/* 종목 검색 입력 + 상태 필터 */}
      {showSearch && (
        <Card>
          <Field
            label="검색 (종목명/티커)"
            value={q}
            onChangeText={setQ}
            placeholder="예: 삼성, AAPL"
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.buy, fontWeight: '700' }}>보유중만 보기 (매수 상태)</Text>
            <Switch value={onlyHolding} onValueChange={setOnlyHolding} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.sell, fontWeight: '700' }}>실현 완료만 보기 (매도 이력)</Text>
            <Switch value={onlyRealized} onValueChange={setOnlyRealized} />
          </View>
        </Card>
      )}

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
            <Card
              style={{
                borderColor: open ? colors.accent : colors.border,
                borderLeftWidth: 5,
                borderLeftColor: pocketColor(k.idx), // 포켓 번호별 고유 색 띠
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>
                    {proj.name}{' '}
                    <Text style={{ color: pocketColor(k.idx), fontWeight: '900' }}>· 포켓 {k.idx + 1}</Text>
                  </Text>
                  <Text style={{ color: colors.textDim, fontSize: 12 }}>{proj.symbol}</Text>
                </View>
                <View style={{ backgroundColor: statusMeta.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: statusMeta.color, fontWeight: '800', fontSize: 12 }}>{statusMeta.text}</Text>
                </View>
              </View>

              {/* 보유 중이면 보유수량·평균매수가를 강조 박스로 */}
              {pnl.totalQtyOpen > 0 && (
                <View
                  style={{
                    flexDirection: 'row',
                    backgroundColor: colors.buyBg,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: colors.buy,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.md,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>보유 수량</Text>
                    <Text style={{ color: colors.buy, fontSize: 18, fontWeight: '900' }}>
                      {money(pnl.totalQtyOpen, 0)}주
                    </Text>
                  </View>
                  <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>평균 매수가</Text>
                    <Text style={{ color: colors.text, fontSize: 18, fontWeight: '900' }}>
                      {formatPrice(pnl.avgOpenPrice, proj.market)}
                    </Text>
                  </View>
                </View>
              )}

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
      })}
    </ScrollView>
  );
}