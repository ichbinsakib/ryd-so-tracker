const test = require('node:test');
const assert = require('node:assert/strict');
const Service = require('../backend/Service.js');
const { FakeSheet } = require('./fakeSheet.js');

const call = (sheet, token, body) => Service.handle(sheet, { idToken: token, ...body });

test('unauthenticated, unknown and viewer access is enforced by the backend', () => {
  const s = new FakeSheet();
  assert.equal(call(s, 'bad', { action: 'list' }).code, 'UNAUTHENTICATED');
  assert.equal(call(s, undefined, { action: 'list' }).code, 'UNAUTHENTICATED');
  const stranger = call(s, 'tok-stranger', { action: 'list' });
  assert.equal(stranger.code, 'FORBIDDEN');
  assert.equal(stranger.records, undefined, 'no data leaks to unauthorised users');
  assert.equal(call(s, 'tok-viewer', { action: 'findSO', so_no: '25712' }).ok, true);
  const v = call(s, 'tok-viewer', { action: 'update', id: 'id-1', baseVersion: 'x', changes: { notes: 'hack' } });
  assert.equal(v.code, 'FORBIDDEN');
  assert.equal(s.auditLog.length, 0);
});

test('list returns record rows with ids, versions and the field catalogue', () => {
  const s = new FakeSheet();
  const r = call(s, 'tok-admin', { action: 'list' });
  assert.equal(r.records.length, 3);
  assert.equal(r.writable, true);
  assert.ok(r.records[0].version);
  assert.equal(r.records[0].values.so_no, 25712);
  assert.equal(r.fields.length, 77);
});

test('editing saves, bumps version, and writes an audit entry', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'new note', status: '3.open', due_date: '2026-12-01' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.values.notes, 'new note');
  assert.equal(r.record.values.status, '3.OPEN');
  assert.notEqual(r.record.version, rec.version);
  assert.equal(s.auditLog.length, 3);
  assert.equal(s.auditAllCalls, 1, 'all audit lines are written in a single batch');
  assert.equal(s.auditLog[0].user, 'editor@example.com');
  assert.equal(s.rows[0].values[0], 'new note', 'persisted to the sheet');
});

test('stale version is rejected with CONFLICT and the sheet is untouched', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  assert.equal(call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'first' } }).ok, true);
  const second = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'second' } });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'CONFLICT');
  assert.equal(second.current.values.notes, 'first');
  assert.equal(s.rows[0].values[0], 'first');
});

test('calculated columns and formula cells cannot be overwritten', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-2' }).record;
  assert.deepEqual(rec.formulaLocked, ['total_price_quote']);
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-2', baseVersion: rec.version, changes: { total_price_quote: 1, so_release_status_bar: '99%', notes: 'ok' } });
  assert.equal(r.code, 'INVALID');
  assert.ok(r.fieldErrors.total_price_quote);
  assert.ok(r.fieldErrors.so_release_status_bar);
  assert.equal(s.rows[1].values[0], '', 'no partial write when any field is invalid');
});

test('invalid values are reported per field, nothing is written', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { due_date: '12/01/26', status: 'NOPE', so_qty: 'x' } });
  assert.equal(r.code, 'INVALID');
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['due_date', 'so_qty', 'status']);
  assert.equal(s.auditLog.length, 0);
});

test('unchanged legacy values are left alone (e.g. text "8-Oct" in a date column)', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-3' }).record;
  assert.equal(rec.values.po_receive_date, '8-Oct');
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-3', baseVersion: rec.version, changes: { po_receive_date: '8-Oct', notes: 'x' } });
  // po_receive_date is not a valid ISO date, but unchanged legacy text should not block other edits
  assert.equal(r.ok, false, 'sending an invalid date for a date field is rejected unless the client omits it');
  const r2 = call(s, 'tok-editor', { action: 'update', id: 'id-3', baseVersion: rec.version, changes: { notes: 'x' } });
  assert.equal(r2.ok, true);
  assert.equal(s.rows[2].values[Object.assign({}, require('../backend/Core.js').BY_KEY).po_receive_date.index], '8-Oct');
});

test('leading zeros in identifiers survive an edit', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-2' }).record;
  assert.equal(rec.values.part_no, '00123');
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-2', baseVersion: rec.version, changes: { po_no_1: '00456' } });
  assert.equal(r.ok, true);
  assert.equal(r.record.values.po_no_1, '00456');
});

test('concurrent save attempt while locked returns BUSY, not a silent overwrite', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  s.locked = true;
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'z' } });
  assert.equal(r.code, 'BUSY');
  assert.notEqual(s.rows[0].values[0], 'z');
});

test('without a RECORD ID column the app is read-only', () => {
  const s = new FakeSheet(undefined, { noIdColumn: true });
  const r = call(s, 'tok-admin', { action: 'list' });
  assert.equal(r.writable, false);
  const u = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: 'x', changes: { notes: 'z' } });
  assert.equal(u.code, 'NOT_FOUND');
});

test('unknown record and malformed requests', () => {
  const s = new FakeSheet();
  assert.equal(call(s, 'tok-editor', { action: 'update', id: 'nope', baseVersion: 'v', changes: { notes: 'x' } }).code, 'NOT_FOUND');
  assert.equal(call(s, 'tok-editor', { action: 'update', id: 'id-1' }).code, 'BAD_REQUEST');
  assert.equal(call(s, 'tok-editor', { action: 'drop' }).code, 'BAD_REQUEST');
  assert.equal(Service.handle(s, null).code, 'BAD_REQUEST');
});

test('clearing STATUS through the API is rejected and nothing is written', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-editor', { action: 'get', id: 'id-1' }).record;
  const r = call(s, 'tok-editor', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { status: '', notes: 'x' } });
  assert.equal(r.code, 'INVALID');
  assert.ok(r.fieldErrors.status);
  assert.equal(s.rows[0].values[1], '1. ANALYSIS');
  assert.equal(s.auditLog.length, 0);
});
