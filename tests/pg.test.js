const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');
const Calc = require('../backend/Calc.js');
const Service = require('../backend/Service.js');
const Pg = require('../backend/PgAdapter.js');

const D = (o) => o;
const ctx = (stock, steel) => ({ stockByPart: (k) => stock[k] || null, steelByPart: (k) => steel[k] || null });

test('calc: status bars count typed cells plus formula cells like COUNTA does', () => {
  // only a part number: G typed (1) + 14 formula cells in G..BI = 15 of 55
  const one = Calc.calcOne('so_release_status_bar', D({ part_no: 'P1' }), ctx({}, {}));
  assert.equal(one.display, '27%');
  assert.equal(Calc.calcOne('so_release_status_bar', D({}), ctx({}, {})).display, '', 'blank part -> blank');
  // material bar: 2 formula cells of 11 even with nothing typed
  assert.equal(Calc.calcOne('mat_status_bar', D({ part_no: 'P1' }), ctx({}, {})).display, '18%');
  assert.equal(Calc.calcOne('mat_status_bar', D({ part_no: 'P1', po_due_date: '2026-11-01', invoice_no: 'I1' }), ctx({}, {})).display, '36%');
});

test('calc: lookups, bars, feet and pounds', () => {
  const steel = { P1: { steelType: '4140', qtyPerBar: '10', routerBarSize: "12' x 1.5" } };
  const stock = { P1: { quantity: 5, unitPrice: 11.79 }, 'M1': { quantity: 120, unitPrice: null } };
  const row = D({ part_no: 'P1', so_qty: 25, bar_type: 'RD', material_code: '1.5 X 12' });
  const c = ctx(stock, steel);
  assert.equal(Calc.calcOne('steel_type', row, c).display, '4140');
  assert.equal(Calc.calcOne('router_bar_size', row, c).display, "12' x 1.5");
  assert.equal(Calc.calcOne('qty_per_bar', row, c).display, '10');
  assert.equal(Calc.calcOne('part_price', row, c).display, ' $ 11.79 ');
  assert.equal(Calc.calcOne('req_bar', row, c).value, 2.5);
  assert.equal(Calc.calcOne('req_ft', row, c).value, 30);
  // RD: pi*(1.5/2)^2*(30*12)*0.283 = 180.05 -> 180
  assert.equal(Calc.calcOne('req_lbs', row, c).value, 180);
  assert.equal(Calc.calcOne('avail_ft', D({ material_code: 'M1' }), c).display, '120');
  assert.equal(Calc.calcOne('avail_ft', D({ material_code: 'zz' }), c).display, '-');
  // unknown part: dashes
  assert.equal(Calc.calcOne('steel_type', D({ part_no: 'NOPE' }), c).display, '-');
  assert.equal(Calc.calcOne('req_bar', D({ part_no: 'NOPE', so_qty: 5 }), c).display, '-');
  assert.equal(Calc.calcOne('req_ft', D({ part_no: 'NOPE', so_qty: 5 }), c).display, '0');
  // bad material code on a round bar -> #VALUE! like the sheet
  assert.equal(Calc.calcOne('req_lbs', D({ part_no: 'P1', so_qty: 25, bar_type: 'RD', material_code: 'nospace' }), c).display, '#VALUE!');
  assert.equal(Calc.calcOne('req_lbs', D({ part_no: 'P1', so_qty: 25, bar_type: '' }), c).value, 0);
});

test('calc: money and date differences', () => {
  const c = ctx({}, { P1: { steelType: 'S', qtyPerBar: '10', routerBarSize: "12' x 1" } });
  assert.equal(Calc.calcOne('quote_price_piece', D({ total_price_quote: 400, so_qty: 8 }), c).display, '$ 50.00');
  assert.equal(Calc.calcOne('quote_price_piece', D({ total_price_quote: 400 }), c).display, '-');
  assert.equal(Calc.calcOne('diff', D({ total_price_quote: 400, so_qty: 8, traveller_mat_price_piece: 60 }), c).display, '$ 10.00');
  assert.equal(Calc.calcOne('gap', D({ so_req_date: '2026-10-01', appr_date: '2026-10-04' }), c).value, 3);
  assert.equal(Calc.calcOne('gap', D({ so_req_date: '2026-10-01' }), c).display, '');
  assert.equal(Calc.calcOne('quote_vs_po_price', D({ price_on_po: 10, total_price_quote: 4 }), c).display, '$ 6.00');
  assert.equal(Calc.calcOne('diff_po_invoice', D({ price_on_invoice: 10, price_on_po: 4 }), c).display, '$ 6.00');
  assert.equal(Calc.calcOne('diff_updated_po_invoice', D({ updated_po_price: 'text', price_on_invoice: 1 }), c).display, '#VALUE!');
  assert.equal(Calc.calcOne('router_vs_po', D({ part_no: 'P1', po_mention_bar_size: '14' }), ctx({}, { P1: { steelType: 'S', qtyPerBar: '1', routerBarSize: "12' x 1" } })).value, 2);
});

function make(extra) {
  let n = 0;
  const base = {
    email: 'admin@example.com', config: { admins: 'admin@example.com', editors: 'ed@example.com' },
    users: [{ email: 'bob@example.com', name: 'Bob', role: 'editor', active: true }],
    rows: [
      { rowNumber: 1, id: 'id-1', data: { status: '3.OPEN', part_no: 'P1', customer: 'ACME', so_no: '100', so_qty: 25, due_date: '2026-12-01' } },
      { rowNumber: 2, id: 'id-2', data: { status: '4.CLOSE', part_no: 'P2', so_no: '101' } }
    ],
    stock: { rows: [['P1', 11.79]], count: 1, meta: { uploadedAt: 'x', uploadedBy: 'y', fileName: 'f' } },
    stockItems: { P1: { quantity: 5, unitPrice: 11.79 } },
    steel: { P1: { steelType: '4140', qtyPerBar: '10', routerBarSize: "12' x 1.5" } },
    newId: () => 'new-' + (++n)
  };
  return Pg.create(Object.assign(base, extra || {}));
}
const call = (p, body) => Service.handle(p.adapter, Object.assign({ idToken: 't' }, body));

test('service on the database adapter: dashboard, get, update', () => {
  const p = make();
  const d = call(p, { action: 'dashboard' });
  assert.equal(d.ok, true);
  assert.deepEqual(d.rows.map((r) => r.so_no), ['100'], 'closed hidden');
  assert.equal(d.rows[0].soBar, 33);   // part, qty, due, SO# typed (4) + 14 formula cells = 18 of 55
  assert.equal(d.rows[0].matBar, 18);
  assert.equal(d.stock.count, 1);

  const g = call(p, { action: 'get', id: 'id-1' });
  assert.equal(g.record.display.steel_type, '4140');
  assert.equal(g.record.priceCheck.state, 'ok');
  assert.equal(g.record.lookupChecks.qty_per_bar.state, 'ok');

  const u = call(p, { action: 'update', id: 'id-1', baseVersion: g.record.version, changes: { customer: 'GLOBEX', notes: 'hi' } });
  assert.equal(u.ok, true);
  assert.equal(u.record.values.customer, 'GLOBEX');
  const upd = p.ops.filter((o) => o.type === 'update')[0];
  assert.deepEqual(upd.patch, { customer: 'GLOBEX', notes: 'hi' });
  assert.equal(p.ops.filter((o) => o.type === 'audit').length, 2);
  // stale version is refused
  assert.equal(call(p, { action: 'update', id: 'id-1', baseVersion: g.record.version, changes: { customer: 'X' } }).code, 'CONFLICT');
});

test('service on the database adapter: create inserts, duplicate SO# refused, people enforced', () => {
  const p = make({ rows: [{ rowNumber: 1, id: 'id-1', data: { part_no: 'P1', so_no: '100' } }] });
  const form = { part_no: 'P9', customer: 'ACME', champion: 'Bob', so_qty: '5', due_date: '2026-12-01', so_type: 'standard', kanban_or_po: 'po', req_by: 'bob', so_req_date: '2026-10-16' };
  assert.equal(call(p, { action: 'createSO', changes: { ...form, so_no: '100' } }).code, 'INVALID');
  assert.equal(call(p, { action: 'createSO', changes: { ...form, champion: 'Nobody' } }).code, 'INVALID');
  const r = call(p, { action: 'createSO', changes: form });
  assert.equal(r.ok, true);
  assert.equal(r.record.values.status, '3.OPEN');
  assert.equal(r.record.values.req_by, 'Bob');
  const ins = p.ops.filter((o) => o.type === 'insert');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].data.part_no, 'P9');
  assert.equal(ins[0].id, r.record.id);
  assert.equal(p.ops.filter((o) => o.type === 'audit')[0].entry.row, null);
});

test('service on the database adapter: delete, closed SO protected, scans, uploads', () => {
  const p = make();
  assert.equal(call(p, { action: 'deleteSO', id: 'id-2' }).code, 'CLOSED');
  assert.equal(call(p, { action: 'deleteSO', id: 'id-1' }).ok, true);
  assert.deepEqual(p.ops.filter((o) => o.type === 'delete').map((o) => o.id), ['id-1']);
  assert.equal(call(p, { action: 'get', id: 'id-1' }).code, 'NOT_FOUND');

  const q = make();
  const pdf = Buffer.from('%PDF-1.4 ' + 'x'.repeat(200)).toString('base64');
  const s = call(q, { action: 'uploadScan', id: 'id-1', fileName: 'a.pdf', mime: 'application/pdf', data: pdf });
  assert.equal(s.ok, true);
  assert.equal(s.scans.length, 1);
  assert.equal(q.ops.filter((o) => o.type === 'scan').length, 1);

  const st = call(q, { action: 'uploadStock', rows: [{ part: 'P1', price: '1.5' }], fileName: 'f.csv' });
  assert.equal(st.ok, true);
  assert.equal(q.ops.filter((o) => o.type === 'stock')[0].rows.length, 1);
  const sl = call(q, { action: 'uploadSteelUsage', rows: [{ part: 'P1', steel: 'S', qty: '10', router: "12'" }], fileName: 's.csv' });
  assert.equal(sl.ok, true);
  assert.ok(q.ops.some((o) => o.type === 'steel') && q.ops.some((o) => o.type === 'steelMeta'));
});

test('service on the database adapter: roles and users', () => {
  const p = make({ email: 'stranger@example.com' });
  assert.equal(call(p, { action: 'dashboard' }).code, 'FORBIDDEN');
  const bob = make({ email: 'bob@example.com' });
  assert.equal(call(bob, { action: 'dashboard' }).code, 'FORBIDDEN', 'editor cannot see the dashboard');
  assert.equal(call(bob, { action: 'findSO', so_no: '100' }).ok, true);
  const admin = make();
  const r = call(admin, { action: 'saveUsers', users: [{ email: 'new@example.com', name: 'New', role: 'editor' }] });
  assert.equal(r.ok, true);
  assert.ok(admin.ops.some((o) => o.type === 'users' && o.list.length === 2));
});

test('mySOs: any role gets the dashboard rows of the snapshot (already scoped to the person); new SOs record who opened them', () => {
  const bob = make({ email: 'bob@example.com' });
  const r = call(bob, { action: 'mySOs' });
  assert.equal(r.ok, true);
  assert.equal(r.mine, true);
  assert.equal(r.role, 'editor');
  assert.deepEqual(r.rows.map((x) => x.so_no), ['100']);
  assert.equal(r.stock.has, true);
  const form = { part_no: 'P9', customer: 'ACME', champion: 'Bob', so_qty: '5', due_date: '2026-12-01', so_type: 'standard', kanban_or_po: 'po', req_by: 'Bob', so_req_date: '2026-10-16' };
  const c = call(bob, { action: 'createSO', changes: form });
  assert.equal(c.ok, true);
  assert.equal(bob.ops.filter((o) => o.type === 'insert')[0].createdBy, 'bob@example.com');
  // the sheet backend is not scoped, so it refuses
  const FakeSheet = require('./fakeSheet.js').FakeSheet;
  assert.equal(Service.handle(new FakeSheet(), { idToken: 'tok-editor', action: 'mySOs' }).code, 'NOT_SUPPORTED');
});

test('setPassword: admin only, minimum length, user must exist, nothing plain is audited', () => {
  const ed = make({ email: 'bob@example.com' });
  assert.equal(call(ed, { action: 'setPassword', email: 'bob@example.com', password: 'longenough1' }).code, 'FORBIDDEN');
  const p = make();
  assert.equal(call(p, { action: 'setPassword', email: 'bob@example.com', password: 'short' }).code, 'INVALID');
  assert.equal(call(p, { action: 'setPassword', email: 'nobody@example.com', password: 'longenough1' }).code, 'NOT_FOUND');
  const ok = call(p, { action: 'setPassword', email: 'Bob@Example.com', password: 'longenough1' });
  assert.equal(ok.ok, true);
  const op = p.ops.filter((o) => o.type === 'setPassword')[0];
  assert.deepEqual([op.email, op.password], ['bob@example.com', 'longenough1']);
  const audit = p.ops.filter((o) => o.type === 'audit')[0].entry;
  assert.equal(audit.field, 'PASSWORD SET');
  assert.ok(!JSON.stringify(audit).includes('longenough1'));
});

test('dashboard rows carry the stage and the material numbers', () => {
  const p = make({ rows: [
    { rowNumber: 1, id: 'id-1', data: { status: '3.OPEN', part_no: 'P1', so_no: '100', so_qty: 25, due_date: '2026-12-01', bar_type: 'RD' } },
    { rowNumber: 2, id: 'id-3', data: { status: '3.OPEN', part_no: 'P1', so_no: '102', so_qty: 5, due_date: '2026-12-01', req_mat_quote: 'NO', po_approve_date: '2026-10-01' } },
    { rowNumber: 3, id: 'id-4', data: { status: '3.OPEN', part_no: 'NOPE', so_no: '103', so_qty: 5, due_date: '2026-12-01' } }
  ] });
  const d = call(p, { action: 'dashboard' });
  const by = (so) => d.rows.find((r) => r.so_no === so);
  assert.equal(by('100').stage, 'Quote');
  assert.equal(by('100').steelType, '4140'); assert.equal(by('100').barType, 'RD'); assert.equal(by('100').barSize, "12' x 1.5"); assert.equal(by('100').qtyPerBar, 10);
  assert.equal(by('100').reqBar, 2.5);
  assert.equal(by('102').stage, 'Release');
  assert.equal(by('103').stage, 'Material'); assert.equal(by('103').reqBar, null);
  assert.equal(by('100').matReceived, false);
});
