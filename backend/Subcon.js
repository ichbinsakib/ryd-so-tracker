/**
 * Subcontractor order tracking for the coordinator. One order = one part sent to the subcontractor team for China
 * manufacturing, followed through: decision, part sent, China quotation, Rich's review and approval, Subcontractor SO request,
 * SO number from the costing manager, PO preparation, PO verification, PO to the vendor, vendor acknowledgment and production,
 * shipment, and confirmed arrival at CAMCO. The team executes; the coordinator tracks dates, follows up and escalates.
 * Pure JavaScript (Node + Deno). Dates are 'YYYY-MM-DD' strings and `today` is always passed in.
 */
var SOSub = (function () {
  // key, label, group (form section). Order = workflow order. estimate = a forecast, not an event.
  var MILESTONES = [
    { key: 'rfq', label: 'Part number sent to subcontractor team', group: 'Quotation' },
    { key: 'quote_received', label: 'China quotation received', group: 'Quotation' },
    { key: 'quote_to_rich', label: 'Quotation submitted to Rich', group: 'Quotation' },
    { key: 'quote_approved', label: 'Quotation approved (confirmed by the team)', group: 'Quotation' },
    { key: 'so_requested', label: 'Subcontractor SO requested', group: 'Subcontractor SO' },
    { key: 'so_costing', label: 'Request submitted to costing manager', group: 'Subcontractor SO' },
    { key: 'so_received', label: 'SO number received', group: 'Subcontractor SO' },
    { key: 'po_received', label: 'PO details received', group: 'Purchase order' },
    { key: 'po_prep_start', label: 'PO preparation started', group: 'Purchase order' },
    { key: 'po_created', label: 'PO completed', group: 'Purchase order' },
    { key: 'po_sent_approval', label: 'PO sent to team for verification', group: 'Purchase order' },
    { key: 'po_approved', label: 'PO verified', group: 'Purchase order' },
    { key: 'po_to_vendor', label: 'Verified PO sent to vendor', group: 'Purchase order' },
    { key: 'ack', label: 'Vendor acknowledged the PO', group: 'Vendor & production' },
    { key: 'down_payment', label: 'Down payment made', group: 'Vendor & production' },
    { key: 'production_start', label: 'Production started', group: 'Vendor & production' },
    { key: 'ready_to_ship', label: 'Production completed (ready to ship)', group: 'Vendor & production' },
    { key: 'vendor_ship', label: 'Vendor shipped', group: 'Shipment & delivery' },
    { key: 'forwarder_pickup', label: 'Forwarder pickup', group: 'Shipment & delivery' },
    { key: 'port_departure', label: 'Departed origin port', group: 'Shipment & delivery' },
    { key: 'eta_port', label: 'Estimated arrival at port', group: 'Shipment & delivery', estimate: true },
    { key: 'arrived_port', label: 'Arrived at destination port', group: 'Shipment & delivery' },
    { key: 'eta_camco', label: 'Estimated arrival at CAMCO', group: 'Shipment & delivery', estimate: true },
    { key: 'received_camco', label: 'Arrived at CAMCO (confirmed)', group: 'Shipment & delivery' },
    { key: 'to_inspection', label: 'Moved to inspection', group: 'Shipment & delivery' },
    { key: 'to_stock', label: 'Moved to stock', group: 'Shipment & delivery' }
  ];
  // Commitments that can move. The first value is kept as the original; later changes are recorded separately.
  var EXPECTED = [
    { key: 'exp_prod', label: 'Expected production completion', actual: 'ready_to_ship' },
    { key: 'exp_ship', label: 'Expected shipment', actual: 'vendor_ship' },
    { key: 'exp_arrival', label: 'Expected arrival at CAMCO', actual: 'received_camco' }
  ];
  var STAGES = [['decision', 'Decision'], ['sent', 'Part sent'], ['quote', 'China quote'], ['approval', 'Quote approval'], ['soReq', 'SO request'], ['soNo', 'SO number'],
    ['poPrep', 'PO preparation'], ['poVerify', 'PO verification'], ['poVendor', 'PO to vendor'], ['vendorStart', 'Vendor start'], ['production', 'Production'], ['delivery', 'Shipment & delivery'], ['done', 'Arrived']];
  // the milestone that finishes each stage, and the milestones that prove the order is at least that far
  var STAGE_DONE = { 2: 'rfq', 3: 'quote_received', 4: 'quote_approved', 5: 'so_requested', 6: 'so_received', 7: 'po_created', 8: 'po_approved', 9: 'po_to_vendor', 10: 'production_start', 11: 'ready_to_ship', 12: 'received_camco' };
  var STAGE_KEYS = {
    2: ['rfq'], 3: ['quote_received'], 4: ['quote_to_rich', 'quote_approved'], 5: ['so_requested'], 6: ['so_costing', 'so_received'], 7: ['po_received', 'po_prep_start', 'po_created'],
    8: ['po_sent_approval', 'po_approved'], 9: ['po_to_vendor'], 10: ['ack', 'down_payment', 'production_start'], 11: ['ready_to_ship'],
    12: ['vendor_ship', 'forwarder_pickup', 'port_departure', 'arrived_port', 'received_camco', 'to_inspection', 'to_stock']
  };
  var SECTIONS = [
    { key: 'immediate', label: 'Immediate actions', hint: 'Needs you now' },
    { key: 'quote', label: 'Quotation pending', hint: 'Part numbers waiting for a China quotation' },
    { key: 'approval', label: 'Approval pending', hint: 'Quotes waiting for review or approval' },
    { key: 'so', label: 'Subcontractor SO pending', hint: 'SO requests or SO numbers not yet received' },
    { key: 'po', label: 'PO processing', hint: 'POs being prepared, verified or sent' },
    { key: 'production', label: 'Vendor production', hint: 'In production, including delays' },
    { key: 'delivery', label: 'Delivery monitoring', hint: 'Waiting for shipment or arrival at CAMCO' },
    { key: 'overdue', label: 'Overdue follow-ups', hint: 'A follow-up or commitment passed without resolution' },
    { key: 'completed', label: 'Completed orders', hint: 'Confirmed arrived at CAMCO' }
  ];
  var DECISIONS = ['PENDING', 'YES', 'NO'];
  var REVIEW_STATUSES = ['', 'SUBMITTED', 'IN REVIEW', 'CHANGES REQUESTED', 'APPROVED'];
  var PRIORITIES = ['NORMAL', 'HIGH', 'LINE DOWN'];
  var BLOCKERS = ['', 'Payment', 'Drawing approval', 'Missing information', 'Vendor delay', 'Port / shipping', 'Quality hold', 'Customs', 'Other'];
  var UPDATE_KINDS = ['NOTE', 'FOLLOW-UP', 'ESCALATION', 'CHANGE'];
  var CFG = { staleDays: 7, ackDays: 3, startDays: 10, dueSoonDays: 7, quoteFollowDays: 3, quoteUrgentDays: 1, approvalFollowDays: 3, soFollowDays: 2, verifyFollowDays: 3, prodFollowDays: 7, quoteAgeWarn: 7, approvalAgeWarn: 5, completedDays: 30 };
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Elapsed calendar days between milestones (never calculated when a date is missing).
  var SEGMENTS = [
    { from: 'rfq', to: 'quote_received', label: 'Part sent → China quotation received' },
    { from: 'quote_received', to: 'quote_approved', label: 'Quotation received → approved' },
    { from: 'quote_approved', to: 'so_requested', label: 'Approved → Subcontractor SO requested' },
    { from: 'so_requested', to: 'so_received', label: 'SO requested → SO number received' },
    { from: 'so_received', to: 'po_created', label: 'SO number → PO completed' },
    { from: 'po_sent_approval', to: 'po_approved', label: 'PO sent for verification → verified' },
    { from: 'po_approved', to: 'po_to_vendor', label: 'PO verified → sent to vendor' },
    { from: 'po_to_vendor', to: 'ready_to_ship', label: 'PO sent to vendor → production completed' },
    { from: 'ready_to_ship', to: 'received_camco', label: 'Production completed → arrived at CAMCO' },
    { from: 'rfq', to: 'received_camco', label: 'Part sent → arrived at CAMCO (total)' }
  ];

  // The Excel sheet (templates and exports). One header per column; the same list is used by the server and the browser.
  // kind: text | num | date | enum | yn. ms / exp point at a milestone / expected-date key; k is a plain field.
  var TEMPLATE_COLUMNS = [
    { h: 'Order ref', k: 'order_ref', kind: 'text', note: 'Unique reference of this order. Leave blank for a new order: the app assigns SUB-0001, SUB-0002 ... and the export shows it. Use it to update the order later.' },
    { h: 'Part #', k: 'part_no', kind: 'text', req: true, note: 'CAMCO part number. Required.' },
    { h: 'Revision', k: 'revision', kind: 'text' },
    { h: 'Description', k: 'description', kind: 'text' },
    { h: 'Qty', k: 'qty', kind: 'num', note: 'Required quantity (pcs). Leave blank while it is not known: the order is flagged until you enter it.' },
    { h: 'Priority', k: 'priority', kind: 'enum', options: ['NORMAL', 'HIGH', 'LINE DOWN'], note: 'NORMAL (default), HIGH or LINE DOWN. HIGH and LINE DOWN are followed up daily.' },
    { h: 'Required at CAMCO', k: 'required_date', kind: 'date', note: 'Date the parts are needed at CAMCO.' },
    { h: 'Customer due date', k: 'customer_due_date', kind: 'date' },
    { h: 'SO required?', k: 'so_required', kind: 'enum', options: ['YES', 'NO', 'PENDING'], note: 'Is a Shop Order needed? YES, NO or PENDING.' },
    { h: 'Subcontracting required?', k: 'sub_required', kind: 'enum', options: ['YES', 'NO', 'PENDING'], note: 'Can the part be made by the subcontractor (China)? YES, NO or PENDING. NO closes the order as not required.' },
    { h: 'Decision note', k: 'decision_note', kind: 'text', note: 'The reason, especially when the answer is NO.' },
    { h: 'Team member', k: 'team_member', kind: 'text', note: 'Responsible subcontractor team member.' },
    { h: 'Responsible person', k: 'owner', kind: 'text', note: 'Who must act next.' },
    { h: 'Communication ref', k: 'comm_ref', kind: 'text', note: 'Email subject or link.' },
    { h: 'SO #', k: 'so_no', kind: 'text', note: 'Subcontractor SO number from the costing manager.' },
    { h: 'PO #', k: 'po_no', kind: 'text', note: 'PO number for the vendor. Must be unique.' },
    { h: 'BPO #', k: 'bpo_no', kind: 'text' },
    { h: 'Batch', k: 'batch', kind: 'text' },
    { h: 'Part sent to team', ms: 'rfq', kind: 'date', note: 'Date the part number was sent to the subcontractor team. Starts the quotation clock.' },
    { h: 'China quotation received', ms: 'quote_received', kind: 'date' },
    { h: 'Quote submitted to Rich', ms: 'quote_to_rich', kind: 'date' },
    { h: 'Review status', k: 'review_status', kind: 'text', suggest: ['SUBMITTED', 'IN REVIEW', 'CHANGES REQUESTED', 'APPROVED'], note: 'Review status with Rich. Suggested: SUBMITTED, IN REVIEW, CHANGES REQUESTED, APPROVED. Other wording is kept as written.' },
    { h: 'Quote approved', ms: 'quote_approved', kind: 'date', note: 'Date the team confirmed the approval.' },
    { h: 'SO requested', ms: 'so_requested', kind: 'date' },
    { h: 'SO request to costing manager', ms: 'so_costing', kind: 'date' },
    { h: 'SO number received', ms: 'so_received', kind: 'date' },
    { h: 'PO prep started', ms: 'po_prep_start', kind: 'date' },
    { h: 'PO completed', ms: 'po_created', kind: 'date' },
    { h: 'PO sent for verification', ms: 'po_sent_approval', kind: 'date' },
    { h: 'PO verified', ms: 'po_approved', kind: 'date' },
    { h: 'PO sent to vendor', ms: 'po_to_vendor', kind: 'date' },
    { h: 'Vendor acknowledged', ms: 'ack', kind: 'date' },
    { h: 'Production started', ms: 'production_start', kind: 'date' },
    { h: 'Production completed', ms: 'ready_to_ship', kind: 'date' },
    { h: 'Vendor shipped', ms: 'vendor_ship', kind: 'date' },
    { h: 'Arrived at CAMCO', ms: 'received_camco', kind: 'date', note: 'Confirmed arrival. Completes the order.' },
    { h: 'Expected production completion', exp: 'exp_prod', kind: 'date', note: 'Promised dates. If one changes, the app keeps the original and logs the change.' },
    { h: 'Expected shipment', exp: 'exp_ship', kind: 'date' },
    { h: 'Expected arrival at CAMCO', exp: 'exp_arrival', kind: 'date' },
    { h: 'Next follow-up date', k: 'next_action_date', kind: 'date' },
    { h: 'Next action', k: 'next_action', kind: 'text' },
    { h: 'Outstanding issue', k: 'blocker', kind: 'text' },
    { h: 'Last update', k: 'last_update', kind: 'date', note: 'Date of the last update from the team or vendor.' },
    { h: 'Escalated?', k: 'escalated', kind: 'yn', note: 'YES or NO.' },
    { h: 'Note', k: 'note', kind: 'text' },
    { h: 'Down payment made', ms: 'down_payment', kind: 'date', opt: true },
    { h: 'Forwarder pickup', ms: 'forwarder_pickup', kind: 'date', opt: true },
    { h: 'Departed origin port', ms: 'port_departure', kind: 'date', opt: true },
    { h: 'Arrived at destination port', ms: 'arrived_port', kind: 'date', opt: true },
    { h: 'Moved to inspection', ms: 'to_inspection', kind: 'date', opt: true },
    { h: 'Moved to stock', ms: 'to_stock', kind: 'date', opt: true },
    { h: 'Qty shipped', k: 'qty_shipped', kind: 'num', opt: true },
    { h: 'Qty received', k: 'qty_received', kind: 'num', opt: true },
    { h: 'Qty on hold', k: 'qty_hold', kind: 'num', opt: true },
    { h: 'Qty rejected', k: 'qty_rejected', kind: 'num', opt: true },
    { h: 'Qty moved to stock', k: 'qty_stocked', kind: 'num', opt: true }
  ];
  function normHeader(h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9#?]+/g, ' ').trim(); }

  /** One sheet row (values by header) -> the fields it filled in. Blank cells are left out so they never overwrite existing data. */
  function fromTemplateRow(row) {
    var byHeader = {}; Object.keys(row || {}).forEach(function (h) { byHeader[normHeader(h)] = row[h]; });
    var out = { ms: {}, exp: {} };
    TEMPLATE_COLUMNS.forEach(function (c) {
      var v = byHeader[normHeader(c.h)]; if (v === undefined || v === null) return; if (typeof v === 'string') v = v.trim(); if (v === '') return;
      if (c.ms) out.ms[c.ms] = String(v); else if (c.exp) out.exp[c.exp] = String(v);
      else if (c.kind === 'yn') out[c.k] = /^(y|yes|true|1)/i.test(String(v));
      else if (c.kind === 'enum') out[c.k] = String(v).toUpperCase();
      else out[c.k] = v;
    });
    return out;
  }
  /** An existing line plus what the sheet filled in. Only filled cells change anything. */
  function mergeLine(existing, inc) {
    var base = Object.assign({}, existing || {});
    Object.keys(inc).forEach(function (k) { if (k !== 'ms' && k !== 'exp') base[k] = inc[k]; });
    base.ms = Object.assign({}, (existing && existing.ms) || {}, inc.ms || {});
    base.exp = Object.assign({}, (existing && existing.exp) || {}, inc.exp || {});
    return base;
  }

  function isDate(s) { return typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function dayNum(s) { return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function addDays(s, n) { return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10); }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
  function dateOrNull(v) { v = str(v, 10); return v === '' ? null : v; }
  function qtyOf(v) { if (v === '' || v == null) return 0; var n = Number(v); return isFinite(n) ? n : NaN; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function shortDate(s) { return s.slice(5).replace('-', '/'); }

  function cleanLine(o) {
    var errors = {};
    var out = {
      order_ref: str(o.order_ref, 40), bpo_no: str(o.bpo_no, 40), batch: str(o.batch, 40), po_no: str(o.po_no, 60), so_no: str(o.so_no, 40), part_no: str(o.part_no, 80), ryd_part: str(o.ryd_part, 80),
      description: str(o.description, 200), revision: str(o.revision, 40), qty: o.qty === '' || o.qty == null ? 0 : Number(o.qty), priority: str(o.priority, 20).toUpperCase() || 'NORMAL', owner: str(o.owner, 80),
      team_member: str(o.team_member, 80), comm_ref: str(o.comm_ref, 300), decision_note: str(o.decision_note, 500),
      so_required: str(o.so_required, 10).toUpperCase() || 'PENDING', sub_required: str(o.sub_required, 10).toUpperCase() || 'PENDING', review_status: str(o.review_status, 60).toUpperCase(),
      blocker_type: str(o.blocker_type, 40), blocker: str(o.blocker, 500), next_action: str(o.next_action, 300), delay_reason: str(o.delay_reason, 500),
      note: str(o.note, 2000), escalated: o.escalated === true, closed: o.closed === true
    };
    ['sent_date', 'required_date', 'customer_due_date', 'next_action_date', 'revised_date', 'last_update'].forEach(function (k) {
      out[k] = dateOrNull(o[k]); if (out[k] && !isDate(out[k])) errors[k] = 'Use a valid date.';
    });
    ['qty_shipped', 'qty_received', 'qty_hold', 'qty_rejected', 'qty_stocked'].forEach(function (k) {
      out[k] = qtyOf(o[k]); if (isNaN(out[k]) || out[k] < 0) errors[k] = 'Enter a quantity of 0 or more.';
    });
    var ms = {}, src = o.ms && typeof o.ms === 'object' ? o.ms : {};
    MILESTONES.forEach(function (m) {
      var v = dateOrNull(src[m.key]); if (!v) return;
      if (!isDate(v)) errors['ms_' + m.key] = 'Use a valid date.'; else ms[m.key] = v;
    });
    out.ms = ms;
    var exp = {}, es = o.exp && typeof o.exp === 'object' ? o.exp : {};
    EXPECTED.forEach(function (e) {
      var v = dateOrNull(es[e.key]); if (!v) return;
      if (!isDate(v)) errors['exp_' + e.key] = 'Use a valid date.'; else exp[e.key] = v;
    });
    out.exp = exp;
    if (!out.part_no) errors.part_no = 'Part # is required.';
    if (!isFinite(out.qty) || out.qty < 0) errors.qty = 'Quantity must be 0 or more.';   // 0 = not known yet (flagged on the order)
    if (DECISIONS.indexOf(out.so_required) < 0) errors.so_required = 'Choose Yes, No or Pending.';
    if (DECISIONS.indexOf(out.sub_required) < 0) errors.sub_required = 'Choose Yes, No or Pending.';
    if (PRIORITIES.indexOf(out.priority) < 0) errors.priority = 'Unknown priority.';
    if (BLOCKERS.indexOf(out.blocker_type) < 0) errors.blocker_type = 'Unknown blocker type.';
    if (out.closed && !Object.keys(errors).length) {
      var miss = completionGaps(out);
      if (miss.length) errors.closed = 'Cannot close yet: ' + miss.join('; ') + '.';
    }
    return { ok: Object.keys(errors).length === 0, value: out, errors: errors };
  }

  // The workflow is complete only when arrival at CAMCO is confirmed.
  function completionGaps(l) {
    var gaps = [], ms = l.ms || {};
    if (!ms.received_camco) gaps.push('enter the date it arrived at CAMCO');
    if ((l.qty_hold || 0) > 0) gaps.push((l.qty_hold) + ' pcs still on hold');
    return gaps;
  }

  function cleanUpdate(u) {
    var kind = str(u.kind, 20).toUpperCase() || 'NOTE', text = str(u.text, 2000), errors = {};
    if (UPDATE_KINDS.indexOf(kind) < 0) errors.kind = 'Unknown update type.';
    if (!text) errors.text = 'Write the update.';
    return { ok: !Object.keys(errors).length, value: { kind: kind, text: text }, errors: errors };
  }

  function milestoneLabel(k) { var m = MILESTONES.filter(function (x) { return x.key === k; })[0]; return m ? m.label : k; }

  // Where the order is: the first stage whose finishing milestone is missing. Later evidence skips earlier stages.
  function stageOf(l, today, cfg) {
    var ms = l.ms || {}, has = function (k) { return !!ms[k]; };
    var evidence = 1;
    Object.keys(STAGE_KEYS).forEach(function (n) { if (STAGE_KEYS[n].some(has)) evidence = Math.max(evidence, +n); });
    if (l.so_no && evidence < 6) evidence = Math.max(evidence, 6);   // an SO number typed without a date still proves it exists
    var urgent = l.priority !== 'NORMAL', team = l.team_member || 'Subcontractor team';
    var r = { n: 0, status: '', next: '', owner: 'none', waitingOn: '', base: null, days: 0 };
    function at(n, status, next, owner, waitingOn, base, days) { r.n = n; r.status = status; r.next = next; r.owner = owner; r.waitingOn = waitingOn || ''; r.base = base || null; r.days = days || 0; return r; }
    var lastContact = l.last_update || null;
    if (l.sub_required === 'NO' || l.so_required === 'NO') return at(1, 'Not required', '', 'none');
    if (evidence < 2 && (l.sub_required !== 'YES' || l.so_required !== 'YES')) return at(1, 'Awaiting decision', 'Decide whether an SO and subcontracting are needed', 'me', '', today, 0);
    function done(n) { return n < evidence || !!(STAGE_DONE[n] && (has(STAGE_DONE[n]) || (n === 6 && l.so_no))); }
    if (!done(2)) return at(2, 'Part number not yet sent', 'Send the part number and requirements to the subcontractor team', 'me', '', today, 0);
    if (!done(3)) return at(3, 'Waiting for China quotation', 'Follow up on the China quotation', 'team', team, lastContact && lastContact > ms.rfq ? lastContact : ms.rfq, urgent ? cfg.quoteUrgentDays : cfg.quoteFollowDays);
    if (!done(4)) {
      if (!has('quote_to_rich')) return at(4, 'Quotation with the team, not yet with Rich', 'Ask the team when the quotation goes to Rich', 'team', team, lastContact && lastContact > ms.quote_received ? lastContact : ms.quote_received, cfg.approvalFollowDays);
      if (/CHANGE/.test(l.review_status || '')) return at(4, 'Rich requested changes', 'Ask the team for the revised quotation', 'team', team, lastContact || ms.quote_to_rich, cfg.approvalFollowDays);
      return at(4, 'Waiting for review and approval', 'Follow up on Rich\'s review and the team\'s approval confirmation', 'team', team + ' / Rich', lastContact && lastContact > ms.quote_to_rich ? lastContact : ms.quote_to_rich, cfg.approvalFollowDays);
    }
    if (!done(5)) return at(5, 'Ready to request the SO', 'Request the Subcontractor SO', 'me', '', today, 0);
    if (!done(6)) {
      if (!has('so_costing')) return at(6, 'SO request not yet with the costing manager', 'Submit the SO request to the costing manager', 'me', '', today, 0);
      return at(6, 'Waiting for the SO number', 'Follow up with the costing manager for the SO number', 'costing', 'Costing manager', lastContact && lastContact > ms.so_costing ? lastContact : ms.so_costing, cfg.soFollowDays);
    }
    if (!done(7)) return at(7, has('po_prep_start') ? 'PO being prepared' : 'PO not started', has('po_prep_start') ? 'Finish the PO for the vendor' : 'Start preparing the PO for the vendor', 'me', '', today, 0);
    if (!done(8)) {
      if (!has('po_sent_approval')) return at(8, 'PO ready, not yet sent for verification', 'Send the PO to the team for verification', 'me', '', today, 0);
      return at(8, 'Waiting for PO verification', 'Follow up on the PO verification', 'team', team, lastContact && lastContact > ms.po_sent_approval ? lastContact : ms.po_sent_approval, cfg.verifyFollowDays);
    }
    if (!done(9)) return at(9, 'PO verified, not yet sent to the vendor', 'Send the verified PO to the Chinese vendor', 'me', '', today, 0);
    if (!done(10)) {
      if (!has('ack') && !has('production_start')) return at(10, 'Waiting for vendor acknowledgment', 'Ask the team and vendor to acknowledge the PO', 'team', team + ' / vendor', lastContact && lastContact > ms.po_to_vendor ? lastContact : ms.po_to_vendor, cfg.ackDays);
      return at(10, 'Acknowledged, production not started', 'Ask for the production start date', 'team', team + ' / vendor', lastContact && lastContact > (ms.ack || ms.po_to_vendor) ? lastContact : (ms.ack || ms.po_to_vendor), cfg.ackDays);
    }
    if (!done(11)) return at(11, 'In production', 'Follow up on production progress and the completion date', 'team', team + ' / vendor', lastContact && lastContact > ms.production_start ? lastContact : ms.production_start, cfg.prodFollowDays);
    if (!done(12)) {
      var shipped = has('vendor_ship') || has('port_departure') || has('forwarder_pickup');
      return at(12, shipped ? 'Shipped, awaiting arrival' : 'Production done, awaiting shipment', shipped ? 'Track the shipment to CAMCO' : 'Confirm the shipment date with the vendor', 'team', team + ' / vendor', lastContact && lastContact > ms.ready_to_ship ? lastContact : (ms.vendor_ship || ms.ready_to_ship), cfg.prodFollowDays);
    }
    return at(13, 'Arrived at CAMCO', '', 'none');
  }

  // Elapsed calendar days for the measurements that have both dates.
  function spansOf(ms) {
    return SEGMENTS.map(function (sg) {
      var a = ms[sg.from], b = ms[sg.to], d = a && b ? daysBetween(a, b) : null;
      return { from: sg.from, to: sg.to, label: sg.label, days: d !== null && d >= 0 ? d : null };
    });
  }

  function describe(l, today, cfg) {
    cfg = cfg || CFG;
    var ms = l.ms || {}, exp = l.exp || {}, orig = l.orig || {};
    var st = stageOf(l, today, cfg);
    var complete = !!ms.received_camco;
    var notRequired = st.status === 'Not required';
    var open = !l.closed && !complete && !notRequired;
    var remaining = Math.max(0, l.qty - (l.qty_stocked || 0) - (l.qty_rejected || 0));
    var expectedArrival = ms.received_camco || exp.exp_arrival || ms.eta_camco || l.revised_date || l.required_date || null;
    var late = 0, forecastLate = 0;
    if (open && l.required_date) {
      if (today > l.required_date) late = daysBetween(l.required_date, today);
      if (expectedArrival && expectedArrival > l.required_date) forecastLate = daysBetween(l.required_date, expectedArrival);
    }
    var base = st.base || null;
    var followup = l.next_action_date || (open && base && st.owner !== 'me' ? addDays(base, st.days) : (open && st.owner === 'me' ? today : null));
    var last = null;
    MILESTONES.forEach(function (m) { if (!m.estimate && ms[m.key] && (!last || ms[m.key] >= last.date)) last = { key: m.key, label: m.label, date: ms[m.key] }; });
    var out = Object.assign({}, l, {
      open: open, complete: complete, notRequired: notRequired, stageNo: st.n, stage: complete ? 'Arrived' : STAGES[st.n - 1][1], status: st.status, owner_role: st.owner, waitingOn: st.waitingOn,
      next: st.next, followup: followup, followupDue: !!(followup && followup <= today && open), lastMilestone: last, remaining: remaining, expected: expectedArrival, pastDue: late, forecastLate: forecastLate,
      lastUpdateAge: l.last_update ? daysBetween(l.last_update, today) : null, daysToRequired: l.required_date ? daysBetween(today, l.required_date) : null,
      progress: complete ? 100 : notRequired ? 0 : Math.round(100 * (st.n - 1) / 12), spans: spansOf(ms), gaps: completionGaps(l),
      origDates: orig
    });
    out.reasons = open ? reasonsFor(out, today, cfg, st) : [];
    out.attention = out.reasons.some(function (r) { return r.level === 'crit'; }) ? 'crit' : (out.reasons.length ? 'warn' : 'ok');
    out.action = out.next || (out.reasons.length ? out.reasons[0].action : '');
    out.outstanding = open ? (out.status + (l.blocker ? ' · ' + l.blocker : '')) : '';
    out.impact = open ? impactOf(out) : '';
    out.section = sectionOf(out);
    return out;
  }

  function impactOf(d) {
    var head = d.stageNo <= 9 ? 'Holds up the PO to the vendor; production cannot start until this is done.' : d.stageNo <= 11 ? 'Delays shipment to CAMCO.' : 'Delays arrival at CAMCO.';
    var tail = d.required_date ? (d.pastDue > 0 ? ' Already ' + plural(d.pastDue, 'day') + ' past the required date.' : d.forecastLate > 0 ? ' Expected ' + plural(d.forecastLate, 'day') + ' after the required date.' : ' ' + plural(d.daysToRequired, 'day') + ' left to the required date ' + d.required_date + '.') : ' No required date set.';
    return head + tail;
  }

  function reasonsFor(d, today, cfg, st) {
    var r = [], ms = d.ms || {}, exp = d.exp || {}, urgent = d.priority !== 'NORMAL';
    function add(level, code, text, action) { r.push({ level: level, code: code, text: text, action: action }); }
    if (d.escalated) add('crit', 'escalated', 'Escalated', 'Follow the escalation with the team lead and record the outcome.');
    if (d.qty_hold > 0) add('crit', 'hold', d.qty_hold + ' pcs on hold', 'Get the hold reason and a release / rework date from quality.');
    if (d.pastDue > 0) add('crit', 'past-due', 'Past the required date by ' + plural(d.pastDue, 'day'), 'Ask the team for a firm revised date and record the delay reason.');
    if (d.forecastLate > 0 && !d.pastDue) add(urgent ? 'crit' : 'warn', 'forecast-late', 'Expected ' + plural(d.forecastLate, 'day') + ' after the required date', urgent ? 'Escalate: this ' + d.priority + ' order will miss the required date.' : 'Check if the date can be recovered or warn the SO owner.');
    if (d.followup && d.followup < today) add(urgent ? 'crit' : 'warn', 'followup-overdue', 'Follow-up overdue by ' + plural(daysBetween(d.followup, today), 'day'), d.next || 'Do the planned follow-up.');
    else if (d.followup && d.followup === today && st.owner !== 'me') add('warn', 'followup-today', 'Follow-up due today', d.next || 'Do the planned follow-up.');
    EXPECTED.forEach(function (e) {
      if (exp[e.key] && exp[e.key] < today && !ms[e.actual]) add(e.key === 'exp_arrival' ? 'crit' : 'warn', 'exp-missed-' + e.key, e.label.replace('Expected ', '') + ' was expected ' + shortDate(exp[e.key]) + ', not confirmed', 'Ask for the actual date or a new commitment and record it.');
    });
    if (!(d.qty > 0)) add('warn', 'no-qty', 'Quantity not set', 'Enter the required quantity.');
    if (d.blocker) add(urgent ? 'crit' : 'warn', 'blocked', 'Blocked' + (d.blocker_type ? ': ' + d.blocker_type : ''), 'Chase the blocker: ' + (d.blocker_type || d.blocker).toLowerCase() + '.');
    if (st.n === 3 && ms.rfq && daysBetween(ms.rfq, today) >= cfg.quoteAgeWarn) add('warn', 'quote-aging', 'Quotation pending ' + plural(daysBetween(ms.rfq, today), 'day'), 'Press the team for the China quotation date.');
    if (st.n === 4 && ms.quote_to_rich && daysBetween(ms.quote_to_rich, today) >= cfg.approvalAgeWarn) add('warn', 'approval-aging', 'With Rich ' + plural(daysBetween(ms.quote_to_rich, today), 'day') + ', no approval', 'Ask the team where the approval stands.');
    if (st.n === 6 && ms.so_costing && daysBetween(ms.so_costing, today) >= 4) add('warn', 'so-aging', 'SO number pending ' + plural(daysBetween(ms.so_costing, today), 'day'), 'Follow up with the costing manager.');
    if (st.n === 8 && ms.po_sent_approval && daysBetween(ms.po_sent_approval, today) >= 4) add('warn', 'verify-aging', 'PO verification pending ' + plural(daysBetween(ms.po_sent_approval, today), 'day'), 'Ask the team to verify the PO.');
    if (ms.po_to_vendor && !ms.ack && !ms.production_start && daysBetween(ms.po_to_vendor, today) >= cfg.ackDays) add('warn', 'no-ack', 'Not acknowledged ' + plural(daysBetween(ms.po_to_vendor, today), 'day') + ' after PO', 'Ask the team to confirm the vendor received the PO.');
    if (ms.po_to_vendor && !ms.production_start && daysBetween(ms.po_to_vendor, today) >= cfg.startDays) add('warn', 'not-started', 'Production not started ' + plural(daysBetween(ms.po_to_vendor, today), 'day') + ' after PO', 'Ask for the planned start date and what is holding it.');
    if (st.owner !== 'me' && st.n > 1 && (d.lastUpdateAge === null ? false : d.lastUpdateAge > cfg.staleDays)) add('warn', 'stale', 'No update for ' + plural(d.lastUpdateAge, 'day'), 'Request a status update from the team.');
    return r.sort(function (a, b) { return (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1); });
  }

  // Each order appears once: overdue follow-ups first, then what needs me, then by stage.
  function sectionOf(d) {
    if (d.complete) return 'completed';
    if (!d.open) return null;
    var overdue = d.reasons.some(function (r) { return r.code === 'followup-overdue' || r.code.indexOf('exp-missed') === 0 || r.code === 'past-due'; });
    if (overdue) return 'overdue';
    if (d.owner_role === 'me' || d.escalated) return 'immediate';
    var n = d.stageNo;
    return n <= 3 ? 'quote' : n === 4 ? 'approval' : n <= 6 ? 'so' : n <= 9 ? 'po' : n <= 11 ? 'production' : 'delivery';
  }

  // Elapsed-day statistics (calendar days) from completed spans.
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

  // Project the date a line will arrive at CAMCO from past spans, starting at the latest dated milestone in the chain.
  function projectReceipt(l, stats) {
    var ms = l.ms || {}; if (ms.received_camco) return null;
    var chain = ['po_to_vendor', 'ready_to_ship', 'received_camco'], last = -1;
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
    cfg = cfg || CFG;
    var described = rawLines.map(function (l) { return describe(l, today, cfg); });
    var stats = leadStats(described);
    described.forEach(function (d) { d.projected = d.open ? projectReceipt(d, stats) : null; });
    var open = described.filter(function (d) { return d.open; });
    var rank = { crit: 0, warn: 1, ok: 2 };
    function byUrgency(a, b) {
      return rank[a.attention] - rank[b.attention] || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || String(a.followup || '9999').localeCompare(String(b.followup || '9999'));
    }
    var sections = {};
    SECTIONS.forEach(function (s) { sections[s.key] = described.filter(function (d) {
      if (d.section !== s.key) return false;
      if (s.key === 'completed') return d.ms.received_camco && daysBetween(d.ms.received_camco, today) <= cfg.completedDays;
      return true;
    }).sort(s.key === 'completed' ? function (a, b) { return String(b.ms.received_camco).localeCompare(String(a.ms.received_camco)); } : byUrgency).map(function (d) { return d.id; }); });
    var queue = open.filter(function (d) { return d.section === 'immediate' || d.section === 'overdue'; }).sort(byUrgency);
    function has(d, code) { return d.reasons.some(function (r) { return r.code === code; }); }
    return {
      lines: described, queue: queue.map(function (d) { return d.id; }), sections: sections, batches: batches(described), leadStats: stats,
      kpis: {
        open: open.length, needsAction: queue.length, critical: open.filter(function (d) { return d.attention === 'crit'; }).length,
        pastDue: open.filter(function (d) { return d.pastDue > 0; }).length, forecastLate: open.filter(function (d) { return d.forecastLate > 0; }).length,
        blocked: open.filter(function (d) { return d.blocker || d.qty_hold > 0; }).length, stale: open.filter(function (d) { return has(d, 'stale'); }).length,
        noAck: open.filter(function (d) { return has(d, 'no-ack'); }).length, overdueFollowups: open.filter(function (d) { return has(d, 'followup-overdue'); }).length,
        openQty: open.reduce(function (t, d) { return t + d.remaining; }, 0)
      }
    };
  }

  return {
    MILESTONES: MILESTONES, EXPECTED: EXPECTED, STAGES: STAGES, SECTIONS: SECTIONS, DECISIONS: DECISIONS, REVIEW_STATUSES: REVIEW_STATUSES, PRIORITIES: PRIORITIES, BLOCKERS: BLOCKERS,
    UPDATE_KINDS: UPDATE_KINDS, SEGMENTS: SEGMENTS, CFG: CFG,
    TEMPLATE_COLUMNS: TEMPLATE_COLUMNS, normHeader: normHeader, fromTemplateRow: fromTemplateRow, mergeLine: mergeLine,
    isDate: isDate, daysBetween: daysBetween, addDays: addDays, cleanLine: cleanLine, cleanUpdate: cleanUpdate, completionGaps: completionGaps, milestoneLabel: milestoneLabel,
    describe: describe, spansOf: spansOf, leadStats: leadStats, projectReceipt: projectReceipt, batches: batches, build: build
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOSub;
