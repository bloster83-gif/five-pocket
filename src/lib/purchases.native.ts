// 네이티브(iOS/Android) RevenueCat 인앱결제 구현.
// 웹에서는 purchases.ts(no-op) 가 대신 사용된다 (Metro 플랫폼 확장자 해석).
import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import type { PurchasesPackage, CustomerInfo } from 'react-native-purchases';
import { ENTITLEMENT_ID, EMPTY_ENTITLEMENT } from './purchases.types';
import type { AutoEntitlement, PurchasePackageInfo } from './purchases.types';

export * from './purchases.types';

let configured = false;
let pkgCache: Record<string, PurchasesPackage> = {};

function apiKey(): string | null {
  const k =
    Platform.OS === 'ios'
      ? process.env.EXPO_PUBLIC_RC_IOS_KEY
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

export async function getAutoPackages(): Promise<PurchasePackageInfo[]> {
  if (!configured) await initPurchases();
  if (!configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings.current;
    if (!current) return [];
    pkgCache = {};
    return current.availablePackages.map((p) => {
      pkgCache[p.identifier] = p;
      return {
        id: p.identifier,
        productId: p.product.identifier,
        title: p.product.title,
        priceString: p.product.priceString,
        period: periodLabel(p.packageType),
      };
    });
  } catch (e) {
    console.warn('[purchases] offerings 조회 실패', e);
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
