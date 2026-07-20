import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '@/lib/auth';
import { registerForNotifications } from '@/lib/notifications';
import { colors } from '@/theme';

function RootNavigator() {
  const { session, loading, phoneVerified, profileLoaded } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    const onVerifyPhone = segments.includes('verify-phone');
    if (!session && !inAuthGroup) {
      router.replace('/login');
    } else if (session && inAuthGroup) {
      router.replace('/');
    } else if (session && profileLoaded && !phoneVerified && !onVerifyPhone) {
      // 로그인했지만 휴대폰 인증이 안 된 경우(SNS 가입 등) → 번호 등록 게이트로
      router.replace('/verify-phone');
    } else if (session && profileLoaded && phoneVerified && onVerifyPhone) {
      router.replace('/');
    }
  }, [session, loading, segments, phoneVerified, profileLoaded]);

  useEffect(() => {
    if (session?.user?.id) registerForNotifications(session.user.id);
  }, [session?.user?.id]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <StatusBar style="light" />
        <RootNavigator />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
