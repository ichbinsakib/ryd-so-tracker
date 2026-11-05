# Status reminders (ANR, RFS, Analysis)

An SO that stays in **1.ANR**, **2.RFS** or **1. ANALYSIS** for 24 hours is emailed to sahamed@camcomfginc.com.
If it is still in that status 10 hours later it is emailed again, and once more 10 hours after that (three emails in all, then it stops).
Changing the SO's status (or opening a new SO) restarts the clock. All SOs that are due at the same moment go in **one digest email**, grouped by status.

Code: `backend/Reminders.js` (rules, email text, tested in `tests/reminders.test.js`) and `statusReminders` in `supabase/api-main.ts`.

## One-time setup (Supabase project "Shop Order Tracking", amanasystem123 account)

1. **SQL editor:** run `supabase/reminders.sql`. Existing SOs start their 24 hours at that moment.
2. **Mail sender (no app password needed): the Apps Script mailer.** Go to script.google.com while signed in to the Google account that should send the mail, create a new project, and paste in `supabase/mailer-apps-script.js`. Then Deploy > New deployment > Web app > Execute as **Me**, access **Anyone**, allow the permissions, and copy the web app URL (ends in `/exec`). The recipient is fixed in the script, so the link can only ever email that one address; keep the URL private. (Optional: add a `MAIL_KEY` Script Property and the same `MAIL_KEY` secret for extra protection.)
   (Alternative if you do have a Gmail app password: use `GMAIL_USER` and `GMAIL_APP_PASSWORD` secrets instead of the two mailer secrets below.)
3. **Edge Function secrets** (Edge Functions > Secrets): `MAIL_WEBHOOK_URL` (the web app URL) and `CRON_KEY` (any long random string, 16+ characters). Optional: `REMIND_TO` to change the recipient seen by the function (the Apps Script recipient is separate).
4. **Redeploy the Edge Function `api`** with the rebuilt `supabase/functions/api/index.ts` (`node scripts/build-edge.js` rebuilds it).
5. **Test the mail:** send a POST to the function URL with `{"action":"statusReminders","cronKey":"<CRON_KEY>","test":true}`. A test email should arrive.
6. **Schedule:** put the same key into `supabase/reminders-schedule.sql` (replace `PASTE_CRON_KEY`) and run it once. It checks every 15 minutes. Stop it with `select cron.unschedule('so-status-reminders');`.

`{"dryRun": true}` in the same request reports how many SOs are due without sending anything.
