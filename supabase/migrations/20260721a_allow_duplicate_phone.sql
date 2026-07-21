-- =====================================================================
-- 휴대폰 번호 중복 가입 허용
--
-- 과거 버전에서 profiles.phone 에 UNIQUE 제약/인덱스가 걸려 있으면,
-- 이미 다른 계정에 등록된 번호로 인증할 때 "이미 다른 계정에 등록된 번호"
-- (unique_violation) 오류가 나면서 인증확인이 실패한다.
-- 여러 계정이 같은 번호를 쓸 수 있게, phone 단일 컬럼 UNIQUE 제약/인덱스를 모두 제거한다.
-- (idempotent — 없으면 아무것도 안 함)
-- =====================================================================

do $$
declare
  r record;
begin
  -- 1) phone 단일 컬럼 UNIQUE 제약 삭제
  for r in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and con.contype = 'u'
      and (
        select array_agg(a.attname order by a.attnum)
        from pg_attribute a
        where a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      ) = array['phone']
  loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;

  -- 2) 제약과 무관하게 만들어진 phone 단일 컬럼 UNIQUE 인덱스 삭제
  for r in
    select c2.relname as idxname
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_class c2 on c2.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and i.indisunique
      and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
      and (
        select array_agg(a.attname order by a.attnum)
        from pg_attribute a
        where a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      ) = array['phone']
  loop
    execute format('drop index if exists public.%I', r.idxname);
  end loop;
end $$;

-- 2.5) profiles 에 붙은 커스텀 트리거 중, 함수 본문이 번호 중복 차단 문구
--      ('사용중인 연락처' 등)를 담고 있으면 그 트리거를 제거 (번호 중복 허용).
do $$
declare
  r record;
begin
  for r in
    select t.tgname
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.profiles'::regclass
      and not t.tgisinternal
      and (
        pg_get_functiondef(p.oid) ilike '%사용중인 연락처%'
        or pg_get_functiondef(p.oid) ilike '%사용 중인 연락처%'
        or pg_get_functiondef(p.oid) ilike '%다른 계정에서 사용%'
      )
  loop
    execute format('drop trigger if exists %I on public.profiles', r.tgname);
  end loop;
end $$;

-- 3) 회원가입 트리거 함수를 "번호 중복 검사 없는" 정본으로 복원.
--    (운영 DB의 handle_new_user 에 '이미 다른 계정에서 사용중인 연락처' 같은
--     번호 중복 차단 로직이 들어가 있었다면 여기서 덮어써서 제거된다. schema.sql 과 동일)
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

  if v_phone is not null then
    delete from public.phone_otps where phone = v_phone;
  end if;
  return new;
end;
$$;
