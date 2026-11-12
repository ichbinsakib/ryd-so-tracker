const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../backend/Lifecycle.js');

const T = '2026-10-29';
const base = { status: '3.OPEN', part_no: 'P', customer: 'C', so_qty: '100', steel_type: '1 RD', router_bar_size: "12' BAR", qty_per_bar: '24', req_ft: '60', avail_ft: '-', due_date: '2026-12-01' };
const part = { ...base, status: '1. ANALYSIS' };
const docs = { print_traveller: 'YES', print_router: 'YES', print_part_prints: 'YES', print_req_po: 'YES', verify_by_sakib: 'YES' };
const released = { ...base, so_no: '1', po_approve_date: '2026-10-27', ack_status: 'RECEIVED', ...docs, charllete_jay_release_date: '2026-10-28' };
const d = (x) => L.describe(x, T);

test('a part check waits for the decision, then walks quote, analysis, SO request, SO number', () => {
  assert.equal(d(part).status, 'Awaiting Decision');
  assert.equal(d({ ...part, so_required: 'YES' }).next, 'Request the material quote');
  const w = d({ ...part, so_required: 'YES', mat_quote_request_date: '2026-10-20' });
  assert.equal(w.status, 'Waiting for Material Quote'); assert.equal(w.owner, 'supplier'); assert.ok(w.followupDue);
  assert.equal(d({ ...part, so_required: 'YES', mat_quote_request_date: '2026-10-20', quote_receive_date: '2026-10-25' }).stage, 4);
  assert.equal(d({ ...part, so_required: 'YES', quote_receive_date: '2026-10-25', quote_approve_date: '2026-10-26' }).stage, 5);
  const c = d({ ...base, so_required: 'YES', quote_approve_date: '2026-10-26', so_req_date: '2026-10-26' });
  assert.equal(c.status, 'Waiting for Costing Manager'); assert.equal(c.waitingOn, 'Costing manager'); assert.equal(c.section, 'A');
});

test('stock that covers the need skips the quote, PO, acknowledgment and material stages', () => {
  const r = d({ ...part, so_required: 'YES', avail_ft: '80' });
  assert.equal(r.stage, 5);
  assert.equal(r.steps.find((s) => s.key === 'quoteReq').state, 'skip');
  assert.equal(d({ ...base, avail_ft: '80', so_no: '5', ...docs, charllete_jay_release_date: '2026-10-28' }).status, 'Monitoring Until Due Date');
});

test('PO, acknowledgment, documents and release in order', () => {
  assert.equal(d({ ...base, so_no: '1' }).stage, 7);
  assert.equal(d({ ...base, so_no: '1', po_no_1: 'X', po_approve_date: '2026-10-27' }).status, 'Waiting for PO Acknowledgment');
  assert.equal(d({ ...base, so_no: '1', po_approve_date: '2026-10-27', ack_status: 'RECEIVED' }).status, 'Awaiting Documentation');
  assert.equal(d({ ...base, so_no: '1', po_approve_date: '2026-10-27', ack_status: 'RECEIVED', ...docs }).status, 'Ready for Release');
});

test('material status: late, at risk, on time, unknown; and the report section', () => {
  assert.equal(d({ ...released, po_due_date: '2026-10-20' }).matStatus, 'Late');
  assert.equal(d({ ...released, po_due_date: '2026-10-20' }).section, 'C');
  assert.equal(d({ ...released, po_due_date: '2026-12-10' }).matStatus, 'At Risk');
  assert.equal(d({ ...released, po_due_date: '2026-11-15' }).matStatus, 'On Time');
  assert.equal(d({ ...released }).matStatus, 'Unknown');
});

test('two completion states: initial workflow completes on material arrival; final needs verified closure', () => {
  const m = d({ ...released, mat_receive_date_stockroom: '2026-10-29' });
  assert.equal(m.initial, 'Complete'); assert.equal(m.final, 'Monitoring'); assert.equal(m.status, 'Monitoring Until Due Date');
  const o = d({ ...released, mat_receive_date_stockroom: '2026-10-20', due_date: '2026-10-20' });
  assert.equal(o.status, 'Overdue — Awaiting Closure'); assert.equal(o.section, 'E'); assert.equal(o.final, 'Overdue');
  assert.equal(d({ ...released, mat_receive_date_stockroom: '2026-10-20', status: '4.CLOSE' }).status, 'Monitoring Until Due Date', 'closed status without a close date is not verified');
  const c = d({ ...released, mat_receive_date_stockroom: '2026-10-20', status: '4.CLOSE', so_close_date: '2026-10-28' });
  assert.equal(c.status, 'Closed — Verified'); assert.equal(c.section, 'F'); assert.equal(c.closedOn, '2026-10-28');
});

test('SOs already past an early stage are not sent backwards; not required SOs are cancelled', () => {
  const r = d({ ...base, so_no: '7', po_approve_date: '2026-09-20', charllete_jay_release_date: '2026-10-01' });
  assert.equal(r.stage, 11);
  assert.equal(d({ ...base, so_required: 'NO' }).status, 'Cancelled / Not Required');
});

test('follow-ups, escalation and issues raise reasons and put the SO in my actions', () => {
  const r = d({ ...released, po_due_date: '2026-11-15', mat_receive_date_stockroom: '2026-10-28', escalated: 'YES', blocker: 'Drawing rev unclear' });
  assert.ok(r.reasons.some((x) => x.text === 'Escalated' && x.level === 'crit'));
  assert.ok(r.reasons.some((x) => /Issue: Drawing/.test(x.text)));
  assert.equal(r.section, 'A');
  const f = d({ ...base, so_no: '1', po_approve_date: '2026-10-27', next_followup_date: '2026-10-25' });
  assert.ok(f.reasons.some((x) => /Follow-up overdue by 4 days/.test(x.text)));
});

// ---- review fixes (today 2026-11-12)
const T2 = '2026-11-12';
const po = { ...base, due_date: '2026-12-20', so_no: 'SO1', supplier: 'Acme', po_no_1: 'PO1', po_approve_date: '2026-09-05', po_due_date: '2026-12-01', ...docs };

test('an acknowledgment date alone passes the acknowledgment stage (an explicit discrepancy still holds it)', () => {
  const r = L.describe({ ...po, ack_date: '2026-09-07' }, T2);
  assert.equal(r.stage, 10); assert.equal(r.status, 'Ready for Release');
  assert.equal(L.describe({ ...po, ack_date: '2026-09-07', ack_status: 'DISCREPANCY' }, T2).stage, 8);
  const rel = L.describe({ ...po, ack_date: '2026-09-07', charllete_jay_release_date: '2026-10-01' }, T2);
  assert.ok(!rel.reasons.some((x) => /acknowledgment not recorded/.test(x.text)));
});

test('released with a PO number but no PO approval: my action with a reason, in a report section', () => {
  const r = L.describe({ ...po, po_approve_date: '', charllete_jay_release_date: '2026-10-01' }, T2);
  assert.equal(r.stage, 11); assert.equal(r.owner, 'me'); assert.equal(r.section, 'A');
  assert.ok(r.reasons.some((x) => x.text === 'PO approval not recorded'));
  assert.ok(!r.reasons.some((x) => /Follow-up/.test(x.text)));
});

test('5.HOLD: on hold, nobody owes anything, never overdue, kept visible in section B', () => {
  const h = L.describe({ ...po, status: '5.HOLD', due_date: '2026-10-01', po_due_date: '2026-10-01', next_followup_date: '2026-09-01' }, T2);
  assert.equal(h.status, 'On hold'); assert.equal(h.owner, 'none'); assert.equal(h.waitingOn, '');
  assert.equal(h.section, 'B'); assert.equal(h.final, 'Open'); assert.equal(h.followup, ''); assert.equal(h.followupDue, false);
  assert.deepEqual(h.reasons.map((x) => x.text), ['On hold']);
  assert.ok(L.STATUSES.includes('On hold'));
  assert.ok(L.describe({ ...po, status: '5.HOLD', escalated: 'YES' }, T2).reasons.some((x) => x.text === 'Escalated'));
});
