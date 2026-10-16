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
 */
var SHEET_NAME = 'RYD-SO';
var AUDIT_SHEET_NAME = 'APP_AUDIT';
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
    if (!body || body.length > 100000) return json_({ ok: false, code: 'BAD_REQUEST', error: 'Bad request size.' });
    req = JSON.parse(body);
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

    config: function () { return { editors: prop_('EDITORS'), viewers: prop_('VIEWERS') }; },

    now: function () { return new Date().toISOString(); },

    readAll: function () {
      var h = headerInfo();
      var n = sheet.getLastRow() - SOCore.FIRST_DATA_ROW + 1;
      if (n < 1) return { idIndex: h.idIndex, rows: [] };
      var range = sheet.getRange(SOCore.FIRST_DATA_ROW, 1, n, h.lastCol);
      return { idIndex: h.idIndex, rows: toRows(range, SOCore.FIRST_DATA_ROW) };
    },

    readRow: function (rowNumber) {
      var h = headerInfo();
      return toRows(sheet.getRange(rowNumber, 1, 1, h.lastCol), rowNumber)[0];
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
