-- =============================================================
-- 마이그레이션 6: 24시간 무인 자동매매 스케줄 (pg_cron → Edge Function)
--
-- ★ 실행 전에 아래 두 값을 본인 것으로 바꾸세요! ★
--   1) YOUR_PROJECT_REF  : Supabase 프로젝트 URL 의 서브도메인
--      (대시보드 → Settings → API → Project URL 에서 확인)
--   2) YOUR_SERVICE_ROLE_KEY : 대시보드 → Settings → API → service_role 키
--
-- 사전 조건:
--   supabase functions deploy auto-trade-runner   (함수 먼저 배포)
--
-- 동작: 평일 매 1분마다 auto-trade-runner 함수를 호출합니다.
--       함수 내부에서 장 시간(국내 09:00~15:30 KST / 미국 정규장 09:30~16:00 ET)
--       외에는 해당 시장을 건너뛰므로 그대로 둬도 안전합니다.
--       (국내는 UTC 낮, 미국 정규장은 UTC 오후라 모두 평일 1-5 안에 들어옵니다.)
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 기존 스케줄이 있으면 제거 (없으면 무시)
do $$
begin
  perform cron.unschedule('auto-trade-runner');
exception
  when others then null;
end $$;

select cron.schedule(
  'auto-trade-runner',
  '* * * * 1-5', -- 평일 매 1분
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/auto-trade-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);

-- 스케줄 확인:  select * from cron.job;
-- 중지하려면:   select cron.unschedule('auto-trade-runner');
