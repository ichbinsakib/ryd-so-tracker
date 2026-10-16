# Setup and deployment on Windows (PowerShell)

Nothing in this guide has been executed against your live Google account yet; sections marked **[manual]** need your Google login.

## 0. Software
- Node.js 20 or newer (this project was developed on Node 24): https://nodejs.org (LTS). Check: `node -v`
- Git for Windows: https://git-scm.com. Check: `git --version`
- A GitHub account.

## 1. Get the project and run the tests
```powershell
cd "D:\CAMCO\SO Tracker"
npm install
npm test
```

## 2. Try the UI locally (synthetic data, not Google)
```powershell
npm run dev:mock
```
Open http://127.0.0.1:5173 and use "Dev sign-in". This uses fake data and is only for UI work.

## 3. Create the Google OAuth client **[manual]**
1. https://console.cloud.google.com → create a project "RYD-SO".
2. APIs & Services → OAuth consent screen: choose *Internal* if you use Google Workspace, otherwise *External* and add your team's emails as test users (or publish).
3. Credentials → Create credentials → OAuth client ID → *Web application*.
4. Authorised JavaScript origins: `http://localhost`, `https://<your-github-username>.github.io`, and later `https://your-domain.example`.
5. Copy the **Client ID** (not a secret).

## 4. Create the Apps Script backend **[manual]**
```powershell
npx clasp login
npx clasp create --type standalone --title "RYD-SO API" --rootDir backend
```
(`clasp create` writes `.clasp.json`; it is git-ignored. `.clasp.json.example` shows the shape.) Then:
```powershell
npm run backend:push
```
Open the script (`npx clasp open`) → Project Settings → Script properties, add:
| Property | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the client ID from step 3 |
| `SHEET_ID` | `1ZEtC2-bTDshaKqWN3MNC0CQE7u3OkJxCTchxUy37aPg` (the app's own copy; the original `1BzamRKd…` is left untouched as the backup) |
| `EDITORS` | comma-separated Google emails allowed to edit |
| `VIEWERS` | comma-separated Google emails with read-only access (optional) |

## 5. One-time sheet preparation **[manual, modifies your sheet]**
1. In Google Sheets: File → Make a copy (your own manual backup).
2. In the Apps Script editor run `setupApp` once and approve the permission prompt. It: creates a Drive backup copy, adds a `RECORD ID` header after column BY with UUIDs on the 888 record rows, and creates an `APP_AUDIT` tab. It changes no existing cell.
3. Run `installDailyBackupTrigger` once.

## 6. Deploy the backend **[manual first time]**
Apps Script editor → Deploy → New deployment → Web app → Execute as: *Me*; Who has access: *Anyone*. Copy the `/exec` URL. (Later updates: `npm run backend:push` then Deploy → Manage deployments → edit → new version, so the URL stays the same.)

## 7. Publish the frontend
```powershell
git init -b main
git add .
git commit -m "Initial RYD-SO app"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
On GitHub: Settings → Pages → Source: *GitHub Actions*. Settings → Secrets and variables → Actions → **Variables**: add `API_URL` (the `/exec` URL) and `GOOGLE_CLIENT_ID`. Re-run "Deploy frontend to GitHub Pages". Note: Pages is free for public repositories; no operational data is in the repo (it is only code). For a private repo use a paid GitHub plan or Cloudflare Pages.

## 8. Verify
Work through [acceptance-checklist.md](acceptance-checklist.md).

## Updating and rolling back
- Frontend: push to `main` → Action deploys. Roll back: `git revert <commit>` and push.
- Backend: `npm run backend:push`, then create a new deployment version. Roll back: Deploy → Manage deployments → pick the previous version. Not automated on purpose: `clasp` login is a personal OAuth token and should not be stored in GitHub.
- Data: see [05-operations.md](05-operations.md).
