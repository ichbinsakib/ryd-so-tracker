const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../backend/Core.js');
const Service = require('../backend/Service.js');
const { FakeSheet } = require('./fakeSheet.js');

const call = (sheet, token, body) => Service.handle(sheet, { idToken: token, ...body });
const withTokens = (extra) => ({
  'tok-admin': { email: 'admin@example.com' }, 'tok-editor': { email: 'editor@example.com' },
  'tok-viewer': { email: 'viewer@example.com' }, 'tok-stranger': { email: 'stranger@example.com' }, ...extra
});

test('roleFor combines bootstrap lists with active APP_USERS rows, highest role wins', () => {
  const users = [{ email: 'New.Person@x.com', role: 'editor', active: true }, { email: 'off@x.com', role: 'admin', active: false }, { email: 'both@x.com', role: 'viewer', active: true }];
  assert.equal(Core.roleFor('new.person@x.com', '', '', '', users), 'editor');
  assert.equal(Core.roleFor('off@x.com', '', '', '', users), null, 'disabled user has no access');
  assert.equal(Core.roleFor('both@x.com', 'both@x.com', '', '', users), 'editor', 'bootstrap editor outranks viewer row');
  assert.equal(Core.roleFor('boss@x.com', '', '', 'boss@x.com', []), 'admin');
  assert.equal(Core.roleFor('nobody@x.com', 'a@x.com', '', '', users), null);
});

test('validateUser: email, role, active and formula-safe text', () => {
  assert.deepEqual(Core.validateUser({ email: ' Jane@Corp.com ', name: 'Jane', employeeId: 'E-7', role: 'Editor', active: 'yes' }).user,
    { email: 'jane@corp.com', name: 'Jane', employeeId: 'E-7', role: 'editor', active: true });
  assert.equal(Core.validateUser({ email: 'jane@corp.com', role: 'viewer', active: false }).user.active, false);
  assert.equal(Core.validateUser({ email: 'not-an-email', role: 'viewer' }).ok, false);
  assert.equal(Core.validateUser({ email: 'a@b.co', role: 'superuser' }).ok, false);
  assert.equal(Core.validateUser({ email: 'a@b.co', name: '=EVIL()', role: 'viewer' }).ok, false);
  assert.equal(Core.validateUser({ email: 'a@b.co,c@d.co', role: 'viewer' }).ok, false);
  assert.equal(Core.validateUser({ email: 'a@b.co' }).user.role, 'viewer', 'default role is viewer');
});

test('only admins can list or change users', () => {
  const s = new FakeSheet();
  for (const t of ['tok-editor', 'tok-viewer', 'tok-stranger']) {
    assert.equal(call(s, t, { action: 'listUsers' }).code, 'FORBIDDEN');
    assert.equal(call(s, t, { action: 'saveUsers', users: [{ email: 'x@y.co', role: 'admin' }] }).code, 'FORBIDDEN');
    assert.equal(call(s, t, { action: 'deleteUser', email: 'x@y.co' }).code, 'FORBIDDEN');
  }
  assert.equal(s.users, undefined);
});

test('admin adds a user who can then sign in with the assigned role; disabling removes access', () => {
  const s = new FakeSheet(undefined, { tokens: withTokens({ 'tok-new': { email: 'emp@corp.com' } }) });
  assert.equal(call(s, 'tok-new', { action: 'whoami' }).code, 'FORBIDDEN', 'not registered yet');
  const r = call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'Emp@Corp.com', name: 'Emp One', employeeId: 'E1', role: 'viewer', active: true }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.users[0].addedBy, 'admin@example.com');
  assert.equal(call(s, 'tok-new', { action: 'whoami' }).role, 'viewer');
  // promote
  call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'emp@corp.com', role: 'editor', active: true }] });
  assert.equal(call(s, 'tok-new', { action: 'whoami' }).role, 'editor');
  assert.equal(s.users.length, 1, 'upsert, not duplicate');
  assert.equal(s.users[0].name, 'Emp One', 'unspecified fields are kept');
  // disable
  call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'emp@corp.com', role: 'editor', active: false }] });
  assert.equal(call(s, 'tok-new', { action: 'whoami' }).code, 'FORBIDDEN');
  assert.ok(s.auditLog.some(a => a.field === 'USERS CHANGED'));
});

test('bulk import validates every row and writes nothing if any row is bad', () => {
  const s = new FakeSheet();
  const bad = call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'ok@x.co', role: 'viewer' }, { email: 'broken', role: 'viewer' }] });
  assert.equal(bad.code, 'INVALID');
  assert.match(bad.error, /Row 2/);
  assert.equal(s.users, undefined);
  const good = call(s, 'tok-admin', { action: 'saveUsers', users: Array.from({ length: 200 }, (_, i) => ({ email: 'u' + i + '@x.co', role: 'viewer' })) });
  assert.equal(good.saved, 200);
  assert.equal(call(s, 'tok-admin', { action: 'saveUsers', users: Array.from({ length: 501 }, (_, i) => ({ email: 'v' + i + '@x.co' })) }).code, 'BAD_REQUEST');
});

test('an admin who is only an APP_USERS admin cannot demote, disable or delete themselves', () => {
  const s = new FakeSheet(undefined, { tokens: withTokens({ 'tok-ua': { email: 'userAdmin@corp.com' } }) });
  call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'useradmin@corp.com', role: 'admin', active: true }, { email: 'other@corp.com', role: 'admin', active: true }] });
  assert.equal(call(s, 'tok-ua', { action: 'whoami' }).role, 'admin');
  assert.equal(call(s, 'tok-ua', { action: 'saveUsers', users: [{ email: 'useradmin@corp.com', role: 'viewer', active: true }] }).code, 'INVALID');
  assert.equal(call(s, 'tok-ua', { action: 'saveUsers', users: [{ email: 'useradmin@corp.com', role: 'admin', active: false }] }).code, 'INVALID');
  assert.equal(call(s, 'tok-ua', { action: 'deleteUser', email: 'useradmin@corp.com' }).code, 'INVALID');
  assert.equal(call(s, 'tok-ua', { action: 'whoami' }).role, 'admin', 'still an admin');
  // but they can manage others
  assert.equal(call(s, 'tok-ua', { action: 'deleteUser', email: 'other@corp.com' }).ok, true);
});

test('bootstrap admins (Script Properties) are listed and can never be locked out by the table', () => {
  const s = new FakeSheet();
  const l = call(s, 'tok-admin', { action: 'listUsers' });
  assert.deepEqual(l.bootstrap.filter(b => b.role === 'admin').map(b => b.email), ['admin@example.com']);
  call(s, 'tok-admin', { action: 'saveUsers', users: [{ email: 'admin@example.com', role: 'viewer', active: false }] });
  assert.equal(call(s, 'tok-admin', { action: 'whoami' }).role, 'admin', 'property admin keeps access');
  assert.equal(call(s, 'tok-admin', { action: 'deleteUser', email: 'ghost@x.co' }).code, 'NOT_FOUND');
});
