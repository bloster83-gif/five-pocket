import { Pressable, Text } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { colors, spacing } from '@/theme';

/**
 * 항상 동작하는 헤더 뒤로가기 버튼.
 *
 * 기본 '<' 는 화면이 다시 그려질 때(저장·목록 갱신 등) 눌러도 반응하지 않는 경우가 있어,
 * 모든 상세/모달 화면에서 이 컴포넌트로 뒤로가기를 직접 제공한다.
 * 되돌아갈 화면이 없으면 fallback 경로로 이동한다.
 *
 * 사용: 화면이 반환하는 JSX 맨 위에 <BackHeader fallback="/my" /> 를 넣는다.
 */
export function BackHeader({ fallback = '/' }: { fallback?: string }) {
  const router = useRouter();
  return (
    <Stack.Screen
      options={{
        headerLeft: () => (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback as any))}
            hitSlop={20}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.cardAlt,
              borderWidth: 1,
              borderColor: colors.border,
              marginLeft: spacing.sm,
              marginRight: spacing.sm,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800', marginTop: -3 }}>‹</Text>
          </Pressable>
        ),
      }}
    />
  );
}
