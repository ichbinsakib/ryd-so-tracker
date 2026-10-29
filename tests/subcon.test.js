const test = require('node:test');
const assert = require('node:assert/strict');
const Sub = require('../backend/Subcon.js');

let n = 0;
const line = (o) => Object.assign({ id: 'l' + (++n), bpo_no: '', batch: '', po_no: '', so_no: '', part_no: 'A', qty: 100, priority: 'NORMAL', sub_required: 'YES', so_required: 'YES', review_status: '', ms: {}, exp: {}, qty_hold: 0, qty_rejected: 0, qty_stocked: 0 }, o);
const T = '2026-10-27';
const d = (o, t) => Sub.describe(line(o), t || T);

test('validation: only part and quantity are required; decisions, review status and dates are checked', () => {
  const bad = Sub.cleanLine({ qty: 0, priority: 'x', blocker_type: 'nope', so_required: 'maybe', review_status: 'zzz', qty_stocked: -1, ms: { po_to_vendor: '2026-13-40' }, exp: { exp_ship: 'soon' } });
  assert.ok(!bad.ok);
  ['part_no', 'qty', 'priority', 'blocker_type', 'so_required', 'review_status', 'qty_stocked', 'ms_po_to_vendor', 'exp_exp_ship'].forEach((k) => assert.ok(bad.errors[k], k));
  const good = Sub.cleanLine({ part_no: 'A', qty: '50', required_date: '2026-12-01', team_member: ' Li ', ms: { rfq: '2026-10-01', bogus: '2026-10-02' }, exp: { exp_prod: '2026-11-10' } });
  assert.ok(good.ok, JSON.stringify(good.errors));
  assert.equal(good.value.team_member, 'Li'); assert.deepEqual(good.value.ms, { rfq: '2026-10-01' }); assert.deepEqual(good.value.exp, { exp_prod: '2026-11-10' });
  assert.equal(good.value.so_required, 'PENDING'); assert.equal(good.value.po_no, '');
});

test('closing needs the confirmed arrival at CAMCO and no hold', () => {
  const base = { part_no: 'A', qty: 10, closed: true };
  const r = Sub.cleanLine(base); assert.ok(!r.ok); assert.match(r.errors.closed, /arrived at CAMCO/);
  assert.ok(Sub.cleanLine(Object.assign({}, base, { ms: { received_camco: '2026-10-01' } })).ok);
  assert.ok(!Sub.cleanLine(Object.assign({}, base, { qty_hold: 2, ms: { received_camco: '2026-10-01' } })).ok);
});

test('stage follows the evidence: decision, part sent, quote, approval, SO, PO, vendor, production, delivery, arrived', () => {
  assert.equal(d({ sub_required: 'PENDING', so_required: 'PENDING' }).status, 'Awaiting decision');
  assert.equal(d({ sub_required: 'NO' }).status, 'Not required');
  assert.deepEqual([d({}).stageNo, d({}).owner_role], [2, 'me']);
  const q = d({ ms: { rfq: '2026-10-20' } }); assert.deepEqual([q.stageNo, q.status, q.owner_role], [3, 'Waiting for China quotation', 'team']);
  assert.equal(d({ ms: { rfq: '2026-10-01', quote_received: '2026-10-10' } }).status, 'Quotation with the team, not yet with Rich');
  assert.equal(d({ ms: { rfq: '2026-10-01', quote_received: '2026-10-10', quote_to_rich: '2026-10-12' } }).status, 'Waiting for review and approval');
  assert.equal(d({ review_status: 'CHANGES REQUESTED', ms: { rfq: '2026-10-01', quote_received: '2026-10-10', quote_to_rich: '2026-10-12' } }).status, 'Rich requested changes');
  const ap = { rfq: '2026-10-01', quote_received: '2026-10-10', quote_to_rich: '2026-10-12', quote_approved: '2026-10-15' };
  assert.deepEqual([d({ ms: ap }).stageNo, d({ ms: ap }).owner_role], [5, 'me']);
  const so = Object.assign({}, ap, { so_requested: '2026-10-16' });
  assert.equal(d({ ms: so }).status, 'SO request not yet with the costing manager');
  const w = d({ ms: Object.assign({}, so, { so_costing: '2026-10-17' }) }); assert.deepEqual([w.status, w.owner_role, w.waitingOn], ['Waiting for the SO number', 'costing', 'Costing manager']);
  const got = Object.assign({}, so, { so_costing: '2026-10-17', so_received: '2026-10-20' });
  assert.equal(d({ ms: got }).status, 'PO not started');
  assert.equal(d({ ms: Object.assign({}, got, { po_prep_start: '2026-10-21', po_created: '2026-10-22' }) }).status, 'PO ready, not yet sent for verification');
  const sent = Object.assign({}, got, { po_prep_start: '2026-10-21', po_created: '2026-10-22', po_sent_approval: '2026-10-23' });
  assert.equal(d({ ms: sent }).status, 'Waiting for PO verification');
  const ver = Object.assign({}, sent, { po_approved: '2026-10-24' }); assert.equal(d({ ms: ver }).status, 'PO verified, not yet sent to the vendor');
  const ven = Object.assign({}, ver, { po_to_vendor: '2026-10-25' }); assert.equal(d({ ms: ven }).status, 'Waiting for vendor acknowledgment');
  assert.equal(d({ ms: Object.assign({}, ven, { ack: '2026-10-26' }) }).status, 'Acknowledged, production not started');
  assert.equal(d({ ms: Object.assign({}, ven, { production_start: '2026-10-26' }) }).status, 'In production');
  assert.equal(d({ ms: Object.assign({}, ven, { production_start: '2026-10-26', ready_to_ship: '2026-10-27' }) }).status, 'Production done, awaiting shipment');
  const sh = d({ ms: Object.assign({}, ven, { production_start: '2026-10-26', ready_to_ship: '2026-10-27', vendor_ship: '2026-10-27' }) }); assert.deepEqual([sh.status, sh.stageNo], ['Shipped, awaiting arrival', 12]);
  const arr = d({ ms: Object.assign({}, ven, { received_camco: '2026-10-27' }) }); assert.ok(arr.complete); assert.equal(arr.stage, 'Arrived'); assert.equal(arr.progress, 100); assert.equal(arr.section, 'completed');
});

test('earlier stages are not reopened when later data exists (imported BPO lines)', () => {
  const l = d({ sub_required: 'PENDING', so_required: 'PENDING', so_no: '25001S', ms: { po_to_vendor: '2026-10-01', production_start: '2026-10-05' } });
  assert.equal(l.stageNo, 11); assert.equal(l.status, 'In production');
});

test('follow-up cadence: every 3 days, daily when urgent; the planned date wins', () => {
  const q = d({ ms: { rfq: '2026-10-20' } }); assert.equal(q.followup, '2026-10-23'); assert.ok(q.followupDue);
  assert.equal(d({ priority: 'HIGH', ms: { rfq: '2026-10-26' } }).followup, '2026-10-27');
  assert.equal(d({ ms: { rfq: '2026-10-26' } }).followup, '2026-10-29');
  assert.equal(d({ ms: { rfq: '2026-10-26' }, last_update: '2026-10-27' }).followup, '2026-10-30', 'counted from the last contact');
  assert.equal(d({ ms: { rfq: '2026-10-20' }, next_action_date: '2026-10-30' }).followup, '2026-10-30');
});

test('reasons and report sections: overdue follow-up, missed expected dates, delays, blockers, escalation', () => {
  const codes = (o) => d(o).reasons.map((r) => r.code);
  const o = d({ ms: { rfq: '2026-10-10' } }); assert.ok(o.reasons.some((r) => r.code === 'followup-overdue')); assert.equal(o.section, 'overdue'); assert.ok(codes({ ms: { rfq: '2026-10-10' } }).includes('quote-aging'));
  assert.equal(d({ ms: { rfq: '2026-10-26' } }).section, 'quote');
  assert.equal(d({}).section, 'immediate');
  const prod = { po_to_vendor: '2026-10-20', ack: '2026-10-21', production_start: '2026-10-22' };
  assert.equal(d({ ms: prod, last_update: '2026-10-26' }).section, 'production');
  assert.ok(codes({ ms: prod, exp: { exp_prod: '2026-10-25' }, last_update: '2026-10-26' }).includes('exp-missed-exp_prod'));
  assert.equal(d({ ms: Object.assign({}, prod, { ready_to_ship: '2026-10-25' }), last_update: '2026-10-26', exp: { exp_prod: '2026-10-25' } }).section, 'delivery');
  assert.ok(codes({ ms: { po_to_vendor: '2026-10-20' } }).includes('no-ack'));
  assert.ok(codes({ ms: { po_to_vendor: '2026-10-10', ack: '2026-10-11' } }).includes('not-started'));
  const b = d({ ms: prod, last_update: '2026-10-26', blocker: 'Drawing approval pending', blocker_type: 'Drawing approval' }); assert.equal(b.attention, 'warn');
  assert.equal(d({ ms: prod, last_update: '2026-10-26', qty_hold: 5 }).attention, 'crit');
  assert.equal(d({ ms: prod, last_update: '2026-10-26', escalated: true }).section, 'immediate');
  assert.equal(d({ closed: true, required_date: '2020-01-01' }).attention, 'ok');
});

test('timing against the required date, and the impact line', () => {
  const pd = d({ required_date: '2026-10-20', ms: { rfq: '2026-10-26' } });
  assert.equal(pd.pastDue, 7); assert.equal(pd.attention, 'crit'); assert.match(pd.impact, /7 days past the required date/);
  const fl = d({ required_date: '2026-11-10', exp: { exp_arrival: '2026-11-15' }, ms: { po_to_vendor: '2026-10-20', ack: '2026-10-21', production_start: '2026-10-22' }, last_update: '2026-10-26' });
  assert.equal(fl.forecastLate, 5); assert.equal(fl.expected, '2026-11-15'); assert.match(fl.impact, /5 days after the required date/);
  assert.equal(d({ required_date: '2026-10-20', ms: { received_camco: '2026-10-19' } }).pastDue, 0);
});

test('elapsed days between milestones: calendar days, only when both dates exist', () => {
  const sp = Sub.spansOf({ rfq: '2026-10-01', quote_received: '2026-10-08', quote_approved: '2026-10-12', received_camco: '2026-11-30' });
  const by = (k) => sp.find((s) => s.from === k.split('>')[0] && s.to === k.split('>')[1]).days;
  assert.equal(by('rfq>quote_received'), 7); assert.equal(by('quote_received>quote_approved'), 4); assert.equal(by('rfq>received_camco'), 60);
  assert.equal(by('quote_approved>so_requested'), null); assert.equal(sp.length, 10);
  assert.equal(Sub.spansOf({ rfq: '2026-10-10', quote_received: '2026-10-01' })[0].days, null, 'a negative span is not reported');
});

test('lead stats and projection', () => {
  const mk = (a, b, c) => line({ ms: { po_to_vendor: a, ready_to_ship: b, received_camco: c } });
  const lines = [mk('2026-06-01', '2026-07-01', '2026-07-31'), mk('2026-06-01', '2026-07-11', '2026-08-10'), mk('2026-06-01', '2026-06-21', '2026-07-21'), mk('2026-06-10', '2026-06-01', null)];
  const st = Sub.leadStats(lines), seg = (a, b) => st.find((s) => s.from === a && s.to === b);
  const s1 = seg('po_to_vendor', 'ready_to_ship'); assert.deepEqual([s1.n, s1.avg, s1.min, s1.max, s1.skipped], [3, 30, 20, 40, 1]);
  const s2 = seg('ready_to_ship', 'received_camco'); assert.deepEqual([s2.n, s2.avg], [3, 30]);
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01' } }), Sub.leadStats([])), null);
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01' } }), st), '2026-11-30');
  assert.equal(Sub.projectReceipt(line({ ms: { po_to_vendor: '2026-10-01', ready_to_ship: '2026-10-31' } }), st), '2026-11-30');
});

test('build: report sections, queue order, batches and KPIs', () => {
  const prod = { po_to_vendor: '2026-10-20', ack: '2026-10-21', production_start: '2026-10-22' };
  const r = Sub.build([
    line({ id: 'a', ms: { rfq: '2026-10-10' } }),                                                   // quote follow-up overdue
    line({ id: 'b' }),                                                                              // part not sent: mine
    line({ id: 'c', ms: { rfq: '2026-10-26' } }),                                                   // quote pending
    line({ id: 'd', ms: prod, last_update: '2026-10-26', bpo_no: 'BPO-1', batch: '1st' }),         // production
    line({ id: 'e', ms: { received_camco: '2026-10-20' } }),                                        // arrived recently
    line({ id: 'f', ms: { received_camco: '2026-08-01' } })                                         // arrived long ago
  ], T);
  assert.deepEqual(r.sections.overdue, ['a']); assert.deepEqual(r.sections.immediate, ['b']); assert.deepEqual(r.sections.quote, ['c']);
  assert.deepEqual(r.sections.production, ['d']); assert.deepEqual(r.sections.completed, ['e']);
  assert.deepEqual(r.queue, ['a', 'b']);
  assert.equal(r.kpis.open, 4); assert.equal(r.kpis.needsAction, 2); assert.equal(r.kpis.overdueFollowups, 1);
  assert.equal(r.batches.length, 2);
});
