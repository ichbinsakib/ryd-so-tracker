#!/usr/bin/env node
/**
 * SO Review agent: runs on an office PC that can reach the SO RELEASE STATUS share and Outlook desktop.
 *   1. scans <root>\<CUSTOMER>\NEED TO RELEASE*\<SO#> folders (and <root>\NEED TO RELEASE)
 *   2. reads every PDF (pdftotext), checks the five required documents and compares every field with the app's SO record
 *   3. reads the "RELEASE SO..." emails from Outlook and decides whether Charlotte/Jay clearly released the SO
 *   4. moves a folder to its customer's RELEASED folder only on a clear release email or an admin's confirmation
 *   5. sends the results to the app (SO Review page, admins only)
 * It never edits or deletes a document and never changes app data.
 *
 *   node agent/so-review-agent.js            full review now
 *   node agent/so-review-agent.js --auto     scheduled mode: picks up "Run review now" / "Confirm release" requests and
 *                                            runs a full review when one is queued or the last one is older than fullEveryMinutes
 *   options: --dry-run (no folder moves)  --no-submit (do not send to the app)  --root <dir>  --config <file>
 *            --records <json>  --mail <json>  (test fixtures instead of the app / Outlook)  --out <report.json>
 * Config: agent/so-review.config.json (not in git): { apiUrl, agentKey, root, pdftotext, approvers, mailDays, fullEveryMinutes, moveFolders }
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const D = require('./so-docs.js');
const VERSION = 'so-review-agent 1.0';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const cfgPath = opt('--config') || path.join(__dirname, 'so-review.config.json');
const CFG = Object.assign({
  apiUrl: 'https://clumhidxgzfkwzwrtngi.supabase.co/functions/v1/api', agentKey: '',
  root: '\\\\192.168.10.10\\Public\\AHAMED, SAKIB\\CO-ORDINATION DATA\\SO RELEASE STATUS',
  pdftotext: 'pdftotext', approvers: ['chamblin@camcomfginc.com', 'jgreen@camcomfginc.com'], mailDays: 365, fullEveryMinutes: 30, moveFolders: true
}, fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {});
if (opt('--root')) CFG.root = opt('--root');
const DRY = flag('--dry-run') || CFG.moveFolders === false, NO_SUBMIT = flag('--no-submit');
const STATE_DIR = process.env.SO_REVIEW_STATE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'so-review-agent');   // lock, last run, mail export
fs.mkdirSync(STATE_DIR, { recursive: true });
// --log: append to %LOCALAPPDATA%\so-review-agent\agent.log (the scheduled task has no console)
const LOG_FILE = flag('--log') ? path.join(STATE_DIR, 'agent.log') : null;
const log = (...a) => {
  const line = [new Date().toISOString().replace('T', ' ').slice(0, 19)].concat(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))).join(' ');
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_e) { /* log is best effort */ } } else console.log(line);
};

// ---------- app API
async function api(action, body) {
  const r = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(Object.assign({ action, agentKey: CFG.agentKey, agent: VERSION + ' @ ' + os.hostname() }, body || {})) });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) throw new Error(action + ': ' + (j.error || 'failed'));
  return j;
}

// ---------- one run at a time
const LOCK = path.join(STATE_DIR, 'run.lock');
function lock() {
  try { const st = fs.statSync(LOCK); if (Date.now() - st.mtimeMs < 2 * 3600e3) return false; } catch (_e) { /* no lock */ }
  fs.writeFileSync(LOCK, String(process.pid)); return true;
}
const unlock = () => { try { fs.unlinkSync(LOCK); } catch (_e) { /* gone */ } };

// ---------- folders
function discover(root) {
  const out = { folders: [], skipped: [], customers: [] };
  const dirs = (p) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const addNeed = (customer, needDir, releasedDir) => {
    for (const name of dirs(needDir)) {
      if (D.isSoFolder(name)) out.folders.push({ so: D.soKey(name), name, customer, dir: path.join(needDir, name), releasedDir });
      else out.skipped.push(path.join(customer || '', path.basename(needDir), name));
    }
  };
  for (const c of dirs(root)) {
    const p = path.join(root, c);
    if (/^NEED TO RELEASE/i.test(c)) { addNeed('', p, null); continue; }     // top-level folder: no RELEASED folder next to it
    const sub = dirs(p), need = sub.filter((x) => /^NEED TO RELEASE/i.test(x)), rel = sub.find((x) => /^RELEASED/i.test(x));
    if (!need.length) continue;
    out.customers.push(c);
    need.forEach((n) => addNeed(c, path.join(p, n), rel ? path.join(p, rel) : null));
  }
  return out;
}
function readFolder(f) {
  const files = [];
  for (const d of fs.readdirSync(f.dir, { withFileTypes: true })) {
    if (!d.isFile()) continue;
    const full = path.join(f.dir, d.name), st = fs.statSync(full), cls = D.classify(d.name);
    files.push({ name: d.name, full, size: st.size, mtime: Math.round(st.mtimeMs), kind: cls.kind });
  }
  return files;
}
// reading a PDF from the share is network-bound (seconds per file), so several are read at once
function pdfText(full) {
  return new Promise((resolve, reject) => execFile(CFG.pdftotext, ['-layout', '-q', full, '-'], { encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))));
}
async function pool(list, size, fn) {
  let i = 0; const run = async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
}

// ---------- email (Outlook desktop, read-only)
// A full export of a year of release emails takes minutes, so it is cached: runs fetch only the last 3 days and merge them;
// the whole range is re-read once a week (or with --full-mail).
function readMail() {
  if (opt('--mail')) return JSON.parse(fs.readFileSync(opt('--mail'), 'utf8').replace(/^﻿/, ''));
  const out = path.join(STATE_DIR, 'mail.json'), cacheFile = path.join(STATE_DIR, 'mail-cache.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_e) { /* no cache yet */ }
  const full = flag('--full-mail') || !cache || Date.now() - (cache.fullAt || 0) > 7 * 86400e3;
  try { fs.unlinkSync(out); } catch (_e) { /* none */ }
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'outlook-release-mail.ps1'), '-Days', String(full ? CFG.mailDays : 3), '-Out', out], { timeout: 1200000, windowsHide: true });
  const got = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, ''));
  if (!got.ok) return got;
  const byRef = new Map((full ? [] : cache.mails || []).map((m) => [m.ref, m]));
  (got.mails || []).forEach((m) => byRef.set(m.ref, m));
  const merged = { ok: true, fullAt: full ? Date.now() : cache.fullAt, mails: [...byRef.values()] };
  fs.writeFileSync(cacheFile, JSON.stringify(merged));
  log('mail:', full ? 'full export' : 'last 3 days merged', '-', merged.mails.length, 'release emails');
  return merged;
}

// ---------- the review run
async function fullRun(requests) {
  const started = Date.now(), errors = [], moves = [], items = [];
  const confirms = new Map((requests || []).filter((r) => r.kind === 'CONFIRM_RELEASE').map((r) => [D.soKey(r.so_no), r]));
  // 1. the app's SO records (and what was reviewed before)
  let records = new Map(), known = new Map();
  try {
    const j = opt('--records') ? JSON.parse(fs.readFileSync(opt('--records'), 'utf8')) : await api('srAgentRecords');
    (j.records || []).forEach((r) => { const k = D.soKey(r.values && r.values.so_no); if (k) records.set(k, r); });
    (j.known || []).forEach((k) => known.set(k.so_no, k));
  } catch (e) { errors.push('App records unavailable: ' + e.message); }
  // 2. folders
  let found;
  try { found = discover(CFG.root); } catch (e) { errors.push('Network folder unavailable (' + CFG.root + '): ' + e.message); found = { folders: [], skipped: [], customers: [] }; }
  // 3. email
  let mails = [], mailError = '';
  try { const m = readMail(); if (!m.ok) mailError = m.error || 'Outlook read failed'; else mails = m.mails || []; } catch (e) { mailError = 'Outlook unavailable: ' + e.message; }
  if (mailError) errors.push(mailError);
  log('folders', found.folders.length, 'records', records.size, 'mails', mails.length, errors.length ? 'errors: ' + errors.join(' | ') : '');

  // read the folders (and the PDFs of those that changed) several at a time; decisions and moves below stay one by one
  const seen = new Set(), todo = [];
  for (const f of found.folders) {
    if (seen.has(f.so)) { errors.push('SO ' + f.so + ' has more than one folder in NEED TO RELEASE (' + f.dir + '): only the first is reviewed'); continue; }
    seen.add(f.so); todo.push(f);
  }
  let doneN = 0;
  await pool(todo, 8, async (f) => {
    const rec = records.get(f.so) || null, prev = known.get(f.so);
    try { f.files = readFolder(f); } catch (e) { f.readError = 'Cannot read folder ' + f.dir + ': ' + e.message; return; }
    f.release = mailError ? { status: 'ERROR', evidence: mailError } : D.decideRelease(f.so, mails, CFG.approvers);
    const recSig = rec ? JSON.stringify(['so_no', 'part_no', 'customer', 'so_qty', 'due_date', 'part_price', 'steel_type', 'material_code', 'traveller_mat_price_piece', 'router_bar_size', 'qty_per_bar', 'po_no_1', 'price_on_po'].map((k) => [rec.values[k], rec.display && rec.display[k]])) : 'none';
    f.fingerprint = crypto.createHash('sha1').update(VERSION + '|' + f.files.map((x) => x.name + ':' + x.size + ':' + x.mtime).sort().join('|') + '|' + recSig + '|' + f.release.status + '|' + (f.release.ref || '') + '|' + (f.release.evidence || '')).digest('hex');
    f.needsReview = !prev || prev.fingerprint !== f.fingerprint || prev.result === 'PENDING REVIEW';
    if (f.needsReview) await Promise.all(f.files.map(async (x) => {
      if (!/\.pdf$/i.test(x.name)) { x.readable = false; x.error = 'Not a PDF'; return; }
      if (x.kind === 'print') { x.readable = true; return; }   // drawings are scanned images
      try { x.text = await pdfText(x.full); x.readable = x.text.replace(/\s/g, '').length > 30; if (!x.readable) x.error = 'No text (scanned or empty)'; } catch (e) { x.readable = false; x.error = String(e.message).split('\n')[0]; }
    }));
    if (++doneN % 25 === 0) log('read', doneN, 'of', todo.length, 'folders');
  });
  for (const f of todo) {
    if (f.readError) { errors.push(f.readError); continue; }
    const rec = records.get(f.so) || null, prev = known.get(f.so), files = f.files, release = f.release, fingerprint = f.fingerprint;
    let review = null, result = prev ? prev.result : 'PENDING REVIEW';
    if (f.needsReview) {
      const r = D.reviewSo(f.so, files, rec);
      r.files = files.map((x) => ({ name: x.name, kind: x.kind, size: x.size, readable: !!x.readable, error: x.error || '' }));
      r.release = release; r.folder = f.dir;
      review = r; result = r.result;
    }
    // folder move: only on a clear release email or an admin's confirmation
    const confirm = confirms.get(f.so), releasedNow = release.status === 'RELEASED' || !!confirm;
    let folderState = 'NEED TO RELEASE', folderPath = f.dir, needsAttention = !!release.changesRequested;
    if (releasedNow) {
      needsAttention = result !== 'PASS';   // released, but the documents did not fully pass: an admin must look
      if (!f.releasedDir) errors.push('SO ' + f.so + ' is released but has no RELEASED folder next to ' + path.dirname(f.dir) + ': not moved');
      else {
        const dest = path.join(f.releasedDir, f.name);
        if (fs.existsSync(dest)) errors.push('SO ' + f.so + ': ' + dest + ' already exists, folder not moved (no duplicates)');
        else if (DRY) log('DRY RUN: would move', f.dir, '->', dest);
        else {
          try {
            fs.renameSync(f.dir, dest);
            folderState = 'RELEASED'; folderPath = dest;
            moves.push({ so_no: f.so, from_path: f.dir, to_path: dest, moved_at: new Date().toISOString(), reason: confirm ? 'Release confirmed by ' + confirm.requested_by + (confirm.note ? ': ' + confirm.note : '') : 'Release email from ' + release.sender + ' on ' + String(release.date).slice(0, 10) + ': ' + (release.evidence || '').slice(0, 120), email_ref: confirm ? '' : (release.subject || '') + ' | ' + (release.ref || ''), moved_by: confirm ? confirm.requested_by : 'agent' });
            log('moved', f.so, '->', dest);
          } catch (e) { errors.push('SO ' + f.so + ': move failed: ' + e.message); }
        }
      }
      if (confirm) confirm.done = { status: folderState === 'RELEASED' ? 'DONE' : 'ERROR', message: folderState === 'RELEASED' ? 'Moved to ' + folderPath : 'Not moved: see the agent errors' };
    }
    items.push({ so_no: f.so, customer_folder: f.customer, folder_path: folderPath, folder_state: folderState, result, release_status: confirm ? 'RELEASED' : release.status, needs_attention: needsAttention, fingerprint, review });
  }
  // SOs reviewed before whose folder left NEED TO RELEASE without the agent (moved by hand)
  const releasedDirs = [];
  try { for (const c of fs.readdirSync(CFG.root)) { const p = path.join(CFG.root, c); try { fs.readdirSync(p).filter((x) => /^RELEASED/i.test(x)).forEach((x) => releasedDirs.push(path.join(p, x))); } catch (_e) { /* not a folder */ } } } catch (_e) { /* root unavailable: reported above */ }
  if (found.folders.length || !errors.some((e) => /Network folder unavailable/.test(e))) {
    for (const [so, k] of known) {
      if (seen.has(so) || k.folder_state !== 'NEED TO RELEASE') continue;
      const name = path.basename(k.folder_path || so), hit = releasedDirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
      items.push({ so_no: so, customer_folder: '', folder_path: hit || k.folder_path, folder_state: hit ? 'RELEASED' : 'GONE', result: k.result, release_status: k.release_status, needs_attention: false, fingerprint: k.fingerprint, review: null });
    }
    for (const [so, c] of confirms) if (!c.done) c.done = { status: 'ERROR', message: 'SO ' + so + ' is not in a NEED TO RELEASE folder' };
  }
  const counts = { folders: found.folders.length, pass: 0, fail: 0, missing: 0, pending: 0, released: 0, possible: 0, moved: moves.length, reviewed: items.filter((x) => x.review).length, skippedFolders: found.skipped.length };
  items.filter((x) => x.folder_state === 'NEED TO RELEASE' || moves.some((m) => m.so_no === x.so_no)).forEach((x) => {
    counts[x.result === 'PASS' ? 'pass' : x.result === 'FAIL' ? 'fail' : x.result === 'MISSING DOCUMENT' ? 'missing' : 'pending']++;
    if (x.release_status === 'RELEASED') counts.released++; if (x.release_status === 'POSSIBLE') counts.possible++;
  });
  const status = { final: true, ok: !errors.length, counts, errors: errors.slice(0, 50), skipped: found.skipped.slice(0, 100), customers: found.customers, durationSec: Math.round((Date.now() - started) / 1000), dryRun: DRY, mails: mails.length };
  const requestsDone = (requests || []).map((r) => ({ id: r.id, status: r.done ? r.done.status : (errors.length ? 'ERROR' : 'DONE'), message: r.done ? r.done.message : (errors.length ? errors[0] : 'Review completed: ' + counts.folders + ' SO folders') }));
  // local copy of the run (for troubleshooting and tests)
  const report = { at: new Date().toISOString(), status, items, moves };
  fs.writeFileSync(opt('--out') || path.join(STATE_DIR, 'last-run.json'), JSON.stringify(report, null, 1));
  if (!NO_SUBMIT) {
    for (let i = 0; i < items.length; i += 15) await api('srAgentSubmit', { reviews: items.slice(i, i + 15) });
    await api('srAgentSubmit', { moves, requestsDone, status });
  }
  fs.writeFileSync(path.join(STATE_DIR, 'last-full-run.txt'), String(Date.now()));
  log('done:', JSON.stringify(counts), errors.length ? errors.length + ' errors' : 'no errors');
  return report;
}

(async () => {
  if (!CFG.agentKey && !NO_SUBMIT && !opt('--records')) { console.error('No agentKey in ' + cfgPath); process.exit(2); }
  if (!lock()) { log('another run is in progress'); return; }
  let requests = [];
  try {
    if (!NO_SUBMIT && !opt('--records')) { try { requests = (await api('srAgentPoll')).requests || []; } catch (e) { log('poll failed:', e.message); } }
    if (flag('--auto')) {
      let last = 0; try { last = +fs.readFileSync(path.join(STATE_DIR, 'last-full-run.txt'), 'utf8') || 0; } catch (_e) { /* never */ }
      if (!requests.length && Date.now() - last < CFG.fullEveryMinutes * 60e3) { log('nothing to do (last full review ' + Math.round((Date.now() - last) / 60e3) + ' min ago)'); return; }
      log('full review: ' + (requests.length ? requests.length + ' request(s)' : 'last one ' + (last ? Math.round((Date.now() - last) / 60e3) + ' min ago' : 'never')) + ' · state ' + STATE_DIR);
    }
    await fullRun(requests);
  } catch (e) {
    log('FAILED:', e.stack || e.message);
    if (!NO_SUBMIT) { try { await api('srAgentSubmit', { status: { final: true, ok: false, error: e.message, counts: {} }, requestsDone: requests.map((r) => ({ id: r.id, status: 'ERROR', message: e.message })) }); } catch (_e) { /* app unreachable */ } }
    process.exitCode = 1;
  } finally { unlock(); }
})();
