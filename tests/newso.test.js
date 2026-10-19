const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');
const Service = require('../backend/Service.js');
const { FakeSheet, makeRow } = require('./fakeSheet.js');

const call = (sheet, token, body) => Service.handle(sheet, { idToken: token, ...body });

const goodForm = () => ({
  so_no: '26001', part_no: 'P-100', customer: 'ACME', champion: 'ALPHA', so_qty: '250',
  due_date: '2026-12-01', so_type: 'standard', kanban_or_po: 'po', req_by: 'BRAVO', so_req_date: '2026-10-16', notes: 'rush'
});

test('non-admins cannot get the full list or the dashboard', () => {
  const s = new FakeSheet();
  for (const t of ['tok-editor', 'tok-viewer']) {
    assert.equal(call(s, t, { action: 'list' }).code, 'FORBIDDEN');
    assert.equal(call(s, t, { action: 'dashboard' }).code, 'FORBIDDEN');
  }
  assert.equal(call(s, 'tok-stranger', { action: 'findSO', so_no: '25712' }).code, 'FORBIDDEN');
});

test('dashboard: slim rows, closed hidden by default, lowest progress first', () => {
  const rows = [
    makeRow(3, 'a', { status: '3.OPEN', part_no: 'P1', so_no: 1, so_release_status_bar: '80%', mat_status_bar: '90%' }),
    makeRow(4, 'b', { status: '3.OPEN', part_no: 'P2', so_no: 2, so_release_status_bar: '20%', mat_status_bar: '100%' }),
    makeRow(5, 'c', { status: '4.CLOSE', part_no: 'P3', so_no: 3, so_release_status_bar: '100%', mat_status_bar: '100%' }),
    makeRow(6, 'd', { status: '5.HOLD', part_no: 'P4', so_no: 4, so_release_status_bar: '', mat_status_bar: '' })
  ];
  const s = new FakeSheet(rows);
  const d = call(s, 'tok-admin', { action: 'dashboard' });
  assert.equal(d.ok, true);
  assert.deepEqual(d.rows.map(r => r.so_no), ['2', '1', '4'], 'closed SO 3 hidden; unknown bars last');
  assert.deepEqual(Object.keys(d.rows[0]).sort(), ['customer', 'due', 'id', 'matBar', 'part_no', 'qty', 'quoteReceived', 'reqQuote', 'soBar', 'so_no', 'status']);
  assert.equal(d.rows[0].soBar, 20);
  assert.equal(d.rows[2].soBar, null);
  assert.equal(call(s, 'tok-admin', { action: 'dashboard', includeClosed: true }).rows.length, 4);
  assert.equal(d.stock.has, false);
  assert.equal(d.steel.meta, null);
});

test('dashboard shows when the stock sheet and STEEL USAGE were last updated', () => {
  const s = new FakeSheet();
  call(s, 'tok-admin', { action: 'uploadStock', fileName: 'stock.csv', rows: [{ part: 'A', price: 1 }] });
  call(s, 'tok-admin', { action: 'uploadSteelUsage', fileName: 'steel.csv', rows: [{ part: 'A', steel: 'S', qty: 1, router: "12'" }] });
  const d = call(s, 'tok-admin', { action: 'dashboard' });
  assert.equal(d.stock.meta.uploadedBy, 'admin@example.com');
  assert.equal(d.stock.meta.fileName, 'stock.csv');
  assert.equal(d.steel.meta.fileName, 'steel.csv');
  assert.equal(d.steel.meta.by, 'admin@example.com');
  assert.equal(d.steel.meta.at, '2026-10-16T12:00:00.000Z');
});

test('findSO: exact SO# only, any authorised role, no table leakage', () => {
  const s = new FakeSheet();
  const r = call(s, 'tok-viewer', { action: 'findSO', so_no: ' r24449 ' });
  assert.equal(r.ok, true);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].values.part_no, '00123');
  assert.equal(call(s, 'tok-editor', { action: 'findSO', so_no: '2571' }).code, 'NOT_FOUND', 'partial numbers do not match');
  assert.equal(call(s, 'tok-editor', { action: 'findSO', so_no: '' }).code, 'BAD_REQUEST');
});

test('planCreate: required fields, unknown fields, duplicate SO#', () => {
  assert.equal(Core.planCreate(goodForm(), []).ok, true);
  const bad = Core.planCreate({ so_no: '1' }, []);
  assert.equal(bad.ok, false);
  for (const k of Core.INTAKE_REQUIRED.filter(k => k !== 'so_no')) assert.ok(bad.fieldErrors[k], k + ' is required');
  assert.equal(bad.fieldErrors.notes, undefined, 'notes optional');
  assert.ok(Core.planCreate({ ...goodForm(), status: '4.CLOSE' }, []).fieldErrors.status, 'status cannot be chosen');
  assert.ok(Core.planCreate({ ...goodForm(), part_price: '1' }, []).fieldErrors.part_price, 'calculated fields refused');
  assert.ok(Core.planCreate(goodForm(), [' 26001 ']).fieldErrors.so_no, 'duplicate SO#');
  assert.ok(Core.planCreate({ ...goodForm(), due_date: '12/01/26' }, []).fieldErrors.due_date);
  assert.ok(Core.planCreate({ ...goodForm(), so_no: '=1+1' }, []).fieldErrors.so_no);
});

test('createSO writes into the first free row after the last record, sets status OPEN and a new ID', () => {
  const s = new FakeSheet();
  const r = call(s, 'tok-editor', { action: 'createSO', changes: goodForm() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.row, 6);
  assert.equal(r.record.id, 'new-id-1');
  assert.equal(r.record.values.status, '3.OPEN');
  assert.equal(r.record.values.so_type, 'STANDARD');
  assert.equal(r.record.values.kanban_or_po, 'PO');
  assert.equal(r.record.values.so_qty, 250);
  assert.equal(s.rows.find(x => x.rowNumber === 7).values[Core.BY_KEY.so_no.index], '', 'only one row was used');
  assert.equal(s.auditLog.at(-1).field, 'SO OPENED');
  // a second SO takes the next free row
  const r2 = call(s, 'tok-admin', { action: 'createSO', changes: { ...goodForm(), so_no: '26002' } });
  assert.equal(r2.record.row, 7);
  // and can be found by number straight away
  assert.equal(call(s, 'tok-viewer', { action: 'findSO', so_no: '26001' }).records[0].id, 'new-id-1');
});

test('createSO: viewers refused, duplicates and missing fields rejected with nothing written', () => {
  const s = new FakeSheet();
  assert.equal(call(s, 'tok-viewer', { action: 'createSO', changes: goodForm() }).code, 'FORBIDDEN');
  const dup = call(s, 'tok-editor', { action: 'createSO', changes: { ...goodForm(), so_no: '25712' } });
  assert.equal(dup.code, 'INVALID');
  assert.ok(dup.fieldErrors.so_no);
  const missing = call(s, 'tok-editor', { action: 'createSO', changes: { so_no: '777' } });
  assert.equal(missing.code, 'INVALID');
  assert.equal(s.auditLog.length, 0);
  assert.equal(s.rows.find(x => x.rowNumber === 6).values[Core.BY_KEY.so_no.index], '');
});

test('createSO fails clearly when no free row is left, and when RECORD ID is missing', () => {
  const full = new FakeSheet([makeRow(3, 'a', { status: '3.OPEN', part_no: 'P', so_no: 1 })]);
  assert.equal(call(full, 'tok-editor', { action: 'createSO', changes: goodForm() }).code, 'NO_FREE_ROW');
  const noId = new FakeSheet(undefined, { noIdColumn: true });
  assert.equal(call(noId, 'tok-editor', { action: 'createSO', changes: goodForm() }).code, 'NOT_READY');
});

const PDF_B64 = Buffer.from('%PDF-1.4 ' + 'x'.repeat(300)).toString('base64');

test('scan upload: type, size and base64 validation', () => {
  assert.equal(Core.validateScanUpload('a.pdf', 'application/pdf', PDF_B64).ok, true);
  assert.equal(Core.validateScanUpload('a.exe', 'application/x-msdownload', PDF_B64).ok, false);
  assert.equal(Core.validateScanUpload('a.pdf', 'application/pdf', 'not base64!!').ok, false);
  assert.equal(Core.validateScanUpload('a.pdf', 'application/pdf', 'QQ==').ok, false, 'too small');
  const big = Buffer.alloc(Core.MAX_SCAN_BYTES + 10, 1).toString('base64');
  assert.equal(Core.validateScanUpload('a.pdf', 'application/pdf', big).ok, false);
  assert.ok(!/[\/\\]/.test(Core.validateScanUpload('../../evil name.pdf', 'application/pdf', PDF_B64).name), 'no path characters');
  assert.equal(Core.validateScanUpload('photo.png', 'image/jpeg', PDF_B64).name, 'photo.jpg', 'extension follows the real type');
});

test('scans: editors upload, everyone authorised can list/download, files must belong to the SO', () => {
  const s = new FakeSheet();
  assert.equal(call(s, 'tok-viewer', { action: 'uploadScan', id: 'id-1', fileName: 'a.pdf', mime: 'application/pdf', data: PDF_B64 }).code, 'FORBIDDEN');
  const up = call(s, 'tok-editor', { action: 'uploadScan', id: 'id-1', fileName: 'signed.pdf', mime: 'application/pdf', data: PDF_B64 });
  assert.equal(up.ok, true);
  assert.equal(up.scans.length, 1);
  assert.equal(s.auditLog.at(-1).field, 'SCAN UPLOADED');
  assert.equal(call(s, 'tok-viewer', { action: 'listScans', id: 'id-1' }).scans[0].name, 'signed.pdf');
  const dl = call(s, 'tok-viewer', { action: 'downloadScan', id: 'id-1', fileId: up.scan.fileId });
  assert.equal(dl.ok, true);
  assert.equal(dl.data, PDF_B64);
  assert.equal(call(s, 'tok-viewer', { action: 'downloadScan', id: 'id-2', fileId: up.scan.fileId }).code, 'NOT_FOUND', 'cannot fetch a file through another SO');
  assert.equal(call(s, 'tok-editor', { action: 'uploadScan', id: 'nope', fileName: 'a.pdf', mime: 'application/pdf', data: PDF_B64 }).code, 'NOT_FOUND');
  assert.equal(call(s, 'tok-editor', { action: 'uploadScan', id: 'id-1', fileName: 'a.html', mime: 'text/html', data: PDF_B64 }).code, 'INVALID');
});

test('start: one call returns who-am-I and, for admins only, the dashboard', () => {
  const s = new FakeSheet();
  const a = call(s, 'tok-admin', { action: 'start' });
  assert.equal(a.role, 'admin');
  assert.ok(a.fields.length > 50 && a.intake);
  assert.ok(Array.isArray(a.dashboard.rows));
  const e = call(s, 'tok-editor', { action: 'start' });
  assert.equal(e.role, 'editor');
  assert.equal(e.dashboard, undefined, 'editors never receive dashboard data');
  assert.equal(call(s, 'tok-stranger', { action: 'start' }).code, 'FORBIDDEN');
});

test('dashboard is cached, fresh=true bypasses the cache, and any write clears it', () => {
  const s = new FakeSheet();
  const d1 = call(s, 'tok-admin', { action: 'dashboard' });
  assert.equal(d1.cached, undefined);
  const d2 = call(s, 'tok-admin', { action: 'dashboard' });
  assert.equal(d2.cached, true, 'second call is served from the cache');
  assert.equal(call(s, 'tok-admin', { action: 'dashboard', fresh: true }).cached, undefined);
  // a save clears it
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'x' } });
  assert.equal(call(s, 'tok-admin', { action: 'dashboard' }).cached, undefined, 'cache was cleared by the save');
  // creating an SO clears it too
  call(s, 'tok-admin', { action: 'dashboard' });
  call(s, 'tok-editor', { action: 'createSO', changes: goodForm() });
  assert.equal(call(s, 'tok-admin', { action: 'dashboard' }).cached, undefined);
  // the cache never lets a non-admin in
  assert.equal(call(s, 'tok-editor', { action: 'dashboard' }).code, 'FORBIDDEN');
});

test('SO# is optional when opening an SO; people list comes from active users', () => {
  assert.ok(!Core.INTAKE_REQUIRED.includes('so_no'));
  const f = goodForm(); delete f.so_no;
  const p = Core.planCreate(f, ['x']);
  assert.equal(p.ok, true);
  assert.ok(!p.writes.some(w => w.key === 'so_no'));
  const s = new FakeSheet(); s.users = [
    { email: 'b@x.com', name: 'Bravo', role: 'editor', active: true },
    { email: 'a@x.com', name: '', role: 'editor', active: true },
    { email: 'off@x.com', name: 'Gone', role: 'editor', active: false }
  ];
  assert.deepEqual(Core.intakeInfo(s.users).people, ['a', 'Bravo']);
  const r = call(s, 'tok-admin', { action: 'createSO', changes: f });
  assert.equal(r.ok, true);
  assert.ok(s.auditLog.some(e => /without SO#/.test(e.newValue)));
});
