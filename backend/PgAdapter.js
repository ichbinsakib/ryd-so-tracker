/**
 * Snapshot adapter for the database version of the app. SOService is synchronous, so the
 * network layer (supabase/functions/api) first loads exactly the rows an action needs into
 * this adapter, runs SOService.handle() against it, then writes the collected `ops` to the
 * database. Pure JavaScript: unit-tested in Node (tests/pgadapter.test.js), no network here.
 *
 * opts = {
 *   email, config:{admins,editors,viewers},
 *   users:[{email,name,employeeId,role,active,...}],
 *   rows:[{rowNumber, id, data:{key:value}}],            // the rows this action needs
 *   stock:{rows:[[part,price]], count, meta},            // stockroom price upload (for the price check)
 *   stockItems:{PART_KEY:{quantity, unitPrice}},         // the STOCK list (PART PRICE / AVAIL FT lookups)
 *   steel:{PART_KEY:{steelType, qtyPerBar, routerBarSize}}, steelCount, steelMeta,
 *   scans:[{fileId,recordId,name,at,by}], scanBytes:{fileId:{mime,data}},
 *   now(), newId()
 * }
 */
var SOPg = (function () {
  var Core = {}, Calc = null;
  function bind() {
    if (Core.FIELDS) return;
    var c = (typeof SOCore !== 'undefined') ? SOCore : require('./Core.js');
    for (var k in c) Core[k] = c[k];
    Calc = (typeof SOCalc !== 'undefined') ? SOCalc : require('./Calc.js');
  }

  var ID_INDEX = 77;
  var WIDTH = 78;

  function create(opts) {
    bind();
    var ops = [];
    var rows = (opts.rows || []).map(function (r) { return { rowNumber: r.rowNumber, id: r.id, data: JSON.parse(JSON.stringify(r.data || {})), pending: false }; });
    var users = (opts.users || []).map(function (u) { return Object.assign({}, u); });
    var scans = (opts.scans || []).slice();
    var tempRow = 0;
    var byIndex = {};
    Core.FIELDS.forEach(function (f) { byIndex[f.index] = f; });

    var ctx = {
      stockByPart: function (key) { return (opts.stockItems && opts.stockItems[key]) || null; },
      steelByPart: function (key) { return (opts.steel && opts.steel[key]) || null; }
    };

    function typedValue(row, f) {
      var v = row.data[f.key];
      return v === undefined || v === null ? '' : v;
    }
    function cell(row, index, calcTable) {
      if (index === ID_INDEX) { var id = row.id || ''; return { value: id, display: id }; }
      var f = byIndex[index];
      if (!f) return { value: '', display: '' };
      if (f.calc) {
        var c = calcTable[f.key] ? calcTable[f.key]() : { value: '', display: '' };
        return c;
      }
      var v = typedValue(row, f);
      return { value: v, display: String(v) };
    }
    function findRow(n) { for (var i = 0; i < rows.length; i++) if (rows[i].rowNumber === n) return rows[i]; return null; }
    function ordered() { return rows.slice().sort(function (a, b) { return a.rowNumber - b.rowNumber; }); }

    var adapter = {
      verifyToken: function () { return { ok: true, email: opts.email }; },
      config: function () { return opts.config || {}; },
      now: opts.now || function () { return new Date().toISOString(); },
      newId: opts.newId,
      withLock: function (fn) { return fn(); },
      getIdIndex: function () { return ID_INDEX; },
      scopedToUser: true,

      readColumns: function (indexes, display) {
        return ordered().map(function (row) {
          var table = Calc.rowCalc(row.data, ctx);
          var values = {};
          indexes.forEach(function (i) { var c = cell(row, i, table); values[i] = display ? c.display : c.value; });
          return { rowNumber: row.rowNumber, values: values };
        });
      },
      readRow: function (n) {
        var row = findRow(n);
        if (!row) return null;
        var table = Calc.rowCalc(row.data, ctx);
        var values = new Array(WIDTH), disp = new Array(WIDTH), formulas = new Array(WIDTH);
        for (var i = 0; i < WIDTH; i++) { var c = cell(row, i, table); values[i] = c.value; disp[i] = c.display; formulas[i] = ''; }
        return { rowNumber: row.rowNumber, values: values, display: disp, formulas: formulas };
      },
      readAll: function () {
        var self = this;
        return { idIndex: ID_INDEX, rows: ordered().map(function (r) { return self.readRow(r.rowNumber); }) };
      },

      writeCells: function (rowNumber, cells) {
        var row = findRow(rowNumber);
        if (!row) throw new Error('Row not found.');
        var patch = {};
        cells.forEach(function (c) {
          if (c.index === ID_INDEX) return;
          var f = byIndex[c.index];
          if (!f || f.calc) return;
          if (c.value === '' || c.value === null || c.value === undefined) { delete row.data[f.key]; patch[f.key] = null; }
          else { row.data[f.key] = c.value; patch[f.key] = c.value; }
        });
        if (!row.pending) ops.push({ type: 'update', id: row.id, patch: patch });
        else { var ins = ops.filter(function (o) { return o.type === 'insert' && o.id === row.id; })[0]; if (ins) Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete ins.data[k]; else ins.data[k] = patch[k]; }); }
      },
      insertRow: function (cells, id) {
        var data = {};
        cells.forEach(function (c) {
          var f = byIndex[c.index];
          if (c.index === ID_INDEX || !f || f.calc || c.value === '' || c.value === null || c.value === undefined) return;
          data[f.key] = c.value;
        });
        tempRow -= 1;
        rows.push({ rowNumber: tempRow, id: id, data: JSON.parse(JSON.stringify(data)), pending: true });
        ops.push({ type: 'insert', id: id, data: data, createdBy: opts.email });
        return tempRow;
      },
      deleteRow: function (rowNumber) {
        var row = findRow(rowNumber);
        if (!row) return;
        rows.splice(rows.indexOf(row), 1);
        ops.push({ type: 'delete', id: row.id });
      },

      audit: function (e) {
        ops.push({ type: 'audit', entry: { at: e.at, user: e.user, recordId: e.recordId || '', row: typeof e.row === 'number' && e.row > 0 ? e.row : null, field: e.field, oldValue: e.oldValue === undefined ? '' : String(e.oldValue), newValue: e.newValue === undefined ? '' : String(e.newValue) } });
      },
      auditAll: function (list) { var self = this; list.forEach(function (e) { self.audit(e); }); },

      readUsers: function () { return users.map(function (u) { return Object.assign({}, u); }); },
      writeUsers: function (list) { users = list.map(function (u) { return Object.assign({}, u); }); ops.push({ type: 'users', list: users.map(function (u) { return Object.assign({}, u); }) }); },

      readStock: function () {
        var s = opts.stock || { rows: [], count: 0, meta: null };
        return { rows: s.rows || [], count: s.count !== undefined ? s.count : (s.rows || []).length, meta: s.meta || null };
      },
      writeStock: function (list, meta) { ops.push({ type: 'stock', rows: list, meta: meta }); },
      writeSteelUsage: function (list, meta) { ops.push({ type: 'steel', rows: list, meta: meta }); return { previousRows: opts.steelCount || 0 }; },
      writeStockItems: function (list) { ops.push({ type: 'stockItems', rows: list }); },
      saveSteelMeta: function (m) { ops.push({ type: 'steelMeta', meta: m }); },
      readSteelMeta: function () { return opts.steelMeta || null; },

      saveScan: function (s) {
        var fileId = opts.newId();
        var entry = { fileId: fileId, recordId: s.recordId, soNo: s.soNo, name: s.name, mime: s.mime, at: s.at, by: s.user };
        scans.push({ fileId: fileId, recordId: s.recordId, name: s.name, at: s.at, by: s.user });
        ops.push({ type: 'scan', scan: entry, data: s.data });
        return { fileId: fileId, name: s.name, at: s.at, by: s.user };
      },
      listScans: function (recordId) {
        return scans.filter(function (x) { return String(x.recordId) === String(recordId); }).map(function (x) { return { at: x.at, fileId: x.fileId, name: x.name, by: x.by }; });
      },
      readScan: function (fileId) { return (opts.scanBytes && opts.scanBytes[fileId]) || { mime: 'application/octet-stream', data: '' }; }
    };
    return { adapter: adapter, ops: ops };
  }

  return { create: create, ID_INDEX: ID_INDEX };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOPg;
