-- =============================================================
-- 5-Pocket 매매 일지 — Supabase 스키마 + 멀티유저 보안(RLS)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요. (신규 설치용)
-- 기존 DB는 supabase/migrations/*.sql 을 날짜순으로 실행하세요.
-- 여러 사용자가 각자 계정으로 써도 서로의 데이터를 절대 볼 수 없도록
-- 모든 테이블에 Row Level Security(RLS)를 걸어 둡니다.
-- =============================================================

-- 안전하게 재실행 가능하도록 확장 활성화
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) profiles : auth.users 를 확장 (표시 이름, 푸시 토큰, 등급, 관리자)
--    tier: 'diary'(기본, 수동 매매) | 'auto'(관리자 인증, 자동 매매)
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  display_name    text,
  email           text,
  expo_push_token text,
  tier            text not null default 'diary' check (tier in ('diary', 'auto')),
  tier_expires_at timestamptz, -- AUTO 등급 만료 시각 (null = 무기한). 만료 시 diary 로 자동 강등
  is_admin        boolean not null default false,
  created_at      timestamptz not null default now()
);

-- 만료된 AUTO 회원을 diary 로 강등 (pg_cron 매시간 실행 권장 — 마이그레이션 g 참고)
create or replace function public.expire_auto_tiers()
returns void
language sql
security definer set search_path = public
as $$
  update public.profiles
  set tier = 'diary', tier_expires_at = null
  where tier = 'auto'
    and tier_expires_at is not null
    and tier_expires_at < now();
$$;

-- 회원가입 시 profiles 행 자동 생성
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 관리자 판별 함수 (RLS 정책 안에서 재귀 없이 쓰기 위해 security definer)
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ★ 최초 관리자 지정: 아래 주석을 본인 이메일로 바꿔 1회 실행하세요.
-- update public.profiles set is_admin = true where email = 'bloster83@gmail.com';

-- -------------------------------------------------------------
-- 2) projects : 종목 + 전략 설정(매수 간격%, 매도 목표%, 포켓 수)
--    한 사용자가 같은 종목으로 여러 프로젝트를 만들 수 있음
-- -------------------------------------------------------------
create table if not exists public.projects (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  symbol             text not null,                 -- 예: 'AAPL', '005930'
  name               text not null,                 -- 표시 이름
  market             text not null default 'MOCK',  -- 'KRX' | 'US' | 'MOCK'
  base_price         numeric(20,4) not null,        -- 기준가(1번 포켓 매수 기준)
  buy_interval_pct   numeric(6,3) not null default 5,   -- 포켓 간 매수 간격 %
  sell_target_pct    numeric(6,3) not null default 10,  -- 매도 목표 수익률 %
  pocket_count       int not null default 5 check (pocket_count between 1 and 10),
  total_budget       numeric(20,4),                 -- 프로젝트 전체 예산(선택)
  is_active          boolean not null default true, -- 실시간 추적/알림 on/off
  auto_trade_enabled boolean not null default false, -- 자동매매 on/off (AUTO 등급 전용)
  closed_at          timestamptz,                   -- null = 진행중, 값 = 종료됨
  created_at         timestamptz not null default now()
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
-- 4) trades : 실제 체결 기록 (프로젝트/포켓 없이 독립 체결도 가능)
-- -------------------------------------------------------------
create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  project_id   uuid references public.projects (id) on delete cascade,
  pocket_id    uuid references public.pockets (id) on delete cascade,
  symbol       text,                                 -- 독립 체결의 종목코드
  name         text,                                 -- 독립 체결의 종목명
  market       text,                                 -- 'KRX' | 'US'
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

-- -------------------------------------------------------------
-- 6) life_goals : 인생목표 (사용자당 1행)
-- -------------------------------------------------------------
create table if not exists public.life_goals (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  current_age  int not null,
  target_age   int not null,
  start_asset  numeric(20,2) not null default 0,
  target_asset numeric(20,2) not null default 0,
  base_year    int not null,  -- current_age 에 해당하는 연도
  updated_at   timestamptz not null default now()
);

-- 연도별 실제 달성 자산 (사용자가 입력)
create table if not exists public.goal_actuals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  year       int not null,
  amount     numeric(20,2) not null,
  deposit    numeric(20,2) not null default 0, -- 연중 순 입출금
  created_at timestamptz not null default now(),
  unique (user_id, year)
);

-- 연도별 목표금액 수기 수정 (올해 목표 직접 조정)
create table if not exists public.goal_target_overrides (
  user_id    uuid not null references auth.users (id) on delete cascade,
  year       int not null,
  amount     numeric(20,2) not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);

-- -------------------------------------------------------------
-- 7) cash_flows : 매매일지 현금흐름 (입금/출금/배당금)
-- -------------------------------------------------------------
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

-- -------------------------------------------------------------
-- 8) broker_accounts : 한국투자증권(KIS) OpenAPI 계좌 (사용자당 1개)
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

-- -------------------------------------------------------------
-- 9) auto_orders : 자동 매수/매도 주문 이력
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

-- =============================================================
-- Row Level Security : 각 사용자는 자기 데이터만 읽기/쓰기 가능
-- =============================================================
alter table public.profiles              enable row level security;
alter table public.projects              enable row level security;
alter table public.pockets               enable row level security;
alter table public.trades                enable row level security;
alter table public.price_alerts          enable row level security;
alter table public.life_goals            enable row level security;
alter table public.goal_actuals          enable row level security;
alter table public.goal_target_overrides enable row level security;
alter table public.cash_flows            enable row level security;
alter table public.broker_accounts       enable row level security;
alter table public.auto_orders           enable row level security;

-- profiles : 본인 행만 + 관리자는 전체 조회/등급 변경
drop policy if exists "profiles self" on public.profiles;
create policy "profiles self" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles admin read" on public.profiles;
create policy "profiles admin read" on public.profiles
  for select using (public.is_admin());

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

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

-- life_goals / goal_actuals / goal_target_overrides : 본인만
drop policy if exists "life_goals self" on public.life_goals;
create policy "life_goals self" on public.life_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goal_actuals self" on public.goal_actuals;
create policy "goal_actuals self" on public.goal_actuals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goal_target_overrides self" on public.goal_target_overrides;
create policy "goal_target_overrides self" on public.goal_target_overrides
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- cash_flows : 본인만
drop policy if exists "cash_flows self" on public.cash_flows;
create policy "cash_flows self" on public.cash_flows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- broker_accounts : 본인만
drop policy if exists "broker_accounts self" on public.broker_accounts;
create policy "broker_accounts self" on public.broker_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- auto_orders : 본인만 + 관리자는 전체 조회
drop policy if exists "auto_orders self" on public.auto_orders;
create policy "auto_orders self" on public.auto_orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "auto_orders admin read" on public.auto_orders;
create policy "auto_orders admin read" on public.auto_orders
  for select using (public.is_admin());

-- =============================================================
-- 실시간(Realtime) 구독 대상 테이블 등록 (선택)
-- =============================================================
alter publication supabase_realtime add table public.trades;
alter publication supabase_realtime add table public.pockets;
