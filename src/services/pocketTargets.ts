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
  stopPrice: number | null,
  /** 정기매수법 포켓의 예정 시각(ISO). undefined = 건드리지 않음 */
  buyAt?: string | null
): Promise<SaveTargetsResult> {
  const base = {
    buy_target_price: buyPrice,
    sell_target_price: sellPrice,
    ...(buyAt !== undefined ? { buy_at: buyAt } : null),
  };

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

/**
 * 마지노선을 프로젝트 전체에 적용 — 🎯 수정 모달의 '이 프로젝트 전체에 적용' 체크.
 *
 * 값은 projects.stop_price(프로젝트 마지노선, 마이그레이션 20260910a) 한 곳에만 두고
 * 포켓별 stop_price 는 모두 비운다 → 보유 포켓은 프로젝트 선으로 손절, 대기 포켓은 그 아래서 매수 보류.
 * (포켓마다 같은 값을 복사해 두면 나중에 프로젝트 선을 고쳐도 포켓 값이 우선돼 어긋난다)
 * projects.stop_price 컬럼이 없으면(마이그레이션 전) 포켓 전부에 같은 값을 넣는 걸로 대신한다.
 */
export async function applyStopToProject(projectId: string, stopPrice: number | null): Promise<{ projectSaved: boolean }> {
  const { error } = await supabase.from('projects').update({ stop_price: stopPrice }).eq('id', projectId);
  if (!error) {
    const { error: e2 } = await supabase.from('pockets').update({ stop_price: null }).eq('project_id', projectId);
    if (e2 && !isMissingColumn(e2)) throw new Error(e2.message);
    return { projectSaved: true };
  }
  if (!isMissingColumn(error)) throw new Error(error.message);
  // 프로젝트 컬럼이 없는 DB → 포켓 전부에 같은 값 (대기 포켓 매수 보류는 안 됨)
  const { error: e3 } = await supabase.from('pockets').update({ stop_price: stopPrice }).eq('project_id', projectId);
  if (e3) throw new Error(e3.message);
  return { projectSaved: false };
}

export const PROJECT_STOP_MIGRATION_HINT =
  '프로젝트 마지노선 컬럼이 아직 없어 보유 포켓들에만 같은 값을 넣었어요. 마이그레이션(20260910a)을 실행하면 대기 포켓의 매수 보류까지 켜집니다.';
