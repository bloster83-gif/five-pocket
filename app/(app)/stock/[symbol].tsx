import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Card } from '@/components/ui';
import { BarChart5y, LineChart } from '@/components/MiniCharts';
import { colors, num, radius, signColor, spacing } from '@/theme';
import {
  fundamentalsConfigured,
  getPriceHistory,
  getStockFinancials,
  type StockFinancials,
  type YearValue,
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
  const { symbol, market, name } = useLocalSearchParams<{ symbol: string; market?: string; name?: string }>();
  const mkt = market === 'KRX' ? 'KRX' : 'US';
  const [fin, setFin] = useState<StockFinancials | null>(null);
  const [priceHist, setPriceHist] = useState<YearValue[]>([]);
  const [loading, setLoading] = useState(true);

  const configured = fundamentalsConfigured();

  const load = useCallback(async () => {
    if (!symbol || !configured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [f, ph] = await Promise.all([getStockFinancials(symbol, mkt), getPriceHistory(symbol, mkt)]);
    setFin(f);
    setPriceHist(ph);
    setLoading(false);
  }, [symbol, mkt, configured]);

  useEffect(() => {
    load();
  }, [load]);

  const f = fin?.fundamentals ?? null;
  const cur = mkt === 'KRX' ? 'KRW' : 'USD';
  const per = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}배` : '—');
  const pct = (n: number | null | undefined) => (n != null ? `${n}%` : '—');
  const epsStr = f?.eps != null ? (mkt === 'KRX' ? `₩${Math.round(f.eps).toLocaleString()}` : `$${f.eps.toFixed(2)}`) : '—';

  return (
    <>
      <Stack.Screen options={{ title: (name as string) || (symbol as string) || '가치분석' }} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
        <View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '900' }}>{(name as string) || symbol}</Text>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            {symbol} · {mkt === 'KRX' ? '🇰🇷 한국' : '🇺🇸 미국'}
          </Text>
        </View>

        {!configured ? (
          <Card style={{ borderColor: colors.warn, borderWidth: 1 }}>
            <Text style={{ color: colors.warn, fontWeight: '800', fontSize: 14 }}>재무 데이터 키가 필요해요</Text>
            <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 20 }}>
              가치분석은 무료 재무 API(Financial Modeling Prep) 키가 있어야 표시돼요.{'\n'}
              financialmodelingprep.com 에서 무료 키를 발급받아 <Text style={{ color: colors.text }}>EXPO_PUBLIC_FMP_KEY</Text> 로
              설정하면 시총·PER·PBR·EPS·ROE·부채비율 + 5년 매출/영업이익/순이익·PER 그래프가 나옵니다.
            </Text>
          </Card>
        ) : loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            {/* 가격 차트 (최근 6개월) */}
            <Card>
              <LineChart title="가격 추이 (최근 6개월)" data={priceHist} color="auto" showYearLabels height={160} />
              {priceHist.length < 2 && (
                <Text style={{ color: colors.textDim, fontSize: 12 }}>가격 데이터를 불러오지 못했어요.</Text>
              )}
            </Card>

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
              </View>
              {!f && <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 6 }}>지표 데이터를 불러오지 못했어요.</Text>}
            </Card>

            {/* 5년 재무 그래프 */}
            <Card>
              <BarChart5y title="매출액 (최근 5년)" data={fin?.revenue ?? []} color={num.evalTotal} formatValue={(n) => abbrevShort(n, cur)} />
            </Card>
            <Card>
              <BarChart5y title="영업이익 (최근 5년)" data={fin?.operatingIncome ?? []} formatValue={(n) => abbrevShort(n, cur)} />
            </Card>
            <Card>
              <BarChart5y title="순이익 (최근 5년)" data={fin?.netIncome ?? []} formatValue={(n) => abbrevShort(n, cur)} />
            </Card>

            {/* 5년 PER 추이 */}
            <Card>
              <LineChart title="PER 추이 (최근 5년)" data={fin?.perHistory ?? []} color={num.base} formatValue={(n) => `${n.toFixed(1)}`} height={150} />
            </Card>

            <Text style={{ color: colors.textDim, fontSize: 11, textAlign: 'center' }}>
              데이터 제공: Financial Modeling Prep · 투자 판단의 책임은 이용자 본인에게 있습니다.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}
