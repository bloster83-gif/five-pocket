-- 부분체결 추적
--
-- 15주를 주문했는데 5주만 체결되는 경우가 있다. 지금까지는 체결이 확인되면
-- 수량과 상관없이 주문을 종결(status='filled')해 버려서
--   · 남은 10주 주문이 증권사에 살아 있는데도 앱에서 사라지고(취소도 못 하고)
--   · 나중에 그 10주가 체결되면 앱은 모른 채 계좌와 수량이 어긋났다.
--
-- filled_qty 에 '지금까지 체결된 누계'를 기록해 두면
--   · 체결분만 그때그때 반영하고
--   · 전량 체결될 때까지 주문을 계속 추적할 수 있다.
--
-- 같은 체결을 두 번 기록하지 않도록, 갱신은 항상
--   update ... set filled_qty = <새 누계> where id = ? and filled_qty < <새 누계>
-- 형태로 한다 (단일 UPDATE 는 원자적이라 앱·서버 러너가 동시에 돌아도 한쪽만 이긴다).

alter table public.auto_orders
  add column if not exists filled_qty numeric(20,4) not null default 0;

comment on column public.auto_orders.filled_qty is
  '지금까지 체결된 누계 수량. quantity 보다 작으면 부분체결(주문은 계속 살아 있음)';
