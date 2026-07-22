-- =============================================================
-- 마이그레이션: 체결(trades) 사용자 메모 컬럼
--   note = 시스템/입력 기록(자동주문 판별용), user_note = 사용자가 직접 남기는 메모
-- Supabase SQL Editor 에 추가 실행하세요.
-- =============================================================

alter table public.trades add column if not exists user_note text;
