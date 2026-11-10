# Operating the app

## Users, roles and sign-in
- Users are rows in `app_users` (email, name, employee ID, role, active), managed by admins on the **Users** screen: add one, import a CSV (email, name, employee id, role), change role, disable, delete, **Set password**. A bad row blocks the whole import.
- Sign-in is **email + password**. An admin sets the first password; the user can change it (minimum 8 characters) under Change password. Passwords are stored only as bcrypt hashes.
- Sessions last 12 hours. 8 wrong passwords for one email within 15 minutes locks it for 15 minutes.
- Role = the highest of the optional `ADMINS` / `EDITORS` / `VIEWERS` Edge Function secrets (or `app_meta.config`) and an active `app_users` row. Accounts listed in `ADMINS` are the emergency/bootstrap admins and cannot be demoted or locked out from the screen. An admin who exists only in the table cannot demote, disable or delete themselves.
- Disabling or deleting a user takes effect on their next request: the role is re-checked every time, so an open session stops working (unless the email is also in one of the env lists).
- Bootstrap: the first admin's password is set in the SQL editor with `select set_user_password('<email>', '<password>');`.

| Role | Can |
|---|---|
| viewer | see the dashboard / all SOs (`mySOs`), open, print, download scans, view subcontractor data and lead times; no changes |
| editor | everything a viewer can, plus open/edit/delete SOs, follow-up log, scans, stock/steel uploads, all subcontractor changes |
| admin | everything, plus users and passwords, deleting a whole BPO, Price Increase Tracking |

## Inhouse SOs
- **Open an SO**: part #, customer and SO qty are required. If every SO detail is given (part, customer, champion, qty, due date, SO type, Kanban/PO, req. by) it starts as `3.OPEN`, otherwise as `1. ANALYSIS`. Champion and Req. by must be active users. SO# must be unique (database index on `so_key`).
- Editing uses a version check: if someone else saved the SO since you opened it you get a conflict with the latest values and nothing is overwritten. Statuses `1.ANR` and `3.OPEN` need an SO#.
- Calculated fields (status bars, part price, steel lookups, bars/lbs/ft, stock) are computed by `backend/Calc.js` on every read; they are never stored.
- Every change is written to `app_audit` with old and new value.
- **Scans**: PDF/JPG/PNG up to 7 MB, stored in the private Storage bucket `scans`, listed in `so_scans`; downloaded through the app.
- **Status reminders**: see [reminders.md](reminders.md).

## Uploads (editors and admins)
- **Inventory / STOCK list** (Excel/CSV): replaces `stock_items` (part, customer, quantity, unit price) and, from the same file, `stockroom_prices` (the price check next to PART PRICE). Two requests: if the second fails, upload the file again.
- **STEEL USAGE**: replaces `steel_usage` (part, steel type, qty per bar, router bar size). The old data is copied to `steel_usage_previous` first (one level of undo; restore it with SQL).
- Values Sheets/Excel would treat as formulas (starting `=` `+` `@`) are rejected.

## Subcontractor tracking
BPO/batch parts in `sc_lines` with milestone dates (`ms`), expected dates (`exp`) and the first value of any changed date (`orig`). Updates go to `sc_updates`; BPO-level moves and notes to `sc_bpo_events`. Excel: download the template (`frontend/subcontractor-template.xlsx`), fill it, **Import Excel** shows a preview (new / updated / problems) before saving; the order ref (`SUB-0001` …) is the update key and is assigned automatically when blank.

## Lead time calculator
Reads `lt_routings` and `lt_workcenters`. To refresh from the LT worksheet: `node scripts/gen-leadtime-sql.js` (needs the source sheet to stay shared for viewing), then run the generated `lt-sql/lt-*.sql` files in order in the SQL editor.

## Price Increase Tracking (admin only)
`price_updates` rows with reply status, effective date, implemented flag, notes and an email trail (`history`). Added, edited and deleted on the page; seeded from `dev/price-updates-seed.json` via `scripts/gen-price-updates-sql.js`.

## Data fixes from the worksheet or mailbox
Write a dated, re-runnable SQL file in `supabase/` (pattern: `sync-<what>-YYYY-MM-DD.sql`, guarded with `where not exists` / exact `where` clauses, ending in a `select` that shows the result), run it in the SQL editor, commit it. For subcontractor changes also insert an `sc_updates` note so the change is visible in the part's history.

## Known limits
- The dashboard and `mySOs` load all SOs in one request (paged 1000 rows at a time from Postgres); fine for thousands of rows.
- No row lock on saves (see 02-architecture, "Concurrency").
- Free-text dates and legacy values imported from the sheet are kept as they are and shown "(existing)".
