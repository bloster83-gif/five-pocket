// =====================================================================
// 인생목표 계산 (순수 함수)
//  - 현재나이·목표나이·시작자산·목표자산 → 필요한 연 수익률(CAGR)
//  - 나이(연도)별 계획 목표금액. 실제 달성액을 입력하면 그 시점부터 목표까지 재계산(리베이스)
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
  const r0 = requiredAnnualReturn(startAsset, targetAsset, years);

  // 가장 최근 실제값 = 리베이스 기준점
  let lastIdx = -1;
  let lastAmount = startAsset;
  for (let i = 0; i <= years; i++) {
    if (actuals[baseYear + i] != null) {
      lastIdx = i;
      lastAmount = actuals[baseYear + i];
    }
  }
  const rFwd = lastIdx >= 0 && lastIdx < years ? requiredAnnualReturn(lastAmount, targetAsset, years - lastIdx) : r0;

  const planned: number[] = [];
  for (let i = 0; i <= years; i++) {
    if (lastIdx < 0 || i < lastIdx) planned.push(Math.round(startAsset * Math.pow(1 + r0, i)));
    else planned.push(Math.round(lastAmount * Math.pow(1 + rFwd, i - lastIdx)));
  }

  const rows: GoalRow[] = [];
  for (let i = 0; i <= years; i++) {
    const year = baseYear + i;
    const actual = actuals[year] ?? null;
    const deposit = deposits[year] ?? 0;
    const dividend = dividends[year] ?? 0;
    // 년초 이월 = 전년 실제(있으면) 아니면 전년 계획, 첫 해는 시작자산
    const carryover = i === 0 ? startAsset : actuals[year - 1] ?? planned[i - 1];
    let profit: number | null = null;
    let returnPct: number | null = null;
    if (actual != null) {
      // 수익금액 = 실제달성 - 이월 - 순입출금 (배당금은 수익에 포함됨)
      profit = Math.round(actual - carryover - deposit);
      returnPct = carryover > 0 ? Math.round((profit / carryover) * 10000) / 100 : null;
    }
    rows.push({ year, age: currentAge + i, planned: planned[i], carryover, actual, deposit, dividend, profit, returnPct });
  }
  return {
    rows,
    annualReturn: Math.round(r0 * 10000) / 100,
    forwardReturn: Math.round(rFwd * 10000) / 100,
  };
}
