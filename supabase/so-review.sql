-- SO Review: release-documentation checks made by the local review agent (agent/so-review-agent.js).
-- Run once in the SQL editor (or `supabase db query --remote -f`); safe to run again. Admin-only in the app.

-- One row per SO: where its folder is and the result of the latest review. Never duplicated (so_no is the key).
create table if not exists so_review_sos (
  so_no            text primary key,
  customer_folder  text not null default '',            -- e.g. RAYMOND, IR
  folder_path      text not null default '',            -- current folder on the share
  folder_state     text not null default 'NEED TO RELEASE' check (folder_state in ('NEED TO RELEASE', 'RELEASED', 'GONE')),
  result           text not null default 'PENDING REVIEW' check (result in ('PASS', 'FAIL', 'MISSING DOCUMENT', 'PENDING REVIEW')),
  release_status   text not null default 'NOT FOUND' check (release_status in ('RELEASED', 'POSSIBLE', 'NOT FOUND', 'ERROR')),
  needs_attention  boolean not null default false,       -- e.g. released but the documents do not match
  latest_review_id bigint,
  fingerprint      text not null default '',             -- files + app record: an unchanged SO is not re-reviewed
  first_seen       timestamptz not null default now(),
  reviewed_at      timestamptz,
  updated_at       timestamptz not null default now()
);

-- Every review kept for history.
create table if not exists so_reviews (
  id             bigint generated always as identity primary key,
  so_no          text not null,
  reviewed_at    timestamptz not null default now(),
  result         text not null,
  docs_found     integer not null default 0,
  docs_required  integer not null default 5,
  summary        jsonb not null default '{}'::jsonb,   -- SO number, part, description, customer, qty, price, material, cost, due date
  documents      jsonb not null default '[]'::jsonb,   -- per required document: present, readable, file, values read, checks
  checks         jsonb not null default '[]'::jsonb,   -- per field: app value, document values, match, severity
  discrepancies  jsonb not null default '[]'::jsonb,
  missing        jsonb not null default '[]'::jsonb,
  release        jsonb not null default '{}'::jsonb,   -- status, subject, date, sender, reference, evidence text
  errors         jsonb not null default '[]'::jsonb,
  fingerprint    text not null default '',
  agent          text not null default ''
);
create index if not exists so_reviews_so_idx on so_reviews (so_no, reviewed_at desc);

-- Every folder move (automatic on clear email confirmation, or after an admin confirms).
create table if not exists so_folder_moves (
  id         bigint generated always as identity primary key,
  so_no      text not null,
  from_path  text not null,
  to_path    text not null,
  moved_at   timestamptz not null default now(),
  reason     text not null default '',
  email_ref  text not null default '',
  moved_by   text not null default ''          -- 'agent' or the admin who confirmed
);
create unique index if not exists so_folder_moves_once on so_folder_moves (so_no, to_path);   -- the same move is never recorded twice

-- Work queued from the SO Review page for the agent: a manual run, or an admin's release confirmation.
create table if not exists so_review_requests (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('RUN', 'CONFIRM_RELEASE')),
  so_no         text not null default '',
  note          text not null default '',
  requested_by  text not null,
  requested_at  timestamptz not null default now(),
  status        text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'DONE', 'ERROR')),
  picked_at     timestamptz,
  done_at       timestamptz,
  message       text not null default ''
);
create index if not exists so_review_requests_open on so_review_requests (status) where status in ('QUEUED', 'RUNNING');

alter table so_review_sos enable row level security;
alter table so_reviews enable row level security;
alter table so_folder_moves enable row level security;
alter table so_review_requests enable row level security;
grant all on so_review_sos, so_reviews, so_folder_moves, so_review_requests to service_role;
grant usage, select on all sequences in schema public to service_role;
