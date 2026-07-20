import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { MemberTier, Profile } from '@/types/db';

interface AuthState {
  session: Session | null;
  loading: boolean;
  /** 내 프로필 (등급/관리자 여부 포함). 로그인 전이나 로딩 중엔 null */
  profile: Profile | null;
  /** 회원 등급. 프로필 로딩 전엔 기본값 'diary' */
  tier: MemberTier;
  isAdmin: boolean;
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

  const loadProfile = async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
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
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
      loadProfile(data.session?.user?.id);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      loadProfile(s?.user?.id);
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
    // 이메일 확인이 켜져 있으면 session 이 아직 null
    return { needsConfirm: !data.session };
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
