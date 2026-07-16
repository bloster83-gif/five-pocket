import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase } from './supabase';

// OAuth 브라우저 세션 마무리 (웹/네이티브 공통 안전장치)
WebBrowser.maybeCompleteAuthSession();

export type SnsProvider = 'google' | 'kakao';

/**
 * SNS 로그인 (Google / Kakao).
 * - 처음 로그인하면 자동으로 회원가입까지 됩니다.
 * - Supabase 대시보드 → Authentication → Providers 에서 해당 provider 를
 *   활성화하고, Redirect URL 목록에 앱 스킴(fivepocket://)을 추가해야 동작합니다.
 */
export async function signInWithProvider(provider: SnsProvider): Promise<{ error?: string }> {
  try {
    if (Platform.OS === 'web') {
      // 웹: Supabase 기본 리다이렉트 흐름
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      return { error: error?.message };
    }

    // 네이티브(Expo Go/빌드): 인앱 브라우저로 열고 돌아온 URL에서 세션 수립
    const redirectTo = makeRedirectUri();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data?.url) return { error: error?.message ?? '로그인 URL 생성에 실패했어요.' };

    const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (res.type !== 'success' || !res.url) return { error: '로그인이 취소되었어요.' };

    // 1) implicit flow: URL fragment 에 토큰
    const frag = res.url.split('#')[1];
    if (frag) {
      const p = new URLSearchParams(frag);
      const access_token = p.get('access_token');
      const refresh_token = p.get('refresh_token');
      if (access_token && refresh_token) {
        const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
        return { error: setErr?.message };
      }
    }
    // 2) PKCE flow: ?code= 교환
    const codeMatch = res.url.match(/[?&]code=([^&]+)/);
    if (codeMatch) {
      const { error: exErr } = await supabase.auth.exchangeCodeForSession(codeMatch[1]);
      return { error: exErr?.message };
    }
    return { error: '로그인 토큰을 받지 못했어요. Supabase의 Redirect URL 설정을 확인하세요.' };
  } catch (e: any) {
    return { error: e?.message ?? 'SNS 로그인 중 오류가 발생했어요.' };
  }
}
