// LOCAL DEVELOPMENT ONLY. Serves ./frontend and an /api endpoint backed by an in-memory fake sheet
// with SYNTHETIC data, using the exact same Service/Core code as the real Apps Script backend.
// It is not connected to Google Sheets and must never be deployed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const Service = require('../backend/Service.js');
const { FakeSheet, makeRow } = require('../tests/fakeSheet.js');

const statuses = ['1. ANALYSIS', '3.OPEN', '4.CLOSE', '5.HOLD'];
const customers = ['ACME', 'GLOBEX', 'INITECH', 'UMBRELLA'];
const champs = ['ALPHA', 'BRAVO', 'CHARLIE'];
const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const rows = [];
for (let i = 0; i < 180; i++) {
  rows.push(makeRow(3 + i, 'id-' + (i + 1), {
    status: statuses[i % 4], champion: champs[i % 3], customer: customers[i % 4],
    part_no: i % 17 === 0 ? '00' + (1000 + i) : '10' + (10000 + i * 7), so_qty: 50 + i * 3,
    due_date: iso((i * 5) % 45 - 15), mat_quote_request_date: i % 4 === 1 ? iso(-5) : '', quote_receive_date: i % 4 === 2 ? iso(-2) : '', quote_received: i % 4 === 2 ? 'yes' : '', mat_receive_date_stockroom: i % 6 === 0 ? iso(-1) : '',
    so_no: i % 25 === 0 ? '' : 25000 + i, so_type: ['STANDARD', 'REPAIR', 'ROUGH'][i % 3], kanban_or_po: i % 2 ? 'PO' : 'KANBAN',
    notes: i % 5 === 0 ? 'Stock-' + i + ' weeks' : '', req_mat_quote: i % 2 ? 'YES' : 'NO', po_receive_date: i % 13 === 0 ? 'req.form' : '2026-09-' + String(1 + (i % 28)).padStart(2, '0'),
    part_price: ' $ ' + ((i % 9) + 1.5).toFixed(2) + ' ', so_release_status_bar: ((i * 7) % 101) + '%', mat_status_bar: [0, 18, 45, 73, 100][i % 5] + '%', steel_type: i % 6 === 0 ? '-' : '.625 OD x .120 WA A513 TP5 RD TUBING', router_bar_size: i % 6 === 0 ? '-' : "12' BAR", qty_per_bar: i % 6 === 0 ? '-' : (i % 4 === 1 ? '0' : String(20 + i)), total_price_quote: i % 7 === 0 ? 398 : ''
  }, i % 7 === 0 ? { total_price_quote: '=275*7.53' } : {}));
}
for (let n = 183; n <= 195; n++) rows.push(makeRow(n, '', {}));   // pre-formatted free rows, like the real sheet
const sheet = new FakeSheet(rows);
const root = path.join(__dirname, '..', 'frontend');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Synthetic subcontractor orders so the Subcontractor screens can be tried without Supabase.
const Sub = require('../backend/Subcon.js');
const scLines = [
  { id: 's1', part_no: 'CHN-100', revision: 'B', qty: 200, priority: 'NORMAL', sub_required: 'YES', so_required: 'YES', required_date: iso(60), ms: {}, exp: {} },
  { id: 's2', part_no: 'CHN-210', qty: 500, priority: 'HIGH', sub_required: 'YES', so_required: 'YES', required_date: iso(50), team_member: 'Li Wei', ms: { rfq: iso(-9) }, exp: {}, last_update: iso(-5) },
  { id: 's3', part_no: 'CHN-300', qty: 80, priority: 'NORMAL', sub_required: 'YES', so_required: 'YES', team_member: 'Li Wei', ms: { rfq: iso(-20), quote_received: iso(-12), quote_to_rich: iso(-10) }, exp: {}, review_status: 'IN REVIEW', required_date: iso(70) },
  { id: 's4', part_no: 'CHN-410', qty: 300, so_no: 'S5001', po_no: 'PO-77', priority: 'NORMAL', sub_required: 'YES', so_required: 'YES', required_date: iso(30), ms: { rfq: iso(-60), quote_received: iso(-52), quote_to_rich: iso(-50), quote_approved: iso(-46), so_requested: iso(-45), so_costing: iso(-44), so_received: iso(-40), po_prep_start: iso(-39), po_created: iso(-37), po_sent_approval: iso(-36), po_approved: iso(-35), po_to_vendor: iso(-34), ack: iso(-32), production_start: iso(-28) }, exp: { exp_prod: iso(-3), exp_arrival: iso(32) }, orig: { exp_prod: iso(-10) }, last_update: iso(-2) },
  { id: 's5', part_no: 'CHN-520', qty: 120, so_no: 'S5002', po_no: 'PO-78', priority: 'NORMAL', sub_required: 'YES', so_required: 'YES', ms: { rfq: iso(-90), quote_received: iso(-80), quote_approved: iso(-75), so_requested: iso(-74), so_received: iso(-70), po_created: iso(-66), po_approved: iso(-64), po_to_vendor: iso(-63), production_start: iso(-55), ready_to_ship: iso(-20), vendor_ship: iso(-15), received_camco: iso(-3) }, exp: {} }
].map((l) => Object.assign({ bpo_no: '', batch: '', so_no: '', po_no: '', ryd_part: '', description: '', owner: '', team_member: '', comm_ref: '', decision_note: '', review_status: '', blocker_type: '', blocker: '', next_action: '', delay_reason: '', note: '', escalated: false, closed: false, qty_shipped: 0, qty_received: 0, qty_hold: 0, qty_rejected: 0, qty_stocked: 0, sent_date: null, customer_due_date: null, next_action_date: null, revised_date: null, last_update: null, orig: {}, exp: {} }, l));
function scMock(rq) {
  const today = rq.today || iso(0);
  if (rq.action === 'scList') return Object.assign({ ok: true, today, role: 'admin', milestones: Sub.MILESTONES, expected: Sub.EXPECTED, stages: Sub.STAGES, sectionDefs: Sub.SECTIONS, decisions: Sub.DECISIONS, reviewStatuses: Sub.REVIEW_STATUSES, priorities: Sub.PRIORITIES, blockers: Sub.BLOCKERS, updateKinds: Sub.UPDATE_KINDS, cfg: Sub.CFG }, Sub.build(scLines, today));
  if (rq.action === 'scUpdates') return { ok: true, updates: [] };
  if (rq.action === 'scSaveLine') { const c = Sub.cleanLine(rq.line || {}); if (!c.ok) return { ok: false, code: 'INVALID', error: 'Please fix the highlighted fields.', fieldErrors: c.errors }; const i = scLines.findIndex((l) => l.id === rq.line.id); if (i >= 0) Object.assign(scLines[i], c.value); else scLines.push(Object.assign({ id: 's' + (scLines.length + 1), orig: {} }, c.value)); return { ok: true }; }
  if (rq.action === 'scImportTemplate') {
    const problems = [], plan = [], seen = new Set();
    (rq.rows || []).forEach((row, i) => {
      const inc = Sub.fromTemplateRow(row); if (!inc.part_no && !inc.order_ref && !inc.po_no && !Object.keys(inc.ms).length) return;
      const ref = String(inc.order_ref || '').trim().toUpperCase(); const ex = ref ? scLines.find((l) => String(l.order_ref || '').toUpperCase() === ref) : undefined;
      const key = ex ? ex.id : (ref || 'new' + i); if (seen.has(key)) { problems.push('Row ' + (row.__row || i + 2) + ': appears twice.'); return; } seen.add(key);
      const c = Sub.cleanLine(Sub.mergeLine(ex || null, inc)); if (!c.ok) { problems.push('Row ' + (row.__row || i + 2) + ' (' + (ref || inc.part_no || '?') + '): ' + Object.values(c.errors).join(' ')); return; }
      plan.push({ ex, value: c.value, row: 'Row ' + (row.__row || i + 2) });
    });
    const adds = plan.filter((p) => !p.ex), upds = plan.filter((p) => p.ex);
    const preview = plan.slice(0, 8).map((p) => ({ row: p.row, ref: p.value.order_ref || (p.ex && p.ex.order_ref) || '', part: p.value.part_no, action: p.ex ? 'update' : 'new' }));
    if (rq.dryRun) return { ok: true, dryRun: true, added: adds.length, updated: upds.length, unchanged: 0, problems, problemCount: problems.length, preview };
    adds.forEach((p) => scLines.push(Object.assign({ id: 's' + (scLines.length + 1), orig: {}, order_ref: p.value.order_ref || 'SUB-' + String(scLines.length + 1).padStart(4, '0') }, p.value)));
    upds.forEach((p) => Object.assign(p.ex, p.value));
    return { ok: true, added: adds.length, updated: upds.length, unchanged: 0, problems, problemCount: problems.length };
  }
  return { ok: false, code: 'BAD_REQUEST', error: 'Not available in the mock.' };
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try {
        const rq = JSON.parse(body);
        out = String(rq.action || '').startsWith('sc') ? scMock(rq) : Service.handle(sheet, rq);
      } catch (e) { out = { ok: false, code: 'BAD_REQUEST', error: 'Bad JSON' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  const f = path.join(root, req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\\/])+/, ''));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(5173, '127.0.0.1', () => console.log('DEV MOCK (synthetic data) on http://127.0.0.1:5173'));
