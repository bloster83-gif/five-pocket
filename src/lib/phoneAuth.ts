// =====================================================================
// 휴대폰 SMS 인증 (회원가입용) — Edge Function 호출 래퍼
//   send-phone-otp   : 인증번호 발송
//   verify-phone-otp : 인증번호 확인
// 두 함수 모두 로그인 전에 호출되므로 --no-verify-jwt 로 배포되어 있어야 합니다.
// =====================================================================

const BASE = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** 입력 문자열에서 숫자만 (하이픈 제거) */
export function onlyDigits(s: string): string {
  return (s ?? '').replace(/[^0-9]/g, '');
}

/** 010-1234-5678 형태로 보기 좋게 */
export function formatPhone(s: string): string {
  const d = onlyDigits(s).slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

/** 한국 휴대폰 번호 형식 검사 */
export function isValidPhone(s: string): boolean {
  return /^01[0-9]{8,9}$/.test(onlyDigits(s));
}

async function callFn(name: string, body: unknown): Promise<any> {
  if (!BASE) throw new Error('Supabase 설정(.env)이 필요해요.');
  const res = await fetch(`${BASE}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ANON ? { authorization: `Bearer ${ANON}`, apikey: ANON } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(json?.error ?? `요청 실패 (HTTP ${res.status})`);
  return json;
}

export interface SendOtpResult {
  ok: boolean;
  devMode?: boolean; // 문자 발송사 미설정 → 테스트 코드 반환됨
  devCode?: string; // 개발 모드에서만 채워짐
}

/** 인증번호 발송. 문자 발송사 미설정 시 devMode=true 로 테스트 코드가 옴 */
export async function sendPhoneOtp(phone: string): Promise<SendOtpResult> {
  const out = await callFn('send-phone-otp', { phone: onlyDigits(phone) });
  return { ok: !!out.ok, devMode: out.devMode, devCode: out.devCode };
}

/** 인증번호 확인. 성공하면 true */
export async function verifyPhoneOtp(phone: string, code: string): Promise<boolean> {
  const out = await callFn('verify-phone-otp', { phone: onlyDigits(phone), code: onlyDigits(code) });
  return !!out.ok;
}
