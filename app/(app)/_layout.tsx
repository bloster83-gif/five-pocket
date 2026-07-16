import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
        headerBackButtonDisplayMode: 'minimal', // 뒤로가기: 텍스트 없이 아이콘만
        headerBackTitle: '',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="journal-entry" options={{ title: '체결 직접 입력', presentation: 'modal' }} />
      <Stack.Screen name="cash-flow" options={{ title: '입금 / 출금 / 배당', presentation: 'modal' }} />
      <Stack.Screen name="project/new" options={{ title: '새 프로젝트', presentation: 'modal' }} />
      <Stack.Screen name="project/[id]/index" options={{ title: '프로젝트' }} />
      <Stack.Screen name="project/[id]/trade" options={{ title: '체결 기록', presentation: 'modal' }} />
      <Stack.Screen name="project/[id]/chart" options={{ title: '차트' }} />
    </Stack>
  );
}
