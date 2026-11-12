// BPO Tracking CSV import (scImport): merging a CSV row into an existing subcontractor line.
const test = require('node:test');
const assert = require('node:assert/strict');
const Pg = require('../backend/PgAdapter.js');

const existing = () => ({
  id: 'L1', po_key: 'PO-77', order_ref: 'SUB-0004', bpo_no: 'BPO-1', batch: 'A', po_no: 'PO-77', so_no: 'S5001', part_no: 'CHN-410', ryd_part: 'RYD-1',
  description: 'Bracket', revision: 'B', qty: 300, priority: 'HIGH', owner: 'Ann', team_member: 'Li', vendor: 'Ningbo', comm_ref: 'mail 1', decision_note: 'ok',
  so_required: 'YES', sub_required: 'YES', review_status: 'IN REVIEW', blocker_type: '', blocker: 'waiting', next_action: 'call', delay_reason: '', note: 'old note',
  escalated: true, closed: false, sent_date: '2026-09-01', required_date: '2026-12-01', customer_due_date: null, next_action_date: '2026-11-20', revised_date: null, last_update: '2026-11-01',
  qty_shipped: 0, qty_received: 0, qty_hold: 0, qty_rejected: 0, qty_stocked: 0,
  ms: { rfq: '2026-09-01', po_to_vendor: '2026-10-01' }, exp: { exp_arrival: '2026-12-10' }, orig: { exp_prod: '2026-11-01' }
});

test('scImport merge keeps every column the CSV did not fill in', () => {
  const m = Pg.bpoImportMerge(existing(), { po_no: 'PO-77', part_no: 'CHN-410', qty: 300, ms: { vendor_ship: '2026-11-05' }, qty_shipped: 300, note: '', last_update: '2026-11-12' });
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  const v = m.value;
  for (const k of ['owner', 'vendor', 'priority', 'blocker', 'next_action', 'team_member', 'decision_note', 'review_status', 'revision', 'description', 'comm_ref', 'so_required', 'order_ref'])
    assert.equal(v[k], existing()[k], k + ' kept');
  assert.equal(v.escalated, true);
  assert.equal(v.note, 'old note', 'a blank cell never erases');
  assert.deepEqual(v.exp, { exp_arrival: '2026-12-10' });
  assert.deepEqual(v.ms, { rfq: '2026-09-01', po_to_vendor: '2026-10-01', vendor_ship: '2026-11-05' }, 'milestones merged, not replaced');
  assert.deepEqual(m.diff.sort(), ['ms', 'qty_shipped']);
});

test('scImport merge never reopens a closed line, keeps a known qty, and keeps the first value of a changed date', () => {
  const ex = existing(); ex.closed = true; ex.ms.received_camco = '2026-11-01'; ex.qty_received = 300;
  const m = Pg.bpoImportMerge(ex, { po_no: 'PO-77', qty: 0, closed: false, ms: { po_to_vendor: '2026-10-03' } });
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  assert.equal(m.value.closed, true);
  assert.equal(m.value.qty, 300, 'qty 0 (unknown) does not replace a known qty');
  assert.equal(m.value.ms.po_to_vendor, '2026-10-03');
  assert.equal(m.orig.po_to_vendor, '2026-10-01', 'first value kept in orig');
  assert.equal(m.orig.exp_prod, '2026-11-01', 'older orig entries kept');
  assert.equal(m.changed.length, 1);
});

test('scImport merge reports no change when only last_update differs', () => {
  const m = Pg.bpoImportMerge(existing(), { po_no: 'PO-77', part_no: 'CHN-410', last_update: '2026-11-12' });
  assert.equal(m.ok, true);
  assert.deepEqual(m.diff, []);
});

test('scImport merge rejects bad dates', () => {
  const m = Pg.bpoImportMerge(existing(), { po_no: 'PO-77', ms: { rfq: '2026-13-45' } });
  assert.equal(m.ok, false);
  assert.ok(m.errors.ms_rfq);
});
