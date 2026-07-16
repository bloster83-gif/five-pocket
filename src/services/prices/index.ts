import { MockPriceProvider } from './mockProvider';
import { YahooPriceProvider } from './yahooProvider';
import type { PriceProvider } from './types';

// 앱 전체에서 쓰는 단일 시세 제공자.
//  - 기본: 야후 파이낸스(키 불필요, 한국+미국). 실기기에서 라이브 동작.
//  - EXPO_PUBLIC_USE_MOCK=1 이면 목업 사용 (웹 CORS 회피/오프라인 데모용).
//
// 나중에 진짜 실시간이 필요하면 여기서 KIS/Finnhub Provider 로 교체:
//   export const priceProvider = new KisPriceProvider(...)
const useMock = process.env.EXPO_PUBLIC_USE_MOCK === '1';

export const priceProvider: PriceProvider = useMock
  ? new MockPriceProvider()
  : new YahooPriceProvider();

export { MockPriceProvider, YahooPriceProvider };
export * from './types';
