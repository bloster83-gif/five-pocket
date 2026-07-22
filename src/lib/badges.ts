// 탭 배지용 아주 가벼운 전역 스토어 (폴링/리얼타임 없이, 화면이 로드할 때 값만 갱신)
import { useSyncExternalStore } from 'react';

let projectCount = 0;
const listeners = new Set<() => void>();

/** 프로젝트 개수 갱신 (프로젝트 목록을 불러온 화면에서 호출) */
export function setProjectCount(n: number) {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (v === projectCount) return;
  projectCount = v;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 탭바 등에서 현재 프로젝트 개수를 구독 */
export function useProjectCount(): number {
  return useSyncExternalStore(subscribe, () => projectCount, () => projectCount);
}

// --- 관심종목 레이더: 기준가 이하 종목 수 배지 ---
let radarBelowCount = 0;
const radarListeners = new Set<() => void>();

/** 기준가 이하 종목 수 갱신 (레이더 화면이 시세를 불러올 때 호출) */
export function setRadarBelowCount(n: number) {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (v === radarBelowCount) return;
  radarBelowCount = v;
  radarListeners.forEach((l) => l());
}

function subscribeRadar(l: () => void) {
  radarListeners.add(l);
  return () => radarListeners.delete(l);
}

/** 탭바에서 기준가 이하 종목 수를 구독 */
export function useRadarBelowCount(): number {
  return useSyncExternalStore(subscribeRadar, () => radarBelowCount, () => radarBelowCount);
}
