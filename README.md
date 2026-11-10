# Shop Order Tracker (RYD-SO)

Team web app for CAMCO shop orders: inhouse SOs (the former RYD-SO worksheet), subcontractor BPO tracking, a lead time calculator and admin-only price increase tracking.

Live at **https://so.amanasystem.com** (GitHub Pages, repo `ichbinsakib/ryd-so-tracker`).

```
frontend/ (static, no build step)  ── GitHub Pages
      │  POST JSON {action, idToken, ...}
      ▼
Supabase Edge Function "api"  ── supabase/functions/api/index.ts (generated)
      │  service role only
      ▼
Supabase Postgres + Storage bucket "scans"   (project clumhidxgzfkwzwrtngi)
```

Since 2026-10-27 the backend is Supabase. The original design (Google Sheet as the database, Apps Script as the API, Google sign-in) is retired; `backend/Code.js` and `backend/appsscript.json` are its leftovers and are not deployed.

## Layout
| Path | What it is |
|---|---|
| `frontend/` | the browser app (`app.js`, `index.html`, `styles.css`, `priceupdates.js`); `lifecycle.js` and `subcon.js` are **generated** copies of the backend files |
| `backend/` | shared pure-JS business logic, run in Node (tests) and Deno (Edge Function): `Core`, `Calc`, `Lifecycle`, `Subcon`, `Service`, `Reminders`, `PgAdapter` |
| `supabase/api-main.ts` | Edge Function network layer: sign-in, data loading, saving, subcontractor / log / lead time / price tracking actions, reminders |
| `supabase/functions/api/index.ts` | **generated** bundle that is deployed; never edit by hand |
| `supabase/*.sql` | schema and migrations (run by hand in the SQL editor), plus dated one-off data fixes |
| `scripts/` | `build-edge.js` (bundle), `stamp.js` (cache-busting), doc and SQL generators |
| `tests/` | `npm test` (Node's built-in runner, no dependencies needed) |
| `dev/mock-server.js` | local UI preview with synthetic data |

## Everyday commands
```powershell
npm test                      # all tests
node scripts/build-edge.js    # after changing backend/*.js or supabase/api-main.ts
node scripts/stamp.js         # after changing frontend files, before committing
npm run gen:docs              # after changing the field table in backend/Core.js (CI checks this)
npm run dev:mock              # http://127.0.0.1:5173, "Dev sign-in", fake data
```

## Docs
| Doc | Purpose |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | what exists, what is unverified, open questions |
| [docs/02-architecture.md](docs/02-architecture.md) | how the app is built and secured |
| [docs/03-setup-windows.md](docs/03-setup-windows.md) | dev setup, deploying frontend / Edge Function / SQL, rollback |
| [docs/05-operations.md](docs/05-operations.md) | users and roles, uploads, data fixes, limits |
| [docs/reminders.md](docs/reminders.md) | status reminder emails |
| [docs/04-custom-domain.md](docs/04-custom-domain.md) | domain and DNS |
| [docs/field-mapping.md](docs/field-mapping.md) | SO fields (generated from `backend/Core.js`) |
| [docs/acceptance-checklist.md](docs/acceptance-checklist.md) | what has been tested and how |
| [docs/01-inspection.md](docs/01-inspection.md) | original worksheet inspection (historical) |

Git note: the working copy is on the `Z:` network share, so git reports "dubious ownership". Run git as `git -c safe.directory='*' ...` or add the share to `safe.directory`.
