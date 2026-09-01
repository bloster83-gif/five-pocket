// 증권사 계좌 잔고 조회 (총자산·예수금)
//
// 프로젝트탭·포켓탭의 전체 요약 표에서 '총자산'과 '사용가능 예산' 행에 쓴다.
//
//   · 예수금   한국 = 국내 잔고(D+2 정산, 원화) / 미국 = 외화 예수금(D+1 정산, 달러)
//   · 총자산   한국 = 계좌 총평가금액(tot_evlu_amt, 증권사 앱에 찍히는 값)
//              미국 = 평가금액 + 외화 예수금 (달러)
//     — MY탭에 보이는 총자산과 같은 데이터. 여기서는 시장별로 나눠 보여준다.
//
// 두 탭이 번갈아 포커스될 때마다 KIS 를 두드리지 않도록 모듈 캐시(60초)를 둔다.
// 웹/Expo Go(kisOrderBlocked)나 계좌 미연결이면 조용히 null 을 돌려준다 — 표에는 '—' 로 뜬다.

import { useEffect, useState } from 'react';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

export interface MarketCash {
  /** 예수금 (주문 가능 현금) */
  deposit: number | null;
  /** 계좌 총자산 (평가금액 + 예수금) */
  totalAsset: number | null;
}

/** 시장코드('KRX' | 'US') → 잔고. 조회 실패·미지원이면 값 없음 */
export type AccountCash = Record<string, MarketCash>;

const TTL_MS = 60_000;
let cache: { key: string; at: number; value: AccountCash } | null = null;
let inflight: { key: string; promise: Promise<AccountCash> } | null = null;

/** 계좌의 원화·달러 잔고를 조회한다(60초 캐시). 실패한 쪽만 값이 비게 된다. */
export async function fetchAccountCash(account: BrokerAccount): Promise<AccountCash> {
  const key = `${account.user_id}:${account.account_no}-${account.account_product_code}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.value;
  if (inflight && inflight.key === key) return inflight.promise;

  const run = (async (): Promise<AccountCash> => {
    const [dom, ov] = await Promise.allSettled([
      getDomesticBalance(account),
      getOverseasBalance(account),
    ]);
    const empty: MarketCash = { deposit: null, totalAsset: null };
    let krx = empty;
    if (dom.status === 'fulfilled') {
      const b = dom.value;
      const cash = Number(b.cash ?? 0);
      // 증권사가 주는 계좌 총평가금액을 그대로 쓰고, 없으면 평가금액+예수금으로 대신한다 (MY탭과 동일)
      const total = Number(b.totalAsset ?? 0);
      krx = { deposit: cash, totalAsset: total > 0 ? total : Number(b.totalEval ?? 0) + cash };
    }
    let us = empty;
    if (ov.status === 'fulfilled') {
      const b = ov.value;
      const cash = Number(b.cash ?? 0);
      us = { deposit: cash, totalAsset: Number(b.totalEval ?? 0) + cash };
    }
    const value: AccountCash = { KRX: krx, US: us };
    cache = { key, at: Date.now(), value };
    return value;
  })();

  inflight = { key, promise: run };
  try {
    return await run;
  } finally {
    if (inflight?.promise === run) inflight = null;
  }
}

/** 다음 조회가 캐시를 건너뛰도록 비운다 (예: 당겨서 새로고침) */
export function clearAccountCashCache() {
  cache = null;
}

/** 요약 표에 넣을 계좌 잔고. 계좌가 없거나 조회 불가면 비어 있다(표에는 '—'). */
export function useAccountCash(account: BrokerAccount | null | undefined): AccountCash {
  const [cash, setCash] = useState<AccountCash>({});

  useEffect(() => {
    if (!account || kisOrderBlocked('KRX')) {
      setCash({});
      return;
    }
    let alive = true;
    fetchAccountCash(account)
      .then((d) => alive && setCash(d))
      .catch(() => alive && setCash({}));
    return () => {
      alive = false;
    };
  }, [account?.user_id, account?.account_no, account?.account_product_code]); // eslint-disable-line react-hooks/exhaustive-deps

  return cash;
}
