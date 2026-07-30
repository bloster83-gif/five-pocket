// 네이티브(iOS/Android) RevenueCat 인앱결제 구현.
// 웹에서는 purchases.ts(no-op) 가 대신 사용된다 (Metro 플랫폼 확장자 해석).
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import type { PurchasesPackage, CustomerInfo } from 'react-native-purchases';
import { ENTITLEMENT_ID, EMPTY_ENTITLEMENT } from './purchases.types';
import type { AutoEntitlement, PurchasePackageInfo } from './purchases.types';

export * from './purchases.types';

let configured = false;
let pkgCache: Record<string, PurchasesPackage> = {};

function apiKey(): string | null {
  // env 인라인이 빠진 번들(OTA 캐시 이슈 등)에서도 동작하도록 app.json extra 폴백
  const k =
    Platform.OS === 'ios'
      ? process.env.EXPO_PUBLIC_RC_IOS_KEY || (Constants.expoConfig?.extra?.rcIosKey as string | undefined)
      : process.env.EXPO_PUBLIC_RC_ANDROID_KEY;
  return k && k.length > 0 ? k : null;
}

export function purchasesSupported(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && !!apiKey();
}

export async function initPurchases(): Promise<void> {
  if (configured) return;
  const key = apiKey();
  if (!key) return; // 키 미설정이면 조용히 패스 (개발/미구성 방어)
  try {
    Purchases.configure({ apiKey: key });
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.WARN : LOG_LEVEL.ERROR);
    configured = true;
  } catch (e) {
    console.warn('[purchases] configure 실패', e);
  }
}

export async function setPurchasesUser(userId: string | null): Promise<void> {
  if (!configured) await initPurchases();
  if (!configured) return;
  try {
    if (userId) await Purchases.logIn(userId);
    else await Purchases.logOut();
  } catch (e) {
    console.warn('[purchases] 사용자 동기화 실패', e);
  }
}

function readAuto(info: CustomerInfo): AutoEntitlement {
  const ent = info?.entitlements?.active?.[ENTITLEMENT_ID];
  if (!ent) return EMPTY_ENTITLEMENT;
  return {
    active: true,
    expiresAt: ent.expirationDate ?? null,
    willRenew: !!ent.willRenew,
    productId: ent.productIdentifier ?? null,
  };
}

// 페이월 표시 순서 (짧은 기간 → 긴 기간): 1개월 → 6개월 → 12개월 …
function periodRank(pkgType: string): number {
  const order: Record<string, number> = {
    WEEKLY: 1,
    MONTHLY: 2,
    TWO_MONTH: 3,
    THREE_MONTH: 4,
    SIX_MONTH: 5,
    ANNUAL: 6,
    LIFETIME: 7,
  };
  return order[pkgType] ?? 99;
}

function periodLabel(pkgType: string): string {
  switch (pkgType) {
    case 'MONTHLY':
      return '1개월';
    case 'TWO_MONTH':
      return '2개월';
    case 'THREE_MONTH':
      return '3개월';
    case 'SIX_MONTH':
      return '6개월';
    case 'ANNUAL':
      return '12개월';
    case 'WEEKLY':
      return '1주';
    case 'LIFETIME':
      return '평생';
    default:
      return '';
  }
}

/** 페이월이 비었을 때 원인을 화면에 보여주기 위한 마지막 진단 메시지 */
export let lastPackagesDiagnostic: string | null = null;

export async function getAutoPackages(): Promise<PurchasePackageInfo[]> {
  lastPackagesDiagnostic = null;
  if (!configured) await initPurchases();
  if (!configured) {
    lastPackagesDiagnostic = apiKey()
      ? 'RevenueCat 초기화에 실패했어요.'
      : '결제 키(RevenueCat)가 앱에 포함되지 않았어요.';
    return [];
  }
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings.current;
    if (!current) {
      const all = Object.keys(offerings.all ?? {});
      lastPackagesDiagnostic = all.length
        ? `RevenueCat 오퍼링(${all.join(', ')})이 있지만 'Current'로 지정되지 않았어요.`
        : 'RevenueCat에 오퍼링이 없어요. (대시보드 → Offerings 확인)';
      return [];
    }
    if (current.availablePackages.length === 0) {
      lastPackagesDiagnostic =
        `오퍼링 '${current.identifier}'에 사용 가능한 상품이 없어요. ` +
        'App Store Connect 구독 상태(제출 준비 완료/승인)와 유료 앱 계약(세금·금융 정보)을 확인하세요.';
      return [];
    }
    pkgCache = {};
    const sorted = [...current.availablePackages].sort(
      (a, b) => periodRank(a.packageType) - periodRank(b.packageType)
    );
    return sorted.map((p) => {
      pkgCache[p.identifier] = p;
      return {
        id: p.identifier,
        productId: p.product.identifier,
        title: p.product.title,
        priceString: p.product.priceString,
        period: periodLabel(p.packageType),
      };
    });
  } catch (e: any) {
    console.warn('[purchases] offerings 조회 실패', e);
    lastPackagesDiagnostic = `상품 조회 실패: ${e?.message ?? e}`;
    return [];
  }
}

export async function purchaseAuto(packageId: string): Promise<AutoEntitlement> {
  if (!configured) await initPurchases();
  if (!configured) throw new Error('결제를 초기화할 수 없어요.');
  const pkg = pkgCache[packageId];
  if (!pkg) throw new Error('상품 정보를 찾을 수 없어요. 잠시 후 다시 시도해 주세요.');
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return readAuto(customerInfo);
}

export async function restoreAuto(): Promise<AutoEntitlement> {
  if (!configured) await initPurchases();
  if (!configured) return EMPTY_ENTITLEMENT;
  const info = await Purchases.restorePurchases();
  return readAuto(info);
}

export async function getAutoEntitlement(): Promise<AutoEntitlement> {
  if (!configured) await initPurchases();
  if (!configured) return EMPTY_ENTITLEMENT;
  const info = await Purchases.getCustomerInfo();
  return readAuto(info);
}
