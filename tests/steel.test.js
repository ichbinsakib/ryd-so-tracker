const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');
const Service = require('../backend/Service.js');
const { FakeSheet, makeRow } = require('./fakeSheet.js');

const call = (sheet, token, body) => Service.handle(sheet, { idToken: token, ...body });
const rec = (disp) => ({ values: { part_no: 'P1' }, display: disp });

test('lookupChecks: present values tick, "-", blank, errors and zero qty are issues', () => {
  const ok = Core.lookupChecks(rec({ steel_type: '1.5 RD 1018', router_bar_size: "12' BAR", qty_per_bar: '40' }));
  assert.deepEqual(Object.values(ok).map(x => x.state), ['ok', 'ok', 'ok']);
  const bad = Core.lookupChecks(rec({ steel_type: '-', router_bar_size: '', qty_per_bar: '0' }));
  assert.deepEqual(Object.values(bad).map(x => x.state), ['issue', 'issue', 'issue']);
  assert.match(bad.steel_type.reason, /STEEL USAGE/);
  assert.equal(Core.lookupChecks(rec({ steel_type: '#N/A', router_bar_size: "12'", qty_per_bar: '5' })).steel_type.state, 'issue');
  assert.equal(Core.lookupChecks({ values: { part_no: '' }, display: {} }), null);
});

test('safeCellText blocks anything Sheets could run as a formula', () => {
  for (const bad of ['=SUM(A1)', '+1+1', '@x', '-1+2', '-abc']) assert.equal(Core.safeCellText(bad, 100), null, bad);
  assert.equal(Core.safeCellText('-', 100), '-');
  assert.equal(Core.safeCellText('-5', 100), '-5');
  assert.equal(Core.safeCellText(" 12' BAR ", 100), "12' BAR");
  assert.equal(Core.safeCellText('x'.repeat(60), 50), null);
});

test('validateSteelUpload cleans rows and counts skipped', () => {
  const v = Core.validateSteelUpload([
    { part: 'A1', steel: '1 RD 1018', qty: 40, router: "12'" },
    { part: '', steel: 'x', qty: 1, router: 'y' },
    { part: 'A2', steel: '=EVIL()', qty: 1, router: 'y' },
    { part: 'A3', steel: '', qty: '', router: '' }
  ]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows, [['A1', '1 RD 1018', '40', "12'"], ['A3', '', '', '']]);
  assert.equal(v.skipped, 2);
  assert.equal(Core.validateSteelUpload([]).ok, false);
});

test('only admins can replace STEEL USAGE; nothing changes otherwise', () => {
  const s = new FakeSheet();
  const body = { action: 'uploadSteelUsage', fileName: 's.csv', rows: [{ part: 'A', steel: 'S', qty: 1, router: "12'" }] };
  for (const t of ['tok-editor', 'tok-viewer', 'tok-stranger']) assert.equal(call(s, t, body).code, 'FORBIDDEN');
  assert.equal(s.steel, undefined);
  assert.equal(s.auditLog.length, 0);
});

test('admin replace: writes new rows, keeps previous, audits, rejects bad files', () => {
  const s = new FakeSheet();
  const first = call(s, 'tok-admin', { action: 'uploadSteelUsage', fileName: 'a.csv', rows: [{ part: 'A', steel: 'S1', qty: 1, router: "12'" }] });
  assert.equal(first.ok, true);
  assert.equal(first.previousRows, 0);
  const second = call(s, 'tok-admin', { action: 'uploadSteelUsage', fileName: 'b.csv', rows: [{ part: 'B', steel: 'S2', qty: 2, router: "20'" }, { part: 'C', steel: 'S3', qty: 3, router: "10'" }] });
  assert.equal(second.previousRows, 1);
  assert.deepEqual(s.steel.map(r => r[0]), ['B', 'C']);
  assert.deepEqual(s.steelPrevious.map(r => r[0]), ['A']);
  assert.equal(s.auditLog.at(-1).field, 'STEEL USAGE REPLACED');
  assert.equal(call(s, 'tok-admin', { action: 'uploadSteelUsage', rows: [{ part: '=X', steel: '', qty: '', router: '' }] }).code, 'INVALID');
  assert.deepEqual(s.steel.map(r => r[0]), ['B', 'C'], 'a rejected upload leaves the data untouched');
});

test('list attaches lookupChecks to records', () => {
  const rows = [makeRow(3, 'id-1', { status: '3.OPEN', part_no: 'P1', steel_type: '1 RD', router_bar_size: "12'", qty_per_bar: '40' }),
                makeRow(4, 'id-2', { status: '3.OPEN', part_no: 'P2', steel_type: '-', router_bar_size: '-', qty_per_bar: '-' })];
  const s = new FakeSheet(rows);
  const l = call(s, 'tok-admin', { action: 'list' });
  assert.equal(l.records[0].lookupChecks.steel_type.state, 'ok');
  assert.equal(l.records[1].lookupChecks.qty_per_bar.state, 'issue');
});
