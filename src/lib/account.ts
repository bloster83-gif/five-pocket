// 회원 탈퇴(완전 삭제) — delete-account Edge Function 호출 래퍼
import { supabase } from './supabase';

const BASE = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * 계정 완전 삭제.
 *  - userId 없이 호출: 본인 탈퇴
 *  - userId 지정: 관리자만 가능 (다른 회원 탈퇴)
 * 성공 시 auth 계정 + 모든 데이터가 삭제된다.
 */
export async function deleteAccount(userId?: string): Promise<void> {
  if (!BASE) throw new Error('Supabase 설정(.env)이 필요해요.');
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error('로그인이 필요해요.');

  const res = await fetch(`${BASE}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(ANON ? { apikey: ANON } : {}),
    },
    body: JSON.stringify(userId ? { userId } : {}),
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(body?.error ?? `탈퇴 실패 (HTTP ${res.status})`);
}
