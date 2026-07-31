import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { initPurchases, setPurchasesUser } from './purchases';
import type { MemberTier, Profile } from '@/types/db';

interface AuthState {
  session: Session | null;
  loading: boolean;
  /** 내 프로필 (등급/관리자 여부 포함). 로그인 전이나 로딩 중엔 null */
  profile: Profile | null;
  /** 회원 등급. 프로필 로딩 전엔 기본값 'diary' */
  tier: MemberTier;
  isAdmin: boolean;
  /** 휴대폰 인증 완료 여부 (SNS 가입 후 번호 등록 게이트에 사용) */
  phoneVerified: boolean;
  /** 프로필을 한 번이라도 불러왔는지 (게이트 판단 전 대기용) */
  profileLoaded: boolean;
  /** 휴대폰 인증을 '나중에 하기'로 건너뛴 상태 (게이트 통과, MY 탭에서 나중에 완료) */
  phoneSkipped: boolean;
  skipPhoneVerification: () => void;
  refreshProfile: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    password: string,
    displayName: string,
    extra?: { fullName?: string; phone?: string }
  ) => Promise<{ error?: string; needsConfirm?: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  // 휴대폰 인증 '나중에 하기' — 앱 실행 중 유지되는 게이트 통과 플래그
  const [phoneSkipped, setPhoneSkipped] = useState(false);

  const loadProfile = async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
      setProfileLoaded(true);
      return;
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (data) {
      // 마이그레이션(20260716e) 전 DB에는 tier/is_admin 컬럼이 없을 수 있어 기본값으로 방어
      const p = {
        tier: 'diary',
        tier_expires_at: null,
        is_admin: false,
        email: null,
        ...(data as Partial<Profile>),
      } as Profile;
      // AUTO 기간 만료 감지 → 즉시 diary 로 강등 (서버 cron 이 놓쳐도 앱에서 방어)
      if (p.tier === 'auto' && p.tier_expires_at && new Date(p.tier_expires_at).getTime() <= Date.now()) {
        p.tier = 'diary';
        p.tier_expires_at = null;
        supabase
          .from('profiles')
          .update({ tier: 'diary', tier_expires_at: null })
          .eq('id', userId)
          .then(() => {});
      }
      setProfile(p);
    } else {
      setProfile(null);
    }
    setProfileLoaded(true);
  };

  useEffect(() => {
    // RevenueCat 초기화 (네이티브에서만 동작, 웹/Expo Go 에서는 no-op)
    initPurchases();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
      loadProfile(data.session?.user?.id);
      // 결제 시스템에 현재 로그인 사용자 연결 (웹훅이 이 id 로 등급을 갱신)
      setPurchasesUser(data.session?.user?.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setProfileLoaded(false);
      loadProfile(s?.user?.id);
      setPurchasesUser(s?.user?.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshProfile = async () => {
    await loadProfile(session?.user?.id);
  };

  const signIn: AuthState['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message };
  };

  const signUp: AuthState['signUp'] = async (email, password, displayName, extra) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName,
          full_name: extra?.fullName ?? null,
          phone: extra?.phone ?? null,
        },
      },
    });
    if (error) return { error: error.message };
    // 이미 휴대폰 OTP로 본인확인을 하므로 이메일 인증은 불필요.
    // 가입 직후 session 이 있으면 그대로 로그인. 없으면(설정에 따라) 바로 로그인 시도해서
    // 이메일 확인 링크 없이 앱으로 진입시킨다. (프로젝트에서 Confirm email 을 끄면 메일도 안 나감)
    if (!data.session) {
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      // Confirm email 이 아직 켜져 있으면 여기서 'Email not confirmed' 로 실패 → 안내 화면
      if (signInErr) return { needsConfirm: true };
    }
    return {};
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  // 화면을 켜둔 채 만료 시각이 지나도 자동매매가 돌지 않도록 렌더 시점에 재검사
  const tierExpired =
    profile?.tier === 'auto' &&
    !!profile.tier_expires_at &&
    new Date(profile.tier_expires_at).getTime() <= Date.now();

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        profile,
        tier: profile?.tier === 'auto' && !tierExpired ? 'auto' : 'diary',
        isAdmin: profile?.is_admin ?? false,
        phoneVerified: profile?.phone_verified ?? false,
        profileLoaded,
        phoneSkipped,
        skipPhoneVerification: () => setPhoneSkipped(true),
        refreshProfile,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
