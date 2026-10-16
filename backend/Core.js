/**
 * Core business logic for the RYD-SO app. Pure JavaScript: no Google services are
 * touched here, so the same file runs in Apps Script and in Node (tests, dev mock).
 *
 * Column map comes from the inspection of the real RYD-SO sheet (header row = 2,
 * data from row 3). `calc: true` columns hold formulas in the sheet and are never written.
 */
var SOCore = (function () {
  var HEADER_ROW = 2;
  var FIRST_DATA_ROW = 3;
  var ID_HEADER = 'RECORD ID';
  var YN = ['YES', 'NO'];

  // [column letter, key, label, type, extra]
  // type: text | longtext | id | number | currency | date | enum
  var RAW = [
    ['A', 'notes', 'NOTES', 'longtext'],
    ['B', 'status', 'STATUS', 'enum', { options: ['1.ANR', '2.RFS', '5.HOLD', '3.OPEN', '4.CLOSE', '1. ANALYSIS'], required: true }],
    ['C', 'so_release_status_bar', 'SO RELEASE STATUS BAR', 'text', { calc: true }],
    ['D', 'mat_status_bar', 'MAT. STATUS BAR?', 'text', { calc: true }],
    ['E', 'champion', 'CHAMPION', 'text'],
    ['F', 'customer', 'CUSTOMER', 'text'],
    ['G', 'part_no', 'PART #', 'id'],
    ['H', 'part_price', 'PART PRICE', 'currency', { calc: true }],
    ['I', 'so_qty', 'SO QTY#', 'number'],
    ['J', 'due_date', 'DUE DATE', 'date'],
    ['K', 'so_no', 'SO#', 'id'],
    ['L', 'steel_type', 'STEEL TYPE', 'text', { calc: true }],
    ['M', 'material_code', 'MATERIAL CODE', 'text'],
    ['N', 'bar_type', 'BAR TYPE?(RD/SQ/REC./FLAT/HEX)', 'enum', { options: ['RD', 'TUBING', 'SQ', 'REC.', 'FLAT', 'HEX', 'RD-AL'] }],
    ['O', 'router_bar_size', 'ROUTER BAR SIZE', 'text', { calc: true }],
    ['P', 'qty_per_bar', 'QTY / BAR', 'number', { calc: true }],
    ['Q', 'verify_qty_per_bar', 'Verify Part Print QTY/Bar', 'text'],
    ['R', 'req_ft', 'REQ. FT', 'number', { calc: true }],
    ['S', 'req_lbs', 'REQ. LBS', 'number', { calc: true }],
    ['T', 'req_bar', 'REQ. BAR', 'number', { calc: true }],
    ['U', 'avail_ft', 'AVAIL (FT)', 'number', { calc: true }],
    ['V', 'email_template', 'EMAIL TEMPLATE', 'text', { calc: true }],
    ['W', 'qty_requested', 'QTY REQUESTED', 'text'],
    ['X', 'req_mat_quote', 'REQ. MAT. QUOTE?', 'enum', { options: YN }],
    ['Y', 'mat_quote_request_date', 'MAT. QUOTE REQUEST DATE', 'date'],
    ['Z', 'need_followup', 'DO NEED TO FOLLOWUP?', 'enum', { options: YN }],
    ['AA', 'followups_required', 'HOW MANY FOLLOWUPS REQUIRED?', 'text'],
    ['AB', 'followup_email_dates', 'FOLLOWUP EMAIL SEND DATES?(LIST DATE WITH COMMA)', 'text'],
    ['AC', 'quote_received', 'QUOTE RECEIVED?', 'enum', { options: YN }],
    ['AD', 'quote_receive_date', 'QUOTE RECEIVE DATE', 'date'],
    ['AE', 'traveller_mat_price_piece', 'TRAVELLER MAT. PRICE/ PIECE', 'currency'],
    ['AF', 'total_price_quote', 'TOTAL PRICE IN QUOTE/ IN STOCK PRICE', 'currency'],
    ['AG', 'quote_price_piece', 'QUOTE PRICE/ PIECE', 'currency', { calc: true }],
    ['AH', 'diff', 'DIFF.', 'currency', { calc: true }],
    ['AI', 'update_mat_cost_traveller', 'UPDATE MATERIAL COST IN TRAVELLER ?', 'enum', { options: YN }],
    ['AJ', 'update_mat_cost_date', 'UPDATE MATERIAL COST DATE', 'date'],
    ['AK', 'kanban_or_po', 'DOES THE SO IS KANBAN OR PO?', 'enum', { options: ['KANBAN', 'PO'] }],
    ['AL', 'so_type', 'SO TYPE', 'enum', { options: ['REPAIR', 'ROUGH', 'STANDARD'] }],
    ['AM', 'so_req_date', 'SO REQ. DATE', 'date'],
    ['AN', 'req_by', 'REQ. BY', 'text'],
    ['AO', 'appr_date', 'APPR. DATE', 'date'],
    ['AP', 'gap', 'GAP', 'number', { calc: true }],
    ['AQ', 'quote_approve_date', 'QUOTE APPROVE DATE', 'date'],
    ['AR', 'po_receive_date', 'PO Receive Date', 'date'],
    ['AS', 'po_no_1', 'PO #', 'id', { note: 'First PO # column (quote/PO section)' }],
    ['AT', 'po_mention_bar_size', 'PO MENTION BAR SIZE', 'text'],
    ['AU', 'router_vs_po', 'ROUTER VS PO?', 'number', { calc: true }],
    ['AV', 'price_on_po', 'PRICE ON PO?', 'currency'],
    ['AW', 'quote_vs_po_price', 'QUOTE VS PO PRICE', 'currency', { calc: true }],
    ['AX', 'po_approve_date', 'PO Approve Date', 'date'],
    ['AY', 'print_traveller', 'PRINT TRAVELLER', 'enum', { options: YN }],
    ['AZ', 'print_router', 'PRINT ROUTER', 'enum', { options: YN }],
    ['BA', 'print_part_prints', 'PRINT PART PRINTS', 'enum', { options: YN }],
    ['BB', 'print_req_po', 'PRINT REQ./PO', 'enum', { options: YN }],
    ['BC', 'verify_by_sakib', 'VERIFY BY SAKIB', 'enum', { options: YN }],
    ['BD', 'send_email_charllete', 'SEND EMAIL TO CHARLLETE', 'enum', { options: YN }],
    ['BE', 'date_of_send', 'DATE OF SEND', 'date'],
    ['BF', 'charllete_jay_release_date', 'CHARLLETE/JAY RELEASE DATE', 'date'],
    ['BG', 'send_image', 'SEND IMAGE?', 'enum', { options: YN }],
    ['BH', 'update_image_server', 'UPDATE IMAGE IN SERVER', 'enum', { options: YN }],
    ['BI', 'update_date', 'UPDATE DATE', 'date'],
    ['BJ', 'po_no_2', 'PO #', 'id', { note: 'Second PO # column (material receiving section)' }],
    ['BK', 'po_due_date', 'PO DUE DATE', 'date'],
    ['BL', 'mat_receive_date_stockroom', 'MAT. RECEIVE DATE IN STOCKROOM', 'date'],
    ['BM', 'verify_date', 'VERIFY DATE', 'date'],
    ['BN', 'invoice_received_finance', 'INVOICE RECEIVED BY FINANCE?', 'enum', { options: YN }],
    ['BO', 'invoice_no', 'INVOICE #', 'id'],
    ['BP', 'price_on_invoice', 'PRICE ON INVOICE?', 'currency'],
    ['BQ', 'diff_po_invoice', 'DIFF BTW PO AND INVOICE?', 'currency', { calc: true }],
    ['BR', 'diff_reason', 'DIFF. REASON?', 'text'],
    ['BS', 'update_po_price', 'UPDATE PO PRICE?', 'enum', { options: YN }],
    ['BT', 'updated_po_price', 'UPDATED PO PRICE?', 'text', { note: 'Holds both prices and dates in existing data' }],
    ['BU', 'diff_updated_po_invoice', 'DIFF BTW UPDATED PO AND INVOICE?', 'currency', { calc: true }],
    ['BV', 'qty_in_stockroom', 'QTY. IN STOCKROOM', 'text'],
    ['BW', 'invoice_checked_by', 'Invoice checked by', 'text'],
    ['BX', 'note', 'NOTE', 'longtext'],
    ['BY', 'so_close_date', 'SO CLOSE DATE', 'date']
  ];

  function colToIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  var FIELDS = RAW.map(function (r) {
    var extra = r[4] || {};
    return {
      col: r[0], index: colToIndex(r[0]), key: r[1], label: r[2], type: r[3],
      calc: !!extra.calc, options: extra.options || null, note: extra.note || '', required: !!extra.required
    };
  });
  var BY_KEY = {};
  FIELDS.forEach(function (f) { BY_KEY[f.key] = f; });

  /** Public field description for the UI. */
  function publicFields() {
    return FIELDS.map(function (f) {
      return { key: f.key, col: f.col, label: f.label, type: f.type, editable: !f.calc, options: f.options, note: f.note, required: f.required };
    });
  }

  // ---- hashing (cyrb53, deterministic in Apps Script and Node) ----
  function hash(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // ---- value normalisation ----
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function validIsoDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return d <= dim;
  }

  /**
   * Validate one user-entered value for a field.
   * @returns {{ok:true,value:*}|{ok:false,error:string}}
   */
  function validateValue(field, input) {
    if (field.calc) return { ok: false, error: field.label + ' is calculated in the sheet and cannot be edited.' };
    var v = input === null || input === undefined ? '' : input;
    if (typeof v === 'string') v = v.trim();
    if (v === '') {
      if (field.required) return { ok: false, error: field.label + ' is required and cannot be blank.' };
      return { ok: true, value: '' };
    }

    switch (field.type) {
      case 'enum':
        var hit = (field.options || []).filter(function (o) { return o.toLowerCase() === String(v).toLowerCase(); })[0];
        if (!hit) return { ok: false, error: field.label + ' must be one of: ' + field.options.join(', ') + '.' };
        return { ok: true, value: hit };
      case 'number':
      case 'currency':
        var cleaned = String(v).replace(/[$,\s]/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, error: field.label + ' must be a number.' };
        return { ok: true, value: parseFloat(cleaned) };
      case 'date':
        if (!validIsoDate(String(v))) return { ok: false, error: field.label + ' must be a valid date (YYYY-MM-DD).' };
        return { ok: true, value: String(v) };
      case 'id':
      case 'text':
      case 'longtext':
        var s = String(v);
        if (s.charAt(0) === '=') return { ok: false, error: field.label + " cannot start with '='." };
        if (s.length > (field.type === 'longtext' ? 5000 : 500)) return { ok: false, error: field.label + ' is too long.' };
        return { ok: true, value: s };
      default:
        return { ok: false, error: 'Unknown field type.' };
    }
  }

  // ---- row <-> record ----
  /** Normalise a raw sheet value for transport (Date -> ISO already done by the adapter). */
  function sameValue(a, b) {
    if (a === b) return true;
    if (a === '' || a === null || a === undefined) return b === '' || b === null || b === undefined;
    return String(a) === String(b);
  }

  /**
   * Build the record the UI sees.
   * `row` = {values:[typed], display:[strings], formulas:[strings|''], rowNumber}
   * values for dates must already be ISO strings (adapter responsibility).
   */
  function buildRecord(row, idIndex) {
    var rec = { id: null, row: row.rowNumber, values: {}, display: {}, formulaLocked: [] };
    FIELDS.forEach(function (f) {
      var typed = row.values[f.index];
      var disp = row.display[f.index];
      rec.display[f.key] = disp === undefined || disp === null ? '' : String(disp);
      if (f.calc) {
        rec.values[f.key] = rec.display[f.key];
      } else {
        rec.values[f.key] = typed === undefined || typed === null ? '' : typed;
        if (row.formulas && row.formulas[f.index]) rec.formulaLocked.push(f.key);
      }
    });
    if (idIndex !== null && idIndex !== undefined && idIndex >= 0) rec.id = row.values[idIndex] ? String(row.values[idIndex]) : null;
    rec.version = recordVersion(rec);
    return rec;
  }

  /** Version covers every editable cell + formula flags, so any change to the row is detected. */
  function recordVersion(rec) {
    var parts = FIELDS.filter(function (f) { return !f.calc; }).map(function (f) {
      return f.key + '=' + String(rec.values[f.key]);
    });
    return hash(parts.join('\u0001') + '|' + rec.formulaLocked.join(','));
  }

  function isRecordRow(row) {
    var pn = row.values[BY_KEY.part_no.index];
    var so = row.values[BY_KEY.so_no.index];
    return !!(String(pn === undefined ? '' : pn).trim() || String(so === undefined ? '' : so).trim());
  }

  /**
   * Plan an update. Pure: returns what to write or why not.
   * @param {Object} current   record from buildRecord for the row as it is now
   * @param {string} baseVersion version the user's edit was based on
   * @param {Object} changes   {key: newValue}
   */
  function planUpdate(current, baseVersion, changes) {
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'Record not found. It may have been removed or its ID changed.' };
    if (!baseVersion || baseVersion !== current.version) {
      return { ok: false, code: 'CONFLICT', error: 'This record was changed by someone else since you opened it.', current: current };
    }
    var keys = Object.keys(changes || {});
    if (!keys.length) return { ok: false, code: 'NO_CHANGES', error: 'Nothing to save.' };
    var writes = [], errors = {};
    keys.forEach(function (k) {
      var f = BY_KEY[k];
      if (!f) { errors[k] = 'Unknown field.'; return; }
      if (f.calc) { errors[k] = f.label + ' is calculated in the sheet and cannot be edited.'; return; }
      if (current.formulaLocked.indexOf(k) >= 0) { errors[k] = f.label + ' contains a formula in this row and cannot be overwritten.'; return; }
      var r = validateValue(f, changes[k]);
      if (!r.ok) { errors[k] = r.error; return; }
      if (sameValue(r.value, current.values[k])) return; // unchanged: leave the cell (and legacy text) alone
      writes.push({ key: k, field: f, value: r.value, old: current.values[k] });
    });
    if (Object.keys(errors).length) return { ok: false, code: 'INVALID', error: 'Some values are invalid.', fieldErrors: errors };
    if (!writes.length) return { ok: false, code: 'NO_CHANGES', error: 'Nothing to save.' };
    return { ok: true, writes: writes };
  }

  // ---- access control ----
  function parseEmailList(s) {
    return String(s || '').split(/[,\s;]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  }

  /** @returns 'editor' | 'viewer' | null */
  function roleFor(email, editorsCsv, viewersCsv) {
    if (!email) return null;
    var e = String(email).toLowerCase();
    if (parseEmailList(editorsCsv).indexOf(e) >= 0) return 'editor';
    if (parseEmailList(viewersCsv).indexOf(e) >= 0) return 'viewer';
    return null;
  }

  /** Check Google tokeninfo payload. */
  function checkTokenInfo(info, clientId, nowSec) {
    if (!info || !clientId) return { ok: false, error: 'Server is not configured.' };
    if (info.aud !== clientId) return { ok: false, error: 'Token was issued for a different application.' };
    if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') return { ok: false, error: 'Untrusted token issuer.' };
    if (!(Number(info.exp) > nowSec)) return { ok: false, error: 'Session expired. Please sign in again.' };
    if (String(info.email_verified) !== 'true') return { ok: false, error: 'Google email is not verified.' };
    if (!info.email) return { ok: false, error: 'No email in token.' };
    return { ok: true, email: String(info.email).toLowerCase() };
  }

  return {
    HEADER_ROW: HEADER_ROW, FIRST_DATA_ROW: FIRST_DATA_ROW, ID_HEADER: ID_HEADER,
    FIELDS: FIELDS, BY_KEY: BY_KEY, publicFields: publicFields, colToIndex: colToIndex,
    hash: hash, validateValue: validateValue, validIsoDate: validIsoDate,
    buildRecord: buildRecord, recordVersion: recordVersion, isRecordRow: isRecordRow,
    planUpdate: planUpdate, sameValue: sameValue,
    parseEmailList: parseEmailList, roleFor: roleFor, checkTokenInfo: checkTokenInfo
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOCore;
