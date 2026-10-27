const test = require('node:test');
const assert = require('node:assert/strict');
const Sub = require('../backend/Subcon.js');

const V1 = 'v1', V2 = 'v2';
const base = (o) => Object.assign({ id: 'o' + Math.random(), sc_no: 'SC-1', part_no: 'P-100', vendor_id: V1, qty: 5, status: 'PO PLACED', po_date: '2026-10-01', promised_date: null, received_date: null }, o);
const run = (orders, leadTimes, today, steps) => Sub.build({ orders, vendors: [{ id: V1, name: 'Alpha', active: true }, { id: V2, name: 'Beta', active: true }], leadTimes: leadTimes || [], steps: steps || [] }, today || '2026-10-27');

test('dates: add and diff days', () => {
  assert.equal(Sub.addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(Sub.daysBetween('2026-10-01', '2026-10-27'), 26);
  assert.ok(!Sub.isDate('2026-13-40'));
});

test('order validation: required fields, dates, amounts, received needs a date', () => {
  const bad = Sub.cleanOrder({ qty: 0, status: 'RECEIVED', quote_amt: '-1', po_date: '2026-10-10', promised_date: '2026-10-01' });
  assert.ok(!bad.ok);
  ['sc_no', 'part_no', 'vendor_id', 'qty', 'quote_amt', 'promised_date', 'received_date'].forEach((k) => assert.ok(bad.errors[k], k));
  const good = Sub.cleanOrder({ sc_no: ' SC-9 ', part_no: 'P1', vendor_id: V1, qty: '3', po_amt: '12.5', steps: [{ name: 'Cut' }, { name: 'Plate', cost: '4' }] });
  assert.ok(good.ok, JSON.stringify(good.errors));
  assert.equal(good.value.sc_no, 'SC-9'); assert.equal(good.value.po_amt, 12.5);
  assert.deepEqual(good.value.steps.map((s) => s.seq), [1, 2]);
  assert.ok(!Sub.cleanOrder({ sc_no: 'a', part_no: 'b', vendor_id: V1, qty: 1, steps: [{ name: '' }] }).ok);
});

test('vendor and lead-time validation', () => {
  assert.ok(!Sub.cleanVendor({ name: '' }).ok);
  assert.ok(!Sub.cleanVendor({ name: 'X', email: 'nope' }).ok);
  assert.ok(Sub.cleanVendor({ name: 'X', email: 'a@b.co' }).ok);
  assert.ok(!Sub.cleanLead({ vendor_id: V1, std_days: 2.5 }).ok);
  assert.ok(Sub.cleanLead({ vendor_id: V1, std_days: 14, part_no: 'P' }).ok);
});

test('expected date: promise wins, then part standard, then vendor default, then history', () => {
  const lt = [{ vendor_id: V1, part_no: '', std_days: 30 }, { vendor_id: V1, part_no: 'p-100', std_days: 10 }];
  const d = run([base({ promised_date: '2026-11-05' }), base({}), base({ part_no: 'OTHER' }), base({ vendor_id: V2 })], lt).orders;
  assert.equal(d[0].expected, '2026-11-05'); assert.equal(d[0].basis, 'vendor promise');
  assert.equal(d[1].expected, '2026-10-11'); assert.equal(d[1].stdSource, 'part');
  assert.equal(d[2].expected, '2026-10-31'); assert.equal(d[2].stdSource, 'vendor');
  assert.equal(d[3].state, 'no-date');
  const h = run([base({ vendor_id: V2, status: 'RECEIVED', po_date: '2026-09-01', received_date: '2026-09-21' }), base({ vendor_id: V2, status: 'RECEIVED', po_date: '2026-09-01', received_date: '2026-09-11' }), base({ vendor_id: V2 })]).orders;
  assert.equal(h[2].expected, '2026-10-16'); assert.equal(h[2].basis, 'past average'); assert.deepEqual(h[2].hist, { n: 2, avg: 15, min: 10, max: 20 });
});

test('state: overdue, due soon, on track, received late, cancelled', () => {
  const t = '2026-10-27';
  const s = (o) => run([base(o)], [], t).orders[0];
  assert.equal(s({ promised_date: '2026-10-20' }).state, 'overdue'); assert.equal(s({ promised_date: '2026-10-20' }).lateDays, 7);
  assert.equal(s({ promised_date: '2026-11-02' }).state, 'due-soon');
  assert.equal(s({ promised_date: '2026-11-03' }).state, 'due-soon');
  assert.equal(s({ promised_date: '2026-11-04' }).state, 'on-track');
  assert.equal(s({ promised_date: '2026-10-20', status: 'RECEIVED', received_date: '2026-10-25' }).state, 'received-late');
  assert.equal(s({ promised_date: '2026-10-20', status: 'RECEIVED', received_date: '2026-10-19' }).state, 'received');
  assert.equal(s({ status: 'CANCELLED' }).state, 'cancelled');
  assert.equal(s({ status: 'QUOTING', po_date: null }).state, 'no-date');
});

test('scorecard and alerts', () => {
  const r = run([
    base({ status: 'RECEIVED', po_date: '2026-09-01', promised_date: '2026-09-20', received_date: '2026-09-18', invoice_amt: 100 }),
    base({ status: 'RECEIVED', po_date: '2026-09-01', promised_date: '2026-09-10', received_date: '2026-09-15', po_amt: 50 }),
    base({ promised_date: '2026-10-20' }), base({ promised_date: '2026-10-30', po_amt: 20 }), base({ vendor_id: V2, promised_date: '2026-12-30' })
  ]);
  const a = r.vendors.find((v) => v.id === V1);
  assert.equal(a.received, 2); assert.equal(a.onTimePct, 50); assert.equal(a.open, 2); assert.equal(a.overdue, 1); assert.equal(a.spend, 170);
  assert.equal(a.avgLead, 16);
  assert.deepEqual(r.alerts.map((o) => o.state), ['overdue', 'due-soon']);
  assert.equal(r.kpis.open, 3); assert.equal(r.kpis.overdue, 1); assert.equal(r.kpis.dueSoon, 1); assert.equal(r.kpis.openValue, 20);
});
