#!/usr/bin/env node
/**
 * End-to-end test of the SO Review agent on made-up SO folders (needs pdftotext; runs on the review PC, not in CI):
 *   node agent/test/run-scenarios.js
 * Builds a throw-away share in the temp folder (RAYMOND\NEED TO RELEASE + RAYMOND\RELEASED), fixture app records and fixture
 * Outlook mails, runs the real agent with --no-submit (nothing is sent to the app) and checks every outcome.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { pdf } = require('./mini-pdf.js');
const F = require('./fixtures.js');

const realCfg = path.join(__dirname, '..', 'so-review.config.json');
const pdftotext = fs.existsSync(realCfg) ? JSON.parse(fs.readFileSync(realCfg, 'utf8')).pdftotext : 'pdftotext';
const root = path.join(os.tmpdir(), 'so-review-scenarios-' + Date.now());
const need = path.join(root, 'RAYMOND', 'NEED TO RELEASE'), released = path.join(root, 'RAYMOND', 'RELEASED');
fs.mkdirSync(need, { recursive: true }); fs.mkdirSync(released, { recursive: true });

const SCEN = [
  { so: '90001', title: 'All five documents, data matches, no release email', expect: { result: 'PASS', release: 'NOT FOUND', moved: false } },
  { so: '90002', title: 'Incorrect material cost', docs: { cost: '1.95' }, expect: { result: 'FAIL', field: 'Material cost per piece', moved: false } },
  { so: '90003', title: 'Incorrect steel type', docs: { steel: '1 RD 1018 CF', grade: '1018' }, expect: { result: 'FAIL', field: 'Steel type / grade', moved: false } },
  { so: '90004', title: 'Missing routing PDF', drop: ['router'], expect: { result: 'MISSING DOCUMENT', missing: 'Routing (part router)', moved: false } },
  { so: '90005', title: 'Incorrect due date', docs: { due: '01/15/2027' }, expect: { result: 'FAIL', field: 'Due date', moved: false } },
  { so: '90006', title: 'Confirmed email release (documents pass)', mail: 'Released. Thank you, Charlotte', expect: { result: 'PASS', release: 'RELEASED', moved: true, attention: false } },
  { so: '90007', title: 'Reply without clear release ("yes")', mail: 'yes', expect: { result: 'PASS', release: 'POSSIBLE', moved: false } },
  { so: '90008', title: 'Released by email but material cost is wrong', docs: { cost: '2.10' }, mail: 'This SO has been released.', expect: { result: 'FAIL', release: 'RELEASED', moved: true, attention: true } },
  { so: '90009', title: 'Not yet released ("Not yet")', mail: 'Not yet', expect: { result: 'PASS', release: 'NOT FOUND', moved: false } }
];

const records = [], mails = [];
for (const s of SCEN) {
  const v = Object.assign({}, F.BASE, { so: s.so }, s.docs || {});
  const dir = path.join(need, s.so); fs.mkdirSync(dir);
  const docs = { router: [s.so + ' PART ROUTER.pdf', F.router(v)], traveler: [s.so + ' PART TRAVELER.pdf', F.traveler(v)], po: [s.so + ' PO.pdf', F.materialPo(v)],
    supplier: [s.so + ' Sales_Acknowledgment.pdf', F.supplier(v)], print: [s.so + ' PART PRINT.pdf', ' ' ] };
  for (const [k, [name, text]] of Object.entries(docs)) if (!(s.drop || []).includes(k)) fs.writeFileSync(path.join(dir, name), pdf(text));
  records.push(F.record(Object.assign({}, F.BASE, { so: s.so })));
  mails.push({ subject: 'RELEASE SO#' + s.so + ' PART#' + F.BASE.part, senderEmail: 'kamrul.hasan@camcomfginc.com', senderName: 'Kamrul Hasan', received: '2026-11-20T15:00:00Z', body: 'Charlotte, please release.', ref: 'test:' + s.so + ':req' });
  if (s.mail) mails.push({ subject: 'Re: RELEASE SO#' + s.so + ' PART#' + F.BASE.part, senderEmail: 'chamblin@camcomfginc.com', senderName: 'Charlotte Hamblin', received: '2026-11-21T15:00:00Z', body: s.mail + '\n________________________________\nFrom: Kamrul Hasan', ref: 'test:' + s.so + ':reply' });
}
const cfgFile = path.join(root, 'config.json'), recFile = path.join(root, 'records.json'), mailFile = path.join(root, 'mail.json'), outFile = path.join(root, 'report.json');
fs.writeFileSync(cfgFile, JSON.stringify({ root, pdftotext, approvers: ['chamblin@camcomfginc.com', 'jgreen@camcomfginc.com'], moveFolders: true }));
fs.writeFileSync(recFile, JSON.stringify({ records, known: [] }));
fs.writeFileSync(mailFile, JSON.stringify({ ok: true, mails }));
const agent = path.join(__dirname, '..', 'so-review-agent.js');
const run = (extra) => execFileSync(process.execPath, [agent, '--config', cfgFile, '--records', recFile, '--mail', mailFile, '--no-submit', '--out', outFile].concat(extra || []), { encoding: 'utf8', env: Object.assign({}, process.env, { SO_REVIEW_STATE: path.join(root, 'state') }) });

run();
const rep = JSON.parse(fs.readFileSync(outFile, 'utf8'));
let failed = 0;
const row = (ok, so, title, got) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + so + '  ' + title.padEnd(52) + ' ' + got); };
for (const s of SCEN) {
  const it = rep.items.find((x) => x.so_no === s.so), e = s.expect;
  if (!it) { row(false, s.so, s.title, 'no result'); continue; }
  const dis = (it.review && it.review.discrepancies || []).map((d) => d.field), miss = it.review && it.review.missing || [];
  const moved = fs.existsSync(path.join(released, s.so)) && !fs.existsSync(path.join(need, s.so));
  const ok = it.result === e.result && (!e.release || it.release_status === e.release) && (!e.field || dis.includes(e.field)) && (!e.missing || miss.some((m) => m.startsWith(e.missing)))
    && moved === e.moved && (e.attention === undefined || it.needs_attention === e.attention)
    && (e.result !== 'PASS' || dis.length === 0);
  row(ok, s.so, s.title, it.result + ' · ' + it.release_status + (moved ? ' · moved' : '') + (it.needs_attention ? ' · attention' : '') + (dis.length ? ' · ' + dis.join(', ') : '') + (miss.length ? ' · missing ' + miss.join(', ') : ''));
}
// files are moved, never changed: the moved folder still has its original files
const movedFiles = fs.readdirSync(path.join(released, '90006')).sort();
row(movedFiles.length === 5, '90006', 'Moved folder keeps all its files', movedFiles.length + ' files');
// a second run with nothing changed re-reviews nothing and moves nothing again
fs.writeFileSync(recFile, JSON.stringify({ records, known: rep.items.map((x) => ({ so_no: x.so_no, fingerprint: x.fingerprint, folder_state: x.folder_state, folder_path: x.folder_path, result: x.result, release_status: x.release_status })) }));
run();
const rep2 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
row(rep2.status.counts.reviewed === 0 && rep2.moves.length === 0, '-----', 'Second run: unchanged SOs are not re-reviewed or re-moved', 'reviewed ' + rep2.status.counts.reviewed + ', moved ' + rep2.moves.length);
console.log(failed ? '\n' + failed + ' scenario check(s) FAILED' : '\nAll scenario checks passed', '\nTest share:', root);
process.exitCode = failed ? 1 : 0;
