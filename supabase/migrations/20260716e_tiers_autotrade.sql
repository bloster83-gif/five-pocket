-- =============================================================
-- 마이그레이션 5: 회원 등급(Diary/AUTO) + 관리자 + 자동매매(한국투자증권)
--                + 인생목표 연도별 목표금액 수기 수정
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

-- -------------------------------------------------------------
-- 1) profiles: 등급(tier) / 관리자 여부 / 이메일(관리자 화면 표시용)
--    - 최초 가입자 = 'diary' (다이어리 등급, 수동 매매)
--    - 관리자가 인증한 사용자 = 'auto' (오토 등급, 자동 매매)
-- -------------------------------------------------------------
alter table public.profiles
  add column if not exists tier text not null default 'diary'
    check (tier in ('diary', 'auto'));

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

alter table public.profiles
  add column if not exists email text;

-- 기존 가입자의 이메일 백필
update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is null;

-- 회원가입 트리거: 이메일도 함께 저장하도록 갱신
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

-- 관리자 판별 함수 (RLS 정책 안에서 재귀 없이 쓰기 위해 security definer)
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- 관리자: 모든 프로필 조회 + 등급 변경 가능
drop policy if exists "profiles admin read" on public.profiles;
create policy "profiles admin read" on public.profiles
  for select using (public.is_admin());

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- ★ 최초 관리자 지정: 아래 주석을 본인 이메일로 바꿔 1회 실행하세요.
-- update public.profiles set is_admin = true where email = 'bloster83@gmail.com';

-- -------------------------------------------------------------
-- 2) projects: 프로젝트별 자동매매 on/off (AUTO 등급 전용)
-- -------------------------------------------------------------
alter table public.projects
  add column if not exists auto_trade_enabled boolean not null default false;

-- -------------------------------------------------------------
-- 3) broker_accounts: 한국투자증권(KIS) OpenAPI 계좌 (사용자당 1개)
--    모의투자(is_virtual=true)로 먼저 검증 후 실전 전환을 권장합니다.
-- -------------------------------------------------------------
create table if not exists public.broker_accounts (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  broker               text not null default 'KIS',
  app_key              text not null,
  app_secret           text not null,
  account_no           text not null,              -- 종합계좌번호 앞 8자리
  account_product_code text not null default '01', -- 계좌상품코드 뒤 2자리
  is_virtual           boolean not null default true, -- true = 모의투자
  access_token         text,                       -- KIS 접근토큰 캐시 (24시간)
  token_expires_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.broker_accounts enable row level security;

drop policy if exists "broker_accounts self" on public.broker_accounts;
create policy "broker_accounts self" on public.broker_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -------------------------------------------------------------
-- 4) auto_orders: 자동 매수/매도 주문 이력
-- -------------------------------------------------------------
create table if not exists public.auto_orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  project_id    uuid references public.projects (id) on delete set null,
  pocket_id     uuid references public.pockets (id) on delete set null,
  side          text not null check (side in ('buy', 'sell')),
  symbol        text not null,
  order_price   numeric(20,4) not null,
  quantity      numeric(20,4) not null,
  status        text not null default 'sent'
                  check (status in ('sent', 'failed')),
  kis_order_no  text,           -- KIS 주문번호(ODNO)
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists auto_orders_user_idx    on public.auto_orders (user_id);
create index if not exists auto_orders_project_idx on public.auto_orders (project_id);

alter table public.auto_orders enable row level security;

drop policy if exists "auto_orders self" on public.auto_orders;
create policy "auto_orders self" on public.auto_orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 관리자는 전체 주문 이력 조회 가능 (관리자 페이지)
drop policy if exists "auto_orders admin read" on public.auto_orders;
create policy "auto_orders admin read" on public.auto_orders
  for select using (public.is_admin());

-- -------------------------------------------------------------
-- 5) goal_target_overrides: 인생목표 연도별 목표금액 수기 수정
-- -------------------------------------------------------------
create table if not exists public.goal_target_overrides (
  user_id    uuid not null references auth.users (id) on delete cascade,
  year       int not null,
  amount     numeric(20,2) not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);

alter table public.goal_target_overrides enable row level security;

drop policy if exists "goal_target_overrides self" on public.goal_target_overrides;
create policy "goal_target_overrides self" on public.goal_target_overrides
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
