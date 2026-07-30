// RevenueCat 웹훅 수신 → profiles.tier 자동 갱신 (결제 시 AUTO 자동 전환, 만료 시 강등)
//
// 배포:  supabase functions deploy revenuecat-webhook --no-verify-jwt
// 시크릿: supabase secrets set RC_WEBHOOK_AUTH="<임의의 긴 문자열>"
//         (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 기본 제공)
//
// RevenueCat 대시보드 → Integrations → Webhooks 에 아래를 입력:
//   URL:  https://<PROJECT_REF>.functions.supabase.co/revenuecat-webhook
//   Authorization header: 위에서 정한 RC_WEBHOOK_AUTH 와 동일한 값
//
// app_user_id 는 앱에서 Purchases.logIn(supabase user id) 로 연결해 두었으므로
// 곧 Supabase 의 profiles.id(uuid) 와 동일하다.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// AUTO 권한을 부여/유지해야 하는 이벤트
const GRANT = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);
// 즉시 강등해야 하는 이벤트 (CANCELLATION 은 만료 전까지 유효하므로 강등하지 않음)
const REVOKE = new Set(['EXPIRATION']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 간단한 공유 시크릿 인증
  const expected = Deno.env.get('RC_WEBHOOK_AUTH');
  const got = req.headers.get('Authorization');
  if (expected && got !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const event = body?.event;
  const type: string | undefined = event?.type;
  const appUserId: string | undefined = event?.app_user_id;
  if (!type || !appUserId) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no event/user' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 익명 RevenueCat id($RCAnonymousID:...) 는 Supabase 사용자와 매칭되지 않으므로 무시
  if (appUserId.startsWith('$RCAnonymousID')) {
    return new Response(JSON.stringify({ ok: true, skipped: 'anonymous' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const expMs: number | null = event?.expiration_at_ms ?? null;
  const expiresAt = expMs ? new Date(expMs).toISOString() : null;
  const stillValid = expMs ? expMs > Date.now() : true;

  let update: { tier: 'auto' | 'diary'; tier_expires_at: string | null } | null = null;
  if (GRANT.has(type) && stillValid) {
    update = { tier: 'auto', tier_expires_at: expiresAt };
  } else if (REVOKE.has(type) || (expMs && !stillValid)) {
    update = { tier: 'diary', tier_expires_at: null };
  }

  if (!update) {
    return new Response(JSON.stringify({ ok: true, skipped: type }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // AUTO 부여 시: 이미 더 긴 기간(관리자 수동 부여 등)이 있으면 줄이지 않고 더 늦은 날짜를 유지.
  // (샌드박스 결제는 기간이 압축돼 5분~1시간이라, 기존 유효기간을 덮어쓰면 즉시 만료돼 보임)
  if (update.tier === 'auto') {
    const { data: cur } = await admin
      .from('profiles')
      .select('tier_expires_at')
      .eq('id', appUserId)
      .maybeSingle();
    const prevMs = cur?.tier_expires_at ? Date.parse(cur.tier_expires_at as string) : 0;
    const nextMs = update.tier_expires_at ? Date.parse(update.tier_expires_at) : 0;
    if (prevMs && nextMs && prevMs > nextMs) {
      update.tier_expires_at = cur!.tier_expires_at as string;
    }
  }

  const { error } = await admin.from('profiles').update(update).eq('id', appUserId);
  if (error) {
    console.error('[revenuecat-webhook] update 실패', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, type, tier: update.tier }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
