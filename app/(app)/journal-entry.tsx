import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, spacing } from '@/theme';
import { searchSymbols } from '@/services/symbols';
import type { SymbolResult, TradeSide } from '@/types/db';

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export default function JournalEntryScreen() {
  const router = useRouter();
  const { session } = useAuth();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SymbolResult | null>(null);

  const [side, setSide] = useState<TradeSide>('buy');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selected && query === selected.name) return;
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchSymbols(q));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, selected]);

  const onSubmit = async () => {
    if (!selected) return notify('종목 선택', '종목을 검색해서 선택하세요.');
    const priceN = Number(price);
    const qtyN = Number(qty);
    if (!priceN || priceN <= 0) return notify('입력 필요', '체결가를 입력하세요.');
    if (!qtyN || qtyN <= 0) return notify('입력 필요', '수량을 입력하세요.');
    const executed = new Date(`${date}T12:00:00`);
    if (isNaN(executed.getTime())) return notify('날짜 오류', 'YYYY-MM-DD 형식으로 입력하세요.');
    if (!session?.user?.id) return;

    setSaving(true);
    const { error } = await supabase.from('trades').insert({
      user_id: session.user.id,
      project_id: null,
      pocket_id: null,
      symbol: selected.symbol,
      name: selected.name,
      market: selected.market,
      side,
      price: priceN,
      quantity: qtyN,
      executed_at: executed.toISOString(),
      note: note.trim() || null,
    });
    setSaving(false);
    if (error) {
      if (/null value|not-null|violates|column .* does not exist|schema cache|PGRST/i.test(`${error.code} ${error.message}`)) {
        return notify('DB 준비 필요', '독립 체결 입력에 필요한 마이그레이션(20260716c)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('저장 실패', error.message);
    }
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
      <Card>
        <Field
          label="종목 검색 (이름/티커)"
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (selected) setSelected(null);
          }}
          placeholder="예: 삼성전자, AAPL"
          autoCapitalize="none"
        />
        {searching && <ActivityIndicator color={colors.buy} />}
        {results.length > 0 && (
          <View style={{ gap: 1, backgroundColor: colors.border, borderRadius: 8, overflow: 'hidden' }}>
            {results.map((r) => (
              <Pressable
                key={r.symbol}
                onPress={() => {
                  setSelected(r);
                  setQuery(r.name);
                  setResults([]);
                }}
                style={{ backgroundColor: colors.cardAlt, padding: spacing.md }}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>{r.name}</Text>
                <Text style={{ color: colors.textDim, fontSize: 12 }}>
                  {r.symbol} · {r.market === 'KRX' ? '한국' : '미국/기타'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {selected && (
          <Text style={{ color: colors.buy, fontWeight: '800' }}>✓ {selected.symbol} 선택됨</Text>
        )}
      </Card>

      <Card>
        <Text style={{ color: colors.textDim }}>매매 구분</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          {(['buy', 'sell'] as TradeSide[]).map((s) => {
            const on = side === s;
            const c = s === 'buy' ? colors.buy : colors.sell;
            return (
              <Pressable
                key={s}
                onPress={() => setSide(s)}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: on ? c : colors.cardAlt }}
              >
                <Text style={{ color: on ? '#fff' : colors.text, fontWeight: '800', fontSize: 16 }}>
                  {s === 'buy' ? '매수' : '매도'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <NumberField label="체결가" value={price} onChangeText={setPrice} decimals placeholder="체결 가격" />
        <NumberField label="수량 (주)" value={qty} onChangeText={setQty} decimals placeholder="예: 10" />
        <Field label="체결 날짜" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
        <Field label="메모(선택)" value={note} onChangeText={setNote} placeholder="예: 배당 재투자" />
      </Card>

      <Button
        title="체결 기록 저장"
        variant={side === 'buy' ? 'buy' : 'sell'}
        large
        onPress={onSubmit}
        loading={saving}
      />
    </ScrollView>
  );
}
