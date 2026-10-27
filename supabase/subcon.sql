-- Subcontractor tracking for the coordinator, modelled on the "BPO Tracking" worksheet:
-- one line per PO (SO + part + quantity) in a BPO batch, with milestone dates, quantities by outcome,
-- blockers / next actions, and an update log. The coordinator monitors; the subcontractor team executes.
-- Same rule as every table: RLS on, no policies, only the Edge Function (service role) touches them.

-- Replace the first (vendor-based) draft. Refuses to drop it if anyone has entered data there.
do $$
declare n bigint;
begin
  if to_regclass('sc_orders') is not null then
    execute 'select (select count(*) from sc_orders) + (select count(*) from sc_vendors) + (select count(*) from sc_lead_times)' into n;
    if n > 0 then raise exception 'The old subcontract tables contain % rows; not dropping them.', n; end if;
  end if;
end $$;
drop table if exists sc_steps, sc_lead_times, sc_orders, sc_vendors cascade;

create table if not exists sc_lines (
  id               uuid primary key default gen_random_uuid(),
  bpo_no           text not null default '',
  batch            text not null default '',
  po_no            text not null default '',
  po_key           text generated always as (upper(btrim(po_no))) stored,
  so_no            text not null default '',
  part_no          text not null default '',          -- CAMCO part
  ryd_part         text not null default '',
  description      text not null default '',
  qty              numeric not null check (qty > 0),  -- requested
  priority         text not null default 'NORMAL' check (priority in ('NORMAL', 'HIGH', 'LINE DOWN')),
  owner            text not null default '',          -- who on the subcontractor team handles it
  sent_date        date,                              -- requirement sent to the team (RFQ request date)
  required_date    date,                              -- PO due date at CAMCO
  customer_due_date date,
  ms               jsonb not null default '{}'::jsonb, -- milestone dates by key, see backend/Subcon.js MILESTONES
  qty_shipped      numeric not null default 0,
  qty_received     numeric not null default 0,
  qty_hold         numeric not null default 0,
  qty_rejected     numeric not null default 0,
  qty_stocked      numeric not null default 0,
  blocker_type     text not null default '',
  blocker          text not null default '',
  next_action      text not null default '',
  next_action_date date,
  revised_date     date,
  delay_reason     text not null default '',
  escalated        boolean not null default false,
  note             text not null default '',
  last_update      date,
  closed           boolean not null default false,
  created_by       text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists sc_lines_po_uq on sc_lines (po_key) where po_key <> '';
create index if not exists sc_lines_batch_idx on sc_lines (bpo_no, batch);

create table if not exists sc_updates (
  id      uuid primary key default gen_random_uuid(),
  line_id uuid not null references sc_lines (id) on delete cascade,
  at      timestamptz not null default now(),
  by_user text not null default '',
  kind    text not null default 'NOTE' check (kind in ('NOTE', 'FOLLOW-UP', 'ESCALATION', 'CHANGE')),
  text    text not null default ''
);
create index if not exists sc_updates_line_idx on sc_updates (line_id, at desc);

alter table sc_lines enable row level security;
alter table sc_updates enable row level security;
grant all on sc_lines, sc_updates to service_role;
