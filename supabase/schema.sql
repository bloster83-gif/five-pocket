-- =============================================================
-- 5-Pocket 매매 일지 — Supabase 스키마 + 멀티유저 보안(RLS)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요.
-- 여러 사용자가 각자 계정으로 써도 서로의 데이터를 절대 볼 수 없도록
-- 모든 테이블에 Row Level Security(RLS)를 걸어 둡니다.
-- =============================================================

-- 안전하게 재실행 가능하도록 확장 활성화
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) profiles : auth.users 를 확장 (표시 이름, 푸시 토큰)
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  expo_push_token text,
  created_at    timestamptz not null default now()
);

-- 회원가입 시 profiles 행 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------
-- 2) projects : 종목 + 전략 설정(매수 간격%, 매도 목표%, 포켓 수)
--    한 사용자가 같은 종목으로 여러 프로젝트를 만들 수 있음
-- -------------------------------------------------------------
create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  symbol            text not null,                 -- 예: 'AAPL', '005930'
  name              text not null,                 -- 표시 이름
  market            text not null default 'MOCK',  -- 'KRX' | 'US' | 'MOCK'
  base_price        numeric(20,4) not null,        -- 기준가(1번 포켓 매수 기준)
  buy_interval_pct  numeric(6,3) not null default 5,   -- 포켓 간 매수 간격 %
  sell_target_pct   numeric(6,3) not null default 10,  -- 매도 목표 수익률 %
  pocket_count      int not null default 5 check (pocket_count between 1 and 10),
  total_budget      numeric(20,4),                 -- 프로젝트 전체 예산(선택)
  is_active         boolean not null default true, -- 실시간 추적/알림 on/off
  created_at        timestamptz not null default now()
);

create index if not exists projects_user_idx on public.projects (user_id);

-- -------------------------------------------------------------
-- 3) pockets : 프로젝트당 N개(기본 5). 각 포켓의 매수가/매도목표가/상태
-- -------------------------------------------------------------
create table if not exists public.pockets (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  idx                int  not null,                    -- 0 .. pocket_count-1
  buy_target_price   numeric(20,4) not null,           -- 이 가격 도달 시 매수 알림
  sell_target_price  numeric(20,4),                    -- 체결 후 이 가격 도달 시 매도 알림
  weight             numeric(6,3) not null default 20, -- 포켓 예산 비중(%)
  budget             numeric(20,4),                    -- 자동 배분된 금액(= total_budget * weight/100)
  status             text not null default 'waiting'   -- 'waiting' | 'bought' | 'sold'
                       check (status in ('waiting','bought','sold')),
  created_at         timestamptz not null default now(),
  unique (project_id, idx)
);

create index if not exists pockets_project_idx on public.pockets (project_id);

-- -------------------------------------------------------------
-- 4) trades : 실제 체결 기록(사용자가 직접 입력)
-- -------------------------------------------------------------
create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  pocket_id    uuid not null references public.pockets (id) on delete cascade,
  side         text not null check (side in ('buy','sell')),
  price        numeric(20,4) not null,
  quantity     numeric(20,4) not null,
  executed_at  timestamptz not null default now(),
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists trades_project_idx on public.trades (project_id);
create index if not exists trades_pocket_idx  on public.trades (pocket_id);

-- -------------------------------------------------------------
-- 5) price_alerts : 알림 발송 이력(중복 알림 방지 겸용)
-- -------------------------------------------------------------
create table if not exists public.price_alerts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  pocket_id       uuid references public.pockets (id) on delete cascade,
  kind            text not null check (kind in ('buy','sell')),
  target_price    numeric(20,4) not null,
  triggered_price numeric(20,4) not null,
  triggered_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists price_alerts_project_idx on public.price_alerts (project_id);

-- =============================================================
-- Row Level Security : 각 사용자는 자기 데이터만 읽기/쓰기 가능
-- =============================================================
alter table public.profiles     enable row level security;
alter table public.projects     enable row level security;
alter table public.pockets      enable row level security;
alter table public.trades       enable row level security;
alter table public.price_alerts enable row level security;

-- profiles : 본인 행만
drop policy if exists "profiles self" on public.profiles;
create policy "profiles self" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- projects : 소유자만
drop policy if exists "projects owner" on public.projects;
create policy "projects owner" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- pockets : 소속 프로젝트의 소유자만 (project 를 통해 소유권 확인)
drop policy if exists "pockets via project" on public.pockets;
create policy "pockets via project" on public.pockets
  for all using (
    exists (select 1 from public.projects p
            where p.id = pockets.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.projects p
            where p.id = pockets.project_id and p.user_id = auth.uid())
  );

-- trades : 소유자만
drop policy if exists "trades owner" on public.trades;
create policy "trades owner" on public.trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- price_alerts : 소유자만
drop policy if exists "alerts owner" on public.price_alerts;
create policy "alerts owner" on public.price_alerts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================
-- 실시간(Realtime) 구독 대상 테이블 등록 (선택)
-- =============================================================
alter publication supabase_realtime add table public.trades;
alter publication supabase_realtime add table public.pockets;
