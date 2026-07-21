// =====================================================================
// 회원 탈퇴 (완전 삭제) — Supabase Edge Function
//
// - 본인 탈퇴: 로그인한 사용자가 자기 계정을 삭제 (body 없음 or 본인 userId)
// - 관리자 탈퇴: 관리자(is_admin)가 body.userId 로 다른 회원을 삭제
//
// auth.users 행을 지우면 profiles/projects/pockets/trades/cash_flows/
// life_goals/broker_accounts/auto_orders 등 모든 데이터가 on delete cascade 로
// 자동 정리된다.
//
// 배포 (로그인 후 호출되므로 JWT 검증 유지):
//   supabase functions deploy delete-account
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anonKey || !serviceKey) return json({ error: '서버 설정 오류' }, 500);

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token || token === anonKey) return json({ error: '로그인이 필요해요.' }, 401);

    // 호출자(본인) 확인
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await userClient.auth.getUser();
    const callerId = userData?.user?.id;
    if (!callerId) return json({ error: '로그인이 필요해요.' }, 401);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // 삭제 대상: body.userId 있으면 그 사람, 없으면 본인
    let targetId = callerId;
    try {
      const body = await req.json();
      if (body?.userId) targetId = String(body.userId);
    } catch {
      /* 본문 없음 → 본인 탈퇴 */
    }

    // 다른 사람을 삭제하려면 관리자여야 함
    if (targetId !== callerId) {
      const { data: prof } = await admin.from('profiles').select('is_admin').eq('id', callerId).maybeSingle();
      if (!prof?.is_admin) {
        return json({ error: '권한이 없어요. (관리자만 다른 회원을 탈퇴시킬 수 있어요)' }, 403);
      }
    }

    // auth.users 삭제 → 모든 데이터 cascade 정리
    const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '탈퇴 처리 중 오류가 발생했어요.' }, 500);
  }
});
