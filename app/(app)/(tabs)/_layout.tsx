import { useEffect } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { setProjectCount, useProjectCount } from '@/lib/badges';
import { colors, daysUntil, spacing } from '@/theme';

// 레이더를 가장 왼쪽 탭으로 두더라도, 앱 시작 화면은 항상 '프로젝트'(index)로 고정
export const unstable_settings = { initialRouteName: 'index' };

function TabIcon({ emoji, color }: { emoji: string; color: string }) {
  return <Text style={{ fontSize: 20, opacity: color === colors.buy ? 1 : 0.6 }}>{emoji}</Text>;
}

// 헤더 중앙: 로고(5 포함) + 흰색 'Pocket Diary'
function HeaderTitle() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <Image source={require('../../../assets/logo-sm.png')} style={{ width: 26, height: 26, borderRadius: 8 }} resizeMode="contain" />
      <Text style={{ color: '#FFFFFF', fontWeight: '900', fontSize: 17 }}>Pocket Diary</Text>
    </View>
  );
}

// 헤더 왼쪽: 내 등급 배지 (Diary / AUTO). AUTO 는 남은 기간(D-day)도 표시
function TierBadge() {
  const { tier, profile } = useAuth();
  const isAuto = tier === 'auto';
  const exp = isAuto ? profile?.tier_expires_at : null;
  const dday = exp ? daysUntil(exp) : null;
  return (
    <View
      style={{
        marginLeft: spacing.md,
        backgroundColor: isAuto ? 'rgba(34,211,166,0.14)' : colors.cardAlt,
        borderRadius: isAuto && dday != null ? 12 : 999,
        paddingHorizontal: 8,
        paddingVertical: isAuto && dday != null ? 2 : 3,
        borderWidth: 1,
        borderColor: isAuto ? colors.primary : colors.border,
        maxWidth: 110,
        alignItems: 'center',
      }}
    >
      {/* AUTO 회원은 위에 AUTO, 아래 줄에 D-day 를 세로로 쌓아 보기 좋게 (초록색) */}
      <Text style={{ color: isAuto ? colors.primary : colors.textDim, fontWeight: '900', fontSize: 10, lineHeight: 12 }}>
        {isAuto ? 'AUTO' : 'Diary'}
      </Text>
      {isAuto && dday != null && (
        <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 9, lineHeight: 11 }}>D-{dday}</Text>
      )}
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
  const { session } = useAuth();
  const projectCount = useProjectCount();

  // 진입 시 프로젝트 개수를 한 번 조회해 배지 초기값 세팅 (목록 탭을 아직 안 열었어도 정확)
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', uid)
      .is('closed_at', null) // 진행중(종료 제외)만 카운트
      .then(({ count }) => {
        if (typeof count === 'number') setProjectCount(count);
      });
  }, [session?.user?.id]);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        // 모든 탭 상단 중앙에 로고 + 앱 이름 고정
        headerTitle: () => <HeaderTitle />,
        headerTitleAlign: 'center',
        headerLeft: () => <TierBadge />,
        headerRight: () => <AdminButton />,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.buy,
        tabBarInactiveTintColor: colors.textDim,
      }}
    >
      {/* 가장 왼쪽: 관심종목 레이더 */}
      <Tabs.Screen
        name="radar"
        options={{
          title: '레이더',
          tabBarIcon: ({ color }) => <TabIcon emoji="📡" color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: '프로젝트',
          tabBarIcon: ({ color }) => <TabIcon emoji="📁" color={color} />,
          // 프로젝트 개수 배지 (0이면 숨김)
          tabBarBadge: projectCount > 0 ? projectCount : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.buy, color: '#fff', fontSize: 11, fontWeight: '800' },
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
        name="my"
        options={{
          title: 'MY',
          tabBarIcon: ({ color }) => <TabIcon emoji="👤" color={color} />,
        }}
      />
      {/* 통계 화면은 MY 탭 안으로 합쳐짐 — 탭바에서 숨김 */}
      <Tabs.Screen name="stats" options={{ href: null }} />
    </Tabs>
  );
}
