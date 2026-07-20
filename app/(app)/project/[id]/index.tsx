import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, ChartIcon, Row } from '@/components/ui';
import { colors, formatMoney, formatPrice, money, pocketColor, radius, signColor, spacing } from '@/theme';
import { computePnL, estimatedShares, pnlPct } from '@/domain/pockets';
import { confirmAction, notify } from '@/lib/alert';
import { usePriceTracker } from '@/services/priceTracker';
import { useAutoTrader } from '@/services/autoTrader';
import type { Pocket, Project, Trade } from '@/types/db';

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { tier } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const [{ data: p }, { data: k }, { data: t }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', id).single(),
      supabase.from('pockets').select('*').eq('project_id', id).order('idx'),
      supabase.from('trades').select('*').eq('project_id', id).order('executed_at'),
    ]);
    if (p) setProject(p as Project);
    if (k) setPockets(k as Pocket[]);
    if (t) setTrades(t as Trade[]);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 자동매매 (AUTO 등급 + 프로젝트 자동매매 ON 일 때만 실제 주문)
  const { handleSignal, lastEvent } = useAutoTrader(project, trades, load);

  const { price, change, changePct, updatedAt, status, error, currency } = usePriceTracker(
    project,
    pockets,
    !!project?.is_active,
    handleSignal
  );
  const pnl = computePnL(trades, price);
  const pct = pnlPct(pnl);

  // 실시간 시세의 통화로 시장을 자동 보정 (예: 삼성전자가 달러로 잘못 저장된 경우 원화로)
  const liveMarket = currency === 'KRW' ? 'KRX' : currency === 'USD' ? 'US' : null;
  useEffect(() => {
    if (project && liveMarket && liveMarket !== project.market) {
      setProject((p) => (p ? { ...p, market: liveMarket } : p));
      supabase.from('projects').update({ market: liveMarket }).eq('id', project.id).then(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMarket]);

  // 포켓별 실제 체결가(매수/매도) 매핑
  const buyByPocket = useMemo(() => {
    const m = new Map<string, Trade>();
    trades.filter((t) => t.side === 'buy').forEach((t) => {
      if (t.pocket_id) m.set(t.pocket_id, t); // 시간순이라 마지막(=현재 순환) 매수가 남음
    });
    return m;
  }, [trades]);

  // 포켓별 완료된 순환 횟수 (= 매도 체결 수)
  const cyclesByPocket = useMemo(() => {
    const m = new Map<string, number>();
    trades
      .filter((t) => t.side === 'sell')
      .forEach((t) => {
        if (t.pocket_id) m.set(t.pocket_id, (m.get(t.pocket_id) ?? 0) + 1);
      });
    return m;
  }, [trades]);

  // 매도 완료된 포켓을 다시 매수 대기로 (기존 기록은 그대로 유지)
  const restartPocket = async (k: Pocket) => {
    const { error } = await supabase
      .from('pockets')
      .update({ status: 'waiting', sell_target_price: null })
      .eq('id', k.id);
    if (error) return notify('처리 실패', error.message);
    load();
  };

  const toggleActive = async (val: boolean) => {
    if (!project) return;
    setProject({ ...project, is_active: val });
    await supabase.from('projects').update({ is_active: val }).eq('id', project.id);
  };

  const toggleAutoTrade = async (val: boolean) => {
    if (!project) return;
    const prev = project;
    setProject({ ...project, auto_trade_enabled: val });
    const { error } = await supabase
      .from('projects')
      .update({ auto_trade_enabled: val })
      .eq('id', project.id);
    if (error) {
      setProject(prev);
      if (/42703|auto_trade_enabled|does not exist|schema cache|PGRST204/i.test(`${error.code} ${error.message}`)) {
        notify('DB 준비 필요', '자동매매에 필요한 컬럼이 아직 없어요. 마이그레이션(20260716e)을 Supabase에서 실행하면 켜집니다.');
      } else {
        notify('처리 실패', error.message);
      }
    }
  };

  const setClosed = async (close: boolean) => {
    if (!project) return;
    const prev = project;
    const closed_at = close ? new Date().toISOString() : null;
    // 종료하면 실시간 추적도 끔
    const is_active = close ? false : project.is_active;
    setProject({ ...project, closed_at, is_active });
    const { error } = await supabase.from('projects').update({ closed_at, is_active }).eq('id', project.id);
    if (error) {
      setProject(prev); // 롤백
      if (/42703|closed_at|does not exist|schema cache|PGRST205/i.test(`${error.code} ${error.message}`)) {
        notify('DB 준비 필요', '프로젝트 종료 기능에 필요한 컬럼이 아직 없어요. 최신 마이그레이션(20260716b)을 Supabase에서 실행하면 켜집니다.');
      } else {
        notify('처리 실패', error.message);
      }
    }
  };

  if (loading || !project) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const mkt = liveMarket ?? project.market;
  const marketLabel = mkt === 'KRX' ? '한국' : '미국';

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
    >
      <Stack.Screen
        options={{
          title: project.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/project/${project.id}/chart`)}
              hitSlop={10}
              style={{ ...headerIconStyle, marginRight: spacing.sm }}
            >
              <ChartIcon size={16} />
            </Pressable>
          ),
        }}
      />

      {/* 실시간 시세 */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.textDim }}>
              {project.symbol} · {marketLabel}
            </Text>
            <Text style={{ color: colors.text, fontSize: 38, fontWeight: '900', marginTop: 2 }}>
              {price != null ? formatPrice(price, mkt) : '—'}
            </Text>
            {change != null && changePct != null && (
              <Text style={{ color: signColor(change), fontSize: 16, fontWeight: '800', marginTop: 2 }}>
                {change > 0 ? '▲' : change < 0 ? '▼' : ''} {formatMoney(Math.abs(change), mkt)} ({changePct > 0 ? '+' : ''}
                {changePct}%)
              </Text>
            )}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>실시간 추적</Text>
            <Switch value={project.is_active} onValueChange={toggleActive} />
          </View>
        </View>

        {/* 상태 표시 (#7 확실한 실시간 표기) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {!project.is_active ? (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>추적이 꺼져 있어요</Text>
          ) : status === 'live' ? (
            <>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.buy }} />
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                실시간 · {updatedAt ? new Date(updatedAt).toLocaleTimeString() : ''} 업데이트
              </Text>
            </>
          ) : status === 'loading' ? (
            <>
              <ActivityIndicator size="small" color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12 }}>시세 불러오는 중…</Text>
            </>
          ) : (
            <Text style={{ color: colors.warn, fontSize: 12 }}>
              시세를 불러오지 못했어요. 폰(Expo Go)에서 실행하거나 프록시/목업 설정이 필요해요.
            </Text>
          )}
        </View>
      </Card>

      {/* 자동매매 켜기/끄기만 (상세 설정·계좌연결은 프로젝트 목록/MY 탭에서) */}
      {tier === 'auto' && (
        <Card style={project.auto_trade_enabled ? { borderColor: colors.buy } : undefined}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>🤖 자동매매</Text>
              <Text style={{ color: project.auto_trade_enabled ? colors.buy : colors.textDim, fontSize: 12 }}>
                {project.auto_trade_enabled ? 'ON · 목표가 도달 시 자동 주문' : 'OFF · 수동 매매'}
              </Text>
            </View>
            <Switch value={project.auto_trade_enabled} onValueChange={toggleAutoTrade} />
          </View>
          {lastEvent && (
            <View
              style={{
                backgroundColor: lastEvent.ok ? colors.buyBg : 'rgba(251,191,36,0.12)',
                borderRadius: 8,
                padding: spacing.sm,
              }}
            >
              <Text style={{ color: lastEvent.ok ? colors.buy : colors.warn, fontSize: 12, fontWeight: '700' }}>
                {lastEvent.ok ? '✅' : '⚠️'} 포켓 {lastEvent.pocketIdx + 1} 자동 {lastEvent.kind === 'buy' ? '매수' : '매도'} ·{' '}
                {lastEvent.message}
              </Text>
            </View>
          )}
        </Card>
      )}

      {/* 손익 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>손익</Text>
        <Row
          label="보유 수량 / 평단"
          value={`${money(pnl.totalQtyOpen, 0)}주  ·  평단 ${formatPrice(pnl.avgOpenPrice, mkt)}`}
        />
        <Row
          label="평가 총액"
          value={price != null ? formatMoney(pnl.totalQtyOpen * price, mkt) : '-'}
        />
        <Row label="평가 손익 (미매도분)" value={formatMoney(pnl.unrealized, mkt)} valueColor={signColor(pnl.unrealized)} />
        <Row label="평가 수익률" value={`${pct > 0 ? '+' : ''}${pct}%`} valueColor={signColor(pct)} />
        <Row label="실현 손익 (매도분)" value={formatMoney(pnl.realized, mkt)} valueColor={signColor(pnl.realized)} />
      </Card>

      {/* 포켓 */}
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>
          5포켓 · 매수간격 {project.buy_interval_pct}% · 매도목표 {project.sell_target_pct}%
        </Text>
        {project.total_budget != null && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
            <Text style={{ color: colors.textDim }}>💰 프로젝트 예산</Text>
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>{formatMoney(project.total_budget, mkt)}</Text>
          </View>
        )}
        {pockets.map((k) => (
          <PocketCard
            key={k.id}
            pocket={k}
            market={mkt}
            price={price}
            buyIntervalPct={Number(project.buy_interval_pct)}
            sellTargetPct={Number(project.sell_target_pct)}
            buyTrade={buyByPocket.get(k.id) ?? null}
            cycles={cyclesByPocket.get(k.id) ?? 0}
            autoMode={tier === 'auto'}
            autoTradeOn={project.auto_trade_enabled}
            onRestart={() => restartPocket(k)}
            onTrade={(side, sqty, sprice) =>
              router.push(
                `/project/${project.id}/trade?pocket=${k.id}&idx=${k.idx}&side=${side}&sqty=${sqty}&sprice=${sprice}`
              )
            }
          />
        ))}
      </View>

      {/* 수정 / 삭제 (프로젝트 종료 버튼 바로 위) */}
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Button title="✏️ 수정" variant="ghost" onPress={() => router.push(`/project/${project.id}/edit`)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="🗑️ 삭제"
            variant="danger"
            onPress={() =>
              confirmAction(
                '프로젝트 삭제',
                `"${project.name}"과(와) 모든 포켓·거래 기록이 삭제됩니다. 계속할까요?`,
                async () => {
                  await supabase.from('projects').delete().eq('id', project.id);
                  router.replace('/');
                },
                '삭제'
              )
            }
          />
        </View>
      </View>

      {project.closed_at ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center' }}>
            {project.closed_at.slice(0, 10)}에 종료된 프로젝트입니다.
          </Text>
          <Button title="프로젝트 재개" variant="primary" onPress={() => setClosed(false)} />
        </View>
      ) : (
        <Button
          title="프로젝트 종료 (매매 완료)"
          variant="sell"
          onPress={() =>
            confirmAction(
              '프로젝트 종료',
              `"${project.name}"을(를) 종료할까요? 종료하면 목록에서 숨겨지고, “지난 프로젝트 보기”로 다시 찾을 수 있어요.`,
              () => setClosed(true),
              '종료'
            )
          }
        />
      )}

    </ScrollView>
  );
}

// 헤더 우측 아이콘 버튼 공통 스타일 (수정·삭제·차트)
const headerIconStyle = {
  width: 34,
  height: 34,
  borderRadius: 17,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.cardAlt,
  borderWidth: 1,
  borderColor: colors.border,
};

// 자동매매 중일 때 보이는 작은 수동 입력 버튼
function ManualEntryButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: colors.cardAlt,
      }}
    >
      <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '700' }}>✍️ 수동으로 입력</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------
// 포켓 카드 — 상태에 따라 표시가 달라진다.
//  waiting: 매수 목표가 강조(빨강) + 매수 체결 버튼
//  bought : 음영으로 "가득 참" 표현 + 매도 목표가 크게(파랑) + 매도 체결 버튼
//  sold   : 거래 완료
// ---------------------------------------------------------------
function PocketCard({
  pocket: k,
  market,
  price,
  buyIntervalPct,
  sellTargetPct,
  buyTrade,
  cycles,
  autoMode,
  autoTradeOn,
  onRestart,
  onTrade,
}: {
  pocket: Pocket;
  market: string;
  price: number | null;
  buyIntervalPct: number; // 매수 간격 % (포켓별 -할인율 표시용)
  sellTargetPct: number; // 매도 목표 % (매도가 +표시용)
  buyTrade: Trade | null;
  cycles: number;
  autoMode: boolean; // AUTO 등급 → 자동체결 안내 + 수동 입력 버튼을 작게
  autoTradeOn: boolean; // 이 프로젝트의 자동매매 스위치 상태 (안내 문구용)
  onRestart: () => void;
  onTrade: (side: 'buy' | 'sell', sqty: number, sprice: number) => void;
}) {
  // 포켓별 기준가 대비 할인율 (포켓1=0%=기준가, 포켓2=-5%, …)
  const buyDiscPct = Math.round(k.idx * buyIntervalPct * 100) / 100;
  const buyReady = k.status === 'waiting' && price != null && price <= k.buy_target_price;
  const sellReady =
    k.status === 'bought' && k.sell_target_price != null && price != null && price >= k.sell_target_price;

  // 매수가능 수량: 배분액 / (현재가 또는 매수목표가)
  const refPrice = price ?? k.buy_target_price;
  const buyableQty = estimatedShares(k.budget, refPrice);

  const statusPill =
    k.status === 'bought'
      ? { text: '매수 완료', color: colors.buy }
      : k.status === 'sold'
        ? { text: '매도 완료', color: colors.sell }
        : { text: '대기중', color: colors.textDim };

  // 음영(가득 참) 배경 + 포켓 번호별 고유 색 띠
  const cardStyle = {
    ...(k.status === 'bought'
      ? { backgroundColor: colors.buyBg, borderColor: colors.buy }
      : k.status === 'sold'
        ? { backgroundColor: colors.sellBg, borderColor: colors.sell }
        : { borderColor: buyReady ? colors.buy : colors.border }),
    borderLeftWidth: 5,
    borderLeftColor: pocketColor(k.idx),
  };

  return (
    <Card style={cardStyle as any}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: pocketColor(k.idx), fontWeight: '900', fontSize: 16 }}>포켓 {k.idx + 1}</Text>
          {cycles > 0 && (
            <View style={{ backgroundColor: colors.cardAlt, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '700' }}>{cycles}회 순환</Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {k.status === 'bought' && <Text style={{ fontSize: 14 }}>🔴</Text>}
          <Text style={{ color: statusPill.color, fontWeight: '800', fontSize: 12 }}>{statusPill.text}</Text>
        </View>
      </View>

      {k.status === 'waiting' && (
        <>
          {/* 매수 목표가 크게 (빨강) + 기준가 대비 할인율 배지 */}
          <View style={{ marginTop: spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>💰 매수 목표가</Text>
              <View style={{ backgroundColor: colors.cardAlt, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 }}>
                <Text style={{ color: k.idx === 0 ? colors.textDim : colors.buy, fontSize: 11, fontWeight: '800' }}>
                  {k.idx === 0 ? '기준가' : `기준가 -${buyDiscPct}%`}
                </Text>
              </View>
            </View>
            <Text style={{ color: colors.buy, fontSize: 26, fontWeight: '900' }}>
              {formatPrice(k.buy_target_price, market)}
            </Text>
          </View>
          {k.budget != null && (
            <Row label={`배분 예산 (비중 ${k.weight}%)`} value={formatPrice(k.budget, market)} />
          )}
          {k.budget != null && (
            <Row label="매수 가능 수량" value={`${money(buyableQty, 0)}주`} valueColor={colors.buy} />
          )}
          {buyReady && (
            <Text style={{ color: colors.buy, fontWeight: '800', marginTop: 2 }}>● 지금 매수 포인트 도달</Text>
          )}
          {autoMode ? (
            <View style={{ marginTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
              <Text style={{ color: autoTradeOn ? colors.buy : colors.textDim, fontSize: 12, flex: 1 }}>
                {autoTradeOn ? '🤖 목표가 도달 시 자동 매수' : '🤖 자동매매 스위치를 켜면 자동 매수돼요'}
              </Text>
              <ManualEntryButton onPress={() => onTrade('buy', buyableQty, price ?? k.buy_target_price)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매수 체결 입력"
                variant="buy"
                large
                onPress={() => onTrade('buy', buyableQty, price ?? k.buy_target_price)}
              />
            </View>
          )}
        </>
      )}

      {k.status === 'bought' && (
        <>
          {/* 매도 목표가 크게 (파랑) + 매수가 대비 +수익률 배지 */}
          <View style={{ marginTop: spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>매도 목표가</Text>
              <View style={{ backgroundColor: colors.sellBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 }}>
                <Text style={{ color: colors.sell, fontSize: 11, fontWeight: '800' }}>매수가 +{sellTargetPct}%</Text>
              </View>
            </View>
            <Text style={{ color: colors.sell, fontSize: 26, fontWeight: '900' }}>
              {k.sell_target_price != null ? formatPrice(k.sell_target_price, market) : '-'}
            </Text>
          </View>
          {buyTrade && (
            <Row
              label="매수 체결"
              value={`${formatPrice(buyTrade.price, market)} · ${money(buyTrade.quantity, 0)}주`}
            />
          )}
          {sellReady && (
            <Text style={{ color: colors.sell, fontWeight: '800', marginTop: 2 }}>● 지금 매도 포인트 도달</Text>
          )}
          {autoMode ? (
            <View style={{ marginTop: spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
              <Text style={{ color: autoTradeOn ? colors.sell : colors.textDim, fontSize: 12, flex: 1 }}>
                {autoTradeOn ? '🤖 목표가 도달 시 자동 매도' : '🤖 자동매매 스위치를 켜면 자동 매도돼요'}
              </Text>
              <ManualEntryButton onPress={() => onTrade('sell', buyTrade?.quantity ?? 0, price ?? k.sell_target_price ?? 0)} />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                title="＋ 매도 체결 입력"
                variant="sell"
                large
                onPress={() => onTrade('sell', buyTrade?.quantity ?? 0, price ?? k.sell_target_price ?? 0)}
              />
            </View>
          )}
        </>
      )}

      {k.status === 'sold' && (
        <View style={{ marginTop: spacing.xs, gap: spacing.sm }}>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            이 포켓은 매도까지 완료됐어요. 다시 시작하면 새 매수 대기 상태가 되고, 이전 기록은 그대로 남습니다.
          </Text>
          <Button
            title="🔄 포켓 재시작 (다시 매수 대기)"
            variant="buy"
            large
            onPress={onRestart}
          />
        </View>
      )}
    </Card>
  );
}
