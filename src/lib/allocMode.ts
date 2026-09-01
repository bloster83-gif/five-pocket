// 포켓 예산 배분 방식 — 비중(%) ↔ 금액
//
// 화면은 늘 '비중'으로 계산한다(buildPocketSeeds 가 비중을 받는다).
// 금액으로 넣고 싶을 때는 여기서 금액 → 비중·총예산으로 바꿔 넣어준다.
//   · 금액 모드에서 총 예산 = 포켓 금액의 합 (그래서 총예산 칸은 읽기 전용이 된다)
//   · 비중 모드로 돌아가도 방금 금액으로 만든 비중이 그대로 남는다
//
// 프로젝트 생성·수정 두 화면이 같은 규칙을 쓰도록 훅으로 뺐다.

import { useEffect, useState } from 'react';
import { normalizeWeights } from '@/domain/pockets';

export type AllocMode = 'pct' | 'amount';

export function useAllocMode(
  market: string,
  weights: string[],
  setWeights: (w: string[]) => void,
  totalBudget: string,
  setTotalBudget: (v: string) => void
) {
  const [mode, setMode] = useState<AllocMode>('pct');
  const [amounts, setAmounts] = useState<string[]>(() => weights.map(() => ''));
  const decimals = market !== 'KRX'; // 원화는 소수점 없음

  // 포켓 개수가 바뀌면 금액 칸 수도 맞춘다
  useEffect(() => {
    setAmounts((a) => (a.length === weights.length ? a : weights.map((_, i) => a[i] ?? '')));
  }, [weights.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const round = (v: number) => (decimals ? Math.round(v * 100) / 100 : Math.round(v));

  /** 금액 목록 → 비중·총예산 반영 */
  const apply = (list: string[]) => {
    const nums = list.map((a) => Number(a) || 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    setTotalBudget(sum > 0 ? String(round(sum)) : '');
    // 비중은 소수 4자리까지 남겨 금액이 거의 그대로 복원되게 한다
    setWeights(nums.map((v) => (sum > 0 ? String(Math.round((v / sum) * 1e6) / 1e4) : '0')));
  };

  /** 모드 전환 — 금액 모드로 들어갈 때 지금 비중대로 금액을 채워 넣는다 */
  const changeMode = (next: AllocMode) => {
    if (next === 'amount') {
      const total = Number(totalBudget) || 0;
      const norm = normalizeWeights(weights.map((w) => Number(w) || 0));
      setAmounts(norm.map((p) => (total > 0 ? String(round((total * p) / 100)) : '')));
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

  const sum = amounts.reduce((a, b) => a + (Number(b) || 0), 0);

  return { mode, changeMode, amounts, setAmount, setAllAmounts, sum, decimals, round };
}
