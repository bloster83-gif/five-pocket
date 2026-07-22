import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { confirmAction, notify } from '@/lib/alert';
import { Card, Chip, Field, FilterBar } from '@/components/ui';
import { colors, formatPrice, money, num, radius, rawNumeric, signColor, spacing, withCommas } from '@/theme';
import { searchSymbols } from '@/services/symbols';
import { priceProvider } from '@/services/prices';
import { setRadarBelowCount } from '@/lib/badges';
import type { Market, SymbolResult, WatchlistItem, WatchlistMemo } from '@/types/db';

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
  const [showSearch, setShowSearch] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null); // 메모가 열린 종목
  const [addOpen, setAddOpen] = useState(false);

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
    setLoading(false);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 각 종목 현재가 로드
  const symbolsKey = useMemo(() => items.map((i) => i.symbol).sort().join(','), [items]);
  const fetchPrices = useCallback(async () => {
    const syms = symbolsKey ? symbolsKey.split(',') : [];
    if (syms.length === 0) {
      setPrices({});
      return;
    }
    const rows = await Promise.all(
      syms.map((s) =>
        priceProvider
          .getQuote(s)
          .then((qq) => {
            const changePct =
              qq.previousClose && qq.previousClose > 0
                ? Math.round(((qq.price - qq.previousClose) / qq.previousClose) * 10000) / 100
                : null;
            return [s, { price: qq.price, changePct }] as const;
          })
          .catch(() => null)
      )
    );
    const m: Record<string, { price: number; changePct: number | null }> = {};
    rows.forEach((r) => {
      if (r) m[r[0]] = r[1];
    });
    setPrices(m);
    setUpdatedAt(Date.now());
  }, [symbolsKey]);

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
    return items.filter((it) => {
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
  }, [items, q, filter, ratioOf]);

  const memosByItem = useMemo(() => {
    const m: Record<string, WatchlistMemo[]> = {};
    memos.forEach((x) => (m[x.item_id] ??= []).push(x));
    return m;
  }, [memos]);

  const addItem = async (r: SymbolResult, basePrice: number) => {
    if (!session?.user?.id) return;
    const market: Market = r.market === 'KRX' ? 'KRX' : 'US';
    const { error } = await supabase.from('watchlist_items').insert({
      user_id: session.user.id,
      symbol: r.symbol,
      name: r.name,
      market,
      base_price: basePrice,
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
          </ScrollView>
        </FilterBar>
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
        onAdd={async (r, base) => {
          setAddOpen(false);
          await addItem(r, base);
        }}
      />
    </View>
  );
}

// 관심종목 한 줄 — 왼쪽 스와이프 삭제, 탭하면 메모 열림
function WatchRow({
  item,
  price,
  changePct,
  ratio,
  memos,
  open,
  onToggle,
  onAddMemo,
  onDeleteMemo,
  onUpdateBase,
  onDelete,
  onCreateProject,
}: {
  item: WatchlistItem;
  price: number | null;
  changePct: number | null;
  ratio: number | null;
  memos: WatchlistMemo[];
  open: boolean;
  onToggle: () => void;
  onAddMemo: (note: string) => void;
  onDeleteMemo: (m: WatchlistMemo) => void;
  onUpdateBase: (base: number) => void;
  onDelete: () => void;
  onCreateProject: () => void;
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
          {/* 2줄: 현재가 · 기준가 */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>현재가</Text>
              <Text style={{ color: num.live, fontWeight: '800', fontSize: 13 }}>{price != null ? formatPrice(price, mkt) : '—'}</Text>
              {/* 금일 변동률 (전일 종가 대비) */}
              {changePct != null && (
                <Text style={{ color: signColor(changePct), fontSize: 11, fontWeight: '800' }}>
                  {changePct > 0 ? '▲' : changePct < 0 ? '▼' : ''}
                  {changePct > 0 ? '+' : ''}
                  {changePct}%
                </Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ color: colors.textDim, fontSize: 11 }}>기준가</Text>
              <Text style={{ color: num.base, fontWeight: '800', fontSize: 13 }}>{formatPrice(item.base_price, mkt)}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
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

        {/* 탭하면 열림 — 기준가 수정 + 메모 */}
        {open && (
          <View style={{ marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm }}>
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

// 종목 추가 모달 — 심볼 검색 → 선택 → 기준가 입력
function AddModal({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (r: SymbolResult, base: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SymbolResult | null>(null);
  const [baseRaw, setBaseRaw] = useState('');

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
      const q = await priceProvider.getQuote(r.symbol);
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
                onAdd(selected, base);
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
