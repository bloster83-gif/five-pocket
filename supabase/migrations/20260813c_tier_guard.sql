-- 등급(tier) 자가 변경 차단
--
-- profiles RLS 는 "본인 행은 전부 수정 가능"이라, 사용자가 앱을 뜯어
-- tier = 'auto' 로 직접 바꾸면 결제 없이 자동매매를 쓸 수 있었다.
-- 등급·만료일·관리자 플래그는 아래 주체만 바꿀 수 있게 트리거로 막는다.
--   · service_role  : RevenueCat 웹훅, 자동매매 러너, 등급 검증 함수
--   · postgres      : pg_cron 만료 강등 작업
--   · 관리자         : 관리자 화면에서의 수동 등급 변경
--
-- (RLS 는 service_role 을 우회하지만 트리거는 우회하지 않으므로 여기서 함께 허용한다)

create or replace function public.guard_profile_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 등급과 무관한 수정(이름·푸시토큰 등)은 그대로 통과
  if new.tier is not distinct from old.tier
     and new.tier_expires_at is not distinct from old.tier_expires_at
     and new.is_admin is not distinct from old.is_admin then
    return new;
  end if;

  -- 서버 주체(웹훅·러너·cron)는 허용
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  -- 관리자 수동 변경은 허용
  if public.is_admin() then
    return new;
  end if;

  -- 본인이 스스로 등급을 '내리는' 것은 허용 (앱이 만료를 감지해 diary 로 정리하는 경로).
  -- 권한을 포기하는 방향이라 악용 소지가 없다.
  if auth.uid() = new.id and new.tier = 'diary' and new.is_admin is not distinct from old.is_admin then
    return new;
  end if;

  raise exception '등급은 직접 변경할 수 없습니다. 결제 또는 관리자를 통해서만 변경됩니다.'
    using errcode = '42501';
end;
$$;

drop trigger if exists profiles_tier_guard on public.profiles;
create trigger profiles_tier_guard
  before update on public.profiles
  for each row
  execute function public.guard_profile_tier();
