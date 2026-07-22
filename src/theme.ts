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

// =====================================================================
// 숫자(값) 통일 색상 체계 — 앱 전체 어디서든 같은 의미의 숫자는 같은 색.
//   · 보유 수량 / 평균 매수가 (보유·원가)        → num.position  (핑크)
//   · 기준가 (base_price)                        → num.base      (보라)
//   · 평가 총액 (현재가 × 수량)                   → num.evalTotal (앰버)
//   · 평가/실현 손익 (±)                          → signColor()   (+빨강 / -파랑)
//   · 실시간 가격 (현재가·시세)                   → num.live      (하양)
//   · 예산 (배분·전체 예산)                        → num.budget    (청록)
// 매수 빨강 / 매도 파랑과 겹치지 않게 나머지는 보라·앰버·청록·하양으로 구분한다.
// =====================================================================
export const num = {
  position: '#EC4899', // 보유 수량 · 평균 매수가 (핑크 — 매수 빨강·손익과 구분)
  base: '#A78BFA', // 기준가
  evalTotal: '#F59E0B', // 평가 총액
  live: '#E8EDF7', // 실시간 가격 (= colors.text)
  budget: '#22D3A6', // 예산 (= colors.primary)
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

/**
 * 오늘 날짜 ~ 대상 날짜의 "캘린더 일수" 차 (시간 무시, 날짜 기준).
 * 시:분까지 계산해 하루가 어긋나던 문제를 막기 위해 양쪽을 자정으로 맞춰 계산한다.
 * 지난 날짜면 0.
 */
export function daysUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return 0;
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target.getTime() - today.getTime()) / 86400000));
}
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

// 인생목표 표시 단위: 목표금액 10억 초과면 '억', 이하면 '백만원'으로 통일
export type GoalUnit = 'eok' | 'mil';
export function goalUnit(targetAsset: number | null | undefined): GoalUnit {
  return (targetAsset ?? 0) > 1e9 ? 'eok' : 'mil'; // 10억 = 1e9 기준
}

/** 인생목표 금액을 지정 단위(억/백만원)로 통일해서 표기 */
export function formatGoalKRW(n: number | null | undefined, unit: GoalUnit): string {
  if (n == null || Number.isNaN(n)) return '-';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (unit === 'eok') {
    const v = abs / 1e8; // 억
    const dec = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return sign + '₩' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec }) + '억';
  }
  const v = abs / 1e6; // 백만원
  const dec = v >= 100 ? 0 : 1;
  return sign + '₩' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec }) + '백만';
}

/**
 * 값 자체의 크기에 따라 억 / 백만원 / 만원 단위를 자동으로 선택해 표기.
 * (인생목표 탭의 모든 금액용 — 목표 자산과 무관하게 각 값의 크기에 맞춤)
 *  - |값| ≥ 1억(1e8)   → '억'
 *  - 1백만 ≤ |값| < 1억 → '백만'
 *  - |값| < 1백만(1e6)  → '만'
 */
export function formatGoalAutoKRW(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '-';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    const v = abs / 1e8; // 억
    const dec = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return sign + '₩' + v.toLocaleString('en-US', { maximumFractionDigits: dec }) + '억';
  }
  if (abs >= 1e6) {
    const v = abs / 1e6; // 백만원
    const dec = v >= 100 ? 0 : 1;
    return sign + '₩' + v.toLocaleString('en-US', { maximumFractionDigits: dec }) + '백만';
  }
  const v = abs / 1e4; // 만원
  const dec = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return sign + '₩' + v.toLocaleString('en-US', { maximumFractionDigits: dec }) + '만';
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

// 포켓 번호별 고유 색 (1~5) — 매수 빨강/매도 파랑과 겹치지 않는 색으로 구분
export const pocketColors = ['#F59E0B', '#22D3A6', '#8B5CF6', '#EC4899', '#84CC16'];
export function pocketColor(idx: number): string {
  return pocketColors[((idx % pocketColors.length) + pocketColors.length) % pocketColors.length];
}
