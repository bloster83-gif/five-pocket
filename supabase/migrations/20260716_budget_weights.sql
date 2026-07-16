-- =============================================================
-- 마이그레이션: 포켓당 예산 → 프로젝트 예산 + 포켓별 비율/배분액
-- 이미 schema.sql 을 실행한 프로젝트라면 SQL Editor 에 이 파일만 추가 실행하세요.
-- (신규 설치는 schema.sql 에 이미 반영되어 있어 실행 불필요)
-- =============================================================

-- 프로젝트 전체 예산
alter table public.projects
  add column if not exists total_budget numeric(20,4);

-- 포켓별 비중(%)과 자동 배분된 금액
alter table public.pockets
  add column if not exists weight numeric(6,3) not null default 20;

alter table public.pockets
  add column if not exists budget numeric(20,4);

-- 더 이상 쓰지 않는 컬럼(있어도 무방하나 정리)
alter table public.projects
  drop column if exists budget_per_pocket;
