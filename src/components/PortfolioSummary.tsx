// ---------------------------------------------------------------
// 전체 요약 표 — 한국/미국을 나란히 두고 예산·포지션을 한눈에.
//
//   구분        한국주식      미국주식
//   총예산      진행중 프로젝트 예산 합
//   사용예산    보유·주문중 포켓에 묶인 배분 예산
//   잔여예산    총예산 − 사용예산
//   ───────────────────────────────
//   평가금액    현재가 × 보유수량
//   매입원가    평균매수가 × 보유수량
//   평가이익    평가금액 − 매입원가
//
// 프로젝트탭·포켓탭이 같은 계산을 쓰도록 집계 함수도 여기 둔다.
// ---------------------------------------------------------------

import { Text, View } from 'react-native';
import { Card } from '@/components/ui';
import { colors, formatMoney, num, signColor } from '@/theme';
import { computePnL } from '@/domain/pockets';
import type { Pocket, Project, Trade } from '@/types/db';

export interface MarketSummary {
  market: string; // 'KRX' | 'US'
  totalBudget: number;
  usedBudget: number;
  evalAmount: number;
  buyCost: number;
  /** 아직 매수하지 않고 '대기중'인 포켓에 이미 배정된 예산 */
  waitingBudget: number;
  /** 증권사 예수금(D+ 정산). 계좌 미연결·조회 실패면 null */
  deposit?: number | null;
}

/** 배분 예산이 '묶여 있는' 상태 — 매수 주문을 넣었거나 보유 중 */
const IN_USE = new Set(['bought', 'buy_ordered', 'sell_ordered']);

/**
 * 진행중 프로젝트를 시장별로 집계한다.
 * @param priceOf 종목코드 → 현재가 (없으면 null — 평가금액에서 제외)
 */
export function computeMarketSummaries(
  projects: Project[],
  pockets: Pocket[],
  trades: Trade[],
  priceOf: (symbol: string) => number | null
): MarketSummary[] {
  const open = projects.filter((p) => !p.closed_at);
  if (open.length === 0) return [];

  const projById = new Map(open.map((p) => [p.id, p]));
  const acc = new Map<string, MarketSummary>();
  const bucket = (market: string) => {
    let e = acc.get(market);
    if (!e) {
      e = { market, totalBudget: 0, usedBudget: 0, waitingBudget: 0, evalAmount: 0, buyCost: 0 };
      acc.set(market, e);
    }
    return e;
  };

  for (const p of open) bucket(p.market).totalBudget += Number(p.total_budget ?? 0);

  for (const k of pockets) {
    const p = projById.get(k.project_id);
    if (!p) continue;
    if (IN_USE.has(k.status)) bucket(p.market).usedBudget += Number(k.budget ?? 0);
    // 대기중 = 아직 현금이지만 이미 다른 포켓에 배정돼 새로 쓸 수 없는 돈
    else if (k.status === 'waiting') bucket(p.market).waitingBudget += Number(k.budget ?? 0);
  }

  // 포지션은 프로젝트 단위로 (같은 프로젝트의 여러 포켓을 합산)
  const tradesByProject = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!t.project_id || !projById.has(t.project_id)) continue;
    const arr = tradesByProject.get(t.project_id) ?? [];
    arr.push(t);
    tradesByProject.set(t.project_id, arr);
  }
  for (const [projectId, ts] of tradesByProject) {
    const p = projById.get(projectId)!;
    const pnl = computePnL(ts, null);
    if (pnl.totalQtyOpen <= 0) continue;
    const b = bucket(p.market);
    b.buyCost += pnl.avgOpenPrice * pnl.totalQtyOpen;
    const price = priceOf(p.symbol);
    if (price != null && price > 0) b.evalAmount += price * pnl.totalQtyOpen;
  }

  // 한국 → 미국 순서 고정
  return Array.from(acc.values()).sort((a, b) => (a.market === 'KRX' ? -1 : b.market === 'KRX' ? 1 : 0));
}

export interface SummaryRow {
  /** 이 행 위에 붙일 구획 소제목 (한 카드 안에서 성격이 다른 묶음을 나눌 때) */
  section?: string;
  label: string;
  values: (number | null)[];
  color?: string;
  sign?: boolean; // 값 부호에 따라 빨강/파랑
  strong?: boolean;
  divider?: boolean; // 위에 구분선
}

/** 표에 쓸 금액 문자열 (부호 포함) */
function fmtCell(v: number | null, market: string, sign?: boolean): string {
  if (v == null) return '—';
  return `${sign && v > 0 ? '+' : ''}${formatMoney(v, market)}`;
}

function Row({
  section,
  label,
  values,
  markets,
  color,
  sign,
  strong,
  divider,
  size,
}: SummaryRow & { markets: string[]; size: number }) {
  return (
    <>
      {section && (
        <Text
          style={{
            color: colors.textDim,
            fontSize: 10,
            fontWeight: '800',
            marginTop: divider ? 0 : 4,
            paddingTop: divider ? 7 : 0,
            ...(divider ? { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4 } : null),
          }}
        >
          {section}
        </Text>
      )}
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 3,
        ...(divider && !section ? { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 3, paddingTop: 7 } : null),
      }}
    >
      <View style={{ width: 60 }}>
        <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 11 }}>
          {label}
        </Text>
      </View>
      {values.map((v, i) => (
        <View key={markets[i] ?? i} style={{ flex: 1, alignItems: 'flex-end', paddingLeft: 4 }}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.55}
            style={{
              color: v == null ? colors.textDim : sign ? signColor(v) : (color ?? colors.text),
              fontSize: strong ? size + 1 : size,
              fontWeight: strong ? '900' : '800',
            }}
          >
            {fmtCell(v, markets[i], sign)}
          </Text>
        </View>
      ))}
    </View>
    </>
  );
}

/**
 * 시장별(한국/미국) 2열 요약 표. 라벨 열은 고정폭이고 값은 길면 글자가 줄어든다.
 * 프로젝트탭·포켓탭·매매일지가 같은 서식을 쓰도록 공용화.
 */
export function SummaryTable({
  title,
  subtitle,
  markets,
  rows,
  footnote,
  accent = colors.primary,
}: {
  title: string;
  subtitle?: string;
  markets: string[];
  rows: SummaryRow[];
  footnote?: string;
  accent?: string;
}) {
  if (markets.length === 0) return null;
  const label = (m: string) => (m === 'KRX' ? '🇰🇷 한국주식' : '🇺🇸 미국주식');

  // 억 단위(₩1,234,567,890 = 14자)까지 한 줄에 들어가도록,
  // 표 안에서 가장 긴 금액 길이에 맞춰 모든 행의 글자 크기를 함께 낮춘다.
  // (행마다 제각각 줄어들면 표가 지저분해지므로 한 값으로 통일)
  let maxLen = 0;
  for (const r of rows) {
    r.values.forEach((v, i) => {
      maxLen = Math.max(maxLen, fmtCell(v, markets[i], r.sign).length);
    });
  }
  const size = markets.length >= 2
    ? maxLen <= 10 ? 13 : maxLen <= 12 ? 12 : maxLen <= 14 ? 11 : maxLen <= 16 ? 10 : 9
    : maxLen <= 14 ? 14 : maxLen <= 17 ? 13 : 12; // 한 시장만 있으면 폭이 넉넉

  return (
    <Card style={{ borderColor: accent, borderWidth: 1.5, backgroundColor: 'rgba(34,211,166,0.06)', gap: 0, padding: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingBottom: 5,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <View style={{ width: 60 }}>
          <Text numberOfLines={1} style={{ color: accent, fontWeight: '900', fontSize: 12 }}>
            {title}
          </Text>
        </View>
        {markets.map((m) => (
          <View key={m} style={{ flex: 1, alignItems: 'flex-end', paddingLeft: 4 }}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ color: colors.text, fontWeight: '900', fontSize: 12 }}>
              {label(m)}
            </Text>
          </View>
        ))}
      </View>

      {rows.map((r) => (
        <Row key={r.label} {...r} markets={markets} size={size} />
      ))}

      {(subtitle || footnote) && (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 5, marginTop: 6, gap: 1 }}>
          {subtitle && <Text style={{ color: colors.textDim, fontSize: 9 }}>{subtitle}</Text>}
          {footnote && <Text style={{ color: colors.textDim, fontSize: 9 }}>{footnote}</Text>}
        </View>
      )}
    </Card>
  );
}

/** 전체 요약 표 (예산 + 포지션). 진행중 프로젝트가 없으면 아무것도 그리지 않는다. */
export function PortfolioSummary({ summaries }: { summaries: MarketSummary[] }) {
  if (summaries.length === 0) return null;
  const markets = summaries.map((s) => s.market);
  const rows: SummaryRow[] = [
    { label: '총예산', values: summaries.map((s) => s.totalBudget), color: num.budget, strong: true },
    { label: '사용예산', values: summaries.map((s) => s.usedBudget), color: num.position },
    { label: '잔여예산', values: summaries.map((s) => Math.max(0, s.totalBudget - s.usedBudget)), color: num.budget },
    // 미반영예산 = 아직 어떤 포켓에도 배정하지 않은 돈
    //   = 증권사 예수금 − 대기중 포켓에 이미 배정된 예산
    //   (프로젝트를 만들 때 보여주는 '사용가능 예산'과 같은 금액)
    {
      label: '미반영예산',
      values: summaries.map((s) => (s.deposit == null ? null : Math.max(0, s.deposit - s.waitingBudget))),
      color: num.budget,
    },
    { label: '평가금액', values: summaries.map((s) => s.evalAmount), color: num.evalTotal, strong: true, divider: true },
    { label: '매입원가', values: summaries.map((s) => s.buyCost), color: num.position },
    { label: '평가이익', values: summaries.map((s) => (s.buyCost > 0 ? s.evalAmount - s.buyCost : 0)), sign: true, strong: true },
  ];
  const rate = summaries
    .map((s) => (s.buyCost > 0 ? `${label2(s.market)} ${pct(((s.evalAmount - s.buyCost) / s.buyCost) * 100)}` : null))
    .filter(Boolean)
    .join('  ·  ');

  return (
    <SummaryTable
      title="📊 전체"
      markets={markets}
      rows={rows}
      subtitle={rate || undefined}
      footnote="사용예산 = 매수 주문·보유 중인 포켓에 묶인 배분 예산 · 잔여예산 = 총예산 − 사용예산 · 미반영예산 = 예수금 − 대기중 포켓 예산 (프로젝트 생성 시 '사용가능 예산'과 같은 금액)"
    />
  );
}

const label2 = (m: string) => (m === 'KRX' ? '한국' : '미국');
const pct = (v: number) => `수익률 ${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}%`;
