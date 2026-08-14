// 구독 검증 → 등급 반영 (웹훅 실패 대비 안전망)
//
// RevenueCat 웹훅이 유일한 등급 반영 경로면, 웹훅이 한 번 실패했을 때
// 결제한 사용자가 영영 AUTO 를 못 받는다. 앱이 이 함수를 호출하면
// 서버가 RevenueCat REST API 로 '실제 구독 상태'를 직접 확인해 등급을 맞춘다.
//
// 사용자가 profiles.tier 를 직접 못 바꾸게 막았으므로(마이그레이션 20260813c),
// 등급을 올릴 수 있는 유일한 클라이언트 경로가 이 함수다.
//
// 배포:  supabase functions deploy verify-entitlement
// 시크릿: supabase secrets set RC_SECRET_KEY="sk_..."   ← RevenueCat 대시보드의 Secret API key
//        (공개키 goog_/appl_ 이 아니라 sk_ 로 시작하는 비밀 키여야 한다)
//
// 요청: POST, Authorization: Bearer <사용자 access token>
// 응답: { ok, tier, expiresAt, source }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ENTITLEMENT_ID = 'auto';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // 1) 토큰으로 사용자 확인 — app_user_id 를 클라이언트가 주장하게 두면 안 된다
  const admin = createClient(url, serviceKey);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const userId = userData?.user?.id;
  if (userErr || !userId) return json({ ok: false, error: '사용자를 확인할 수 없습니다.' }, 401);

  // 2) RevenueCat 에 실제 구독 상태를 묻는다
  const rcKey = Deno.env.get('RC_SECRET_KEY');
  if (!rcKey) return json({ ok: false, error: 'RC_SECRET_KEY 가 설정되지 않았습니다.' }, 500);

  let expiresAt: string | null = null;
  let active = false;
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${rcKey}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 404) {
      // RevenueCat 에 이 사용자 기록 자체가 없음 = 구매 이력 없음
      return json({ ok: true, tier: null, active: false, source: 'revenuecat', note: 'no subscriber' });
    }
    if (!res.ok) {
      const text = await res.text();
      return json({ ok: false, error: `RevenueCat 조회 실패 (${res.status}) ${text.slice(0, 200)}` }, 502);
    }
    const body = await res.json();
    const ent = body?.subscriber?.entitlements?.[ENTITLEMENT_ID];
    const expires: string | null = ent?.expires_date ?? null;
    // expires_date 가 null 이면 평생 이용권, 값이 있으면 미래여야 유효
    active = !!ent && (expires === null || Date.parse(expires) > Date.now());
    expiresAt = expires;
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'RevenueCat 조회 오류' }, 502);
  }

  // 3) 유효한 구독일 때만 등급을 올린다.
  //    구독이 없다고 해서 강등하지는 않는다 — 관리자가 수동으로 준 AUTO(결제 이력 없음)를
  //    이 함수가 빼앗으면 안 된다. 강등은 웹훅(EXPIRATION)과 pg_cron 만료 작업이 담당한다.
  if (!active) {
    return json({ ok: true, tier: null, active: false, source: 'revenuecat' });
  }

  const { data: cur } = await admin
    .from('profiles')
    .select('tier,tier_expires_at')
    .eq('id', userId)
    .maybeSingle();

  // 기존 만료일이 더 늦으면(관리자 장기 부여 등) 줄이지 않는다
  const prevMs = cur?.tier_expires_at ? Date.parse(cur.tier_expires_at as string) : 0;
  const nextMs = expiresAt ? Date.parse(expiresAt) : 0;
  const keepAt = prevMs && nextMs && prevMs > nextMs ? (cur!.tier_expires_at as string) : expiresAt;

  const already = cur?.tier === 'auto' && (cur?.tier_expires_at ?? null) === keepAt;
  if (already) return json({ ok: true, tier: 'auto', active: true, expiresAt: keepAt, source: 'unchanged' });

  const { error } = await admin
    .from('profiles')
    .update({ tier: 'auto', tier_expires_at: keepAt })
    .eq('id', userId);
  if (error) return json({ ok: false, error: error.message }, 500);

  return json({ ok: true, tier: 'auto', active: true, expiresAt: keepAt, source: 'verified' });
});
