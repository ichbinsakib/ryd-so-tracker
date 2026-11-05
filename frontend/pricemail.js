/**
 * Reads price-update emails (Microsoft Graph message objects) and turns them into price update records.
 * Pure JavaScript with no DOM, so it runs in the browser and in the tests. It never guesses: a part is only
 * extracted from a table row or a "price of PART from $a to $b" sentence in the NEW text of a message
 * (the quoted earlier conversation is cut off), and a date only when the email states it.
 */
var SOMail = (function () {
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function decode(s) {
    return String(s).replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); });
  }
  function strip(h) { return decode(String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }

  // The new text of an email: everything before the quoted earlier messages.
  function topHtml(html) {
    var h = String(html || ''), cut = h.length, m;
    [/<div[^>]*id=["']?(?:divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)/i, /<hr\b/i, /<div[^>]*class=["'][^"']*gmail_quote/i, /<blockquote/i, /-----Original Message-----/i, /From:\s*(?:<[^>]+>\s*)*[A-Z][^<]{2,60}\s*(?:<[^>]+>\s*)*Sent:/i].forEach(function (re) {
      m = re.exec(h); if (m && m.index < cut) cut = m.index;
    });
    return h.slice(0, cut);
  }

  function price(s) { var m = /\$?\s*(\d[\d,]*\.\d{1,2})\b/.exec(String(s)); return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 10000) / 10000 : null; }
  function isPart(s) { return /^[0-9][0-9A-Za-z]{2,}(?:[-\/][0-9A-Za-z]+)*$/.test(s) && /\d/.test(s) && s.length >= 6; }

  function tables(html) {
    var out = [], tm, re = /<table[\s\S]*?<\/table>/gi;
    while ((tm = re.exec(html))) {
      var rows = [], rm, rr = /<tr[\s\S]*?<\/tr>/gi;
      while ((rm = rr.exec(tm[0]))) {
        var cells = [], cm, cr = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        while ((cm = cr.exec(rm[0]))) cells.push(strip(cm[1]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) out.push(rows);
    }
    return out;
  }

  function fromTable(rows) {
    var head = -1, i, cols = null;
    for (i = 0; i < rows.length && head < 0; i++) {
      var lc = rows[i].map(function (c) { return c.toLowerCase(); });
      var part = lc.findIndex(function (c) { return /^(part|pn|part\s*(number|no|#))/.test(c); });
      var prev = lc.findIndex(function (c) { return /old price|current/.test(c); });
      var orig = lc.findIndex(function (c) { return /previous proposed/.test(c); });
      var next = lc.findIndex(function (c) { return /new price|revised proposed|revised/.test(c); });
      if (next < 0) next = lc.findIndex(function (c, k) { return /proposed/.test(c) && k !== orig; });
      if (part >= 0 && prev >= 0 && next >= 0 && next !== prev) { head = i; cols = { part: part, prev: prev, next: next, orig: orig }; }
    }
    var items = [];
    if (!cols) return items;
    for (i = head + 1; i < rows.length; i++) {
      var r = rows[i], pn = (r[cols.part] || '').replace(/\s+/g, '');
      if (!isPart(pn)) continue;
      var a = price(r[cols.prev]), b = price(r[cols.next]);
      if (a === null || b === null) continue;
      var o = cols.orig >= 0 ? price(r[cols.orig]) : null;
      items.push({ part_no: pn, prev_price: a, new_price: b, orig_new_price: o !== null && o !== b ? o : null });
    }
    return items;
  }

  function fromProse(text) {
    var items = [], re = /price of (?:part(?: number)?\s*)?#?\s*([0-9][0-9A-Za-z\-\/]{5,})[^$]{0,80}\$\s*(\d[\d,]*\.\d{1,2})\s*to\s*\$\s*(\d[\d,]*\.\d{1,2})/gi, m;
    while ((m = re.exec(text))) items.push({ part_no: m[1], prev_price: parseFloat(m[2].replace(/,/g, '')), new_price: parseFloat(m[3].replace(/,/g, '')), orig_new_price: null });
    return items;
  }

  function iso(y, m, d) { var t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') : null; }
  function dateIn(s) {
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return iso(+m[3], +m[1], +m[2]);
    m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
    return m && MONTHS[m[1].slice(0, 3).toLowerCase()] ? iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]) : null;
  }
  // "will take effect on September 30, 2026", "corrected effective date ... will be 11/23/2026"
  function effectiveDate(text) {
    var re = /(?:take effect|go into effect|become effective|effective date[^.]{0,60}?\b(?:will be|is|to be)|effective(?: on| date:))\s*(?:on\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i, m = re.exec(text);
    return m ? dateIn(m[1]) : null;
  }

  function parseMessage(msg) {
    var top = topHtml(msg.body && msg.body.content), text = strip(top), items = [];
    tables(top).forEach(function (t) { items = items.concat(fromTable(t)); });
    if (!items.length) items = fromProse(text);
    return { items: items, effective: items.length ? effectiveDate(text) : null };
  }

  var addr = function (r) { return String((r && r.emailAddress && r.emailAddress.address) || '').toLowerCase(); };
  var nameOf = function (r) { return String((r && r.emailAddress && r.emailAddress.name) || addr(r)); };
  var day = function (iso8) { return String(iso8 || '').slice(0, 10); };
  var isSkye = function (r) { return /(^|[._])ingraham@|skye\.ingraham/.test(addr(r)); };
  var isCamco = function (r) { return /@camcomfginc\.com$/.test(addr(r)); };
  var tidy = function (s) { return String(s || '').replace(/^\s*((re|fw|fwd):\s*)+/i, '').replace(/^\[external\]\s*/i, '').trim(); };
  var fmt = function (iso8) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso8 || ''); return m ? (+m[2]) + '/' + (+m[3]) + '/' + m[1] : ''; };

  /**
   * messages: Graph message objects (subject, from, toRecipients, ccRecipients, sentDateTime, conversationId, bodyPreview, body.content).
   * Returns { items, scanned, skippedNoParts }: one record per part, merged in date order.
   */
  function collect(messages) {
    var msgs = (messages || []).filter(function (m) { return m && m.id; }).sort(function (a, b) { return String(a.sentDateTime).localeCompare(String(b.sentDateTime)); });
    var byPart = {}, order = [], convs = {}, scanned = 0;
    msgs.forEach(function (m) {
      var toSkye = (m.toRecipients || []).concat(m.ccRecipients || []).some(isSkye);
      if (!isCamco(m.from) || !toSkye) return;
      scanned++;
      var p = parseMessage(m), d = day(m.sentDateTime), who = nameOf(m.from);
      p.items.forEach(function (it) {
        var k = it.part_no.toUpperCase(), rec = byPart[k];
        if (!rec) {
          rec = byPart[k] = { part_no: it.part_no, prev_price: it.prev_price, new_price: it.new_price, orig_new_price: it.orig_new_price, sent_by: who, sent_date: d, revised_date: null, effective_date: p.effective,
            source_subject: tidy(m.subject), source_date: d, conversation_id: m.conversationId || '', last_reply_date: null, last_reply_text: '', history: [] };
          order.push(k);
          rec.history.push({ date: d, who: who, text: 'Sent $' + it.prev_price.toFixed(2) + ' to $' + it.new_price.toFixed(2) + (p.effective ? ', effective ' + fmt(p.effective) : '') + '.' });
          convs[m.conversationId] = (convs[m.conversationId] || []).concat(k);
          return;
        }
        var notes = [];
        if (it.new_price !== rec.new_price) {
          rec.orig_new_price = rec.orig_new_price !== null ? rec.orig_new_price : rec.new_price;
          notes.push('Revised price to $' + it.new_price.toFixed(2) + ' (was $' + rec.new_price.toFixed(2) + ')');
          rec.new_price = it.new_price; rec.revised_date = d;
        }
        if (p.effective && p.effective !== rec.effective_date) { notes.push('Effective date ' + (rec.effective_date ? 'changed from ' + fmt(rec.effective_date) + ' to ' : 'set to ') + fmt(p.effective)); rec.effective_date = p.effective; }
        if (notes.length) rec.history.push({ date: d, who: who, text: notes.join('. ') + '.' });
        if (m.conversationId) convs[m.conversationId] = (convs[m.conversationId] || []).concat(k);
      });
    });
    // Skye's replies on the same thread: shown as a flag, never as acceptance
    msgs.forEach(function (m) {
      if (!isSkye(m.from)) return;
      (convs[m.conversationId] || []).forEach(function (k) {
        var rec = byPart[k], d = day(m.sentDateTime);
        if (d > rec.sent_date && (!rec.last_reply_date || d >= rec.last_reply_date)) { rec.last_reply_date = d; rec.last_reply_text = String(m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 240); }
      });
    });
    return { items: order.map(function (k) { return byPart[k]; }), scanned: scanned };
  }

  return { parseMessage: parseMessage, collect: collect, effectiveDate: effectiveDate, topHtml: topHtml };
})();
if (typeof module !== 'undefined') module.exports = SOMail;
