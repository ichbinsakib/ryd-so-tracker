// Copy to config.js (or let the GitHub Action generate it). These values are NOT secrets.
window.APP_CONFIG = {
  // Apps Script Web App URL ending in /exec
  API_URL: 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec',
  // OAuth 2.0 Web client ID (Google Cloud Console -> APIs & Services -> Credentials)
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com',
  // Local development against dev/mock-server.js only. Must be false in production.
  DEV_MODE: false
};
// Production values are injected by .github/workflows/deploy-frontend.yml from repository variables.
