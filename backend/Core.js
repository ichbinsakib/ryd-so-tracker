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

  /** @returns 'admin' | 'editor' | 'viewer' | null  (admins can also edit) */
  function roleFor(email, editorsCsv, viewersCsv, adminsCsv) {
    if (!email) return null;
    var e = String(email).toLowerCase();
    if (parseEmailList(adminsCsv).indexOf(e) >= 0) return 'admin';
    if (parseEmailList(editorsCsv).indexOf(e) >= 0) return 'editor';
    if (parseEmailList(viewersCsv).indexOf(e) >= 0) return 'viewer';
    return null;
  }

  // ---- stockroom price check ----
  var PRICE_TOLERANCE = 0.005;
  var MAX_STOCK_ROWS = 20000;

  function normalizePart(p) {
    return String(p === undefined || p === null ? '' : p).trim().toUpperCase().replace(/\s+/g, ' ');
  }

  /** Parses 11.79, "$ 11.79 ", "1,416.50". Returns null for "-", "", text. */
  function parsePrice(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return parseFloat(s);
  }

  /** rows: [[part, price], ...] -> {PART: [prices]} */
  function buildStockIndex(rows) {
    var idx = {};
    (rows || []).forEach(function (r) {
      var k = normalizePart(r[0]);
      var p = parsePrice(r[1]);
      if (!k || p === null) return;
      (idx[k] = idx[k] || []).push(p);
    });
    return idx;
  }

  /**
   * Compare a record's PART PRICE (worksheet) to the uploaded stockroom prices.
   * state: 'none' (nothing to compare) | 'ok' | 'issue'
   */
  function priceCheck(rec, index, hasStock) {
    if (!hasStock) return { state: 'none' };
    var part = normalizePart(rec.values.part_no);
    if (!part) return { state: 'none' };
    var appPrice = parsePrice(rec.display.part_price);
    var list = index[part];
    if (!list) return { state: 'issue', reason: 'Part not found in the stockroom sheet', appPrice: appPrice, stockPrices: [] };
    if (appPrice === null) return { state: 'issue', reason: 'No part price in the worksheet', appPrice: null, stockPrices: list };
    var ok = list.some(function (p) { return Math.abs(p - appPrice) < PRICE_TOLERANCE; });
    return ok
      ? { state: 'ok', appPrice: appPrice, stockPrices: list }
      : { state: 'issue', reason: 'Price differs from the stockroom sheet', appPrice: appPrice, stockPrices: list };
  }

  /** Validate rows sent by an admin upload: [{part, price}]. */
  function validateStockUpload(rows) {
    if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'The file has no rows to import.' };
    if (rows.length > MAX_STOCK_ROWS) return { ok: false, error: 'Too many rows (limit ' + MAX_STOCK_ROWS + ').' };
    var clean = [], skipped = 0;
    rows.forEach(function (r) {
      var part = r && typeof r.part === 'string' ? r.part.trim() : (r && typeof r.part === 'number' ? String(r.part) : '');
      var price = r ? parsePrice(r.price) : null;
      if (!part || part.length > 100 || part.charAt(0) === '=' || price === null || price < 0) { skipped++; return; }
      clean.push([part, price]);
    });
    if (!clean.length) return { ok: false, error: 'No valid part number + price rows were found. Check the column choice.' };
    return { ok: true, rows: clean, skipped: skipped };
  }

  // ---- STEEL USAGE lookup check + upload ----
  var LOOKUP_KEYS = ['steel_type', 'router_bar_size', 'qty_per_bar'];

  /** For records with a part number: is each STEEL USAGE-driven value present? */
  function lookupChecks(rec) {
    if (!normalizePart(rec.values.part_no)) return null;
    var out = {};
    LOOKUP_KEYS.forEach(function (k) {
      var raw = rec.display[k];
      var v = String(raw === undefined || raw === null ? '' : raw).trim();
      var label = BY_KEY[k].label;
      if (v === '' || v === '-' || v.charAt(0) === '#') out[k] = { state: 'issue', reason: 'No ' + label + ' found in STEEL USAGE for this part' };
      else if (k === 'qty_per_bar' && parsePrice(v) === 0) out[k] = { state: 'issue', reason: label + ' is 0 in STEEL USAGE' };
      else out[k] = { state: 'ok' };
    });
    return out;
  }

  /** Cell text that Sheets would treat as a formula must never be written. */
  function safeCellText(v, max) {
    var s = String(v === undefined || v === null ? '' : v).trim();
    if (s.length > max) return null;
    var c = s.charAt(0);
    if (c === '=' || c === '+' || c === '@') return null;
    if (c === '-' && s.length > 1 && !/^-[0-9.]+$/.test(s)) return null;
    return s;
  }

  /** rows: [{part, steel, qty, router}] -> [[part, steel, qty, router]] */
  function validateSteelUpload(rows) {
    if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'The file has no rows to import.' };
    if (rows.length > MAX_STOCK_ROWS) return { ok: false, error: 'Too many rows (limit ' + MAX_STOCK_ROWS + ').' };
    var clean = [], skipped = 0;
    rows.forEach(function (r) {
      if (!r) { skipped++; return; }
      var part = safeCellText(r.part, 100), steel = safeCellText(r.steel, 300), qty = safeCellText(r.qty, 50), router = safeCellText(r.router, 50);
      if (!part || steel === null || qty === null || router === null) { skipped++; return; }
      clean.push([part, steel, qty, router]);
    });
    if (!clean.length) return { ok: false, error: 'No valid rows were found. Check the column choice.' };
    return { ok: true, rows: clean, skipped: skipped };
  }

  // ---- Opening a new SO (intake form), dashboard rows, scan uploads ----
  var INTAKE_KEYS = ['so_no', 'part_no', 'customer', 'champion', 'so_qty', 'due_date', 'so_type', 'kanban_or_po', 'req_by', 'so_req_date', 'notes'];
  var INTAKE_REQUIRED = ['so_no', 'part_no', 'customer', 'champion', 'so_qty', 'due_date', 'so_type', 'kanban_or_po', 'req_by', 'so_req_date'];
  var NEW_SO_STATUS = '3.OPEN';

  function intakeInfo() { return { keys: INTAKE_KEYS.slice(), required: INTAKE_REQUIRED.slice() }; }

  function normSo(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); }

  /**
   * Validate the "Open an SO" form. existingSoNos: array of SO# values already in the sheet.
   * Returns {ok:true, writes:[{key, field, value}]} or {ok:false, code, error, fieldErrors}.
   */
  function planCreate(changes, existingSoNos) {
    var errors = {}, writes = [];
    changes = changes || {};
    Object.keys(changes).forEach(function (k) {
      if (INTAKE_KEYS.indexOf(k) < 0) errors[k] = 'This field cannot be set when opening an SO.';
    });
    INTAKE_KEYS.forEach(function (k) {
      if (errors[k]) return;
      var f = BY_KEY[k];
      var r = validateValue(f, changes[k]);
      if (!r.ok) { errors[k] = r.error; return; }
      if (r.value === '') {
        if (INTAKE_REQUIRED.indexOf(k) >= 0) errors[k] = f.label + ' is required.';
        return;
      }
      writes.push({ key: k, field: f, value: r.value });
    });
    var so = writes.filter(function (w) { return w.key === 'so_no'; })[0];
    if (so && !errors.so_no) {
      var taken = (existingSoNos || []).some(function (x) { return normSo(x) === normSo(so.value); });
      if (taken) errors.so_no = 'SO# ' + so.value + ' already exists.';
    }
    if (Object.keys(errors).length) return { ok: false, code: 'INVALID', error: 'Please fix the highlighted fields.', fieldErrors: errors };
    writes.push({ key: 'status', field: BY_KEY.status, value: NEW_SO_STATUS });
    return { ok: true, writes: writes };
  }

  function pctNum(t) {
    var s = String(t === undefined || t === null ? '' : t);
    if (s.indexOf('%') < 0) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /** The only data the admin dashboard needs per SO. */
  function dashboardRow(rec) {
    return {
      id: rec.id, so_no: rec.values.so_no, part_no: rec.values.part_no, customer: rec.values.customer,
      status: rec.values.status, soBar: pctNum(rec.display.so_release_status_bar), matBar: pctNum(rec.display.mat_status_bar)
    };
  }

  var SCAN_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
  var MAX_SCAN_BYTES = 7 * 1024 * 1024;

  /** Validate an uploaded scan (base64 body). Returns {ok, name, mime, bytes} or {ok:false, error}. */
  function validateScanUpload(fileName, mime, b64) {
    var ext = SCAN_TYPES[mime];
    if (!ext) return { ok: false, error: 'Only PDF, JPG or PNG scans are accepted.' };
    if (typeof b64 !== 'string' || !b64.length || !/^[A-Za-z0-9+\/]+={0,2}$/.test(b64)) return { ok: false, error: 'The file data is not valid.' };
    var bytes = Math.floor(b64.length * 3 / 4) - (b64.slice(-2) === '==' ? 2 : b64.slice(-1) === '=' ? 1 : 0);
    if (bytes > MAX_SCAN_BYTES) return { ok: false, error: 'The scan is too large (limit 7 MB).' };
    if (bytes < 100) return { ok: false, error: 'The file looks empty.' };
    var base = String(fileName || 'scan').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 60) || 'scan';
    return { ok: true, name: base + '.' + ext, mime: mime, bytes: bytes };
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
    parseEmailList: parseEmailList, roleFor: roleFor, checkTokenInfo: checkTokenInfo,
    normalizePart: normalizePart, parsePrice: parsePrice, buildStockIndex: buildStockIndex,
    priceCheck: priceCheck, validateStockUpload: validateStockUpload,
    lookupChecks: lookupChecks, validateSteelUpload: validateSteelUpload, safeCellText: safeCellText,
    INTAKE_KEYS: INTAKE_KEYS, INTAKE_REQUIRED: INTAKE_REQUIRED, intakeInfo: intakeInfo, planCreate: planCreate, normSo: normSo,
    dashboardRow: dashboardRow, pctNum: pctNum, validateScanUpload: validateScanUpload, MAX_SCAN_BYTES: MAX_SCAN_BYTES
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOCore;
