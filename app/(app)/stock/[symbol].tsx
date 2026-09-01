import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Card } from '@/components/ui';
import { BarChart5y, LineChart } from '@/components/MiniCharts';
import { StockPriceChart } from '@/components/StockPriceChart';
import { colors, formatChangePct, formatPrice, num, radius, signColor, spacing } from '@/theme';
import { getUnifiedQuote, loadBrokerAccount } from '@/services/prices/unified';
import { getStoredQuote } from '@/services/prices/quoteStore';
import { useAuth } from '@/lib/auth';
import { fetchCloseSeries, type SeriesPoint, type SeriesRange } from '@/services/prices/yahooProvider';
import {
  fundamentalsConfigured,
  getPriceHistory,
  getStockFinancials,
  type StockFinancials,
} from '@/services/fundamentals';

const CHART_W = Dimensions.get('window').width - 32 - 28; // 화면폭 - 패딩(MiniCharts와 동일)

const RANGES: { key: SeriesRange; label: string }[] = [
  { key: '1M', label: '1개월' },
  { key: '3M', label: '3개월' },
  { key: '6M', label: '6개월' },
  { key: '1Y', label: '1년' },
  { key: '3Y', label: '3년' },
  { key: '5Y', label: '5년' },
  { key: '10Y', label: '10년' },
];

// 큰 금액 축약 (시총·재무제표) — 한국은 조/억, 미국은 B/M
function abbrev(n: number, currency: string): string {
  const won = currency === 'KRW';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (won) {
    if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(1)}조`;
    if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString()}억`;
    if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString()}만`;
    return `${sign}${Math.round(a).toLocaleString()}`;
  }
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${Math.round(a / 1e6).toLocaleString()}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3).toLocaleString()}K`;
  return `${sign}$${Math.round(a).toLocaleString()}`;
}

// 차트 막대 라벨용 (통화기호 없이 짧게)
function abbrevShort(n: number, currency: string): string {
  const won = currency === 'KRW';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (won) {
    if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(1)}조`;
    if (a >= 1e8) return `${sign}${Math.round(a / 1e8)}억`;
    return `${sign}${Math.round(a / 1e4)}만`;
  }
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}${Math.round(a / 1e6)}M`;
  return `${sign}${Math.round(a / 1e3)}K`;
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View
      style={{
        flexBasis: '31%',
        flexGrow: 1,
        backgroundColor: colors.cardAlt,
        borderRadius: radius.md,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm,
        gap: 2,
      }}
    >
      <Text style={{ color: colors.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? colors.text, fontSize: 15, fontWeight: '900' }} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

export default function StockValuationScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { symbol, market, name } = useLocalSearchParams<{ symbol: string; market?: string; name?: string }>();
  const mkt = market === 'KRX' ? 'KRX' : 'US';
  const [fin, setFin] = useState<StockFinancials | null>(null);
  const [finLoading, setFinLoading] = useState(true);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [range, setRange] = useState<SeriesRange>('6M');
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [prevClose, setPrevClose] = useState<number | null>(null);
  // '크게 보기' — 기기를 돌리지 않고 화면 안에서 90° 회전 (매매차트와 동일)
  const [wideView, setWideView] = useState(false);
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // 한국은 네이버(키 불필요), 미국은 FMP 키 필요
  const finReady = mkt === 'KRX' || fundamentalsConfigured();

  // 실시간 현재가 — 앱 공통 통합 시세(KIS 우선, 전역 캐시 공유).
  // 진입 즉시 다른 화면(레이더 등)이 받아둔 마지막 가격을 그대로 보여준 뒤 10초 폴링으로 갱신.
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const cached = getStoredQuote(symbol);
    if (cached) {
      setLivePrice(cached.price);
      if (cached.previousClose != null) setPrevClose(cached.previousClose);
    }
    const tick = async () => {
      try {
        const account = await loadBrokerAccount(session?.user?.id);
        const q = await getUnifiedQuote(account, symbol, mkt);
        if (!alive) return;
        setLivePrice(q.price);
        if (q.previousClose != null) setPrevClose(q.previousClose);
      } catch {
        /* 일시적 오류 — 다음 폴링에서 재시도 */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, mkt, session?.user?.id]);

  // 재무 데이터 (1회)
  useEffect(() => {
    (async () => {
      if (!symbol || !finReady) {
        setFinLoading(false);
        return;
      }
      setFinLoading(true);
      setFin(await getStockFinancials(symbol, mkt));
      setFinLoading(false);
    })();
  }, [symbol, mkt, finReady]);

  // 가격 시계열 (기간 변경 시) — 야후 우선, 실패 시 FMP 폴백
  const loadSeries = useCallback(async () => {
    if (!symbol) return;
    setSeriesLoading(true);
    try {
      const { points } = await fetchCloseSeries(symbol, range);
      if (points.length >= 2) {
        setSeries(points);
        return;
      }
      const fb = await getPriceHistory(symbol, mkt);
      setSeries(fb.map((d) => ({ t: Date.parse(d.year), c: d.value })).filter((p) => Number.isFinite(p.t)));
    } catch {
      setSeries([]);
    } finally {
      setSeriesLoading(false);
    }
  }, [symbol, mkt, range]);

  useEffect(() => {
    loadSeries();
  }, [loadSeries]);

  const f = fin?.fundamentals ?? null;
  const cur = mkt === 'KRX' ? 'KRW' : 'USD';
  const per = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}배` : '—');
  const pct = (n: number | null | undefined) => (n != null ? `${n}%` : '—');
  const epsStr = f?.eps != null ? (mkt === 'KRX' ? `₩${Math.round(f.eps).toLocaleString()}` : `$${f.eps.toFixed(2)}`) : '—';

  // 등락률 (현재가 vs 전일종가)
  const changePct =
    livePrice != null && prevClose != null && prevClose > 0
      ? Math.round((livePrice / prevClose - 1) * 10000) / 100
      : null;

  // 기간칩 + 차트. 세로 화면과 '크게 보기'(가로) 양쪽에서 같은 걸 그린다.
  const chartBlock = (w: number, h: number) => (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {RANGES.map((r) => (
          <Pressable
            key={r.key}
            onPress={() => setRange(r.key)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 999,
              backgroundColor: range === r.key ? colors.buy : colors.cardAlt,
            }}
          >
            <Text style={{ color: range === r.key ? '#fff' : colors.textDim, fontSize: 12, fontWeight: '700' }}>
              {r.label}
            </Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {/* 크게 보기 — 기기를 돌리지 않고 화면 안에서 90° 회전시켜 본다 (매매차트와 동일) */}
        <Pressable
          onPress={() => setWideView((v) => !v)}
          hitSlop={8}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: wideView ? colors.buy : colors.border,
            backgroundColor: colors.cardAlt,
          }}
        >
          <Text style={{ color: wideView ? colors.buy : colors.text, fontSize: 13, fontWeight: '900' }}>
            {wideView ? '⤡' : '⤢'}
          </Text>
        </Pressable>
      </View>
      {seriesLoading ? (
        <View style={{ height: h, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <StockPriceChart points={series} market={mkt} width={w} height={h} symbol={symbol as string} />
      )}
    </>
  );

  // 크게 보기 — 화면 전체를 덮고 내용을 90° 돌려 크게 보여준다 (매매차트와 같은 방식).
  // 화면 회전 잠금을 켜 둔 사람도 쓸 수 있다.
  if (wideView) {
    const innerW = winH - (insets.top + insets.bottom) - spacing.sm * 2;
    return (
      <Modal visible transparent={false} animationType="fade" onRequestClose={() => setWideView(false)}>
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View
            style={{
              position: 'absolute',
              top: (winH - winW) / 2,
              left: (winW - winH) / 2,
              width: winH,
              height: winW,
              transform: [{ rotate: '90deg' }],
              // 90° 돌린 좌표계라 기기의 상·하단(노치·홈 인디케이터)이 좌·우가 된다
              paddingLeft: insets.top + spacing.sm,
              paddingRight: insets.bottom + spacing.sm,
              paddingTop: insets.right + spacing.sm,
              paddingBottom: insets.left + spacing.sm,
              gap: spacing.sm,
            }}
          >
            {chartBlock(innerW, Math.max(180, winW - insets.left - insets.right - 130))}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: (name as string) || (symbol as string) || '가치분석',
          headerLeft: () => (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/radar'))}
              hitSlop={12}
              style={{ paddingHorizontal: 6, paddingVertical: 2 }}
            >
              <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', marginTop: -2 }}>‹</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
        {/* 종목명 + 실시간 현재가 (맨 위) */}
        <View style={{ gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '900' }}>{(name as string) || symbol}</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            {symbol} · {mkt === 'KRX' ? '🇰🇷 한국' : '🇺🇸 미국'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <Text style={{ color: num.live, fontSize: 30, fontWeight: '900' }}>
              {livePrice != null ? formatPrice(livePrice, mkt) : '—'}
            </Text>
            {changePct != null && (
              <Text style={{ color: signColor(changePct), fontSize: 15, fontWeight: '800' }}>
                {changePct > 0 ? '▲ +' : changePct < 0 ? '▼ ' : ''}
                {formatChangePct(changePct)}%
              </Text>
            )}
          </View>
        </View>

        {/* 가격 차트 — 기간 선택 + 핀치 확대·축소 + 꾹 눌러 가격 추적 + 그리기 */}
        <Card>{chartBlock(CHART_W, 210)}</Card>

        {!finReady ? (
          <Card style={{ borderColor: colors.warn, borderWidth: 1 }}>
            <Text style={{ color: colors.warn, fontWeight: '800', fontSize: 14 }}>재무 데이터 키가 필요해요</Text>
            <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
              미국주식 가치분석은 무료 재무 API(Financial Modeling Prep) 키가 있어야 표시돼요.{'\n'}
              financialmodelingprep.com 에서 무료 키를 발급받아 <Text style={{ color: colors.text }}>EXPO_PUBLIC_FMP_KEY</Text> 로
              설정하면 시총·PER·PBR·EPS·ROE·부채비율 + 5년 매출/영업이익/순이익·PER 그래프가 나옵니다.
            </Text>
          </Card>
        ) : finLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            {/* 가치분석 지표 카드 */}
            <Card>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15, marginBottom: 6 }}>가치분석 지표</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Metric label="시가총액" value={f?.marketCap != null ? abbrev(f.marketCap, cur) : '—'} color={num.evalTotal} />
                <Metric label="PER" value={per(f?.per)} color={num.base} />
                <Metric label="PBR" value={per(f?.pbr)} color={num.base} />
                <Metric label="PEG" value={f?.peg != null ? f.peg.toFixed(2) : '—'} color={num.base} />
                <Metric label="EPS" value={epsStr} color={num.position} />
                <Metric label="ROE" value={pct(f?.roe)} color={f?.roe != null ? signColor(f.roe) : undefined} />
                <Metric label="부채비율" value={pct(f?.debtToEquity)} color={num.position} />
                <Metric label="EV/EBITDA" value={per(f?.evEbitda)} color={num.base} />
                <Metric
                  label="EPS성장률(연평균)"
                  value={f?.epsGrowth != null ? `${f.epsGrowth > 0 ? '+' : ''}${f.epsGrowth}%` : '—'}
                  color={f?.epsGrowth != null ? signColor(f.epsGrowth) : undefined}
                />
              </View>
              {!f && <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 6 }}>지표 데이터를 불러오지 못했어요.</Text>}
              {f?.pegComputed && f?.peg != null && (
                <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 6 }}>
                  * PEG = PER ÷ EPS성장률(연평균) — 불러온 연간 EPS 자료로 직접 계산한 값이에요.
                </Text>
              )}
            </Card>

            {/* 5년 재무 그래프 — 영업이익·순이익엔 매출액 대비 이익률(%)을 2줄로 표시 */}
            {(() => {
              const revByYear: Record<string, number> = {};
              (fin?.revenue ?? []).forEach((d) => {
                revByYear[d.year] = d.value;
              });
              const marginSub = (d: { year: string; value: number }) => {
                const rev = revByYear[d.year];
                if (!rev || rev <= 0) return null;
                return `${Math.round((d.value / rev) * 1000) / 10}%`;
              };
              return (
                <>
                  <Card>
                    <BarChart5y title="매출액 (최근 5년)" data={fin?.revenue ?? []} color={num.evalTotal} formatValue={(n) => abbrevShort(n, cur)} />
                  </Card>
                  <Card>
                    <BarChart5y title="영업이익 (최근 5년)" data={fin?.operatingIncome ?? []} formatValue={(n) => abbrevShort(n, cur)} formatSub={marginSub} />
                    <Text style={{ color: colors.textDim, fontSize: 10, marginTop: 2 }}>% = 매출액 대비 영업이익률</Text>
                  </Card>
                  <Card>
                    <BarChart5y title="순이익 (최근 5년)" data={fin?.netIncome ?? []} formatValue={(n) => abbrevShort(n, cur)} formatSub={marginSub} />
                    <Text style={{ color: colors.textDim, fontSize: 10, marginTop: 2 }}>% = 매출액 대비 순이익률</Text>
                  </Card>
                </>
              );
            })()}

            {/* 5년 PER 추이 — 연도별 정확한 수치 표시 */}
            <Card>
              <LineChart
                title="PER 추이 (최근 5년)"
                data={fin?.perHistory ?? []}
                color={num.base}
                formatValue={(n) => `${n.toFixed(1)}`}
                showAllValues
                height={150}
              />
            </Card>

            <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>
              데이터: {mkt === 'KRX' ? '네이버 증권' : 'Financial Modeling Prep'} · Yahoo Finance(차트) · 투자 판단의 책임은 이용자
              본인에게 있습니다.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}
