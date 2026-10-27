const test = require('node:test');
const assert = require('node:assert/strict');
const Sub = require('../backend/Subcon.js');

let n = 0;
const line = (o) => Object.assign({ id: 'l' + (++n), bpo_no: 'BPO-1', batch: '1st Batch', po_no: 'P' + n, so_no: '25001S', part_no: 'A', qty: 100, priority: 'NORMAL', ms: {}, qty_hold: 0, qty_rejected: 0, qty_stocked: 0, blocker: '', blocker_type: '', escalated: false, closed: false, required_date: '2026-11-30', last_update: '2026-10-25' }, o);
const T = '2026-10-27';
const d = (o, t) => Sub.describe(line(o), t || T);

test('validation: required fields, quantities, dates, enums', () => {
  const bad = Sub.cleanLine({ qty: 0, priority: 'x', blocker_type: 'nope', qty_stocked: -1, ms: { po_to_vendor: '2026-13-40' } });
  assert.ok(!bad.ok);
  ['po_no', 'so_no', 'part_no', 'qty', 'priority', 'blocker_type', 'qty_stocked', 'ms_po_to_vendor'].forEach((k) => assert.ok(bad.errors[k], k));
  const good = Sub.cleanLine({ po_no: ' P1 ', so_no: 'S1', part_no: 'A', qty: '50', required_date: '2026-12-01', ms: { po_to_vendor: '2026-10-01', bogus: '2026-10-02' } });
  assert.ok(good.ok, JSON.stringify(good.errors));
  assert.equal(good.value.po_no, 'P1'); assert.deepEqual(good.value.ms, { po_to_vendor: '2026-10-01' });
  assert.ok(!Sub.cleanLine({ po_no: 'P', so_no: 'S', part_no: 'A', qty: 10, qty_stocked: 8, qty_rejected: 3 }).ok);
});

test('closing needs receipt, stock move, no open quantity and no hold', () => {
  const base = { po_no: 'P', so_no: 'S', part_no: 'A', qty: 10, closed: true };
  const r = Sub.cleanLine(base); assert.ok(!r.ok); assert.match(r.errors.closed, /received at CAMCO/); assert.match(r.errors.closed, /10 pcs not yet stocked/);
  const ok = Sub.cleanLine(Object.assign({}, base, { qty_stocked: 9, qty_rejected: 1, ms: { received_camco: '2026-10-01', to_stock: '2026-10-05' } }));
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.ok(!Sub.cleanLine(Object.assign({}, base, { qty_stocked: 9, qty_rejected: 1, qty_hold: 2, ms: { received_camco: '2026-10-01', to_stock: '2026-10-05' } })).ok);
});

test('progress and stage: skipped milestones count once a later one is done', () => {
  assert.equal(d({}).progress, 0);
  assert.equal(d({ ms: { po_received: '2026-10-01' } }).stage, 'PO not yet with vendor');
  const p = d({ ms: { po_to_vendor: '2026-10-01', production_start: '2026-10-05' } });
  assert.equal(p.progress, 33); assert.equal(p.stage, 'In production');
  const t = d({ ms: { vendor_ship: '2026-10-10', arrived_port: '2026-10-20' } });
  assert.equal(t.progress, 78); assert.equal(t.stage, 'At port / inbound');
  const all = d({ qty: 10, qty_stocked: 10, ms: { received_camco: '2026-10-20', to_stock: '2026-10-22' } });
  assert.equal(all.progress, 100); assert.equal(all.stage, 'Completed'); assert.ok(all.complete);
});

test('timing: past due, forecast late, expected date priority', () => {
  const pd = d({ required_date: '2026-10-20' });
  assert.equal(pd.pastDue, 7); assert.equal(pd.attention, 'crit'); assert.match(pd.action, /revised date/);
  const fl = d({ required_date: '2026-11-10', ms: { eta_camco: '2026-11-15' } });
  assert.equal(fl.forecastLate, 5); assert.equal(fl.expected, '2026-11-15'); assert.equal(fl.attention, 'warn');
  assert.equal(d({ required_date: '2026-11-10', ms: { eta_camco: '2026-11-15' }, priority: 'LINE DOWN' }).attention, 'crit');
  assert.equal(d({ required_date: '2026-11-10', revised_date: '2026-11-12' }).expected, '2026-11-12');
  assert.equal(d({ required_date: '2026-10-20', ms: { received_camco: '2026-10-19' } }).pastDue, 0);
});

test('reasons: no ack, not started, stale update, blocker, hold, overdue follow-up, escalation', () => {
  const codes = (o) => d(o).reasons.map((r) => r.code);
  assert.ok(codes({ ms: { po_to_vendor: '2026-10-20' } }).includes('no-ack'));
  assert.ok(!codes({ ms: { po_to_vendor: '2026-10-20', ack: '2026-10-21' } }).includes('no-ack'));
  assert.ok(codes({ ms: { po_to_vendor: '2026-10-10', ack: '2026-10-11' } }).includes('not-started'));
  assert.ok(!codes({ ms: { po_to_vendor: '2026-10-10', production_start: '2026-10-12' } }).includes('not-started'));
  assert.ok(codes({ last_update: '2026-10-10' }).includes('stale')); assert.ok(codes({ last_update: null }).includes('stale'));
  assert.ok(!codes({}).includes('stale'));
  const b = d({ blocker: 'Waiting for drawing approval', blocker_type: 'Drawing approval' }); assert.equal(b.attention, 'warn'); assert.match(b.action, /drawing approval/);
  assert.equal(d({ qty_hold: 5 }).attention, 'crit');
  assert.ok(codes({ next_action_date: '2026-10-26', next_action: 'Call' }).includes('action-overdue'));
  assert.equal(d({ escalated: true }).attention, 'crit');
  assert.equal(d({}).attention, 'ok');
  assert.equal(d({ closed: true, required_date: '2020-01-01' }).attention, 'ok');
});

test('lead stats and projection', () => {
  const mk = (a, b, c) => line({ ms: { po_to_vendor: a, ready_to_ship: b, port_departure: c } });
  const lines = [mk('2026-06-01', '2026-07-01', '2026-07-10'), mk('2026-06-01', '2026-07-11', '2026-07-21'), mk('2026-06-01', '2026-06-21', '2026-06-30'), mk('2026-06-10', '2026-06-01', null)];
  const st = Sub.leadStats(lines);
  assert.deepEqual([st[0].n, st[0].avg, st[0].min, st[0].max, st[0].skipped], [3, 30, 20, 40, 1]);
  assert.equal(st[1].n, 3); assert.equal(st[1].avg, 9);
  assert.equal(st[2].n, 0);
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01' } }), st), null);   // arrival spans have no history yet
  const full = [1, 2, 3].map((i) => line({ ms: { po_to_vendor: '2026-01-01', ready_to_ship: '2026-01-11', port_departure: '2026-01-21', arrived_port: '2026-02-20', received_camco: '2026-03-02' } }));
  const st2 = Sub.leadStats(full);
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01' } }), st2), '2026-11-30');
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01', port_departure: '2026-10-20' } }), st2), '2026-11-29');
});

test('build: queue order, batches and KPIs', () => {
  const r = Sub.build([
    line({ id: 'a', required_date: '2026-10-20' }),
    line({ id: 'b', required_date: '2026-11-30', priority: 'LINE DOWN', blocker: 'x' }),
    line({ id: 'c', required_date: '2026-11-30' }),
    line({ id: 'd', batch: '2nd Batch', closed: true, qty: 5, qty_stocked: 5, ms: { received_camco: '2026-10-01', to_stock: '2026-10-02' } })
  ], T);
  assert.deepEqual(r.queue, ['b', 'a']);
  assert.equal(r.kpis.open, 3); assert.equal(r.kpis.needsAction, 2); assert.equal(r.kpis.pastDue, 1); assert.equal(r.kpis.blocked, 1);
  assert.equal(r.batches.length, 2); assert.equal(r.batches[0].lines, 3); assert.equal(r.batches[0].crit, 2);
  assert.equal(r.batches[1].progress, 100);
});
