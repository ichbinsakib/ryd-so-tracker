-- Runs the reminder check every 15 minutes. Run ONCE, after the Edge Function `api` is redeployed and the
-- secrets are set (see docs/reminders.md). Replace PASTE_CRON_KEY with the same value as the CRON_KEY secret.
-- Do not commit this file with the real key in it.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'so-status-reminders',
  '*/15 * * * *',
  $$ select net.http_post(
       url     := 'https://clumhidxgzfkwzwrtngi.supabase.co/functions/v1/api',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body    := '{"action": "statusReminders", "cronKey": "PASTE_CRON_KEY"}'::jsonb
     ) $$
);

-- To stop the reminders:  select cron.unschedule('so-status-reminders');
