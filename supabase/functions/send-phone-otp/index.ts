// =====================================================================
// 휴대폰 SMS 인증코드 발송 (Supabase Edge Function)
//
// 회원가입 전(로그인 전)에 호출되므로 JWT 검증을 꺼서 배포해야 합니다:
//   supabase functions deploy send-phone-otp --no-verify-jwt
//
// 문자 발송사는 한국에서 많이 쓰는 "알리고(Aligo)"를 사용합니다.
//   시크릿 설정:
//   supabase secrets set ALIGO_API_KEY=... ALIGO_USER_ID=... ALIGO_SENDER=발신번호
//   (발신번호는 알리고에 사전 등록된 번호여야 함)
//
// ★ 개발/테스트 모드: 위 알리고 시크릿이 없으면 문자를 실제로 보내지 않고
//   응답에 devCode 로 인증코드를 돌려줍니다. (문자 계약 전 흐름 테스트용)
//   운영 시에는 반드시 알리고 시크릿을 등록해 실제 문자로 전환하세요.
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const onlyDigits = (s: string) => (s ?? '').replace(/[^0-9]/g, '');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

  try {
    const { phone: rawPhone } = await req.json();
    const phone = onlyDigits(rawPhone);
    // 한국 휴대폰: 01012345678 (10~11자리)
    if (!/^01[0-9]{8,9}$/.test(phone)) {
      return json({ error: '올바른 휴대폰 번호를 입력하세요. (예: 010-1234-5678)' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    // 재전송 쿨다운: 마지막 발송 후 60초 이내면 거부
    const { data: existing } = await admin
      .from('phone_otps')
      .select('sent_at')
      .eq('phone', phone)
      .maybeSingle();
    if (existing?.sent_at && Date.now() - new Date(existing.sent_at).getTime() < 60_000) {
      return json({ error: '잠시 후 다시 시도해주세요. (1분에 1회)' }, 429);
    }

    // 6자리 코드 생성 (crypto 사용 → 예측 불가)
    const code = String((crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)).padStart(6, '0');
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5분

    const { error: upErr } = await admin.from('phone_otps').upsert({
      phone,
      code,
      expires_at: expiresAt,
      verified: false,
      attempts: 0,
      sent_at: nowIso,
    });
    if (upErr) return json({ error: upErr.message }, 500);

    // 알리고로 실제 문자 발송
    const apiKey = Deno.env.get('ALIGO_API_KEY');
    const userId = Deno.env.get('ALIGO_USER_ID');
    const sender = Deno.env.get('ALIGO_SENDER');
    if (apiKey && userId && sender) {
      const form = new URLSearchParams({
        key: apiKey,
        user_id: userId,
        sender,
        receiver: phone,
        msg: `[5 Pocket Diary] 인증번호 [${code}] 를 입력해주세요.`,
        testmode_yn: Deno.env.get('ALIGO_TEST') === '1' ? 'Y' : 'N',
      });
      const res = await fetch('https://apis.aligo.in/send/', { method: 'POST', body: form });
      const out = await res.json();
      // result_code 1 = 성공
      if (String(out.result_code) !== '1') {
        return json({ error: out.message ?? '문자 발송에 실패했어요.' }, 502);
      }
      return json({ ok: true, expiresAt });
    }

    // 개발 모드: 문자 발송사 미설정 → 코드를 응답으로 반환 (테스트용)
    return json({
      ok: true,
      expiresAt,
      devMode: true,
      devCode: code,
      notice: '문자 발송사(알리고)가 설정되지 않아 테스트 코드를 반환합니다. 운영 시 ALIGO_* 시크릿을 등록하세요.',
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '인증번호 발송 중 오류가 발생했어요.' }, 500);
  }
});
