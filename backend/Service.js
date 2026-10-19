/**
 * Request handling and access control. Talks to the sheet only through an `adapter`
 * so it can be tested without Google (see tests/ and dev/).
 *
 * adapter = {
 *   verifyToken(idToken) -> {ok, email, error},
 *   config() -> {editors: 'a@x.com,b@y.com', viewers: '...'},
 *   readAll() -> {idIndex, rows:[{rowNumber, values, display, formulas}]},
 *   readRow(rowNumber) -> same row shape,
 *   writeCells(rowNumber, [{index, value}]),
 *   audit(entry),
 *   withLock(fn) -> fn() result, or throws {code:'BUSY'}
 *   now() -> ISO string
 * }
 */
var SOService = (function () {
  // Resolved lazily so file load order in Apps Script does not matter.
  var Core = {};
  function bindCore() {
    var c = (typeof SOCore !== 'undefined') ? SOCore : require('./Core.js');
    for (var k in c) Core[k] = c[k];
  }

  function fail(code, error, extra) {
    var r = { ok: false, code: code, error: error };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  function readStockInfo(adapter) {
    var s = adapter.readStock ? adapter.readStock() : { rows: [], meta: null };
    return { index: Core.buildStockIndex(s.rows), has: s.rows.length > 0, count: s.rows.length, meta: s.meta || null };
  }

  function withCheck(rec, stock) {
    rec.priceCheck = Core.priceCheck(rec, stock.index, stock.has);
    rec.lookupChecks = Core.lookupChecks(rec);
    return rec;
  }

  function loadRecords(adapter, stock) {
    var data = adapter.readAll();
    var records = [];
    data.rows.forEach(function (row) {
      if (!Core.isRecordRow(row)) return;
      records.push(withCheck(Core.buildRecord(row, data.idIndex), stock));
    });
    return { records: records, idIndex: data.idIndex };
  }

  function handle(adapter, req) {
    bindCore();
    try {
      if (!req || typeof req !== 'object') return fail('BAD_REQUEST', 'Malformed request.');
      var auth = adapter.verifyToken(req.idToken);
      if (!auth || !auth.ok) return fail('UNAUTHENTICATED', (auth && auth.error) || 'Please sign in.');
      var cfg = adapter.config();
      var users = adapter.readUsers ? adapter.readUsers() : [];
      var role = Core.roleFor(auth.email, cfg.editors, cfg.viewers, cfg.admins, users);
      if (!role) return fail('FORBIDDEN', 'Your Google account (' + auth.email + ') is not authorised for this application.');

      switch (req.action) {
        case 'whoami':
          return { ok: true, email: auth.email, role: role, fields: Core.publicFields(), intake: Core.intakeInfo(users) };

        case 'start': {
          // One round trip at sign-in: who am I + (for admins) the dashboard.
          var base = { ok: true, email: auth.email, role: role, fields: Core.publicFields(), intake: Core.intakeInfo(users) };
          if (role === 'admin') base.dashboard = dashboard(adapter, auth.email, {});
          return base;
        }

        case 'list': {
          // The full table is admin-only; everyone else works one SO at a time.
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can see the full list.');
          var stock = readStockInfo(adapter);
          var l = loadRecords(adapter, stock);
          return {
            ok: true, role: role, email: auth.email, fields: Core.publicFields(),
            writable: l.idIndex >= 0, refreshedAt: adapter.now(), records: l.records,
            stock: { has: stock.has, count: stock.count, meta: stock.meta }
          };
        }

        case 'listUsers':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can manage users.');
          return listUsers(adapter, cfg, users);

        case 'saveUsers':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can manage users.');
          return saveUsers(adapter, auth.email, cfg, req);

        case 'deleteUser':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can manage users.');
          return deleteUser(adapter, auth.email, cfg, req);

        case 'dashboard':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can see the dashboard.');
          return dashboard(adapter, auth.email, req);

        case 'findSO':
          return findSO(adapter, req);

        case 'createSO':
          if (role === 'viewer') return fail('FORBIDDEN', 'You have read-only access.');
          return createSO(adapter, auth.email, req);

        case 'uploadScan':
          if (role === 'viewer') return fail('FORBIDDEN', 'You have read-only access.');
          return uploadScan(adapter, auth.email, req);

        case 'listScans':
          return listScans(adapter, req);

        case 'downloadScan':
          return downloadScan(adapter, req);

        case 'get': {
          var row = findById(adapter, req.id);
          if (!row) return fail('NOT_FOUND', 'Record not found.');
          return { ok: true, record: withCheck(Core.buildRecord(row.row, row.idIndex), readStockInfo(adapter)), refreshedAt: adapter.now() };
        }

        case 'update':
          if (role === 'viewer') return fail('FORBIDDEN', 'You have read-only access.');
          return update(adapter, auth.email, req);

        case 'uploadStock':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can upload the stockroom sheet.');
          return uploadStock(adapter, auth.email, req);

        case 'uploadSteelUsage':
          if (role !== 'admin') return fail('FORBIDDEN', 'Only admins can upload STEEL USAGE data.');
          return uploadSteelUsage(adapter, auth.email, req);

        default:
          return fail('BAD_REQUEST', 'Unknown action.');
      }
    } catch (e) {
      if (e && e.code === 'BUSY') return fail('BUSY', 'The sheet is busy with another save. Please try again in a few seconds.');
      return fail('SERVER_ERROR', 'Unexpected server error: ' + (e && e.message ? e.message : e));
    }
  }

  // Light-weight lookups read only the few columns they need (reading the whole sheet takes ~10 s),
  // then the single matching row is read in full.
  function findById(adapter, id) {
    if (!id) return null;
    var idIndex = adapter.getIdIndex();
    if (idIndex < 0) return null;
    var rows = adapter.readColumns([idIndex], false);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].values[idIndex]) === String(id)) return { row: adapter.readRow(rows[i].rowNumber), idIndex: idIndex };
    }
    return null;
  }

  function update(adapter, email, req) {
    if (!req.id || !req.baseVersion || !req.changes || typeof req.changes !== 'object') {
      return fail('BAD_REQUEST', 'Missing id, baseVersion or changes.');
    }
    return adapter.withLock(function () {
      var found = findById(adapter, req.id);
      if (!found) return fail('NOT_FOUND', 'Record not found. Reload the list.');
      var current = Core.buildRecord(found.row, found.idIndex);
      var plan = Core.planUpdate(current, req.baseVersion, req.changes);
      if (!plan.ok) {
        var extra = {};
        if (plan.current) extra.current = plan.current;
        if (plan.fieldErrors) extra.fieldErrors = plan.fieldErrors;
        return fail(plan.code, plan.error, extra);
      }
      adapter.writeCells(found.row.rowNumber, plan.writes.map(function (w) {
        return { index: w.field.index, value: w.value, type: w.field.type };
      }));
      clearDashCache(adapter);
      var after = adapter.readRow(found.row.rowNumber);
      var updated = withCheck(Core.buildRecord(after, found.idIndex), readStockInfo(adapter));
      var stamp = adapter.now();
      auditMany(adapter, plan.writes.map(function (w) {
        return { at: stamp, user: email, recordId: req.id, row: found.row.rowNumber, field: w.field.label + ' (' + w.field.col + ')', oldValue: String(w.old), newValue: String(w.value) };
      }));
      return { ok: true, record: updated, changed: plan.writes.map(function (w) { return w.key; }), refreshedAt: adapter.now() };
    });
  }

  function bootstrapList(cfg) {
    var out = [];
    Core.parseEmailList(cfg.admins).forEach(function (e) { out.push({ email: e, role: 'admin' }); });
    Core.parseEmailList(cfg.editors).forEach(function (e) { out.push({ email: e, role: 'editor' }); });
    Core.parseEmailList(cfg.viewers).forEach(function (e) { out.push({ email: e, role: 'viewer' }); });
    return out;
  }

  function listUsers(adapter, cfg, users) {
    return { ok: true, users: users, bootstrap: bootstrapList(cfg) };
  }

  // An admin who is not also a bootstrap (Script Properties) admin must not be able to lock themselves out.
  function isBootstrapAdmin(cfg, email) { return Core.parseEmailList(cfg.admins).indexOf(String(email).toLowerCase()) >= 0; }

  function saveUsers(adapter, actor, cfg, req) {
    var list = req.users;
    if (!Array.isArray(list) || !list.length) return fail('BAD_REQUEST', 'No users to save.');
    if (list.length > 500) return fail('BAD_REQUEST', 'Too many users in one request (limit 500).');
    var clean = [], errors = [];
    list.forEach(function (u, i) {
      var r = Core.validateUser(u);
      if (r.ok) clean.push(r.user); else errors.push('Row ' + (i + 1) + ': ' + r.error);
    });
    if (errors.length) return fail('INVALID', errors.slice(0, 5).join(' '), { errors: errors.slice(0, 20) });
    var me = String(actor).toLowerCase();
    var self = clean.filter(function (u) { return u.email === me; })[0];
    if (self && (self.role !== 'admin' || !self.active) && !isBootstrapAdmin(cfg, actor)) {
      return fail('INVALID', 'You cannot remove your own admin access or disable yourself. Ask another admin.');
    }
    return adapter.withLock(function () {
      var existing = adapter.readUsers();
      var merged = Core.mergeUsers(existing, clean);
      if (merged.length > Core.MAX_USERS) return fail('INVALID', 'Too many users (limit ' + Core.MAX_USERS + ').');
      var stamp = adapter.now();
      merged.forEach(function (u) {
        if (clean.some(function (c) { return c.email === String(u.email).toLowerCase(); })) { u.addedBy = u.addedBy || actor; u.addedAt = u.addedAt || stamp; u.updatedBy = actor; u.updatedAt = stamp; }
      });
      adapter.writeUsers(merged);
      adapter.audit({ at: stamp, user: actor, recordId: '', row: '', field: 'USERS CHANGED', oldValue: '', newValue: clean.length + ' user(s): ' + clean.slice(0, 5).map(function (u) { return u.email + '=' + (u.active ? u.role : 'disabled'); }).join(', ') + (clean.length > 5 ? ', ...' : '') });
      return { ok: true, saved: clean.length, users: merged, bootstrap: bootstrapList(cfg) };
    });
  }

  function deleteUser(adapter, actor, cfg, req) {
    var email = String(req.email || '').trim().toLowerCase();
    if (!email) return fail('BAD_REQUEST', 'Missing email.');
    if (email === String(actor).toLowerCase() && !isBootstrapAdmin(cfg, actor)) return fail('INVALID', 'You cannot delete yourself. Ask another admin.');
    return adapter.withLock(function () {
      var existing = adapter.readUsers();
      var rest = existing.filter(function (u) { return String(u.email).toLowerCase() !== email; });
      if (rest.length === existing.length) return fail('NOT_FOUND', 'User not found.');
      adapter.writeUsers(rest);
      adapter.audit({ at: adapter.now(), user: actor, recordId: '', row: '', field: 'USER DELETED', oldValue: email, newValue: '' });
      return { ok: true, users: rest, bootstrap: bootstrapList(cfg) };
    });
  }

  // One sheet write for all audit lines (each separate append costs a round trip to Google).
  function auditMany(adapter, entries) {
    if (!entries.length) return;
    if (adapter.auditAll) adapter.auditAll(entries); else entries.forEach(function (e) { adapter.audit(e); });
  }

  function readSteelMeta(adapter) { return adapter.readSteelMeta ? adapter.readSteelMeta() : null; }

  function span(a, b) { var o = []; for (var i = Math.min(a, b); i <= Math.max(a, b); i++) o.push(i); return o; }

  function blank(v) { return String(v === undefined || v === null ? '' : v).trim() === ''; }

  var DASH_TTL = 60; // seconds
  function dashKey(req) { return req.includeClosed ? 'dash1' : 'dash0'; }
  function clearDashCache(adapter) { if (adapter.cacheClear) adapter.cacheClear(['dash0', 'dash1']); }

  function dashboard(adapter, email, req) {
    var key = dashKey(req);
    if (!req.fresh && adapter.cacheGet) {
      var hit = adapter.cacheGet(key);
      if (hit) { hit.cached = true; hit.email = email; return hit; }
    }
    var out = buildDashboard(adapter, email, req);
    if (adapter.cachePut) adapter.cachePut(key, out, DASH_TTL);
    return out;
  }

  function buildDashboard(adapter, email, req) {
    var K = Core.BY_KEY;
    var idIndex = adapter.getIdIndex();
    var stock = readStockInfo(adapter);
    // B..AC in one contiguous read (status, bars, customer, part, qty, due date, SO#, quote flags)
    var idxs = span(K.status.index, K.quote_received.index);
    if (idIndex >= 0) idxs.push(idIndex);
    var rows = [];
    adapter.readColumns(idxs, true).forEach(function (r) {
      var v = r.values;
      if (blank(v[K.part_no.index]) && blank(v[K.so_no.index])) return;
      var status = String(v[K.status.index] || '').trim();
      if (!req.includeClosed && status === '4.CLOSE') return;
      rows.push({
        id: idIndex >= 0 ? v[idIndex] || null : null, so_no: v[K.so_no.index], part_no: v[K.part_no.index], customer: v[K.customer.index],
        status: status, soBar: Core.pctNum(v[K.so_release_status_bar.index]), matBar: Core.pctNum(v[K.mat_status_bar.index]),
        due: v[K.due_date.index], qty: v[K.so_qty.index], reqQuote: v[K.req_mat_quote.index], quoteReceived: v[K.quote_received.index]
      });
    });
    // lowest progress first (unknown bars last)
    var low = function (r) { var a = [r.soBar, r.matBar].filter(function (x) { return x !== null; }); return a.length ? Math.min.apply(null, a) : 1000; };
    rows.sort(function (a, b) { return low(a) - low(b); });
    return {
      ok: true, role: 'admin', email: email, refreshedAt: adapter.now(), rows: rows,
      stock: { has: stock.has, count: stock.count, meta: stock.meta },
      steel: { meta: readSteelMeta(adapter) }, writable: idIndex >= 0
    };
  }

  function findSO(adapter, req) {
    var want = Core.normSo(req.so_no);
    if (!want) return fail('BAD_REQUEST', 'Enter an SO number.');
    var K = Core.BY_KEY;
    var idIndex = adapter.getIdIndex();
    var hits = adapter.readColumns(span(K.part_no.index, K.so_no.index), false).filter(function (r) {
      var v = r.values;
      if (blank(v[K.part_no.index]) && blank(v[K.so_no.index])) return false;
      return Core.normSo(v[K.so_no.index]) === want;
    }).slice(0, 5);
    if (!hits.length) return fail('NOT_FOUND', 'No SO found with number ' + req.so_no + '.');
    var stock = readStockInfo(adapter);
    var out = hits.map(function (h) { return withCheck(Core.buildRecord(adapter.readRow(h.rowNumber), idIndex), stock); });
    return { ok: true, records: out, refreshedAt: adapter.now() };
  }

  function createSO(adapter, email, req) {
    if (!req.changes || typeof req.changes !== 'object') return fail('BAD_REQUEST', 'Missing form data.');
    return adapter.withLock(function () {
      var K = Core.BY_KEY;
      var idIndex = adapter.getIdIndex();
      if (idIndex < 0) return fail('NOT_READY', 'Editing is not set up yet (no RECORD ID column).');
      var rows = adapter.readColumns(span(K.part_no.index, K.so_no.index), false);
      var isRec = function (r) { return !(blank(r.values[K.part_no.index]) && blank(r.values[K.so_no.index])); };
      var existing = [], lastRecordRow = 0;
      rows.forEach(function (r) {
        if (!isRec(r)) return;
        existing.push(r.values[K.so_no.index]);
        if (r.rowNumber > lastRecordRow) lastRecordRow = r.rowNumber;
      });
      var plan = Core.planCreate(req.changes, existing, adapter.readUsers ? Core.peopleList(adapter.readUsers()) : null);
      if (!plan.ok) return fail(plan.code, plan.error, { fieldErrors: plan.fieldErrors });
      var free = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].rowNumber > lastRecordRow && !isRec(rows[i])) { free = rows[i]; break; }
      }
      if (!free) return fail('NO_FREE_ROW', 'There is no free row left in RYD-SO. Ask an admin to extend the sheet.');
      var id = adapter.newId();
      var cells = plan.writes.map(function (w) { return { index: w.field.index, value: w.value, type: w.field.type }; });
      cells.push({ index: idIndex, value: id, type: 'text' });
      adapter.writeCells(free.rowNumber, cells);
      clearDashCache(adapter);
      adapter.audit({
        at: adapter.now(), user: email, recordId: id, row: free.rowNumber, field: 'SO OPENED',
        oldValue: '', newValue: (function () { var w = plan.writes.filter(function (x) { return x.key === 'so_no'; })[0]; return w ? 'SO# ' + w.value : 'SO opened without SO# (part ' + plan.writes.filter(function (x) { return x.key === 'part_no'; })[0].value + ')'; })()
      });
      var rec = withCheck(Core.buildRecord(adapter.readRow(free.rowNumber), idIndex), readStockInfo(adapter));
      return { ok: true, record: rec, refreshedAt: adapter.now() };
    });
  }

  function uploadScan(adapter, email, req) {
    var found = findById(adapter, req.id);
    if (!found) return fail('NOT_FOUND', 'Record not found.');
    var v = Core.validateScanUpload(req.fileName, req.mime, req.data);
    if (!v.ok) return fail('INVALID', v.error);
    var rec = Core.buildRecord(found.row, found.idIndex);
    var saved = adapter.saveScan({
      recordId: req.id, soNo: String(rec.values.so_no), name: v.name, mime: v.mime, data: req.data, user: email, at: adapter.now()
    });
    adapter.audit({ at: adapter.now(), user: email, recordId: req.id, row: found.row.rowNumber, field: 'SCAN UPLOADED', oldValue: '', newValue: v.name + ' (' + v.bytes + ' bytes)' });
    return { ok: true, scan: saved, scans: adapter.listScans(req.id) };
  }

  function listScans(adapter, req) {
    if (!findById(adapter, req.id)) return fail('NOT_FOUND', 'Record not found.');
    return { ok: true, scans: adapter.listScans(req.id) };
  }

  function downloadScan(adapter, req) {
    if (!req.id || !req.fileId) return fail('BAD_REQUEST', 'Missing id or fileId.');
    var known = adapter.listScans(req.id).filter(function (s) { return s.fileId === req.fileId; })[0];
    if (!known) return fail('NOT_FOUND', 'Scan not found for this SO.');
    var f = adapter.readScan(req.fileId);
    return { ok: true, name: known.name, mime: f.mime, data: f.data };
  }

  function uploadStock(adapter, email, req) {
    var v = Core.validateStockUpload(req.rows);
    if (!v.ok) return fail('INVALID', v.error);
    var fileName = String(req.fileName || '').slice(0, 120);
    return adapter.withLock(function () {
      var meta = { uploadedAt: adapter.now(), uploadedBy: email, fileName: fileName };
      adapter.writeStock(v.rows, meta);
      clearDashCache(adapter);
      adapter.audit({
        at: meta.uploadedAt, user: email, recordId: '', row: '', field: 'STOCKROOM UPLOAD',
        oldValue: '', newValue: v.rows.length + ' rows' + (fileName ? ' from ' + fileName : '') + (v.skipped ? ' (' + v.skipped + ' skipped)' : '')
      });
      return { ok: true, count: v.rows.length, skipped: v.skipped, meta: meta };
    });
  }

  function uploadSteelUsage(adapter, email, req) {
    var v = Core.validateSteelUpload(req.rows);
    if (!v.ok) return fail('INVALID', v.error);
    var fileName = String(req.fileName || '').slice(0, 120);
    return adapter.withLock(function () {
      var meta = { at: adapter.now(), by: email, fileName: fileName };
      var replaced = adapter.writeSteelUsage(v.rows, meta);
      clearDashCache(adapter);
      if (adapter.saveSteelMeta) adapter.saveSteelMeta({ at: meta.at, by: meta.by, fileName: meta.fileName, count: v.rows.length });
      adapter.audit({
        at: meta.at, user: email, recordId: '', row: '', field: 'STEEL USAGE REPLACED',
        oldValue: (replaced && replaced.previousRows !== undefined ? replaced.previousRows : '?') + ' old rows (kept in STEEL USAGE (previous))',
        newValue: v.rows.length + ' rows' + (fileName ? ' from ' + fileName : '') + (v.skipped ? ' (' + v.skipped + ' skipped)' : '')
      });
      return { ok: true, count: v.rows.length, skipped: v.skipped, previousRows: replaced ? replaced.previousRows : undefined, meta: meta };
    });
  }

  return { handle: handle, loadRecords: loadRecords };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOService;
