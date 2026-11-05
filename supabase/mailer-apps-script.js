// Mail sender for the status reminders, used when Gmail app passwords are not available.
// Paste this into a new Google Apps Script project (script.google.com), signed in as the account that should send the mail.
//
// 1. Deploy > New deployment > type "Web app" > Execute as: Me > Who has access: Anyone > Deploy. Allow the permissions it asks for.
// 2. Copy the web app URL (ends in /exec) and save it as the MAIL_WEBHOOK_URL secret in Supabase.
//
// The recipient is fixed below, so the link can only ever email that one address; keep the URL private.
// Optional extra protection: add a Script Property MAIL_KEY and the same MAIL_KEY secret in Supabase; then every request must carry it.
var TO = 'sahamed@camcomfginc.com';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var key = PropertiesService.getScriptProperties().getProperty('MAIL_KEY');
    if (key && body.key !== key) return out_({ ok: false, error: 'Not allowed.' });
    MailApp.sendEmail({ to: TO, subject: String(body.subject || '').slice(0, 200), body: String(body.text || ''), htmlBody: String(body.html || ''), name: 'Shop Order Tracker' });
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
