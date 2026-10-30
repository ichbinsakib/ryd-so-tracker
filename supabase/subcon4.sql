-- Real sheets have free-text review statuses and candidate parts without a quantity yet.
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi).
alter table sc_lines drop constraint if exists sc_lines_review_chk;
alter table sc_lines drop constraint if exists sc_lines_qty_check;
do $$ begin
  alter table sc_lines add constraint sc_lines_qty_chk check (qty >= 0);
exception when duplicate_object then null; end $$;
