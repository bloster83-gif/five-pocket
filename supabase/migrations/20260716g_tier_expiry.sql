-- =============================================================
-- 마이그레이션 7: 기간제 AUTO 등급 (1개월/6개월/1년 인증 + 자동 만료)
-- Supabase SQL Editor 에 추가 실행하세요.
--
--  - profiles.tier_expires_at: AUTO 등급 만료 시각 (null = 무기한)
--  - 만료되면 자동으로 diary 등급으로 강등 → 자동매매도 함께 차단됨
--  - 만료 검사는 3중으로 동작:
--      1) 아래 pg_cron 이 매시간 5분에 DB에서 직접 강등
--      2) auto-trade-runner(무인 자동매매)가 매 실행마다 강등 + 만료자 제외
--      3) 앱도 로그인/새로고침 시 만료를 감지해 강등
-- =============================================================

alter table public.profiles
  add column if not exists tier_expires_at timestamptz;

-- 만료된 AUTO 회원을 diary 로 강등하는 함수
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

-- 매시간 5분에 만료 검사 (pg_cron)
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('expire-auto-tiers');
exception
  when others then null;
end $$;

select cron.schedule(
  'expire-auto-tiers',
  '5 * * * *',
  $$ select public.expire_auto_tiers(); $$
);

-- 확인:  select * from cron.job;
-- 수동 실행 테스트:  select public.expire_auto_tiers();
