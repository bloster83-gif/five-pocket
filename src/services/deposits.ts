// 증권사 예수금(미반영예산) 조회
//
// 프로젝트 예산으로 아직 잡지 않은 돈 = 증권사 계좌에 그냥 남아 있는 예수금.
// 프로젝트탭·포켓탭의 전체 요약 표에서 '미반영예산' 행으로 보여준다.
//
//   · 한국 = 국내 잔고의 예수금(D+2 정산, 원화)
//   · 미국 = 해외 잔고의 외화 예수금(D+1 정산, 달러)
//
// 두 탭이 번갈아 포커스될 때마다 KIS 를 두드리지 않도록 모듈 캐시(60초)를 둔다.
// 웹/Expo Go(kisOrderBlocked)나 계좌 미연결이면 조용히 null 을 돌려준다 — 표에는 '—' 로 뜬다.

import { useEffect, useState } from 'react';
import { getDomesticBalance, getOverseasBalance, kisOrderBlocked } from '@/services/broker/kis';
import type { BrokerAccount } from '@/types/db';

/** 시장코드('KRX' | 'US') → 예수금. 조회 실패·미지원이면 값 없음 */
export type Deposits = Record<string, number | null>;

const TTL_MS = 60_000;
let cache: { key: string; at: number; value: Deposits } | null = null;
let inflight: { key: string; promise: Promise<Deposits> } | null = null;

/** 계좌의 원화·달러 예수금을 조회한다(60초 캐시). 실패한 쪽만 null 이 된다. */
export async function fetchDeposits(account: BrokerAccount): Promise<Deposits> {
  const key = `${account.user_id}:${account.account_no}-${account.account_product_code}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.value;
  if (inflight && inflight.key === key) return inflight.promise;

  const run = (async (): Promise<Deposits> => {
    const [dom, ov] = await Promise.allSettled([
      getDomesticBalance(account),
      getOverseasBalance(account),
    ]);
    const value: Deposits = {
      KRX: dom.status === 'fulfilled' ? Number(dom.value.cash ?? 0) : null,
      US: ov.status === 'fulfilled' ? Number(ov.value.cash ?? 0) : null,
    };
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
export function clearDepositsCache() {
  cache = null;
}

/** 요약 표에 넣을 예수금. 계좌가 없거나 조회 불가면 전부 null 로 유지된다. */
export function useDeposits(account: BrokerAccount | null | undefined): Deposits {
  const [deposits, setDeposits] = useState<Deposits>({});

  useEffect(() => {
    if (!account || kisOrderBlocked('KRX')) {
      setDeposits({});
      return;
    }
    let alive = true;
    fetchDeposits(account)
      .then((d) => alive && setDeposits(d))
      .catch(() => alive && setDeposits({}));
    return () => {
      alive = false;
    };
  }, [account?.user_id, account?.account_no, account?.account_product_code]); // eslint-disable-line react-hooks/exhaustive-deps

  return deposits;
}
