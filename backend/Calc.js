/**
 * The calculated columns of the order sheet, ported from its formulas so the app can run
 * without a spreadsheet. Pure JavaScript (Node + Deno). Each result is {value, display}.
 *
 * Lookups (the sheet's VLOOKUPs) are passed in:
 *   ctx.stockByPart(key)  -> {quantity, unitPrice} | null   (the sheet's 'STOCK ' tab: PartNumber, TotalQuantity, UnitPrice)
 *   ctx.steelByPart(key)  -> {steelType, qtyPerBar, routerBarSize} | null   (STEEL USAGE columns B, C, D)
 */
var SOCalc = (function () {
  var Core = {};
  function bindCore() {
    if (Core.FIELDS) return;
    var c = (typeof SOCore !== 'undefined') ? SOCore : require('./Core.js');
    for (var k in c) Core[k] = c[k];
  }

  function blank(v) { return v === undefined || v === null || String(v).trim() === ''; }
  var ERR = { err: true };

  function isoToSerial(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  /** Spreadsheet-style number coercion: blank = 0, "$1,200.50" = 1200.5, ISO date = serial, other text = NaN. */
  function num(v) {
    if (blank(v)) return 0;
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    var d = isoToSerial(s);
    if (!isNaN(d)) return d;
    var c = s.replace(/[$,\s]/g, '');
    return /^-?\d+(\.\d+)?$/.test(c) ? parseFloat(c) : NaN;
  }

  function round(n, dp) { var f = Math.pow(10, dp); return Math.round(n * f) / f; }
  function fmtNum(n) { return String(round(n, 4)); }
  function fmtMoney(n) {
    var neg = n < 0, s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$ ' : '$ ') + s;
  }
  function fmtPct(x) { return Math.round(x * 100) + '%'; }

  function ok(value, display) { return { value: value, display: display === undefined ? String(value) : display }; }
  function text(s) { return { value: s, display: s }; }
  var ERROR = { value: '#VALUE!', display: '#VALUE!' };

  /** Number written before the first apostrophe of a router bar size like "12' ..." (null if none). */
  function feetOf(router) {
    var s = String(router === undefined || router === null ? '' : router), i = s.indexOf("'");
    if (i < 1) return null;
    var n = num(s.slice(0, i));
    return isNaN(n) ? null : n;
  }

  function counta(d, from, to) {
    var typed = 0, calc = 0;
    Core.FIELDS.forEach(function (f) {
      if (f.index < from || f.index > to) return;
      if (f.calc) calc++; else if (!blank(d[f.key])) typed++;   // formula cells count as non-empty, as COUNTA does
    });
    return { n: typed + calc, cols: to - from + 1 };
  }

  function rowCalc(d, ctx) {
    bindCore();
    var K = Core.BY_KEY;
    var part = Core.normalizePart(d.part_no);
    var steel = part && ctx.steelByPart ? ctx.steelByPart(part) : null;
    var stockPart = part && ctx.stockByPart ? ctx.stockByPart(part) : null;
    var out = {};

    function bar(from, to) {
      if (blank(d.part_no)) return text('');
      var c = counta(d, from, to);
      return text(c.n === 0 ? '0%' : fmtPct(c.n / c.cols));
    }
    out.so_release_status_bar = function () { return bar(K.part_no.index, K.update_date.index); };       // G..BI
    out.mat_status_bar = function () { return bar(K.po_due_date.index, K.diff_updated_po_invoice.index); }; // BK..BU

    out.part_price = function () { return stockPart && stockPart.unitPrice !== null ? ok(stockPart.unitPrice, ' ' + fmtMoney(stockPart.unitPrice) + ' ') : text('-'); };
    out.steel_type = function () { return steel ? text(String(steel.steelType)) : text('-'); };
    out.router_bar_size = function () { return steel ? text(String(steel.routerBarSize)) : text('-'); };
    out.qty_per_bar = function () { return steel ? ok(steel.qtyPerBar, String(steel.qtyPerBar)) : text('-'); };

    var reqBar;
    out.req_bar = function () {
      if (reqBar) return reqBar;
      var p = steel ? num(steel.qtyPerBar) : NaN, q = num(d.so_qty);
      reqBar = (isNaN(p) || isNaN(q) || p === 0 || !steel) ? text('-') : ok(q / p, fmtNum(q / p));
      return reqBar;
    };
    var reqFt;
    out.req_ft = function () {
      if (reqFt) return reqFt;
      if (blank(d.part_no)) { reqFt = text('-'); return reqFt; }
      var router = steel ? steel.routerBarSize : '-', ft = feetOf(router), bars = out.req_bar();
      reqFt = (ft === null || typeof bars.value !== 'number') ? ok(0, '0') : ok(ft * bars.value, fmtNum(ft * bars.value));
      return reqFt;
    };
    out.req_lbs = function () {
      var bt = String(d.bar_type === undefined || d.bar_type === null ? '' : d.bar_type), ft = out.req_ft();
      function dia() {
        var m = String(d.material_code === undefined || d.material_code === null ? '' : d.material_code), i = m.indexOf(' ');
        if (i < 1) return NaN;
        return num(m.slice(0, i));
      }
      var inches = typeof ft.value === 'number' ? ft.value * 12 : NaN, x;
      if (bt === 'RD' || bt === 'RD-AL') {
        x = dia(); if (isNaN(x) || isNaN(inches)) return ERROR;
        var r1 = Math.round(Math.PI * Math.pow(x / 2, 2) * inches * (bt === 'RD' ? 0.283 : 0.098));
        return ok(r1);
      }
      if (bt === 'SQ') {
        x = dia(); if (isNaN(x) || isNaN(inches)) return ERROR;
        return ok(Math.round(Math.pow(x, 2) * inches * 0.283));
      }
      if (bt === 'REC.') return text('lbs=(HEIGHT * WIDTH)×(Length×12)×0.283');
      if (bt === 'FLAT') return text('lbs=((WIDTH×THICKNESS)×12)×(Length×12)×0.283');
      if (bt === 'TUBING') return text('lbs=π×((OD^2−ID^2)/4)×(Length in inches)×Density (lb/in³)');
      return ok(0);
    };
    out.avail_ft = function () {
      var s = blank(d.material_code) ? null : (ctx.stockByPart ? ctx.stockByPart(Core.normalizePart(d.material_code)) : null);
      return s && s.quantity !== null ? ok(s.quantity) : text('-');
    };
    out.email_template = function () { return text('Send Email'); };

    out.quote_price_piece = function () {
      var a = num(d.total_price_quote), q = num(d.so_qty);
      return (isNaN(a) || isNaN(q) || q === 0) ? text('-') : ok(a / q, fmtMoney(a / q));
    };
    var qpp;
    out.diff = function () {
      qpp = qpp || out.quote_price_piece();
      var a = num(d.traveller_mat_price_piece);
      return (isNaN(a) || typeof qpp.value !== 'number') ? text('') : ok(a - qpp.value, fmtMoney(a - qpp.value));
    };
    out.gap = function () {
      if (blank(d.appr_date) || blank(d.so_req_date)) return text('');
      var a = num(d.appr_date), b = num(d.so_req_date);
      return (isNaN(a) || isNaN(b)) ? text('') : ok(a - b);
    };
    out.router_vs_po = function () {
      var ft = feetOf(steel ? steel.routerBarSize : '-'), a = num(d.po_mention_bar_size);
      return (ft === null || isNaN(a)) ? text('-') : ok(round(a - ft, 4));
    };
    out.quote_vs_po_price = function () {
      var a = num(d.price_on_po), b = num(d.total_price_quote);
      return (isNaN(a) || isNaN(b)) ? text('-') : ok(a - b, fmtMoney(a - b));
    };
    out.diff_po_invoice = function () {
      var a = num(d.price_on_invoice), b = num(d.price_on_po);
      return (isNaN(a) || isNaN(b)) ? ERROR : ok(a - b, fmtMoney(a - b));
    };
    out.diff_updated_po_invoice = function () {
      var a = num(d.updated_po_price), b = num(d.price_on_invoice);
      return (isNaN(a) || isNaN(b)) ? ERROR : ok(a - b, fmtMoney(a - b));
    };
    return out;
  }

  /** Value of one calculated column for one row (data keyed by field key). */
  function calcOne(key, d, ctx) {
    var table = rowCalc(d, ctx);
    return table[key] ? table[key]() : text('');
  }

  return { rowCalc: rowCalc, calcOne: calcOne, num: num, fmtMoney: fmtMoney };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOCalc;
