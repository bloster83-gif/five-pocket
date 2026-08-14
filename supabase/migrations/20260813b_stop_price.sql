-- 마지노선(손절) 가격
--
-- 보유 중인 포켓에 '이 가격까지 떨어지면 무조건 판다'는 하한선을 둔다.
-- 매도 목표가(위쪽)와 대칭으로 아래쪽을 막아 손실을 제한하고 최소 이익을 지킨다.
--   · stop_price 가 null 이면 마지노선 없음 (기존 동작 그대로)
--   · 현재가 <= stop_price 이면 'stop' 신호 → 자동매매는 현재가로 전량 매도

alter table public.pockets
  add column if not exists stop_price numeric(20,4);

comment on column public.pockets.stop_price is
  '마지노선(손절) 가격 — 현재가가 이 값 이하로 내려가면 전량 매도. null = 사용 안 함';

-- 알림 이력에 'stop' 종류 추가
alter table public.price_alerts
  drop constraint if exists price_alerts_kind_check;
alter table public.price_alerts
  add constraint price_alerts_kind_check check (kind in ('buy', 'sell', 'stop'));
