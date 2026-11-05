const test = require('node:test');
const assert = require('node:assert');
const M = require('../frontend/pricemail.js');

const me = { emailAddress: { name: 'Sakib Ahamed', address: 'Sahamed@camcomfginc.com' } };
const skye = { emailAddress: { name: 'Skye Ingraham', address: 'Skye.Ingraham@tmhna.com' } };
const rich = { emailAddress: { name: 'Rich Arnold', address: 'rarnold@camcomfginc.com' } };
const table = (rows, head) => '<table><tr>' + head.map((h) => '<td>' + h + '</td>').join('') + '</tr>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
const quoted = '<hr><div id="divRplyFwdMsg"><b>From:</b> Sakib Ahamed <b>Sent:</b> Wednesday</div>' + table([['838-007-056', '$3.24', '$99.99']], ['Part Number', 'Old Price', 'New Price']);
const msg = (id, date, subject, html, extra) => Object.assign({ id, subject, from: me, toRecipients: [skye], ccRecipients: [rich], sentDateTime: date + 'T15:00:00Z', conversationId: 'c-' + (extra && extra.conv || id), bodyPreview: '', body: { content: html } }, extra || {});

test('table with Old/New price and "will take effect on" date', () => {
  const p = M.parseMessage(msg('1', '2026-09-23', 'Pricing Update', '<p>The updated pricing will take effect on October 31, 2026.</p>' + table([['114-018-066', '$12.69', '$14.93', 'x'], ['828-006-728', '$9.17', '$10.08', 'x']], ['Part Number', 'Old Price', 'New Price', 'Notes'])));
  assert.deepStrictEqual(p.items.map((i) => [i.part_no, i.prev_price, i.new_price]), [['114-018-066', 12.69, 14.93], ['828-006-728', 9.17, 10.08]]);
  assert.strictEqual(p.effective, '2026-10-31');
});
test('quoted earlier messages are ignored', () => {
  const p = M.parseMessage(msg('2', '2026-10-06', 'RE: Pricing', '<p>Corrected effective date for both price increases is 11/16/2026, not 09/30/2026.</p>' + table([['838-007-056', '$3.24', '$6.43']], ['Part Number', 'Old Price', 'New Price']) + quoted));
  assert.strictEqual(p.items.length, 1);
  assert.strictEqual(p.items[0].new_price, 6.43);
  assert.strictEqual(p.effective, '2026-11-16');
});
test('revised-proposal table: current, previous proposed, revised proposed', () => {
  const p = M.parseMessage(msg('3', '2026-10-30', 'RE: Camco Price Changes', table([['838-007-056', 'BOSS', '3,207', '$3.24', '$6.43', '$3.63']], ['PN', 'Description', 'EAU', 'Current Unit Cost', 'Previous Proposed', 'Revised Proposed'])));
  assert.deepStrictEqual(p.items[0], { part_no: '838-007-056', prev_price: 3.24, new_price: 3.63, orig_new_price: 6.43 });
  assert.strictEqual(p.effective, null);
});
test('single-part sentence', () => {
  const p = M.parseMessage(msg('4', '2026-10-30', 'Price Update Request', '<p>we propose updating the price of 114-019-767 from $122.67 to $142.70 (+$20.03). The updated pricing would take effect on December 31, 2026.</p>'));
  assert.deepStrictEqual(p.items.map((i) => [i.part_no, i.prev_price, i.new_price]), [['114-019-767', 122.67, 142.7]]);
  assert.strictEqual(p.effective, '2026-12-31');
});
test('collect merges corrections, revisions and flags (not confirms) Skye replies', () => {
  const t = (rows) => table(rows, ['Part Number', 'Old Price', 'New Price']);
  const msgs = [
    msg('a', '2026-09-16', 'Pricing Update Notification - PART# 838-007-056', '<p>The updated pricing will take effect on September 30, 2026.</p>' + t([['838-007-056', '$3.24', '$6.43']])),
    msg('b', '2026-10-06', 'RE: Pricing Update Notification - PART# 838-007-056', '<p>The corrected effective date for both price increases is 11/16/2026.</p>' + t([['838-007-056', '$3.24', '$6.43']]) + quoted, { conv: 'a' }),
    { id: 'r', subject: 'RE: Camco Price Changes', from: skye, toRecipients: [me], sentDateTime: '2026-10-22T15:00:00Z', conversationId: 'c-a', bodyPreview: 'These need review', body: { content: '' } },
    msg('c', '2026-10-30', 'RE: x', table([['838-007-056', '$3.24', '$3.63']], ['PN', 'Current', 'Revised Proposed']), { conv: 'a' }),
    msg('d', '2026-10-30', 'ignored', t([['111-222-333', '$1.00', '$2.00']]), { toRecipients: [rich], ccRecipients: [] }),
    Object.assign(msg('e', '2026-10-31', 'ignored', t([['444-555-666', '$1.00', '$2.00']])), { from: skye })
  ];
  const r = M.collect(msgs);
  assert.strictEqual(r.items.length, 1);
  const it = r.items[0];
  assert.strictEqual(it.sent_date, '2026-09-16');
  assert.strictEqual(it.effective_date, '2026-11-16');
  assert.strictEqual(it.new_price, 3.63);
  assert.strictEqual(it.orig_new_price, 6.43);
  assert.strictEqual(it.revised_date, '2026-10-30');
  assert.strictEqual(it.last_reply_date, '2026-10-22');
  assert.strictEqual(it.history.length, 3);
});
