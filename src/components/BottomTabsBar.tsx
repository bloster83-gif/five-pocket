import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '@/theme';

// 탭 그룹 밖의 상세 화면(프로젝트 상세 등)에서도 하단 탭이 보이도록 하는 커스텀 탭바.
// 누르면 해당 탭으로 이동한다. (탭 화면과 동일한 구성)
const TABS = [
  { key: 'index', label: '프로젝트', emoji: '📁', route: '/' },
  { key: 'pockets', label: '포켓', emoji: '🧺', route: '/pockets' },
  { key: 'journal', label: '매매일지', emoji: '📓', route: '/journal' },
  { key: 'goals', label: '인생목표', emoji: '🎯', route: '/goals' },
  { key: 'my', label: 'MY', emoji: '👤', route: '/my' },
] as const;

export function BottomTabsBar({ active }: { active?: string }) {
  const router = useRouter();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.card,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: 8,
        paddingBottom: 26,
      }}
    >
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => router.replace(t.route as any)}
            style={{ flex: 1, alignItems: 'center', gap: 2 }}
          >
            <Text style={{ fontSize: 20, opacity: on ? 1 : 0.6 }}>{t.emoji}</Text>
            <Text style={{ color: on ? colors.buy : colors.textDim, fontSize: 11, fontWeight: on ? '800' : '600' }}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
