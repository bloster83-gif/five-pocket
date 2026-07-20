-- =============================================================
-- 마이그레이션 8: 회원가입 정보 확장 (실명 + 휴대폰 + 휴대폰 SMS 인증)
-- Supabase SQL Editor 에 추가 실행하세요.
--
--  - profiles.full_name (실명), phone (휴대폰), phone_verified (인증 여부)
--  - phone_otps: 가입 전 휴대폰 SMS 인증코드 저장 (service_role 만 접근)
--  - 가입 트리거가 인증된 휴대폰이면 phone_verified=true 로 저장
-- =============================================================

alter table public.profiles
  add column if not exists full_name text;      -- 실명
alter table public.profiles
  add column if not exists phone text;           -- 휴대폰 번호 (숫자만)
alter table public.profiles
  add column if not exists phone_verified boolean not null default false;

-- 가입 전(로그인 전) 휴대폰 인증코드 임시 저장 테이블
create table if not exists public.phone_otps (
  phone       text primary key,          -- 숫자만 (예: 01012345678)
  code        text not null,             -- 6자리 인증코드
  expires_at  timestamptz not null,      -- 만료 시각 (보통 5분)
  verified    boolean not null default false,
  attempts    int not null default 0,    -- 코드 확인 시도 횟수 (무차별 대입 방지)
  sent_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- RLS: 일반 사용자는 접근 불가. Edge Function(service_role)만 읽고 쓴다.
alter table public.phone_otps enable row level security;
-- (정책을 만들지 않으면 anon/authenticated 는 전부 차단됨 = 의도된 동작)

-- 가입 트리거: 실명/휴대폰 저장 + 인증된 휴대폰이면 phone_verified=true
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_phone text := nullif(new.raw_user_meta_data->>'phone', '');
  v_verified boolean := false;
begin
  if v_phone is not null then
    select verified into v_verified from public.phone_otps
      where phone = v_phone and verified = true;
    v_verified := coalesce(v_verified, false);
  end if;

  insert into public.profiles (id, display_name, full_name, email, phone, phone_verified)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'full_name',
    new.email,
    v_phone,
    v_verified
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        phone = coalesce(excluded.phone, public.profiles.phone),
        phone_verified = public.profiles.phone_verified or excluded.phone_verified;

  -- 사용한 인증코드 정리
  if v_phone is not null then
    delete from public.phone_otps where phone = v_phone;
  end if;
  return new;
end;
$$;
