import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { confirmAction } from '@/lib/alert';
import { Card, Chip, Field, FilterBar } from '@/components/ui';
import { realizedEvents } from '@/domain/pockets';
import { colors, formatKRW, formatMoney, formatPrice, money, signColor, spacing } from '@/theme';
import type { CashFlow, CashFlowType, Project, Trade } from '@/types/db';

const FLOW_META: Record<CashFlowType, { label: string; color: string; sign: string }> = {
  deposit: { label: '입금', color: colors.buy, sign: '+' },
  withdrawal: { label: '출금', color: colors.sell, sign: '-' },
  dividend: { label: '배당금', color: colors.accent, sign: '+' },
};

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function JournalScreen() {
  const router = useRouter();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [flows, setFlows] = useState<CashFlow[]>([]);
  const [projMap, setProjMap] = useState<Record<string, Project>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState(ymd(new Date()));
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState('');
  // 기본 조회 기간: 올해 1월 1일 ~ 오늘
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(ymd(new Date()));
  const [preset, setPreset] = useState<string | null>('올해'); // 기간 빠른 버튼
  const [sideFilter, setSideFilter] = useState<'buy' | 'sell' | null>(null); // 매수/매도만 보기

  // 기간 빠른 버튼: 한 번 탭으로 from/to 설정
  const applyPreset = (key: string) => {
    const today = new Date();
    const t = ymd(today);
    const daysAgo = (n: number) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
    if (key === '오늘') {
      setFrom(t);
      setTo(t);
    } else if (key === '1주') {
      setFrom(daysAgo(6));
      setTo(t);
    } else if (key === '1개월') {
      setFrom(ymd(new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())));
      setTo(t);
    } else if (key === '3개월') {
      setFrom(ymd(new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())));
      setTo(t);
    } else if (key === '올해') {
      setFrom(`${today.getFullYear()}-01-01`);
      setTo(t);
    } else {
      // 전체
      setFrom('');
      setTo('');
    }
    setPreset(key);
  };

  // 날짜를 손으로 고치면 빠른 버튼 선택 해제
  const onChangeFrom = (v: string) => {
    setFrom(v);
    setPreset(null);
  };
  const onChangeTo = (v: string) => {
    setTo(v);
    setPreset(null);
  };

  const load = useCallback(async () => {
    const [{ data: t }, { data: p }, { data: cf }] = await Promise.all([
      supabase.from('trades').select('*').order('executed_at', { ascending: false }),
      supabase.from('projects').select('*'),
      supabase.from('cash_flows').select('*').order('occurred_at', { ascending: false }),
    ]);
    if (t) setTrades(t as Trade[]);
    setFlows((cf as CashFlow[]) ?? []); // 테이블 없으면 빈 배열
    if (p) {
      const m: Record<string, Project> = {};
      (p as Project[]).forEach((x) => (m[x.id] = x));
      setProjMap(m);
    }
    setLoading(false);
  }, []);

  const deleteFlow = async (cf: CashFlow) => {
    setFlows((prev) => prev.filter((x) => x.id !== cf.id));
    const { error } = await supabase.from('cash_flows').delete().eq('id', cf.id);
    if (error) load();
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const deleteTrade = async (t: Trade) => {
    setTrades((prev) => prev.filter((x) => x.id !== t.id)); // 낙관적 제거
    const { error } = await supabase.from('trades').delete().eq('id', t.id);
    if (error) load(); // 실패 시 되돌리기
  };

  // 검색어가 현금흐름 종류(입금/출금/배당)를 가리키는지
  const flowTypeQuery: CashFlowType | null = useMemo(() => {
    const s = q.trim();
    if (/입금/.test(s)) return 'deposit';
    if (/출금/.test(s)) return 'withdrawal';
    if (/배당/.test(s)) return 'dividend';
    return null;
  }, [q]);

  // 종목/기간/매매구분 필터
  const filteredTrades = useMemo(() => {
    if (flowTypeQuery) return []; // 입금/출금 검색 중엔 체결은 숨김
    const s = q.trim().toLowerCase();
    return trades.filter((t) => {
      if (sideFilter && t.side !== sideFilter) return false;
      if (s) {
        const proj = t.project_id ? projMap[t.project_id] : undefined;
        const hay = `${proj?.name ?? t.name ?? ''} ${proj?.symbol ?? t.symbol ?? ''}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      const d = t.executed_at.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }, [trades, projMap, q, from, to, flowTypeQuery, sideFilter]);

  // 현재 검색 조건(종목/기간)에 해당하는 실현손익 이벤트
  // (평단 계산은 전체 이력 기준, 매도 시점이 기간 안에 들면 포함.
  //  '매수만' 필터 중에는 매도가 안 보이므로 실현수익도 숨긴다)
  const filteredRealized = useMemo(() => {
    if (flowTypeQuery || sideFilter === 'buy') return [];
    const s = q.trim().toLowerCase();
    return realizedEvents(trades).filter((ev) => {
      const d = ev.at.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (s) {
        const proj = ev.trade.project_id ? projMap[ev.trade.project_id] : undefined;
        const hay = `${proj?.name ?? ev.trade.name ?? ''} ${proj?.symbol ?? ev.trade.symbol ?? ''}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [trades, projMap, q, from, to, flowTypeQuery, sideFilter]);

  // 체결의 시장 판별 (통화 표기용)
  const marketOfTrade = useCallback(
    (t: Trade) => (t.project_id ? projMap[t.project_id]?.market : undefined) ?? t.market ?? 'US',
    [projMap]
  );

  // 일자별·시장별 실현수익 (날짜 카드에 표시)
  const realizedByDate = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    filteredRealized.forEach((ev) => {
      const d = ev.at.slice(0, 10);
      const mkt = marketOfTrade(ev.trade);
      (m[d] ??= {})[mkt] = (m[d][mkt] ?? 0) + ev.amount;
    });
    return m;
  }, [filteredRealized, marketOfTrade]);

  // 검색 조건 전체의 합산 실현수익 (시장별)
  const realizedTotals = useMemo(() => {
    const byMarket: Record<string, number> = {};
    filteredRealized.forEach((ev) => {
      const mkt = marketOfTrade(ev.trade);
      byMarket[mkt] = (byMarket[mkt] ?? 0) + ev.amount;
    });
    return { byMarket, count: filteredRealized.length };
  }, [filteredRealized, marketOfTrade]);

  // 기간 내 현금흐름 종류별 합산
  const flowSums = useMemo(() => {
    const m: Record<CashFlowType, number> = { deposit: 0, withdrawal: 0, dividend: 0 };
    flows.forEach((cf) => {
      const d = cf.occurred_at.slice(0, 10);
      if (from && d < from) return;
      if (to && d > to) return;
      m[cf.type] += Number(cf.amount);
    });
    return m;
  }, [flows, from, to]);

  const byDate = useMemo(() => {
    const m: Record<string, Trade[]> = {};
    for (const t of filteredTrades) {
      const d = t.executed_at.slice(0, 10);
      (m[d] ??= []).push(t);
    }
    return m;
  }, [filteredTrades]);

  // 현금흐름: 입금/출금/배당 검색이면 그 종류만, 종목검색 중엔 숨김, 아니면 기간 내 전부
  const flowsByDate = useMemo(() => {
    const m: Record<string, CashFlow[]> = {};
    if (q.trim() && !flowTypeQuery) return m;
    for (const cf of flows) {
      if (flowTypeQuery && cf.type !== flowTypeQuery) continue;
      const d = cf.occurred_at.slice(0, 10);
      if (from && d < from) continue;
      if (to && d > to) continue;
      (m[d] ??= []).push(cf);
    }
    return m;
  }, [flows, q, from, to, flowTypeQuery]);

  const allDates = useMemo(() => {
    const s = new Set([...Object.keys(byDate), ...Object.keys(flowsByDate)]);
    return Array.from(s).sort((a, b) => (a < b ? 1 : -1));
  }, [byDate, flowsByDate]);

  const renderFlow = (cf: CashFlow) => {
    const meta = FLOW_META[cf.type];
    return (
      <Swipeable
        key={cf.id}
        renderLeftActions={() => (
          <Pressable
            onPress={() => confirmAction('삭제', `${meta.label} 기록을 삭제할까요?`, () => deleteFlow(cf), '삭제')}
            style={{ backgroundColor: colors.danger, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '800' }}>삭제</Text>
          </Pressable>
        )}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, backgroundColor: colors.card }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.cardAlt }}>
              <Text style={{ color: meta.color, fontWeight: '800', fontSize: 12 }}>{meta.label}</Text>
            </View>
            <Text style={{ color: colors.textDim, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
              {cf.note ?? '현금'}
            </Text>
          </View>
          <Text style={{ color: meta.color, fontWeight: '700' }}>
            {meta.sign}
            {formatMoney(cf.amount, cf.market)}
          </Text>
        </View>
      </Swipeable>
    );
  };

  const renderTrade = (t: Trade) => {
    const proj = t.project_id ? projMap[t.project_id] : undefined;
    const mkt = proj?.market ?? t.market ?? 'US';
    const displayName = proj?.name ?? t.name ?? t.symbol ?? '—';
    const isBuy = t.side === 'buy';
    // 자동매매 엔진이 기록한 체결은 note 가 '자동주문'으로 시작 (앱/서버 러너 공통)
    const isAutoOrder = !!t.note && t.note.startsWith('자동주문');
    return (
      <Swipeable
        key={t.id}
        renderLeftActions={() => (
          <Pressable
            onPress={() => confirmAction('체결 삭제', `${displayName} ${isBuy ? '매수' : '매도'} 기록을 삭제할까요?`, () => deleteTrade(t), '삭제')}
            style={{ backgroundColor: colors.danger, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '800' }}>삭제</Text>
          </Pressable>
        )}
      >
        <View style={{ paddingVertical: 6, gap: 2, backgroundColor: colors.card }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 6,
                  backgroundColor: isBuy ? colors.buyBg : colors.sellBg,
                }}
              >
                <Text style={{ color: isBuy ? colors.buy : colors.sell, fontWeight: '800', fontSize: 12 }}>
                  {isBuy ? '매수' : '매도'}
                </Text>
              </View>
              {/* 자동주문 / 수동주문 구분 배지 */}
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 6,
                  backgroundColor: isAutoOrder ? 'rgba(91,141,239,0.16)' : colors.cardAlt,
                }}
              >
                <Text style={{ color: isAutoOrder ? colors.accent : colors.textDim, fontWeight: '800', fontSize: 10 }}>
                  {isAutoOrder ? '🤖 자동주문' : '수동주문'}
                </Text>
              </View>
              <Text style={{ color: colors.text, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                {displayName}
                {!t.project_id ? <Text style={{ color: colors.textDim, fontSize: 11 }}>  · 직접입력</Text> : null}
              </Text>
            </View>
            <Text style={{ color: colors.text }}>
              {formatPrice(t.price, mkt)} · {money(t.quantity, 0)}주
            </Text>
          </View>
          {t.note ? (
            <Text style={{ color: colors.textDim, fontSize: 12, marginLeft: 4 }} numberOfLines={2}>
              📝 {t.note}
            </Text>
          ) : null}
        </View>
      </Swipeable>
    );
  };

  const HeaderToggle = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center', paddingRight: spacing.md }}>
            {(['list', 'calendar'] as const).map((v) => (
              <Pressable
                key={v}
                onPress={() => setView(v)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: view === v ? colors.buy : colors.cardAlt,
                }}
              >
                <Text style={{ fontSize: 16 }}>{v === 'list' ? '📋' : '📅'}</Text>
              </Pressable>
            ))}
          </View>
        ),
      }}
    />
  );

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        {HeaderToggle}
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {HeaderToggle}
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 90 }}>

      {/* 검색/필터 바 (내용 카드와 구분되는 어두운 바 서식) */}
      <FilterBar>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
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
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => router.push('/journal-entry')}
            style={{ backgroundColor: colors.buy, borderRadius: 10, paddingHorizontal: 14, height: 36, justifyContent: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '800' }}>＋ 체결 추가</Text>
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, alignItems: 'center' }}>
          {['오늘', '1주', '1개월', '3개월', '올해', '전체'].map((k) => (
            <Chip key={k} label={k} active={preset === k} onPress={() => applyPreset(k)} />
          ))}
          <View style={{ width: 1, height: 22, backgroundColor: colors.border }} />
          <Chip
            label="매수만"
            active={sideFilter === 'buy'}
            onPress={() => setSideFilter(sideFilter === 'buy' ? null : 'buy')}
          />
          <Chip
            label="매도만"
            active={sideFilter === 'sell'}
            onPress={() => setSideFilter(sideFilter === 'sell' ? null : 'sell')}
            activeColor={colors.sell}
          />
        </ScrollView>
      </FilterBar>

      {showSearch && (
        <Card>
          <Field
            label="검색 (종목명/티커, 또는 입금·출금·배당)"
            value={q}
            onChangeText={setQ}
            placeholder="예: 삼성전자, AAPL, 입금"
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Field label="기간 시작" value={from} onChangeText={onChangeFrom} placeholder="YYYY-MM-DD" autoCapitalize="none" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="기간 끝" value={to} onChangeText={onChangeTo} placeholder="YYYY-MM-DD" autoCapitalize="none" />
            </View>
          </View>

          {/* 합산 결과 */}
          <View style={{ backgroundColor: colors.cardAlt, borderRadius: 10, padding: spacing.md, gap: 4 }}>
            {flowTypeQuery ? (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>
                  {FLOW_META[flowTypeQuery].label} 합계 (기간 내)
                </Text>
                <Text style={{ color: FLOW_META[flowTypeQuery].color, fontWeight: '900', fontSize: 16 }}>
                  {formatKRW(flowSums[flowTypeQuery])}
                </Text>
              </View>
            ) : (
              <>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>
                  실현수익 합계는 검색 결과 위의 “💰 실현수익” 카드에 표시됩니다.
                </Text>
                {!q.trim() && (
                  <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: 2, flexWrap: 'wrap' }}>
                    <Text style={{ color: colors.buy, fontSize: 12 }}>입금 {formatKRW(flowSums.deposit)}</Text>
                    <Text style={{ color: colors.sell, fontSize: 12 }}>출금 {formatKRW(flowSums.withdrawal)}</Text>
                    <Text style={{ color: colors.accent, fontSize: 12 }}>배당 {formatKRW(flowSums.dividend)}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </Card>
      )}

      {/* 💰 현재 검색 조건의 합산 실현수익 (항상 표시) */}
      {!flowTypeQuery && sideFilter !== 'buy' && realizedTotals.count > 0 && (
        <Card style={{ borderColor: colors.buy }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.text, fontWeight: '800' }}>
              💰 실현수익 {q.trim() ? `· ${q.trim()}` : '· 전체 종목'}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              {from || '처음'} ~ {to || '오늘'} · 매도 {realizedTotals.count}건
            </Text>
          </View>
          {Object.entries(realizedTotals.byMarket).map(([mkt, v]) => (
            <View key={mkt} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.textDim }}>{mkt === 'KRX' ? '한국 (원화)' : '미국 (달러)'}</Text>
              <Text style={{ color: signColor(v), fontWeight: '900', fontSize: 18 }}>
                {v > 0 ? '+' : ''}
                {formatMoney(v, mkt)}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {trades.length > 0 && Object.keys(byDate).length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>검색 조건에 맞는 체결 기록이 없어요.</Text>
        </Card>
      )}

      {trades.length === 0 && flows.length === 0 && (
        <Card>
          <Text style={{ color: colors.text, fontWeight: '700' }}>아직 기록이 없어요</Text>
          <Text style={{ color: colors.textDim }}>
            프로젝트/직접입력으로 체결을, 우측 아래 ＋ 버튼으로 입금·출금·배당금을 기록하면 날짜별로 쌓입니다.
          </Text>
        </Card>
      )}

      {view === 'list' &&
        allDates.map((d) => (
          <Card key={d}>
            <DayHeader date={d} realized={realizedByDate[d]} />
            {byDate[d]?.map(renderTrade)}
            {flowsByDate[d]?.map(renderFlow)}
          </Card>
        ))}

      {view === 'calendar' && (
        <>
          <Card>
            {/* 월 이동 */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} hitSlop={10}>
                <Text style={{ color: colors.text, fontSize: 20 }}>‹</Text>
              </Pressable>
              <Text style={{ color: colors.text, fontWeight: '800' }}>
                {month.getFullYear()}년 {month.getMonth() + 1}월
              </Text>
              <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} hitSlop={10}>
                <Text style={{ color: colors.text, fontSize: 20 }}>›</Text>
              </Pressable>
            </View>
            {/* 요일 */}
            <View style={{ flexDirection: 'row' }}>
              {WD.map((w, i) => (
                <Text
                  key={w}
                  style={{ flex: 1, textAlign: 'center', color: i === 0 ? colors.buy : colors.textDim, fontSize: 12 }}
                >
                  {w}
                </Text>
              ))}
            </View>
            {/* 날짜 그리드 */}
            <CalendarGrid month={month} byDate={byDate} selected={selected} onSelect={setSelected} />
          </Card>

          <Card>
            <DayHeader date={selected} realized={realizedByDate[selected]} />
            {byDate[selected]?.map(renderTrade)}
            {flowsByDate[selected]?.map(renderFlow)}
            {!byDate[selected]?.length && !flowsByDate[selected]?.length && (
              <Text style={{ color: colors.textDim }}>이 날짜에는 기록이 없어요.</Text>
            )}
          </Card>
        </>
      )}
      </ScrollView>

      {/* 우측 아래 FAB: 입금/출금/배당금 */}
      <Pressable
        onPress={() => router.push('/cash-flow')}
        style={{
          position: 'absolute',
          right: spacing.lg,
          bottom: spacing.lg,
          backgroundColor: colors.accent,
          width: 58,
          height: 58,
          borderRadius: 29,
          alignItems: 'center',
          justifyContent: 'center',
          elevation: 4,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800', marginTop: -2 }}>＋</Text>
      </Pressable>
    </View>
  );
}

// 날짜 카드 헤더: 날짜 + 그날의 실현수익 (시장별)
function DayHeader({ date, realized }: { date: string; realized?: Record<string, number> }) {
  const entries = realized ? Object.entries(realized).filter(([, v]) => v !== 0) : [];
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <Text style={{ color: colors.textDim, fontWeight: '800' }}>{date}</Text>
      {entries.length > 0 && (
        <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
          {entries.map(([mkt, v]) => (
            <View
              key={mkt}
              style={{
                backgroundColor: v >= 0 ? colors.buyBg : colors.sellBg,
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: signColor(v), fontWeight: '900', fontSize: 12 }}>
                실현 {v > 0 ? '+' : ''}
                {formatMoney(v, mkt)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function CalendarGrid({
  month,
  byDate,
  selected,
  onSelect,
}: {
  month: Date;
  byDate: Record<string, Trade[]>;
  selected: string;
  onSelect: (d: string) => void;
}) {
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstWeekday = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row' }}>
          {row.map((d, ci) => {
            if (d == null) return <View key={ci} style={{ flex: 1 }} />;
            const ds = `${year}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayTrades = byDate[ds] ?? [];
            const hasBuy = dayTrades.some((t) => t.side === 'buy');
            const hasSell = dayTrades.some((t) => t.side === 'sell');
            const isSel = ds === selected;
            return (
              <Pressable key={ci} onPress={() => onSelect(ds)} style={{ flex: 1, alignItems: 'center' }}>
                <View
                  style={{
                    width: 34,
                    height: 40,
                    borderRadius: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isSel ? colors.cardAlt : 'transparent',
                    borderWidth: isSel ? 1 : 0,
                    borderColor: colors.buy,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 13 }}>{d}</Text>
                  <View style={{ flexDirection: 'row', gap: 2, marginTop: 2, height: 5 }}>
                    {hasBuy && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.buy }} />}
                    {hasSell && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.sell }} />}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
