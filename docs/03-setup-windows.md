# Development setup and deployment (Windows)

## 1. Software
- Node.js 20+ (developed on Node 24). `node -v`
- Git for Windows. The working copy is on the `Z:` network share, so run git as `git -c safe.directory='*' ...` (or add the share to `safe.directory` once).
- Access to the Supabase project `clumhidxgzfkwzwrtngi` ("Shop Order Tracking") and the GitHub repo `ichbinsakib/ryd-so-tracker`.

No `npm install` is needed for the tests (they use Node's built-in runner). `npm install` only adds `clasp`, which belongs to the retired Apps Script backend.

## 2. Run the tests and the local preview
```powershell
npm test
npm run dev:mock
```
The mock serves `frontend/` at http://127.0.0.1:5173 with synthetic data; use "Dev sign-in". It uses `frontend/config.js` (`API_URL: '/api'`, `DEV_MODE: true`) — keep that file as is in the repo; the deploy workflow overwrites it.

The mock runs the shared `backend/` rules against an in-memory fake sheet, so it covers SO screens, subcontractor screens and the price tracking stub, but not the Supabase-only code in `supabase/api-main.ts` (sign-in, `lg*`, `ltLookup`, real queries).

## 3. Making a change
| You changed | Then |
|---|---|
| `backend/*.js` or `supabase/api-main.ts` | `node scripts/build-edge.js`, `npm test`, redeploy the Edge Function (step 5). If `Lifecycle.js` / `Subcon.js` changed, the frontend copies changed too: also step 4. |
| field table in `backend/Core.js` | also `npm run gen:docs` (CI fails if `docs/field-mapping.md` is out of date) |
| `frontend/*` | `node scripts/stamp.js` (adds `?v=<hash>` so browsers pick up the new files), commit, push (step 4) |
| database structure | add a new `supabase/<name>.sql` that is safe to re-run (`if not exists`), run it (step 6) |

Never edit `supabase/functions/api/index.ts`, `frontend/lifecycle.js` or `frontend/subcon.js` by hand.

## 4. Deploy the frontend
Push to `main`. The "Deploy frontend to GitHub Pages" workflow runs the tests, writes `frontend/config.js` with the Edge Function URL, and publishes `frontend/`. It only triggers on changes under `frontend/` (or run it by hand from the Actions tab).

## 5. Deploy the Edge Function
The repo has no Supabase CLI config, so deployment is manual. Either:
- Supabase dashboard → Edge Functions → `api` → replace the code with `supabase/functions/api/index.ts` → Deploy; or
- Supabase CLI: `npx supabase functions deploy api --project-ref clumhidxgzfkwzwrtngi` from a folder laid out as `supabase/functions/api/index.ts`.

Edge Function secrets (Edge Functions → Secrets): `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Optional: `ADMINS`, `EDITORS`, `VIEWERS` (comma-separated emails). Reminders: `CRON_KEY`, `MAIL_WEBHOOK_URL`, optional `MAIL_KEY`, `REMIND_TO` (see [reminders.md](reminders.md)).

## 6. Run SQL
Supabase dashboard → SQL editor → paste the file → Run. Order for a fresh database:
1. `schema.sql`, `auth.sql`, `fix-bulk-delete.sql`
2. `lifecycle.sql`, `reminders.sql`
3. `subcon.sql`, `subcon2.sql` … `subcon5.sql`
4. `leadtime.sql`, then the files from `node scripts/gen-leadtime-sql.js` (written to `lt-sql/`, git-ignored)
5. `price-updates.sql` (regenerate with `node scripts/gen-price-updates-sql.js`), `price-updates-history.sql`
6. `reminders-schedule.sql` once, with the real cron key pasted in (do not commit the key)

The dated files (`import-sheet-2026-11-03.sql`, `sync-*-2026-11-05.sql`, `add-bpo-parts-…`, `move-3-parts-…`) are one-off data fixes that have already been applied; they are kept as a record.

The first admin's password is set in the SQL editor: `select set_user_password('<email>', '<password>');`. After that, admins set passwords on the Users screen.

## Rolling back
- Frontend: `git revert <commit>` and push.
- Edge Function: redeploy the previous `index.ts` (`git show <commit>:supabase/functions/api/index.ts`).
- Data: there is no automatic restore in this repo. Use `app_audit` (old/new value per field) for single changes, and Supabase's own backups for larger restores (check what the project's plan includes).
