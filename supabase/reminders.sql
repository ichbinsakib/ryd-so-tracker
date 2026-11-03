-- Status reminders (ANR / RFS / ANALYSIS): remember when each SO entered its status and how many reminder
-- emails it has had. Run once in the SQL editor; safe to run again.
-- Existing SOs start their 24 hours when this runs (the app never recorded when they entered a status).
alter table shop_orders add column if not exists status_since   timestamptz not null default now();
alter table shop_orders add column if not exists remind_count   integer     not null default 0;
alter table shop_orders add column if not exists last_remind_at timestamptz;

-- A new SO, or any change of STATUS, restarts the clock and the reminder count.
create or replace function shop_orders_status_clock() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or (new.data->>'status') is distinct from (old.data->>'status') then
    new.status_since := now(); new.remind_count := 0; new.last_remind_at := null;
  end if;
  return new;
end $$;

drop trigger if exists shop_orders_status_clock on shop_orders;
create trigger shop_orders_status_clock before insert or update on shop_orders
  for each row execute function shop_orders_status_clock();

create index if not exists shop_orders_status_idx on shop_orders ((data->>'status'));
