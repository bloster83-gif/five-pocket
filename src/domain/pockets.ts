// =====================================================================
// 5-Pocket 매매 로직 (순수 함수) — 앱의 핵심 계산이 전부 여기 모여 있음
//
// 전략:
//  - 기준가(base_price)에서 시작해 매수 간격(buy_interval_pct)만큼
//    가격이 내려갈 때마다 다음 포켓을 매수한다.
//      포켓 0 매수가 = base
//      포켓 1 매수가 = base * (1 - 5%)
//      포켓 2 매수가 = base * (1 - 10%)  ... (간격 5% 예시)
//  - 각 포켓은 "실제 체결가 대비" 매도 목표 수익률(sell_target_pct)에
//    도달하면 매도한다.  체결 전에는 매수 목표가를 기준으로 예상 매도가를 보여준다.
// =====================================================================

import type { Pocket, PocketSeed, Trade } from '@/types/db';

// 기본 포켓 수 5개 (원하면 6~10개까지 늘릴 수 있음)
export const POCKET_COUNT = 5;
export const MIN_POCKET_COUNT = 5;
export const MAX_POCKET_COUNT = 10;

/** 포켓 개수를 허용 범위(5~10)로 보정 */
export function clampPocketCount(n: number | null | undefined): number {
  const v = Math.floor(Number(n) || POCKET_COUNT);
  return Math.min(MAX_POCKET_COUNT, Math.max(MIN_POCKET_COUNT, v));
}

export interface StrategyInput {
  basePrice: number;
  buyIntervalPct: number; // 예: 5  → 포켓마다 5%씩 낮게 매수
  sellTargetPct: number; // 예: 10 → 체결가 대비 +10%에서 매도
  totalBudget?: number | null; // 프로젝트 전체 예산(선택)
  weights?: number[]; // 포켓별 비중(%). 미지정 시 균등(100/개수)
  pocketCount?: number; // 포켓 개수(기본 5, 6~10 가능)
  market?: string; // 'KRX'면 목표가를 호가단위에 맞춰 정렬
}

/**
 * KRX 호가단위(틱) — 2023-01-25 개편 기준 (일반주식·리츠·ETF 공통).
 * (KIS 주문도 이 단위의 배수만 허용 → 목표가를 여기 맞춰야 '주식주문호가단위 오류'가 안 남)
 */
export function krxTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** 가격을 KRX 호가단위에 맞춰 정렬 (매수=내림, 매도=올림, 그 외=반올림) */
export function alignToKrxTick(price: number, side?: 'buy' | 'sell'): number {
  const p = Math.round(price);
  if (p <= 0) return 0;
  const t = krxTickSize(p);
  const aligned =
    side === 'buy' ? Math.floor(p / t) * t : side === 'sell' ? Math.ceil(p / t) * t : Math.round(p / t) * t;
  return Math.max(t, aligned);
}

/** 비중 배열을 정규화(합계 100%가 되도록). 합이 0이면 균등 분배. */
export function normalizeWeights(weights: number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum <= 0) return clean.map(() => round2(100 / clean.length));
  return clean.map((w) => round2((w / sum) * 100));
}

/**
 * 전략으로부터 각 포켓의 매수 목표가 / (예상)매도 목표가 / 비중 / 배분액을 계산한다.
 * 포켓은 항상 5개. 반환 배열은 idx 오름차순.
 */
export function buildPocketSeeds(s: StrategyInput): PocketSeed[] {
  const count = s.pocketCount ? clampPocketCount(s.pocketCount) : POCKET_COUNT;
  const rawWeights = s.weights && s.weights.length === count ? s.weights : Array(count).fill(100 / count);
  const weights = normalizeWeights(rawWeights);
  const isKrx = s.market === 'KRX';
  const seeds: PocketSeed[] = [];
  for (let i = 0; i < count; i++) {
    let buy = round4(s.basePrice * (1 - (s.buyIntervalPct / 100) * i));
    let sell = round4(buy * (1 + s.sellTargetPct / 100));
    // KRX 는 호가단위 배수만 주문 가능 → 매수는 내림, 매도는 올림으로 정렬해 저장
    if (isKrx) {
      buy = alignToKrxTick(buy, 'buy');
      sell = alignToKrxTick(sell, 'sell');
    }
    const budget = s.totalBudget && s.totalBudget > 0 ? round2((s.totalBudget * weights[i]) / 100) : null;
    seeds.push({ idx: i, buy_target_price: buy, sell_target_price: sell, weight: weights[i], budget });
  }
  return seeds;
}

/** 배분액과 매수 목표가로 예상 매수 수량(정수)을 계산 (참고용). */
/**
 * 프로젝트 총예산이 포켓 배분액의 합과 어긋난 경우를 찾아낸다.
 *
 * 프로젝트 예산은 생성 시 포켓들에 전액 배분되므로 `총예산 = Σ 포켓 배분액` 이 항상 성립해야 한다.
 * 포켓이 삭제되면 총예산도 줄어야 하는데, '삭제할 때 빼기' 방식은 그 코드를 거치지 않은
 * 경로(과거 데이터·다른 화면)를 놓친다. 그래서 별도 카운터를 믿지 않고 매번 합에서 유도한다.
 *
 * 배분액이 하나라도 비어 있는 프로젝트는 판단하지 않는다 (부분 배분 상태일 수 있으므로).
 */
export function findBudgetMismatches<
  P extends { id: string; total_budget: number | null },
  K extends { project_id: string; budget: number | null },
>(projects: P[], pockets: K[]): { id: string; current: number; correct: number }[] {
  const byProject = new Map<string, K[]>();
  pockets.forEach((k) => {
    const arr = byProject.get(k.project_id) ?? [];
    arr.push(k);
    byProject.set(k.project_id, arr);
  });

  const out: { id: string; current: number; correct: number }[] = [];
  for (const p of projects) {
    if (p.total_budget == null) continue;
    const ks = byProject.get(p.id);
    if (!ks || ks.length === 0) continue; // 포켓이 없으면 판단 보류 (예산만 잡아둔 상태일 수 있음)
    if (ks.some((k) => k.budget == null)) continue; // 배분이 덜 된 상태
    const sum = ks.reduce((s, k) => s + Number(k.budget), 0);
    const cur = Number(p.total_budget);
    if (Math.abs(sum - cur) > 0.01) out.push({ id: p.id, current: cur, correct: sum });
  }
  return out;
}

export function estimatedShares(budget: number | null, price: number): number {
  if (!budget || budget <= 0 || price <= 0) return 0;
  return Math.floor(budget / price);
}

/**
 * 포켓이 실제로 체결된 뒤, 그 체결가를 기준으로 매도 목표가를 다시 계산.
 * (매수 목표가와 실제 체결가가 다를 수 있으므로)
 */
export function sellTargetFromFill(fillPrice: number, sellTargetPct: number): number {
  return round4(fillPrice * (1 + sellTargetPct / 100));
}

// --------------------------- 알림 판정 ---------------------------

export interface PriceSignal {
  /** buy = 매수 포인트 / sell = 매도 목표가 / stop = 마지노선(손절) 하한 도달 */
  kind: 'buy' | 'sell' | 'stop';
  pocket: Pocket;
  targetPrice: number;
  currentPrice: number;
}

/** 마지노선(손절)이 설정된 포켓인지 — 0 이하나 null 은 '사용 안 함'으로 본다 */
export function stopPriceOf(p: Pocket): number | null {
  const v = p.stop_price == null ? null : Number(p.stop_price);
  return v != null && v > 0 ? v : null;
}

/**
 * 현재가를 받아 어떤 알림을 울려야 하는지 판정한다.
 *  - 매수 신호: 아직 'waiting' 인 포켓 중, 현재가 <= 매수 목표가
 *  - 매도 신호: 'bought' 인 포켓 중, 현재가 >= 매도 목표가
 *  - 손절 신호: 'bought' 인 포켓 중, 마지노선이 설정되어 있고 현재가 <= 마지노선
 *
 * 손절을 매도보다 먼저 본다. 둘이 동시에 성립할 수는 없지만(마지노선 < 매도목표),
 * 사용자가 마지노선을 매도목표 위로 잘못 넣었을 때 '무조건 판다'는 쪽이 안전하다.
 * (실제 발송 중복 방지는 price_alerts 이력으로 별도 처리)
 */
export function evaluateSignals(pockets: Pocket[], currentPrice: number): PriceSignal[] {
  const signals: PriceSignal[] = [];
  for (const p of pockets) {
    if (p.status === 'waiting' && currentPrice <= p.buy_target_price) {
      signals.push({ kind: 'buy', pocket: p, targetPrice: p.buy_target_price, currentPrice });
      continue;
    }
    if (p.status !== 'bought') continue;

    const stop = stopPriceOf(p);
    if (stop != null && currentPrice <= stop) {
      signals.push({ kind: 'stop', pocket: p, targetPrice: stop, currentPrice });
    } else if (p.sell_target_price != null && currentPrice >= p.sell_target_price) {
      signals.push({ kind: 'sell', pocket: p, targetPrice: p.sell_target_price, currentPrice });
    }
  }
  return signals;
}

// --------------------------- 손익 계산 ---------------------------

export interface PnL {
  realized: number; // 실현 손익 (매도 완료분)
  unrealized: number; // 평가 손익 (매수 후 미매도분, 현재가 기준)
  investedOpen: number; // 미매도 포켓에 투입된 원금
  totalQtyOpen: number; // 미매도 수량
  avgOpenPrice: number; // 미매도분 평단가
}

/**
 * 거래 기록 + 현재가로 실현/평가 손익을 계산.
 *
 * 포켓은 여러 번 "순환"할 수 있다 (매수→매도 완료 후 재시작해서 또 매수→매도).
 * 그래서 포켓별로 체결을 시간순으로 처리하며, 포지션이 0이 되면 원가를 리셋한다.
 *  - 실현손익: 각 매도 시점의 평균단가 기준으로 누적 (모든 순환 포함)
 *  - 평가손익: 현재 열려있는(미매도) 포지션만 현재가로 평가
 */
export function computePnL(trades: Trade[], currentPrice: number | null): PnL {
  // 포켓별 그룹핑 (포켓 없는 체결은 각각 독립 처리)
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.pocket_id ?? `solo-${t.id}`;
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  let realized = 0;
  let openQty = 0;
  let openCost = 0;

  for (const g of groups.values()) {
    g.sort((a, b) => (a.executed_at < b.executed_at ? -1 : a.executed_at > b.executed_at ? 1 : 0));
    let pos = 0; // 음수 허용: 기록 날짜가 어긋나 매도가 매수보다 먼저 와도 나중 매수와 상쇄된다
    let cost = 0;
    for (const t of g) {
      if (t.side === 'buy') {
        if (pos < 0) {
          // 선기록된 매도 빚을 먼저 갚는다 (원가에는 반영하지 않음)
          const repay = Math.min(t.quantity, -pos);
          pos += repay;
          const rest = t.quantity - repay;
          if (rest > 0) {
            pos += rest;
            cost += rest * t.price;
          }
        } else {
          pos += t.quantity;
          cost += t.quantity * t.price;
        }
      } else if (pos > 0) {
        const avg = cost / pos;
        const q = Math.min(t.quantity, pos);
        realized += (t.price - avg) * q;
        pos -= q;
        cost -= avg * q;
        const rest = t.quantity - q;
        if (rest > 0) pos -= rest; // 초과 매도분은 빚으로 (날짜 어긋난 기록 대비)
        if (Math.abs(pos) <= 1e-9) {
          // 순환 완료 → 원가 리셋 (다음 매수부터 새 사이클)
          pos = 0;
          cost = 0;
        }
      } else {
        // 매수 기록이 아직 없는(또는 날짜가 뒤인) 매도 — 빚으로 기록해 나중 매수와 상쇄
        pos -= t.quantity;
      }
    }
    openQty += Math.max(pos, 0);
    openCost += pos > 0 ? cost : 0;
  }

  const avgBuy = openQty > 0 ? openCost / openQty : 0;
  const unrealized = currentPrice != null && openQty > 0 ? (currentPrice - avgBuy) * openQty : 0;

  return {
    realized: round4(realized),
    unrealized: round4(unrealized),
    investedOpen: round4(openCost),
    totalQtyOpen: round4(openQty),
    avgOpenPrice: round4(avgBuy),
  };
}

export function pnlPct(pnl: PnL): number {
  if (pnl.investedOpen <= 0) return 0;
  return round2((pnl.unrealized / pnl.investedOpen) * 100);
}

// --------------------------- 실현손익 이벤트 ---------------------------

export interface RealizedEvent {
  at: string; // 매도 체결 시각 (ISO)
  amount: number; // 이 매도로 실현된 손익
  trade: Trade; // 해당 매도 체결
}

/**
 * 매도 체결 하나하나의 실현손익을 시간순으로 계산해 이벤트로 반환.
 * (기간/종목별 합산 검색, 연도별 실현수익 계산에 사용)
 * 포켓 단위(독립 체결은 종목 단위)로 평균단가를 추적하며, 포지션 0이 되면 원가 리셋(순환 대응).
 */
export function realizedEvents(trades: Trade[]): RealizedEvent[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.pocket_id ?? (t.symbol ? `solo-${t.symbol}` : `solo-${t.id}`);
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  const events: RealizedEvent[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.executed_at < b.executed_at ? -1 : a.executed_at > b.executed_at ? 1 : 0));
    let pos = 0; // 음수 허용 (computePnL 과 동일한 날짜 어긋남 대비)
    let cost = 0;
    for (const t of g) {
      if (t.side === 'buy') {
        if (pos < 0) {
          const repay = Math.min(t.quantity, -pos);
          pos += repay;
          const rest = t.quantity - repay;
          if (rest > 0) {
            pos += rest;
            cost += rest * t.price;
          }
        } else {
          pos += t.quantity;
          cost += t.quantity * t.price;
        }
      } else if (pos > 0) {
        const avg = cost / pos;
        const q = Math.min(t.quantity, pos);
        events.push({ at: t.executed_at, amount: round4((t.price - avg) * q), trade: t });
        pos -= q;
        cost -= avg * q;
        const rest = t.quantity - q;
        if (rest > 0) pos -= rest;
        if (Math.abs(pos) <= 1e-9) {
          pos = 0;
          cost = 0;
        }
      } else {
        pos -= t.quantity; // 짝 없는 매도 — 실현손익은 계산 불가, 수량만 상쇄 대기
      }
    }
  }
  return events.sort((a, b) => (a.at < b.at ? -1 : 1));
}

// --------------------------- 유틸 ---------------------------

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
