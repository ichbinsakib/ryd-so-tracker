-- SO lifecycle follow-up log: one row per decision, follow-up, escalation or evidence reference on an SO.
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi). The lifecycle fields themselves live in shop_orders.data.
create table if not exists so_log (
  id        uuid primary key default gen_random_uuid(),
  record_id uuid not null references shop_orders (id) on delete cascade,
  at        timestamptz not null default now(),
  by_user   text not null default '',
  kind      text not null default 'NOTE' check (kind in ('NOTE', 'FOLLOW-UP', 'ESCALATION', 'DECISION', 'EVIDENCE')),
  text      text not null default '',
  ref       text not null default ''
);
create index if not exists so_log_record_idx on so_log (record_id, at desc);
alter table so_log enable row level security;
grant all on so_log to service_role;
