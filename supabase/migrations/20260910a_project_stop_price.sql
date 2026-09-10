-- 프로젝트 마지노선
--
-- 포켓 마지노선(pockets.stop_price, 20260813b)은 '보유중 포켓 하나'의 손절선이다.
-- 정기매수법처럼 가격과 상관없이 계속 사는 프로젝트에는 '이 아래로는 더 안 산다'는
-- 프로젝트 단위의 하한선이 필요해서 projects.stop_price 를 둔다.
--
-- 현재가 <= stop_price 이면
--   ① 보유중 포켓: 포켓 마지노선이 따로 없으면 이 값으로 'stop' 신호 → 현재가로 전량 매도
--   ② 대기중 포켓: 예정 시각·목표가에 닿아도 매수하지 않는다 (매수 보류)
-- 가격이 선 위로 돌아오면 보류됐던 매수는 그대로 재개된다.
-- null = 사용 안 함 (기존 동작 그대로)

alter table public.projects
  add column if not exists stop_price numeric(20,4);

comment on column public.projects.stop_price is
  '프로젝트 마지노선 — 현재가가 이 값 이하면 보유 포켓 전량 매도 + 대기 포켓 매수 보류. null = 사용 안 함';
