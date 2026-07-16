import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { confirmAction, notify } from '@/lib/alert';
import { Card } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';
import type { MemberTier, Profile } from '@/types/db';

// profiles.tier 컬럼이 아직 없을 때(마이그레이션 전) 나는 에러인지 판별
function isMissingSchema(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const s = `${err.code ?? ''} ${err.message ?? ''}`;
  return /42703|42P01|PGRST204|PGRST205|does not exist|schema cache/i.test(s);
}

const TIER_META: Record<MemberTier, { label: string; color: string; bg: string; desc: string }> = {
  diary: { label: 'Diary', color: colors.textDim, bg: colors.cardAlt, desc: '수동 매매 (기본)' },
  auto: { label: 'AUTO', color: colors.buy, bg: colors.buyBg, desc: '자동 매매 (인증)' },
};

export default function AdminScreen() {
  const { isAdmin, session } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | MemberTier>('all');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      setMigrationNeeded(isMissingSchema(error));
    } else if (data) {
      setUsers(
        (data as Partial<Profile>[]).map(
          (p) => ({ tier: 'diary', is_admin: false, email: null, ...p }) as Profile
        )
      );
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const counts = useMemo(() => {
    const c = { all: users.length, diary: 0, auto: 0 };
    users.forEach((u) => (c[u.tier] += 1));
    return c;
  }, [users]);

  const shown = useMemo(
    () => (filter === 'all' ? users : users.filter((u) => u.tier === filter)),
    [users, filter]
  );

  const setTier = async (u: Profile, tier: MemberTier) => {
    if (u.tier === tier) return;
    setSavingId(u.id);
    const { error } = await supabase.from('profiles').update({ tier }).eq('id', u.id);
    setSavingId(null);
    if (error) {
      if (isMissingSchema(error)) {
        setMigrationNeeded(true);
        return notify('DB 준비 필요', '마이그레이션(20260716e)을 Supabase에서 먼저 실행하세요.');
      }
      return notify('변경 실패', error.message);
    }
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, tier } : x)));
  };

  const onSetTier = (u: Profile, tier: MemberTier) => {
    if (tier === 'auto') {
      confirmAction(
        'AUTO 등급 인증',
        `"${u.display_name ?? u.email ?? u.id}" 님을 AUTO 등급으로 인증할까요?\n자동 매수/매도 기능이 활성화됩니다.`,
        () => setTier(u, tier),
        '인증'
      );
    } else {
      confirmAction(
        'Diary 등급으로 변경',
        `"${u.display_name ?? u.email ?? u.id}" 님을 Diary 등급(수동 매매)으로 되돌릴까요?`,
        () => setTier(u, tier),
        '변경'
      );
    }
  };

  if (!isAdmin) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg }}>
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>관리자 전용 페이지입니다</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            관리자 권한이 없는 계정이에요. Supabase SQL Editor에서{'\n'}
            update profiles set is_admin = true where email = '내 이메일';{'\n'}
            을 실행하면 이 계정을 관리자로 지정할 수 있습니다.
          </Text>
        </Card>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.buy} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 40 }}>
      {migrationNeeded && (
        <Card style={{ borderColor: colors.warn }}>
          <Text style={{ color: colors.warn, fontWeight: '800' }}>DB 마이그레이션이 필요해요</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            Supabase SQL Editor에서 마이그레이션(20260716e)을 실행하면 등급 관리가 켜집니다.
          </Text>
        </Card>
      )}

      {/* 요약 + 필터 */}
      <Card>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>👑 회원 관리</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(
            [
              { key: 'all', label: `전체 ${counts.all}` },
              { key: 'diary', label: `Diary ${counts.diary}` },
              { key: 'auto', label: `AUTO ${counts.auto}` },
            ] as const
          ).map((f) => {
            const on = filter === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 999,
                  backgroundColor: on ? colors.buyBg : colors.cardAlt,
                  borderWidth: 1,
                  borderColor: on ? colors.buy : colors.border,
                }}
              >
                <Text style={{ color: on ? colors.buy : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ color: colors.textDim, fontSize: 11 }}>
          Diary = 최초 가입 등급(수동 매매) · AUTO = 관리자가 인증한 등급(자동 매매)
        </Text>
      </Card>

      {shown.length === 0 && (
        <Card>
          <Text style={{ color: colors.textDim }}>표시할 회원이 없어요.</Text>
        </Card>
      )}

      {shown.map((u) => {
        const meta = TIER_META[u.tier];
        const isMe = u.id === session?.user?.id;
        return (
          <Card key={u.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>
                    {u.display_name ?? '(이름 없음)'}
                  </Text>
                  {u.is_admin && <Text style={{ fontSize: 12 }}>👑</Text>}
                  {isMe && (
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>(나)</Text>
                  )}
                </View>
                <Text style={{ color: colors.textDim, fontSize: 12 }}>{u.email ?? '-'}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>
                  가입 {u.created_at?.slice(0, 10) ?? '-'}
                </Text>
              </View>
              <View style={{ backgroundColor: meta.bg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}>
                <Text style={{ color: meta.color, fontWeight: '900', fontSize: 13 }}>{meta.label}</Text>
              </View>
            </View>

            {/* 등급 변경 버튼 */}
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {(['diary', 'auto'] as MemberTier[]).map((t) => {
                const on = u.tier === t;
                const m = TIER_META[t];
                return (
                  <Pressable
                    key={t}
                    disabled={on || savingId === u.id}
                    onPress={() => onSetTier(u, t)}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      paddingVertical: 10,
                      borderRadius: radius.md,
                      backgroundColor: on ? m.bg : colors.cardAlt,
                      borderWidth: 1,
                      borderColor: on ? m.color : colors.border,
                      opacity: savingId === u.id ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: on ? m.color : colors.textDim, fontWeight: '800', fontSize: 13 }}>
                      {on ? '✓ ' : ''}
                      {m.label}
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 10 }}>{m.desc}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );
}
