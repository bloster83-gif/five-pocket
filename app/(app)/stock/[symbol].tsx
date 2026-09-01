import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Card } from '@/components/ui';
import { BarChart5y, LineChart } from '@/components/MiniCharts';
import { CandleChart } from '@/components/CandleChart';
import { colors, formatChangePct, formatPrice, num, radius, signColor, spacing } from '@/theme';
import { getUnifiedQuote, loadBrokerAccount } from '@/services/prices/unified';
import { getStoredQuote } from '@/services/prices/quoteStore';
import { useAuth } from '@/lib/auth';
import { fetchCandles, type Candle, type CandleMode } from '@/services/prices/yahooProvider';
import {
  fundamentalsConfigured,
  getStockFinancials,
  type StockFinancials,
} from '@/services/fundamentals';

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
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [candleErr, setCandleErr] = useState<string | null>(null);
  const [mode, setMode] = useState<CandleMode>('day');
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [prevClose, setPrevClose] = useState<number | null>(null);

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

  // 캔들 (봉 종류 변경 시) — 프로젝트 매매차트와 같은 데이터·같은 차트
  const loadCandles = useCallback(async () => {
    if (!symbol) return;
    setCandlesLoading(true);
    setCandleErr(null);
    try {
      const { candles: c } = await fetchCandles(symbol as string, mode);
      setCandles(c);
    } catch (e: any) {
      setCandles([]);
      setCandleErr(e?.message ?? '차트 데이터를 불러오지 못했어요');
    } finally {
      setCandlesLoading(false);
    }
  }, [symbol, mode]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

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

        {/* 가격 차트 — 프로젝트 매매차트와 완전히 같은 캔들차트 (이평선·확대·가로보기·그리기) */}
        <Card>
          <CandleChart
            symbol={symbol as string}
            market={mkt}
            candles={candles}
            mode={mode}
            onMode={setMode}
            loading={candlesLoading}
            error={candleErr}
            height={260}
          />
        </Card>

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
