-- Subcontractor workflow v3: decision, quotation review, SO request, expected dates with retained originals.
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi). Existing lines keep working (new columns have defaults).
alter table sc_lines add column if not exists so_required text not null default 'PENDING';
alter table sc_lines add column if not exists sub_required text not null default 'PENDING';
alter table sc_lines add column if not exists decision_note text not null default '';
alter table sc_lines add column if not exists revision text not null default '';
alter table sc_lines add column if not exists team_member text not null default '';
alter table sc_lines add column if not exists comm_ref text not null default '';
alter table sc_lines add column if not exists review_status text not null default '';
alter table sc_lines add column if not exists exp jsonb not null default '{}'::jsonb;    -- expected dates: exp_prod, exp_ship, exp_arrival
alter table sc_lines add column if not exists orig jsonb not null default '{}'::jsonb;   -- first value of any date that was later changed
do $$ begin
  alter table sc_lines add constraint sc_lines_decisions_chk check (so_required in ('YES','NO','PENDING') and sub_required in ('YES','NO','PENDING'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sc_lines add constraint sc_lines_review_chk check (review_status in ('','SUBMITTED','IN REVIEW','CHANGES REQUESTED','APPROVED'));
exception when duplicate_object then null; end $$;
