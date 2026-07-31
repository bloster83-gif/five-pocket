import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// env 인라인이 빠진 번들(OTA/Metro 캐시 등)에서도 동작하도록 app.json extra 폴백.
// 이 값이 비면 supabase 호출이 전부 'Network request failed' 로 실패한다.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL || (Constants.expoConfig?.extra?.supabaseUrl as string | undefined);
const anonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || (Constants.expoConfig?.extra?.supabaseAnonKey as string | undefined);

if (!url || !anonKey) {
  // .env 파일이 없으면 명확한 에러로 알려준다 (앱 실행 전 흔한 실수)
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY 가 설정되지 않았습니다. .env.example 을 .env 로 복사하고 값을 채우세요.'
  );
}

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon', {
  auth: {
    // React Native 에서는 AsyncStorage 로 세션을 저장, 웹에서는 기본(localStorage)
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

export const hasSupabaseConfig = Boolean(url && anonKey);
