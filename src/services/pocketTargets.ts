// 포켓 목표가 저장 (매수 목표가 · 매도 목표가 · 마지노선)
//
// stop_price 는 마이그레이션 20260813b 로 추가된 컬럼이라, 아직 실행하지 않은 DB 에서는
// 저장이 통째로 실패한다. 그런 경우 마지노선만 빼고 저장해 기존 기능이 깨지지 않게 한다.

import { supabase } from '@/lib/supabase';

/** 컬럼이 없어서 난 오류인지 (마이그레이션 미실행) */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return /stop_price|42703|schema cache|PGRST204|does not exist/i.test(`${error.code ?? ''} ${error.message ?? ''}`);
}

export interface SaveTargetsResult {
  /** 마지노선까지 저장됐는지. false = 마이그레이션 미실행이라 매수·매도 목표가만 저장됨 */
  stopSaved: boolean;
}

export async function savePocketTargets(
  pocketId: string,
  buyPrice: number,
  sellPrice: number | null,
  stopPrice: number | null
): Promise<SaveTargetsResult> {
  const base = { buy_target_price: buyPrice, sell_target_price: sellPrice };

  const { error } = await supabase
    .from('pockets')
    .update({ ...base, stop_price: stopPrice })
    .eq('id', pocketId);
  if (!error) return { stopSaved: true };
  if (!isMissingColumn(error)) throw new Error(error.message);

  // 마지노선 컬럼이 없는 DB → 나머지만 저장
  const { error: retry } = await supabase.from('pockets').update(base).eq('id', pocketId);
  if (retry) throw new Error(retry.message);
  return { stopSaved: false };
}

/** 마지노선 저장이 안 됐을 때 사용자에게 보여줄 안내 (마이그레이션 필요) */
export const STOP_PRICE_MIGRATION_HINT =
  '마지노선 기능에 필요한 컬럼이 아직 없어요. 최신 마이그레이션(20260813b)을 Supabase에서 실행하면 켜집니다.\n(매수·매도 목표가는 저장됐어요)';
