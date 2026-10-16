# RYD-SO Tracker

Team web app over the **RYD-SO** Google Sheet. Google Sheets stays the source of truth; Apps Script is the backend; the frontend is static and hosted on GitHub Pages. No Supabase or other third-party services.

- `frontend/` static app (no build step)
- `backend/` Apps Script (`Core.js` rules, `Service.js` API, `Code.js` Google glue); pushed with clasp
- `tests/` automated tests (`npm test`); `dev/mock-server.js` local UI preview with synthetic data
- `docs/` start with [STATUS.md](docs/STATUS.md)

| Doc | Purpose |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | what is done, unverified, and pending decisions |
| [docs/01-inspection.md](docs/01-inspection.md) | worksheet findings |
| [docs/field-mapping.md](docs/field-mapping.md) | column-by-column mapping |
| [docs/02-architecture.md](docs/02-architecture.md) | architecture comparison and security design |
| [docs/03-setup-windows.md](docs/03-setup-windows.md) | Windows setup, deploy, rollback |
| [docs/04-custom-domain.md](docs/04-custom-domain.md) | domain and DNS |
| [docs/05-operations.md](docs/05-operations.md) | access, backups, changes |
| [docs/acceptance-checklist.md](docs/acceptance-checklist.md) | tests run vs still to run |

Quick start: `npm install`, `npm test`, `npm run dev:mock`.
