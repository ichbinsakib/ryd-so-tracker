# Project status (2026-11-10)

## Live
- https://so.amanasystem.com (GitHub Pages) → Supabase Edge Function `api` → Postgres, project `clumhidxgzfkwzwrtngi`. Backend moved from Apps Script + Google Sheet on 2026-10-27; password sign-in replaced Google sign-in the same day.
- 110 automated tests pass (`npm test`); generated files (`supabase/functions/api/index.ts`, `frontend/lifecycle.js`, `frontend/subcon.js`) match their sources as of this date.

## Modules
| Module | Since | Notes |
|---|---|---|
| Inhouse SOs: dashboard, open/find/edit SO, 13-stage lifecycle stepper, next action, follow-up log, scans, print | 10-27 / 10-29 | data imported from the RYD-SO sheet; catch-ups 11-03 and 11-05 |
| Uploads: STOCK list + stockroom prices, STEEL USAGE | 10-27 | |
| Users screen, passwords, change password | 10-27 | |
| Subcontractor tracking: BPO/batch parts, milestones, BPO tracker and page, Excel template import/export, update log | 10-27 → 11-03 | Kanban board view removed 11-04; BPO move history kept in `sc_bpo_events` |
| Status reminders (ANR / RFS / Analysis) | 11-04 | email via the Apps Script mailer; see [reminders.md](reminders.md) |
| Lead Time Calculation | 11-05 | data from the LT / TRAVELLER / CT worksheets |
| Price Increase Tracking (admin only) | 11-05 → 11-06 | add/edit/delete on the page, email trail per part |

## Not verified / open
- Which SQL files have been run in the live database is not recorded in the repo; the dated data-fix files are assumed applied (each is re-runnable).
- Whether the reminder cron job (`reminders-schedule.sql`) is scheduled live is not recorded here.
- Saves have no row lock (version check only); simultaneous edits of the same field could both be accepted.
- `backend/Code.js`, `backend/appsscript.json`, `dev/fresh-start.gs`, `.clasp.json.example` and the `clasp` scripts in `package.json` belong to the retired Apps Script backend and could be removed.
- HR integration (sign in with the HR app's password, employee list from HR) is not built; users are managed on the Users screen.
- Only RYD-SO is in scope from the original workbook (IR-SO, ITT-SO, MAT. SO are not).
