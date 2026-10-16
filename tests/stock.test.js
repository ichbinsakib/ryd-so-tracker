const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');
const Service = require('../backend/Service.js');
const { FakeSheet } = require('./fakeSheet.js');

const call = (sheet, token, body) => Service.handle(sheet, { idToken: token, ...body });

test('parsePrice and normalizePart', () => {
  assert.equal(Core.parsePrice(' $ 11.79 '), 11.79);
  assert.equal(Core.parsePrice('1,416.50'), 1416.5);
  assert.equal(Core.parsePrice(3), 3);
  assert.equal(Core.parsePrice('-'), null);
  assert.equal(Core.parsePrice(''), null);
  assert.equal(Core.normalizePart('  ab-12  c '), 'AB-12 C');
});

test('priceCheck states', () => {
  const idx = Core.buildStockIndex([['838-004-428', 11.79], ['dup-1', 5], ['DUP-1', 6], ['X', 'bad']]);
  const rec = (part, price) => ({ values: { part_no: part }, display: { part_price: price } });
  assert.equal(Core.priceCheck(rec('838-004-428', ' $ 11.79 '), idx, true).state, 'ok');
  assert.equal(Core.priceCheck(rec('838-004-428', ' $ 11.80 '), idx, true).state, 'issue');
  assert.equal(Core.priceCheck(rec('nope', '$ 1'), idx, true).reason, 'Part not found in the stockroom sheet');
  assert.equal(Core.priceCheck(rec('838-004-428', '-'), idx, true).reason, 'No part price in the worksheet');
  assert.equal(Core.priceCheck(rec('dup-1', '$ 6.00'), idx, true).state, 'ok', 'matches any price listed for the part');
  assert.equal(Core.priceCheck(rec('838-004-428', '$ 11.79'), idx, false).state, 'none', 'nothing uploaded yet');
  assert.equal(Core.priceCheck(rec('', '$ 1'), idx, true).state, 'none');
  assert.equal(Core.priceCheck(rec('x', '$ 1'), idx, true).state, 'issue', 'row with non-numeric stock price is ignored');
});

test('validateStockUpload cleans, counts skipped and rejects junk', () => {
  const v = Core.validateStockUpload([{ part: 'A1', price: '$2.50' }, { part: '', price: 1 }, { part: 'B', price: 'x' }, { part: '=EVIL()', price: 1 }, { part: 77, price: 3 }]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows, [['A1', 2.5], ['77', 3]]);
  assert.equal(v.skipped, 3);
  assert.equal(Core.validateStockUpload([]).ok, false);
  assert.equal(Core.validateStockUpload([{ part: '', price: 'x' }]).ok, false);
  assert.equal(Core.validateStockUpload('nope').ok, false);
});

test('roles: admin outranks editor and can edit', () => {
  assert.equal(Core.roleFor('a@x.com', 'a@x.com', '', 'a@x.com'), 'admin');
  assert.equal(Core.roleFor('e@x.com', 'e@x.com', '', 'a@x.com'), 'editor');
});

test('only admins can upload; editors and viewers are refused and nothing is stored', () => {
  const s = new FakeSheet();
  const body = { action: 'uploadStock', rows: [{ part: '838-004-428', price: 11.79 }], fileName: 'stock.csv' };
  assert.equal(call(s, 'tok-editor', body).code, 'FORBIDDEN');
  assert.equal(call(s, 'tok-viewer', body).code, 'FORBIDDEN');
  assert.equal(call(s, 'tok-stranger', body).code, 'FORBIDDEN');
  assert.equal(s.stock.length, 0);
});

test('admin upload stores prices, audits it, and list shows tick/issue per record', () => {
  const s = new FakeSheet();
  assert.equal(call(s, 'tok-admin', { action: 'list' }).records[0].priceCheck.state, 'none');
  const up = call(s, 'tok-admin', { action: 'uploadStock', fileName: 'stock.csv', rows: [{ part: '838-004-428', price: '11.79' }, { part: '00123', price: 3 }, { part: 'bad', price: 'x' }] });
  assert.equal(up.ok, true);
  assert.equal(up.count, 2);
  assert.equal(up.skipped, 1);
  assert.equal(s.auditLog.at(-1).field, 'STOCKROOM UPLOAD');
  const l = call(s, 'tok-admin', { action: 'list' });
  assert.equal(l.stock.has, true);
  assert.equal(l.stock.count, 2);
  assert.equal(l.stock.meta.uploadedBy, 'admin@example.com');
  const by = Object.fromEntries(l.records.map(r => [r.values.part_no, r.priceCheck]));
  assert.equal(by['838-004-428'].state, 'ok');
  assert.equal(by['00123'].state, 'issue');           // 2.49 vs 3
  assert.equal(by['1078364'].state, 'issue');         // not in stockroom file
});

test('re-upload replaces the previous stockroom prices', () => {
  const s = new FakeSheet();
  call(s, 'tok-admin', { action: 'uploadStock', rows: [{ part: '838-004-428', price: 1 }] });
  call(s, 'tok-admin', { action: 'uploadStock', rows: [{ part: '838-004-428', price: 11.79 }] });
  assert.equal(s.stock.length, 1);
  assert.equal(call(s, 'tok-admin', { action: 'list' }).records[0].priceCheck.state, 'ok');
});

test('admins can still edit records; upload with an unusable file is rejected', () => {
  const s = new FakeSheet();
  const rec = call(s, 'tok-admin', { action: 'get', id: 'id-1' }).record;
  assert.equal(call(s, 'tok-admin', { action: 'update', id: 'id-1', baseVersion: rec.version, changes: { notes: 'admin edit' } }).ok, true);
  assert.equal(call(s, 'tok-admin', { action: 'uploadStock', rows: [{ part: '', price: 'x' }] }).code, 'INVALID');
});
