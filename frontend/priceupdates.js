/**
 * Price Increase Tracking rules (admin only section under Lead Time Calculation).
 * Pure JavaScript, no assumptions: a price update is only "Confirmed" when Skye's reply says so (reply = 'confirmed').
 * Sending an email never counts as acceptance. Missing facts are reported as Missing, not guessed.
 * describe(row, todayIso) -> { pct, days, sentAgo, status, tone, alert, missing }
 */
var SOPrice = (function () {
  var SOON_DAYS = 14;        // "Effective Soon" window
  var FOLLOW_DAYS = 14;      // days without a reply before a follow-up is suggested
  var STATUSES = ['Needs Attention', 'Overdue', 'Effective Soon', 'Pending Confirmation', 'Confirmed'];

  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    var t = new Date(+m[1], +m[2] - 1, +m[3]);
    return t.getMonth() === +m[2] - 1 ? t : null;
  }
  function diff(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }
  function num(v) { return v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v); }
  function dshort(s) { var t = parse(s); return t ? (t.getMonth() + 1) + '/' + t.getDate() + '/' + t.getFullYear() : ''; }
  function plural(n, w) { return n + ' ' + w + (Math.abs(n) === 1 ? '' : 's'); }

  function describe(r, todayIso) {
    var today = parse(todayIso) || parse(new Date().toISOString());
    var prev = num(r.prev_price), next = num(r.new_price);
    var eff = parse(r.effective_date), sent = parse(r.sent_date);
    var pct = prev !== null && prev > 0 && next !== null ? (next - prev) / prev * 100 : null;
    var days = eff ? diff(eff, today) : null;
    var sentAgo = sent ? diff(today, sent) : null;
    var missing = [];
    if (prev === null) missing.push('previous price');
    if (next === null) missing.push('new price');
    if (!sent) missing.push('date sent to Skye');
    if (!eff) missing.push('effective date');
    var reply = r.reply || 'none', status, alert;

    if (reply === 'declined') {
      status = 'Needs Attention';
      alert = 'Skye did not accept this price' + (r.reply_date ? ' (' + dshort(r.reply_date) + ')' : '') + '. Resolve it with Leo/Skye or close the request.';
    } else if (reply === 'disputed') {
      status = 'Needs Attention';
      var rev = r.revised_date ? 'Revised price sent ' + dshort(r.revised_date) + ', no reply yet. ' : '';
      alert = 'Skye questioned this price' + (r.reply_date ? ' on ' + dshort(r.reply_date) : '') + '. ' + rev + (days !== null ? (days >= 0 ? 'Effective in ' + plural(days, 'day') + '; get agreement first.' : 'Effective date passed ' + plural(-days, 'day') + ' ago.') : '');
    } else if (missing.length) {
      status = 'Needs Attention';
      alert = 'Missing: ' + missing.join(', ') + '. Review the source email.';
    } else if (reply === 'confirmed') {
      if (days < 0 && r.implemented !== true) { status = 'Overdue'; alert = 'Effective ' + plural(-days, 'day') + ' ago; confirmed by Skye but implementation is not verified.'; }
      else { status = 'Confirmed'; alert = ''; }
    } else if (days < 0) {
      status = 'Overdue';
      alert = 'Effective date passed ' + plural(-days, 'day') + ' ago and Skye has not confirmed. Check which price Raymond is using.';
    } else if (days <= SOON_DAYS) {
      status = 'Effective Soon';
      alert = (days === 0 ? 'Effective today' : 'Effective in ' + plural(days, 'day')) + ' with no confirmation. Follow up with Skye now.';
    } else {
      status = 'Pending Confirmation';
      alert = sentAgo >= FOLLOW_DAYS ? 'No reply for ' + plural(sentAgo, 'day') + '. Follow up with Skye.' : '';
    }
    var tone = status === 'Confirmed' ? 'ok' : status === 'Needs Attention' || status === 'Overdue' ? 'bad' : status === 'Effective Soon' ? 'warn' : 'muted';
    return { pct: pct, days: days, sentAgo: sentAgo, status: status, tone: tone, alert: alert, missing: missing };
  }

  // Summary figures for the top of the section
  function summarize(rows, todayIso) {
    var out = { total: rows.length, awaiting: 0, soon7: 0, overdue: 0, attention: 0 };
    rows.forEach(function (r) {
      var d = describe(r, todayIso);
      if ((r.reply || 'none') === 'none' || r.reply === 'disputed') out.awaiting++;
      if (d.days !== null && d.days >= 0 && d.days <= 7) out.soon7++;
      if (d.status === 'Overdue') out.overdue++;
      if (d.status === 'Overdue' || d.status === 'Needs Attention') out.attention++;
    });
    return out;
  }

  return { STATUSES: STATUSES, SOON_DAYS: SOON_DAYS, describe: describe, summarize: summarize };
})();
if (typeof module !== 'undefined') module.exports = SOPrice;
