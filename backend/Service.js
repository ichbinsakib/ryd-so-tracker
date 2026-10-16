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
          return { ok: true, email: auth.email, role: role, fields: Core.publicFields(), intake: Core.intakeInfo() };

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

  function readSteelMeta(adapter) { return adapter.readSteelMeta ? adapter.readSteelMeta() : null; }

  function blank(v) { return String(v === undefined || v === null ? '' : v).trim() === ''; }

  function dashboard(adapter, email, req) {
    var K = Core.BY_KEY;
    var idIndex = adapter.getIdIndex();
    var stock = readStockInfo(adapter);
    var idxs = [K.status.index, K.so_release_status_bar.index, K.mat_status_bar.index, K.customer.index, K.part_no.index, K.so_no.index];
    if (idIndex >= 0) idxs.push(idIndex);
    var rows = [];
    adapter.readColumns(idxs, true).forEach(function (r) {
      var v = r.values;
      if (blank(v[K.part_no.index]) && blank(v[K.so_no.index])) return;
      var status = String(v[K.status.index] || '').trim();
      if (!req.includeClosed && status === '4.CLOSE') return;
      rows.push({
        id: idIndex >= 0 ? v[idIndex] || null : null, so_no: v[K.so_no.index], part_no: v[K.part_no.index], customer: v[K.customer.index],
        status: status, soBar: Core.pctNum(v[K.so_release_status_bar.index]), matBar: Core.pctNum(v[K.mat_status_bar.index])
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
    var hits = adapter.readColumns([K.so_no.index, K.part_no.index], false).filter(function (r) {
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
      var rows = adapter.readColumns([K.part_no.index, K.so_no.index], false);
      var isRec = function (r) { return !(blank(r.values[K.part_no.index]) && blank(r.values[K.so_no.index])); };
      var existing = [], lastRecordRow = 0;
      rows.forEach(function (r) {
        if (!isRec(r)) return;
        existing.push(r.values[K.so_no.index]);
        if (r.rowNumber > lastRecordRow) lastRecordRow = r.rowNumber;
      });
      var plan = Core.planCreate(req.changes, existing);
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
      adapter.audit({
        at: adapter.now(), user: email, recordId: id, row: free.rowNumber, field: 'SO OPENED',
        oldValue: '', newValue: 'SO# ' + plan.writes.filter(function (w) { return w.key === 'so_no'; })[0].value
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
