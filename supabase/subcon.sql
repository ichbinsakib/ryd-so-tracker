-- Subcontract module: vendors, subcontract orders (whole part made by a vendor), routing steps, lead-time table.
-- Same rule as every table: RLS on, no policies, only the Edge Function (service role) touches them.

create table if not exists sc_vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  name_key   text generated always as (lower(btrim(name))) stored,
  contact    text not null default '',
  email      text not null default '',
  phone      text not null default '',
  notes      text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists sc_vendors_name_uq on sc_vendors (name_key);

create table if not exists sc_orders (
  id            uuid primary key default gen_random_uuid(),
  sc_no         text not null,
  sc_key        text generated always as (upper(btrim(sc_no))) stored,
  so_no         text not null default '',
  part_no       text not null default '',
  description   text not null default '',
  qty           numeric not null default 0,
  vendor_id     uuid references sc_vendors (id) on delete set null,
  status        text not null default 'QUOTING' check (status in ('QUOTING', 'PO PLACED', 'IN PROCESS', 'RECEIVED', 'CANCELLED')),
  po_no         text not null default '',
  quote_date    date,
  po_date       date,
  promised_date date,
  received_date date,
  quote_amt     numeric,
  po_amt        numeric,
  invoice_amt   numeric,
  notes         text not null default '',
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists sc_orders_key_uq on sc_orders (sc_key);
create index if not exists sc_orders_vendor_idx on sc_orders (vendor_id);

create table if not exists sc_steps (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references sc_orders (id) on delete cascade,
  seq           int not null default 1,
  name          text not null default '',
  vendor_id     uuid references sc_vendors (id) on delete set null,
  sent_date     date,
  promised_date date,
  received_date date,
  cost          numeric
);
create index if not exists sc_steps_order_idx on sc_steps (order_id, seq);

create table if not exists sc_lead_times (
  id        uuid primary key default gen_random_uuid(),
  part_no   text not null default '',          -- blank = default for the vendor (any part)
  vendor_id uuid references sc_vendors (id) on delete cascade,
  std_days  int not null check (std_days >= 0),
  notes     text not null default ''
);
create unique index if not exists sc_lead_uq on sc_lead_times (upper(btrim(part_no)), coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table sc_vendors enable row level security;
alter table sc_orders enable row level security;
alter table sc_steps enable row level security;
alter table sc_lead_times enable row level security;

grant all on sc_vendors, sc_orders, sc_steps, sc_lead_times to service_role;
