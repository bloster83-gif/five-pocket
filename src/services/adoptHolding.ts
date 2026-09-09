// 계좌에만 있는 보유 종목을 프로젝트로 '잡아오기'
//
// 앱이 모르는 보유분(진행중 프로젝트가 없는 종목)을 한 번에 관리 대상으로 만든다.
//   ① 종목명·계좌 평단으로 프로젝트 생성 (기준가 = 평단, 총예산 = 평단 × 수량)
//   ② 포켓 1에 보유분 전부를 배정하고 '보유중'으로 (배분할 돈이 없는 2~5번은 만들지 않는다)
//   ③ 평단 기준 매수 체결을 기록 → 계좌와 수량이 바로 맞는다
//
// 프로젝트 생성 화면을 거치지 않는 이유: 그 화면은 '새로 쓸 돈'을 배분하는 곳이라
// 예수금 기준 '사용가능 예산'을 넘으면 저장을 막는다. 이미 산 주식은 그 돈이 이미
// 주식으로 바뀌어 예수금에 없으므로 언제나 초과로 잡혀 만들 수가 없다.

import { supabase } from '@/lib/supabase';
import { alignToKrxTick, buildPocketSeeds, POCKET_COUNT } from '@/domain/pockets';

/** 새 프로젝트의 기본 전략 (생성 화면 기본값과 동일) */
const DEFAULT_BUY_INTERVAL_PCT = 5;
const DEFAULT_SELL_TARGET_PCT = 10;

export interface AdoptInput {
  userId: string;
  symbol: string;
  name: string;
  market: string; // 'KRX' | 'US'
  qty: number; // 계좌 보유수량
  avgPrice: number; // 계좌 매입평균가
}

/** 계좌 보유분을 프로젝트+포켓1 보유로 만든다. 만들어진 프로젝트 id 반환. */
export async function adoptHolding(input: AdoptInput): Promise<string> {
  const { userId, symbol, name, market, qty, avgPrice } = input;
  if (qty <= 0 || avgPrice <= 0) throw new Error('보유수량 또는 평균단가를 확인할 수 없어요.');

  const isKrx = market === 'KRX';
  const basePrice = isKrx ? alignToKrxTick(avgPrice, 'buy') : avgPrice;
  const totalBudget = Math.round(avgPrice * qty * 10000) / 10000;

  const { data: proj, error: perr } = await supabase
    .from('projects')
    .insert({
      user_id: userId,
      name,
      symbol,
      market,
      base_price: basePrice,
      buy_interval_pct: DEFAULT_BUY_INTERVAL_PCT,
      sell_target_pct: DEFAULT_SELL_TARGET_PCT,
      pocket_count: POCKET_COUNT,
      total_budget: totalBudget,
    })
    .select()
    .single();
  if (perr || !proj) throw new Error(perr?.message ?? '프로젝트를 만들지 못했어요.');

  // 보유분은 전부 포켓 1에 있다 → 비중 100/0/0/0/0 (2~5번은 예산이 0이라 만들지 않는다).
  const seeds = buildPocketSeeds({
    basePrice,
    buyIntervalPct: DEFAULT_BUY_INTERVAL_PCT,
    sellTargetPct: DEFAULT_SELL_TARGET_PCT,
    totalBudget,
    weights: Array.from({ length: POCKET_COUNT }, (_, i) => (i === 0 ? 100 : 0)),
    pocketCount: POCKET_COUNT,
    market,
  });

  // 배분 예산이 0인 포켓은 '아직 만들지 않은 것'으로 둔다 (프로젝트 생성 화면과 같은 규칙).
  // 행을 만들어 두면 목록의 포켓 신호등에 2~5번이 빈 원으로 켜져 있는 것처럼 보인다.
  const { data: pocketRows, error: kerr } = await supabase
    .from('pockets')
    .insert(
      seeds
        .filter((s) => (s.budget ?? 0) > 0)
        .map((s) => ({
          project_id: proj.id,
          idx: s.idx,
          buy_target_price: s.buy_target_price,
          sell_target_price: s.sell_target_price,
          weight: s.weight,
          budget: s.budget,
          status: 'bought' as const, // 이미 보유 중인 물량
        }))
    )
    .select('id,idx');
  if (kerr) throw new Error(kerr.message);

  const first = ((pocketRows ?? []) as { id: string; idx: number }[]).find((k) => k.idx === 0);
  if (!first) throw new Error('포켓을 만들지 못했어요.');

  // 계좌 평단으로 매수 체결을 기록 → 앱 보유수량이 계좌와 맞는다
  const { error: terr } = await supabase.from('trades').insert({
    user_id: userId,
    project_id: proj.id,
    pocket_id: first.id,
    side: 'buy',
    price: avgPrice,
    quantity: qty,
    executed_at: new Date().toISOString(),
    note: '계좌 보유분 반영 (매입평균가 기준)',
  });
  if (terr) throw new Error(terr.message);

  return proj.id as string;
}
