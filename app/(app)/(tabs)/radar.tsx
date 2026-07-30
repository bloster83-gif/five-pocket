import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { chooseAction, confirmAction, notify } from '@/lib/alert';
import { Card, Chip, Field, FilterBar } from '@/components/ui';
import { colors, formatChangePct, formatPrice, money, num, radius, rawNumeric, signColor, spacing, withCommas } from '@/theme';
import { searchSymbols } from '@/services/symbols';
import { getUnifiedQuote, loadBrokerAccount } from '@/services/prices/unified';
import { getStoredQuotes } from '@/services/prices/quoteStore';
import { setRadarBelowCount } from '@/lib/badges';
import type { BrokerAccount, Market, SymbolResult, WatchlistGroup, WatchlistItem, WatchlistMemo } from '@/types/db';

type Filter = 'all' | 'KRX' | 'US' | 'under' | 'over';

// #RRGGBB 두 색을 t(0~1)로 섞기 — 기준가 이하 종목 음영(형광펜) 강도 표현용
function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function blendHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  return `rgb(${m(ar, br)},${m(ag, bg)},${m(ab, bb)})`;
}

// 관심종목 레이더 — 기준가를 직접 입력하고, '기준가 대비 %'(= 현재가 ÷ 기준가)로 종목을 감시한다.
export default function RadarScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [memos, setMemos] = useState<WatchlistMemo[]>([]);
  const [prices, setPrices] = useState<Record<string, { price: number; changePct: number | null }>>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null); // 마지막 시세 갱신 시각
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false); // 테이블 없음(마이그레이션 미실행) 감지
  const [filter, setFilter] = useState<Filter>('all');
  const [sortByChange, setSortByChange] = useState(false); // 금일 변동률 높은 순 정렬
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null); // 메모가 열린 종목
  const [addOpen, setAddOpen] = useState(false);
  // 그룹: null=전체, 'none'=미분류, 그 외=그룹 id
  const [groups, setGroups] = useState<WatchlistGroup[]>([]);
  const [groupsReady, setGroupsReady] = useState(true); // 그룹 테이블 존재 여부(마이그레이션 20260728a)
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [groupModal, setGroupModal] = useState<{ mode: 'create' } | { mode: 'rename'; group: WatchlistGroup } | null>(null);

  const load = useCallback(async () => {
    if (!session?.user?.id) return;
    const { data: it, error } = await supabase
      .from('watchlist_items')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      if (/watchlist|does not exist|PGRST205|schema cache|42P01/i.test(`${error.code} ${error.message}`)) {
        setMissing(true);
        setLoading(false);
        return;
      }
    }
    setItems((it as WatchlistItem[]) ?? []);
    const { data: mm } = await supabase.from('watchlist_memos').select('*').order('created_at', { ascending: false });
    setMemos((mm as WatchlistMemo[]) ?? []);
    // 그룹 목록 (테이블 없으면 그룹 UI만 조용히 숨김 — 레이더는 정상 동작)
    const { data: gg, error: gerr } = await supabase
      .from('watchlist_groups')
      .select('*')
      .order('created_at', { ascending: true });
    if (gerr) setGroupsReady(false);
    else {
      setGroupsReady(true);
      setGroups((gg as WatchlistGroup[]) ?? []);
    }
    setLoading(false);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 각 종목 현재가 로드 — 프로젝트 상세와 동일하게 KIS 실시간(국내 KRX+NXT / 미국 주간거래) 우선, 실패 시 Yahoo 폴백.
  // (심볼·시장 목록이 실제로 바뀔 때만 재생성 → 기준가 수정 등에는 불필요한 재조회 안 함)
  const symMktKey = useMemo(() => items.map((i) => `${i.symbol}:${i.market}`).sort().join(','), [items]);
  const symbolMarkets = useMemo(
    () => items.map((i) => ({ symbol: i.symbol, market: i.market })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symMktKey]
  );
  const fetchPrices = useCallback(async () => {
    if (symbolMarkets.length === 0) {
      setPrices({});
      return;
    }
    // 앱 공통 통합 시세 (KIS 우선: 국내 NXT 통합·미국 주간거래 → Yahoo 폴백, 전역 캐시 공유)
    const account = await loadBrokerAccount(session?.user?.id);
    const rows = await Promise.all(
      symbolMarkets.map(async ({ symbol, market }) => {
        try {
          const q = await getUnifiedQuote(account, symbol, market);
          return [symbol, { price: q.price, changePct: q.changePct }] as const;
        } catch {
          return null;
        }
      })
    );
    const m: Record<string, { price: number; changePct: number | null }> = {};
    rows.forEach((r) => {
      if (r) m[r[0]] = r[1];
    });
    setPrices(m);
    setUpdatedAt(Date.now());
  }, [symbolMarkets, session?.user?.id]);

  // 진입 즉시 전역 캐시의 마지막 가격 프리필 (다른 화면과 같은 가격에서 시작)
  useEffect(() => {
    const cached = getStoredQuotes(symbolMarkets.map((s) => s.symbol));
    if (Object.keys(cached).length === 0) return;
    setPrices((m) => {
      const next = { ...m };
      for (const [sym, q] of Object.entries(cached)) if (!next[sym]) next[sym] = { price: q.price, changePct: q.changePct };
      return next;
    });
  }, [symbolMarkets]);

  // 목록이 바뀌면 즉시 1회 시세 갱신
  useEffect(() => {
    void fetchPrices();
  }, [fetchPrices]);

  // 레이더 탭이 보이는 동안 30초마다 실시간 시세 자동 갱신
  useFocusEffect(
    useCallback(() => {
      const id = setInterval(() => void fetchPrices(), 30_000);
      return () => clearInterval(id);
    }, [fetchPrices])
  );

  // 기준가 이하 종목 수를 탭 배지에 반영 (알림은 보내지 않음 — 화면 음영·배지로만 표시)
  useEffect(() => {
    const below = items.filter((it) => {
      const p = prices[it.symbol]?.price;
      return p != null && it.base_price > 0 && p < it.base_price;
    }).length;
    setRadarBelowCount(below);
  }, [prices, items]);

  // 기준가 대비 % (현재가 ÷ 기준가 × 100). 시세 없으면 null.
  const ratioOf = useCallback(
    (it: WatchlistItem) => {
      const p = prices[it.symbol]?.price;
      if (p == null || !it.base_price || it.base_price <= 0) return null;
      return Math.round((p / it.base_price) * 1000) / 10;
    },
    [prices]
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = items.filter((it) => {
      // 그룹 필터 (전체/미분류/특정 그룹)
      if (groupFilter === 'none' && it.group_id != null) return false;
      if (groupFilter && groupFilter !== 'none' && it.group_id !== groupFilter) return false;
      if (s && !`${it.name} ${it.symbol}`.toLowerCase().includes(s)) return false;
      if (filter === 'KRX') return it.market === 'KRX';
      if (filter === 'US') return it.market === 'US';
      if (filter === 'under') {
        const r = ratioOf(it);
        return r != null && r <= 100;
      }
      if (filter === 'over') {
        const r = ratioOf(it);
        return r != null && r >= 100;
      }
      return true;
    });
    if (sortByChange) {
      // 금일 변동률 높은 순 (시세 없는 종목은 뒤로)
      return [...list].sort(
        (a, b) => (prices[b.symbol]?.changePct ?? -Infinity) - (prices[a.symbol]?.changePct ?? -Infinity)
      );
    }
    return list;
  }, [items, q, filter, ratioOf, sortByChange, prices, groupFilter]);

  const memosByItem = useMemo(() => {
    const m: Record<string, WatchlistMemo[]> = {};
    memos.forEach((x) => (m[x.item_id] ??= []).push(x));
    return m;
  }, [memos]);

  const addItem = async (r: SymbolResult, basePrice: number, groupId: string | null = null) => {
    if (!session?.user?.id) return;
    const market: Market = r.market === 'KRX' ? 'KRX' : 'US';
    // 이미 담긴 종목(같은 심볼+시장)이면 중복 추가 방지
    if (items.some((it) => it.symbol === r.symbol && it.market === market)) {
      return notify('이미 추가된 종목', `"${r.name}"은(는) 이미 관심종목에 있어요.`);
    }
    const { error } = await supabase.from('watchlist_items').insert({
      user_id: session.user.id,
      symbol: r.symbol,
      name: r.name,
      market,
      base_price: basePrice,
      // 그룹 선택 시에만 포함 (그룹 마이그레이션 전에도 추가는 정상 동작)
      ...(groupId ? { group_id: groupId } : {}),
    });
    if (error) return notify('추가 실패', error.message);
    await load();
  };

  const deleteItem = async (it: WatchlistItem) => {
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    await supabase.from('watchlist_items').delete().eq('id', it.id);
  };

  const updateBase = async (it: WatchlistItem, base: number) => {
    if (base <= 0) return;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, base_price: base } : x)));
    const { error } = await supabase.from('watchlist_items').update({ base_price: base }).eq('id', it.id);
    if (error) {
      notify('기준가 변경 실패', error.message);
      load();
    }
  };

  const addMemo = async (itemId: string, note: string) => {
    if (!session?.user?.id || !note.trim()) return;
    const { error } = await supabase
      .from('watchlist_memos')
      .insert({ item_id: itemId, user_id: session.user.id, note: note.trim() });
    if (error) return notify('메모 저장 실패', error.message);
    await load();
  };

  const deleteMemo = async (m: WatchlistMemo) => {
    setMemos((prev) => prev.filter((x) => x.id !== m.id));
    await supabase.from('watchlist_memos').delete().eq('id', m.id);
  };

  // ---- 그룹 관리 ----
  const createGroup = async (name: string) => {
    if (!session?.user?.id || !name.trim()) return;
    const { error } = await supabase.from('watchlist_groups').insert({ user_id: session.user.id, name: name.trim() });
    if (error) return notify('그룹 만들기 실패', error.message);
    await load();
  };

  const renameGroup = async (g: WatchlistGroup, name: string) => {
    if (!name.trim()) return;
    setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, name: name.trim() } : x)));
    const { error } = await supabase.from('watchlist_groups').update({ name: name.trim() }).eq('id', g.id);
    if (error) {
      notify('이름 변경 실패', error.message);
      load();
    }
  };

  const deleteGroup = (g: WatchlistGroup) => {
    confirmAction('그룹 삭제', `"${g.name}" 그룹을 삭제할까요? 소속 종목은 삭제되지 않고 '미분류'로 이동해요.`, async () => {
      setGroups((prev) => prev.filter((x) => x.id !== g.id));
      setItems((prev) => prev.map((x) => (x.group_id === g.id ? { ...x, group_id: null } : x)));
      if (groupFilter === g.id) setGroupFilter(null);
      await supabase.from('watchlist_groups').delete().eq('id', g.id);
    }, '삭제');
  };

  // 그룹 칩 길게 누르면 이름 변경/삭제 메뉴
  const groupMenu = (g: WatchlistGroup) => {
    chooseAction(`📂 ${g.name}`, '그룹을 어떻게 할까요?', [
      { text: '이름 변경', onPress: () => setGroupModal({ mode: 'rename', group: g }) },
      { text: '삭제', style: 'destructive', onPress: () => deleteGroup(g) },
      { text: '취소', style: 'cancel' },
    ]);
  };

  // 종목의 소속 그룹 변경 (null = 미분류)
  const setItemGroup = async (it: WatchlistItem, groupId: string | null) => {
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, group_id: groupId } : x)));
    const { error } = await supabase.from('watchlist_items').update({ group_id: groupId }).eq('id', it.id);
    if (error) {
      notify('그룹 지정 실패', /group_id|column/i.test(error.message) ? '그룹 마이그레이션(20260728a)을 먼저 실행해 주세요.' : error.message);
      load();
    }
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
      {/* 틀고정: 제목 + 검색/필터 바 */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm }}>
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, alignItems: 'center' }}>
            <Chip label="전체" active={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label="한국" icon="🇰🇷" active={filter === 'KRX'} onPress={() => setFilter('KRX')} />
            <Chip label="미국" icon="🇺🇸" active={filter === 'US'} onPress={() => setFilter('US')} activeColor={colors.accent} />
            <View style={{ width: 1, height: 22, backgroundColor: colors.border }} />
            <Chip label="기준가 이하 (100%↓)" active={filter === 'under'} onPress={() => setFilter('under')} activeColor={colors.sell} />
            <Chip label="기준가 이상 (100%↑)" active={filter === 'over'} onPress={() => setFilter('over')} />
            <View style={{ width: 1, height: 22, backgroundColor: colors.border }} />
            <Chip label="변동률순 📈" active={sortByChange} onPress={() => setSortByChange((v) => !v)} activeColor={colors.warn} />
          </ScrollView>
        </FilterBar>
        {/* 그룹 칩 — 만들기(＋그룹), 필터, 길게 눌러 이름변경/삭제 */}
        {!missing && groupsReady && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, alignItems: 'center' }}>
            <Chip label="📂 전체" active={groupFilter === null} onPress={() => setGroupFilter(null)} />
            {groups.map((g) => (
              // 그룹 칩을 길게 누르면 이름변경/삭제 메뉴
              <Chip
                key={g.id}
                label={g.name}
                active={groupFilter === g.id}
                onPress={() => setGroupFilter((f) => (f === g.id ? null : g.id))}
                onLongPress={() => groupMenu(g)}
                activeColor={colors.accent}
              />
            ))}
            {groups.length > 0 && (
              <Chip label="미분류" active={groupFilter === 'none'} onPress={() => setGroupFilter((f) => (f === 'none' ? null : 'none'))} />
            )}
            <Pressable
              onPress={() => setGroupModal({ mode: 'create' })}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: colors.primary,
                backgroundColor: 'rgba(34,211,166,0.10)',
              }}
            >
              <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>＋ 그룹</Text>
            </Pressable>
          </ScrollView>
        )}
        {showSearch && (
          <Field label="" value={q} onChangeText={setQ} placeholder="종목명/티커 검색" autoCapitalize="none" />
        )}
        {!missing && items.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.buy }} />
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              실시간 · 30초 간격 자동 갱신{updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString()}` : ''}
            </Text>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
      >
        {missing && (
          <Card style={{ borderColor: colors.warn }}>
            <Text style={{ color: colors.warn, fontWeight: '800' }}>DB 준비 필요</Text>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>
              관심종목 레이더 테이블이 아직 없어요. Supabase에서 마이그레이션(20260722a_watchlist)을 실행하면 사용할 수 있어요.
            </Text>
          </Card>
        )}

        {!missing && items.length === 0 && (
          <Card>
            <Text style={{ color: colors.text, fontWeight: '700' }}>관심종목이 없어요</Text>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>
              오른쪽 아래 + 버튼으로 종목을 추가하고 기준가를 입력하면, 현재가와 기준가 대비(%)를 한눈에 볼 수 있어요.
            </Text>
          </Card>
        )}

        {filtered.map((it) => (
          <WatchRow
            key={it.id}
            item={it}
            price={prices[it.symbol]?.price ?? null}
            changePct={prices[it.symbol]?.changePct ?? null}
            ratio={ratioOf(it)}
            memos={memosByItem[it.id] ?? []}
            groups={groupsReady ? groups : []}
            onSetGroup={(gid) => setItemGroup(it, gid)}
            open={expanded === it.id}
            onToggle={() => setExpanded((e) => (e === it.id ? null : it.id))}
            onAddMemo={(note) => addMemo(it.id, note)}
            onDeleteMemo={deleteMemo}
            onUpdateBase={(base) => updateBase(it, base)}
            onDelete={() =>
              confirmAction('관심종목 삭제', `"${it.name}"을(를) 관심종목에서 삭제할까요? 메모도 함께 삭제됩니다.`, () => deleteItem(it), '삭제')
            }
            onCreateProject={() =>
              router.push(
                `/project/new?symbol=${encodeURIComponent(it.symbol)}&name=${encodeURIComponent(it.name)}&market=${it.market}&base=${it.base_price}`
              )
            }
            onDetail={() =>
              router.push(
                `/stock/${encodeURIComponent(it.symbol)}?market=${it.market}&name=${encodeURIComponent(it.name)}`
              )
            }
          />
        ))}

        {!missing && items.length > 0 && filtered.length === 0 && (
          <Card>
            <Text style={{ color: colors.textDim }}>필터/검색 조건에 맞는 종목이 없어요.</Text>
          </Card>
        )}

        {!missing && items.length > 0 && (
          <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>
            💡 기준가 대비 = 현재가 ÷ 기준가 · 기준가 이하로 내려가면 파란 음영(많이 떨어질수록 진하게) + 탭 배지 · 탭하면 메모 · 오른쪽으로 밀면 프로젝트 생성 · 왼쪽으로 밀면 삭제.
          </Text>
        )}
      </ScrollView>

      {/* 우측 아래 + 버튼 — 종목 추가 */}
      {!missing && (
        <Pressable
          onPress={() => setAddOpen(true)}
          style={{
            position: 'absolute',
            right: spacing.lg,
            bottom: spacing.lg,
            backgroundColor: colors.buy,
            width: 58,
            height: 58,
            borderRadius: 29,
            alignItems: 'center',
            justifyContent: 'center',
            elevation: 5,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800', marginTop: -2 }}>＋</Text>
        </Pressable>
      )}

      <AddModal
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        groups={groupsReady ? groups : []}
        // 특정 그룹을 필터 중이면 그 그룹이 기본 선택되게
        defaultGroupId={groupFilter && groupFilter !== 'none' ? groupFilter : null}
        onAdd={async (r, base, gid) => {
          setAddOpen(false);
          await addItem(r, base, gid);
        }}
      />

      {/* 그룹 만들기/이름 변경 모달 */}
      <GroupNameModal
        state={groupModal}
        onClose={() => setGroupModal(null)}
        onSubmit={async (name) => {
          const m = groupModal;
          setGroupModal(null);
          if (!m) return;
          if (m.mode === 'create') await createGroup(name);
          else await renameGroup(m.group, name);
        }}
      />
    </View>
  );
}

// 그룹 만들기/이름 변경 모달 — 이름 하나만 입력
function GroupNameModal({
  state,
  onClose,
  onSubmit,
}: {
  state: { mode: 'create' } | { mode: 'rename'; group: WatchlistGroup } | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (state) setName(state.mode === 'rename' ? state.group.name : '');
  }, [state]);
  if (!state) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg }}>
          <Pressable
            onPress={() => {}}
            style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.border }}
          >
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 17 }}>
              {state.mode === 'create' ? '📂 새 그룹 만들기' : `📂 그룹 이름 변경`}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="그룹 이름 (예: 반도체, 배당주, 미국 빅테크)"
              placeholderTextColor={colors.textDim}
              autoFocus
              style={{
                backgroundColor: colors.cardAlt,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: 12,
                color: colors.text,
                fontSize: 16,
                fontWeight: '700',
                borderWidth: 1,
                borderColor: colors.border,
              }}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}>
                <Text style={{ color: colors.textDim, fontWeight: '800' }}>취소</Text>
              </Pressable>
              <Pressable
                onPress={() => name.trim() && onSubmit(name)}
                disabled={!name.trim()}
                style={{ flex: 2, backgroundColor: name.trim() ? colors.primary : colors.border, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
              >
                <Text style={{ color: '#04121A', fontWeight: '900' }}>{state.mode === 'create' ? '만들기' : '변경'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// 관심종목 한 줄 — 왼쪽 스와이프 삭제, 탭하면 메모 열림
function WatchRow({
  item,
  price,
  changePct,
  ratio,
  memos,
  groups,
  onSetGroup,
  open,
  onToggle,
  onAddMemo,
  onDeleteMemo,
  onUpdateBase,
  onDelete,
  onCreateProject,
  onDetail,
}: {
  item: WatchlistItem;
  price: number | null;
  changePct: number | null;
  ratio: number | null;
  memos: WatchlistMemo[];
  groups: WatchlistGroup[];
  onSetGroup: (groupId: string | null) => void;
  open: boolean;
  onToggle: () => void;
  onAddMemo: (note: string) => void;
  onDeleteMemo: (m: WatchlistMemo) => void;
  onUpdateBase: (base: number) => void;
  onDelete: () => void;
  onCreateProject: () => void;
  onDetail: () => void;
}) {
  const [note, setNote] = useState('');
  const mkt = item.market;
  const isKr = mkt === 'KRX';
  const [baseRaw, setBaseRaw] = useState(String(item.base_price));
  // 다른 곳에서 기준가가 바뀌면 편집값도 동기화
  useEffect(() => {
    setBaseRaw(String(item.base_price));
  }, [item.base_price]);
  // 기준가 대비: 100% 이상=현재가가 기준가 위(빨강), 미만=아래(파랑)
  const ratioColor = ratio == null ? colors.textDim : ratio >= 100 ? colors.buy : colors.sell;
  // 형광펜 음영: 기준가 이하로 내려갈수록(=ratio가 100 미만으로 낮을수록) 파란 음영이 진해짐
  const drop = ratio != null && ratio < 100 ? 100 - ratio : 0; // 기준가 대비 몇 % 아래인지
  const shadeBg = drop > 0 ? blendHex(colors.card, colors.sell, Math.min(drop / 25, 1) * 0.55) : undefined;
  const swipeRef = useRef<Swipeable>(null);
  return (
    <Swipeable
      ref={swipeRef}
      // 오른쪽으로 스와이프(=왼쪽 액션) → 이 종목으로 프로젝트 생성
      renderLeftActions={() => (
        <Pressable
          onPress={() => {
            swipeRef.current?.close();
            onCreateProject();
          }}
          style={{ backgroundColor: colors.buy, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, borderRadius: radius.md, marginRight: spacing.sm, width: 130 }}
        >
          <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>＋ 프로젝트 생성</Text>
        </Pressable>
      )}
      renderRightActions={() => (
        <Pressable
          onPress={onDelete}
          style={{ backgroundColor: colors.danger, justifyContent: 'center', paddingHorizontal: 20, borderRadius: radius.md, marginLeft: spacing.sm }}
        >
          <Text style={{ color: '#fff', fontWeight: '800' }}>삭제</Text>
        </Pressable>
      )}
      onSwipeableOpen={(dir) => {
        if (dir === 'left') {
          swipeRef.current?.close();
          onCreateProject();
        }
      }}
    >
      <Card
        style={{
          borderLeftWidth: 5,
          borderLeftColor: mkt === 'KRX' ? colors.text : colors.accent,
          paddingVertical: spacing.sm,
          gap: 2,
          ...(shadeBg ? { backgroundColor: shadeBg, borderColor: colors.sell } : null),
        }}
      >
        <Pressable onPress={onToggle}>
          {/* 1줄: 국기 + 종목명 + 기준가 대비 % */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
              <Text style={{ fontSize: 14 }}>{mkt === 'KRX' ? '🇰🇷' : '🇺🇸'}</Text>
              <Text style={{ color: colors.text, fontWeight: '800', flex: 1 }} numberOfLines={1}>
                {item.name}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: colors.textDim, fontSize: 10 }}>기준가 대비</Text>
              <Text style={{ color: ratioColor, fontWeight: '900', fontSize: 16 }}>{ratio != null ? `${ratio}%` : '—'}</Text>
            </View>
          </View>
          {/* 2줄: 현재가 · 기준가 (금액이 길어도 줄바꿈 없이 한 줄 — 폰트 자동 축소) + 오른쪽 고정 메모 표시 */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: spacing.md, flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>현재가</Text>
                <Text
                  style={{ color: num.live, fontWeight: '800', fontSize: 13, flexShrink: 1 }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {price != null ? formatPrice(price, mkt) : '—'}
                </Text>
                {/* 금일 변동률 (전일 종가 대비) */}
                {changePct != null && (
                  <Text style={{ color: signColor(changePct), fontSize: 11, fontWeight: '800' }} numberOfLines={1}>
                    {changePct > 0 ? '▲' : changePct < 0 ? '▼' : ''}
                    {changePct > 0 ? '+' : ''}
                    {formatChangePct(changePct)}%
                  </Text>
                )}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0 }}>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>기준가</Text>
                <Text
                  style={{ color: num.base, fontWeight: '800', fontSize: 13, flexShrink: 1 }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {formatPrice(item.base_price, mkt)}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <Text style={{ fontSize: 12 }}>📝</Text>
              {/* 메모가 1개 이상이면 개수를 색깔 동그라미로 강조 */}
              {memos.length > 0 ? (
                <View
                  style={{
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    paddingHorizontal: 5,
                    backgroundColor: colors.primary,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#04121A', fontSize: 11, fontWeight: '900' }}>{memos.length}</Text>
                </View>
              ) : (
                <Text style={{ color: colors.textDim, fontSize: 11 }}>0</Text>
              )}
              <Text style={{ color: colors.textDim, fontSize: 11 }}>{open ? '▲' : '▼'}</Text>
            </View>
          </View>
        </Pressable>

        {/* 탭하면 열림 — 자세히 보기(가치분석) + 기준가 수정 + 메모 */}
        {open && (
          <View style={{ marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm }}>
            {/* 가치분석 자세히 보기 */}
            <Pressable
              onPress={onDetail}
              style={{
                backgroundColor: colors.primary,
                borderRadius: radius.md,
                paddingVertical: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#04121A', fontWeight: '900', fontSize: 13 }}>📊 자세히 보기 (가치분석)</Text>
            </Pressable>
            {/* 그룹 지정 — 그룹이 있을 때만 표시 */}
            {groups.length > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text style={{ color: colors.textDim, fontSize: 12, width: 52 }}>그룹</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
                  <Pressable
                    onPress={() => onSetGroup(null)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 999,
                      backgroundColor: item.group_id == null ? colors.textDim : colors.cardAlt,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ color: item.group_id == null ? colors.bg : colors.textDim, fontSize: 11, fontWeight: '800' }}>미분류</Text>
                  </Pressable>
                  {groups.map((g) => {
                    const on = item.group_id === g.id;
                    return (
                      <Pressable
                        key={g.id}
                        onPress={() => onSetGroup(on ? null : g.id)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: 999,
                          backgroundColor: on ? colors.accent : colors.cardAlt,
                          borderWidth: 1,
                          borderColor: on ? colors.accent : colors.border,
                        }}
                      >
                        <Text style={{ color: on ? '#fff' : colors.textDim, fontSize: 11, fontWeight: '800' }}>{g.name}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            )}
            {/* 기준가 변경 */}
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
              <Text style={{ color: colors.textDim, fontSize: 12, width: 52 }}>기준가</Text>
              <TextInput
                value={withCommas(baseRaw, !isKr)}
                onChangeText={(t) => setBaseRaw(rawNumeric(t, !isKr))}
                keyboardType="decimal-pad"
                placeholder="기준가 입력"
                placeholderTextColor={colors.textDim}
                style={{
                  flex: 1,
                  backgroundColor: colors.cardAlt,
                  borderRadius: radius.md,
                  paddingHorizontal: spacing.md,
                  paddingVertical: 8,
                  color: num.base,
                  fontSize: 15,
                  fontWeight: '900',
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              />
              <Pressable
                onPress={() => {
                  const b = Number(rawNumeric(baseRaw, !isKr)) || 0;
                  if (b > 0) onUpdateBase(b);
                }}
                style={{ backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 9 }}
              >
                <Text style={{ color: '#04121A', fontWeight: '800' }}>변경</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="메모 입력 (매수 이유, 관찰 포인트 등)"
                  placeholderTextColor={colors.textDim}
                  multiline
                  style={{
                    backgroundColor: colors.cardAlt,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 10,
                    color: colors.text,
                    borderWidth: 1,
                    borderColor: colors.border,
                    minHeight: 40,
                  }}
                />
              </View>
              <Pressable
                onPress={() => {
                  if (!note.trim()) return;
                  onAddMemo(note);
                  setNote('');
                }}
                style={{ backgroundColor: colors.buy, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 11 }}
              >
                <Text style={{ color: '#fff', fontWeight: '800' }}>저장</Text>
              </Pressable>
            </View>
            {memos.length === 0 ? (
              <Text style={{ color: colors.textDim, fontSize: 12 }}>아직 메모가 없어요. 위에 입력하면 날짜와 함께 기록됩니다.</Text>
            ) : (
              memos.map((m) => (
                <View key={m.id} style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.sm, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>{m.created_at.replace('T', ' ').slice(0, 16)}</Text>
                    <Pressable onPress={() => onDeleteMemo(m)} hitSlop={8}>
                      <Text style={{ color: colors.danger, fontSize: 11, fontWeight: '800' }}>삭제</Text>
                    </Pressable>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{m.note}</Text>
                </View>
              ))
            )}
          </View>
        )}
      </Card>
    </Swipeable>
  );
}

// 종목 추가 모달 — 심볼 검색 → 선택 → 기준가 입력 (+그룹 지정)
function AddModal({
  visible,
  onClose,
  groups,
  defaultGroupId,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  groups: WatchlistGroup[];
  defaultGroupId: string | null;
  onAdd: (r: SymbolResult, base: number, groupId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SymbolResult | null>(null);
  const [baseRaw, setBaseRaw] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);

  // 모달 열릴 때 — 그룹 필터 중이면 그 그룹을 기본 선택
  useEffect(() => {
    if (visible) setGroupId(defaultGroupId);
  }, [visible, defaultGroupId]);

  useEffect(() => {
    if (!visible) return;
    if (selected) return;
    const s = query.trim();
    if (s.length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchSymbols(s));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, selected, visible]);

  const reset = () => {
    setQuery('');
    setResults([]);
    setSelected(null);
    setBaseRaw('');
    setGroupId(defaultGroupId);
  };
  const close = () => {
    reset();
    onClose();
  };
  const pick = async (r: SymbolResult) => {
    setSelected(r);
    setQuery(r.name);
    setResults([]);
    try {
      // KIS 우선(NXT·주간거래 반영) → Yahoo 폴백
      const account = await loadBrokerAccount();
      const q = await getUnifiedQuote(account, r.symbol, r.market);
      setBaseRaw(String(r.market === 'KRX' ? Math.round(q.price) : q.price));
    } catch {
      /* 웹 CORS 등: 직접 입력 */
    }
  };

  if (!visible) return null;
  const mkt: Market = selected?.market === 'KRX' ? 'KRX' : 'US';
  const isKr = mkt === 'KRX';
  const base = Number(rawNumeric(baseRaw, !isKr)) || 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <Pressable onPress={close} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: spacing.lg }}>
        <Pressable
          onPress={() => {}}
          style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.border, maxHeight: '85%' }}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }} showsVerticalScrollIndicator={false}>
          <Text style={{ color: colors.text, fontWeight: '900', fontSize: 18 }}>관심종목 추가</Text>

          <Field
            label="종목 검색 (한글명·티커)"
            value={query}
            onChangeText={(t) => {
              setQuery(t);
              if (selected) setSelected(null);
            }}
            placeholder="예: 삼성전자, AAPL"
            autoCapitalize="none"
          />

          {searching && <ActivityIndicator color={colors.textDim} />}

          {!selected && results.length > 0 && (
            <View>
              {results.map((r) => (
                <Pressable
                  key={`${r.symbol}-${r.exchange}`}
                  onPress={() => pick(r)}
                  style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                  <Text style={{ fontSize: 14 }}>{r.market === 'KRX' ? '🇰🇷' : '🇺🇸'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 12 }}>
                      {r.symbol} · {r.exchange}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {selected && (
            <View style={{ gap: spacing.sm }}>
              <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 16 }}>{isKr ? '🇰🇷' : '🇺🇸'}</Text>
                <Text style={{ color: colors.text, fontWeight: '800', flex: 1 }} numberOfLines={1}>
                  {selected.name} <Text style={{ color: colors.textDim, fontSize: 12 }}>({selected.symbol})</Text>
                </Text>
                <Pressable onPress={reset} hitSlop={8}>
                  <Text style={{ color: colors.textDim, fontSize: 12 }}>변경</Text>
                </Pressable>
              </View>
              <View>
                <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 4 }}>기준가 ({isKr ? '₩' : '$'}) — 직접 입력</Text>
                <TextInput
                  value={withCommas(baseRaw, !isKr)}
                  onChangeText={(t) => setBaseRaw(rawNumeric(t, !isKr))}
                  keyboardType="decimal-pad"
                  placeholder="기준가 입력"
                  placeholderTextColor={colors.textDim}
                  style={{
                    backgroundColor: colors.cardAlt,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 12,
                    color: num.base,
                    fontSize: 20,
                    fontWeight: '900',
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                />
              </View>

              {/* 그룹 지정 (선택) — 그룹이 있을 때만 */}
              {groups.length > 0 && (
                <View>
                  <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 4 }}>그룹 (선택)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
                    <Pressable
                      onPress={() => setGroupId(null)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                        borderRadius: 999,
                        backgroundColor: groupId == null ? colors.textDim : colors.cardAlt,
                        borderWidth: 1,
                        borderColor: colors.border,
                      }}
                    >
                      <Text style={{ color: groupId == null ? colors.bg : colors.textDim, fontSize: 12, fontWeight: '800' }}>미분류</Text>
                    </Pressable>
                    {groups.map((g) => {
                      const on = groupId === g.id;
                      return (
                        <Pressable
                          key={g.id}
                          onPress={() => setGroupId(on ? null : g.id)}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                            borderRadius: 999,
                            backgroundColor: on ? colors.accent : colors.cardAlt,
                            borderWidth: 1,
                            borderColor: on ? colors.accent : colors.border,
                          }}
                        >
                          <Text style={{ color: on ? '#fff' : colors.textDim, fontSize: 12, fontWeight: '800' }}>{g.name}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
            </View>
          )}

          </ScrollView>

          {/* 버튼은 스크롤 밖에 고정 — 키보드가 올라와도 항상 보임 */}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
            <Pressable onPress={close} style={{ flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: colors.textDim, fontWeight: '800' }}>취소</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!selected || base <= 0) return;
                onAdd(selected, base, groupId);
                reset();
              }}
              disabled={!selected || base <= 0}
              style={{ flex: 2, backgroundColor: selected && base > 0 ? colors.buy : colors.border, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>추가</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
