import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '@/theme';

function TabIcon({ emoji, color }: { emoji: string; color: string }) {
  return <Text style={{ fontSize: 20, opacity: color === colors.buy ? 1 : 0.6 }}>{emoji}</Text>;
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
