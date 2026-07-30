// 기본(웹 / Expo Go) 구현 — 인앱결제 미지원 환경에서 안전하게 no-op.
// 네이티브(iOS/Android)에서는 Metro 가 purchases.native.ts 를 대신 사용한다.
import { EMPTY_ENTITLEMENT } from './purchases.types';
import type { AutoEntitlement, PurchasePackageInfo } from './purchases.types';

export * from './purchases.types';

/** 인앱결제 사용 가능 여부 (웹/미설정에서는 false) */
export function purchasesSupported(): boolean {
  return false;
}

/** 앱 시작 시 1회 RevenueCat 초기화 (웹에서는 no-op) */
export async function initPurchases(): Promise<void> {
  /* no-op */
}

/** 로그인/로그아웃 시 RevenueCat 사용자 연결 (웹에서는 no-op) */
export async function setPurchasesUser(_userId: string | null): Promise<void> {
  /* no-op */
}

/** 페이월이 비었을 때 원인 표시용 (웹에서는 미지원 안내) */
export const lastPackagesDiagnostic: string | null = null;

/** 페이월 패키지 목록 (웹에서는 빈 배열) */
export async function getAutoPackages(): Promise<PurchasePackageInfo[]> {
  return [];
}

/** 구매 실행 (웹에서는 미지원) */
export async function purchaseAuto(_packageId: string): Promise<AutoEntitlement> {
  throw new Error('인앱결제는 앱(정식 빌드)에서만 이용할 수 있어요.');
}

/** 구매 복원 */
export async function restoreAuto(): Promise<AutoEntitlement> {
  return EMPTY_ENTITLEMENT;
}

/** 현재 AUTO 권한 상태 조회 */
export async function getAutoEntitlement(): Promise<AutoEntitlement> {
  return EMPTY_ENTITLEMENT;
}
