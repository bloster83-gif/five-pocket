-- 정기(적립식) 매수 프로젝트
--
-- 지금까지 포켓은 '가격이 얼마까지 내려오면 산다'로만 동작했다.
-- 여기에 '정해진 날짜·시각이 되면 산다'를 더한다.
--   · projects.buy_mode = 'price'    기존 방식 (기준가에서 간격 %씩 내려갈 때마다 매수)
--   · projects.buy_mode = 'schedule' 정기 매수 (포켓마다 예정 시각, 그 시각에 현재가로 매수)
--
-- 정기 매수 포켓은 pockets.buy_at 에 '살 시각'을 갖는다.
-- 그 시각이 지나면 현재가 지정가로, 배분 예산으로 살 수 있는 최대 수량을 주문한다.
-- 매도는 기존과 같다 — 실제 체결가 대비 sell_target_pct 만큼 오르면 판다.
--
-- buy_at 이 있는 포켓은 가격 조건을 보지 않는다 (시각만 본다).

alter table public.projects
  add column if not exists buy_mode text not null default 'price';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_buy_mode_check'
  ) then
    alter table public.projects
      add constraint projects_buy_mode_check check (buy_mode in ('price', 'schedule'));
  end if;
end $$;

alter table public.pockets
  add column if not exists buy_at timestamptz;

comment on column public.projects.buy_mode is
  '매수 방식 — price: 목표가 도달 시 매수(기본) / schedule: 정해진 시각에 현재가로 매수';
comment on column public.pockets.buy_at is
  '정기 매수 예정 시각. 이 시각이 지나면 현재가로 매수한다. null = 가격 방식 포켓';

-- 예정 시각이 지난 대기 포켓을 러너가 빨리 찾도록
create index if not exists pockets_buy_at_idx on public.pockets (buy_at) where buy_at is not null;
