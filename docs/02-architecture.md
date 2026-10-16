# Phase 2/3: Architecture recommendation and design

## Recommendation: Option B — static frontend + Apps Script backend, with Google sign-in verified in the backend

```
Browser (team PC)
  └─ frontend (static HTML/JS)  ── hosted on GitHub Pages (or Cloudflare Pages), custom domain + HTTPS
        │  1. "Sign in with Google" → Google ID token (proves the user's email)
        │  2. POST {action, idToken, ...}  (text/plain JSON, no CORS preflight)
        ▼
Apps Script Web App  (runs as the OWNER, URL reachable by anyone but useless without a valid token)
        │  verifies token (aud = our client ID, not expired, email verified)
        │  checks email against EDITORS / VIEWERS in Script Properties
        │  LockService + version check + validation, then writes
        ▼
Google Sheet (source of truth, never shared with the team)
```

## Why not Option A (everything inside Apps Script)
Apps Script web apps have one decisive limitation for this brief: **who the caller is.**
- "Execute as me" (needed so the team does not need Sheet access) only returns the caller's email reliably for users in the *same Google Workspace domain*; for other accounts `Session.getActiveUser().getEmail()` can be blank. I could not test this here, so it is a risk, and the team's accounts are unknown.
- "Execute as user accessing" would force every teammate to have access to the whole spreadsheet, which you said you do not want.
- Apps Script URLs live on `script.google.com/macros/s/…/exec` (and a `googleusercontent.com` iframe). **Apps Script does not support mapping your own domain to a web app.** Only Google Workspace Sites embedding is possible, which changes the user experience.

Option B avoids both: identity comes from a Google ID token verified by the backend regardless of Workspace/gmail, and the domain is attached to the static frontend.

## Comparison
| Criterion | A: Apps Script only | B: Pages + Apps Script (chosen) |
|---|---|---|
| Ease | Easiest, one deploy | One extra step: Google OAuth client ID, Pages setup |
| Identity | Unreliable outside Workspace | Verified Google ID token, any Google account |
| Access control | Allow-list in script (if email available) | Allow-list in script, enforced per request |
| Team needs sheet access | No (execute as me) | No |
| Concurrency | LockService + version check | Same |
| Quotas | Same Apps Script limits (consumer: ~20k URL fetches/day, 6 min per run, ~30 simultaneous executions) | Same; each cold request also calls Google tokeninfo (cached 5 min) |
| Cost | Free | Free (GitHub Pages free for public repos; private repos need a paid plan, or use Cloudflare Pages free) |
| Performance | Iframe sandbox, slower first load | Static files from a CDN; API calls ~0.5–2 s |
| Custom domain | Not supported directly | Supported on the static host |
| GitHub integration | clasp only | Pages deploy by Actions + clasp for backend |
| Scalability | ~1000 rows fine; Sheets as DB is the limit | Same |

No separate proxy/backend is needed. CORS works because requests are "simple" (`Content-Type: text/plain`, no preflight) and Apps Script serves JSON with permissive CORS headers. **This still needs to be verified against the live deployment** (see acceptance checklist).

## Security model
- Sheet is private. Only the owner's script touches it.
- The `/exec` URL is public but every action requires a valid Google ID token for an allow-listed email; `doGet` returns no data.
- Allow-list is in Script Properties (not in GitHub). The OAuth client ID and API URL are public by design and live in GitHub Actions *variables*, not secrets. No tokens, keys or service-account files exist anywhere.
- Backend validates every field, rejects calculated columns and formula cells, rejects text beginning `=`, and logs every change to `APP_AUDIT`.
- Residual risks: ID tokens last ~1 hour (user re-signs in; unsaved edits are kept in the form); revoking a user means removing the email from the property (takes effect immediately). The deployment runs with the owner's broad Drive/Sheets scopes, so protect the owner account with 2-step verification.

## Data model
Each record = one RYD-SO row. Stable key = `RECORD ID` (UUID) in a column added after BY by `setupApp()`. Version = hash of all editable cells and formula flags; a save sends the version it was based on; mismatch → `CONFLICT` with the latest record. Writes happen inside `LockService.getScriptLock()` (10 s wait → `BUSY`).

## Backend operations
`whoami`, `list`, `get`, `update` (all require token + allow-list; `update` requires editor). No create/delete by design.

## Screens
Records table (search, 5 filters, sort, column picker, pagination, last-refreshed) → record detail grouped into the sheet's workflow sections (Order, Material requirement, Material quote, SO request/approvals/PO, Release & prints, Receiving & invoice, Close) with calculated/formula fields greyed and labelled.

## Backup and recovery
`backupNow()` (daily trigger, keeps 14 dated copies in the owner's Drive) + `APP_AUDIT` with old/new value per field for manual rollback + Google Sheets version history.
