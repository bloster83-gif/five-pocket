-- 매도 체결 후 자동 종료
--
-- '매도 후 종료'를 눌렀는데 매도가 아직 체결되지 않은 경우, 그 자리에서 프로젝트를
-- 종료해 버리면 목록에서 사라져 '매도 주문완료 → 매도 완료' 전환을 확인할 수 없다.
-- 이 플래그를 남겨두고, 남은 매도가 전부 체결된 순간 앱이 프로젝트를 자동으로 종료한다.

alter table public.projects
  add column if not exists close_after_sell boolean not null default false;

comment on column public.projects.close_after_sell is
  '매도 주문이 전부 체결되면 프로젝트를 자동 종료할지 여부 (매도 후 종료 예약)';
