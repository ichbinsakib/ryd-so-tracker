// SO Review: document readers, field checks and release decisions (no PDFs or network: text fixtures only).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../agent/so-docs.js');
const F = require('../agent/test/fixtures.js');

const files = (v, drop) => [['router', F.router], ['traveler', F.traveler], ['materialPo', F.materialPo], ['supplier', F.supplier], ['print', () => '']]
  .filter(([k]) => !(drop || []).includes(k)).map(([k, fn]) => ({ name: v.so + ' ' + k + '.pdf', kind: k, text: fn(v), readable: true }));
const rec = F.record(F.BASE);

test('classify: real CAMCO file names', () => {
  assert.equal(D.classify('25808 PART ROUTER.pdf').kind, 'router');
  assert.equal(D.classify('25877- PART TRAVELER.pdf').kind, 'traveler');
  assert.equal(D.classify('25808 PO.pdf').kind, 'materialPo');
  assert.equal(D.classify('25808 Sales_Acknowledgment.pdf').kind, 'supplier');
  assert.equal(D.classify('25877- Alro_Order.pdf').kind, 'supplier');
  assert.equal(D.classify('25865R REQ. FORM.pdf').kind, 'reqForm');
  assert.equal(D.classify('25865R - PART PRINT.pdf').kind, 'print');
  assert.ok(D.isSoFolder('25865R') && D.isSoFolder('R23666') && !D.isSoFolder('MRB PULL SO LIST') && !D.isSoFolder('7-4-2025'));
});

test('readers: router and traveler values', () => {
  const r = D.parseRouter(F.router(F.BASE)), t = D.parseTraveler(F.traveler(F.BASE));
  assert.equal(r.so, '90001'); assert.equal(r.part, 'TST-100-001'); assert.equal(r.steel, '1 RD 1045 CF'); assert.equal(r.partPrice, 21.6); assert.equal(r.materialCost, 1.73); assert.equal(r.pcsPerBar, 20);
  assert.equal(t.qty, 600); assert.equal(t.due, '2026-12-15'); assert.equal(t.description, 'PIN, TEST SHAFT'); assert.equal(t.materialCost, 1.73);
  assert.deepEqual(t.ops.map((o) => o.op), r.ops.map((o) => o.op));
});

test('all five documents matching the app: PASS', () => {
  const v = F.BASE, out = D.reviewSo(v.so, files(v), rec);
  assert.equal(out.result, 'PASS', JSON.stringify(out.discrepancies));
  assert.equal(out.docs_found, 5); assert.equal(out.docs_required, 5);
});

test('wrong material cost, steel type or due date: FAIL naming the field, app value and document value', () => {
  const cases = [[{ cost: '1.95' }, 'Material cost per piece'], [{ steel: '1 RD 1018 CF', grade: '1018' }, 'Steel type / grade'], [{ due: '01/15/2027' }, 'Due date']];
  for (const [chg, field] of cases) {
    const v = Object.assign({}, F.BASE, chg), out = D.reviewSo(v.so, files(v), rec);
    assert.equal(out.result, 'FAIL', field);
    const d = out.discrepancies.find((x) => x.field === field);
    assert.ok(d, field + ' flagged'); assert.ok(d.problem.includes('app has'), d.problem); assert.ok(d.fix);
  }
});

test('missing routing: MISSING DOCUMENT, never PASS', () => {
  const out = D.reviewSo('90001', files(F.BASE, ['router']), rec);
  assert.equal(out.result, 'MISSING DOCUMENT');
  assert.ok(out.missing.some((m) => /Routing/.test(m)));
  assert.equal(out.docs_found, 4);
});

test('no SO in the app: FAIL with an error', () => {
  const out = D.reviewSo('90001', files(F.BASE), null);
  assert.equal(out.result, 'FAIL'); assert.ok(out.errors.some((e) => /not found in the app/.test(e)));
});

test('release decision: only a clear reply from Charlotte/Jay counts; vague, hedged or "not yet" replies do not', () => {
  const ap = ['chamblin@camcomfginc.com', 'jgreen@camcomfginc.com'];
  const m = (body, from, when) => ({ subject: 'Re: RELEASE SO#25808 PART#310766-000', senderEmail: from || 'chamblin@camcomfginc.com', senderName: 'Charlotte Hamblin', received: when || '2026-11-21T10:00:00Z', body, ref: 'x' });
  assert.equal(D.decideRelease('25808', [m('Released.\n______________\nFrom: Kamrul')], ap).status, 'RELEASED');
  assert.equal(D.decideRelease('25808', [m('yes')], ap).status, 'POSSIBLE');
  assert.equal(D.decideRelease('25808', [m('They should be released already.')], ap).status, 'POSSIBLE');
  assert.equal(D.decideRelease('25808', [m('Not yet')], ap).status, 'NOT FOUND');
  const ch = D.decideRelease('25808', [m('Can you please combine op 035 and op 040 to op 030')], ap);
  assert.equal(ch.status, 'NOT FOUND'); assert.equal(ch.changesRequested, true);
  assert.equal(D.decideRelease('25808', [m('Released.', 'karmrul.hasan@camcomfginc.com')], ap).status, 'NOT FOUND', 'only approvers count');
  assert.equal(D.decideRelease('25809', [m('Released.')], ap).status, 'NOT FOUND', 'another SO thread does not count');
  // a later "not yet" overrides an earlier approval
  assert.equal(D.decideRelease('25808', [m('Approved.', null, '2026-11-20T10:00:00Z'), m('Not yet, the router changed', null, '2026-11-22T10:00:00Z')], ap).status, 'NOT FOUND');
});
