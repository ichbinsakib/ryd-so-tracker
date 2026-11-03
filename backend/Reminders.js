/**
 * Status reminders: an SO that stays in ANR, RFS or ANALYSIS gets a reminder email after 24 hours,
 * then again every 10 hours, three emails in all. Pure logic (no network, no database) so it is
 * tested in Node and bundled into the Edge Function by scripts/build-edge.js.
 */
var SOReminders = (function () {
  var WATCHED = [
    { status: '1.ANR', label: 'ANR', meaning: 'Approved but not released' },
    { status: '2.RFS', label: 'RFS', meaning: 'Request for SO' },
    { status: '1. ANALYSIS', label: 'Analysis', meaning: 'Analysis for SO releasing' }
  ];
  var FIRST_AFTER_HOURS = 24;
  var REPEAT_AFTER_HOURS = 10;
  var MAX_EMAILS = 3;
  var HOUR = 3600000;

  function statuses() { return WATCHED.map(function (w) { return w.status; }); }
  function info(status) { return WATCHED.filter(function (w) { return w.status === status; })[0] || null; }

  function ms(v) { var t = v ? new Date(v).getTime() : NaN; return isNaN(t) ? null : t; }

  /**
   * rows: [{id, data, status_since, remind_count, last_remind_at}]. Returns the rows that need an email now,
   * each with `sent` (emails already sent), `number` (this one's number, 1..MAX_EMAILS) and `hoursIn` (time in the status).
   */
  function due(rows, nowMs) {
    var out = [];
    (rows || []).forEach(function (r) {
      var status = String((r.data && r.data.status) || '').trim();
      if (!info(status)) return;
      var since = ms(r.status_since);
      if (since === null) return;
      var sent = Number(r.remind_count) || 0;
      if (sent >= MAX_EMAILS) return;
      var ok;
      if (sent === 0) ok = nowMs - since >= FIRST_AFTER_HOURS * HOUR;
      else { var last = ms(r.last_remind_at); ok = last !== null && nowMs - last >= REPEAT_AFTER_HOURS * HOUR; }
      if (!ok) return;
      out.push({ id: r.id, status: status, data: r.data || {}, sent: sent, number: sent + 1, hoursIn: Math.floor((nowMs - since) / HOUR) });
    });
    return out;
  }

  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ago(h) { return h >= 48 ? Math.floor(h / 24) + ' d ' + (h % 24) + ' h' : h + ' h'; }

  /** One digest email for everything that is due: {subject, text, html}. */
  function buildEmail(items, appUrl) {
    var groups = WATCHED.map(function (w) { return { w: w, rows: items.filter(function (i) { return i.status === w.status; }) }; }).filter(function (g) { return g.rows.length; });
    var counts = groups.map(function (g) { return g.rows.length + ' ' + g.w.label; }).join(', ');
    var finalCount = items.filter(function (i) { return i.number === MAX_EMAILS; }).length;
    var subject = 'SO reminder: ' + counts + ' still waiting to be cleared' + (finalCount ? ' (' + finalCount + ' final reminder' + (finalCount === 1 ? '' : 's') + ')' : '');
    var label = function (i) { var d = i.data; return (d.so_no ? 'SO ' + d.so_no : 'Part check') + ' | ' + (d.part_no || '-') + ' | ' + (d.customer || '-') + (d.so_qty ? ' | ' + d.so_qty + ' pcs' : '') + ' | in status ' + ago(i.hoursIn) + ' | reminder ' + i.number + ' of ' + MAX_EMAILS; };
    var text = ['These shop orders have been in the same status too long. Please clear them within the next ' + REPEAT_AFTER_HOURS + ' hours. If they are still there you get another reminder (up to ' + MAX_EMAILS + ' in all).', ''];
    groups.forEach(function (g) { text.push(g.w.label + ' (' + g.w.meaning + '): ' + g.rows.length); g.rows.forEach(function (i) { text.push('  - ' + label(i)); }); text.push(''); });
    if (appUrl) text.push('Open the app: ' + appUrl);
    var html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2430">' +
      '<p>These shop orders have been in the same status too long. Please clear them within the next <b>' + REPEAT_AFTER_HOURS + ' hours</b>. If they are still there you get another reminder (up to ' + MAX_EMAILS + ' in all).</p>' +
      groups.map(function (g) {
        return '<h3 style="margin:16px 0 6px">' + esc(g.w.label) + ' <span style="color:#667487;font-weight:normal">(' + esc(g.w.meaning) + ') &middot; ' + g.rows.length + '</span></h3>' +
          '<table style="border-collapse:collapse;width:100%"><tr style="background:#f3f5f8;text-align:left"><th style="padding:5px 8px">SO / Part</th><th style="padding:5px 8px">Customer</th><th style="padding:5px 8px">Qty</th><th style="padding:5px 8px">In status</th><th style="padding:5px 8px">Reminder</th></tr>' +
          g.rows.map(function (i) { var d = i.data; return '<tr style="border-top:1px solid #e2e7ee"><td style="padding:5px 8px"><b>' + esc(d.so_no ? 'SO ' + d.so_no : 'Part check') + '</b> ' + esc(d.part_no || '') + '</td><td style="padding:5px 8px">' + esc(d.customer || '') + '</td><td style="padding:5px 8px">' + esc(d.so_qty || '') + '</td><td style="padding:5px 8px">' + esc(ago(i.hoursIn)) + '</td><td style="padding:5px 8px">' + i.number + ' of ' + MAX_EMAILS + (i.number === MAX_EMAILS ? ' (final)' : '') + '</td></tr>'; }).join('') + '</table>';
      }).join('') + (appUrl ? '<p style="margin-top:16px"><a href="' + esc(appUrl) + '">Open the app</a></p>' : '') + '</div>';
    return { subject: subject, text: text.join('\n'), html: html };
  }

  return { WATCHED: WATCHED, FIRST_AFTER_HOURS: FIRST_AFTER_HOURS, REPEAT_AFTER_HOURS: REPEAT_AFTER_HOURS, MAX_EMAILS: MAX_EMAILS, statuses: statuses, due: due, buildEmail: buildEmail };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SOReminders;
