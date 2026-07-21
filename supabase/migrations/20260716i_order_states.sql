-- =============================================================
-- 마이그레이션 9: 주문완료(체결 대기) 중간 상태 추가
--
--  - pockets.status: 자동주문이 들어가면 'buy_ordered'/'sell_ordered'(주문완료)로
--    바뀌고, 실제 체결이 확인되면 'bought'/'sold'로 넘어간다.
--  - auto_orders.status: 체결 동기화 시 'filled' 로 표시하므로 허용값에 추가.
-- =============================================================

alter table public.pockets drop constraint if exists pockets_status_check;
alter table public.pockets
  add constraint pockets_status_check
  check (status in ('waiting', 'buy_ordered', 'bought', 'sell_ordered', 'sold'));

alter table public.auto_orders drop constraint if exists auto_orders_status_check;
alter table public.auto_orders
  add constraint auto_orders_status_check
  check (status in ('sent', 'filled', 'failed'));
