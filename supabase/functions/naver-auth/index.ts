// =====================================================================
// 네이버 로그인 브로커 (Supabase Edge Function)
//
// Supabase Auth 는 네이버를 기본 지원하지 않아서, 이 함수가 중간에서
// 네이버 OAuth → Supabase 세션 발급을 대신해 준다.
//
// 흐름:
//   1) 앱 → GET /naver-auth?redirect_uri=<앱 복귀 주소>
//      → 네이버 로그인 페이지로 리다이렉트 (state 에 복귀 주소 보관)
//   2) 네이버 → GET /naver-auth?code=...&state=...  (콜백)
//      → 코드 교환 → 네이버 프로필(이메일) 조회
//      → Supabase 사용자 찾기/생성 (이메일 기준, 처음이면 자동 회원가입)
//      → magiclink 토큰(hashed_token) 발급 후 앱으로 리다이렉트
//   3) 앱 → supabase.auth.verifyOtp({ type:'email', token_hash }) 로 로그인 완료
//
// 배포 (이 함수는 로그인 전에 호출되므로 JWT 검증을 꺼야 함):
//   supabase functions deploy naver-auth --no-verify-jwt
// 필요한 시크릿:
//   supabase secrets set NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=...
// 네이버 개발자센터(developers.naver.com) 애플리케이션의 Callback URL 에
//   https://<프로젝트>.supabase.co/functions/v1/naver-auth 를 등록하세요.
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const redirectParam = url.searchParams.get('redirect_uri');

  const NAVER_CLIENT_ID = Deno.env.get('NAVER_CLIENT_ID');
  const NAVER_CLIENT_SECRET = Deno.env.get('NAVER_CLIENT_SECRET');
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    return new Response('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 시크릿을 설정하세요.', { status: 500 });
  }

  // Edge Function 자기 자신의 공개 URL (네이버 콜백으로 등록되는 주소)
  const selfUrl = `${url.origin}${url.pathname}`;

  // ---------- 1단계: 네이버 로그인 페이지로 ----------
  if (!code) {
    if (!redirectParam) return new Response('redirect_uri 파라미터가 필요합니다.', { status: 400 });
    const stateVal = btoa(JSON.stringify({ r: redirectParam, n: crypto.randomUUID() }));
    const authorize = new URL('https://nid.naver.com/oauth2.0/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', NAVER_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', selfUrl);
    authorize.searchParams.set('state', stateVal);
    return Response.redirect(authorize.toString(), 302);
  }

  // ---------- 2단계: 네이버 콜백 ----------
  let appRedirect: string | null = null;
  try {
    appRedirect = JSON.parse(atob(state ?? '')).r as string;
  } catch {
    /* invalid state */
  }
  if (!appRedirect) return new Response('state 가 올바르지 않습니다.', { status: 400 });

  // 네이버가 code 대신 error 를 돌려준 경우 그 사유를 앱으로 전달 (디버깅용)
  const naverErr = url.searchParams.get('error');
  if (naverErr) {
    const desc = url.searchParams.get('error_description') ?? naverErr;
    const sep = appRedirect.includes('?') ? '&' : '?';
    return Response.redirect(`${appRedirect}${sep}naver_error=${encodeURIComponent(desc)}`, 302);
  }

  const back = (params: Record<string, string>) => {
    const sep = appRedirect!.includes('?') ? '&' : '?';
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return Response.redirect(`${appRedirect}${sep}${qs}`, 302);
  };

  try {
    // 코드 → 네이버 액세스 토큰
    const tokenUrl = new URL('https://nid.naver.com/oauth2.0/token');
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    tokenUrl.searchParams.set('client_id', NAVER_CLIENT_ID);
    tokenUrl.searchParams.set('client_secret', NAVER_CLIENT_SECRET);
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('state', state ?? '');
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      return back({ naver_error: tokenJson.error_description ?? '네이버 토큰 교환에 실패했어요.' });
    }

    // 네이버 프로필 (이메일 필수)
    const meRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const me = await meRes.json();
    const email: string | undefined = me?.response?.email;
    const nickname: string | undefined = me?.response?.nickname ?? me?.response?.name;
    if (!email) {
      return back({ naver_error: '네이버 계정에서 이메일 제공에 동의해야 로그인할 수 있어요.' });
    }

    // Supabase 사용자 찾기/생성 (service role)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { display_name: nickname ?? email.split('@')[0], provider: 'naver' },
    });
    // 이미 가입된 이메일이면 그대로 로그인 진행
    if (createErr && !/already|registered|exists/i.test(createErr.message)) {
      return back({ naver_error: createErr.message });
    }

    // magiclink 토큰 발급 → 앱에서 verifyOtp 로 세션 수립
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    const tokenHash = linkData?.properties?.hashed_token;
    if (linkErr || !tokenHash) {
      return back({ naver_error: linkErr?.message ?? '로그인 토큰 발급에 실패했어요.' });
    }

    return back({ token_hash: tokenHash });
  } catch (e) {
    return back({ naver_error: e instanceof Error ? e.message : '네이버 로그인 중 오류가 발생했어요.' });
  }
});
