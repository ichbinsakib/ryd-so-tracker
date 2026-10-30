-- Order reference: the key an Excel sheet uses to update an order (SUB-0001, SUB-0002 ...). Assigned by the app when left blank.
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi).
alter table sc_lines add column if not exists order_ref text not null default '';
create unique index if not exists sc_lines_ref_uq on sc_lines (upper(btrim(order_ref))) where btrim(order_ref) <> '';
