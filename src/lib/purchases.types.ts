// RevenueCat 인앱결제 공용 타입 — 네이티브/웹 구현이 동일 시그니처를 공유한다.

/** AUTO 등급을 잠금 해제하는 RevenueCat entitlement 식별자 (대시보드에서 동일하게 생성) */
export const ENTITLEMENT_ID = 'auto';

/** 현재 사용자의 AUTO 구독 상태 */
export interface AutoEntitlement {
  /** AUTO 권한이 활성 상태인지 */
  active: boolean;
  /** 만료 시각(ISO). 무기한/없음이면 null */
  expiresAt: string | null;
  /** 다음 주기에 자동 갱신되는지 */
  willRenew: boolean;
  /** 구매한 상품 식별자 */
  productId: string | null;
}

/** 페이월에 표시할 구매 패키지 정보(스토어에서 내려온 현지화 가격 포함) */
export interface PurchasePackageInfo {
  /** RevenueCat 패키지 식별자 (구매 시 사용) */
  id: string;
  /** 스토어 상품 식별자 */
  productId: string;
  /** 상품 제목 */
  title: string;
  /** 현지화된 가격 문자열 (예: "₩30,000") */
  priceString: string;
  /** 기간 라벨 (예: "1개월") */
  period: string;
}

export const EMPTY_ENTITLEMENT: AutoEntitlement = {
  active: false,
  expiresAt: null,
  willRenew: false,
  productId: null,
};
