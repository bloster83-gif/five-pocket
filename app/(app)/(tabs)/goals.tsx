import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { notify } from '@/lib/alert';
import { Button, Card, Chip, Field, FilterBar, NumberField } from '@/components/ui';
import { BarChart, Legend } from '@/components/charts';
import { colors, formatKRW, radius, spacing } from '@/theme';
import { buildGoalRows } from '@/domain/goals';
import { realizedEvents } from '@/domain/pockets';
import type { CashFlow, LifeGoal, Trade } from '@/types/db';

// life_goals 테이블이 아직 없을 때(마이그레이션 전) 나는 에러인지 판별
function isMissingSchema(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const s = `${err.code ?? ''} ${err.message ?? ''}`;
  return /42P01|PGRST205|does not exist|schema cache/i.test(s);
}

export default function GoalsScreen() {
  const { session } = useAuth();
  const uid = session?.user?.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [currentAge, setCurrentAge] = useState('');
  const [targetAge, setTargetAge] = useState('');
  const [startAsset, setStartAsset] = useState('');
  const [targetAsset, setTargetAsset] = useState('');
  const [baseYear, setBaseYear] = useState(new Date().getFullYear());
  const [hasGoal, setHasGoal] = useState(false);
  const [showSetting, setShowSetting] = useState(true);
  const [migrationNeeded, setMigrationNeeded] = useState(false);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [flows, setFlows] = useState<CashFlow[]>([]);

  // 연도별 목표금액 수기 수정 (goal_target_overrides)
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [savingTarget, setSavingTarget] = useState(false);

  const load = useCallback(async () => {
    if (!uid) return;
    const [{ data: g, error: gErr }, { data: t }, { data: cf }, { data: ov }] = await Promise.all([
      supabase.from('life_goals').select('*').eq('user_id', uid).maybeSingle(),
      supabase.from('trades').select('*').order('executed_at'),
      supabase.from('cash_flows').select('*'),
      supabase.from('goal_target_overrides').select('*').eq('user_id', uid),
    ]);
    if (ov) {
      const m: Record<number, number> = {};
      (ov as { year: number; amount: number }[]).forEach((o) => (m[o.year] = Number(o.amount)));
      setOverrides(m);
    }
    setMigrationNeeded(!!gErr && isMissingSchema(gErr));
    if (g) {
      const goal = g as LifeGoal;
      setCurrentAge(String(goal.current_age));
      setTargetAge(String(goal.target_age));
      setStartAsset(String(goal.start_asset));
      setTargetAsset(String(goal.target_asset));
      setBaseYear(goal.base_year);
      setHasGoal(true);
      setShowSetting(false);
    }
    if (t) setTrades(t as Trade[]);
    setFlows((cf as CashFlow[]) ?? []);
    setLoading(false);
  }, [uid]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const nums = {
    currentAge: Number(currentAge),
    targetAge: Number(targetAge),
    startAsset: Number(startAsset),
    targetAsset: Number(targetAsset),
  };
  const nowYear = new Date().getFullYear();

  // 매매일지 → 연도별 순입출금 (입금-출금, 배당 제외) — 원화 기준 합산
  const depositNetByYear = useMemo(() => {
    const m: Record<number, number> = {};
    flows.forEach((cf) => {
      if (cf.type === 'dividend') return;
      const y = Number(cf.occurred_at.slice(0, 4));
      const sign = cf.type === 'withdrawal' ? -1 : 1;
      m[y] = (m[y] ?? 0) + sign * Number(cf.amount);
    });
    return m;
  }, [flows]);

  // 매매일지 → 연도별 배당금 (수익으로 분류)
  const dividendByYear = useMemo(() => {
    const m: Record<number, number> = {};
    flows.forEach((cf) => {
      if (cf.type !== 'dividend') return;
      const y = Number(cf.occurred_at.slice(0, 4));
      m[y] = (m[y] ?? 0) + Number(cf.amount);
    });
    return m;
  }, [flows]);

  // 매매일지 → 연도별 실현손익
  const realizedByYear = useMemo(() => {
    const m: Record<number, number> = {};
    realizedEvents(trades).forEach((ev) => {
      const y = Number(ev.at.slice(0, 4));
      m[y] = (m[y] ?? 0) + ev.amount;
    });
    return m;
  }, [trades]);

  // 실제달성액 자동 계산: 이월 + 입출금 + 배당금 + 실현손익 (올해까지)
  const actualsAuto = useMemo(() => {
    const m: Record<number, number> = {};
    if (!nums.startAsset || !nums.currentAge || !nums.targetAge) return m;
    let carry = nums.startAsset;
    for (let y = baseYear; y <= Math.min(nowYear, baseYear + (nums.targetAge - nums.currentAge)); y++) {
      const actual = Math.round(
        carry + (depositNetByYear[y] ?? 0) + (dividendByYear[y] ?? 0) + (realizedByYear[y] ?? 0)
      );
      m[y] = actual;
      carry = actual;
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAsset, currentAge, targetAge, baseYear, depositNetByYear, dividendByYear, realizedByYear]);

  const { rows, annualReturn, forwardReturn } = useMemo(() => {
    if (!nums.currentAge || !nums.targetAge || nums.targetAge <= nums.currentAge || !nums.startAsset || !nums.targetAsset)
      return { rows: [], annualReturn: 0, forwardReturn: 0 };
    return buildGoalRows(
      nums.currentAge,
      nums.targetAge,
      nums.startAsset,
      nums.targetAsset,
      baseYear,
      actualsAuto,
      depositNetByYear,
      dividendByYear
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAge, targetAge, startAsset, targetAsset, baseYear, actualsAuto, depositNetByYear, dividendByYear]);

  // 수기 수정된 연도는 계획(목표) 금액을 덮어쓴다
  const displayRows = useMemo(
    () => rows.map((r) => (overrides[r.year] != null ? { ...r, planned: overrides[r.year] } : r)),
    [rows, overrides]
  );

  const [selBar, setSelBar] = useState<number | null>(null);
  const thisYearRow = displayRows.find((r) => r.year === nowYear) ?? null;
  const hasThisYearOverride = overrides[nowYear] != null;

  // 표 빠른 보기: 전체 / 과거 / 올해 / 미래
  const [tableFilter, setTableFilter] = useState<'all' | 'past' | 'now' | 'future'>('all');
  const tableRows = useMemo(
    () =>
      displayRows.filter((r) => {
        if (tableFilter === 'past') return r.year < nowYear;
        if (tableFilter === 'now') return r.year === nowYear;
        if (tableFilter === 'future') return r.year > nowYear;
        return true;
      }),
    [displayRows, tableFilter, nowYear]
  );

  // 올해 목표 수기 저장 / 자동 계산으로 복원
  const saveThisYearTarget = async () => {
    if (!uid) return;
    const amt = Number(targetInput);
    if (!amt || amt <= 0) return notify('입력 확인', '올해 목표 금액을 올바르게 입력하세요.');
    setSavingTarget(true);
    const { error } = await supabase.from('goal_target_overrides').upsert(
      { user_id: uid, year: nowYear, amount: amt, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,year' }
    );
    setSavingTarget(false);
    if (error) {
      if (isMissingSchema(error)) {
        return notify('DB 준비 필요', '마이그레이션(20260716e)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('저장 실패', error.message);
    }
    setOverrides((prev) => ({ ...prev, [nowYear]: amt }));
    setEditingTarget(false);
  };

  const resetThisYearTarget = async () => {
    if (!uid) return;
    setSavingTarget(true);
    const { error } = await supabase
      .from('goal_target_overrides')
      .delete()
      .eq('user_id', uid)
      .eq('year', nowYear);
    setSavingTarget(false);
    if (error && !isMissingSchema(error)) return notify('복원 실패', error.message);
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[nowYear];
      return next;
    });
    setEditingTarget(false);
  };

  const saveGoal = async () => {
    if (!uid) return;
    if (!nums.currentAge || !nums.targetAge || nums.targetAge <= nums.currentAge)
      return notify('입력 확인', '현재 나이 < 목표 나이가 되도록 입력하세요.');
    if (!nums.startAsset || !nums.targetAsset) return notify('입력 확인', '시작 자산과 목표 자산을 입력하세요.');
    setSaving(true);
    const { error } = await supabase.from('life_goals').upsert(
      {
        user_id: uid,
        current_age: nums.currentAge,
        target_age: nums.targetAge,
        start_asset: nums.startAsset,
        target_asset: nums.targetAsset,
        base_year: nowYear, // 현재 나이 기준 연도 = 올해
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    setSaving(false);
    if (error) {
      if (isMissingSchema(error)) {
        setMigrationNeeded(true);
        return notify('DB 준비 필요', '마이그레이션(20260716b)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('저장 실패', error.message);
    }
    setBaseYear(nowYear);
    setHasGoal(true);
    setShowSetting(false);
  };

  const chartData = useMemo(
    () =>
      displayRows.map((r) => ({
        label: `'${String(r.year).slice(2)}`,
        bars: [
          { value: r.planned, color: colors.buy },
          ...(r.actual != null ? [{ value: r.actual, color: colors.text }] : []),
        ],
      })),
    [displayRows]
  );

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      {migrationNeeded && (
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>DB 마이그레이션이 필요해요</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            Supabase SQL Editor에서 마이그레이션(20260716b)을 실행하면 목표 저장이 켜집니다. 계산·미리보기는 정상 동작해요.
          </Text>
        </Card>
      )}

      {/* 목표 설정 (접기/펼치기) */}
      <Card>
        <Pressable onPress={() => setShowSetting((s) => !s)} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>🎯 목표 설정</Text>
          <Text style={{ color: colors.textDim, fontSize: 16 }}>{showSetting ? '▲ 접기' : '▼ 펼치기'}</Text>
        </Pressable>
        {!showSetting && hasGoal && (
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            {nums.currentAge}→{nums.targetAge}세 · {formatKRW(nums.startAsset)} → {formatKRW(nums.targetAsset)}
          </Text>
        )}
        {showSetting && (
          <>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              목표 나이와 목표 금액을 정하면 매년 필요한 수익률이 계산되고, 입출금·실현손익은 매매일지에서 자동으로 가져옵니다.
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Field label="현재 나이" value={currentAge} onChangeText={setCurrentAge} keyboardType="number-pad" placeholder="예: 30" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="목표 나이" value={targetAge} onChangeText={setTargetAge} keyboardType="number-pad" placeholder="예: 60" />
              </View>
            </View>
            <NumberField label="최초 금액 (현재 자산, 원)" value={startAsset} onChangeText={setStartAsset} placeholder="예: 50,000,000" />
            <NumberField label="목표 자산 (원)" value={targetAsset} onChangeText={setTargetAsset} placeholder="예: 1,000,000,000" />
            <Button title={hasGoal ? '목표 수정 저장' : '목표 저장'} onPress={saveGoal} loading={saving} />
          </>
        )}
      </Card>

      {rows.length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>
            위 목표 설정을 펼쳐 나이·최초 금액·목표 자산을 입력하면, 올해 현황과 나이별 목표 표가 나타납니다.
          </Text>
        </Card>
      )}

      {rows.length > 0 && (
        <>
          {/* 빠른 보기: 표 필터 (어두운 바 서식) */}
          <FilterBar style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>빠른 보기</Text>
            <Chip label="전체" active={tableFilter === 'all'} onPress={() => setTableFilter('all')} />
            <Chip label="과거" active={tableFilter === 'past'} onPress={() => setTableFilter('past')} activeColor={colors.accent} />
            <Chip label="올해" icon="🔥" active={tableFilter === 'now'} onPress={() => setTableFilter('now')} />
            <Chip label="미래" active={tableFilter === 'future'} onPress={() => setTableFilter('future')} activeColor={colors.accent} />
          </FilterBar>

          {/* ★ 올해 현황 (크게 강조) */}
          {thisYearRow && (
            <Card style={{ borderColor: colors.buy, borderWidth: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 18 }}>
                  🔥 올해 ({nowYear} · {thisYearRow.age}세)
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12 }}>매매일지 자동 연동</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: colors.textDim }}>올해 목표</Text>
                  {hasThisYearOverride && (
                    <View style={{ backgroundColor: colors.cardAlt, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text style={{ color: colors.textDim, fontSize: 10 }}>수기 수정됨</Text>
                    </View>
                  )}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Text style={{ color: colors.buy, fontWeight: '800', fontSize: 16 }}>{formatKRW(thisYearRow.planned)}</Text>
                  <Pressable
                    onPress={() => {
                      setTargetInput(String(Math.round(thisYearRow.planned)));
                      setEditingTarget((e) => !e);
                    }}
                    hitSlop={8}
                    style={{
                      backgroundColor: colors.cardAlt,
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ fontSize: 13 }}>✏️</Text>
                  </Pressable>
                </View>
              </View>

              {/* 올해 목표 수기 수정 폼 */}
              {editingTarget && (
                <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm }}>
                  <NumberField
                    label={`올해(${nowYear}) 목표 금액 (원)`}
                    value={targetInput}
                    onChangeText={setTargetInput}
                    placeholder="예: 60,000,000"
                  />
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <View style={{ flex: 1 }}>
                      <Button title="저장" onPress={saveThisYearTarget} loading={savingTarget} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button title="닫기" variant="ghost" onPress={() => setEditingTarget(false)} />
                    </View>
                  </View>
                  {hasThisYearOverride && (
                    <Button title="자동 계산으로 되돌리기" variant="ghost" onPress={resetThisYearTarget} loading={savingTarget} />
                  )}
                </View>
              )}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textDim }}>최초금액 (년초 이월)</Text>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{formatKRW(thisYearRow.carryover)}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textDim }}>입출금 (매매일지)</Text>
                <Text style={{ color: colors.text, fontWeight: '700' }}>
                  {thisYearRow.deposit >= 0 ? '+' : ''}
                  {formatKRW(thisYearRow.deposit)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textDim }}>배당금 (매매일지)</Text>
                <Text style={{ color: colors.accent, fontWeight: '800' }}>
                  +{formatKRW(thisYearRow.dividend)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.textDim }}>실현손익 (매매일지)</Text>
                <Text style={{ color: (realizedByYear[nowYear] ?? 0) >= 0 ? colors.buy : colors.sell, fontWeight: '800' }}>
                  {(realizedByYear[nowYear] ?? 0) >= 0 ? '+' : ''}
                  {formatKRW(realizedByYear[nowYear] ?? 0)}
                </Text>
              </View>
              <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: spacing.md, marginTop: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>현재 달성액</Text>
                  <Text style={{ color: colors.text, fontWeight: '900', fontSize: 20 }}>
                    {thisYearRow.actual != null ? formatKRW(thisYearRow.actual) : '-'}
                  </Text>
                </View>
                {thisYearRow.actual != null && thisYearRow.planned > 0 && (
                  <Text style={{ color: thisYearRow.actual >= thisYearRow.planned ? colors.buy : colors.warn, fontSize: 12, textAlign: 'right' }}>
                    올해 목표의 {Math.round((thisYearRow.actual / thisYearRow.planned) * 100)}% 달성
                  </Text>
                )}
              </View>
            </Card>
          )}

          {/* 요약: 필요한 수익률 */}
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.textDim }}>앞으로 매년 필요한 수익률</Text>
              <Text style={{ color: colors.buy, fontWeight: '900', fontSize: 18 }}>{forwardReturn || annualReturn}%</Text>
            </View>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              {nums.targetAge}세에 {formatKRW(nums.targetAsset)} 목표 · 이후 연도는 "이 정도 금액을 목표로" 가이드
            </Text>
          </Card>

          {/* 그래프 */}
          <Card>
            <Text style={{ color: colors.text, fontWeight: '800' }}>연도별 총자산</Text>
            <Legend items={[{ color: colors.buy, label: '계획(목표)' }, { color: colors.text, label: '실제 달성(자동)' }]} />
            {selBar != null && displayRows[selBar] && (
              <View style={{ backgroundColor: colors.cardAlt, borderRadius: radius.sm, padding: spacing.sm, gap: 2 }}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>
                  {displayRows[selBar].age}세 ({displayRows[selBar].year})
                </Text>
                <Text style={{ color: colors.buy, fontSize: 13 }}>계획 {formatKRW(displayRows[selBar].planned)}</Text>
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  실제 {displayRows[selBar].actual != null ? formatKRW(displayRows[selBar].actual) : '미래'}
                  {displayRows[selBar].returnPct != null ? `  ·  ${displayRows[selBar].returnPct}%` : ''}
                </Text>
              </View>
            )}
            <BarChart data={chartData} onBarPress={setSelBar} selectedIndex={selBar} />
          </Card>

          {/* 표 */}
          <Card>
            <Text style={{ color: colors.text, fontWeight: '800' }}>나이별 목표 & 실제 (자동 계산)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                <View style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Text style={[thCell, { width: 60 }]}>나이/연도</Text>
                  <Text style={[thCell, { width: 96 }]}>최초금액/계획</Text>
                  <Text style={[thCell, { width: 84 }]}>입출금</Text>
                  <Text style={[thCell, { width: 84 }]}>배당금</Text>
                  <Text style={[thCell, { width: 96 }]}>실제달성액</Text>
                  <Text style={[thCell, { width: 96 }]}>수익금액/수익률</Text>
                </View>
                {tableRows.map((r) => {
                  const isThisYear = r.year === nowYear;
                  return (
                    <View
                      key={r.year}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 6,
                        borderBottomWidth: 0.5,
                        borderBottomColor: colors.border,
                        backgroundColor: isThisYear ? colors.buyBg : 'transparent',
                        borderRadius: isThisYear ? 8 : 0,
                      }}
                    >
                      <View style={{ width: 60 }}>
                        <Text style={{ color: isThisYear ? colors.buy : colors.text, fontWeight: isThisYear ? '900' : '700' }}>
                          {r.age}세{isThisYear ? ' ★' : ''}
                        </Text>
                        <Text style={{ color: colors.textDim, fontSize: 10 }}>{r.year}</Text>
                      </View>
                      <View style={{ width: 96 }}>
                        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>{formatKRW(r.carryover)}</Text>
                        <Text style={{ color: colors.buy, fontSize: 10 }}>계획 {formatKRW(r.planned)}</Text>
                      </View>
                      <Text style={{ width: 84, color: r.deposit ? colors.text : colors.textDim, fontSize: 12 }}>
                        {r.deposit ? `${r.deposit > 0 ? '+' : ''}${formatKRW(r.deposit)}` : '-'}
                      </Text>
                      <Text style={{ width: 84, color: r.dividend ? colors.accent : colors.textDim, fontSize: 12, fontWeight: r.dividend ? '700' : '400' }}>
                        {r.dividend ? `+${formatKRW(r.dividend)}` : '-'}
                      </Text>
                      <Text style={{ width: 96, color: r.actual != null ? colors.text : colors.textDim, fontSize: 12, fontWeight: '700' }}>
                        {r.actual != null ? formatKRW(r.actual) : `목표 ${formatKRW(r.planned)}`}
                      </Text>
                      <View style={{ width: 96 }}>
                        {r.profit != null ? (
                          <>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: r.profit >= 0 ? colors.buy : colors.sell }}>
                              {r.profit >= 0 ? '+' : ''}
                              {formatKRW(r.profit)}
                            </Text>
                            <Text style={{ fontSize: 10, color: (r.returnPct ?? 0) >= 0 ? colors.buy : colors.sell }}>
                              {r.returnPct == null ? '' : `${r.returnPct > 0 ? '+' : ''}${r.returnPct}%`}
                            </Text>
                          </>
                        ) : (
                          <Text style={{ color: colors.textDim }}>-</Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
            <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 4 }}>
              * 입출금·배당금·실현손익은 매매일지 기록에서 자동 합산 (원화 기준).
              실제달성액 = 최초금액 ± 입출금 + 배당금 + 실현손익. 수익금액에는 배당금이 포함됩니다.
            </Text>
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const thCell = { color: colors.textDim, fontSize: 11 } as const;
