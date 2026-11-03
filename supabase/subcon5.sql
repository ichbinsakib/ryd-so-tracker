-- Subcontractor BPO board: vendor name on each part, and a history of every BPO move / note.
-- Safe to run more than once; nothing existing is changed or removed.
alter table sc_lines add column if not exists vendor text not null default '';

create table if not exists sc_bpo_events (
  id         uuid primary key default gen_random_uuid(),
  bpo_no     text not null default '',
  batch      text not null default '',
  at         timestamptz not null default now(),   -- when it was recorded in the app
  event_date date,                                  -- the day it really happened (defaults to the day it was recorded)
  by_user    text not null default '',
  kind       text not null default 'MOVE' check (kind in ('MOVE', 'NOTE', 'FOLLOW-UP')),
  from_stage text not null default '',
  to_stage   text not null default '',              -- a board column key, or AUTO = follow the dates again
  text       text not null default '',
  applied    text not null default ''               -- what the move wrote to the parts, if anything
);
create index if not exists sc_bpo_events_idx on sc_bpo_events (bpo_no, batch, at);
alter table sc_bpo_events enable row level security;
grant all on sc_bpo_events to service_role;
