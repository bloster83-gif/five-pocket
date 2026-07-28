-- =============================================================
-- 마이그레이션: 관심종목 레이더 그룹
--   watchlist_groups        : 사용자별 그룹 (이름)
--   watchlist_items.group_id: 종목 → 그룹 연결 (그룹 삭제 시 미분류로)
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

create table if not exists public.watchlist_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists watchlist_groups_user_idx on public.watchlist_groups (user_id);

alter table public.watchlist_groups enable row level security;
drop policy if exists "watchlist_groups self" on public.watchlist_groups;
create policy "watchlist_groups self" on public.watchlist_groups
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.watchlist_items
  add column if not exists group_id uuid references public.watchlist_groups (id) on delete set null;

create index if not exists watchlist_items_group_idx on public.watchlist_items (group_id);
