-- Safe saves for shop orders (run once; safe to run again).
-- One call applies all of a save's order writes AND their audit rows in a single transaction: either everything lands or
-- nothing does (no change without its history line). An update or delete carries the row's updated_at as it was read; if
-- the row changed since then the whole save is refused with CONFLICT instead of silently overwriting someone else's edit.
create or replace function apply_order_ops(p_ops jsonb) returns void
language plpgsql as $$
declare
  o jsonb;
  n integer;
begin
  for o in select value from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    if o->>'type' = 'update' then
      update shop_orders
         set data = (data || (o->'patch'))
                    - coalesce((select array_agg(k) from jsonb_each(o->'patch') as e(k, v) where v = 'null'::jsonb), '{}'::text[]),
             updated_at = now()
       where id = (o->>'id')::uuid
         and (o->>'expect' is null or updated_at = (o->>'expect')::timestamptz);
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'CONFLICT: shop order % changed since it was read', o->>'id' using errcode = 'P0409';
      end if;
    elsif o->>'type' = 'insert' then
      insert into shop_orders (id, data, created_by)
      values ((o->>'id')::uuid, coalesce(o->'data', '{}'::jsonb), lower(coalesce(o->>'createdBy', '')));
    elsif o->>'type' = 'delete' then
      delete from shop_orders
       where id = (o->>'id')::uuid
         and (o->>'expect' is null or updated_at = (o->>'expect')::timestamptz);
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'CONFLICT: shop order % changed since it was read', o->>'id' using errcode = 'P0409';
      end if;
    elsif o->>'type' = 'audit' then
      insert into app_audit (at, user_email, record_id, row_no, field, old_value, new_value)
      values (coalesce((o->>'at')::timestamptz, now()), coalesce(o->>'user', ''), coalesce(o->>'recordId', ''),
              nullif(o->>'row', '')::bigint, coalesce(o->>'field', ''), coalesce(o->>'oldValue', ''), coalesce(o->>'newValue', ''));
    else
      raise exception 'Unknown order op type: %', o->>'type';
    end if;
  end loop;
end $$;

revoke execute on function apply_order_ops(jsonb) from public, anon, authenticated;
grant execute on function apply_order_ops(jsonb) to service_role;
