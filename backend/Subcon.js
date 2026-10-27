/**
 * Subcontractor tracking for the coordinator (modelled on the BPO Tracking worksheet).
 * One line = one PO (SO + part + quantity) in a BPO batch. The subcontractor team executes; the coordinator
 * monitors: milestone dates, quantities by outcome, blockers, expected vs required dates, and what needs action.
 * Pure JavaScript (Node + Deno). Dates are 'YYYY-MM-DD' strings and `today` is always passed in.
 */
var SOSub = (function () {
  // key, label, what the line is waiting for while this milestone is open, core (counts toward progress)
  var MILESTONES = [
    { key: 'rfq', label: 'Requirement sent to team', waiting: 'Requirement sent', core: false },
    { key: 'po_received', label: 'PO details received', waiting: 'Awaiting PO details', core: true },
    { key: 'po_created', label: 'PO created', waiting: 'PO being created', core: false },
    { key: 'po_sent_approval', label: 'PO sent for approval', waiting: 'PO awaiting approval', core: false },
    { key: 'po_approved', label: 'PO approved', waiting: 'PO awaiting approval', core: false },
    { key: 'po_to_vendor', label: 'PO submitted to vendor', waiting: 'PO not yet with vendor', core: true },
    { key: 'ack', label: 'Vendor acknowledged', waiting: 'Awaiting acknowledgment', core: false },
    { key: 'down_payment', label: 'Down payment made', waiting: 'Awaiting down payment', core: false },
    { key: 'production_start', label: 'Production started', waiting: 'Production not started', core: true },
    { key: 'ready_to_ship', label: 'Ready to ship', waiting: 'In production', core: true },
    { key: 'vendor_ship', label: 'Vendor shipped', waiting: 'Ready, awaiting shipment', core: true },
    { key: 'forwarder_pickup', label: 'Forwarder pickup', waiting: 'Awaiting forwarder', core: false },
    { key: 'port_departure', label: 'Departed origin port', waiting: 'Awaiting departure', core: true },
    { key: 'eta_port', label: 'Estimated arrival at port', waiting: '', core: false, estimate: true },
    { key: 'arrived_port', label: 'Arrived at destination port', waiting: 'In transit', core: true },
    { key: 'eta_camco', label: 'Estimated arrival at CAMCO', waiting: '', core: false, estimate: true },
    { key: 'received_camco', label: 'Received at CAMCO', waiting: 'At port / inbound', core: true },
    { key: 'to_inspection', label: 'Moved to inspection', waiting: '', core: false },
    { key: 'to_stock', label: 'Moved to stock', waiting: 'Received, awaiting stock move', core: true }
  ];
  var CORE = MILESTONES.filter(function (m) { return m.core; }).map(function (m) { return m.key; });
  var PRIORITIES = ['NORMAL', 'HIGH', 'LINE DOWN'];
  var BLOCKERS = ['', 'Payment', 'Drawing approval', 'Missing information', 'Vendor delay', 'Port / shipping', 'Quality hold', 'Customs', 'Other'];
  var UPDATE_KINDS = ['NOTE', 'FOLLOW-UP', 'ESCALATION', 'CHANGE'];
  var CFG = { staleDays: 7, ackDays: 3, startDays: 10, dueSoonDays: 7 };
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Time spans between milestones, used for lead-time statistics and projections.
  var SEGMENTS = [
    { from: 'po_to_vendor', to: 'ready_to_ship', label: 'PO to vendor → ready to ship' },
    { from: 'ready_to_ship', to: 'port_departure', label: 'Ready to ship → departed origin port' },
    { from: 'port_departure', to: 'arrived_port', label: 'Departed → arrived at port' },
    { from: 'arrived_port', to: 'received_camco', label: 'Port arrival → received at CAMCO' },
    { from: 'received_camco', to: 'to_stock', label: 'Received → moved to stock' }
  ];

  function isDate(s) { return typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function dayNum(s) { return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function addDays(s, n) { return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10); }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
  function dateOrNull(v) { v = str(v, 10); return v === '' ? null : v; }
  function qtyOf(v) { if (v === '' || v == null) return 0; var n = Number(v); return isFinite(n) ? n : NaN; }

  function cleanLine(o) {
    var errors = {};
    var out = {
      bpo_no: str(o.bpo_no, 40), batch: str(o.batch, 40), po_no: str(o.po_no, 60), so_no: str(o.so_no, 40), part_no: str(o.part_no, 80), ryd_part: str(o.ryd_part, 80),
      description: str(o.description, 200), qty: Number(o.qty), priority: str(o.priority, 20).toUpperCase() || 'NORMAL', owner: str(o.owner, 80),
      blocker_type: str(o.blocker_type, 40), blocker: str(o.blocker, 500), next_action: str(o.next_action, 300), delay_reason: str(o.delay_reason, 500),
      note: str(o.note, 2000), escalated: o.escalated === true, closed: o.closed === true
    };
    ['sent_date', 'required_date', 'customer_due_date', 'next_action_date', 'revised_date', 'last_update'].forEach(function (k) {
      out[k] = dateOrNull(o[k]); if (out[k] && !isDate(out[k])) errors[k] = 'Use a valid date.';
    });
    ['qty_shipped', 'qty_received', 'qty_hold', 'qty_rejected', 'qty_stocked'].forEach(function (k) {
      out[k] = qtyOf(o[k]); if (isNaN(out[k]) || out[k] < 0) errors[k] = 'Enter a quantity of 0 or more.';
    });
    var ms = {};
    var src = o.ms && typeof o.ms === 'object' ? o.ms : {};
    MILESTONES.forEach(function (m) {
      var v = dateOrNull(src[m.key]); if (!v) return;
      if (!isDate(v)) errors['ms_' + m.key] = 'Use a valid date.'; else ms[m.key] = v;
    });
    out.ms = ms;
    if (!out.po_no) errors.po_no = 'PO # is required.';
    if (!out.so_no) errors.so_no = 'SO # is required.';
    if (!out.part_no) errors.part_no = 'Part # is required.';
    if (!isFinite(out.qty) || out.qty <= 0) errors.qty = 'Quantity must be more than 0.';
    if (PRIORITIES.indexOf(out.priority) < 0) errors.priority = 'Unknown priority.';
    if (BLOCKERS.indexOf(out.blocker_type) < 0) errors.blocker_type = 'Unknown blocker type.';
    if (isFinite(out.qty) && out.qty > 0 && !errors.qty_stocked && out.qty_stocked + out.qty_rejected > out.qty) errors.qty_stocked = 'Stocked + rejected cannot be more than the requested quantity.';
    if (out.closed && !Object.keys(errors).length) {
      var miss = completionGaps(out);
      if (miss.length) errors.closed = 'Cannot close yet: ' + miss.join('; ') + '.';
    }
    return { ok: Object.keys(errors).length === 0, value: out, errors: errors };
  }

  // What must be true before the coordinator can close a line.
  function completionGaps(l) {
    var gaps = [], ms = l.ms || {};
    if (!ms.received_camco) gaps.push('enter the date it was received at CAMCO');
    if (!ms.to_stock) gaps.push('enter the date it was moved to stock');
    var open = l.qty - (l.qty_stocked || 0) - (l.qty_rejected || 0);
    if (open > 0) gaps.push(open + ' pcs not yet stocked or rejected');
    if ((l.qty_hold || 0) > 0) gaps.push((l.qty_hold) + ' pcs still on hold');
    return gaps;
  }

  function cleanUpdate(u) {
    var kind = str(u.kind, 20).toUpperCase() || 'NOTE', text = str(u.text, 2000), errors = {};
    if (UPDATE_KINDS.indexOf(kind) < 0) errors.kind = 'Unknown update type.';
    if (!text) errors.text = 'Write the update.';
    return { ok: !Object.keys(errors).length, value: { kind: kind, text: text }, errors: errors };
  }

  // A core milestone counts as done when it has a date, or when any later core milestone has one (skipped steps).
  function coreDone(ms) {
    var last = -1;
    CORE.forEach(function (k, i) { if (ms[k]) last = i; });
    return CORE.map(function (k, i) { return !!ms[k] || i < last; });
  }

  function describe(l, today, cfg) {
    cfg = cfg || CFG;
    var ms = l.ms || {}, done = coreDone(ms);
    var doneCount = done.filter(Boolean).length;
    var nextIdx = done.indexOf(false);
    var nextKey = nextIdx < 0 ? null : CORE[nextIdx];
    var nextMs = MILESTONES.filter(function (m) { return m.key === nextKey; })[0];
    var remaining = Math.max(0, l.qty - (l.qty_stocked || 0) - (l.qty_rejected || 0));
    var complete = !!ms.received_camco && !!ms.to_stock && remaining === 0 && !(l.qty_hold > 0);
    var received = !!ms.received_camco;
    var open = !l.closed;
    var expected = ms.received_camco || ms.eta_camco || l.revised_date || l.required_date || null;
    var late = 0, forecastLate = 0, lastUpdateAge = null;
    if (open && !received && l.required_date) {
      if (today > l.required_date) late = daysBetween(l.required_date, today);
      if (expected && expected > l.required_date) forecastLate = daysBetween(l.required_date, expected);
    }
    if (l.last_update) lastUpdateAge = daysBetween(l.last_update, today);
    var out = Object.assign({}, l, {
      open: open, complete: complete, progress: Math.round(100 * doneCount / CORE.length), stage: complete ? 'Completed' : (nextMs ? nextMs.waiting : 'Received, awaiting stock move'),
      nextKey: nextKey, remaining: remaining, expected: expected, pastDue: late, forecastLate: forecastLate, lastUpdateAge: lastUpdateAge,
      daysToRequired: l.required_date ? daysBetween(today, l.required_date) : null, gaps: completionGaps(l)
    });
    out.reasons = open ? reasonsFor(out, today, cfg) : [];
    out.attention = out.reasons.some(function (r) { return r.level === 'crit'; }) ? 'crit' : (out.reasons.length ? 'warn' : 'ok');
    out.action = out.reasons.length ? out.reasons[0].action : '';
    return out;
  }

  function reasonsFor(d, today, cfg) {
    var r = [], ms = d.ms || {}, urgent = d.priority !== 'NORMAL';
    function add(level, code, text, action) { r.push({ level: level, code: code, text: text, action: action }); }
    if (d.escalated) add('crit', 'escalated', 'Escalated', 'Follow the escalation with the team lead and record the outcome.');
    if (d.qty_hold > 0) add('crit', 'hold', d.qty_hold + ' pcs on hold', 'Get the hold reason and a release / rework date from quality.');
    if (d.pastDue > 0) add('crit', 'past-due', 'Past due ' + d.pastDue + ' d', 'Ask the team for a firm revised date and record the delay reason.');
    if (d.forecastLate > 0 && !d.pastDue) add(urgent ? 'crit' : 'warn', 'forecast-late', 'Expected ' + d.forecastLate + ' d after required date', urgent ? 'Escalate: this ' + d.priority + ' order will miss the required date.' : 'Check if the date can be recovered or warn the SO owner.');
    if (d.blocker) add(urgent ? 'crit' : 'warn', 'blocked', 'Blocked' + (d.blocker_type ? ': ' + d.blocker_type : ''), 'Chase the blocker: ' + (d.blocker_type || d.blocker).toLowerCase() + '.');
    if (ms.po_to_vendor && !ms.ack && !ms.production_start && daysBetween(ms.po_to_vendor, today) >= cfg.ackDays) add('warn', 'no-ack', 'Not acknowledged ' + daysBetween(ms.po_to_vendor, today) + ' d after PO', 'Ask the team to confirm they received the PO.');
    if (ms.po_to_vendor && !ms.production_start && daysBetween(ms.po_to_vendor, today) >= cfg.startDays) add('warn', 'not-started', 'Production not started ' + daysBetween(ms.po_to_vendor, today) + ' d after PO', 'Ask for the planned start date and what is holding it.');
    if (d.lastUpdateAge === null ? !d.complete : d.lastUpdateAge > cfg.staleDays) add('warn', 'stale', d.lastUpdateAge === null ? 'No update yet' : 'No update for ' + d.lastUpdateAge + ' d', 'Request a status update from the team.');
    if (d.next_action_date && d.next_action_date < today) add('warn', 'action-overdue', 'Follow-up was due ' + shortDate(d.next_action_date), d.next_action || 'Do the planned follow-up.');
    if (d.complete && d.open) add('warn', 'verify', 'Complete: verify and close', 'Check quantities and close the record.');
    return r.sort(function (a, b) { return (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1); });
  }
  function shortDate(s) { return s.slice(5).replace('-', '/'); }

  // Lead-time statistics from completed spans between milestones.
  function leadStats(lines) {
    return SEGMENTS.map(function (sg) {
      var vals = [], skipped = 0;
      lines.forEach(function (l) {
        var a = l.ms && l.ms[sg.from], b = l.ms && l.ms[sg.to]; if (!a || !b) return;
        var d = daysBetween(a, b); if (d < 0) { skipped++; return; } vals.push(d);
      });
      vals.sort(function (x, y) { return x - y; });
      var n = vals.length;
      return { from: sg.from, to: sg.to, label: sg.label, n: n, skipped: skipped, avg: n ? Math.round(vals.reduce(function (t, x) { return t + x; }, 0) / n) : null, min: n ? vals[0] : null, max: n ? vals[n - 1] : null, median: n ? vals[Math.floor((n - 1) / 2)] : null };
    });
  }

  // Project the date a line will be received at CAMCO from past spans, starting at the latest dated milestone in the chain.
  function projectReceipt(l, stats) {
    var ms = l.ms || {}; if (ms.received_camco) return null;
    var chain = ['po_to_vendor', 'ready_to_ship', 'port_departure', 'arrived_port', 'received_camco'], last = -1;
    chain.forEach(function (k, i) { if (ms[k]) last = i; });
    if (last < 0) return null;
    var total = 0;
    for (var i = last; i < chain.length - 1; i++) {
      var s = stats.filter(function (x) { return x.from === chain[i] && x.to === chain[i + 1]; })[0];
      if (!s || s.n < 3) return null; total += s.avg;
    }
    return addDays(ms[chain[last]], total);
  }

  function batches(described) {
    var map = {}, order = [];
    described.forEach(function (d) {
      var k = d.bpo_no + '|' + d.batch; if (!map[k]) { map[k] = { bpo_no: d.bpo_no, batch: d.batch, lines: [] }; order.push(k); }
      map[k].lines.push(d);
    });
    return order.map(function (k) {
      var b = map[k], ls = b.lines, open = ls.filter(function (d) { return d.open; });
      var stages = {}; open.forEach(function (d) { stages[d.stage] = (stages[d.stage] || 0) + 1; });
      var req = ls.map(function (d) { return d.required_date; }).filter(Boolean).sort(), exp = ls.map(function (d) { return d.expected; }).filter(Boolean).sort();
      return {
        bpo_no: b.bpo_no, batch: b.batch, lines: ls.length, open: open.length, qty: ls.reduce(function (t, d) { return t + d.qty; }, 0), remaining: ls.reduce(function (t, d) { return t + d.remaining; }, 0),
        progress: ls.length ? Math.round(ls.reduce(function (t, d) { return t + d.progress; }, 0) / ls.length) : 0, stages: stages,
        required: req.length ? req[req.length - 1] : null, expected: exp.length ? exp[exp.length - 1] : null,
        crit: open.filter(function (d) { return d.attention === 'crit'; }).length, warn: open.filter(function (d) { return d.attention === 'warn'; }).length,
        pastDue: open.filter(function (d) { return d.pastDue > 0; }).length
      };
    });
  }

  function build(rawLines, today, cfg) {
    var described = rawLines.map(function (l) { return describe(l, today, cfg); });
    var stats = leadStats(described);
    described.forEach(function (d) { d.projected = d.open ? projectReceipt(d, stats) : null; });
    var open = described.filter(function (d) { return d.open; });
    var rank = { crit: 0, warn: 1, ok: 2 };
    var queue = open.filter(function (d) { return d.attention !== 'ok'; }).sort(function (a, b) {
      var p = PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority);
      return rank[a.attention] - rank[b.attention] || p || (a.daysToRequired == null ? 1e9 : a.daysToRequired) - (b.daysToRequired == null ? 1e9 : b.daysToRequired);
    });
    function has(d, code) { return d.reasons.some(function (r) { return r.code === code; }); }
    return {
      lines: described, queue: queue.map(function (d) { return d.id; }), batches: batches(described), leadStats: stats,
      kpis: {
        open: open.length, needsAction: queue.length, critical: open.filter(function (d) { return d.attention === 'crit'; }).length,
        pastDue: open.filter(function (d) { return d.pastDue > 0; }).length, forecastLate: open.filter(function (d) { return d.forecastLate > 0; }).length,
        blocked: open.filter(function (d) { return d.blocker || d.qty_hold > 0; }).length, stale: open.filter(function (d) { return has(d, 'stale'); }).length,
        noAck: open.filter(function (d) { return has(d, 'no-ack'); }).length, toVerify: open.filter(function (d) { return has(d, 'verify'); }).length,
        openQty: open.reduce(function (t, d) { return t + d.remaining; }, 0)
      }
    };
  }

  return {
    MILESTONES: MILESTONES, CORE: CORE, PRIORITIES: PRIORITIES, BLOCKERS: BLOCKERS, UPDATE_KINDS: UPDATE_KINDS, SEGMENTS: SEGMENTS, CFG: CFG,
    isDate: isDate, daysBetween: daysBetween, addDays: addDays, cleanLine: cleanLine, cleanUpdate: cleanUpdate, completionGaps: completionGaps,
    describe: describe, leadStats: leadStats, projectReceipt: projectReceipt, batches: batches, build: build
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOSub;
