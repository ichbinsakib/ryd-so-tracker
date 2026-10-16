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
      var role = Core.roleFor(auth.email, cfg.editors, cfg.viewers, cfg.admins);
      if (!role) return fail('FORBIDDEN', 'Your Google account (' + auth.email + ') is not authorised for this application.');

      switch (req.action) {
        case 'whoami':
          return { ok: true, email: auth.email, role: role, fields: Core.publicFields() };

        case 'list': {
          var stock = readStockInfo(adapter);
          var l = loadRecords(adapter, stock);
          return {
            ok: true, role: role, email: auth.email, fields: Core.publicFields(),
            writable: l.idIndex >= 0, refreshedAt: adapter.now(), records: l.records,
            stock: { has: stock.has, count: stock.count, meta: stock.meta }
          };
        }

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

  function findById(adapter, id) {
    if (!id) return null;
    var data = adapter.readAll();
    if (data.idIndex < 0) return null;
    for (var i = 0; i < data.rows.length; i++) {
      var r = data.rows[i];
      if (String(r.values[data.idIndex]) === String(id)) return { row: r, idIndex: data.idIndex };
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
      var after = adapter.readRow(found.row.rowNumber);
      var updated = withCheck(Core.buildRecord(after, found.idIndex), readStockInfo(adapter));
      plan.writes.forEach(function (w) {
        adapter.audit({
          at: adapter.now(), user: email, recordId: req.id, row: found.row.rowNumber,
          field: w.field.label + ' (' + w.field.col + ')', oldValue: String(w.old), newValue: String(w.value)
        });
      });
      return { ok: true, record: updated, changed: plan.writes.map(function (w) { return w.key; }), refreshedAt: adapter.now() };
    });
  }

  function uploadStock(adapter, email, req) {
    var v = Core.validateStockUpload(req.rows);
    if (!v.ok) return fail('INVALID', v.error);
    var fileName = String(req.fileName || '').slice(0, 120);
    return adapter.withLock(function () {
      var meta = { uploadedAt: adapter.now(), uploadedBy: email, fileName: fileName };
      adapter.writeStock(v.rows, meta);
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
