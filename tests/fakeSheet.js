// In-memory stand-in for the RYD-SO sheet. Used by unit tests and the local dev mock server.
// All data here is synthetic. Never put real operational data in the repository.
const Core = require('../backend/Core.js');

const NCOLS = 78; // A..BY (77 columns) + RECORD ID
const ID_INDEX = 77;

function emptyRow() { return new Array(NCOLS).fill(''); }

function makeRow(rowNumber, id, fields, formulas = {}) {
  const values = emptyRow();
  const formulaArr = new Array(NCOLS).fill('');
  for (const [k, v] of Object.entries(fields)) values[Core.BY_KEY[k].index] = v;
  for (const [k, f] of Object.entries(formulas)) formulaArr[Core.BY_KEY[k].index] = f;
  values[ID_INDEX] = id;
  return { rowNumber, values, display: values.map(String), formulas: formulaArr };
}

function seedRows() {
  return [
    makeRow(3, 'id-1', { status: '1. ANALYSIS', champion: 'ALPHA', customer: 'ACME', part_no: '838-004-428', so_qty: 1200, due_date: '2026-11-05', so_no: 25712, notes: 'Stock-27 weeks', bar_type: 'RD', so_release_status_bar: '35%', part_price: ' $ 11.79 ' }),
    makeRow(4, 'id-2', { status: '3.OPEN', customer: 'ACME', part_no: '00123', so_qty: 770, so_no: 'R24449', part_price: ' $ 2.49 ', req_mat_quote: 'YES', price_on_po: 319.95, total_price_quote: 398 }, { total_price_quote: '=275*7.53' }),
    makeRow(5, 'id-3', { status: '4.CLOSE', customer: 'GLOBEX', part_no: '1078364', so_qty: 50, so_no: 25692, po_receive_date: '8-Oct' }),
    makeRow(6, '', {}), makeRow(7, '', {}), makeRow(8, '', {})
  ];
}

class FakeSheet {
  constructor(rows = seedRows(), opts = {}) {
    this.rows = rows;
    this.idIndex = opts.noIdColumn ? -1 : ID_INDEX;
    this.auditLog = [];
    this.locked = false;
    this.stock = [];
    this.stockMeta = null;
    this.tokens = opts.tokens || {
      'tok-editor': { email: 'editor@example.com' },
      'tok-viewer': { email: 'viewer@example.com' },
      'tok-stranger': { email: 'stranger@example.com' },
      'tok-admin': { email: 'admin@example.com' }
    };
  }
  verifyToken(t) { const x = this.tokens[t]; return x ? { ok: true, email: x.email } : { ok: false, error: 'Session expired or invalid. Please sign in again.' }; }
  config() { return { editors: 'editor@example.com', viewers: 'viewer@example.com', admins: 'admin@example.com' }; }
  newId() { this.idCounter = (this.idCounter || 0) + 1; return 'new-id-' + this.idCounter; }
  saveScan(s) { this.scans = this.scans || []; const e = { fileId: 'file-' + (this.scans.length + 1), name: s.name, mime: s.mime, at: s.at, by: s.user, recordId: s.recordId, soNo: s.soNo, data: s.data }; this.scans.push(e); return { fileId: e.fileId, name: e.name, at: e.at, by: e.by }; }
  listScans(recordId) { return (this.scans || []).filter(x => x.recordId === recordId).map(x => ({ fileId: x.fileId, name: x.name, at: x.at, by: x.by })); }
  readScan(fileId) { const x = (this.scans || []).find(s => s.fileId === fileId); return { mime: x.mime, data: x.data }; }
  saveSteelMeta(m) { this.steelMetaSaved = m; }
  readSteelMeta() { return this.steelMetaSaved || null; }
  readStock() { return { rows: this.stock.map(r => r.slice()), meta: this.stockMeta }; }
  writeSteelUsage(rows, meta) { const previousRows = (this.steel || []).length; this.steelPrevious = this.steel || []; this.steel = rows.map(r => r.slice()); this.steelMeta = meta; return { previousRows }; }
  writeStock(rows, meta) { this.stock = rows.map(r => r.slice()); this.stockMeta = meta; }
  now() { return '2026-10-16T12:00:00.000Z'; }
  readAll() { return { idIndex: this.idIndex, rows: this.rows.map(r => JSON.parse(JSON.stringify(r))) }; }
  readUsers() { return (this.users || []).map((u) => Object.assign({}, u)); }
  writeUsers(list) { this.users = list.map((u) => Object.assign({}, u)); }
  getIdIndex() { return this.idIndex; }
  readColumns(indexes, display) {
    return this.rows.map((r) => {
      const values = {};
      indexes.forEach((i) => { values[i] = display ? r.display[i] : r.values[i]; });
      return { rowNumber: r.rowNumber, values };
    });
  }
  readRow(n) { return JSON.parse(JSON.stringify(this.rows.find(r => r.rowNumber === n))); }
  writeCells(n, cells) {
    const row = this.rows.find(r => r.rowNumber === n);
    for (const c of cells) { row.values[c.index] = c.value; row.display[c.index] = String(c.value); }
  }
  audit(e) { this.auditLog.push(e); }
  withLock(fn) {
    if (this.locked) throw { code: 'BUSY' };
    this.locked = true;
    try { return fn(); } finally { this.locked = false; }
  }
}

module.exports = { FakeSheet, makeRow, seedRows, ID_INDEX };
