// One-off "fresh start" for the live Apps Script project. NOT part of the deployed app.
// Paste at the top of Code.gs, run aaFreshStart once, then delete it again.
// Takes a full backup copy of the spreadsheet first (backupNow), then clears:
//   - every input cell of the order sheet (formula cells and headers stay), incl. RECORD ID
//   - APP_AUDIT, SO_SCANS, STOCKROOM_PRICES, STEEL USAGE, STEEL USAGE (previous)
// APP_USERS is left alone. Scan files in the Drive folder are not deleted.
function aaFreshStart() {
  backupNow();
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sh = getDataSheet_(ss);
  var first = SOCore.FIRST_DATA_ROW, last = sh.getLastRow(), n = last - first + 1, report = [];
  if (n > 0) {
    var idCol = -1, lastCol = sh.getLastColumn();
    sh.getRange(SOCore.HEADER_ROW, 1, 1, lastCol).getValues()[0].forEach(function (h, i) { if (String(h).trim() === SOCore.ID_HEADER) idCol = i; });
    var cols = SOCore.FIELDS.filter(function (f) { return !f.calc; }).map(function (f) { return f.index; });
    if (idCol >= 0) cols.push(idCol);
    var cleared = 0;
    cols.forEach(function (ci) {
      var rg = sh.getRange(first, ci + 1, n, 1);
      var fs = rg.getFormulas(), vs = rg.getValues(), out = [];
      for (var i = 0; i < n; i++) { if (fs[i][0]) { out.push([fs[i][0]]); } else { if (vs[i][0] !== '') cleared++; out.push(['']); } }
      rg.setValues(out);
    });
    report.push('Order sheet cells cleared: ' + cleared);
  }
  function wipe(name, row, ncols) {
    var t = ss.getSheetByName(name);
    if (!t) { report.push(name + ': missing'); return; }
    var l = t.getLastRow();
    if (l >= row) { t.getRange(row, 1, l - row + 1, ncols || t.getLastColumn()).clearContent(); report.push(name + ': cleared ' + (l - row + 1) + ' rows'); }
    else report.push(name + ': already empty');
  }
  wipe(AUDIT_SHEET_NAME, 2); wipe(SCANS_SHEET_NAME, 2);
  var st = ss.getSheetByName(STOCK_SHEET_NAME); if (st) st.getRange(1, 4, 3, 2).clearContent();
  wipe(STOCK_SHEET_NAME, 2, 2);
  wipe(STEEL_SHEET_NAME, 2, 11); wipe(STEEL_PREVIOUS_NAME, 1);
  PropertiesService.getScriptProperties().deleteProperty('STEEL_META');
  CacheService.getScriptCache().removeAll(['dash0', 'dash1']);
  Logger.log(report.join(' | '));
}
