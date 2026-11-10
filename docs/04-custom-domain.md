# Custom domain

The backend URL is the Supabase function (`https://clumhidxgzfkwzwrtngi.supabase.co/functions/v1/api`); users never open it, the browser app only calls it. The **frontend** gets the domain, via the static host.

When adding or changing a frontend origin, also add it to `ALLOWED_ORIGINS` in `supabase/api-main.ts`, rebuild (`node scripts/build-edge.js`) and redeploy the Edge Function, or the browser will block the API calls. (The Google OAuth steps below date from the old Google sign-in and are no longer needed.)

## GitHub Pages
1. Repo Settings → Pages → Custom domain: `so.example.com` (use a subdomain; apex domains need four A records).
2. DNS at your registrar:
   - Subdomain: `CNAME  so  →  <your-github-username>.github.io`
   - Apex (optional): `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (check GitHub's docs for current values).
3. Tick *Enforce HTTPS* once the certificate is issued (GitHub provisions it automatically, can take up to ~24 h).
4. Add `https://so.example.com` to the OAuth client's *Authorised JavaScript origins*.

## Moving from the github.io URL to your domain
Nothing in the sheet or backend changes. Only: the OAuth origin (step 4) and DNS. Keep the old origin in the OAuth client during the switch. Users just sign in again.

## Alternative hosts
Cloudflare Pages or Netlify also support custom domains with free HTTPS and private repositories; the same `frontend/` folder is deployed with `config.js` generated as in `.github/workflows/deploy-frontend.yml`. No reverse proxy is needed.

## Done: https://so.amanasystem.com
- Cloudflare DNS: `CNAME so -> ichbinsakib.github.io`, DNS only (grey cloud). Apex and www records untouched.
- GitHub repo Settings -> Pages: custom domain `so.amanasystem.com`, HTTPS enforced.
- Google OAuth client (project so-review): `https://so.amanasystem.com` added to Authorized JavaScript origins (the github.io origin and `http://localhost` stay, so the old link keeps working).
