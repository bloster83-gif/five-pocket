import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { notify } from '@/lib/alert';
import { Button, Callout, Card, Field, NumberField, Segmented } from '@/components/ui';
import { colors, formatPrice, money, spacing } from '@/theme';
import { buildPocketSeeds, buildScheduleSeeds, estimatedShares, inferSchedule, normalizeWeights, pocketBuyTarget, POCKET_COUNT, scheduleAt, type ScheduleUnit } from '@/domain/pockets';
import type { Pocket, Project } from '@/types/db';
import { BackHeader } from '@/components/BackHeader';
import { WeightInput } from '@/components/WeightInput';
import { AutoBudgetField } from '@/components/AutoBudgetField';
import { StopLineField } from '@/components/StopLineField';
import { useAllocMode } from '@/lib/allocMode';

const pad2 = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeStr = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function parseStart(date: string, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m || !t) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0);
  return isNaN(d.getTime()) ? null : d;
}
const UNITS: { key: ScheduleUnit; label: string }[] = [
  { key: 'day', label: '일' },
  { key: 'week', label: '주' },
  { key: 'month', label: '개월' },
];

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
  const [stopPrice, setStopPrice] = useState(''); // 프로젝트 마지노선 (정기매수법, 선택) — 잠겨 있어도 고칠 수 있다
  const [savingStop, setSavingStop] = useState(false);
  const [totalBudget, setTotalBudget] = useState('');
  const [weights, setWeights] = useState<string[]>(Array(POCKET_COUNT).fill('20'));
  // 정기매수법 — 저장된 포켓의 예정 시각에서 되짚어 낸 값으로 시작
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:30');
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState<ScheduleUnit>('week');

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
      setStopPrice(proj.stop_price != null && Number(proj.stop_price) > 0 ? String(proj.stop_price) : '');
      setTotalBudget(proj.total_budget != null ? String(proj.total_budget) : '');
    }
    if (k) {
      const ks = [...(k as Pocket[])].sort((a, b) => a.idx - b.idx);
      setPockets(ks);
      if (ks.length > 0) setWeights(ks.map((x) => String(x.weight)));
      // 정기매수법이면 날짜·시각·주기를 포켓에서 되짚어 채운다
      if ((p as Project)?.buy_mode === 'schedule') {
        const inf = inferSchedule(ks);
        if (inf) {
          setStartDate(dateStr(inf.startAt));
          setStartTime(timeStr(inf.startAt));
          setEvery(String(inf.every));
          setUnit(inf.unit);
        }
      }
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
  const isSched = project?.buy_mode === 'schedule';
  const scheduleStart = useMemo(() => parseStart(startDate, startTime), [startDate, startTime]);
  const scheduleEvery = Math.max(1, Math.floor(Number(every) || 1));

  // 배분 방식 — 비중(%) / 금액 / 수량(주) (프로젝트 생성 화면과 같은 규칙)
  // 수량 모드의 포켓 매수가: 정액매수법 = 포켓 목표가, 정기매수법 = 기준가(생성 당시 현재가, 참고값)
  const pocketPrice = (i: number) =>
    isSched ? parsed.basePrice : pocketBuyTarget(parsed.basePrice, parsed.buyIntervalPct, i, market);
  const alloc = useAllocMode(market, weights, setWeights, totalBudget, setTotalBudget, pocketPrice);
  const byAmount = alloc.mode === 'amount';
  const byQty = alloc.mode === 'qty';
  const byPct = alloc.mode === 'pct';

  const seeds = useMemo(() => {
    if (!parsed.basePrice || parsed.basePrice <= 0) return [];
    const input = { ...parsed, budgets: alloc.budgets };
    if (isSched) {
      if (!scheduleStart) return [];
      return buildScheduleSeeds({
        ...input,
        schedule: { startAt: scheduleStart, every: scheduleEvery, unit, count: parsed.pocketCount },
      });
    }
    return buildPocketSeeds(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrice, buyInterval, sellTarget, totalBudget, weights, alloc.budgets, market, isSched, scheduleStart, scheduleEvery, unit]);

  const setWeight = (i: number, v: string) => {
    const next = [...weights];
    next[i] = v;
    setWeights(next);
  };

  const resetEqual = () => {
    const count = weights.length;
    if (byQty) return alloc.setAllQtys(alloc.equalQtys(Number(totalBudget) || 0, count));
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
    if (isSched && !scheduleStart) {
      return notify('입력 필요', '첫 매수 날짜는 YYYY-MM-DD, 시각은 HH:MM 형식으로 입력하세요.');
    }

    setSaving(true);
    const { error: perr } = await supabase
      .from('projects')
      .update({
        base_price: parsed.basePrice,
        buy_interval_pct: parsed.buyIntervalPct,
        sell_target_pct: parsed.sellTargetPct,
        total_budget: parsed.totalBudget,
        ...(isSched ? { stop_price: Number(stopPrice) > 0 ? Number(stopPrice) : null } : null),
      })
      .eq('id', project.id);
    if (perr) {
      setSaving(false);
      if (/stop_price/i.test(perr.message)) {
        return notify('DB 준비 필요', '마지노선에 필요한 마이그레이션(20260910a)을 Supabase에서 먼저 실행해 주세요.');
      }
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
            // 정기매수법은 예정 시각도 다시 쓴다 (안 쓰면 날짜 수정이 반영되지 않는다)
            ...(isSched ? { buy_at: s.buy_at ?? null } : null),
          })
          .eq('id', k.id);
      })
    );

    setSaving(false);
    notify('저장 완료', '프로젝트가 수정됐어요.');
    router.back();
  };

  /** 잠긴(거래 있는) 프로젝트에서 마지노선만 저장 — 목표가 수정처럼 언제든 바꿀 수 있어야 한다 */
  const saveStopOnly = async () => {
    if (!project) return;
    setSavingStop(true);
    const { error } = await supabase
      .from('projects')
      .update({ stop_price: Number(stopPrice) > 0 ? Number(stopPrice) : null })
      .eq('id', project.id);
    setSavingStop(false);
    if (error) {
      if (/stop_price/i.test(error.message)) {
        return notify('DB 준비 필요', '마지노선에 필요한 마이그레이션(20260910a)을 Supabase에서 먼저 실행해 주세요.');
      }
      return notify('저장 실패', error.message);
    }
    notify('저장 완료', Number(stopPrice) > 0 ? `마지노선 ${formatPrice(Number(stopPrice), market)} 으로 저장했어요.` : '마지노선을 해제했어요.');
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
        <Callout tone="warn" title="🔒 전략·예산은 수정할 수 없어요">
          이미 매매(체결 {tradeCount}건)가 시작된 프로젝트라, 전략·예산을 바꾸면 손익 계산이 꼬여요. 전략을 바꾸려면 새 프로젝트를 만들어 주세요.
        </Callout>
      )}

      <Card title={project.name} subtitle={`${project.symbol} · ${market === 'KRX' ? '한국(원화)' : '미국(달러)'} · 종목/이름은 변경할 수 없어요`}>
        {/* 정기매수법은 기준가가 없다 (예정 시각의 현재가로 산다) */}
        {!isSched && (
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
        )}
      </Card>

      <Card style={{ opacity: dim }} title={isSched ? '📅 정기매수법' : '📉 정액매수법'}>
        {isSched ? (
          <>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1.4 }}>
                <Field label="첫 매수 날짜" value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" autoCapitalize="none" editable={!locked} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="시각" value={startTime} onChangeText={setStartTime} placeholder="09:30" autoCapitalize="none" editable={!locked} />
              </View>
            </View>
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800', marginTop: -6 }}>🕘 한국시간(폰 시간대) 기준</Text>
            <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-end' }}>
              <View style={{ width: 78 }}>
                <Field label="간격" value={every} onChangeText={setEvery} keyboardType="number-pad" editable={!locked} />
              </View>
              <View style={{ flex: 1, paddingBottom: 6 }}>
                <Segmented options={UNITS.map((u) => ({ key: u.key, label: `${u.label}마다` }))} value={unit} onChange={setUnit} disabled={locked} />
              </View>
            </View>
            <Field label="매도 목표 % (체결가 대비)" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" editable={!locked} />
            {scheduleStart ? (
              <Callout title={`매수 예정 (${parsed.pocketCount}회)`}>
                {Array.from({ length: Math.min(parsed.pocketCount, 5) }, (_, i) => {
                  const d = scheduleAt(scheduleStart, scheduleEvery, unit, i);
                  return (
                    <Text key={i} style={{ color: colors.text, fontSize: 12 }}>
                      포켓 {i + 1} · {dateStr(d)} {timeStr(d)}
                    </Text>
                  );
                })}
                {parsed.pocketCount > 5 && <Text style={{ color: colors.textDim, fontSize: 11 }}>… 외 {parsed.pocketCount - 5}회</Text>}
              </Callout>
            ) : (
              <Callout tone="warn">날짜는 YYYY-MM-DD, 시각은 HH:MM 형식으로 입력하세요.</Callout>
            )}
          </>
        ) : (
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Field label="매수 간격 %" value={buyInterval} onChangeText={setBuyInterval} keyboardType="decimal-pad" editable={!locked} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="매도 목표 %" value={sellTarget} onChangeText={setSellTarget} keyboardType="decimal-pad" editable={!locked} />
            </View>
          </View>
        )}
      </Card>

      {/* 프로젝트 마지노선 (정기매수법) — 거래가 있어 전략이 잠겨 있어도 이것만은 언제든 고칠 수 있다.
          그래서 잠금 흐림(dim)이 걸린 전략 카드 밖, 별도 카드에 둔다. */}
      {isSched && (
        <Card title="🛑 프로젝트 마지노선">
          <StopLineField market={market} value={stopPrice} onChange={setStopPrice} />
          {locked ? (
            <Button title="마지노선만 저장" onPress={saveStopOnly} loading={savingStop} />
          ) : (
            <Text style={{ color: colors.textDim, fontSize: 11 }}>아래 '수정 저장'을 누르면 함께 저장돼요.</Text>
          )}
        </Card>
      )}

      <Card style={{ opacity: dim }} title="예산 & 포켓 배분">
        {/* 금액·수량 모드에서는 총예산 = 포켓 금액 합 → 입력칸 대신 '자동 계산' 표시 */}
        {byPct ? (
          <NumberField
            label={`프로젝트 총 예산 (${market === 'KRX' ? '원' : '달러'}, 선택)`}
            value={totalBudget}
            onChangeText={setTotalBudget}
            decimals
            editable={!locked}
            placeholder="예: 1,000,000"
          />
        ) : (
          <AutoBudgetField market={market} value={totalBudget} mode={byQty ? 'qty' : 'amount'} />
        )}
        {/* 배분 방식 — 비중(%)으로 나눌지, 금액을 직접 넣을지 */}
        {!locked && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: colors.textDim, fontSize: 13, marginRight: 2 }}>배분</Text>
            <Segmented
              options={[
                { key: 'pct' as const, label: '비중 %' },
                { key: 'amount' as const, label: `금액 ${market === 'KRX' ? '₩' : '$'}` },
                { key: 'qty' as const, label: '수량 주' },
              ]}
              value={alloc.mode}
              onChange={alloc.changeMode}
            />
            <View style={{ flex: 1 }} />
            <Pressable onPress={resetEqual}>
              <Text style={{ color: colors.accent, fontWeight: '700' }}>균등 분배</Text>
            </Pressable>
          </View>
        )}
        {/* 한 줄 고정 — 입력 중 '(자동 정규화됨)'이 붙으며 줄바꿈되면 아래 입력칸이 밀린다 */}
        <Text numberOfLines={1} style={{ color: colors.textDim }}>
          {byQty ? (
            <>
              총 {money(alloc.qtySum)}주 · {formatPrice(alloc.sum, market)}
              {isSched ? ' (기준가 기준)' : ' (포켓별 매수 목표가 기준)'}
            </>
          ) : byAmount ? (
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
                  {byQty ? (
                    <WeightInput
                      value={alloc.qtys[i] ?? ''}
                      onChange={(v) => alloc.setQty(i, v)}
                      editable={!locked}
                      commas
                      decimals={false}
                    />
                  ) : byAmount ? (
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
                {/* 설명은 항상 두 줄로 고정(비중 / 금액) — 한 줄에 다 넣으면 금액이 잘리고,
                    줄 수가 바뀌면 입력 중 레이아웃이 흔들려 키보드가 닫힌다 */}
                <View style={{ flex: 1, opacity: excluded ? 0.5 : 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.textDim }}>
                    {byQty ? `${formatPrice(Number(alloc.amounts[i]) || 0, market)} · ${normalized[i]}%` : `${normalized[i]}%`}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 12 }}>
                    {byQty
                      ? alloc.priceOf(i) > 0
                        ? `@${formatPrice(alloc.priceOf(i), market)}`
                        : ' '
                      : byAmount
                        ? ' '
                        : allocAmt != null
                          ? formatPrice(allocAmt, market)
                          : ' '}
                  </Text>
                </View>
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
