# Operating the app

## Manage team access
Apps Script → Project Settings → Script properties → edit `EDITORS` / `VIEWERS` (comma-separated emails, case-insensitive). Takes effect on the next request. Remove an email to revoke access immediately (a still-valid sign-in token is useless once the email is off the list).

## Backups and recovery
- `backupNow` (daily trigger) copies the entire spreadsheet to your Drive as `BACKUP RYD-SO yyyy-MM-dd_HHmm`, keeping 14. Restore by copying the needed data back from a backup copy.
- `APP_AUDIT` tab records time, user, record ID, row, field, old and new value for every change made through the app. To undo a single edit, copy the old value back.
- Google Sheets File → Version history also covers edits.
- Never test destructive operations on production: make a copy of the sheet, point `SHEET_ID` of a separate test script at it.

## Change which fields are editable or add a column
Edit `backend/Core.js` (`RAW` table: letter, key, label, type, `calc`). Run `npm run gen:docs && npm test`, push, redeploy. Inserting columns in the sheet shifts letters, so update the table in the same change.

## Known limits
- Whole table is loaded in one request (~890 rows × 78 columns, a few hundred KB). Fine up to a few thousand rows.
- Apps Script consumer quotas apply (see 02-architecture).
- Concurrent edits: second saver gets a conflict message and nothing is overwritten. Direct edits typed into the Google Sheet while a user has the record open are also detected (the version covers all editable cells) but only at save time.

## Backend updates (current manual procedure)
The Apps Script project was created by pasting the files from `backend/` into the editor (not via clasp). After changing anything in `backend/`:
1. Paste the changed file's content into the matching file in the Apps Script editor and save.
2. Deploy → Manage deployments → pencil on the active deployment → Version: *New version* → Deploy. The `/exec` URL stays the same.
3. Frontend-only changes just need `git push` (GitHub Actions redeploys Pages).
Note: the editor copy has comments stripped, so the repo is the source of truth. Switch to `clasp` (docs/03) to automate this.

## Admin uploads (stockroom prices, STEEL USAGE)
Admins are listed in the `ADMINS` Script property (comma-separated emails). Admins can also edit records. Only admins see the two upload buttons, and the backend refuses these actions for everyone else.
- **Upload stockroom sheet** (CSV/Excel): stores part number + price in a new tab `STOCKROOM_PRICES` (replaced on every upload). Each record's PART PRICE is compared with it: green tick = matches, red ! = mismatch, part missing, or no price in the worksheet.
- **Replace STEEL USAGE data** (CSV/Excel): maps 4 columns (PART NUMBER, PS_COMP, PS_QTY PER, MAT'L TYPE) into columns A:D of the `STEEL USAGE` tab. **This deletes all old data in that tab** (A2:K), including the Margin and ID columns. Before deleting, the whole tab is copied to `STEEL USAGE (previous)` (one level of undo: the next upload overwrites that copy). RYD-SO, IR-SO, ITT-SO and the hidden HIGH USAGE PARTS tab look values up from STEEL USAGE, so they change immediately. Green tick / red ! on STEEL TYPE, ROUTER BAR SIZE and QTY / BAR mean the lookup found / did not find a value for that part.
- Every upload is written to `APP_AUDIT`. Cells that Sheets would read as formulas (starting with = + @) are rejected.
- To undo a STEEL USAGE replace: copy the contents of `STEEL USAGE (previous)` back into `STEEL USAGE` (or use Version history).

## Who sees what (since the redesign)
- **Admins** (`ADMINS`): dashboard only — cards for when the stockroom sheet and STEEL USAGE were last updated, plus a slim list of non-closed SOs showing only the SO release and material status bars (lowest progress first). They can also open SOs, find an SO, edit, and run the two uploads. The full worksheet table is gone for everyone.
- **Editors** (`EDITORS`): home screen with **Open an SO** and **Find an SO by number**. No list of SOs is ever sent to them (the backend refuses `list` and `dashboard` for non-admins).
- **Viewers** (`VIEWERS`): can find an SO and read it, print it and download scans; cannot create, edit or upload.

## Opening an SO
The form writes the SO into the first free, pre-formatted row after the last record in RYD-SO (so the sheet's formulas keep working), sets STATUS to `3.OPEN`, adds a RECORD ID and logs `SO OPENED` in `APP_AUDIT`. Required: SO#, PART #, CUSTOMER, CHAMPION, SO QTY#, DUE DATE, SO TYPE, KANBAN/PO, REQ. BY, SO REQ. DATE; NOTES is optional. SO# must be unique. To change which fields are required or offered, edit `INTAKE_KEYS` / `INTAKE_REQUIRED` in `backend/Core.js`. If the sheet runs out of free rows the app says so (extend the formula rows down).

## Print and scans
**Print details** prints a clean one-page summary (all non-empty fields, bars, price/steel checks, signature lines). **Upload scan** (PDF/JPG/PNG, max 7 MB) stores the file in a private Drive folder `RYD-SO Scans` (owner's Drive; its ID is in the `SCAN_FOLDER_ID` script property), logs it in the `SO_SCANS` tab and in `APP_AUDIT`. Team members download scans through the app; they do not need Drive access.

## Managing users (admin screen)
Admins have a **Manage users** button on the dashboard. Each user is a row in the `APP_USERS` tab: email, name, employee ID, role (viewer / editor / admin), active (yes/no). Admins can add one user, import many from a CSV (columns: email, name, employee id, role), change a role, disable or delete a user. A bad row in an import blocks the whole import with a message; nothing is half-written.
- Sign-in is still **Google**: the person must use the Google account whose email the admin entered. A person not in the table (and not in the Script Properties lists) is refused with "ask an admin".
- Role = the highest of: the Script Properties lists (`ADMINS`, `EDITORS`, `VIEWERS`) and an active `APP_USERS` row. The `ADMINS` property is the emergency/bootstrap access: those accounts cannot be demoted or locked out from the screen.
- An admin who exists only in the table cannot demote, disable or delete themselves (another admin must).
- Edits typed straight into the `APP_USERS` tab take up to 5 minutes to apply (the list is cached). Changes made through the screen apply immediately. All changes are logged in `APP_AUDIT`.
- **No passwords are stored anywhere in this app.** Connecting the HR app (sign in with the HR password, employee list from HR) needs a small addition to the HR app itself and is not built yet; see docs/STATUS.md.

## Speed notes (what makes the app fast or slow)
- **Order sheet is found by its tab id** (`SHEET_GID`, default 519433600, overridable with a Script Property of the same name), not by its name, so renaming the tab (it is now called "SHOP ORDERs") cannot break the app. If the tab is ever deleted and recreated, set the `SHEET_GID` property to the new tab's id (the `gid=` number in the sheet URL).
- Bulk reads (dashboard, find, open, record lookup) go through the Sheets API ("Sheets" advanced service, enabled in `appsscript.json`): measured about 0.25 s versus 2.7 s with `SpreadsheetApp` for the dashboard columns. If the API call fails the code falls back to `SpreadsheetApp`.
- Writes are batched: neighbouring cells are written in one call and all audit lines in one write.
- The admin dashboard is cached for 60 s (compressed in CacheService). Any save, new SO or upload clears it; the Refresh button bypasses it. Signing in as admin returns the dashboard in the same request (`start` action).
- Remaining floor: roughly 2.5-3 s per request is Apps Script's own overhead, which cannot be removed without moving the API off Apps Script.
