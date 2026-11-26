/**
 * SO Review: read the release documents of one SO folder and compare them with the app's SO record.
 * Pure functions (no file, network or mail access) so they can be unit-tested: tests/so-review.test.js.
 *
 * Documents in a folder (file names vary: "25808 PART ROUTER.pdf", "25877- PO.pdf", "25865R REQ. FORM.pdf"):
 *   router      PART ROUTER / ROUTING          CAMCO routing: part, customer, steel, bar, pcs/bar, part price, material cost, operations
 *   traveler    PART TRAVELER                  CAMCO traveler: SO#, qty, due date, part, description, customer, material, price, cost, operations
 *   materialPo  PO                              CAMCO material purchase order to the supplier (one PO may cover several SOs)
 *   reqForm     REQ. FORM                       stock requisition (material pulled from stock: no supplier order needed)
 *   supplier    Sales_Acknowledgment / Sales_Confirmation / *_Order / Order Confirmation: the supplier's confirmation of the PO
 *   print       PART PRINT                      the drawing (a scanned image: only its presence is checked)
 */
'use strict';

const DOC_KINDS = [
  ['router', 'Routing (part router)'],
  ['traveler', 'Traveler'],
  ['material', 'Material PO or stock requisition'],
  ['supplier', 'Supplier sales confirmation'],
  ['print', 'Part print']
];

// ---------- helpers
const clean = (s) => String(s == null ? '' : s).replace(/ /g, ' ').trim();
const up = (s) => clean(s).toUpperCase().replace(/\s+/g, ' ');
function money(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const m = String(s).replace(/[,\s]/g, '').match(/^\(?-?\$?\(?(-?\d+(?:\.\d+)?)\)?$/);
  if (!m) return null;
  const neg = /^\(|-/.test(String(s).replace(/\s/g, ''));
  return neg ? -Math.abs(parseFloat(m[1])) : parseFloat(m[1]);
}
function num(s) { const t = String(s == null ? '' : s).replace(/[,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; }
/** M/D/YY or M/D/YYYY (or ISO) -> YYYY-MM-DD */
function isoDate(s) {
  const t = clean(s);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/); if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  const d = new Date(+y, +m[1] - 1, +m[2]); if (d.getMonth() !== +m[1] - 1 || d.getDate() !== +m[2]) return null;
  return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
}
/** "SO 25808", "25808", "R23666" -> "25808" style key (upper case, no spaces, leading zeros kept) */
const soKey = (s) => up(s).replace(/^SO\s*#?\s*/, '').replace(/\s+/g, '');
const partKey = (s) => up(s).replace(/\s+/g, '');
/** customer names: the app keeps a short name (IR, TOYOTA), the documents the full one (INGERSOLL-RAND, TOYOTA MATERIAL HANDLING, Inc.) */
const customerKey = (s) => { const u = up(s); if (/^(IR\b|INGERSOLL)/.test(u)) return 'IR'; return (u.match(/^[A-Z0-9&]+/) || [u])[0]; };
/** steel / material text compared without spacing differences and with ".625" == "0.625" */
const steelKey = (s) => up(s).replace(/\b0\./g, '.').replace(/[\s"'”]/g, '');
const lines = (t) => String(t || '').replace(/\r/g, '').split('\n');
const firstCell = (line) => clean(String(line || '').split(/\s{3,}/).filter((x) => x.trim())[0] || '');
function after(text, re) { const m = String(text || '').match(re); return m ? clean(m[1]) : ''; }
/** A steel size that wraps onto the next line ("RECTANGLE BAR 2.00 x" / "2.25") is joined back together. */
function steelAfter(text, re) {
  const t = String(text || ''), m = t.match(re); if (!m) return '';
  let v = clean(m[1]);
  if (/\b[xX]$/.test(v)) {
    const rest = t.slice(m.index + m[0].length).replace(/^[^\n]*\n/, '');   // the line below the label
    const n = (rest.split('\n')[0] || '').match(/^\s*.{0,60}?(\d+(?:\.\d+)?)/);
    if (n) v += ' ' + n[1];
  }
  return v;
}
/** The first $ amount on the lines below `label`, in roughly the same column (layout-mode pdftotext). */
function amountBelow(text, label, maxLines, colSlack) {
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const c = ls[i].indexOf(label); if (c < 0) continue;
    for (let j = i; j <= Math.min(ls.length - 1, i + (maxLines || 3)); j++) {
      const re = /\$\s*([\d,]+\.\d+)/g; let m;
      while ((m = re.exec(ls[j]))) {
        // only an amount in (roughly) the label's own column: amounts further right belong to the next field
        if (Math.abs(m.index - c) <= (colSlack || 30)) return money(m[1]);
      }
    }
  }
  return null;
}

// ---------- classify files
function classify(fileName) {
  const n = up(fileName).replace(/[_\-.]+/g, ' ');
  if (!/\.?(PDF)$/.test(up(fileName)) && !/\.PDF$/i.test(fileName)) return { kind: 'other', usable: false };
  if (/\bROUT(ER|ING)\b/.test(n)) return { kind: 'router' };
  if (/\bTRAVE?LL?ER\b/.test(n)) return { kind: 'traveler' };
  if (/\bPRINT\b|\bDRAWING\b/.test(n)) return { kind: 'print' };
  if (/\bREQ\b.*\bFORM\b|\bREQUISITION\b/.test(n)) return { kind: 'reqForm' };
  if (/SALES ?(ACK|CONF)|ACKNOWLEDG|CONFIRMATION|\bORDER\b/.test(n)) return { kind: 'supplier' };
  if (/\bPO\b|PURCHASE ORDER/.test(n)) return { kind: 'materialPo' };
  return { kind: 'other' };
}

// ---------- document readers (text from `pdftotext -layout`)
function parseOps(text, re) {
  const out = []; let m; const r = new RegExp(re.source, 'gm');
  while ((m = r.exec(text))) out.push({ op: m[1], wc: m[2], desc: clean(m[3] || '').split(/\s{2,}/)[0] });
  return out;
}
function parseRouter(text) {
  const ls = lines(text).filter((l) => l.trim()); let part = '', desc = '';
  const pi = ls.findIndex((l) => /PART NUMBER/.test(l));
  if (pi >= 0) { part = firstCell(ls[pi + 1]); desc = firstCell(ls[pi + 2]); if (/MATERIAL PCS|STEEL TYPE|CUSTOMER:/i.test(desc)) desc = ''; }
  return {
    so: after(text, /(\S+)\s+ROUTING\b/), part, description: desc,
    customer: after(text, /CUSTOMER:\s*(.+?)(?:\s{2,}|$)/m),
    barSize: (after(text, /MATERIAL TYPE:\s*(.+?)(?:\s{2,}|$)/m).match(/^\d+\s*(?:'|FT|FEET)\s*(?:BAR)?$/i) || [''])[0],   // only a bar length, e.g. 12' BAR
    pcsPerBar: num(after(text, /PCS PER\s*:\s*([\d.,]+)/)),
    steel: steelAfter(text, /STEEL TYPE:\s*(.+?)(?:\s{3,}|$)/m),   // 3+ spaces: descriptions like "RECTANGLE BAR 2.00 x  2.25" keep their double space
    partPrice: amountBelow(text, 'PART PRICE', 3, 12),
    materialCost: amountBelow(text, 'PART MATERIAL COST', 3, 40),
    ops: parseOps(text, /^\s{0,6}(\d{3}[A-Z]?)\s+(\d{5})\b(.*)$/)
  };
}
function parseTraveler(text) {
  return {
    so: after(text, /SHOP ORDER\s+(\S+)/),
    qty: num(after(text, /^\s*NUMBER\s+([\d,]+)\s*$/m)) ?? num(after(text, /ORDER\s+QUANTITY\s+([\d,]+)/)),
    due: isoDate(after(text, /\bDUE\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/)),
    part: after(text, /PART NUMBER\s+(\S+)/),
    description: after(text, /PART DESCRIPTION\s+(.+?)(?:\s{2,}|$)/m),
    customer: after(text, /^CUSTOMER\s+(.+?)(?:\s{2,}|$)/m),
    steel: steelAfter(text, /^MATERIAL TYPE\s+(.+?)(?:\s{3,}|$)/m),
    partPrice: money(after(text, /PART PRICE\s*\$\s*([\d,]+\.\d+)/)),
    materialCost: money(after(text, /MATERIAL COST\s*\$\s*([\d,]+\.\d+)/)),
    ops: parseOps(text, /^(\d{3}[A-Z]?)\s+\d+\s+(\d{5})\b(.*)$/)
  };
}
function parseMaterialPo(text) {
  const soLines = [];
  const r = /^\s*(\d{1,2})\s+(R?\d{4,6}[A-Z]{0,2})\s+(.+?)(?:\s{2,}|$)/gm; let m;
  while ((m = r.exec(text))) soLines.push({ line: m[1], so: m[2], desc: clean(m[3]) });
  const ls = lines(text).filter((l) => l.trim()); const vi = ls.findIndex((l) => /^\s*VENDOR:/.test(l));
  return {
    poNo: after(text, /PO NUMBER:\s*(\d+)/), poDate: isoDate(after(text, /PO DATE:\s*(\S+)/)),
    vendor: vi >= 0 ? firstCell(ls[vi + 1]) : '', soLines, sos: [...new Set(soLines.map((x) => soKey(x.so)))],
    part: after(text, /PART #:\s*(\S+)/), total: money(after(text, /TOTAL:\s*\$\s*([\d,]+\.\d+)/)), due: isoDate(after(text, /DUE DATE:\s*(\S+)/))
  };
}
function parseReqForm(text) {
  return { so: after(text, /SHOP ORDER NUMBER\s+(\S+)/), partCost: money(after(text, /PART COST:\s*\$\s*([\d,]+\.\d+)/)), totalCost: money(after(text, /TOTAL COST:\s*\$\s*([\d,]+\.\d+)/)) };
}
function parseSupplier(text) {
  const t = String(text || '');
  const poRefs = [...new Set((t.match(/\b13\d{4}\b/g) || []))];   // CAMCO PO numbers are 13xxxx
  const soRefs = new Set(); let m; const r = /SO\s*#?\s*(\d{5})/gi; while ((m = r.exec(t))) soRefs.add(m[1]);
  const detl = t.match(/Detl:\s*((?:\d+,\s?)*\d+)/i);   // Alro: "Detl: 25874,25875,876,877" (later numbers abbreviated)
  if (detl) { let base = ''; detl[1].split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => { if (x.length >= 5) base = x; else if (base) x = base.slice(0, base.length - x.length) + x; soRefs.add(x); }); }
  const totals = [...t.matchAll(/(?:Total(?:\s+Price|\s+Value\s*\(USD\))?|Net Value|Item Total \(USD\))\s*:?\s*\$?\s*([\d,]+\.\d{2})/gi)].map((x) => money(x[1]));
  const known = t.match(/Murphy and Nolan|Alro Steel|Earle M\. Jorgensen|EMJ|Ryerson|Olympic Steel|Castle Metals|Southern Cast|Kloeckner|Russel Metals|Samuel/i);
  return { supplierName: known ? known[0] : firstCell(lines(t).find((l) => l.trim()) || ''), poRefs, soRefs: [...soRefs], total: totals.length ? totals[totals.length - 1] : null, text: t };
}

// ---------- comparison
/** One field check. sources: [{doc, value}], app value; kind: 'text' | 'steel' | 'money' | 'number' | 'date' | 'so' | 'part' */
function check(field, severity, appValue, sources, kind, note) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return null;
    switch (kind) {
      case 'money': return money(v);
      case 'number': return num(v);
      case 'date': return isoDate(v) || clean(v);
      case 'steel': return steelKey(v);
      case 'so': return soKey(v);
      case 'part': return partKey(v);
      case 'customer': return customerKey(v);
      default: return up(v);
    }
  };
  const eq = (a, b) => (kind === 'money' || kind === 'number' ? Math.abs(a - b) < 0.005 : a === b);
  // appValue === false: the app does not store this field, so only the documents are compared with each other
  const app = appValue === false ? null : norm(appValue), docs = (sources || []).filter((s) => s && s.value !== undefined);
  const out = { field, severity, app: appValue === undefined || appValue === null || appValue === false ? '' : appValue, docs: docs.map((s) => ({ doc: s.doc, value: s.value === null ? '' : s.value })), ok: true, problem: '', note: note || '' };
  const readable = docs.filter((s) => norm(s.value) !== null);
  if (!readable.length) { out.ok = null; out.problem = 'Not found in the documents'; return out; }
  const bad = readable.filter((s) => app !== null && !eq(norm(s.value), app));
  const docsDisagree = readable.some((s) => !eq(norm(s.value), norm(readable[0].value)));
  if (app === null && appValue !== false) { out.ok = false; out.problem = 'Missing in the app'; out.fix = 'Enter ' + field + ' in the app (documents show ' + readable[0].value + ')'; return out; }
  if (bad.length || docsDisagree) {
    out.ok = false;
    out.problem = bad.length ? bad.map((s) => s.doc + ' shows ' + s.value).join('; ') + ' but the app has ' + appValue : 'The documents disagree: ' + readable.map((s) => s.doc + ' ' + s.value).join(', ');
    out.fix = bad.length ? 'Correct ' + field + ' in ' + (bad.length === readable.length ? 'the app or in ' : '') + bad.map((s) => s.doc).join(' and ') : 'Make the documents agree';
  }
  return out;
}

/**
 * Review one SO. files: [{name, kind, text, readable, error}], rec: the app record ({values, display}) or null.
 * Returns { result, docs_found, docs_required, summary, documents, checks, discrepancies, missing, errors }.
 */
function reviewSo(soNo, files, rec) {
  const errors = [], byKind = {};
  files.forEach((f) => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
  const one = (k) => (byKind[k] || []).find((f) => f.readable) || (byKind[k] || [])[0] || null;
  const router = one('router'), traveler = one('traveler'), po = one('materialPo'), req = one('reqForm'), sup = one('supplier'), print = one('print');
  const R = router && router.readable ? parseRouter(router.text) : null;
  const T = traveler && traveler.readable ? parseTraveler(traveler.text) : null;
  const P = po && po.readable ? parseMaterialPo(po.text) : null;
  const Q = req && req.readable ? parseReqForm(req.text) : null;
  const S = sup && sup.readable ? parseSupplier(sup.text) : null;
  const stock = !!req && !po;   // material pulled from stock: no supplier order is expected

  // ---- the five required documents
  const docState = (kind, label, f, values, extra) => ({ kind, label, file: f ? f.name : '', present: !!f, readable: !!(f && f.readable), required: true, values: values || null, notes: extra || [] });
  const documents = [
    docState('router', 'Routing (part router)', router, R),
    docState('traveler', 'Traveler', traveler, T),
    docState('material', stock ? 'Stock requisition form' : 'Material PO', po || req, P || Q),
    Object.assign(docState('supplier', 'Supplier sales confirmation', sup, S ? { supplier: S.supplierName, poRefs: S.poRefs, soRefs: S.soRefs, total: S.total } : null), stock && !sup ? { required: false, notes: ['Not needed: material is pulled from stock'] } : {}),
    Object.assign(docState('print', 'Part print', print, null), print ? { notes: ['Scanned drawing: presence checked only'] } : {})
  ];
  // a print is an image: present counts as readable
  if (print) documents[4].readable = true;
  documents.forEach((d) => { const f = d.kind === 'material' ? (po || req) : one(d.kind === 'print' ? 'print' : d.kind); if (f && f.error) d.notes.push('Could not read: ' + f.error); });
  const required = documents.filter((d) => d.required);
  const missing = required.filter((d) => !d.present || !d.readable).map((d) => d.label + (d.present ? ' (unreadable)' : ''));

  // ---- field checks against the app record
  const v = rec ? rec.values || {} : {}, dsp = rec ? rec.display || {} : {};
  const app = (k) => { const x = v[k]; return x === undefined || x === null || String(x).trim() === '' || String(x).trim() === '-' ? null : x; };
  const appD = (k) => { const x = dsp[k] !== undefined ? dsp[k] : v[k]; const s = clean(x); return s === '' || s === '-' || /^#/.test(s) ? null : s; };
  const checks = [];
  if (!rec) errors.push('SO ' + soNo + ' was not found in the app');
  const src = (doc, value) => ({ doc, value });
  const so = soKey(soNo);
  checks.push(check('SO number', 'critical', rec ? app('so_no') : so, [src('Folder', so), R && src('Routing', R.so), T && src('Traveler', T.so), Q && src('Requisition', Q.so),
    P && src('Material PO', P.sos.includes(so) ? so : (P.sos.join(', ') || null))].filter(Boolean), 'so'));
  checks.push(check('Part number', 'critical', app('part_no'), [R && src('Routing', R.part), T && src('Traveler', T.part), P && P.part && src('Material PO', P.part)].filter(Boolean), 'part'));
  checks.push(check('Part description', 'major', false, [R && src('Routing', R.description), T && src('Traveler', T.description)].filter(Boolean), 'text', 'Not stored in the app: routing and traveler must agree'));
  checks.push(check('Customer', 'major', app('customer'), [R && src('Routing', R.customer), T && src('Traveler', T.customer)].filter(Boolean), 'customer'));
  checks.push(check('Order quantity', 'critical', app('so_qty'), [T && src('Traveler', T.qty)].filter(Boolean), 'number'));
  checks.push(check('Part price', 'critical', appD('part_price'), [R && src('Routing', R.partPrice), T && src('Traveler', T.partPrice)].filter(Boolean), 'money'));
  checks.push(check('Steel type / grade', 'critical', appD('steel_type') || app('material_code'), [R && src('Routing', R.steel), T && src('Traveler', T.steel)].filter(Boolean), 'steel'));
  // the traveler carries the updated material cost = the app's quote price per piece (total quote / qty), not the old traveller price
  checks.push(check('Material cost per piece', 'critical', appD('quote_price_piece') || app('traveller_mat_price_piece'), [R && src('Routing', R.materialCost), T && src('Traveler', T.materialCost)].filter(Boolean), 'money'));
  checks.push(check('Due date', 'critical', app('due_date'), [T && src('Traveler', T.due)].filter(Boolean), 'date'));
  checks.push(check('Bar size', 'major', appD('router_bar_size'), [R && src('Routing', R.barSize)].filter(Boolean), 'text'));
  checks.push(check('Pieces per bar', 'major', appD('qty_per_bar'), [R && src('Routing', R.pcsPerBar)].filter(Boolean), 'number'));
  // routing: the traveler must carry the same operations, in the same order, as the routing
  if (R && T) {
    const a = R.ops.map((o) => o.op + '/' + o.wc), b = T.ops.map((o) => o.op + '/' + o.wc);
    const same = a.length > 0 && a.join(',') === b.join(',');
    const sorted = b.every((x, i) => i === 0 || x.split('/')[0] > b[i - 1].split('/')[0]);
    checks.push({ field: 'Routing operations and sequence', severity: 'critical', app: '', docs: [{ doc: 'Routing', value: a.join(' → ') }, { doc: 'Traveler', value: b.join(' → ') }],
      ok: !a.length && !b.length ? null : same && sorted, problem: !a.length && !b.length ? 'No operations found' : same && sorted ? '' : !same ? 'The traveler operations (op/work center) differ from the routing' : 'Operations are out of order',
      fix: same && sorted ? undefined : 'Regenerate the traveler from the current routing', note: a.length + ' operations' });
  }
  // material order: the PO must list this SO, the supplier confirmation must be for the same PO
  if (P) {
    checks.push(check('Material PO number', 'major', app('po_no_1') ? String(app('po_no_1')).replace(/\D/g, '') : null, [src('Material PO', P.poNo)], 'text'));
    checks.push({ field: 'Material PO lists this SO', severity: 'critical', app: so, docs: [{ doc: 'Material PO', value: P.sos.join(', ') }], ok: P.sos.includes(so), problem: P.sos.includes(so) ? '' : 'This SO is not on the material PO', fix: P.sos.includes(so) ? undefined : 'Put the right material PO in the folder' });
    if (P.sos.length === 1) checks.push(check('Material PO total', 'major', app('price_on_po'), [src('Material PO', P.total)], 'money'));
  }
  if (S && P) {
    const okPo = S.poRefs.includes(P.poNo);
    checks.push({ field: 'Supplier confirmation is for this PO', severity: 'critical', app: '', docs: [{ doc: 'Material PO', value: P.poNo }, { doc: 'Supplier confirmation', value: S.poRefs.join(', ') }], ok: okPo, problem: okPo ? '' : 'The supplier confirmation does not reference PO ' + P.poNo, fix: okPo ? undefined : 'Get the supplier confirmation for PO ' + P.poNo });
    if (S.total !== null && P.total !== null) checks.push(check('Supplier total vs PO total', 'major', P.total, [src('Supplier confirmation', S.total)], 'money', 'A difference usually means a price or surcharge change'));
  }
  if (S) {
    const refsSo = S.soRefs.includes(so) || (rec && app('part_no') && partKey(S.text).includes(partKey(app('part_no'))));
    checks.push({ field: 'Supplier confirmation names this SO or part', severity: 'major', app: so, docs: [{ doc: 'Supplier confirmation', value: S.soRefs.join(', ') || '(no SO#)' }], ok: !!refsSo, problem: refsSo ? '' : 'Neither the SO number nor the part number appears on the supplier confirmation' });
  }
  if (Q) checks.push(check('Material cost per piece (requisition)', 'major', appD('quote_price_piece') || app('traveller_mat_price_piece'), [src('Requisition', Q.partCost)], 'money', 'Stock price on the requisition'));

  // steel grade on the material order: the grade number on the routing (e.g. 1045) must appear on the PO / supplier documents
  const grade = (R && R.steel ? R.steel : '').match(/\b(\d{4}|A\d{3}|\d{3}[A-Z]?L?\d{0,2})\b/g);
  if (grade && (P || S)) {
    const g = grade[grade.length - 1];
    const inPo = P ? P.soLines.some((l) => up(l.desc).includes(g)) || up(po.text).includes(g) : null, inSup = S ? up(S.text).includes(g) : null;
    // the CAMCO material PO must name the grade (critical); supplier confirmations often abbreviate it, so that one is informational
    if (P) checks.push({ field: 'Steel grade on the material PO', severity: 'critical', app: g, docs: [{ doc: 'Material PO', value: inPo ? g : '(not found)' }], ok: inPo, problem: inPo ? '' : 'Steel grade ' + g + ' from the routing is not on the material PO', fix: inPo ? undefined : 'Check the material ordered is grade ' + g });
    if (S) checks.push({ field: 'Steel grade on the supplier confirmation', severity: 'minor', app: g, docs: [{ doc: 'Supplier confirmation', value: inSup ? g : '(not found)' }], ok: inSup, problem: inSup ? '' : 'Grade ' + g + ' not written on the supplier confirmation: check it by eye' });
  }

  const discrepancies = checks.filter((c) => c.ok === false).map((c) => ({ field: c.field, severity: c.severity, app: c.app, docs: c.docs, problem: c.problem, fix: c.fix || '' }));
  const result = missing.length ? 'MISSING DOCUMENT' : !rec || discrepancies.some((d) => d.severity === 'critical' || d.severity === 'major') ? 'FAIL' : 'PASS';
  const summary = {
    so_no: so, part_no: app('part_no') || (R && R.part) || (T && T.part) || '', description: (T && T.description) || (R && R.description) || '',
    customer: app('customer') || (T && T.customer) || '', qty: app('so_qty') ?? (T && T.qty), part_price: appD('part_price') || (T && T.partPrice), material: appD('steel_type') || (R && R.steel) || '',
    material_cost: appD('quote_price_piece') || app('traveller_mat_price_piece') || (T && T.materialCost), due_date: app('due_date') || (T && T.due) || '', status: app('status') || ''
  };
  return { result, docs_found: required.filter((d) => d.present && d.readable).length, docs_required: required.length, summary, documents, checks, discrepancies, missing, errors };
}

// ---------- release confirmation from email
/**
 * mails: [{subject, senderEmail, senderName, received (ISO), body, ref}] (any order). approvers: lower-case emails.
 * RELEASED only for a clear statement from an approver in this SO's release thread; any other approver reply is POSSIBLE.
 */
function decideRelease(soNo, mails, approvers) {
  const so = soKey(soNo), soRe = new RegExp('(?:^|[^\\d])' + so.replace(/[^\dA-Z]/g, '') + '(?![\\d])', 'i');
  const thread = (mails || []).filter((m) => /RELEASE/i.test(m.subject || '') && soRe.test(m.subject || ''));
  const fromApprover = thread.filter((m) => (approvers || []).includes(String(m.senderEmail || '').toLowerCase()))
    .sort((a, b) => String(b.received).localeCompare(String(a.received)));
  const top = (body) => String(body || '').split(/\n\s*(?:From:|-----Original Message|_{10,}|On .{5,80} wrote:)/i)[0].replace(/\s+/g, ' ').trim();
  const POSITIVE = /\b(released|approved|has been released|been approved|is released|are released|done|completed)\b/i;
  const HEDGE = /\b(not|n't|never|no|pending|waiting|will|would|should|could|once|until|after|if|need|needs|please|can you|could you|for approval)\b/i;
  // newest reply first: a "not yet" or a change request after an earlier approval means it is not released now
  const NOT_YET = /\bnot\s+yet\b|\bnot\s+(?:been\s+)?(?:released|approved)\b|\bon\s+hold\b|\bpending\b|\bwaiting\b/i;
  const CHANGES = /\b(?:please|can you|could you|kindly)\b[^.?!]{0,80}\b(?:combine|change|fix|update|correct|add|remove|revise|resend|send)\b/i;
  for (const m of fromApprover) {
    const t = top(m.body), base = { subject: m.subject, date: m.received, sender: m.senderName || m.senderEmail, ref: m.ref || '', threadCount: thread.length };
    if (NOT_YET.test(t)) return Object.assign(base, { status: 'NOT FOUND', evidence: 'Not released yet: ' + t.slice(0, 280) });
    if (CHANGES.test(t)) return Object.assign(base, { status: 'NOT FOUND', changesRequested: true, evidence: 'Changes requested: ' + t.slice(0, 280) });
    if (POSITIVE.test(t) && !HEDGE.test(t)) return Object.assign(base, { status: 'RELEASED', evidence: t.slice(0, 300) });
  }
  if (fromApprover.length) { const m = fromApprover[0]; return { status: 'POSSIBLE', subject: m.subject, date: m.received, sender: m.senderName || m.senderEmail, ref: m.ref || '', evidence: top(m.body).slice(0, 300) || '(no text: image or attachment only)', threadCount: thread.length }; }
  if (thread.length) { const m = thread.slice().sort((a, b) => String(b.received).localeCompare(String(a.received)))[0]; return { status: 'NOT FOUND', subject: m.subject, date: m.received, sender: m.senderName || m.senderEmail, ref: m.ref || '', evidence: 'Release requested; no reply from Charlotte or Jay yet', threadCount: thread.length }; }
  return { status: 'NOT FOUND', subject: '', date: '', sender: '', ref: '', evidence: 'No release email found', threadCount: 0 };
}

/** Folder names that are SOs: 25808, 25865R, R23666, 25310N. Others ("MRB PULL SO LIST", "7-4-2025") are skipped. */
const isSoFolder = (name) => /^R?\d{5}[A-Z]{0,2}$/i.test(String(name || '').trim());

module.exports = { DOC_KINDS, classify, parseRouter, parseTraveler, parseMaterialPo, parseReqForm, parseSupplier, reviewSo, decideRelease, isSoFolder, isoDate, money, soKey, steelKey };
