-- The database blocks DELETE without WHERE, so the bulk replace functions delete with 'where true'.
create or replace function replace_stockroom_prices(p_rows jsonb) returns integer
language plpgsql as $$
declare n integer;
begin
  delete from stockroom_prices where true;
  insert into stockroom_prices (part, price)
    select r->>0, (r->>1)::numeric from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function replace_steel_usage(p_rows jsonb) returns integer
language plpgsql as $$
declare prev integer;
begin
  delete from steel_usage_previous where true;
  insert into steel_usage_previous (part, steel_type, qty_per_bar, router_bar_size)
    select part, steel_type, qty_per_bar, router_bar_size from steel_usage;
  get diagnostics prev = row_count;
  delete from steel_usage where true;
  insert into steel_usage (part, steel_type, qty_per_bar, router_bar_size)
    select r->>0, coalesce(r->>1, ''), coalesce(r->>2, ''), coalesce(r->>3, '') from jsonb_array_elements(p_rows) r;
  return prev;
end $$;

create or replace function replace_stock_items(p_rows jsonb) returns integer
language plpgsql as $$
declare n integer;
begin
  delete from stock_items where true;
  insert into stock_items (part, customer, quantity, unit_price)
    select r->>0, coalesce(r->>1, ''), nullif(r->>2, '')::numeric, nullif(r->>3, '')::numeric from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

