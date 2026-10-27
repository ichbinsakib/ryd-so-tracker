/**
 * Subcontract module logic: validation, lead-time expectations (standard table + actual history),
 * order state (overdue / due soon / on track), vendor scorecards and the alert list.
 * Pure JavaScript (Node + Deno): all dates are 'YYYY-MM-DD' strings and `today` is passed in.
 */
var SOSub = (function () {
  var STATUSES = ['QUOTING', 'PO PLACED', 'IN PROCESS', 'RECEIVED', 'CANCELLED'];
  var DUE_SOON_DAYS = 7;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isDate(s) { return typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function dayNum(s) { return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function addDays(s, n) { return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10); }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
  function numOrNull(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : NaN; }
  function dateOrNull(v) { v = str(v, 10); return v === '' ? null : v; }
  function partKey(p) { return str(p).toUpperCase(); }

  function cleanOrder(o) {
    var errors = {};
    var out = {
      sc_no: str(o.sc_no, 40), so_no: str(o.so_no, 40), part_no: str(o.part_no, 80), description: str(o.description, 200),
      qty: Number(o.qty), vendor_id: str(o.vendor_id, 60) || null, status: str(o.status, 20).toUpperCase() || 'QUOTING',
      po_no: str(o.po_no, 60), notes: str(o.notes, 1000)
    };
    ['quote_date', 'po_date', 'promised_date', 'received_date'].forEach(function (k) {
      out[k] = dateOrNull(o[k]); if (out[k] && !isDate(out[k])) errors[k] = 'Use a valid date.';
    });
    ['quote_amt', 'po_amt', 'invoice_amt'].forEach(function (k) {
      out[k] = numOrNull(o[k]); if (out[k] !== null && (isNaN(out[k]) || out[k] < 0)) errors[k] = 'Enter an amount of 0 or more.';
    });
    if (!out.sc_no) errors.sc_no = 'Subcontract # is required.';
    if (!out.part_no) errors.part_no = 'Part # is required.';
    if (!out.vendor_id) errors.vendor_id = 'Choose a vendor.';
    if (!isFinite(out.qty) || out.qty <= 0) errors.qty = 'Quantity must be more than 0.';
    if (STATUSES.indexOf(out.status) < 0) errors.status = 'Unknown status.';
    if (out.po_date && out.promised_date && !errors.po_date && !errors.promised_date && out.promised_date < out.po_date) errors.promised_date = 'Promised date is before the PO date.';
    if (out.status === 'RECEIVED' && !out.received_date) errors.received_date = 'Enter the received date.';
    var steps = [];
    (Array.isArray(o.steps) ? o.steps : []).slice(0, 30).forEach(function (s, i) {
      var st = { seq: i + 1, name: str(s.name, 80), vendor_id: str(s.vendor_id, 60) || null, sent_date: dateOrNull(s.sent_date), promised_date: dateOrNull(s.promised_date), received_date: dateOrNull(s.received_date), cost: numOrNull(s.cost) };
      if (!st.name) { errors['step' + i] = 'Every step needs a name.'; }
      ['sent_date', 'promised_date', 'received_date'].forEach(function (k) { if (st[k] && !isDate(st[k])) errors['step' + i] = 'Step ' + (i + 1) + ': use valid dates.'; });
      if (st.cost !== null && (isNaN(st.cost) || st.cost < 0)) errors['step' + i] = 'Step ' + (i + 1) + ': enter a cost of 0 or more.';
      steps.push(st);
    });
    out.steps = steps;
    return { ok: Object.keys(errors).length === 0, value: out, errors: errors };
  }

  function cleanVendor(v) {
    var out = { name: str(v.name, 80), contact: str(v.contact, 80), email: str(v.email, 120), phone: str(v.phone, 40), notes: str(v.notes, 500), active: v.active !== false };
    var errors = {};
    if (!out.name) errors.name = 'Vendor name is required.';
    if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) errors.email = 'Enter a valid email.';
    return { ok: Object.keys(errors).length === 0, value: out, errors: errors };
  }

  function cleanLead(l) {
    var out = { part_no: str(l.part_no, 80), vendor_id: str(l.vendor_id, 60) || null, std_days: Number(l.std_days), notes: str(l.notes, 200) };
    var errors = {};
    if (!out.vendor_id) errors.vendor_id = 'Choose a vendor.';
    if (!isFinite(out.std_days) || out.std_days < 0 || Math.floor(out.std_days) !== out.std_days) errors.std_days = 'Days must be a whole number, 0 or more.';
    return { ok: Object.keys(errors).length === 0, value: out, errors: errors };
  }

  // Standard lead days: exact part + vendor first, then the vendor's default (blank part).
  function standardDays(order, leadTimes) {
    var pk = partKey(order.part_no), best = null;
    (leadTimes || []).forEach(function (l) {
      if (l.vendor_id !== order.vendor_id) return;
      if (partKey(l.part_no) === pk && pk) best = { days: l.std_days, source: 'part' };
      else if (!partKey(l.part_no) && !best) best = { days: l.std_days, source: 'vendor' };
    });
    return best;
  }

  // Actual history: received orders with a PO date -> days from PO to receipt, per part+vendor (and per vendor).
  function history(orders) {
    var byPart = {}, byVendor = {};
    function add(map, key, d) { var h = map[key] || (map[key] = { n: 0, sum: 0, min: d, max: d }); h.n++; h.sum += d; h.min = Math.min(h.min, d); h.max = Math.max(h.max, d); }
    (orders || []).forEach(function (o) {
      if (o.status !== 'RECEIVED' || !o.po_date || !o.received_date) return;
      var d = daysBetween(o.po_date, o.received_date); if (d < 0) return;
      add(byPart, o.vendor_id + '|' + partKey(o.part_no), d); add(byVendor, o.vendor_id, d);
    });
    function fin(h) { return h ? { n: h.n, avg: Math.round(h.sum / h.n), min: h.min, max: h.max } : null; }
    return { part: function (vendorId, part) { return fin(byPart[vendorId + '|' + partKey(part)]); }, vendor: function (vendorId) { return fin(byVendor[vendorId]); } };
  }

  // Expected receipt date: the vendor's promise when given, else PO date + standard days, else PO date + historical average.
  function describeOrder(o, ctx) {
    var today = ctx.today, open = o.status !== 'RECEIVED' && o.status !== 'CANCELLED';
    var std = standardDays(o, ctx.leadTimes), hist = ctx.history.part(o.vendor_id, o.part_no) || null;
    var expected = null, basis = '';
    if (o.promised_date) { expected = o.promised_date; basis = 'vendor promise'; }
    else if (o.po_date && std) { expected = addDays(o.po_date, std.days); basis = 'standard lead time'; }
    else if (o.po_date && hist) { expected = addDays(o.po_date, hist.avg); basis = 'past average'; }
    var state = 'no-date', lateDays = 0;
    if (o.status === 'CANCELLED') state = 'cancelled';
    else if (o.status === 'RECEIVED') {
      state = 'received';
      if (o.received_date) {
        var ref = o.promised_date || expected;
        if (ref && o.received_date > ref) { lateDays = daysBetween(ref, o.received_date); state = 'received-late'; }
      }
    } else if (expected) {
      var left = daysBetween(today, expected);
      if (left < 0) { state = 'overdue'; lateDays = -left; } else if (left <= DUE_SOON_DAYS) state = 'due-soon'; else state = 'on-track';
    }
    var actual = o.po_date ? daysBetween(o.po_date, o.received_date || today) : null;
    if (actual !== null && actual < 0) actual = null;
    return Object.assign({}, o, {
      open: open, expected: expected, basis: basis, state: state, lateDays: lateDays, actualDays: actual,
      stdDays: std ? std.days : null, stdSource: std ? std.source : '', hist: hist,
      daysToDue: open && expected ? daysBetween(today, expected) : null
    });
  }

  function scorecard(vendors, described) {
    return (vendors || []).map(function (v) {
      var mine = described.filter(function (o) { return o.vendor_id === v.id; });
      var done = mine.filter(function (o) { return o.status === 'RECEIVED'; });
      var judged = done.filter(function (o) { return o.received_date && (o.promised_date || o.expected); });
      var onTime = judged.filter(function (o) { return o.state !== 'received-late'; }).length;
      var lead = done.filter(function (o) { return o.actualDays !== null; });
      var spend = mine.reduce(function (t, o) { if (o.status === 'CANCELLED') return t; var a = o.invoice_amt != null ? o.invoice_amt : (o.po_amt != null ? o.po_amt : 0); return t + a; }, 0);
      return {
        id: v.id, name: v.name, active: v.active,
        open: mine.filter(function (o) { return o.open; }).length, overdue: mine.filter(function (o) { return o.state === 'overdue'; }).length,
        received: done.length, onTimePct: judged.length ? Math.round(100 * onTime / judged.length) : null,
        avgLead: lead.length ? Math.round(lead.reduce(function (t, o) { return t + o.actualDays; }, 0) / lead.length) : null,
        spend: Math.round(spend * 100) / 100
      };
    });
  }

  function build(raw, today) {
    var hist = history(raw.orders);
    var ctx = { today: today, leadTimes: raw.leadTimes, history: hist };
    var orders = raw.orders.map(function (o) {
      var d = describeOrder(o, ctx);
      d.steps = (raw.steps || []).filter(function (s) { return s.order_id === o.id; }).sort(function (a, b) { return a.seq - b.seq; });
      return d;
    });
    var alerts = orders.filter(function (o) { return o.state === 'overdue' || o.state === 'due-soon'; })
      .sort(function (a, b) { return (a.daysToDue || 0) - (b.daysToDue || 0); });
    var open = orders.filter(function (o) { return o.open; });
    return {
      orders: orders, vendors: scorecard(raw.vendors, orders), alerts: alerts,
      kpis: {
        open: open.length, overdue: open.filter(function (o) { return o.state === 'overdue'; }).length,
        dueSoon: open.filter(function (o) { return o.state === 'due-soon'; }).length,
        noDate: open.filter(function (o) { return o.state === 'no-date'; }).length,
        openValue: Math.round(open.reduce(function (t, o) { return t + (o.po_amt || o.quote_amt || 0); }, 0) * 100) / 100
      }
    };
  }

  return { STATUSES: STATUSES, DUE_SOON_DAYS: DUE_SOON_DAYS, isDate: isDate, daysBetween: daysBetween, addDays: addDays, cleanOrder: cleanOrder, cleanVendor: cleanVendor, cleanLead: cleanLead, standardDays: standardDays, history: history, describeOrder: describeOrder, scorecard: scorecard, build: build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOSub;
