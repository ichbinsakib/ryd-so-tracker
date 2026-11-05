const test = require('node:test');
const assert = require('node:assert');
const P = require('../frontend/priceupdates.js');
const seed = require('../dev/price-updates-seed.json');

const base = { prev_price: 10, new_price: 11, sent_date: '2026-10-01', effective_date: '2026-12-01', reply: 'none' };
const TODAY = '2026-11-05';

test('percentage and days remaining are calculated', () => {
  const d = P.describe(base, TODAY);
  assert.ok(Math.abs(d.pct - 10) < 1e-9);
  assert.strictEqual(d.days, 26);
  assert.strictEqual(d.status, 'Pending Confirmation');
});
test('sent email is never treated as confirmation', () => {
  assert.notStrictEqual(P.describe(base, TODAY).status, 'Confirmed');
  assert.strictEqual(P.describe(Object.assign({}, base, { reply: 'confirmed' }), TODAY).status, 'Confirmed');
});
test('effective soon, overdue and boundaries', () => {
  assert.strictEqual(P.describe(Object.assign({}, base, { effective_date: '2026-11-19' }), TODAY).status, 'Effective Soon');
  assert.strictEqual(P.describe(Object.assign({}, base, { effective_date: '2026-11-20' }), TODAY).status, 'Pending Confirmation');
  assert.strictEqual(P.describe(Object.assign({}, base, { effective_date: '2026-11-05' }), TODAY).days, 0);
  assert.strictEqual(P.describe(Object.assign({}, base, { effective_date: '2026-11-04' }), TODAY).status, 'Overdue');
});
test('confirmed but past effective date needs implementation proof', () => {
  const r = Object.assign({}, base, { reply: 'confirmed', effective_date: '2026-11-01' });
  assert.strictEqual(P.describe(r, TODAY).status, 'Overdue');
  assert.strictEqual(P.describe(Object.assign({}, r, { implemented: true }), TODAY).status, 'Confirmed');
});
test('missing information is flagged, not invented', () => {
  const d = P.describe({ prev_price: 3, new_price: 4, reply: 'none' }, TODAY);
  assert.strictEqual(d.status, 'Needs Attention');
  assert.deepStrictEqual(d.missing, ['date sent to Skye', 'effective date']);
  assert.strictEqual(d.days, null);
});
test('disputed and declined replies need attention', () => {
  assert.strictEqual(P.describe(Object.assign({}, base, { reply: 'disputed' }), TODAY).status, 'Needs Attention');
  assert.strictEqual(P.describe(Object.assign({}, base, { reply: 'declined' }), TODAY).status, 'Needs Attention');
});
test('seed data from the mailbox gives the expected picture on 11/5/2026', () => {
  const by = {}; seed.forEach((r) => { by[r.part_no] = P.describe(r, TODAY); });
  assert.strictEqual(by['136-000-433'].status, 'Effective Soon');
  assert.strictEqual(by['838-007-056'].status, 'Needs Attention');
  assert.strictEqual(by['1305846'].status, 'Overdue');
  assert.strictEqual(by['114-019-767'].days, 56);
  assert.ok(Math.abs(by['114-019-767'].pct - 16.3) < 0.05);
  const s = P.summarize(seed, TODAY);
  assert.deepStrictEqual(s, { total: 10, awaiting: 9, soon7: 0, overdue: 3, attention: 6 });
});
