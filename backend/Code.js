/**
 * Google Apps Script entry points and Google-specific adapter.
 * Deployed as a Web App: Execute as ME, Who has access: ANYONE.
 * "Anyone" only means the URL is reachable; every request must carry a Google ID token
 * that is verified here and the email must be in the allow-list (Script Properties).
 *
 * Script Properties (Project Settings -> Script properties):
 *   GOOGLE_CLIENT_ID  OAuth Web client ID (public value, also in the frontend)
 *   SHEET_ID          ID of the spreadsheet
 *   EDITORS           comma-separated emails who may view and edit
 *   VIEWERS           comma-separated emails who may only view
 *   ADMINS            comma-separated emails who may edit AND upload the stockroom price sheet
 */
var SHEET_NAME = 'RYD-SO';
var AUDIT_SHEET_NAME = 'APP_AUDIT';
var STOCK_SHEET_NAME = 'STOCKROOM_PRICES';
var STEEL_SHEET_NAME = 'STEEL USAGE';
var SCANS_SHEET_NAME = 'SO_SCANS';
var USERS_SHEET_NAME = 'APP_USERS';
var STEEL_PREVIOUS_NAME = 'STEEL USAGE (previous)';
var BACKUP_KEEP = 14;

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function doGet() {
  // Deliberately returns no data. Used only to confirm the deployment is alive.
  return json_({ ok: true, service: 'RYD-SO API', note: 'POST requests with a Google ID token are required.' });
}

function doPost(e) {
  var req;
  try {
    var body = e && e.postData && e.postData.contents;
    if (!body || body.length > 14000000) return json_({ ok: false, code: 'BAD_REQUEST', error: 'Bad request size.' });
    req = JSON.parse(body);
    if (body.length > 2000000 && (!req || req.action !== 'uploadScan')) return json_({ ok: false, code: 'BAD_REQUEST', error: 'Bad request size.' });
    if (body.length > 100000 && (!req || (req.action !== 'uploadStock' && req.action !== 'uploadSteelUsage' && req.action !== 'uploadScan'))) return json_({ ok: false, code: 'BAD_REQUEST', error: 'Bad request size.' });
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', error: 'Request is not valid JSON.' });
  }
  return json_(SOService.handle(sheetAdapter_(), req));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- adapter

function sheetAdapter_() {
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  var tz = ss.getSpreadsheetTimeZone();

  function headerInfo() {
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(SOCore.HEADER_ROW, 1, 1, lastCol).getValues()[0];
    var idIndex = -1;
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim() === SOCore.ID_HEADER) idIndex = i;
    }
    return { lastCol: lastCol, idIndex: idIndex };
  }

  // The header row never changes after setup, so remember where RECORD ID is (saves a sheet read per request).
  function cachedIdIndex() {
    var cache = CacheService.getScriptCache();
    var hit = cache.get('idIndex');
    if (hit !== null && hit !== undefined) return Number(hit);
    var idx = headerInfo().idIndex;
    if (idx >= 0) cache.put('idIndex', String(idx), 600);
    return idx;
  }

  function rowWidth() { return Math.max(cachedIdIndex() + 1, SOCore.FIELDS.length); }

  function normalise(v) {
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    }
    return v;
  }

  function toRows(range, startRow) {
    var values = range.getValues();
    var display = range.getDisplayValues();
    var formulas = range.getFormulas();
    return values.map(function (r, i) {
      return { rowNumber: startRow + i, values: r.map(normalise), display: display[i], formulas: formulas[i] };
    });
  }

  return {
    verifyToken: verifyIdToken_,

    config: function () { return { editors: prop_('EDITORS'), viewers: prop_('VIEWERS'), admins: prop_('ADMINS') }; },

    readStock: function () {
      var st = ss.getSheetByName(STOCK_SHEET_NAME);
      if (!st || st.getLastRow() < 2) return { rows: [], meta: null };
      var rows = st.getRange(2, 1, st.getLastRow() - 1, 2).getValues().filter(function (r) { return String(r[0]).trim() !== ''; });
      var m = st.getRange(1, 4, 3, 2).getValues();
      return { rows: rows, meta: { uploadedAt: String(m[0][1]), uploadedBy: String(m[1][1]), fileName: String(m[2][1]) } };
    },

    newId: function () { return Utilities.getUuid(); },

    saveSteelMeta: function (meta) { PropertiesService.getScriptProperties().setProperty('STEEL_META', JSON.stringify(meta)); },

    readSteelMeta: function () {
      var raw = prop_('STEEL_META');
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },

    saveScan: function (s) {
      var blob = Utilities.newBlob(Utilities.base64Decode(s.data), s.mime, 'SO-' + String(s.soNo).replace(/[^A-Za-z0-9_-]/g, '_') + '_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss') + '_' + s.name);
      var file = scanFolder_().createFile(blob);
      var tab = ss.getSheetByName(SCANS_SHEET_NAME) || createScansSheet_(ss);
      tab.appendRow([s.at, s.recordId, s.soNo, file.getId(), file.getName(), s.user]);
      return { fileId: file.getId(), name: file.getName(), at: s.at, by: s.user };
    },

    listScans: function (recordId) {
      var tab = ss.getSheetByName(SCANS_SHEET_NAME);
      if (!tab || tab.getLastRow() < 2) return [];
      return tab.getRange(2, 1, tab.getLastRow() - 1, 6).getValues()
        .filter(function (r) { return String(r[1]) === String(recordId); })
        .map(function (r) { return { at: String(r[0]), fileId: String(r[3]), name: String(r[4]), by: String(r[5]) }; });
    },

    readScan: function (fileId) {
      var blob = DriveApp.getFileById(fileId).getBlob();
      return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
    },

    readUsers: function () {
      var cache = CacheService.getScriptCache();
      var hit = cache.get('users');
      if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through to the sheet */ } }
      var tab = ss.getSheetByName(USERS_SHEET_NAME);
      var users = [];
      if (tab && tab.getLastRow() >= 2) {
        tab.getRange(2, 1, tab.getLastRow() - 1, 9).getValues().forEach(function (r) {
          if (!String(r[0]).trim()) return;
          users.push({
            email: String(r[0]).trim().toLowerCase(), name: String(r[1]), employeeId: String(r[2]), role: String(r[3]).trim().toLowerCase(),
            active: String(r[4]).trim().toUpperCase() !== 'NO', addedBy: String(r[5]), addedAt: String(r[6]), updatedBy: String(r[7]), updatedAt: String(r[8])
          });
        });
      }
      try { cache.put('users', JSON.stringify(users), 300); } catch (e) { /* too big to cache: fine */ }
      return users;
    },

    writeUsers: function (list) {
      var tab = ss.getSheetByName(USERS_SHEET_NAME) || createUsersSheet_(ss);
      var last = tab.getLastRow();
      if (last >= 2) tab.getRange(2, 1, last - 1, 9).clearContent();
      if (list.length) {
        tab.getRange(2, 3, list.length, 1).setNumberFormat('@');
        tab.getRange(2, 1, list.length, 9).setValues(list.map(function (u) {
          return [u.email, u.name || '', u.employeeId || '', u.role, u.active ? 'YES' : 'NO', u.addedBy || '', u.addedAt || '', u.updatedBy || '', u.updatedAt || ''];
        }));
      }
      CacheService.getScriptCache().remove('users');
      SpreadsheetApp.flush();
    },

    writeSteelUsage: function (rows, meta) {
      var su = ss.getSheetByName(STEEL_SHEET_NAME);
      if (!su) throw new Error('Sheet "' + STEEL_SHEET_NAME + '" not found.');
      var lastRow = su.getLastRow();
      var lastCol = Math.max(su.getLastColumn(), 11);
      var previousRows = Math.max(0, lastRow - 1);
      // 1) one-level undo: copy the whole current tab (values) before touching it
      var prev = ss.getSheetByName(STEEL_PREVIOUS_NAME) || ss.insertSheet(STEEL_PREVIOUS_NAME);
      prev.clear();
      if (lastRow >= 1) prev.getRange(1, 1, lastRow, lastCol).setValues(su.getRange(1, 1, lastRow, lastCol).getValues());
      prev.getRange(1, lastCol + 2).setValue('Snapshot of STEEL USAGE taken ' + meta.at + ' by ' + meta.by + ' before uploading ' + meta.fileName);
      SpreadsheetApp.flush();
      // 2) delete old data (header row 1 is kept), 3) write the new rows into A:D
      if (lastRow >= 2) su.getRange(2, 1, lastRow - 1, lastCol).clearContent();
      su.getRange(2, 1, rows.length, 4).setValues(rows);
      SpreadsheetApp.flush();
      return { previousRows: previousRows };
    },

    writeStock: function (rows, meta) {
      var st = ss.getSheetByName(STOCK_SHEET_NAME) || ss.insertSheet(STOCK_SHEET_NAME);
      st.clear();
      st.getRange(1, 1, 1, 2).setValues([['PART #', 'PRICE']]);
      st.getRange(1, 4, 3, 2).setValues([['UPLOADED AT', meta.uploadedAt], ['UPLOADED BY', meta.uploadedBy], ['FILE', meta.fileName]]);
      st.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      st.getRange(2, 1, rows.length, 2).setValues(rows);
      st.setFrozenRows(1);
      SpreadsheetApp.flush();
    },

    now: function () { return new Date().toISOString(); },

    readAll: function () {
      var h = headerInfo();
      var n = sheet.getLastRow() - SOCore.FIRST_DATA_ROW + 1;
      if (n < 1) return { idIndex: h.idIndex, rows: [] };
      var range = sheet.getRange(SOCore.FIRST_DATA_ROW, 1, n, h.lastCol);
      return { idIndex: h.idIndex, rows: toRows(range, SOCore.FIRST_DATA_ROW) };
    },

    getIdIndex: cachedIdIndex,

    // Reads only the requested columns (contiguous ones in one call). display=true returns the text as shown in the sheet.
    readColumns: function (indexes, display) {
      var n = sheet.getLastRow() - SOCore.FIRST_DATA_ROW + 1;
      if (n < 1) return [];
      var rows = [];
      for (var i = 0; i < n; i++) rows.push({ rowNumber: SOCore.FIRST_DATA_ROW + i, values: {} });
      var sorted = indexes.slice().sort(function (a, b) { return a - b; }).filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
      var g = 0;
      while (g < sorted.length) {
        var start = sorted[g], end = start;
        while (g + 1 < sorted.length && sorted[g + 1] === end + 1) { g++; end = sorted[g]; }
        var range = sheet.getRange(SOCore.FIRST_DATA_ROW, start + 1, n, end - start + 1);
        var data = display ? range.getDisplayValues() : range.getValues();
        for (var r = 0; r < n; r++) {
          for (var c = 0; c <= end - start; c++) rows[r].values[start + c] = display ? data[r][c] : normalise(data[r][c]);
        }
        g++;
      }
      return rows;
    },

    readRow: function (rowNumber) {
      return toRows(sheet.getRange(rowNumber, 1, 1, rowWidth()), rowNumber)[0];
    },

    writeCells: function (rowNumber, cells) {
      cells.forEach(function (c) {
        var cell = sheet.getRange(rowNumber, c.index + 1);
        var v = c.value;
        if (v === '') {
          cell.clearContent();
        } else if (c.type === 'date') {
          cell.setValue(Utilities.parseDate(v, tz, 'yyyy-MM-dd'));
        } else if (typeof v === 'number') {
          cell.setValue(v);
        } else if (/^0\d+$/.test(v)) {
          cell.setValue("'" + v); // keep leading zeros as text
        } else {
          cell.setValue(v);
        }
      });
      SpreadsheetApp.flush();
    },

    audit: function (entry) {
      var audit = ss.getSheetByName(AUDIT_SHEET_NAME);
      if (!audit) { console.warn('AUDIT ' + JSON.stringify(entry)); return; }
      audit.appendRow([entry.at, entry.user, entry.recordId, entry.row, entry.field, entry.oldValue, entry.newValue]);
    },

    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) throw { code: 'BUSY' };
      try { return fn(); } finally { lock.releaseLock(); }
    }
  };
}

function createUsersSheet_(ss) {
  var t = ss.insertSheet(USERS_SHEET_NAME);
  t.appendRow(['EMAIL', 'NAME', 'EMPLOYEE ID', 'ROLE (viewer/editor/admin)', 'ACTIVE (YES/NO)', 'ADDED BY', 'ADDED AT', 'UPDATED BY', 'UPDATED AT']);
  t.setFrozenRows(1);
  return t;
}

function createScansSheet_(ss) {
  var t = ss.insertSheet(SCANS_SHEET_NAME);
  t.appendRow(['AT (UTC)', 'RECORD ID', 'SO#', 'DRIVE FILE ID', 'FILE NAME', 'UPLOADED BY']);
  t.setFrozenRows(1);
  return t;
}

/** Private Drive folder for scans. Created on first use; its ID is kept in Script Properties. */
function scanFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SCAN_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  var folder = DriveApp.createFolder('RYD-SO Scans');
  props.setProperty('SCAN_FOLDER_ID', folder.getId());
  return folder;
}


function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4000) return { ok: false, error: 'Please sign in.' };
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + SOCore.hash(idToken);
  var hit = cache.get(key);
  var clientId = prop_('GOOGLE_CLIENT_ID');
  var info;
  if (hit) {
    info = JSON.parse(hit);
  } else {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { ok: false, error: 'Session expired or invalid. Please sign in again.' };
    info = JSON.parse(resp.getContentText());
  }
  var res = SOCore.checkTokenInfo(info, clientId, Math.floor(Date.now() / 1000));
  if (res.ok && !hit) cache.put(key, JSON.stringify(info), 300);
  return res;
}

// ------------------------------------------------- one-time setup (run by the owner)

/**
 * Run ONCE from the Apps Script editor, after making a manual copy of the spreadsheet.
 * - Makes a Drive backup copy.
 * - Adds a "RECORD ID" column after the last used column of RYD-SO and fills IDs for record rows.
 * - Creates the APP_AUDIT sheet.
 * Existing cells are never changed.
 */
function setupApp() {
  backupNow();
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sheet = ss.getSheetByName(SHEET_NAME);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(SOCore.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  var idCol = -1;
  headers.forEach(function (h, i) { if (String(h).trim() === SOCore.ID_HEADER) idCol = i + 1; });
  if (idCol < 0) {
    idCol = lastCol + 1;
    sheet.getRange(SOCore.HEADER_ROW, idCol).setValue(SOCore.ID_HEADER);
  }
  var n = sheet.getLastRow() - SOCore.FIRST_DATA_ROW + 1;
  var range = sheet.getRange(SOCore.FIRST_DATA_ROW, 1, n, idCol);
  var vals = range.getValues();
  var partIdx = SOCore.BY_KEY.part_no.index, soIdx = SOCore.BY_KEY.so_no.index;
  var out = [], created = 0;
  vals.forEach(function (r) {
    var isRec = String(r[partIdx]).trim() || String(r[soIdx]).trim();
    var cur = r[idCol - 1];
    if (isRec && !cur) { cur = Utilities.getUuid(); created++; }
    out.push([cur]);
  });
  sheet.getRange(SOCore.FIRST_DATA_ROW, idCol, n, 1).setValues(out);
  if (!ss.getSheetByName(AUDIT_SHEET_NAME)) {
    var a = ss.insertSheet(AUDIT_SHEET_NAME);
    a.appendRow(['AT (UTC)', 'USER', 'RECORD ID', 'ROW', 'FIELD', 'OLD VALUE', 'NEW VALUE']);
    a.setFrozenRows(1);
  }
  console.log('Setup done. Record IDs created: ' + created + ' (ID column ' + idCol + ').');
}

/** Makes a dated copy of the whole spreadsheet in the owner's Drive and prunes old copies. */
function backupNow() {
  var file = DriveApp.getFileById(prop_('SHEET_ID'));
  var stamp = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd_HHmm');
  var prefix = 'BACKUP RYD-SO ';
  file.makeCopy(prefix + stamp);
  var copies = [];
  var it = DriveApp.searchFiles("title contains '" + prefix + "' and trashed = false");
  while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(prefix) === 0) copies.push(f); }
  copies.sort(function (a, b) { return b.getName() < a.getName() ? -1 : 1; });
  copies.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
}

/** Run once to schedule a daily backup. */
function installDailyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
}
