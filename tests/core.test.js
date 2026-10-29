const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');

test('column letters map to the inspected sheet layout', () => {
  assert.equal(Core.colToIndex('A'), 0);
  assert.equal(Core.colToIndex('Z'), 25);
  assert.equal(Core.colToIndex('AA'), 26);
  assert.equal(Core.colToIndex('BY'), 76);
  const expect = { so_no: 'K', part_no: 'G', status: 'B', due_date: 'J', so_close_date: 'BY', invoice_no: 'BO' };
  for (const [k, c] of Object.entries(expect)) assert.equal(Core.BY_KEY[k].col, c);
  assert.equal(Core.FIELDS.length, 97);
  assert.equal(new Set(Core.FIELDS.map(f => f.key)).size, 97, 'keys unique');
  assert.equal(new Set(Core.FIELDS.map(f => f.index)).size, 97, 'indexes unique');
});

test('formula columns are read-only', () => {
  for (const k of ['so_release_status_bar', 'part_price', 'steel_type', 'req_lbs', 'email_template', 'diff', 'gap', 'quote_vs_po_price', 'diff_po_invoice', 'diff_updated_po_invoice']) {
    assert.equal(Core.BY_KEY[k].calc, true, k);
    assert.equal(Core.validateValue(Core.BY_KEY[k], 'x').ok, false);
  }
  assert.equal(Core.BY_KEY.notes.calc, false);
});

test('enum validation uses the sheet dropdown values, case-insensitive, canonicalised', () => {
  const f = Core.BY_KEY.status;
  assert.deepEqual(Core.validateValue(f, '3.open'), { ok: true, value: '3.OPEN' });
  assert.equal(Core.validateValue(f, 'DONE').ok, false);
  assert.deepEqual(Core.validateValue(Core.BY_KEY.kanban_or_po, 'po'), { ok: true, value: 'PO' });
  assert.equal(Core.validateValue(Core.BY_KEY.bar_type, 'RD-AL').ok, true);
});

test('number and currency parsing', () => {
  const f = Core.BY_KEY.total_price_quote;
  assert.deepEqual(Core.validateValue(f, '$1,416.50'), { ok: true, value: 1416.5 });
  assert.deepEqual(Core.validateValue(f, '-398'), { ok: true, value: -398 });
  assert.equal(Core.validateValue(f, 'abc').ok, false);
  assert.equal(Core.validateValue(Core.BY_KEY.so_qty, '12.5.1').ok, false);
});

test('date validation', () => {
  const f = Core.BY_KEY.due_date;
  assert.equal(Core.validateValue(f, '2026-02-28').ok, true);
  assert.equal(Core.validateValue(f, '2026-02-30').ok, false);
  assert.equal(Core.validateValue(f, '10/12/26').ok, false);
  assert.equal(Core.validateValue(f, '1999-01-01').ok, false);
});

test('blank clears; text cannot start with = (formula injection)', () => {
  assert.deepEqual(Core.validateValue(Core.BY_KEY.notes, '   '), { ok: true, value: '' });
  assert.equal(Core.validateValue(Core.BY_KEY.notes, '=HYPERLINK("x")').ok, false);
  assert.equal(Core.validateValue(Core.BY_KEY.so_no, '=1+1').ok, false);
});

test('identifiers keep leading zeros (validated as text, not coerced)', () => {
  assert.deepEqual(Core.validateValue(Core.BY_KEY.part_no, '00123'), { ok: true, value: '00123' });
});

test('access roles', () => {
  assert.equal(Core.roleFor('A@X.com', 'a@x.com, b@x.com', ''), 'editor');
  assert.equal(Core.roleFor('v@x.com', 'a@x.com', 'v@x.com'), 'viewer');
  assert.equal(Core.roleFor('z@x.com', 'a@x.com', 'v@x.com'), null);
  assert.equal(Core.roleFor('', 'a@x.com', ''), null);
});

test('token info checks', () => {
  const now = 1000;
  const good = { aud: 'cid', iss: 'https://accounts.google.com', exp: '2000', email_verified: 'true', email: 'A@X.com' };
  assert.deepEqual(Core.checkTokenInfo(good, 'cid', now), { ok: true, email: 'a@x.com' });
  assert.equal(Core.checkTokenInfo({ ...good, aud: 'other' }, 'cid', now).ok, false);
  assert.equal(Core.checkTokenInfo({ ...good, exp: '900' }, 'cid', now).ok, false);
  assert.equal(Core.checkTokenInfo({ ...good, email_verified: 'false' }, 'cid', now).ok, false);
  assert.equal(Core.checkTokenInfo({ ...good, iss: 'evil.com' }, 'cid', now).ok, false);
  assert.equal(Core.checkTokenInfo(good, '', now).ok, false);
});

test('record version changes when any editable value changes, not when calc values change', () => {
  const { makeRow } = require('./fakeSheet.js');
  const a = Core.buildRecord(makeRow(3, 'x', { notes: 'a', so_release_status_bar: '10%' }), 77);
  const b = Core.buildRecord(makeRow(3, 'x', { notes: 'a', so_release_status_bar: '20%' }), 77);
  const c = Core.buildRecord(makeRow(3, 'x', { notes: 'b' }), 77);
  assert.equal(a.version, b.version);
  assert.notEqual(a.version, c.version);
});

test('STATUS is required: cannot be cleared, but other fields can', () => {
  const r = Core.validateValue(Core.BY_KEY.status, '  ');
  assert.equal(r.ok, false);
  assert.match(r.error, /required/);
  assert.equal(Core.validateValue(Core.BY_KEY.notes, '').ok, true);
  assert.equal(Core.publicFields().find(f => f.key === 'status').required, true);
});
