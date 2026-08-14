// 구독 검증 → 등급 반영 (웹훅 실패 대비 안전망)
//
// 등급(profiles.tier)은 사용자가 직접 못 바꾸게 막혀 있으므로(마이그레이션 20260813c),
// 앱은 이 함수를 통해서만 등급을 갱신할 수 있다. 서버(verify-entitlement)가
// RevenueCat 에 실제 구독 상태를 직접 물어보고 service_role 로 반영한다.
//
// 호출 시점
//   · 결제 직후 / 구매 복원 직후 (웹훅보다 빠르고, 웹훅이 실패해도 살아남음)
//   · 앱에서 entitlement 는 살아 있는데 등급이 diary 로 보일 때
//
// 함수가 아직 배포되지 않았거나 네트워크가 끊겨도 앱은 그대로 동작해야 하므로
// 실패는 조용히 삼키고 false 를 돌려준다.

import { supabase } from '@/lib/supabase';

export interface VerifyResult {
  ok: boolean;
  /** 서버가 실제로 등급을 올렸는지 (이미 AUTO 였으면 false) */
  changed: boolean;
  expiresAt?: string | null;
  error?: string;
}

export async function verifyEntitlement(): Promise<VerifyResult> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return { ok: false, changed: false, error: '로그인이 필요해요.' };

    const { data, error } = await supabase.functions.invoke('verify-entitlement', {
      body: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return { ok: false, changed: false, error: error.message };

    const r = data as { ok?: boolean; source?: string; expiresAt?: string | null; error?: string };
    return {
      ok: !!r?.ok,
      changed: r?.source === 'verified',
      expiresAt: r?.expiresAt ?? null,
      error: r?.error,
    };
  } catch (e: any) {
    // 함수 미배포·오프라인 등 — 웹훅 경로가 여전히 있으므로 조용히 넘어간다
    return { ok: false, changed: false, error: e?.message ?? '검증 요청 실패' };
  }
}
