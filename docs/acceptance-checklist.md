# Acceptance checklist

Legend: ✅ executed and passed in this project, ⬜ not yet executed (requires your Google deployment).

## Automated / local (executed 2026-10-16)
- ✅ `npm test`: 21 tests pass (field map, validation, roles, token checks, access control, save, conflict, formula protection, leading zeros, lock/BUSY, read-only without RECORD ID).
- ✅ UI against the local mock (synthetic data, same Service/Core code): load 180 rows, search, status filter, sort asc/desc, open record, edit + confirmation dialog + save, conflict detection with "load latest and re-apply", invalid-value messages, unsaved-changes flag, calculated fields disabled (18).
- ⬜ Not tested: Safari/Firefox, mobile widths, keyboard-only use.

## Live deployment (all ⬜)
**Data**
- ⬜ In the copy, tab `RYD-SO` exists with headers in row 2 matching docs/field-mapping.md (A=NOTES … BY=SO CLOSE DATE).
- ⬜ Record count in the app equals 888 (rows with a PART #) and a spot-check of 10 rows matches the sheet.
- ⬜ Edit a text, a date, a dropdown and a number on a **copy** of the sheet; refresh the browser; values persist and appear in the sheet with the same formats.
- ⬜ Date typed in the app appears in the sheet as a true date (not text) in the sheet's time zone.
- ⬜ Cells with formulas (AF with `=275*7.53`, J with `=AM542+55`) are shown "formula" and cannot be changed; calculated columns unchanged after saves.
- ⬜ Entering an ID with a leading zero (e.g. `00456` in PO #) stays `00456` in the sheet.
- ⬜ `setupApp` changes no existing cell (compare to the manual copy).
**Security**
- ⬜ Opening the `/exec` URL in a browser returns no data.
- ⬜ A Google account not in EDITORS/VIEWERS gets "not authorised" and sees no records.
- ⬜ A VIEWER can read but cannot save (UI and direct API call).
- ⬜ Removing an editor's email blocks them on their next request.
- ⬜ Expired token (wait ~1 h) shows re-sign-in without losing form edits.
**Concurrency**
- ⬜ Two browsers edit the same record: second save shows the conflict message.
- ⬜ Edit directly in the Sheet while the record is open in the app, then save: conflict reported.
**Operations**
- ⬜ App works with your PC switched off.
- ⬜ GitHub Action deploys the frontend; live URL loads over HTTPS.
- ⬜ `backupNow` creates a Drive copy; the daily trigger fires.
- ⬜ Rollback of a frontend commit and of a backend deployment version.
- ⬜ CORS: browser fetch from the Pages origin to the `/exec` URL succeeds (not exercised yet).
- ⬜ Custom domain with HTTPS.

## Admin uploads (all ⬜, run on a copy first)
- ⬜ Sign in as admin: both upload buttons visible; as editor/viewer: hidden, and a direct API call is refused.
- ⬜ Upload a small stockroom CSV: STOCKROOM_PRICES tab created, ticks/red marks appear, filter works.
- ⬜ Replace STEEL USAGE with the full real file: STEEL USAGE (previous) contains the old data, RYD-SO STEEL TYPE / ROUTER BAR SIZE / QTY / BAR update, badges update after refresh.
- ⬜ Part numbers that are digits only match between the new STEEL USAGE rows and RYD-SO (VLOOKUP is type-sensitive: number vs text).
