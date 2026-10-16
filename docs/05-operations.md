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
Admins are listed in the  Script property (comma-separated emails). Admins can also edit records. Only admins see the two upload buttons, and the backend refuses these actions for everyone else.
- **Upload stockroom sheet** (CSV/Excel): stores part number + price in a new tab  (replaced on every upload). Each record's PART PRICE is compared with it: green tick = matches, red ! = mismatch, part missing, or no price in the worksheet.
- **Replace STEEL USAGE data** (CSV/Excel): maps 4 columns (PART NUMBER, PS_COMP, PS_QTY PER, MAT'L TYPE) into columns A:D of the STEEL USAGE tab. **This deletes all old data in that tab** (A2:K), including the Margin and ID columns. Before deleting, the whole tab is copied to  (one level of undo: the next upload overwrites that copy). RYD-SO, IR-SO, ITT-SO and the hidden HIGH USAGE PARTS tab look values up from STEEL USAGE, so they change immediately. Green tick/red ! on STEEL TYPE, ROUTER BAR SIZE and QTY / BAR mean the lookup found / did not find a value for that part.
- Every upload is written to . Cells that Sheets would read as formulas (starting with = + @) are rejected.
- To undo a STEEL USAGE replace: copy the contents of  back into  (or use Version history).
