# Architecture

Current design since 2026-10-27. (The first release used the Google Sheet as the database with an Apps Script API and Google sign-in; see "History" at the end.)

```
Browser
  └─ frontend/ (static HTML/JS, no build)  ── GitHub Pages, https://so.amanasystem.com
        │  1. action "login" {email, password} → random session token (12 h)
        │  2. POST {action, idToken: <session token>, ...}  JSON
        ▼
Supabase Edge Function "api"  (Deno; supabase/functions/api/index.ts, generated)
        │  checks the session, works out the role (viewer / editor / admin)
        │  loads only the rows the action needs → runs the shared rules → writes the changes
        ▼
Supabase Postgres (RLS on, no policies: only the service role can read or write)
Supabase Storage bucket "scans" (private)
```

The browser never talks to the database directly; it holds no Supabase key. The only thing in `frontend/config.js` in production is the public function URL (written by `.github/workflows/deploy-frontend.yml`).

## Code structure: shared rules + a thin network layer
`backend/*.js` are plain JavaScript modules with no I/O. They run in Node (tests, mock server) and inside the Edge Function:

| Module | Global | Role |
|---|---|---|
| `Core.js` | `SOCore` | SO field table (key, label, type, options, `calc`), validation, record versions, roles, intake (new SO) rules |
| `Calc.js` | `SOCalc` | the worksheet formulas ported to JS: status bars, part price, steel type / router bar size / qty per bar lookups, required ft / lbs / bars, stock |
| `Lifecycle.js` | `SOLife` | the 13-stage SO workflow, status, next action, attention flags (also copied to the browser) |
| `Subcon.js` | `SOSub` | subcontractor milestones, stages, BPO board, line validation, Excel template mapping (also copied to the browser) |
| `Service.js` | `SOService` | request handling and access control for the SO actions, against an `adapter` |
| `Reminders.js` | `SOReminders` | which SOs are due a status reminder, email text |
| `PgAdapter.js` | `SOPg` | snapshot adapter: gives `Service` a sheet-like view over preloaded DB rows and collects writes as `ops` |

`scripts/build-edge.js` concatenates these plus `supabase/api-main.ts` into `supabase/functions/api/index.ts`, and writes `frontend/lifecycle.js` and `frontend/subcon.js`.

### Request flow (`supabase/api-main.ts`)
1. `statusReminders` (cron key) and `login` need no session; everything else needs a valid session token.
2. Role = highest of the `ADMINS` / `EDITORS` / `VIEWERS` lists (Edge Function env vars, or `app_meta.config`) and the person's active `app_users` row.
3. Actions starting `sc` (subcontractor), `lg` (SO follow-up log), `pu` (price tracking), `ltLookup`, and `stGet` / `stUpload` (SO Tracker) are handled directly in `api-main.ts` with Supabase queries.
4. All other actions (`start`, `get`, `findSO`, `createSO`, `update`, `deleteSO`, `dashboard`, `mySOs`, uploads, users, scans) go through `prefetch` → `SOPg.create` → `SOService.handle` → `flush(ops)`.

Request bodies are capped at 100 KB except the upload/import actions (14 MB).

## Data model (Postgres)
| Table | Contents | Created by |
|---|---|---|
| `shop_orders` | one row per inhouse SO; editable fields in `data` jsonb keyed as in `Core.js`; calculated fields are never stored; `so_key` unique (when not blank); `created_by`; reminder columns `status_since`, `remind_count`, `last_remind_at` | `schema.sql`, `reminders.sql` |
| `app_users` | email, name, employee id, role, active, `pw_hash` (bcrypt) | `schema.sql`, `auth.sql` |
| `sessions`, `login_attempts` | SHA-256 of session tokens; sign-in attempts for lockout | `auth.sql` |
| `app_audit` | every change: time, user, record, field, old/new value | `schema.sql` |
| `so_scans` + bucket `scans` | uploaded PDF/JPG/PNG per SO | `schema.sql` |
| `so_log` | SO follow-up log (NOTE, FOLLOW-UP, ESCALATION, DECISION, EVIDENCE) | `lifecycle.sql` |
| `stock_items` | the STOCK list (part, qty, unit price): part price and stock lookups | `schema.sql` |
| `stockroom_prices` | stockroom price upload (price check tick / mark) | `schema.sql` |
| `steel_usage`, `steel_usage_previous` | STEEL USAGE upload and one level of undo | `schema.sql` |
| `app_meta` | small key/values: `stock_meta`, `steel_meta`, optional `config` | `schema.sql` |
| `sc_lines`, `sc_updates`, `sc_bpo_events` | subcontractor parts per BPO/batch, their update log, BPO moves/notes | `subcon.sql` … `subcon5.sql` |
| `lt_workcenters`, `lt_routings` | lead time calculator (from the LT / TRAVELLER / CT worksheets) | `leadtime.sql` + `scripts/gen-leadtime-sql.js` |
| `price_updates` | price increase tracking (admin only) | `price-updates.sql`, `price-updates-history.sql` |
| `so_tracker_runs` + bucket `so-tracker` | SO Tracker uploads from the planner's PC (`latest/`, `history/YYYY-MM-DD/`); `app_users.can_upload_tracker` marks the uploader | `so-tracker.sql` |

Bulk replaces (`replace_stock_items`, `replace_stockroom_prices`, `replace_steel_usage`) and `patch_order` are SQL functions executable only by the service role.

## Security model
- Every table has RLS enabled and no policies; `anon` / `authenticated` have no grants. Only the Edge Function (service role key, held by Supabase) touches data.
- Passwords: set by an admin (or changed by the user), hashed with bcrypt (cost 10) inside Postgres via pgcrypto. `check_login` costs the same whether or not the email exists. No plain password is stored or logged.
- Sessions: 32 random bytes, stored only as SHA-256, 12 hours. 8 wrong passwords per email in 15 minutes locks that email for 15 minutes. Logout deletes the session.
- CORS: responses only name an allowed origin (`so.amanasystem.com`, `ichbinsakib.github.io`, localhost); list in `api-main.ts`.
- Role checks happen in the backend for every action; the UI hiding buttons is only convenience.
- The status reminder endpoint requires `CRON_KEY` (16+ characters, Edge Function secret).

## Concurrency
Each SO has a version (hash of its editable values). A save sends the version it was based on; a mismatch returns `CONFLICT` with the latest record. `withLock` is a no-op in the database adapter, so two saves landing at the same instant can both pass the version check; each still only patches the fields it changed (`patch_order` merges jsonb), so the risk is limited to the same field being changed by both.

## History
Oct 2026: Google Sheet (RYD-SO tab) as the database, Apps Script web app as the API (`backend/Code.js`), Google ID tokens, Script Properties for the allow-list, `APP_AUDIT` / `APP_USERS` tabs. The documented limit of that design was Apps Script's own overhead of roughly 2.5–3 s per request. The sheet data was imported into `shop_orders`; later catch-ups are the dated `supabase/sync-*.sql` / `import-*.sql` files.
