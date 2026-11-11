-- SO Tracker page: the planner's PC uploads its daily SO recommendations (stUpload); every signed-in user reads them (stGet).
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi). Safe to re-run.

-- Private bucket: latest/so_tracker.html, latest/so_tracker_results.json, history/YYYY-MM-DD/so_tracker.html
insert into storage.buckets (id, name, public) values ('so-tracker', 'so-tracker', false) on conflict (id) do nothing;

create table if not exists so_tracker_runs (
  id          uuid primary key default gen_random_uuid(),
  run_at      text not null default '',
  uploaded_by text not null default '',
  counts      jsonb,          -- {"OPEN SO": 11, "URGENT REVIEW REQUIRED": 13, ...}
  sources     jsonb,          -- data-source status at that run
  parts       integer,
  created_at  timestamptz not null default now()
);
create index if not exists so_tracker_runs_created_idx on so_tracker_runs (created_at desc);
alter table so_tracker_runs enable row level security;
grant all on so_tracker_runs to service_role;

-- Only accounts with this flag may upload (stUpload). Nobody has it until you set it.
alter table app_users add column if not exists can_upload_tracker boolean not null default false;

-- Give the planner PC's account the upload right (replace the email with the account saved by setup_amana_login.bat):
-- update app_users set can_upload_tracker = true where email = lower('tracker-account@example.com');
