-- =============================================================
-- 마이그레이션 2: 프로젝트 종료(closed_at) + 인생목표 테이블
-- 이미 앱을 쓰던 DB라면 SQL Editor 에 이 파일을 추가 실행하세요.
-- =============================================================

-- 1) 프로젝트 종료 시각 (null = 진행중, 값 있음 = 종료됨)
alter table public.projects
  add column if not exists closed_at timestamptz;

-- 2) 인생목표 (사용자당 1행)
create table if not exists public.life_goals (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  current_age  int not null,
  target_age   int not null,
  start_asset  numeric(20,2) not null default 0,
  target_asset numeric(20,2) not null default 0,
  base_year    int not null,  -- current_age 에 해당하는 연도
  updated_at   timestamptz not null default now()
);

-- 3) 연도별 실제 달성 자산 (사용자가 입력)
create table if not exists public.goal_actuals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  year       int not null,
  amount     numeric(20,2) not null,
  created_at timestamptz not null default now(),
  unique (user_id, year)
);

-- RLS
alter table public.life_goals   enable row level security;
alter table public.goal_actuals enable row level security;

drop policy if exists "life_goals self" on public.life_goals;
create policy "life_goals self" on public.life_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goal_actuals self" on public.goal_actuals;
create policy "goal_actuals self" on public.goal_actuals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
