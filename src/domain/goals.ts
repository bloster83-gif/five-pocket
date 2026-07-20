// =====================================================================
// 인생목표 계산 (순수 함수) — 매년 리베이스(rolling rebase) 방식
//  - 매 연도, 그 해 "년초 이월금액"(= 전년 실제달성액, 없으면 전년 계획)을 기준으로
//    목표나이까지 남은 기간에 필요한 연 수익률을 다시 계산하고, 그 해 말 목표금액을
//    year_start * (1 + r) 로 잡는다. → 현재 자금 상황에 맞춰 매년 계획이 재설정됨.
//  - 첫 해: 년초 이월 = 시작자산. 그 해 말 목표 = 시작자산 * (1 + r0). (첫 해부터 성장 반영)
//  - 목표나이(마지막 해): 목표 자산 그대로.
//  - 연도별: 년초이월금액 / 입출금 / 실제달성액 / 수익금액(입출금 제외) / 수익률
//      수익금액 = 실제달성액 - 년초이월 - 입출금
//      수익률  = 수익금액 / 년초이월 * 100
// =====================================================================

export interface GoalRow {
  year: number;
  age: number;
  planned: number; // 계획 목표금액 (빨강)
  carryover: number; // 년초 이월 금액 (전년 말 잔액 = 전년 실제, 없으면 전년 계획)
  actual: number | null; // 실제 달성액 (연말 잔액)
  deposit: number; // 순 입출금 (외부 자금: 입금 - 출금)
  dividend: number; // 배당금 (투자 수익의 일부)
  profit: number | null; // 수익금액 = 실현손익 + 배당금 (입출금 제외)
  returnPct: number | null; // 수익률 %
}

export function requiredAnnualReturn(start: number, target: number, years: number): number {
  if (start <= 0 || years <= 0 || target <= 0) return 0;
  return Math.pow(target / start, 1 / years) - 1;
}

export function buildGoalRows(
  currentAge: number,
  targetAge: number,
  startAsset: number,
  targetAsset: number,
  baseYear: number,
  actuals: Record<number, number>,
  deposits: Record<number, number> = {},
  dividends: Record<number, number> = {}
): { rows: GoalRow[]; annualReturn: number; forwardReturn: number } {
  const years = Math.max(targetAge - currentAge, 0);

  const rows: GoalRow[] = [];
  const planned: number[] = [];
  let firstYearReturn = 0; // 첫 해 기준 필요수익률 (시작자산 기준)

  for (let i = 0; i <= years; i++) {
    const year = baseYear + i;
    const age = currentAge + i;
    // 년초 이월 = 첫 해는 시작자산, 그 외는 전년 실제(있으면) 아니면 전년 계획
    const carryover = i === 0 ? startAsset : actuals[year - 1] ?? planned[i - 1];
    // 이 해 말까지 남은 성장 연수 (목표 나이까지). 매년 이월금액 기준으로 필요수익률 재계산.
    const remaining = targetAge - age;
    let plan: number;
    let r = 0;
    if (remaining <= 0) {
      plan = Math.round(targetAsset); // 목표 나이엔 목표 자산 그대로
    } else {
      r = requiredAnnualReturn(carryover, targetAsset, remaining);
      plan = Math.round(carryover * (1 + r));
    }
    planned.push(plan);
    if (i === 0) firstYearReturn = r;

    const actual = actuals[year] ?? null;
    const deposit = deposits[year] ?? 0;
    const dividend = dividends[year] ?? 0;
    let profit: number | null = null;
    let returnPct: number | null = null;
    if (actual != null) {
      // 수익금액 = 실제달성 - 이월 - 순입출금 (배당금은 수익에 포함됨)
      profit = Math.round(actual - carryover - deposit);
      returnPct = carryover > 0 ? Math.round((profit / carryover) * 10000) / 100 : null;
    }
    rows.push({ year, age, planned: plan, carryover, actual, deposit, dividend, profit, returnPct });
  }

  // 앞으로 매년 필요한 수익률 = 가장 최근 실제달성액 기준으로 목표까지 재계산 (없으면 첫 해 기준)
  let lastActualYear = -1;
  let lastActualAmount = startAsset;
  for (let i = 0; i <= years; i++) {
    if (actuals[baseYear + i] != null) {
      lastActualYear = baseYear + i;
      lastActualAmount = actuals[baseYear + i];
    }
  }
  let forwardReturn = firstYearReturn;
  if (lastActualYear >= 0) {
    const ageThen = currentAge + (lastActualYear - baseYear);
    const remaining = targetAge - ageThen;
    forwardReturn = remaining > 0 ? requiredAnnualReturn(lastActualAmount, targetAsset, remaining) : 0;
  }

  return {
    rows,
    annualReturn: Math.round(firstYearReturn * 10000) / 100,
    forwardReturn: Math.round(forwardReturn * 10000) / 100,
  };
}
