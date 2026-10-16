# Project status (2026-10-16)

## Done
- Phase 1 inspection ([01-inspection.md](01-inspection.md)), field mapping (generated), architecture decision ([02-architecture.md](02-architecture.md)).
- Backend (`backend/`): Core, Service, Apps Script glue, setup/backup functions.
- Frontend (`frontend/`): list, search, filters, sort, pagination, column picker, detail edit, confirmations, conflict/auth-expiry handling.
- 21 automated tests passing; UI exercised against a local mock with synthetic data.
- CI and Pages deploy workflows written (not yet run: no GitHub repo exists yet).

## Data source
The app uses the user-made copy `1ZEtC2-bTDshaKqWN3MNC0CQE7u3OkJxCTchxUy37aPg` (private: it asks for sign-in). Its layout has **not been inspected** by me (no access), so I assume the RYD-SO tab is identical to the original. Verify the header row first (`setupApp` + the first `list` call will surface a mismatch only indirectly), see checklist.

## Live setup done 2026-10-16 (verified)
- Apps Script project created in the owner's account (script id `1wSKWn4R-zHDZ7Rv23kVgaR4SfHmmc_yNQqZ1yrsV-XGOfjPwtqpu5qaH`), code pasted via the editor (not clasp). Script properties `SHEET_ID`, `EDITORS` set; `GOOGLE_CLIENT_ID` **not yet set**.
- `setupApp` ran: 888 RECORD IDs in column BZ, `APP_AUDIT` tab added; sheet CSV size grew only by the ID column. Backup copy created in Drive. Daily `backupNow` trigger installed.
- Web app deployed (Execute as owner, access Anyone): GET returns no data; POST with a fake token returns `UNAUTHENTICATED`.
- Remaining: OAuth client ID, set `GOOGLE_CLIENT_ID`, GitHub repo + Pages, live read/write test, CORS test from the Pages origin.
- Note: the repo's `backend/` files were pasted with comments stripped; keep the repo as the source of truth and re-paste after changes.

## Added after first release
- STATUS required; status bars as progress bars; NOTES hidden in the table.
- Admin role ( property = ichbinsakib@gmail.com), stockroom price upload + ✓/! check, STEEL USAGE replace upload + ✓/! checks. Backend is Apps Script version 3. Tested with unit tests and the local mock only; **never exercised against the live sheet** (see acceptance checklist).

## Not done / not verified
- **Nothing has been deployed or run against your real Google Sheet or Apps Script.** No live read or write has been tested. The Apps Script glue (`Code.js`) has never executed.
- Unverified assumptions: CORS from Pages to the Apps Script `/exec` URL; `tokeninfo` verification from `UrlFetchApp`; leading-apostrophe handling for leading-zero IDs; date write in the sheet's time zone.
- Needs your Google login: OAuth client, `clasp login`, `setupApp`, first deployment.

## Decisions awaiting you
1. Approve adding a `RECORD ID` column (after BY) and an `APP_AUDIT` tab to the workbook (done by `setupApp`, after you make a copy).
2. Team emails and which are editors vs viewers.
3. Public GitHub repo (free Pages) vs private repo (Cloudflare Pages or paid GitHub).
4. Other tabs (IR-SO, ITT-SO, MAT. SO) in scope?

## Known issues
- Hidden sheet rows (15) are shown in the app.
- Large text fields are not diffed word by word in conflicts.
