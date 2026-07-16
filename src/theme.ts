// 앱 전체 공통 색상/간격 (다크 테마 기준)
// 한국 주식 관례: 매수/상승 = 빨강, 매도/하락 = 파랑
export const colors = {
  bg: '#0B1220',
  card: '#151E2E',
  cardAlt: '#1C2740',
  border: '#26324A',
  text: '#E8EDF7',
  textDim: '#96A2B8',
  primary: '#22D3A6', // 브랜드/중립 CTA(로그인·저장 등)
  buy: '#F5455C', // 매수 / 상승 (빨강)
  sell: '#3B82F6', // 매도 / 하락 (파랑)
  buyBg: 'rgba(245,69,92,0.14)', // 매수 강조 배경(음영)
  sellBg: 'rgba(59,130,246,0.14)', // 매도 강조 배경(음영)
  danger: '#F87171', // 삭제 등 위험 동작
  warn: '#FBBF24',
  accent: '#5B8DEF',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 12, lg: 16 };

// ---- 입력값 콤마 포맷 (세자리 구분) ----
/** 입력 문자열에서 숫자만 남기기 (decimals=true면 소수점 1개 허용) */
export function rawNumeric(t: string, decimals = false): string {
  let s = t.replace(/,/g, '');
  if (decimals) {
    s = s.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
  } else {
    s = s.replace(/[^\d]/g, '');
  }
  return s;
}

/** 숫자 원문에 천단위 콤마 붙이기 (입력 표시용) */
export function withCommas(raw: string, decimals = false): string {
  if (raw === '' || raw == null) return '';
  if (decimals) {
    const endsDot = raw.endsWith('.');
    const [i, d] = raw.split('.');
    const iF = (i || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (d !== undefined) return iF + '.' + d;
    return iF + (endsDot ? '.' : '');
  }
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '-';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// 시장별 통화/자릿수
export type MarketCode = 'KRX' | 'US' | 'MOCK' | string;

export function currencyForMarket(market: MarketCode): string {
  if (market === 'KRX') return 'KRW';
  return 'USD';
}

/** 시장에 맞춘 가격 표기 (원화는 소수점 없음, 달러는 2자리) */
export function formatPrice(n: number | null | undefined, market: MarketCode): string {
  if (n == null || Number.isNaN(n)) return '-';
  if (market === 'KRX') return '₩' + money(n, 0);
  return '$' + money(n, 2);
}

/** 큰 원화 금액을 억/만 단위로 짧게 (인생목표·통계용) */
export function formatKRW(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e8) return sign + '₩' + (abs / 1e8).toFixed(abs >= 1e9 ? 1 : 2).replace(/\.?0+$/, '') + '억';
  if (abs >= 1e4) return sign + '₩' + Math.round(abs / 1e4).toLocaleString() + '만';
  return sign + '₩' + Math.round(abs).toLocaleString();
}

export function formatMoney(n: number | null | undefined, market: MarketCode): string {
  // 손익 등 금액 표기 (부호 유지)
  if (n == null || Number.isNaN(n)) return '-';
  const digits = market === 'KRX' ? 0 : 2;
  const sym = market === 'KRX' ? '₩' : '$';
  const sign = n < 0 ? '-' : '';
  return sign + sym + money(Math.abs(n), digits);
}

// 손익/등락: 이익·상승 = 빨강(buy), 손실·하락 = 파랑(sell)
export function signColor(n: number): string {
  if (n > 0) return colors.buy;
  if (n < 0) return colors.sell;
  return colors.textDim;
}
