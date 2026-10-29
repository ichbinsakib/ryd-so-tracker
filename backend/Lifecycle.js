/**
 * Shop Order lifecycle: where an SO is in the 13-stage workflow, what is waiting on whom, what the next action is,
 * and whether it needs the coordinator's attention. Pure JavaScript (Node, Deno and the browser: the frontend gets a
 * generated copy as frontend/lifecycle.js). Nothing is assumed complete without evidence in the record.
 *
 * describe(d, today): d = the record's values by field key as strings (dates ISO or M/D/YYYY, calculated fields as shown),
 * today = ISO date string. Returns the result documented at the end of describe().
 */
var SOLife = (function () {
  var STAGES = [
    ['decide', 'Decide'], ['qty', 'Quantity'], ['quoteReq', 'Quote request'], ['quoteAnalysis', 'Quote analysis'], ['soReq', 'SO request'],
    ['soNo', 'SO number'], ['po', 'PO'], ['ack', 'Acknowledgment'], ['docs', 'Documents'], ['release', 'Release'],
    ['material', 'Material arrival'], ['monitor', 'Monitoring'], ['closure', 'Closure']
  ];
  var STATUSES = ['Not Started', 'Awaiting Decision', 'In Progress', 'Waiting for Supplier', 'Waiting for Costing Manager', 'Waiting for Material Quote',
    'Waiting for PO Acknowledgment', 'Awaiting Documentation', 'Ready for Release', 'Released to Production', 'Awaiting Material',
    'Initial Workflow Complete', 'Monitoring Until Due Date', 'Overdue — Awaiting Closure', 'Closed — Verified', 'Cancelled / Not Required'];
  var CFG = { quoteFollowDays: 3, soNoFollowDays: 2, ackFollowDays: 3, dueSoonDays: 14, matRiskDays: 3, quoteValidWarnDays: 3 };
  var DOCS = [['print_traveller', 'traveller'], ['print_router', 'router'], ['print_part_prints', 'part prints'], ['print_req_po', 'req./PO'], ['verify_by_sakib', 'verification']];

  function txt(d, k) { var v = d[k]; return v === undefined || v === null ? '' : String(v).trim(); }
  function has(d, k) { var t = txt(d, k); return t !== '' && t !== '-'; }
  function yes(d, k) { return /^(y|yes|true)/i.test(txt(d, k)); }
  function num(d, k) { var t = txt(d, k).replace(/[$,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; }
  function mk(y, m, day) { var t = new Date(y, m, day); return t.getFullYear() === y && t.getMonth() === m && t.getDate() === day ? t : null; }
  function parse(s) {
    s = String(s === undefined || s === null ? '' : s).trim(); var m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return mk(+m[1], +m[2] - 1, +m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return mk(+m[3], +m[1] - 1, +m[2]);
    return null;
  }
  function date(d, k) { return parse(d[k]); }
  function iso(t) { return t ? t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') : ''; }
  function addDays(t, n) { if (!t) return null; var x = new Date(t.getTime()); x.setDate(x.getDate() + n); return x; }
  function diff(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }   // a - b in days
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function describe(d, todayIso) {
    d = d || {};
    var today = parse(todayIso) || parse(iso(new Date()));
    var status = txt(d, 'status').toUpperCase(), isAnalysis = /ANALYSIS|ANR/.test(status);
    var due = date(d, 'due_date'), soClose = date(d, 'so_close_date') || date(d, 'closure_verified_date');
    var reasons = [], skipped = {};
    function why(level, text) { reasons.push({ level: level, text: text }); }

    // ---- facts from the record
    var req = num(d, 'req_ft'), avail = num(d, 'avail_ft');
    var stockOK = req !== null && req > 0 && avail !== null && avail >= req;
    var quoteNeeded = txt(d, 'req_mat_quote').toUpperCase() !== 'NO' && !stockOK;
    var quoteRequested = has(d, 'mat_quote_request_date'), quoteReceived = has(d, 'quote_receive_date') || /^(y|stock)/i.test(txt(d, 'quote_received'));
    var soReq = date(d, 'so_req_date'), soNo = has(d, 'so_no');
    var poCreated = has(d, 'po_no_1') || has(d, 'po_receive_date'), poApproved = has(d, 'po_approve_date');
    var poNeeded = !stockOK || poCreated || poApproved;
    var released = has(d, 'charllete_jay_release_date'), matReceived = has(d, 'mat_receive_date_stockroom');
    var docMissing = DOCS.filter(function (x) { return !yes(d, x[0]); }).map(function (x) { return x[1]; });
    var promised = date(d, 'po_due_date'), required = date(d, 'mat_required_date') || due;
    var supplier = txt(d, 'supplier');

    // Evidence that the SO already exists: earlier stages are then history, not open work.
    var progressed = soNo || poCreated || poApproved || released || matReceived, preSO = !progressed && !soReq;
    var so = txt(d, 'so_required').toUpperCase();
    if (so === '') so = isAnalysis && !soReq && !soNo ? 'PENDING' : 'YES';

    var r = {
      stage: 1, status: 'Not Started', next: '', owner: 'none', waitingOn: '', actionDate: null, followup: null, matStatus: '', closedOn: null,
      initial: 'In progress', final: 'Open'
    };
    function at(stage, status, next, owner, waitingOn, actionDate, followup) { r.stage = stage; r.status = status; r.next = next; r.owner = owner; r.waitingOn = waitingOn || ''; r.actionDate = actionDate || null; r.followup = followup || null; }

    // ---- material arrival status (only meaningful once material has been ordered)
    if (poNeeded && (poApproved || matReceived)) {
      if (matReceived) {
        var rc = date(d, 'mat_receive_date_stockroom');
        r.matStatus = rc && required && diff(rc, required) > 0 ? 'Late' : 'On Time';
      } else if (!promised) r.matStatus = 'Unknown';
      else if (diff(today, promised) > 0) r.matStatus = 'Late';
      else if (required && diff(promised, required) > 0) r.matStatus = 'At Risk';
      else if (required && diff(required, today) <= CFG.matRiskDays) r.matStatus = 'At Risk';
      else r.matStatus = 'On Time';
    }

    var followDate = date(d, 'next_followup_date');
    function followupBy(def) { return followDate || def; }

    var closedStatus = /CLOSE/.test(status);
    if (so === 'NO') {
      at(1, 'Cancelled / Not Required', '', 'none'); r.initial = 'Not required'; r.final = 'Cancelled';
    } else if (closedStatus && soClose) {
      at(13, 'Closed — Verified', '', 'none'); r.initial = 'Complete'; r.final = 'Closed — Verified'; r.closedOn = soClose;
    } else if (closedStatus) {
      at(13, 'Monitoring Until Due Date', 'Verify the closure: enter the SO close date or the closure evidence', 'me', '', today); r.initial = 'Complete'; r.final = 'Open';
      why('warn', 'Marked closed without a close date or evidence');
    } else if (so === 'PENDING' && !progressed) {
      at(1, 'Awaiting Decision', 'Decide whether an SO is needed (Yes or No)', 'me', '', today);
    } else if (!progressed && (!has(d, 'part_no') || !has(d, 'customer') || !has(d, 'so_qty') || !(has(d, 'steel_type') && has(d, 'router_bar_size') && has(d, 'qty_per_bar')))) {
      var miss = [];
      if (!has(d, 'part_no')) miss.push('part number'); if (!has(d, 'customer')) miss.push('customer'); if (!has(d, 'so_qty')) miss.push('SO quantity');
      if (!(has(d, 'steel_type') && has(d, 'router_bar_size') && has(d, 'qty_per_bar'))) miss.push('steel data (STEEL USAGE)');
      at(2, 'In Progress', 'Confirm quantity and requirements: missing ' + miss.join(', '), 'me', '', today);
    } else if (preSO && quoteNeeded && !quoteRequested && !quoteReceived) {
      at(3, 'In Progress', 'Request the material quote' + (supplier ? ' from ' + supplier : ''), 'me', '', today);
    } else if (preSO && quoteNeeded && !quoteReceived) {
      var qd = date(d, 'quote_expected_date') || addDays(date(d, 'mat_quote_request_date'), CFG.quoteFollowDays);
      at(3, 'Waiting for Material Quote', 'Follow up on the material quote' + (supplier ? ' with ' + supplier : ''), 'supplier', supplier || 'Supplier', qd, followupBy(qd));
    } else if (preSO && quoteNeeded && !has(d, 'quote_approve_date')) {
      at(4, 'In Progress', 'Analyze the quote and approve it (price, lead time, quantity, validity)', 'me', '', today);
      var qv = date(d, 'quote_valid_until');
      if (qv) { var qn = diff(qv, today); if (qn < 0) why('crit', 'Quote expired ' + plural(-qn, 'day') + ' ago'); else if (qn <= CFG.quoteValidWarnDays) why('warn', 'Quote valid for only ' + plural(qn, 'more day')); }
    } else if (preSO) {
      at(5, 'In Progress', 'Request the SO from the costing manager' + (due ? '' : ' (set the due date first)'), 'me', '', today);
      if (!due) why('warn', 'Due date not set');
    } else if (!soNo && !progressed) {
      var sd = addDays(soReq, CFG.soNoFollowDays);
      at(6, 'Waiting for Costing Manager', 'Follow up with the costing manager for the SO number', 'costing', 'Costing manager', sd, followupBy(sd));
    } else if (poNeeded && !poApproved && !released && !matReceived) {
      at(7, 'In Progress', poCreated ? 'Approve the PO and send it to the supplier' : 'Purchase the material and create the PO', 'me', '', today);
    } else if (poNeeded && poApproved && !released && !matReceived && txt(d, 'ack_status').toUpperCase() !== 'RECEIVED') {
      var ad = addDays(date(d, 'po_approve_date'), CFG.ackFollowDays);
      if (txt(d, 'ack_status').toUpperCase() === 'DISCREPANCY') at(8, 'In Progress', 'Resolve the acknowledgment discrepancy with ' + (supplier || 'the supplier'), 'supplier', supplier || 'Supplier', today, followupBy(today));
      else at(8, 'Waiting for PO Acknowledgment', 'Follow up for the supplier acknowledgment of the PO', 'supplier', supplier || 'Supplier', ad, followupBy(ad));
    } else if (!released && docMissing.length) {
      at(9, 'Awaiting Documentation', 'Prepare the release documents: ' + docMissing.join(', '), 'me', '', today);
    } else if (!released) {
      at(10, 'Ready for Release', 'Release the SO to production', 'me', '', today);
    } else if (poNeeded && !matReceived) {
      var md = promised || required;
      at(11, 'Awaiting Material', r.matStatus === 'Late' ? 'Material is late: get a new delivery date from ' + (supplier || 'the supplier') : r.matStatus === 'Unknown' ? 'Get the promised delivery date from ' + (supplier || 'the supplier') : 'Monitor the material delivery', r.matStatus === 'Late' || r.matStatus === 'Unknown' ? 'supplier' : 'none', r.matStatus === 'On Time' ? '' : (supplier || 'Supplier'), md, followupBy(r.matStatus === 'On Time' ? md : today));
      r.owner = r.matStatus === 'Late' || r.matStatus === 'Unknown' ? 'me' : 'none';
    } else if (!due || diff(due, today) >= 0) {
      at(12, 'Monitoring Until Due Date', due ? 'No action needed until the due date' : 'Set the SO due date', due ? 'none' : 'me', '', due || today, followDate);
      r.initial = 'Complete'; if (!due) why('warn', 'Due date not set');
    } else {
      var ec = date(d, 'expected_closure_date');
      at(13, 'Overdue — Awaiting Closure', ec ? 'Confirm the SO closes on ' + iso(ec) : 'Get the SO closure status and an expected closure date', 'me', 'CAMCO personnel', ec || today, followupBy(ec && diff(ec, today) > 0 ? ec : today));
      r.initial = 'Complete'; r.final = 'Overdue';
    }
    if (r.stage >= 12 && r.stage < 13 && r.final === 'Open') r.final = 'Monitoring';
    if (due && diff(due, today) < 0 && r.final !== 'Closed — Verified' && r.final !== 'Cancelled') r.final = 'Overdue';   // past the due date without verified closure, whatever stage it is in
    if (r.stage >= 12 && r.initial !== 'Not required') r.initial = 'Complete';
    if (r.stage <= 11 && r.initial === 'In progress' && poNeeded === false && released) r.initial = 'Complete';

    // ---- stages that did not apply
    if (!quoteNeeded) { skipped.quoteReq = true; skipped.quoteAnalysis = true; }
    if (!poNeeded) { skipped.po = true; skipped.ack = true; skipped.material = true; }

    // ---- flags that matter at any stage
    var live = r.status !== 'Closed — Verified' && r.status !== 'Cancelled / Not Required';
    if (live) {
      if (due && r.stage < 13 && diff(due, today) < 0) why('crit', 'Overdue ' + plural(-diff(due, today), 'day') + ', not closed');
      else if (due && diff(due, today) <= CFG.dueSoonDays && r.stage < 13) why(diff(due, today) <= 7 ? 'warn' : 'info', 'Due in ' + plural(diff(due, today), 'day') + ' (' + iso(due) + ')');
      if (r.stage === 13 && r.final === 'Overdue') why('crit', 'Overdue ' + plural(-diff(due, today), 'day') + ', closure not verified');
      if (r.matStatus === 'Late') why('crit', 'Material is late' + (promised ? ' (promised ' + iso(promised) + ')' : ''));
      else if (r.matStatus === 'At Risk') why('warn', 'Material delivery at risk' + (promised && required && diff(promised, required) > 0 ? ': promised ' + plural(diff(promised, required), 'day') + ' after it is needed' : ''));
      else if (r.matStatus === 'Unknown' && r.stage >= 8) why('warn', 'No promised material delivery date');
      if (r.followup && diff(r.followup, today) <= 0) why(diff(r.followup, today) < 0 ? 'warn' : 'info', 'Follow-up ' + (diff(r.followup, today) < 0 ? 'overdue by ' + plural(-diff(r.followup, today), 'day') : 'due today'));
      if (yes(d, 'escalated')) why('crit', 'Escalated');
      if (has(d, 'blocker')) why('warn', 'Issue: ' + txt(d, 'blocker'));
      if (released && poNeeded && poApproved && txt(d, 'ack_status').toUpperCase() !== 'RECEIVED') why('info', 'Supplier acknowledgment not recorded');
      if (progressed && !soNo) why('warn', 'SO number not recorded');
      if (progressed && !(has(d, 'steel_type') && has(d, 'router_bar_size') && has(d, 'qty_per_bar'))) why('info', 'Steel data missing: material need cannot be calculated');
    }

    // ---- which report section it belongs to (each SO appears once, highest first)
    var sec = null, followDue = r.followup && diff(r.followup, today) <= 0;
    var hasCrit = reasons.some(function (x) { return x.level === 'crit'; });
    if (r.status === 'Closed — Verified') sec = 'F';
    else if (!live) sec = null;
    else if (r.final === 'Overdue') sec = 'E';
    else if (r.matStatus === 'Late' || r.matStatus === 'At Risk') sec = 'C';
    else if (r.owner === 'me' || yes(d, 'escalated') || (followDue && r.owner !== 'none')) sec = 'A';
    else if (r.owner && r.owner !== 'none' && r.owner !== 'me') sec = 'B';
    else if (r.stage === 12 && due && diff(due, today) <= CFG.dueSoonDays) sec = 'D';

    // ---- stepper
    var dates = { quoteReq: date(d, 'mat_quote_request_date'), quoteAnalysis: date(d, 'quote_approve_date'), soReq: soReq, soNo: date(d, 'so_no_received_date'), po: date(d, 'po_approve_date'), ack: date(d, 'ack_date'),
      release: date(d, 'charllete_jay_release_date'), material: date(d, 'mat_receive_date_stockroom'), closure: soClose };
    var steps = STAGES.map(function (s, i) {
      var n = i + 1, st = n < r.stage ? (skipped[s[0]] ? 'skip' : 'done') : n === r.stage ? 'current' : (skipped[s[0]] ? 'skip' : 'todo');
      if (r.status === 'Closed — Verified') st = skipped[s[0]] ? 'skip' : 'done';
      if (r.status === 'Cancelled / Not Required') st = n === 1 ? 'current' : 'todo';
      if (st === 'current' && hasCrit && r.status !== 'Closed — Verified') st = 'issue';
      return { key: s[0], label: s[1], state: st, date: dates[s[0]] ? iso(dates[s[0]]) : '' };
    });

    var nextActionDue = r.actionDate ? iso(r.actionDate) : '';
    return {
      stage: r.stage, stageKey: STAGES[r.stage - 1][0], stageLabel: STAGES[r.stage - 1][1], status: r.status, initial: r.initial, final: r.final,
      next: r.next, owner: r.owner, waitingOn: r.waitingOn, actionDate: nextActionDue, followup: r.followup ? iso(r.followup) : '', followupDue: !!followDue,
      matStatus: r.matStatus, reasons: reasons, section: sec, closedOn: r.closedOn ? iso(r.closedOn) : '', steps: steps,
      docs: { missing: docMissing, total: DOCS.length }, daysToDue: due ? diff(due, today) : null,
      rank: (hasCrit ? 0 : 1) * 100000 + (due ? Math.max(0, diff(due, today) + 5000) : 9000)
    };
  }

  return { STAGES: STAGES, STATUSES: STATUSES, CFG: CFG, describe: describe, parse: parse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOLife;
