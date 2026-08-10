// =====================================================================
// 거래 가능 시간 판정 (앱 공통)
//
//  장이 닫혀 있을 때 주문을 보내면 증권사가 거부하고, 실패 알림만 쌓인다.
//  주문을 아예 보내지 않고 '거래 가능 시간'이 될 때까지 기다렸다가 보내기 위해
//  시장별 세션을 판정한다. 서버 러너(auto-trade-runner)와 판정 기준을 맞출 것.
//
//  국내(KRX + 넥스트레이드)
//    - KRX 정규장     : 평일 09:00 ~ 15:30 KST — 모든 종목 주문 가능
//    - NXT 프리마켓   : 평일 08:00 ~ 08:50 KST — 넥스트레이드 상장 종목만
//    - NXT 애프터마켓 : 평일 15:40 ~ 20:00 KST — 넥스트레이드 상장 종목만
//
//  미국
//    - 정규장         : 평일 09:30 ~ 16:00 ET
//    - 프리/애프터    : 평일 04:00~09:30, 16:00~20:00 ET (정규장 TR 로 접수)
//    - 주간거래(블루오션) : 일~목 20:00 ~ 익일 04:00 ET (실전 계좌만)
// =====================================================================

/** 지정한 타임존의 현재 요일(0=일)·분(0~1439) */
function zoned(timeZone: string): { day: number; mins: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(get('hour')) % 24; // en-US 는 자정을 24 로 주기도 함
  return { day: dayMap[get('weekday')] ?? 0, mins: hour * 60 + Number(get('minute')) };
}

const HHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// ── 국내 ────────────────────────────────────────────────────────────
const KRX_OPEN = 9 * 60; // 09:00
const KRX_CLOSE = 15 * 60 + 30; // 15:30
const NXT_PRE_OPEN = 8 * 60; // 08:00
const NXT_PRE_CLOSE = 8 * 60 + 50; // 08:50
const NXT_AFTER_OPEN = 15 * 60 + 40; // 15:40
const NXT_AFTER_CLOSE = 20 * 60; // 20:00

export type KrxSession = 'regular' | 'nxt-pre' | 'nxt-after' | 'closed';

export function krxSession(): KrxSession {
  const { day, mins } = zoned('Asia/Seoul');
  if (day === 0 || day === 6) return 'closed';
  if (mins >= KRX_OPEN && mins <= KRX_CLOSE) return 'regular';
  if (mins >= NXT_PRE_OPEN && mins < NXT_PRE_CLOSE) return 'nxt-pre';
  if (mins >= NXT_AFTER_OPEN && mins < NXT_AFTER_CLOSE) return 'nxt-after';
  return 'closed';
}

// ── 미국 ────────────────────────────────────────────────────────────
export type UsSession = 'regular' | 'extended' | 'daytime' | 'closed';

export function usSession(): UsSession {
  const { day, mins } = zoned('America/New_York');
  const weekday = day >= 1 && day <= 5;
  if (weekday && mins >= 9 * 60 + 30 && mins <= 16 * 60) return 'regular';
  // 프리(04:00~09:30) / 애프터(16:00~20:00) — 정규장 TR 로 접수된다
  if (weekday && ((mins >= 4 * 60 && mins < 9 * 60 + 30) || (mins > 16 * 60 && mins < 20 * 60))) return 'extended';
  // 주간거래(블루오션): 일~목 20:00 이후 / 월~금 04:00 이전
  if (day >= 0 && day <= 4 && mins >= 20 * 60) return 'daytime';
  if (day >= 1 && day <= 5 && mins < 4 * 60) return 'daytime';
  return 'closed';
}

// ── 주문 가능 여부 ──────────────────────────────────────────────────
export interface OrderWindow {
  /** 지금 주문을 보내도 되는지 */
  canOrder: boolean;
  /** 못 보내는 이유 (사용자 안내용). canOrder 면 비어 있다 */
  reason: string;
}

/**
 * 국내 주문 가능 여부.
 * @param nxtTradable 넥스트레이드에서 거래되는 종목인지. false 면 KRX 정규장에만 주문한다.
 */
export function krxOrderWindow(nxtTradable: boolean): OrderWindow {
  const s = krxSession();
  if (s === 'regular') return { canOrder: true, reason: '' };
  if (s === 'nxt-pre' || s === 'nxt-after') {
    if (nxtTradable) return { canOrder: true, reason: '' };
    return {
      canOrder: false,
      reason: `넥스트레이드 미거래 종목이라 KRX 정규장(평일 ${HHMM(KRX_OPEN)}~${HHMM(KRX_CLOSE)})에 주문해요.`,
    };
  }
  return {
    canOrder: false,
    reason: `지금은 거래 시간이 아니에요. 거래 시간(평일 ${HHMM(KRX_OPEN)}~${HHMM(KRX_CLOSE)}${
      nxtTradable ? `, NXT ${HHMM(NXT_PRE_OPEN)}~${HHMM(NXT_PRE_CLOSE)}·${HHMM(NXT_AFTER_OPEN)}~${HHMM(NXT_AFTER_CLOSE)}` : ''
    })이 되면 주문해요.`,
  };
}

/**
 * 미국 주문 가능 여부.
 * @param isVirtual 모의투자 계좌면 주간거래(블루오션)를 지원하지 않는다.
 */
export function usOrderWindow(isVirtual: boolean): OrderWindow {
  const s = usSession();
  if (s === 'regular' || s === 'extended') return { canOrder: true, reason: '' };
  if (s === 'daytime') {
    if (!isVirtual) return { canOrder: true, reason: '' };
    return { canOrder: false, reason: '모의투자는 미국 주간거래를 지원하지 않아요. 정규장이 열리면 주문해요.' };
  }
  return { canOrder: false, reason: '지금은 미국 거래 시간이 아니에요. 거래 시간이 되면 주문해요.' };
}

/** 시장에 맞는 주문 가능 여부 (국내는 NXT 거래 여부를 함께 받는다) */
export function orderWindow(market: string, opts: { nxtTradable?: boolean; isVirtual?: boolean }): OrderWindow {
  return market === 'US' ? usOrderWindow(!!opts.isVirtual) : krxOrderWindow(!!opts.nxtTradable);
}
