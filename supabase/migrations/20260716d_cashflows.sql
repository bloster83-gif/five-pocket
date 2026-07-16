-- =============================================================
-- 마이그레이션 4: 매매일지 현금흐름 (입금/출금/배당금)
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

create table if not exists public.cash_flows (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  type        text not null check (type in ('deposit', 'withdrawal', 'dividend')),
  amount      numeric(20,2) not null,
  market      text not null default 'KRX', -- 통화 표기용 (KRX=원, US=달러)
  occurred_at timestamptz not null default now(),
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists cash_flows_user_idx on public.cash_flows (user_id);

alter table public.cash_flows enable row level security;

drop policy if exists "cash_flows self" on public.cash_flows;
create policy "cash_flows self" on public.cash_flows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
