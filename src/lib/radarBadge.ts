// 앱 시작 시(레이더 탭을 아직 안 열었어도) '기준가 이하' 종목 수를 계산해 탭 배지에 반영.
// 레이더 화면과 동일한 시세 로직(KIS 실시간 우선 → Yahoo 폴백)을 가볍게 재사용한다.
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { setRadarBelowCount } from './badges';
import { priceProvider } from '@/services/prices';
import { getDomesticPrice, getOverseasPrice } from '@/services/broker/kis';
import type { BrokerAccount, WatchlistItem } from '@/types/db';

/** 관심종목의 현재가를 조회해 기준가 이하 종목 수를 배지에 세팅 (실패는 조용히 무시) */
export async function refreshRadarBadge(userId: string | undefined): Promise<void> {
  if (!userId) return;
  try {
    const { data: it, error } = await supabase.from('watchlist_items').select('*');
    if (error) return; // 테이블 없음/오류 → 조용히 패스 (앱 안 깨지게)
    const items = (it as WatchlistItem[]) ?? [];
    if (items.length === 0) {
      setRadarBelowCount(0);
      return;
    }
    const native = Platform.OS !== 'web';
    let account: BrokerAccount | null = null;
    if (native) {
      const { data } = await supabase
        .from('broker_accounts')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      account = (data as BrokerAccount) ?? null;
    }
    let below = 0;
    await Promise.all(
      items.map(async (w) => {
        try {
          let price: number | null = null;
          if (native && account) {
            try {
              price =
                w.market === 'US'
                  ? (await getOverseasPrice(account, w.symbol)).price
                  : (await getDomesticPrice(account, w.symbol)).price;
            } catch {
              /* KIS 실패 → Yahoo 폴백 */
            }
          }
          if (price == null) price = (await priceProvider.getQuote(w.symbol)).price;
          if (price != null && w.base_price > 0 && price < w.base_price) below += 1;
        } catch {
          /* 개별 종목 실패는 무시 */
        }
      })
    );
    setRadarBelowCount(below);
  } catch {
    /* 전체 실패 → 기존 배지 값 유지 */
  }
}
