import { ScrollView } from 'react-native';
import { StatsContent } from '@/components/StatsContent';
import { spacing } from '@/theme';

// 통계는 MY 탭 안으로 합쳐졌지만, 라우트는 유지(직접 진입 대비).
export default function StatsScreen() {
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
      <StatsContent />
    </ScrollView>
  );
}
