// 포켓 예산 배분 방식 — 비중(%) ↔ 금액 ↔ 수량(주)
//
// 화면은 늘 '비중'으로 계산한다(buildPocketSeeds 가 비중을 받는다).
// 금액·수량으로 넣고 싶을 때는 여기서 금액 → 비중·총예산으로 바꿔 넣어준다.
//   · 금액 모드에서 총 예산 = 포켓 금액의 합 (그래서 총예산 칸은 읽기 전용이 된다)
//   · 수량 모드에서 포켓 금액 = 수량 × 그 포켓의 매수가(priceOf) → 총 예산도 그 합으로 따라온다
//   · 비중 모드로 돌아가도 방금 만든 비중이 그대로 남는다
//
// 비중은 소수 2자리로 정규화되므로 금액이 몇 원 어긋날 수 있다 → `budgets` 를 seeds 에 같이 넘겨
// 금액·수량 모드에서는 입력한 금액이 그대로 포켓 배분액이 되게 한다.
//
// 프로젝트 생성·수정 두 화면이 같은 규칙을 쓰도록 훅으로 뺐다.

import { useEffect, useMemo, useState } from 'react';
import { normalizeWeights } from '@/domain/pockets';

export type AllocMode = 'pct' | 'amount' | 'qty';

export function useAllocMode(
  market: string,
  weights: string[],
  setWeights: (w: string[]) => void,
  totalBudget: string,
  setTotalBudget: (v: string) => void,
  /** 포켓 i 의 예상 매수가 (수량 모드용). 정액매수법 = 포켓 목표가, 정기매수법 = 현재가 */
  priceOf?: (i: number) => number
) {
  const [mode, setMode] = useState<AllocMode>('pct');
  const [amounts, setAmounts] = useState<string[]>(() => weights.map(() => ''));
  const [qtys, setQtys] = useState<string[]>(() => weights.map(() => ''));
  const decimals = market !== 'KRX'; // 원화는 소수점 없음

  // 포켓 개수가 바뀌면 금액·수량 칸 수도 맞춘다
  useEffect(() => {
    setAmounts((a) => (a.length === weights.length ? a : weights.map((_, i) => a[i] ?? '')));
    setQtys((q) => (q.length === weights.length ? q : weights.map((_, i) => q[i] ?? '')));
  }, [weights.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const round = (v: number) => (decimals ? Math.round(v * 100) / 100 : Math.round(v));
  const price = (i: number) => {
    const p = priceOf ? Number(priceOf(i)) : 0;
    return Number.isFinite(p) && p > 0 ? p : 0;
  };

  /** 금액 목록 → 비중·총예산 반영 */
  const apply = (list: string[]) => {
    const nums = list.map((a) => Number(a) || 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    setTotalBudget(sum > 0 ? String(round(sum)) : '');
    // 비중은 소수 4자리까지 남겨 금액이 거의 그대로 복원되게 한다
    setWeights(nums.map((v) => (sum > 0 ? String(Math.round((v / sum) * 1e6) / 1e4) : '0')));
  };

  /** 수량 목록 → 금액(수량 × 매수가) → 비중·총예산 */
  const applyQty = (list: string[]) => {
    const amt = list.map((q, i) => {
      const n = Math.floor(Number(q) || 0);
      const p = price(i);
      return n > 0 && p > 0 ? String(round(n * p)) : '';
    });
    setAmounts(amt);
    apply(amt);
  };

  /** 지금 비중·총예산대로 포켓별 금액 */
  const amountsFromWeights = () => {
    const total = Number(totalBudget) || 0;
    const norm = normalizeWeights(weights.map((w) => Number(w) || 0));
    return norm.map((p) => (total > 0 ? round((total * p) / 100) : 0));
  };

  /** 모드 전환 — 금액·수량 모드로 들어갈 때 지금 비중대로 칸을 채워 넣는다 */
  const changeMode = (next: AllocMode) => {
    if (next === mode) return;
    if (next === 'amount') {
      setAmounts(amountsFromWeights().map((v) => (v > 0 ? String(v) : '')));
    } else if (next === 'qty') {
      // 지금 배분액으로 살 수 있는 수량을 채우고, 예산은 '수량 × 매수가'로 다시 맞춘다
      const q = amountsFromWeights().map((v, i) => {
        const p = price(i);
        const n = p > 0 ? Math.floor(v / p) : 0;
        return n > 0 ? String(n) : '';
      });
      setQtys(q);
      // 매수가를 아직 모르면(기준가·현재가 없음) 예산을 지우지 않고 칸만 비워 둔다
      if (weights.some((_, i) => price(i) > 0)) applyQty(q);
    }
    setMode(next);
  };

  const setAmount = (i: number, v: string) => {
    const next = [...amounts];
    next[i] = v;
    setAmounts(next);
    apply(next);
  };

  /** 여러 칸을 한 번에 (균등 분배·전액 입력) */
  const setAllAmounts = (list: string[]) => {
    setAmounts(list);
    apply(list);
  };

  const setQty = (i: number, v: string) => {
    const next = [...qtys];
    next[i] = v;
    setQtys(next);
    applyQty(next);
  };

  const setAllQtys = (list: string[]) => {
    setQtys(list);
    applyQty(list);
  };

  /** 총액을 포켓 수로 나눠 각 포켓 매수가로 살 수 있는 수량 (수량 모드의 균등 분배·전액 입력) */
  const equalQtys = (total: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const p = price(i);
      const n = p > 0 && total > 0 ? Math.floor(total / count / p) : 0;
      return n > 0 ? String(n) : '';
    });

  // 수량 모드에서 매수가(기준가·간격·현재가)가 바뀌면 같은 수량으로 금액을 다시 계산
  const priceKey = weights.map((_, i) => price(i)).join(',');
  useEffect(() => {
    if (mode === 'qty') applyQty(qtys);
  }, [priceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = amounts.reduce((a, b) => a + (Number(b) || 0), 0);
  const qtySum = qtys.reduce((a, b) => a + Math.floor(Number(b) || 0), 0);

  /** seeds 에 넘길 포켓별 배분액 — 비중 모드는 undefined(총예산 × 비중으로 계산) */
  const budgets = useMemo(
    () => (mode === 'pct' ? undefined : amounts.map((a) => Number(a) || 0)),
    [mode, amounts]
  );

  return {
    mode,
    changeMode,
    amounts,
    setAmount,
    setAllAmounts,
    qtys,
    setQty,
    setAllQtys,
    equalQtys,
    priceOf: price,
    sum,
    qtySum,
    budgets,
    decimals,
    round,
  };
}
