const test = require('node:test');
const assert = require('node:assert');
const R = require('../backend/Reminders.js');

const H = 3600000, now = Date.UTC(2026, 10, 4, 12, 0, 0);
const hoursAgo = (h) => new Date(now - h * H).toISOString();
const row = (status, sinceH, sent, lastH, extra) => ({ id: 'x' + Math.random(), data: Object.assign({ status, part_no: 'P1', customer: 'RAYMOND', so_qty: 10 }, extra), status_since: hoursAgo(sinceH), remind_count: sent, last_remind_at: lastH === null ? null : hoursAgo(lastH) });

test('nothing before 24 hours in the status', () => {
  assert.strictEqual(R.due([row('1.ANR', 23.9, 0, null)], now).length, 0);
});

test('first email at 24 hours, for ANR, RFS and Analysis alike', () => {
  const d = R.due([row('1.ANR', 24, 0, null), row('2.RFS', 30, 0, null), row('1. ANALYSIS', 100, 0, null)], now);
  assert.deepStrictEqual(d.map((x) => x.status), ['1.ANR', '2.RFS', '1. ANALYSIS']);
  assert.ok(d.every((x) => x.number === 1));
});

test('second email 10 hours after the first, not before', () => {
  assert.strictEqual(R.due([row('2.RFS', 40, 1, 9.9)], now).length, 0);
  const d = R.due([row('2.RFS', 40, 1, 10)], now);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].number, 2);
});

test('third email 10 hours after the second, then it stops', () => {
  const d = R.due([row('1.ANR', 60, 2, 10)], now);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].number, 3);
  assert.strictEqual(R.due([row('1.ANR', 200, 3, 50)], now).length, 0);
});

test('other statuses are never reminded', () => {
  assert.strictEqual(R.due([row('3.OPEN', 500, 0, null), row('4.CLOSE', 500, 0, null), row('5.HOLD', 500, 0, null)], now).length, 0);
});

test('a row without a usable timestamp is skipped', () => {
  assert.strictEqual(R.due([{ id: 'a', data: { status: '1.ANR' }, status_since: null, remind_count: 0 }, { id: 'b', data: { status: '1.ANR' }, status_since: hoursAgo(50), remind_count: 1, last_remind_at: null }], now).length, 0);
});

test('digest email groups by status and escapes text', () => {
  const items = R.due([row('1.ANR', 30, 0, null, { so_no: '25788', customer: 'A<B' }), row('2.RFS', 90, 2, 10)], now);
  const m = R.buildEmail(items, 'https://so.amanasystem.com');
  assert.match(m.subject, /1 ANR, 1 RFS/); assert.match(m.subject, /1 final reminder/);
  assert.match(m.text, /SO 25788/); assert.match(m.html, /A&lt;B/); assert.ok(!/A<B/.test(m.html));
  assert.match(m.text, /reminder 3 of 3/);
});
