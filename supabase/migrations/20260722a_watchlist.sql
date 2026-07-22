-- =============================================================
-- 마이그레이션: 관심종목 레이더 (watchlist) + 종목별 메모
--   watchlist_items : 관심종목 (기준가 직접 입력, 현재가/기준가 = 기준가 대비 %)
--   watchlist_memos : 종목별 메모 (날짜 자동 기록)
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

create table if not exists public.watchlist_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  symbol      text not null,               -- 야후 시세용 심볼 (예: 005930.KS, AAPL)
  name        text not null,               -- 표시용 종목명
  market      text not null default 'KRX', -- 'KRX' | 'US' (통화·시세 판별)
  base_price  numeric(20,4) not null default 0, -- 사용자가 입력한 기준가
  created_at  timestamptz not null default now()
);

create index if not exists watchlist_items_user_idx on public.watchlist_items (user_id);

alter table public.watchlist_items enable row level security;
drop policy if exists "watchlist_items self" on public.watchlist_items;
create policy "watchlist_items self" on public.watchlist_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.watchlist_memos (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.watchlist_items (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  note        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists watchlist_memos_item_idx on public.watchlist_memos (item_id);

alter table public.watchlist_memos enable row level security;
drop policy if exists "watchlist_memos self" on public.watchlist_memos;
create policy "watchlist_memos self" on public.watchlist_memos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
