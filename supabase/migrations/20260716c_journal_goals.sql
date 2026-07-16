-- =============================================================
-- 마이그레이션 3: 매매일지 독립 체결 입력 + 인생목표 입출금
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

-- 1) 매매일지에서 프로젝트/포켓 없이도 체결을 기록할 수 있도록
alter table public.trades alter column project_id drop not null;
alter table public.trades alter column pocket_id  drop not null;
alter table public.trades add column if not exists symbol text; -- 독립 체결의 종목코드
alter table public.trades add column if not exists name   text; -- 독립 체결의 종목명
alter table public.trades add column if not exists market text; -- 'KRX' | 'US'

-- 2) 인생목표: 연도별 입출금(순증감) 금액
alter table public.goal_actuals add column if not exists deposit numeric(20,2) not null default 0;
