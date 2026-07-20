import { Tabs, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { colors, spacing } from '@/theme';

function TabIcon({ emoji, color }: { emoji: string; color: string }) {
  return <Text style={{ fontSize: 20, opacity: color === colors.buy ? 1 : 0.6 }}>{emoji}</Text>;
}

// 헤더 왼쪽: 내 등급 배지 (Diary / AUTO). AUTO 는 남은 기간(D-day)도 표시
function TierBadge() {
  const { tier, profile } = useAuth();
  const isAuto = tier === 'auto';
  const exp = isAuto ? profile?.tier_expires_at : null;
  const dday = exp ? Math.max(0, Math.ceil((new Date(exp).getTime() - Date.now()) / 86400000)) : null;
  return (
    <View
      style={{
        marginLeft: spacing.md,
        backgroundColor: isAuto ? colors.buyBg : colors.cardAlt,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 3,
        borderWidth: 1,
        borderColor: isAuto ? colors.buy : colors.border,
      }}
    >
      <Text style={{ color: isAuto ? colors.buy : colors.textDim, fontWeight: '900', fontSize: 11 }}>
        {isAuto ? `AUTO${dday != null ? ` D-${dday}` : ''}` : 'Diary'}
      </Text>
    </View>
  );
}

// 헤더 오른쪽: 관리자만 보이는 회원 관리 버튼
function AdminButton() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  if (!isAdmin) return <View style={{ width: 44 }} />;
  return (
    <Pressable
      onPress={() => router.push('/admin')}
      hitSlop={10}
      style={{ width: 44, height: 40, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontSize: 18 }}>👑</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        // 모든 탭 상단 중앙에 앱 이름 고정
        headerTitle: '5 Pocket Diary',
        headerTitleAlign: 'center',
        headerTitleStyle: { fontWeight: '900', fontSize: 18, color: colors.buy },
        headerLeft: () => <TierBadge />,
        headerRight: () => <AdminButton />,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.buy,
        tabBarInactiveTintColor: colors.textDim,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '프로젝트',
          tabBarIcon: ({ color }) => <TabIcon emoji="📁" color={color} />,
        }}
      />
      <Tabs.Screen
        name="pockets"
        options={{
          title: '포켓',
          tabBarIcon: ({ color }) => <TabIcon emoji="🧺" color={color} />,
        }}
      />
      <Tabs.Screen
        name="journal"
        options={{
          title: '매매일지',
          tabBarIcon: ({ color }) => <TabIcon emoji="📓" color={color} />,
        }}
      />
      <Tabs.Screen
        name="goals"
        options={{
          title: '인생목표',
          tabBarIcon: ({ color }) => <TabIcon emoji="🎯" color={color} />,
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: '통계',
          tabBarIcon: ({ color }) => <TabIcon emoji="📊" color={color} />,
        }}
      />
    </Tabs>
  );
}
