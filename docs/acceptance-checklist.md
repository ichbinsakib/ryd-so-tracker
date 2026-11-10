# Acceptance checklist

Legend: ✅ executed and passed (date), ⬜ not recorded as tested. The live app has been in daily use since late October 2026, but individual live checks below were not logged; tick them when you run them.

## Automated (2026-11-10)
- ✅ `npm test`: 110 tests (field map, validation, roles, users, passwords via adapter, save / conflict, new SO intake, scans, stock and steel uploads, Postgres snapshot adapter, lifecycle, subcontractor rules, reminders, price updates).
- ✅ Generated files in sync with `backend/*.js` + `supabase/api-main.ts`.
- ⬜ No automated tests cover `supabase/api-main.ts` itself (sign-in, `sc*` / `lg*` / `pu*` / `ltLookup` queries, `flush`).

## Security (live)
- ⬜ Opening the function URL with GET returns only a service note, no data.
- ⬜ Wrong password 8 times → locked for 15 minutes; correct password afterwards works.
- ⬜ A disabled user's open session is refused on the next action.
- ⬜ A viewer cannot save, upload or change subcontractor data (UI and direct API call).
- ⬜ An editor cannot open Users or Price Increase Tracking (direct API call refused).
- ⬜ Direct REST call to `https://clumhidxgzfkwzwrtngi.supabase.co/rest/v1/shop_orders` with the anon key returns no rows.
- ⬜ A request from an origin not in `ALLOWED_ORIGINS` is blocked by the browser.

## Inhouse SOs (live)
- ⬜ Open an SO with only part / customer / qty → `1. ANALYSIS`; with all details → `3.OPEN`; duplicate SO# refused.
- ⬜ Calculated fields (bars, part price, steel type, router bar size, qty/bar, lbs/ft/bars, stock) match the sheet for 5 sample parts.
- ⬜ Two browsers edit the same SO: the second save gets the conflict message.
- ⬜ Scan upload (PDF) and download by another user.
- ⬜ `app_audit` has old/new values for an edit.

## Uploads (live)
- ⬜ Inventory upload updates `stock_items` and `stockroom_prices`; price ticks change.
- ⬜ STEEL USAGE upload: `steel_usage_previous` holds the old data; lookups update.

## Subcontractor, reminders, other (live)
- ⬜ Excel template import: preview, then import; order refs assigned; date changes logged with originals kept.
- ⬜ Reminder test mail (`{"action":"statusReminders","cronKey":"…","test":true}`) arrives; cron job fires every 15 minutes.
- ⬜ Lead time lookup for a known part shows its routing and total days.
- ⬜ Frontend deploy workflow publishes; `stamp.js` versions make browsers load new files.
- ⬜ Rollback of a frontend commit and of an Edge Function version.
