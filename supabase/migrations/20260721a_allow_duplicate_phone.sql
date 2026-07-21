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
