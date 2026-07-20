// =====================================================================
// 휴대폰 SMS 인증코드 확인 (Supabase Edge Function)
//
// 회원가입 전에 호출되므로 JWT 검증을 꺼서 배포:
//   supabase functions deploy verify-phone-otp --no-verify-jwt
//
// phone + code 를 받아 phone_otps 와 대조 → 맞으면 verified=true 로 표시.
// 이후 회원가입 트리거(handle_new_user)가 verified 된 번호면 phone_verified=true 로 저장.
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const onlyDigits = (s: string) => (s ?? '').replace(/[^0-9]/g, '');
const MAX_ATTEMPTS = 5;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

  try {
    const body = await req.json();
    const phone = onlyDigits(body.phone);
    const code = onlyDigits(body.code);
    if (!phone || code.length !== 6) {
      return json({ error: '인증번호 6자리를 입력하세요.' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: row } = await admin
      .from('phone_otps')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    if (!row) return json({ error: '먼저 인증번호를 요청하세요.' }, 400);
    if (row.verified) return json({ ok: true, alreadyVerified: true });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return json({ error: '인증번호가 만료됐어요. 다시 요청해주세요.' }, 400);
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return json({ error: '시도 횟수를 초과했어요. 인증번호를 다시 요청해주세요.' }, 429);
    }

    if (row.code !== code) {
      await admin.from('phone_otps').update({ attempts: row.attempts + 1 }).eq('phone', phone);
      return json({ error: `인증번호가 일치하지 않아요. (남은 시도 ${MAX_ATTEMPTS - row.attempts - 1}회)` }, 400);
    }

    // 성공
    await admin.from('phone_otps').update({ verified: true }).eq('phone', phone);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '인증 확인 중 오류가 발생했어요.' }, 500);
  }
});
