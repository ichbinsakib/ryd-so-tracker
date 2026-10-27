-- Shop Order Tracking Details: database schema (Supabase / Postgres).
-- Every table has RLS enabled and NO policies: only the Edge Function (service role) can read or write.

create table if not exists shop_orders (
  row_no     bigint generated always as identity primary key,
  id         uuid not null unique default gen_random_uuid(),
  data       jsonb not null default '{}'::jsonb,   -- editable fields keyed like backend/Core.js (calculated columns are computed, never stored)
  so_key     text generated always as (upper(btrim(coalesce(data->>'so_no', '')))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shop_orders_so_key_uq on shop_orders (so_key) where so_key <> '';

create table if not exists app_users (
  email       text primary key,
  name        text not null default '',
  employee_id text not null default '',
  role        text not null check (role in ('viewer', 'editor', 'admin')),
  active      boolean not null default true,
  added_by    text not null default '',
  added_at    text not null default '',
  updated_by  text not null default '',
  updated_at  text not null default ''
);

create table if not exists app_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_email  text not null default '',
  record_id   text not null default '',
  row_no      bigint,
  field       text not null default '',
  old_value   text not null default '',
  new_value   text not null default ''
);
create index if not exists app_audit_record_idx on app_audit (record_id);

create table if not exists so_scans (
  id        uuid primary key,
  record_id uuid not null,
  so_no     text not null default '',
  name      text not null,
  mime      text not null,
  path      text not null,
  by_user   text not null default '',
  at        timestamptz not null default now()
);
create index if not exists so_scans_record_idx on so_scans (record_id);

-- The "STOCK" list (PartNumber, TotalQuantity, UnitPrice): PART PRICE and AVAIL (FT) look values up here.
create table if not exists stock_items (
  part       text not null,
  part_key   text generated always as (upper(regexp_replace(btrim(part), '\s+', ' ', 'g'))) stored,
  customer   text not null default '',
  quantity   numeric,
  unit_price numeric
);
create index if not exists stock_items_key_idx on stock_items (part_key);

-- Admin upload: stockroom prices used for the green tick / red mark next to PART PRICE.
create table if not exists stockroom_prices (
  part     text not null,
  part_key text generated always as (upper(regexp_replace(btrim(part), '\s+', ' ', 'g'))) stored,
  price    numeric not null
);
create index if not exists stockroom_prices_key_idx on stockroom_prices (part_key);

-- Admin upload: STEEL USAGE (steel type, qty per bar, router bar size by part number).
create table if not exists steel_usage (
  part            text not null,
  part_key        text generated always as (upper(regexp_replace(btrim(part), '\s+', ' ', 'g'))) stored,
  steel_type      text not null default '',
  qty_per_bar     text not null default '',
  router_bar_size text not null default ''
);
create index if not exists steel_usage_key_idx on steel_usage (part_key);
create table if not exists steel_usage_previous (like steel_usage including defaults);

create table if not exists app_meta (key text primary key, value jsonb not null);

alter table shop_orders enable row level security;
alter table app_users enable row level security;
alter table app_audit enable row level security;
alter table so_scans enable row level security;
alter table stock_items enable row level security;
alter table stockroom_prices enable row level security;
alter table steel_usage enable row level security;
alter table steel_usage_previous enable row level security;
alter table app_meta enable row level security;

-- Bulk replace helpers (atomic: one statement per upload).
create or replace function replace_stockroom_prices(p_rows jsonb) returns integer
language plpgsql as $$
declare n integer;
begin
  delete from stockroom_prices;
  insert into stockroom_prices (part, price)
    select r->>0, (r->>1)::numeric from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function replace_steel_usage(p_rows jsonb) returns integer
language plpgsql as $$
declare prev integer;
begin
  delete from steel_usage_previous;
  insert into steel_usage_previous (part, steel_type, qty_per_bar, router_bar_size)
    select part, steel_type, qty_per_bar, router_bar_size from steel_usage;
  get diagnostics prev = row_count;
  delete from steel_usage;
  insert into steel_usage (part, steel_type, qty_per_bar, router_bar_size)
    select r->>0, coalesce(r->>1, ''), coalesce(r->>2, ''), coalesce(r->>3, '') from jsonb_array_elements(p_rows) r;
  return prev;
end $$;

create or replace function replace_stock_items(p_rows jsonb) returns integer
language plpgsql as $$
declare n integer;
begin
  delete from stock_items;
  insert into stock_items (part, customer, quantity, unit_price)
    select r->>0, coalesce(r->>1, ''), nullif(r->>2, '')::numeric, nullif(r->>3, '')::numeric from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function replace_stockroom_prices(jsonb) from public, anon, authenticated;
revoke execute on function replace_steel_usage(jsonb) from public, anon, authenticated;
revoke execute on function replace_stock_items(jsonb) from public, anon, authenticated;

-- Private bucket for SO scans (PDF / JPG / PNG).
insert into storage.buckets (id, name, public) values ('scans', 'scans', false) on conflict (id) do nothing;

-- Starting users (migrated from the old APP_USERS tab).
insert into app_users (email, name, employee_id, role, active, added_by, added_at)
values
  ('amanasystem7@gmail.com', 'Kamrul Hasan', 'AS-006', 'editor', true, 'ichbinsakib@gmail.com', now()::text),
  ('amanasystem1@gmail.com', 'Azizul Bari Munna', 'AS-001', 'editor', true, 'ichbinsakib@gmail.com', now()::text)
on conflict (email) do nothing;

-- Merge a patch into one order (a null value removes that field).
create or replace function patch_order(p_id uuid, p_patch jsonb) returns void
language sql as $$
  update shop_orders
     set data = (data || p_patch) - coalesce((select array_agg(k) from jsonb_each(p_patch) as e(k, v) where v = 'null'::jsonb), '{}'::text[]),
         updated_at = now()
   where id = p_id;
$$;
revoke execute on function patch_order(uuid, jsonb) from public, anon, authenticated;

-- Added later: who opened each SO (drives the "My SOs" list).
alter table shop_orders add column if not exists created_by text not null default '';
create index if not exists shop_orders_created_by_idx on shop_orders (created_by);

-- The Edge Function connects as service_role. Tables were created with "auto-expose" off, so grant it explicitly.
-- anon / authenticated get nothing: the browser can never read these tables directly.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
