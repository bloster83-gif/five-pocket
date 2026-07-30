import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase } from './supabase';

// OAuth 브라우저 세션 마무리 (웹/네이티브 공통 안전장치)
WebBrowser.maybeCompleteAuthSession();

export type SnsProvider = 'google' | 'kakao';
export type SnsButton = SnsProvider | 'naver' | 'apple';

/**
 * Apple 로그인 (iOS 전용) — App Store 심사 규정 4.8: 제3자 로그인(구글/카카오/네이버)을
 * 제공하는 앱은 'Apple로 로그인'도 반드시 제공해야 한다.
 * 네이티브 시트에서 인증 → identityToken 을 Supabase 에 전달해 세션 수립.
 * Supabase 대시보드 → Authentication → Providers → Apple 활성화 +
 * Client IDs 에 번들 ID(com.fivepocket.app) 추가 필요.
 */
export async function signInWithApple(): Promise<{ error?: string }> {
  if (Platform.OS !== 'ios') return { error: 'Apple 로그인은 iOS에서만 지원돼요.' };
  try {
    const AppleAuthentication = await import('expo-apple-authentication');
    const Crypto = await import('expo-crypto');
    if (!(await AppleAuthentication.isAvailableAsync())) {
      return { error: '이 기기에서는 Apple 로그인을 사용할 수 없어요.' };
    }
    // nonce: 재전송 공격 방지 — Apple 에는 해시를, Supabase 에는 원문을 전달
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
    if (!cred.identityToken) return { error: 'Apple 인증 토큰을 받지 못했어요.' };
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: cred.identityToken,
      nonce: rawNonce,
    });
    if (error) return { error: error.message };
    // 최초 가입 시 Apple 이 주는 이름을 프로필에 저장 (두 번째 로그인부터는 안 내려옴)
    const name = [cred.fullName?.familyName, cred.fullName?.givenName].filter(Boolean).join('');
    if (name) {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (uid) {
        await supabase
          .from('profiles')
          .update({ full_name: name, display_name: name })
          .eq('id', uid)
          .is('full_name', null);
      }
    }
    return {};
  } catch (e: any) {
    // 사용자가 시트를 닫은 경우는 조용히
    if (e?.code === 'ERR_REQUEST_CANCELED' || /canceled/i.test(String(e?.message))) return {};
    return { error: e?.message ?? 'Apple 로그인에 실패했어요.' };
  }
}

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

/**
 * 네이버 로그인.
 * Supabase 가 네이버를 기본 지원하지 않아 Edge Function(naver-auth)이 중계합니다.
 * - Supabase 대시보드에서 `naver-auth` 함수 배포 + NAVER_CLIENT_ID/SECRET 시크릿 설정 필요.
 * - 처음 로그인하면 자동으로 회원가입까지 됩니다.
 */
export async function signInWithNaver(): Promise<{ error?: string }> {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) return { error: 'Supabase 설정(.env)이 필요해요.' };
  const fnUrl = `${base}/functions/v1/naver-auth`;

  try {
    if (Platform.OS === 'web') {
      // 웹: 전체 리다이렉트 → 돌아오면 completeNaverWebLogin() 이 마무리
      window.location.href = `${fnUrl}?redirect_uri=${encodeURIComponent(window.location.origin)}`;
      return {};
    }

    const redirectTo = makeRedirectUri();
    const res = await WebBrowser.openAuthSessionAsync(
      `${fnUrl}?redirect_uri=${encodeURIComponent(redirectTo)}`,
      redirectTo
    );
    if (res.type !== 'success' || !res.url) return { error: '로그인이 취소되었어요.' };

    const errMatch = res.url.match(/[?&#]naver_error=([^&]+)/);
    if (errMatch) return { error: decodeURIComponent(errMatch[1]) };
    const hashMatch = res.url.match(/[?&#]token_hash=([^&]+)/);
    if (!hashMatch) return { error: '로그인 토큰을 받지 못했어요. naver-auth 함수 배포를 확인하세요.' };

    const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: hashMatch[1] });
    return { error: error?.message };
  } catch (e: any) {
    return { error: e?.message ?? '네이버 로그인 중 오류가 발생했어요.' };
  }
}

/**
 * (웹 전용) 네이버 로그인 후 ?token_hash= 로 돌아온 URL 을 감지해 세션을 수립.
 * 로그인 화면 mount 시 한 번 호출하세요. 해당 파라미터가 없으면 null 반환.
 */
export async function completeNaverWebLogin(): Promise<{ error?: string } | null> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const search = window.location.search;
  const errMatch = search.match(/[?&]naver_error=([^&]+)/);
  const hashMatch = search.match(/[?&]token_hash=([^&]+)/);
  if (!errMatch && !hashMatch) return null;
  // URL 정리 (새로고침 시 재시도 방지)
  window.history.replaceState(null, '', window.location.pathname);
  if (errMatch) return { error: decodeURIComponent(errMatch[1]) };
  const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: hashMatch![1] });
  return { error: error?.message };
}
