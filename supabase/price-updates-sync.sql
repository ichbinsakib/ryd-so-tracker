-- Price Increase Tracking: "Refresh from Outlook" support. Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi). Safe to re-run.
alter table price_updates add column if not exists conversation_id text not null default '';
alter table price_updates add column if not exists last_reply_date date;      -- latest reply from Skye on the same email thread (flag only, never auto-confirms)
alter table price_updates add column if not exists last_reply_text text not null default '';

-- Public settings for the Outlook connection (the Azure app's Application (client) ID and tenant ID are not secrets).
create table if not exists price_settings (
  key   text primary key,
  value text not null default ''
);
alter table price_settings enable row level security;
grant all on price_settings to service_role;
