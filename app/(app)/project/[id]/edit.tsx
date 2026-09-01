import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { notify } from '@/lib/alert';
import { Button, Card, Field, NumberField } from '@/components/ui';
import { colors, formatPrice, money, spacing } from '@/theme';
import { buildPocketSeeds, estimatedShares, normalizeWeights, POCKET_COUNT } from '@/domain/pockets';
import type { Pocket, Project } from '@/types/db';
import { BackHeader } from '@/components/BackHeader';
import { WeightInput } from '@/components/WeightInput';
import { useAllocMode } from '@/lib/allocMode';

// 프로젝트 수정 — 종목/시장/이름은 고정(이름=종목명).
//  - 거래가 하나도 없으면: 전략·예산·포켓비중 수정 가능
//  - 거래가 한 건이라도 있으면: 전략이 꼬이므로 수정 불가 (읽기 전용)
export default function EditProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [tradeCount, setTradeCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [basePrice, setBasePrice] = useState('');
  const [buyInterval, setBuyInterval] = useState('5');
  const [sellTarget, setSellTarget] = useState('10');
  const [totalBudget, setTotalBudget] = useState('');
  const [weights, setWeights] = useState<string[]>(Array(POCKET_COUNT).fill('20'));

  const load = useCallback(async () => {
    if (!id) return;
    const [{ data: p }, { data: k }, { count }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('pockets').select('*').eq('project_id', id).order('idx'),
      supabase.from('trades').select('id', { count: 'exact', head: true }).eq('project_id', id),
    ]);
    setTradeCount(count ?? 0);
    if (p) {
      const proj = p as Project;
      setProject(proj);
      setBasePrice(String(proj.base_price));
      setBuyInterval(String(proj.buy_interval_pct));
      setSellTarget(String(proj.sell_target_pct));
      setTotalBudget(proj.total_budget != null ? String(proj.total_budget) : '');
    }
    if (k) {
      const ks = [...(k as Pocket[])].sort((a, b) => a.idx - b.idx);
      setPockets(ks);
      if (ks.length > 0) setWeights(ks.map((x) => String(x.weight)));
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const market = project?.market ?? 'US';
  const parsed = {
    basePrice: Number(basePrice),
    buyIntervalPct: Number(buyInterval),
    sellTargetPct: Number(sellTarget),
    totalBudget: totalBudget ? Number(totalBudget) : null,
    weights: weights.map((w) => Number(w) || 0),
    pocketCount: pockets.length || project?.pocket_count || POCKET_COUNT,
    market,
  };
  const normalized = useMemo(() => normalizeWeights(parsed.weights), [weights]); // eslint-disable-line react-hooks/exhaustive-deps
  const weightSum = parsed.weights.reduce((a, b) => a + b, 0);
  const seeds = useMemo(() => {
    if (!parsed.basePrice || parsed.basePrice <= 0) return [];
    return buildPocketSeeds(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrice, buyInterval, sellTarget, totalBudget, weights, market]);

  const setWeight = (i: number, v: string) => {
    const next = [...weights];
    next[i] = v;
    setWeights(next);
  };

  // 배분 방식 — 비중(%) 또는 금액 (프로젝트 생성 화면과 같은 규칙)
  const alloc = useAllocMode(market, weights, setWeights, totalBudget, setTotalBudget);
  const byAmount = alloc.mode === 'amount';
  const resetEqual = () => {
    const count = weights.length;
    if (byAmount) {
      const per = alloc.round((Number(totalBudget) || 0) / count);
      return alloc.setAllAmounts(Array(count).fill(per > 0 ? String(per) : ''));
    }
    setWeights(Array(count).fill(String(Math.round((100 / count) * 100) / 100)));
  };

  // 거래가 하나라도 있으면 수정 불가 (전략 잠금). 이름은 종목명이라 항상 고정.
  const locked = tradeCount > 0;

  const onSave = async () => {
    if (!project) return;
    if (locked) return; // 잠김: 저장 버튼 자체가 없음

    if (!parsed.basePrice || parsed.basePrice <= 0) {
      return notify('입력 필요', '기준가를 올바르게 입력하세요.');
    }

    setSaving(true);
    const { error: perr } = await supabase
      .from('projects')
      .update({
        base_price: parsed.basePrice,
        buy_interval_pct: parsed.buyIntervalPct,
        sell_target_pct: parsed.sellTargetPct,
        total_budget: parsed.totalBudget,
      })
      .eq('id', project.id);
    if (perr) {
      setSaving(false);
      return notify('저장 실패', perr.message);
    }

    // 거래 없음 → 모든 포켓 목표가+예산 재계산
    await Promise.all(
      pockets.map((k) => {
        const s = seeds[k.idx];
        if (!s) return Promise.resolve();
        return supabase
          .from('pockets')
          .update({
            buy_target_price: s.buy_target_price,
            sell_target_price: s.sell_target_price,
            weight: s.weight,
            budget: s.budget,
          })
          .eq('id', k.id);
      })
    );

    setSaving(false);
    notify('저장 완료', '프로젝트가 수정됐어요.');
    router.back();
  };

  if (loading || !project) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const dim = locked ? 0.45 : 1;

  return (
    // keyboardDismissMode="interactive" 는 입력 중 키보드가 멋대로 닫히는 원인이라 제거
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackHeader fallback="/" />
      {locked && (
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>🔒 수정할 수 없어요</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            이미 매매(체결 {tradeCount}건)가 시작된 프로젝트라, 전략·예산을 바꾸면 손익 계산이 꼬여요.
            전략을 바꾸려면 새 프로젝트를 만들어 주세요.
          </Text>
        </Card>
      )}

      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{project.name}</Text>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>
          {project.symbol} · {market === 'KRX' ? '한국(원화)' : '미국(달러)'} · 종목/이름은 변경할 수 없어요
        </Text>
        <View style={{ opacity: dim }}>
          <NumberField
            label={`기준가 (${market === 'KRX' ? '원' : '달러'})`}
            value={basePrice}
            onChangeText={setBasePrice}
            decimals
            editable={!locked}
            placeholder="1번 포켓 매수 기준가"
          />
        </View>
      </Card>

      <Card style={{ opacity: dim }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>5분할 전략</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="매수 간격 %" value={buyInterval} onChangeText={setBuyInterval} keyboardType="decimal-pad" editable={!locked} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="매도 목표 %" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" editable={!locked} />
          </View>
        </View>
      </Card>

      <Card style={{ opacity: dim }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>예산 & 포켓 비율</Text>
        <NumberField
          label={
            byAmount
              ? `프로젝트 총 예산 (${market === 'KRX' ? '원' : '달러'}) · 포켓 금액 합계`
              : `프로젝트 총 예산 (${market === 'KRX' ? '원' : '달러'}, 선택)`
          }
          value={totalBudget}
          onChangeText={setTotalBudget}
          decimals
          editable={!locked && !byAmount} // 금액 모드에서는 포켓 금액의 합이라 직접 못 고친다
          placeholder="예: 1,000,000"
        />
        {/* 배분 방식 — 비중(%)으로 나눌지, 금액을 직접 넣을지 */}
        {!locked && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: colors.textDim, fontSize: 13, marginRight: 2 }}>배분</Text>
            {(['pct', 'amount'] as const).map((k) => (
              <Pressable
                key={k}
                onPress={() => alloc.changeMode(k)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: alloc.mode === k ? colors.primary : colors.border,
                  backgroundColor: alloc.mode === k ? 'rgba(34,211,166,0.14)' : colors.cardAlt,
                }}
              >
                <Text style={{ color: alloc.mode === k ? colors.primary : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                  {k === 'pct' ? '비중 %' : `금액 ${market === 'KRX' ? '₩' : '$'}`}
                </Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Pressable onPress={resetEqual}>
              <Text style={{ color: colors.accent, fontWeight: '700' }}>균등 분배</Text>
            </Pressable>
          </View>
        )}
        {/* 한 줄 고정 — 입력 중 '(자동 정규화됨)'이 붙으며 줄바꿈되면 아래 입력칸이 밀린다 */}
        <Text numberOfLines={1} style={{ color: colors.textDim }}>
          {byAmount ? (
            <>포켓 금액 합계: {formatPrice(alloc.sum, market)}</>
          ) : (
            <>
              포켓별 비중 합계: {money(weightSum, 1)}%{' '}
              {Math.abs(weightSum - 100) > 0.1 && <Text style={{ color: colors.warn }}>(자동 정규화됨)</Text>}
            </>
          )}
        </Text>
        {weights.map((w, i) => {
          const allocAmt = parsed.totalBudget ? (parsed.totalBudget * normalized[i]) / 100 : null;
          const sd = seeds[i];
          // 예산 0 또는 매수 가능 수량 0주면 저장해도 이 포켓은 살아나지 않는다
          const excluded =
            parsed.totalBudget != null &&
            !!sd &&
            ((sd.budget ?? 0) <= 0 || estimatedShares(sd.budget, sd.buy_target_price) <= 0);
          return (
            <View key={i} style={{ gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <Text style={{ color: colors.text, width: 56, opacity: excluded ? 0.5 : 1 }}>포켓 {i + 1}</Text>
                <View style={{ width: byAmount ? 130 : 90 }}>
                  {byAmount ? (
                    <WeightInput
                      value={alloc.amounts[i] ?? ''}
                      onChange={(v) => alloc.setAmount(i, v)}
                      editable={!locked}
                      commas
                      decimals={alloc.decimals}
                    />
                  ) : (
                    <WeightInput value={w} onChange={(v) => setWeight(i, v)} editable={!locked} />
                  )}
                </View>
                <Text numberOfLines={1} style={{ color: colors.textDim, flex: 1, opacity: excluded ? 0.5 : 1 }}>
                  {byAmount
                    ? `${normalized[i]}%`
                    : `${normalized[i]}% ${allocAmt != null ? `· ${formatPrice(allocAmt, market)}` : ''}`}
                </Text>
              </View>
              {/* 이유는 잘리지 않게 아랫줄에 따로 (빨강) */}
              {excluded && (
                <Text style={{ color: colors.danger, fontSize: 11, fontWeight: '700', marginLeft: 56 + spacing.md }}>
                  1주도 살 수 없어 이 포켓은 생성되지 않아요
                </Text>
              )}
            </View>
          );
        })}
      </Card>

      {locked ? (
        <Button title="닫기" variant="ghost" onPress={() => router.back()} />
      ) : (
        <Button title="수정 저장" onPress={onSave} loading={saving} />
      )}
      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}
