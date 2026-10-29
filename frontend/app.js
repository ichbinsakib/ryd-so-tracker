/* Shop Order Tracking Details frontend. No build step. All access control is enforced by the backend. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null, email: '', role: null, fields: [], byKey: {}, intake: null,
    dash: null, view: [], page: 0, pageSize: 50, chip: 'all', sort: 'progress', stage: '', mat: '',
    current: null, dirty: false, saving: false, scans: [], tab: 0, users: [], bootstrap: []
  };
  const LOOKUP_KEYS = ['steel_type', 'router_bar_size', 'qty_per_bar'];
  const BAR_KEYS = ['so_release_status_bar', 'mat_status_bar'];
  // Editable sections of an SO, grouped the way a buyer works through it.
  // Tabs mirror the lifecycle stepper: [title, stages covered, fields (a..b = a field range in column order)]
  const TAB_DEFS = [
    ['Decide & quantity', [1, 2], ['notes', 'status', 'so_required', 'so_required_note', 'champion', 'customer', 'part_no', 'part_rev', 'part_price', 'so_qty', 'due_date']],
    ['Quote', [3, 4], ['steel_type..update_mat_cost_date', 'supplier', 'quote_expected_date', 'quote_valid_until', 'quote_analysis', 'quote_approve_date']],
    ['SO request & number', [5, 6], ['kanban_or_po', 'so_type', 'so_req_date', 'req_by', 'appr_date', 'gap', 'so_no', 'so_no_received_date']],
    ['PO & acknowledgment', [7, 8], ['po_receive_date', 'po_no_1', 'po_mention_bar_size', 'router_vs_po', 'price_on_po', 'quote_vs_po_price', 'po_approve_date', 'ack_status', 'ack_date', 'ack_note']],
    ['Documents & release', [9, 10], ['print_traveller..update_date']],
    ['Material arrival', [11, 11], ['po_no_2', 'po_due_date', 'mat_required_date', 'mat_receive_date_stockroom', 'verify_date', 'qty_in_stockroom']],
    ['Invoice & closure', [12, 13], ['invoice_received_finance..diff_updated_po_invoice', 'invoice_checked_by', 'note', 'expected_closure_date', 'so_close_date', 'closure_verified_date', 'closure_note']],
    ['Follow-up', [], ['owner', 'last_followup_date', 'next_followup_date', 'escalated', 'blocker']]
  ];
  let tabCache = null;
  function tabList() {
    if (tabCache && tabCache.n === state.fields.length) return tabCache.list;
    const order = state.fields.map((f) => f.key), used = new Set();
    const list = TAB_DEFS.map(([title, stages, items]) => {
      const keys = [];
      items.forEach((it) => { const [a, b] = it.split('..'); const i = order.indexOf(a), j = b ? order.indexOf(b) : i; if (i >= 0) order.slice(i, j + 1).forEach((k) => { if (!used.has(k)) { used.add(k); keys.push(k); } }); });
      return [title, stages, keys];
    });
    const rest = order.filter((k) => !used.has(k) && k !== 'record_id'); list[list.length - 1][2].push(...rest);   // anything unlisted lands on the last tab
    tabCache = { n: state.fields.length, list }; return list;
  }
  const tabForStage = (n) => { const i = tabList().findIndex((t) => t[1].includes(n)); return i < 0 ? 0 : i; };
  const PEOPLE_KEYS = ['champion', 'req_by', 'owner'];
  const VIEWS = ['view-loading', 'view-users', 'view-login', 'view-home', 'view-admin', 'view-new', 'view-detail', 'view-subcon', 'view-dash'];

  // ---------- helpers
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => n.append(c));
    return n;
  }
  const norm = (v) => (v === null || v === undefined ? '' : String(v));
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? norm(iso) : d.toLocaleString(); };
  const daysAgo = (iso) => { const d = new Date(iso); return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 86400000); };
  const money = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toFixed(2));
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  // The sheet shows dates as MM/DD/YY; typed dates come back as ISO.
  function parseDate(s) {
    s = norm(s).trim(); let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
    return null;
  }
  const daysUntil = (d) => (d ? Math.round((d.getTime() - startOfToday().getTime()) / 86400000) : null);
  const shortDate = (d) => (d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '');
  function parseMoney(s) { const c = norm(s).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'); return /^-?\d+(\.\d+)?$/.test(c) ? parseFloat(c) : null; }
  const initials = (email) => email.split('@')[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  const niceName = (email) => email.split('@')[0].split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function show(id) { VIEWS.forEach((v) => { $(v).hidden = v !== id; }); navSync(id); window.scrollTo(0, 0); }
  function navSync(id) {
    $('sidenav').hidden = id === 'view-login' || id === 'view-loading';
    const on = id === 'view-subcon' ? (SC.section === 'leads' ? 'nav-lead' : 'nav-subcon') : id === 'view-dash' ? 'nav-dash' : 'nav-inhouse';
    ['nav-dash', 'nav-inhouse', 'nav-subcon', 'nav-lead'].forEach((n) => { $(n).classList.toggle('on', n === on); if (n === on) $(n).setAttribute('aria-current', 'page'); else $(n).removeAttribute('aria-current'); });
  }
  function toast(msg, isErr) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, isErr ? 8000 : 3500);
  }
  function confirmDialog(title, bodyNode, okLabel, danger) {
    return new Promise((resolve) => {
      const d = $('dlg'); $('dlg-title').textContent = title;
      const b = $('dlg-body'); b.replaceChildren(bodyNode);
      const ok = $('dlg-ok'); ok.textContent = okLabel || 'OK'; ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
      d.showModal();
    });
  }
  function banner(id, kind, msg, node) { const b = $(id); b.className = kind; b.replaceChildren(node || msg || ''); }

  // Progress bar: 100% = solid green; below that the colour progresses red -> orange -> yellow -> green.
  function pctOf(text) { const n = parseFloat(String(text).replace('%', '')); return isNaN(n) || !/%/.test(String(text)) ? null : Math.max(0, Math.min(100, n)); }
  function barNode(text) {
    const p = typeof text === 'number' ? Math.max(0, Math.min(100, text)) : pctOf(text);
    if (p === null || p === undefined) return el('span', { class: 'muted', text: '—' });
    const color = p >= 100 ? 'hsl(135 65% 38%)' : 'hsl(' + Math.round(p * 1.1) + ' 80% 45%)';
    return el('div', { class: 'bar' + (p >= 100 ? ' bar-done' : ''), title: p + '%', role: 'progressbar', 'aria-valuenow': String(p), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      el('i', { style: 'width:' + p + '%;background:' + color }), el('span', { text: (p % 1 ? p.toFixed(1) : p) + '%' }));
  }
  function statusPill(s) {
    s = norm(s).trim(); if (!s) return el('span', { class: 'muted', text: '—' });
    const cls = /OPEN/.test(s) ? 's-open' : /HOLD/.test(s) ? 's-hold' : /CLOSE/.test(s) ? 's-close' : /ANALYSIS|ANR|RFS/.test(s) ? 's-analysis' : '';
    return el('span', { class: 'pill ' + cls, text: s.replace(/^\d\.\s*/, '') });
  }
  // Due-date cell: date plus a relative badge (overdue = red, within a week = amber).
  function dueNode(d, closed) {
    if (!d) return el('span', { class: 'muted', text: '—' });
    const n = daysUntil(d);
    let cls = '', label = n === 0 ? 'today' : n > 0 ? 'in ' + n + ' d' : Math.abs(n) + ' d overdue';
    if (!closed) { if (n < 0) cls = 'bad'; else if (n <= 7) cls = 'warn'; } else label = 'closed';
    return el('span', { class: 'due ' + cls }, shortDate(d), el('small', { text: label }));
  }

  // ---- stockroom price / STEEL USAGE check indicators ----
  function priceBadge(rec) {
    const c = rec.priceCheck; if (!c || c.state === 'none') return '';
    if (c.state === 'ok') return el('span', { class: 'chk', title: 'Price matches stockroom sheet (' + money(c.appPrice) + ')', text: '✓' });
    return el('button', { class: 'issue', type: 'button', title: c.reason + ' — click for details', text: '!', onclick: () => showPriceDialog(rec) });
  }
  function showPriceDialog(rec) {
    const c = rec.priceCheck;
    $('dp-title').textContent = 'Price issue · part ' + norm(rec.values.part_no);
    $('dp-body').replaceChildren(
      el('p', { text: c.reason + '.' }),
      el('div', { class: 'prow' }, el('span', { text: 'Worksheet PART PRICE' }), el('strong', { text: money(c.appPrice) })),
      el('div', { class: 'prow' }, el('span', { text: 'Stockroom sheet price' }), el('strong', { text: c.stockPrices.length ? c.stockPrices.map(money).join(', ') : 'not listed' })));
    $('dlg-price').showModal();
  }
  function lookupBadge(rec, key) {
    const c = rec.lookupChecks && rec.lookupChecks[key]; if (!c) return '';
    if (c.state === 'ok') return el('span', { class: 'chk', title: 'Found in STEEL USAGE', text: '✓' });
    return el('button', { class: 'issue', type: 'button', title: c.reason, text: '!', onclick: () => {
      $('dp-title').textContent = 'Missing data · part ' + norm(rec.values.part_no);
      $('dp-body').replaceChildren(el('p', { text: c.reason + '.' }), el('p', { class: 'muted', text: 'An admin can fix this by uploading STEEL USAGE data that includes this part number.' }));
      $('dlg-price').showModal();
    } });
  }

  // ---------- API
  async function api(action, body) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(CFG.API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal,
        body: JSON.stringify(Object.assign({ action, idToken: state.token }, body || {}))
      });
      if (!res.ok) return { ok: false, code: 'HTTP', error: 'Server responded with HTTP ' + res.status + '.' };
      return await res.json();
    } catch (e) {
      return { ok: false, code: 'NETWORK', error: e.name === 'AbortError' ? 'The server took too long to respond.' : 'Cannot reach the server. Check your internet connection and try again.' };
    } finally { clearTimeout(to); }
  }

  // ---------- auth
  async function renderSignIn(container, onToken) {
    if (CFG.DEV_MODE) {
      container.replaceChildren(el('button', { class: 'btn btn-primary', text: 'Dev sign-in (editor)', onclick: () => onToken('tok-editor') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (viewer)', onclick: () => onToken('tok-viewer') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (stranger)', onclick: () => onToken('tok-stranger') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (admin)', onclick: () => onToken('tok-admin') }));
      return;
    }
    const msg = el('p', { class: 'error', role: 'alert' });
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'Email', required: true, 'aria-label': 'Email' });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true, 'aria-label': 'Password' });
    const go = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' });
    const form = el('form', { class: 'loginform' }, email, pw, go, msg);
    email.value = store('lastEmail') || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); go.disabled = true; go.textContent = 'Signing in…'; msg.textContent = '';
      const r = await api('login', { email: email.value, password: pw.value });
      go.disabled = false; go.textContent = 'Sign in';
      if (!r.ok) { msg.textContent = r.error || 'Could not sign in.'; pw.value = ''; pw.focus(); return; }
      store('lastEmail', r.email); onToken(r.token);
    });
    container.replaceChildren(form);
    (email.value ? pw : email).focus();
  }
  async function onSignedIn(token) { state.token = token; store('tok', token); $('login-msg').textContent = ''; await start(); }
  function signOut() {
    if (state.token && !CFG.DEV_MODE) api('logout');
    state.token = null; store('tok', null); state.dash = null; state.current = null; state.dirty = false;
    $('userchip').hidden = true; $('btn-signout').hidden = true; $('btn-pw').hidden = true; $('btn-refresh').hidden = true; $('refreshed').textContent = '';
    showLogin('');
  }
  async function showLogin(msg) {
    show('view-login'); $('login-msg').textContent = msg || '';
    try { await renderSignIn($('g-signin'), onSignedIn); } catch (e) { $('login-msg').textContent = e.message; }
  }

  // ---------- start / home
  async function start() {
    show('view-loading');
    const r = await api('start', { today: today(), includeClosed: true });
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      if (r.code === 'FORBIDDEN') { signOut(); return showLogin(r.error); }
      return showLogin(r.error || 'Could not reach the server.');
    }
    Object.assign(state, { email: r.email, role: r.role, fields: r.fields, intake: r.intake });
    state.byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
    $('avatar').textContent = initials(r.email); $('user-name').textContent = niceName(r.email); $('user-role').textContent = r.role;
    $('userchip').hidden = false; $('btn-signout').hidden = false; $('btn-pw').hidden = CFG.DEV_MODE;
    state.dirty = false; state.current = null; updateSaveBar();
    // admins get the inhouse list in the same round trip
    if (r.dashboard) { setDashMode(); state.dashAll = r.dashboard; state.dashAt = Date.now(); applyDashboard(withoutClosed(r.dashboard)); }
    openDash();
  }
  const isAdmin = () => state.role === 'admin';
  // the dashboard data is fetched once and reused for a minute; any save, upload or delete makes it stale
  const FRESH_MS = 60000, isFresh = (at) => !!at && Date.now() - at < FRESH_MS;
  const staleDash = () => { state.dashAll = null; state.dashAt = 0; state.dashListAt = 0; };
  const withoutClosed = (r) => Object.assign({}, r, { rows: r.rows.filter((x) => !/CLOSE/.test(norm(x.status))) });
  function setDashMode() {
    const admin = isAdmin();
    $('dash-title').textContent = admin ? 'Inhouse' : 'My SOs';
    $('dash-sub').textContent = admin ? 'Progress of every sales order that is not closed.' : 'Sales orders you opened or are responsible for, with their progress.';
    $('fresh-cards').hidden = state.role === 'viewer'; $('admin-users').hidden = !admin; $('admin-new').hidden = state.role === 'viewer';
    if (!admin && !state.sortSet) { state.sort = 'due'; $('sort').value = 'due'; state.sortSet = true; }
  }
  function goHome() {
    state.dirty = false; state.current = null; updateSaveBar();
    return loadDashboard();
    $('btn-refresh').hidden = true; $('refreshed').textContent = '';
    $('home-greet').textContent = 'Welcome, ' + niceName(state.email).split(' ')[0];
    $('home-new').hidden = state.role === 'viewer'; $('home-msg').textContent = ''; $('home-find-input').value = '';
    show('view-home');
  }
  async function leaveGuard() {
    if (!state.dirty) return true;
    return confirmDialog('Discard unsaved changes?', el('p', { text: 'You have unsaved changes. If you leave they will be lost.' }), 'Discard and leave', true);
  }

  // ---------- find an SO
  async function findSO(text, msgEl) {
    msgEl.textContent = ''; const so = text.trim();
    if (!so) { msgEl.textContent = 'Enter an SO number.'; return; }
    const r = await api('findSO', { so_no: so });
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      msgEl.textContent = r.error; return;
    }
    if (r.records.length === 1) return openRecord(r.records[0]);
    $('dp-title').textContent = r.records.length + ' SOs share this number';
    $('dp-body').replaceChildren(el('p', { text: 'Choose which one to open:' }), ...r.records.map((rec) => el('div', { class: 'prow' },
      el('span', { text: 'Part ' + norm(rec.values.part_no) + ' · ' + norm(rec.values.customer) + ' · ' + norm(rec.values.status) }),
      el('button', { class: 'btn', type: 'button', text: 'Open', onclick: () => { $('dlg-price').close(); openRecord(rec); } }))));
    $('dlg-price').showModal();
  }

  // ---------- dashboard: overview of inhouse and subcontractor work
  const DASH_LIST = 8;
  async function openDash() {
    if (!state.token || !state.role) return;
    if (!(await leaveGuard())) return;
    state.dirty = false; state.current = null; updateSaveBar(); setDashMode();
    show('view-dash'); $('btn-refresh').hidden = false; $('dash2-new').hidden = state.role === 'viewer';
    return loadDash(false);
  }
  async function loadDash(fresh) {
    const st = $('dash2-status'); st.className = 'statusline'; st.textContent = 'Loading…';
    $('btn-refresh').disabled = true;
    const reuse = !fresh && state.dashAll && isFresh(state.dashAt);
    const [inh, sc] = await Promise.all([reuse ? Promise.resolve(state.dashAll) : api(isAdmin() ? 'dashboard' : 'mySOs', { includeClosed: true, fresh: !!fresh, today: today() }), api('scList', { today: today() })]);
    $('btn-refresh').disabled = false;
    const bad = [inh, sc].find((x) => !x.ok);
    if (bad && bad.code === 'UNAUTHENTICATED') return showLogin(bad.error);
    if (sc.ok) SC.data = sc;
    state.dashAll = inh.ok ? inh : null; if (inh.ok && !reuse) state.dashAt = Date.now();
    st.className = 'statusline' + (bad ? ' err' : ''); st.textContent = bad ? bad.error + ' (some data unavailable)' : '';
    renderDash(state.dashAll, sc.ok ? sc : null);
  }
  const REPORT_CAP = 8;
  const SECTIONS = [['A', 'Immediate actions', 'Needs you now', 'warn'], ['B', 'Blocked shop orders', 'Waiting on someone else', 'info'], ['C', 'Material and production risks', 'Late or at-risk material', 'bad'],
    ['D', 'Upcoming SO due dates', 'Due within 14 days, in monitoring', 'info'], ['E', 'Overdue SOs', 'Past due without verified closure', 'bad'], ['F', 'Completed', 'Verified closures, last 14 days', 'ok']];
  function reportSections(dash) {
    const by = {}; SECTIONS.forEach(([k]) => { by[k] = []; });
    (dash ? dash.rows : []).forEach((r) => {
      const lc = r.lc; if (!lc || !lc.section) return;
      if (lc.section === 'F') { const n = lc.closedOn ? daysUntil(parseDate(lc.closedOn)) : null; if (n === null || n < -14) return; }
      by[lc.section].push(r);
    });
    Object.values(by).forEach((a) => a.sort((x, y) => x.lc.rank - y.lc.rank));
    return by;
  }
  const soLabel = (r) => (norm(r.so_no) ? 'SO ' + norm(r.so_no) : 'Part check');
  function reportItem(r, sec) {
    const lc = r.lc;
    const lines = sec === 'F' ? [['Closed', dshort(lc.closedOn)]] : [['Action', lc.next || '—'], [lc.owner === 'me' ? 'Who' : 'Waiting on', lc.owner === 'me' ? 'Me' : (lc.waitingOn || '—')], ['Do by', lc.actionDate ? dshort(lc.actionDate) : '—'], ['Follow-up', lc.followup ? dshort(lc.followup) : '—']];
    return el('button', { class: 'ditem ritem', type: 'button', onclick: () => openById(r.id) },
      el('span', { class: 'so', text: soLabel(r) }),
      el('span', { class: 'dmain' }, el('b', { text: norm(r.part_no) + ' · ' + norm(r.customer) + (norm(r.qty) ? ' · ' + norm(r.qty) + ' pcs' : '') }), el('small', { text: r.stage + ' · ' + lc.status + (norm(r.due) ? ' · due ' + dshort(toIso(norm(r.due))) : '') }),
        lc.reasons.length ? el('span', { class: 'nextwhy' }, lc.reasons.slice(0, 4).map((x) => el('span', { class: 'badge ' + (x.level === 'crit' ? 'sc-bad' : x.level === 'warn' ? 'sc-warn' : 'sc-muted'), text: x.text }))) : ''),
      el('span', { class: 'rlines' }, lines.map(([k, v]) => el('span', {}, el('small', { text: k }), ' ', v))));
  }
  const toIso = (s) => { const d = parseDate(s); return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; };
  function reportText() {
    const by = reportSections(state.dashAll), out = ['SHOP ORDER REPORT: ' + today(), ''];
    SECTIONS.forEach(([k, title]) => {
      out.push(k + '. ' + title.toUpperCase() + ' (' + by[k].length + ')');
      if (!by[k].length) out.push('  none');
      by[k].forEach((r) => { const lc = r.lc; out.push('- ' + [norm(r.part_no), soLabel(r), r.stage + ' / ' + lc.status, k === 'F' ? 'closed ' + lc.closedOn : 'Action: ' + (lc.next || '—'), lc.owner === 'me' ? 'Who: me' : lc.waitingOn ? 'Waiting on: ' + lc.waitingOn : '', lc.actionDate ? 'By: ' + lc.actionDate : '', lc.followup ? 'Follow-up: ' + lc.followup : '', lc.reasons.length ? 'Issues: ' + lc.reasons.map((x) => x.text).join('; ') : ''].filter(Boolean).join(' | ')); });
      out.push('');
    });
    return out.join('\n');
  }
  function renderDash(dash, sc) {
    const by = reportSections(dash);
    const tile = (k, title, sub, tone) => el('button', { class: 'kpi kpi-go ' + (by[k].length ? tone : 'ok'), type: 'button', onclick: () => { const t = $('rep-' + k); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      el('div', { class: 'kv', text: String(by[k].length) }), el('div', { class: 'kl', text: k + '. ' + title }));
    $('dash2-tiles').replaceChildren(...(dash ? SECTIONS.map(([k, t, s, tone]) => tile(k, t, s, tone)) : [el('p', { class: 'muted', text: 'Shop order data is unavailable.' })]));
    $('dash2-report').replaceChildren(...(dash ? SECTIONS.filter(([k]) => by[k].length || k === 'A').map(([k, title, sub]) => el('section', { class: 'card rsec', id: 'rep-' + k },
      el('div', { class: 'sechead' }, el('h3', { text: k + '. ' + title }), el('span', { class: 'muted small', text: sub + ' · ' + by[k].length })),
      by[k].length ? el('div', { class: 'dlist' }, ...by[k].slice(0, state.repAll && state.repAll[k] ? by[k].length : REPORT_CAP).map((r) => reportItem(r, k)),
        by[k].length > REPORT_CAP ? el('button', { class: 'btn btn-sm dmore', type: 'button', text: state.repAll && state.repAll[k] ? 'Show fewer' : 'Show all ' + by[k].length + ' ›', onclick: () => { state.repAll = state.repAll || {}; state.repAll[k] = !state.repAll[k]; renderDash(dash, sc); } }) : '') : el('p', { class: 'muted', text: 'Nothing needs your action right now.' }))) : []));
    const kp = (cls, v, l, go) => el('button', { class: 'kpi kpi-go ' + cls, type: 'button', onclick: go }, el('div', { class: 'kv', text: String(v) }), el('div', { class: 'kl', text: l }));
    const k = sc && sc.kpis, toQueue = () => { SC.tab = 'queue'; openSubcon('subcon'); };
    $('dash2-kpis-sc').replaceChildren(...(k ? [kp('info', k.open, 'Open lines', () => openSubcon('subcon')), kp(k.needsAction ? 'warn' : 'ok', k.needsAction, 'Need my action', toQueue),
      kp(k.pastDue ? 'bad' : 'ok', k.pastDue, 'Past due', toQueue), kp(k.blocked ? 'bad' : 'ok', k.blocked, 'Blocked / on hold', toQueue)] : [el('p', { class: 'muted', text: 'Subcontractor data is unavailable.' })]));
  }

  // ---------- inhouse list
  async function loadDashboard(fresh) {
    setDashMode(); show('view-admin'); $('btn-refresh').hidden = false;
    if (!fresh && state.dash && isFresh(state.dashListAt) && state.dashClosed === $('incl-closed').checked) { applyDashboard(state.dash); return; }
    $('grid').tBodies[0].replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted', text: 'Loading…' })));
    const ls = $('list-status'); ls.className = 'statusline'; ls.textContent = '';
    $('btn-refresh').disabled = true;
    const r = await api(isAdmin() ? 'dashboard' : 'mySOs', { includeClosed: $('incl-closed').checked, fresh: !!fresh, today: today() });
    $('btn-refresh').disabled = false;
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      ls.className = 'statusline err'; ls.textContent = r.error + ' (data unavailable)'; return;
    }
    state.dashListAt = Date.now(); state.dashClosed = $('incl-closed').checked;
    applyDashboard(r);
  }
  function applyDashboard(r) {
    state.dash = r;
    $('refreshed').textContent = 'Updated ' + new Date(r.refreshedAt).toLocaleTimeString();
    renderKpis(r.rows); renderPipeline(r.rows); renderMatReq(r.rows); if (r.stock) renderCards(r); buildChips(); applyView();
  }
  const rowClosed = (r) => /CLOSE/.test(norm(r.status));
  const rowDue = (r) => parseDate(r.due);
  const rowProgress = (r) => { const a = [r.soBar, r.matBar].filter((x) => x !== null); return a.length ? Math.min.apply(null, a) : 1000; };
  const awaitingQuote = (r) => norm(r.reqQuote).trim().toUpperCase() === 'YES' && !/^(y|stock|req|rec)/i.test(norm(r.quoteReceived).trim());
  function renderKpis(rows) {
    const open = rows.filter((r) => !rowClosed(r));
    const overdue = open.filter((r) => { const n = daysUntil(rowDue(r)); return n !== null && n < 0; }).length;
    const soon = open.filter((r) => { const n = daysUntil(rowDue(r)); return n !== null && n >= 0 && n <= 7; }).length;
    const aq = open.filter(awaitingQuote).length;
    const avg = (key) => { const v = open.map((r) => r[key]).filter((x) => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) + '%' : '—'; };
    const k = (cls, value, label) => el('div', { class: 'kpi ' + cls }, el('div', { class: 'kv', text: String(value) }), el('div', { class: 'kl', text: label }));
    $('kpis').replaceChildren(k('info', open.length, 'Open SOs'), k(overdue ? 'bad' : 'ok', overdue, 'Overdue'), k(soon ? 'warn' : 'ok', soon, 'Due in 7 days'),
      k(aq ? 'warn' : 'ok', aq, 'Awaiting quote'), k('info', avg('soBar'), 'Avg SO release'), k('info', avg('matBar'), 'Avg material'));
  }
  // ---------- inhouse planning: pipeline by stage, material roll-up
  const STAGE_GROUPS = TAB_DEFS.filter((t) => t[1].length);   // same groups as the SO page
  const groupOf = (r) => { const g = r.lc ? STAGE_GROUPS.find((t) => t[1].includes(r.lc.stage)) : null; return g ? g[0] : ''; };
  const rowOpen = (r) => !rowClosed(r) && !(r.lc && (r.lc.status === 'Closed — Verified' || r.lc.status === 'Cancelled / Not Required'));
  const matKey = (r) => (r.steelType ? [r.steelType, r.barType, r.barSize].map((x) => x || '?').join(' | ') : '');
  const fmtN = (n, d) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 1 : d }));
  function renderPipeline(rows) {
    const open = rows.filter(rowOpen);
    $('pipeline').replaceChildren(...STAGE_GROUPS.map(([title, stages], i) => {
      const here = open.filter((r) => groupOf(r) === title), late = here.filter((r) => { const n = daysUntil(rowDue(r)); return n !== null && n < 0; }).length, mine = here.filter((r) => r.lc && r.lc.owner === 'me').length;
      const pcs = here.reduce((t, r) => t + (parseFloat(norm(r.qty).replace(/,/g, '')) || 0), 0);
      return el('li', {}, el('button', { class: 'pstage' + (state.stage === title ? ' on' : '') + (late ? ' late' : '') + (here.length ? '' : ' empty'), type: 'button', 'aria-pressed': String(state.stage === title),
        title: 'Stages ' + stages[0] + (stages.length > 1 ? '–' + stages[stages.length - 1] : ''), onclick: () => { state.stage = state.stage === title ? '' : title; renderPipeline(state.dash.rows); applyView(); } },
        el('span', { class: 'pn', text: String(i + 1) }), el('b', { text: title }), el('span', { class: 'pc', text: String(here.length) }),
        el('small', { text: here.length ? [pcs ? fmtN(pcs, 0) + ' pcs' : '', mine ? mine + ' need me' : '', late ? late + ' late' : ''].filter(Boolean).join(' · ') : '—' })));
    }));
  }
  function renderMatReq(rows) {
    const need = rows.filter((r) => rowOpen(r) && !r.matReceived && !(r.lc && r.lc.stage < 6));
    const groups = {}, nodata = [];
    need.forEach((r) => {
      const k = matKey(r); if (!k) { nodata.push(r); return; }
      const g = groups[k] || (groups[k] = { key: k, steel: r.steelType, bar: r.barType, size: r.barSize, sos: 0, pcs: 0, bars: 0, ft: 0, lbs: 0, short: 0, unknown: 0 });
      g.sos++; g.pcs += parseFloat(norm(r.qty).replace(/,/g, '')) || 0; g.bars += r.reqBar || 0; g.ft += r.reqFt || 0; g.lbs += r.reqLbs || 0;
      if (r.reqFt === null || r.availFt === null) g.unknown++; else if (r.availFt < r.reqFt) g.short++;
    });
    const list = Object.values(groups).sort((x, y) => y.lbs - x.lbs);
    const tot = list.reduce((t, g) => ({ bars: t.bars + g.bars, ft: t.ft + g.ft, lbs: t.lbs + g.lbs }), { bars: 0, ft: 0, lbs: 0 });
    $('matreq-sub').textContent = need.length ? ' · ' + need.length + ' open SO' + (need.length === 1 ? '' : 's') + ' still waiting for material · ' + fmtN(Math.ceil(tot.bars), 0) + ' bars · ' + fmtN(tot.ft, 0) + ' ft · ' + fmtN(tot.lbs, 0) + ' lbs' : ' · nothing waiting for material';
    $('matreq').tHead.replaceChildren(el('tr', {}, ['STEEL', 'BAR', 'BAR SIZE', 'SOs', 'PCS', 'BARS', 'FEET', 'LBS', 'STOCK', ''].map((t) => el('th', { text: t }))));
    const row = (g) => el('tr', { class: 'clickrow' + (state.mat === g.key ? ' picked' : ''), onclick: () => { state.mat = state.mat === g.key ? '' : g.key; renderMatReq(state.dash.rows); applyView(); } },
      el('td', {}, el('b', { text: g.steel })), el('td', { text: g.bar || '—' }), el('td', { text: g.size || '—' }), el('td', { text: String(g.sos) }), el('td', { text: fmtN(g.pcs, 0) }),
      el('td', {}, el('b', { text: fmtN(Math.ceil(g.bars), 0) })), el('td', { text: fmtN(g.ft, 0) }), el('td', { text: fmtN(g.lbs, 0) }),
      el('td', {}, g.short ? el('span', { class: 'badge sc-bad', text: g.short + ' short' }) : g.unknown === g.sos ? el('span', { class: 'badge sc-muted', text: 'unknown' }) : el('span', { class: 'badge sc-ok', text: 'covered' }), g.short && g.unknown ? el('small', { class: 'muted', text: ' +' + g.unknown + ' unknown' }) : ''),
      el('td', { class: 'muted small', text: state.mat === g.key ? 'filtering ✕' : 'show SOs' }));
    const body = list.map(row);
    if (nodata.length) body.push(el('tr', { class: 'clickrow' + (state.mat === 'none' ? ' picked' : ''), onclick: () => { state.mat = state.mat === 'none' ? '' : 'none'; renderMatReq(state.dash.rows); applyView(); } },
      el('td', { colspan: 3 }, el('b', { text: 'No steel data' }), el('small', { class: 'muted', text: '  parts missing from STEEL USAGE, so the need cannot be calculated' })), el('td', { text: String(nodata.length) }), el('td', { colspan: 6, class: 'muted small', text: state.mat === 'none' ? 'filtering ✕' : 'show SOs' })));
    $('matreq').tBodies[0].replaceChildren(...(body.length ? body : [el('tr', {}, el('td', { colspan: 10, class: 'muted', text: 'Every open SO has its material.' }))]));
    $('matreq-card').hidden = !rows.length;
  }
  function freshness(cardId, whenId, subId, whenIso, subText, emptyText, staleDays) {
    const card = $(cardId), w = $(whenId), s = $(subId);
    card.classList.remove('stale', 'never');
    if (!whenIso) { w.textContent = emptyText; s.textContent = 'Upload a file to enable checks.'; card.classList.add('never'); return; }
    const d = daysAgo(whenIso);
    w.textContent = fmtWhen(whenIso);
    s.textContent = (d === null ? '' : d === 0 ? 'Updated today' : 'Updated ' + d + ' day' + (d === 1 ? '' : 's') + ' ago') + (subText ? ' · ' + subText : '');
    if (d !== null && d > (staleDays || 30)) card.classList.add('stale');
  }
  function renderCards(r) {
    const dc = $('data-card'), inv = r.stock && r.stock.meta ? daysAgo(r.stock.meta.uploadedAt) : null, needs = !r.stock || !r.stock.has || inv === null || inv > 1 || !(r.steel && r.steel.meta);
    $('data-sub').textContent = !r.stock || !r.stock.has ? '· inventory never uploaded' : inv > 1 ? '· inventory is ' + inv + ' days old: upload today\'s file' : '· inventory up to date'; $('data-sub').className = 'small ' + (needs ? 'tone-bad' : 'muted');
    if (needs && !state.dataSeen) { dc.open = true; state.dataSeen = true; }
    const sm = r.stock.meta || {};
    freshness('card-stock', 'stock-when', 'stock-sub', r.stock.has ? sm.uploadedAt : null,
      r.stock.count.toLocaleString() + ' parts' + (sm.uploadedBy ? ' · by ' + sm.uploadedBy : '') + (sm.fileName ? ' · ' + sm.fileName : '') + (daysAgo(sm.uploadedAt) > 1 ? ' · upload today\'s file' : ''), 'Never uploaded', 1);
    const st = r.steel.meta;
    freshness('card-steel', 'steel-when', 'steel-sub', st ? st.at : null,
      st ? st.count + ' rows' + (st.by ? ' · by ' + st.by : '') + (st.fileName ? ' · ' + st.fileName : '') : '', 'Not updated through the app yet');
  }
  const CHIPS = [['all', 'All'], ['mine', 'Needs my action'], ['blocked', 'Blocked'], ['1. ANALYSIS', 'Analysis'], ['3.OPEN', 'Open'], ['5.HOLD', 'On hold'], ['late', 'Overdue'], ['quote', 'Awaiting quote'], ['4.CLOSE', 'Closed']];
  function chipMatch(r, c) {
    if (c === 'all') return true; if (c === 'late') { const n = daysUntil(rowDue(r)); return !rowClosed(r) && n !== null && n < 0; }
    if (c === 'mine') return rowOpen(r) && !!r.lc && r.lc.owner === 'me'; if (c === 'blocked') return rowOpen(r) && !!r.lc && r.lc.section === 'B';
    if (c === 'quote') return !rowClosed(r) && awaitingQuote(r); return norm(r.status).trim() === c;
  }
  function buildChips() {
    const rows = state.dash ? state.dash.rows : [];
    $('chips').replaceChildren(...CHIPS.filter(([c]) => c !== '4.CLOSE' || $('incl-closed').checked).map(([c, label]) =>
      el('button', { class: 'chip' + (state.chip === c ? ' on' : ''), type: 'button', 'aria-pressed': String(state.chip === c), onclick: () => { state.chip = c; buildChips(); applyView(); } },
        label, el('b', { text: String(rows.filter((r) => chipMatch(r, c)).length) }))));
  }
  function applyView() {
    const q = $('q').value.trim().toLowerCase();
    const rows = (state.dash ? state.dash.rows : []).filter((r) => chipMatch(r, state.chip) && (!state.stage || (rowOpen(r) && groupOf(r) === state.stage)) && (!state.mat || (rowOpen(r) && !r.matReceived && (state.mat === 'none' ? !matKey(r) : matKey(r) === state.mat))) && (!q || [r.so_no, r.part_no, r.customer, r.steelType].some((v) => norm(v).toLowerCase().includes(q))));
    const soNum = (r) => { const n = parseFloat(norm(r.so_no).replace(/\D/g, '')); return isNaN(n) ? -1 : n; };
    if (state.sort === 'due') rows.sort((a, b) => { const x = rowDue(a), y = rowDue(b); return (x ? x.getTime() : 9e15) - (y ? y.getTime() : 9e15); });
    else if (state.sort === 'so') rows.sort((a, b) => soNum(b) - soNum(a));
    else rows.sort((a, b) => rowProgress(a) - rowProgress(b));
    state.view = rows; state.page = 0; renderTable();
  }
  function renderTable() {
    $('grid').tHead.replaceChildren(el('tr', {}, ['SO#', 'Part / customer', 'Stage', 'Next action', 'Due', 'Material', 'Progress', ''].map((h) => el('th', { text: h }))));
    const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = state.view.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
    const body = $('grid').tBodies[0];
    const mpill = (m) => el('span', { class: 'badge ' + (m === 'Late' ? 'sc-bad' : m === 'At Risk' ? 'sc-warn' : m === 'Unknown' ? 'sc-muted' : 'sc-ok'), text: m });
    if (!slice.length) body.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'muted', text: state.dash && state.dash.rows.length ? 'No SOs match your filter.' : (isAdmin() ? 'No open SOs.' : 'You have no open SOs yet. Use Open an SO, or find one by its number.') })));
    else body.replaceChildren(...slice.map((r) => el('tr', { tabindex: 0, onclick: () => openById(r.id), onkeydown: (e) => { if (e.key === 'Enter') openById(r.id); } },
      el('td', {}, el('div', { class: 'cell2' }, el('span', { class: 'so', text: norm(r.so_no) || 'Part check' }), el('small', { text: norm(r.qty) ? norm(r.qty) + ' pcs' : '' }))),
      el('td', {}, el('div', { class: 'cell2' }, el('span', { text: norm(r.part_no) }), el('small', { text: norm(r.customer) }))),
      el('td', {}, el('div', { class: 'cell2' }, el('span', { class: 'stagepill', text: r.stage || '—' }), el('small', { text: r.lc ? r.lc.status : norm(r.status) }))),
      el('td', {}, el('div', { class: 'cell2' }, el('span', { text: r.lc && r.lc.next ? r.lc.next : '—' }), el('small', { text: r.lc ? (r.lc.owner === 'me' ? 'Me' + (r.lc.actionDate ? ' · by ' + dshort(r.lc.actionDate) : '') : r.lc.waitingOn ? 'Waiting on ' + r.lc.waitingOn + (r.lc.followup ? ' · follow up ' + dshort(r.lc.followup) : '') : '') : '' }))),
      el('td', {}, dueNode(rowDue(r), rowClosed(r))),
      el('td', {}, el('div', { class: 'cell2' }, r.lc && r.lc.matStatus ? mpill(r.lc.matStatus) : el('span', { class: 'muted', text: r.steelType ? 'not ordered' : 'no steel data' }), el('small', { text: r.steelType ? [r.steelType, r.reqBar !== null ? fmtN(Math.ceil(r.reqBar), 0) + ' bars' : ''].filter(Boolean).join(' · ') : '' }))),
      el('td', {}, barNode(rowProgress(r) === 1000 ? null : rowProgress(r))),
      el('td', { class: 'chev' }, rowClosed(r) ? '' : el('button', { class: 'rowdel', type: 'button', title: 'Delete this SO', 'aria-label': 'Delete this SO', text: '🗑', onclick: (e) => { e.stopPropagation(); deleteSO(r.id, norm(r.so_no) || norm(r.part_no)); } }), ' ›'))));
    $('pg-info').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
    $('pg-prev').disabled = state.page === 0; $('pg-next').disabled = state.page >= pages - 1;
    const ls = $('list-status'); ls.className = 'statusline';
    ls.textContent = state.view.length + ' of ' + (state.dash ? state.dash.rows.length : 0) + ' SOs';
    if (state.stage || state.mat) ls.append(' · filtered by ' + (state.stage ? 'stage ' + state.stage : '') + (state.stage && state.mat ? ' and ' : '') + (state.mat ? (state.mat === 'none' ? 'no steel data' : 'material ' + state.mat.split(' | ')[0]) : '') + ' ', el('button', { class: 'btn btn-sm', type: 'button', text: 'Clear filter', onclick: () => { state.stage = ''; state.mat = ''; renderPipeline(state.dash.rows); renderMatReq(state.dash.rows); applyView(); } }));
  }
  async function deleteSO(id, label) {
    if (state.role === 'viewer') return;
    if (!(await confirmDialog('Delete this SO?', el('p', { text: 'SO ' + (label || '') + ' will be permanently removed from the sheet. This cannot be undone. Only unfinished SOs can be deleted.' }), 'Delete SO', true))) return;
    const r = await api('deleteSO', { id });
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      toast(r.error || 'Could not delete the SO.', true); return;
    }
    staleDash(); toast('SO deleted.'); state.dirty = false; state.current = null; updateSaveBar();
    if (state.role === 'admin') loadDashboard(true); else goHome();
  }
  async function openById(id) {
    const r = await api('get', { id });
    if (!r.ok) { toast(r.error || 'Could not open the SO.', true); return; }
    openRecord(r.record);
  }
  const loadList = () => { staleDash(); return loadDashboard(true); };
  function exportCsv() {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const head = ['SO#', 'Part', 'Customer', 'Qty', 'Status', 'Stage', 'Steel', 'Bar', 'Bar size', 'Bars', 'Feet', 'Lbs', 'Due date', 'SO release %', 'Material %'];
    const lines = [head.map(q).join(',')].concat(state.view.map((r) => [norm(r.so_no), norm(r.part_no), norm(r.customer), norm(r.qty), norm(r.status), norm(r.stage), norm(r.steelType), norm(r.barType), norm(r.barSize), r.reqBar === null ? '' : r.reqBar, r.reqFt === null ? '' : r.reqFt, r.reqLbs === null ? '' : r.reqLbs, norm(r.due), r.soBar === null ? '' : r.soBar, r.matBar === null ? '' : r.matBar].map((v) => q(/^[=+@-]/.test(String(v)) ? "'" + v : v)).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = el('a', { href: url, download: 'shop-orders-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('btn-csv').onclick = exportCsv;

  // ---------- open a new SO
  const NEW_CHECK = ['part_no', 'customer', 'so_qty', 'notes'];
  const NEW_SO = ['so_no', 'so_req_date', 'due_date', 'so_type', 'kanban_or_po', 'champion', 'req_by'];
  function newField(key) {
    const f = state.byKey[key]; const req = state.intake.checkRequired.includes(key); const id = 'nf-' + key;
    let input;
    if (key === 'champion' || key === 'req_by') {
      const names = (state.intake.people || []).slice();
      input = el('select', { id }, ['', ...names].map((o) => el('option', { value: o, text: o === '' ? '— choose a person —' : o })));
    } else if (f.type === 'enum') input = el('select', { id }, ['', ...f.options].map((o) => el('option', { value: o, text: o === '' ? '— choose —' : o })));
    else if (f.type === 'date') input = el('input', { id, type: 'date', value: '' });
    else if (f.type === 'longtext') input = el('textarea', { id });
    else input = el('input', { id, type: 'text', inputmode: f.type === 'number' ? 'decimal' : 'text' });
    input.dataset.key = key;
    input.addEventListener('input', () => { const w = input.closest('.field'); w.classList.remove('invalid'); w.querySelector('.ferr')?.remove(); });
    return el('div', { class: 'field' + (req ? ' mandatory' : '') + (f.type === 'longtext' ? ' wide' : '') },
      el('label', { for: id }, f.label, req ? el('span', { class: 'req', title: 'Required', text: ' *' }) : el('span', { class: 'tag', text: 'optional' })), input);
  }
  function openNewForm() {
    state.dirty = false; updateSaveBar();
    const grid = (keys) => el('div', { class: 'grid' }, keys.filter((k) => state.intake.keys.includes(k)).map(newField));
    $('new-form').replaceChildren(el('fieldset', {}, el('legend', { text: 'Part check' }), grid(NEW_CHECK)),
      el('details', { class: 'newdetails card' }, el('summary', { text: 'Already have the SO? Add the SO details now (otherwise request the SO after the quote)' }), grid(NEW_SO)));
    banner('new-banner', '', ''); show('view-new');
    $('nf-part_no').focus();
  }
  function collectNew() { const ch = {}; $('new-form').querySelectorAll('[data-key]').forEach((i) => { ch[i.dataset.key] = i.value.trim(); }); return ch; }
  function showFieldErrors(prefix, errs) {
    Object.entries(errs || {}).forEach(([k, m]) => {
      const i = $(prefix + k); if (!i) return; i.closest('details')?.setAttribute('open', ''); const w = i.closest('.field'); w.classList.add('invalid'); w.querySelector('.ferr')?.remove(); w.append(el('div', { class: 'ferr', text: m }));
    });
    document.querySelector('.field.invalid')?.scrollIntoView({ block: 'center' });
  }
  let creating = false;
  async function submitNew() {
    if (creating) return;
    const ch = collectNew(); const missing = {};
    state.intake.checkRequired.forEach((k) => { if (!ch[k]) missing[k] = state.byKey[k].label + ' is required.'; });
    if (Object.keys(missing).length) { banner('new-banner', 'err', 'Please fill in all required fields.'); showFieldErrors('nf-', missing); return; }
    const table = el('table', {}, el('tbody', {}, state.intake.keys.filter((k) => ch[k]).map((k) => el('tr', {}, el('td', { text: state.byKey[k].label }), el('td', { text: ch[k] })))));
    if (!(await confirmDialog('Open this SO?', table, 'Open SO'))) return;
    creating = true; $('new-submit').disabled = true; $('new-submit').textContent = 'Opening…'; banner('new-banner', '', '');
    const r = await api('createSO', { changes: ch });
    creating = false; $('new-submit').disabled = false; $('new-submit').textContent = 'Open SO';
    if (r.ok) { staleDash(); const chk = isCheck(r.record); toast(chk ? 'Part check opened.' : (norm(r.record.values.so_no) ? 'SO ' + norm(r.record.values.so_no) : 'SO') + ' opened.'); openRecord(r.record, 'ok', chk ? 'Part check opened. The material needed is on the left. Request the quote on the Material & quote tab, then click Request SO when it is in.' : 'SO opened and added to the sheet. Fill in the rest of the details as they arrive, then print it and upload the scan.'); return; }
    if (r.code === 'UNAUTHENTICATED') { banner('new-banner', 'err', r.error + ' Your form is still here — sign in again, then click Open SO.'); const h = el('span'); $('new-banner').append(' ', h); renderSignIn(h, (t) => { state.token = t; store('tok', t); banner('new-banner', 'ok', 'Signed in again. Click Open SO to continue.'); }); return; }
    if (r.code === 'INVALID') { banner('new-banner', 'err', r.error); showFieldErrors('nf-', r.fieldErrors); return; }
    banner('new-banner', 'err', (r.error || 'Could not open the SO.') + ' Nothing was created; your answers are still in the form.');
  }

  // ---------- one SO: workflow, facts, next actions
  const dv = (rec, k) => norm(rec.display[k]).trim();
  const has = (rec, k) => { const v = dv(rec, k); return v !== '' && v !== '-'; };
  const dateOf = (rec, k) => { const t = norm(rec.values[k]); return isIso(t) ? parseDate(t) : parseDate(rec.display[k]); };
  const yes = (v) => /^(y|yes|true)/i.test(norm(v).trim());
  const isCheck = (rec) => /ANALYSIS|ANR/.test(dv(rec, 'status').toUpperCase());
  function workflow(rec) {
    const quoteSkipped = dv(rec, 'req_mat_quote').toUpperCase() === 'NO';
    const lookupBad = rec.lookupChecks && Object.values(rec.lookupChecks).some((c) => c.state === 'issue');
    const closed = /CLOSE/.test(dv(rec, 'status')) || has(rec, 'so_close_date');
    const S = [];
    S.push({ label: 'Check', raw: isCheck(rec) ? 'todo' : 'done', date: null });
    S.push({ label: 'Order', raw: has(rec, 'so_no') && has(rec, 'due_date') ? 'done' : 'todo', date: dateOf(rec, 'so_req_date') });
    S.push({ label: 'Material', raw: lookupBad ? 'issue' : (rec.lookupChecks ? 'done' : (has(rec, 'steel_type') ? 'done' : 'todo')), date: null });
    S.push({ label: quoteSkipped ? 'Quote (n/a)' : 'Quote', raw: quoteSkipped ? 'skip' : (has(rec, 'quote_receive_date') || /^(y|stock)/i.test(dv(rec, 'quote_received')) ? 'done' : (has(rec, 'mat_quote_request_date') ? 'part' : 'todo')), date: dateOf(rec, 'quote_receive_date') || dateOf(rec, 'mat_quote_request_date') });
    S.push({ label: 'Approval', raw: quoteSkipped ? 'skip' : (has(rec, 'quote_approve_date') ? 'done' : 'todo'), date: dateOf(rec, 'quote_approve_date') });
    S.push({ label: 'PO', raw: has(rec, 'po_approve_date') ? 'done' : (has(rec, 'po_receive_date') || has(rec, 'po_no_1') ? 'part' : 'todo'), date: dateOf(rec, 'po_approve_date') || dateOf(rec, 'po_receive_date') });
    S.push({ label: 'Release', raw: has(rec, 'charllete_jay_release_date') ? 'done' : (has(rec, 'date_of_send') ? 'part' : 'todo'), date: dateOf(rec, 'charllete_jay_release_date') || dateOf(rec, 'date_of_send') });
    S.push({ label: 'Receiving', raw: has(rec, 'mat_receive_date_stockroom') ? 'done' : 'todo', date: dateOf(rec, 'mat_receive_date_stockroom') });
    S.push({ label: 'Invoice', raw: yes(dv(rec, 'invoice_received_finance')) || has(rec, 'invoice_no') ? 'done' : 'todo', date: null });
    S.push({ label: 'Closed', raw: closed ? 'done' : 'todo', date: dateOf(rec, 'so_close_date') });
    let currentSet = false;
    S.forEach((s) => {
      if (s.raw === 'done') s.state = 'done'; else if (s.raw === 'skip') s.state = 'skip';
      else if (s.raw === 'issue') { s.state = 'issue'; if (!currentSet) currentSet = true; }
      else if (!currentSet) { s.state = 'current'; currentSet = true; } else s.state = 'todo';
    });
    return S;
  }
  // One control for stage and tab: each item is a group of lifecycle stages; clicking shows (and edits) that group's fields.
  function renderStepper(rec) {
    const lc = lcOf(rec), groups = tabList();
    $('stepper').replaceChildren(...groups.map(([title, stages], i) => {
      const parts = stages.map((n) => lc.steps[n - 1]);
      let st = 'todo';
      if (!stages.length) st = 'extra';
      else if (parts.some((p) => p.state === 'issue')) st = 'issue';
      else if (parts.some((p) => p.state === 'current')) st = 'current';
      else if (parts.every((p) => p.state === 'done' || p.state === 'skip')) st = 'done';
      const dated = parts.map((p) => p.date).filter(Boolean).pop();
      const sub = !stages.length ? (lc.reasons.some((x) => x.text === 'Escalated') ? 'escalated' : 'log & owner') : st === 'current' || st === 'issue' ? 'now' : dated ? shortDate(parseDate(dated)) : st === 'done' ? 'done' : '';
      return el('li', { class: 'step st-' + st + (i === state.tab ? ' sel' : ''), role: 'tab', tabindex: 0, 'aria-selected': String(i === state.tab), title: stages.length ? 'Stage' + (stages.length > 1 ? 's ' + stages[0] + '–' + stages[stages.length - 1] : ' ' + stages[0]) + ': ' + stages.map((n) => lc.steps[n - 1].label).join(', ') : 'Follow-ups, owner and issues',
        onclick: () => selectTab(i), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(i); } } },
        el('span', { class: 'sc', text: st === 'done' ? '✓' : st === 'issue' ? '!' : !stages.length ? '⚑' : String(i + 1) }),
        el('b', {}, title, el('span', { class: 'tc', id: 'tc-' + i, hidden: true })), el('small', { text: sub }));
    }));
  }
  // ---------- lifecycle: the rules live in lifecycle.js (same file the server uses)
  const lcInput = (rec) => { const d = {}; state.fields.forEach((f) => { d[f.key] = norm(f.editable ? rec.values[f.key] : rec.display[f.key]).trim(); }); return d; };
  const lcOf = (rec) => SOLife.describe(lcInput(rec), today());
  async function quickUpdate(rec, changes, okMsg) {
    if (!(await leaveGuard())) return false;
    const r = await api('update', { id: rec.id, baseVersion: rec.version, changes });
    if (!r.ok) { toast(r.error || 'Could not save.', true); return false; }
    staleDash(); state.current = r.record; state.dirty = false; renderDetail(); updateDirty(); if (okMsg) toast(okMsg); return true;
  }
  async function addLog(rec, kind, text, ref) { return api('lgAdd', { id: rec.id, kind, text, ref: ref || '' }); }
  async function decideSO(rec, needed) {
    let note = '';
    if (!needed) {
      const ta = el('textarea', { rows: 3, placeholder: 'Why is no SO needed? (for example: covered by stock, customer cancelled)' });
      if (!(await confirmDialog('SO not required', el('div', {}, el('p', { text: 'The part will be marked Cancelled / Not Required and leave your action list.' }), ta), 'Mark not required'))) return;
      note = ta.value.trim(); if (!note) { toast('Enter the reason.', true); return; }
    }
    const ok = await quickUpdate(rec, needed ? { so_required: 'YES' } : { so_required: 'NO', so_required_note: note }, needed ? 'Marked: SO needed.' : 'Marked: not required.');
    if (ok) { await addLog(rec, 'DECISION', needed ? 'SO required: yes' : 'SO not required: ' + note); loadLog(); }
  }
  function renderNextCard(rec) {
    const lc = lcOf(rec), card = $('nextcard');
    const done = lc.status === 'Closed — Verified' || lc.status === 'Cancelled / Not Required', crit = lc.reasons.some((x) => x.level === 'crit');
    card.className = 'card nextcard ' + (done ? 'done' : crit ? 'bad' : lc.owner === 'me' ? 'mine' : 'wait');
    const item = (label, node) => (node === '' || node === null || node === undefined ? '' : el('div', { class: 'nitem' }, el('small', { text: label }), el('b', {}, node)));
    const who = lc.owner === 'me' ? 'Me' : lc.waitingOn;
    const acts = [];
    if (canEdit() && !done) {
      if (lc.status === 'Awaiting Decision') acts.push(el('button', { class: 'btn btn-primary', type: 'button', text: 'SO needed', onclick: () => decideSO(rec, true) }), el('button', { class: 'btn', type: 'button', text: 'Not required', onclick: () => decideSO(rec, false) }));
      if (isCheck(rec) && lc.stage >= 3) acts.push(el('button', { class: 'btn' + (lc.stage === 5 ? ' btn-primary' : ''), type: 'button', text: 'Request SO ›', onclick: () => requestSO(rec, lc.stage >= 5) }));
      acts.push(el('button', { class: 'btn btn-sm', type: 'button', text: 'Log a follow-up', onclick: () => { $('logbox').scrollIntoView({ block: 'center' }); const t = $('log-text'); if (t) t.focus(); } }));
    }
    const pill = (t, cls) => el('span', { class: 'badge ' + cls, text: t });
    const chip = (label, text) => (text ? el('span', { class: 'nchip' }, el('small', { text: label + ' ' }), el('b', { text: text })) : '');
    card.replaceChildren(
      el('div', { class: 'nextline' },
        el('small', { class: 'nextlabel', text: done ? 'STATUS' : 'NEXT' }), el('b', { class: 'nexttxt', text: lc.next || (done ? lc.status : 'Nothing to do right now') }),
        chip(lc.owner === 'me' ? 'Who' : 'Waiting on', who), chip('by', lc.actionDate ? shortDate(parseDate(lc.actionDate)) : ''), chip('follow-up', lc.followup ? shortDate(parseDate(lc.followup)) + (lc.followupDue ? ' (due)' : '') : ''),
        lc.matStatus ? pill('Material: ' + lc.matStatus, lc.matStatus === 'Late' ? 'sc-bad' : lc.matStatus === 'At Risk' ? 'sc-warn' : lc.matStatus === 'Unknown' ? 'sc-muted' : 'sc-ok') : '',
        ...lc.reasons.map((x) => el('span', { class: 'badge ' + (x.level === 'crit' ? 'sc-bad' : x.level === 'warn' ? 'sc-warn' : 'sc-muted'), text: x.text }))),
      acts.length ? el('div', { class: 'checkact' }, acts) : '');
  }
  // ---------- follow-up log
  async function loadLog() {
    const rec = state.current; if (!rec || !rec.id) { state.log = []; renderLog(); return; }
    const r = await api('lgList', { id: rec.id });
    if (!state.current || state.current.id !== rec.id) return;
    state.log = r.ok ? r.log : []; renderLog(r.ok ? '' : (r.error || 'Could not load the log.'));
  }
  function renderLog(err) {
    const rec = state.current; if (!rec) return;
    const kind = el('select', { id: 'log-kind' }, [['FOLLOW-UP', 'Follow-up'], ['NOTE', 'Note'], ['DECISION', 'Decision'], ['ESCALATION', 'Escalation'], ['EVIDENCE', 'Evidence']].map(([v, l]) => el('option', { value: v, text: l })));
    const text = el('textarea', { id: 'log-text', rows: 2, placeholder: 'What happened? Who did you contact, what did they say?' });
    const ref = el('input', { id: 'log-ref', type: 'text', placeholder: 'Link or reference to the email / document (optional)' });
    const nxt = el('input', { id: 'log-next', type: 'date', 'aria-label': 'Next follow-up date' });
    const msg = el('span', { class: 'error', id: 'log-msg' });
    const go = el('button', { class: 'btn btn-primary', type: 'button', text: 'Add to log' });
    go.onclick = async () => {
      msg.textContent = ''; if (!text.value.trim()) { msg.textContent = 'Write what happened.'; return; }
      go.disabled = true; const r = await addLog(rec, kind.value, text.value.trim(), ref.value.trim()); go.disabled = false;
      if (!r.ok) { msg.textContent = (r.fieldErrors && Object.values(r.fieldErrors)[0]) || r.error || 'Could not save.'; return; }
      const ch = {}; if (kind.value === 'FOLLOW-UP' || kind.value === 'ESCALATION') ch.last_followup_date = today(); if (kind.value === 'ESCALATION') ch.escalated = 'YES'; if (nxt.value) ch.next_followup_date = nxt.value;
      if (Object.keys(ch).length && !state.dirty) await quickUpdate(state.current, ch); else if (Object.keys(ch).length) toast('Logged. Save your edits, then set the follow-up dates on the Workflow tab.');
      toast('Added to the log.'); loadLog();
    };
    $('log-form').replaceChildren(...(canEdit() ? [el('div', { class: 'logrow' }, kind, el('label', { class: 'lognext' }, 'Next follow-up ', nxt)), text, ref, el('div', { class: 'logrow' }, go, msg)] : [el('p', { class: 'muted', text: 'You have read-only access.' })]));
    const log = state.log || [];
    $('log-list').replaceChildren(...(err ? [el('p', { class: 'error', text: err })] : log.length ? log.map((e) => el('div', { class: 'logitem k-' + e.kind.toLowerCase() },
      el('div', { class: 'loghead' }, el('span', { class: 'badge ' + (e.kind === 'ESCALATION' ? 'sc-bad' : e.kind === 'DECISION' ? 'sc-warn' : 'sc-muted'), text: e.kind.toLowerCase() }), el('small', { class: 'muted', text: new Date(e.at).toLocaleString() + ' · ' + niceName(e.by_user) })),
      el('div', { text: e.text }), e.ref ? (/^https?:\/\//i.test(e.ref) ? el('a', { href: e.ref, target: '_blank', rel: 'noopener noreferrer', text: e.ref }) : el('small', { class: 'muted', text: 'Ref: ' + e.ref })) : '')) : [el('p', { class: 'muted', text: 'Nothing logged yet.' })]));
  }
  function nextActions(rec) {
    const out = []; const closed = /CLOSE/.test(dv(rec, 'status'));
    const add = (kind, title, text) => out.push({ kind, title, text });
    if (rec.lookupChecks) {
      const miss = Object.entries(rec.lookupChecks).filter(([, c]) => c.state === 'issue').map(([k]) => state.byKey[k].label);
      if (miss.length) add('warn', 'Steel data missing for this part', miss.join(', ') + ' not found in STEEL USAGE — material needs cannot be calculated. Ask an admin to update STEEL USAGE.');
    }
    if (rec.priceCheck && rec.priceCheck.state === 'issue') add('warn', 'Part price does not match the stockroom sheet', rec.priceCheck.reason + '. Worksheet ' + money(rec.priceCheck.appPrice) + ' vs stockroom ' + (rec.priceCheck.stockPrices.length ? rec.priceCheck.stockPrices.map(money).join(', ') : 'not listed') + '.');
    if (!closed && dv(rec, 'req_mat_quote').toUpperCase() === 'YES' && has(rec, 'mat_quote_request_date') && !has(rec, 'quote_receive_date') && !/^(y|stock)/i.test(dv(rec, 'quote_received'))) {
      const d = dateOf(rec, 'mat_quote_request_date'); const age = d ? -daysUntil(d) : null;
      if (age !== null && age >= 3) add('warn', 'Quote requested ' + age + ' days ago — no reply yet', 'Follow up with the supplier' + (has(rec, 'followups_required') ? ' (follow-ups planned: ' + dv(rec, 'followups_required') + ')' : '') + '.');
      else add('info', 'Waiting for the material quote', 'Requested ' + (d ? shortDate(d) : 'recently') + '.');
    } else if (!closed && has(rec, 'quote_receive_date') && !has(rec, 'quote_approve_date')) add('info', 'Quote received — approval pending', 'Quote received ' + shortDate(dateOf(rec, 'quote_receive_date')) + '. Approve it to move to the PO.');
    if (!closed && has(rec, 'po_due_date') && !has(rec, 'mat_receive_date_stockroom')) {
      const n = daysUntil(dateOf(rec, 'po_due_date'));
      if (n !== null && n < 0) add('bad', 'Material is ' + Math.abs(n) + ' day' + (Math.abs(n) === 1 ? '' : 's') + ' past the PO due date', 'PO due ' + shortDate(dateOf(rec, 'po_due_date')) + ', not yet received in the stockroom.');
    }
    if (!closed && has(rec, 'mat_receive_date_stockroom') && !yes(dv(rec, 'invoice_received_finance')) && !has(rec, 'invoice_no')) add('info', 'Material received — invoice not yet with finance', 'Received ' + shortDate(dateOf(rec, 'mat_receive_date_stockroom')) + '.');
    const dpo = parseMoney(rec.display.diff_po_invoice);
    if (dpo !== null && Math.abs(dpo) >= 0.005 && has(rec, 'price_on_invoice')) add('warn', 'Invoice differs from the PO by ' + money(Math.abs(dpo)), has(rec, 'diff_reason') ? 'Reason noted: ' + dv(rec, 'diff_reason') : 'No reason recorded yet.');
    if (!out.length) out.push({ kind: 'ok', title: closed ? 'This SO is closed' : 'On track — nothing needs attention right now', text: '' });
    return out;
  }
  function renderCallouts(rec) {
    const icon = { bad: '⛔', warn: '⚠️', info: 'ℹ️', ok: '✅' };
    const list = nextActions(rec).filter((a) => a.kind === 'bad' || a.kind === 'warn'); $('callouts').hidden = !list.length;
    $('callouts').replaceChildren(...list.map((a) => el('div', { class: 'callout ' + a.kind },
      el('span', { class: 'ci', text: icon[a.kind] }), el('div', {}, el('b', { text: a.title }), a.text ? el('span', { text: a.text }) : ''))));
  }
  // Release readiness: the go / no-go list an engineer walks through before releasing an SO to the floor.
  const numOf = (rec, k) => { const t = dv(rec, k).replace(/[$,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; };
  function readiness(rec) {
    const items = [], add = (label, st, detail) => items.push({ label, st, detail });
    const ft = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ft';
    const matOk = has(rec, 'steel_type') && has(rec, 'router_bar_size') && has(rec, 'qty_per_bar');
    add('Material data', matOk ? 'ok' : 'bad', matOk ? [dv(rec, 'steel_type'), dv(rec, 'router_bar_size'), dv(rec, 'qty_per_bar') + ' per bar'].join(' · ') : 'Steel type, bar size or qty per bar not found in STEEL USAGE');
    const req = numOf(rec, 'req_ft'), avail = numOf(rec, 'avail_ft'), covered = has(rec, 'mat_receive_date_stockroom');
    if (covered) add('Material on hand', 'ok', 'Received in the stockroom ' + shortDate(dateOf(rec, 'mat_receive_date_stockroom')));
    else if (req === null) add('Material on hand', 'na', 'Required length unknown');
    else if (avail !== null && avail >= req) add('Material on hand', 'ok', ft(avail) + ' in stock for ' + ft(req) + ' needed');
    else add('Material on hand', has(rec, 'po_approve_date') ? 'warn' : 'bad', (avail === null ? 'No stock figure' : 'Short by ' + ft(req - avail)) + ' (need ' + ft(req) + ')' + (has(rec, 'po_approve_date') ? ': covered by the approved PO' : ': material has to be bought'));
    const quoteNeeded = dv(rec, 'req_mat_quote').toUpperCase() !== 'NO';
    if (!quoteNeeded) add('Material quote', 'na', 'Not required');
    else if (has(rec, 'quote_approve_date')) add('Material quote', 'ok', 'Approved ' + shortDate(dateOf(rec, 'quote_approve_date')));
    else if (has(rec, 'quote_receive_date') || /^(y|stock)/i.test(dv(rec, 'quote_received'))) add('Material quote', 'warn', 'Received, waiting for approval');
    else add('Material quote', 'bad', has(rec, 'mat_quote_request_date') ? 'Requested ' + shortDate(dateOf(rec, 'mat_quote_request_date')) + ', no reply' : 'Not requested yet');
    add('Purchase order', has(rec, 'po_approve_date') ? 'ok' : has(rec, 'po_receive_date') || has(rec, 'po_no_1') ? 'warn' : 'bad', has(rec, 'po_approve_date') ? 'Approved ' + shortDate(dateOf(rec, 'po_approve_date')) : has(rec, 'po_receive_date') || has(rec, 'po_no_1') ? 'PO received, not approved' : 'No PO yet');
    const rv = numOf(rec, 'router_vs_po');
    add('PO bar size matches router', rv === null ? 'na' : rv === 0 ? 'ok' : 'bad', rv === null ? 'No bar size entered from the PO' : rv === 0 ? dv(rec, 'po_mention_bar_size') : 'PO says ' + dv(rec, 'po_mention_bar_size') + ', router says ' + dv(rec, 'router_bar_size'));
    if (rec.priceCheck && rec.priceCheck.state === 'issue') add('Part price', 'warn', rec.priceCheck.reason);
    const prints = ['print_traveller', 'print_router', 'print_part_prints', 'print_req_po'].filter((k) => yes(dv(rec, k))).length;
    add('Traveller, router, prints, req./PO', prints === 4 ? 'ok' : prints ? 'warn' : 'bad', prints + ' of 4 printed');
    add('Verified', yes(dv(rec, 'verify_by_sakib')) ? 'ok' : 'bad', yes(dv(rec, 'verify_by_sakib')) ? 'Verified' : 'Not verified yet');
    const due = dateOf(rec, 'due_date'), pod = dateOf(rec, 'po_due_date');
    if (due && pod && !covered) { const gap = Math.round((pod - due) / 86400000); add('Material arrives before the SO is due', gap > 0 ? 'bad' : 'ok', gap > 0 ? 'PO due ' + gap + ' day' + (gap === 1 ? '' : 's') + ' after the SO due date' : 'PO due ' + Math.abs(gap) + ' day' + (Math.abs(gap) === 1 ? '' : 's') + ' before the SO is due'); }
    return items;
  }
  function readinessCard(rec) {
    const items = readiness(rec), bad = items.filter((i) => i.st === 'bad').length, warn = items.filter((i) => i.st === 'warn').length;
    const icon = { ok: '✓', warn: '!', bad: '✕', na: '–' };
    const closed = /CLOSE/.test(dv(rec, 'status')), released = has(rec, 'charllete_jay_release_date');
    const head = closed ? 'Closed' : released ? 'Released' : bad ? 'Not ready to release: ' + bad + ' open' : warn ? 'Almost ready: ' + warn + ' to confirm' : 'Ready to release';
    return el('div', { class: 'fcard ready ' + (closed || released ? 'done' : bad ? 'bad' : warn ? 'warn' : 'ok') }, el('h3', { text: 'Release readiness' }), el('div', { class: 'readyhead', text: head }),
      el('ul', { class: 'readylist' }, items.map((i) => el('li', { class: 'r-' + i.st }, el('span', { class: 'ri', text: icon[i.st] }), el('div', {}, el('b', { text: i.label }), el('small', { text: i.detail }))))));
  }
  // Purchasing check for a part that is not an SO yet: what is needed, is it in stock, is the quote in, then request the SO.
  function checkCard(rec) {
    const items = [], add = (label, st, detail) => items.push({ label, st, detail });
    const n0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
    const matOk = has(rec, 'steel_type') && has(rec, 'router_bar_size') && has(rec, 'qty_per_bar');
    add('Part & material data', matOk ? 'ok' : 'bad', matOk ? [dv(rec, 'steel_type'), dv(rec, 'router_bar_size'), dv(rec, 'qty_per_bar') + ' per bar'].join(' · ') : 'Not found in STEEL USAGE for this part number');
    const qty = norm(rec.values.so_qty).trim(), bars = numOf(rec, 'req_bar'), ftReq = numOf(rec, 'req_ft'), lbs = numOf(rec, 'req_lbs'), avail = numOf(rec, 'avail_ft');
    add('Possible quantity', qty ? 'ok' : 'bad', qty ? qty + ' pcs' + (bars !== null ? ' needs ' + Math.ceil(bars) + ' bar' + (Math.ceil(bars) === 1 ? '' : 's') + (ftReq !== null ? ' · ' + n0(ftReq) + ' ft' : '') + (lbs ? ' · ' + n0(lbs) + ' lbs' : '') : '') : 'Enter the possible SO quantity');
    const inStock = ftReq !== null && ftReq > 0 && avail !== null && avail >= ftReq;
    if (ftReq === null) add('Stock on hand', 'na', 'Required length unknown');
    else add('Stock on hand', inStock ? 'ok' : avail === null ? 'warn' : 'bad', inStock ? n0(avail) + ' ft in stock for ' + n0(ftReq) + ' ft needed: no purchase needed' : (avail === null ? 'No stock figure' : 'Short by ' + n0(ftReq - avail) + ' ft') + ' (need ' + n0(ftReq) + ' ft): material has to be bought');
    const quoteNo = dv(rec, 'req_mat_quote').toUpperCase() === 'NO', got = has(rec, 'quote_receive_date') || /^(y|stock)/i.test(dv(rec, 'quote_received'));
    if (inStock || quoteNo) add('Material quote', 'na', inStock ? 'Not needed, stock covers it' : 'Marked as not required');
    else if (got) add('Material quote', 'ok', 'Received' + (has(rec, 'quote_receive_date') ? ' ' + shortDate(dateOf(rec, 'quote_receive_date')) : ''));
    else if (has(rec, 'mat_quote_request_date')) { const d = dateOf(rec, 'mat_quote_request_date'), age = d ? -daysUntil(d) : null; add('Material quote', 'warn', 'Requested ' + (d ? shortDate(d) : '') + (age ? ' (' + age + ' day' + (age === 1 ? '' : 's') + ' ago)' : '') + ', waiting for the reply'); }
    else add('Material quote', 'bad', 'Not requested yet: use Send Email on the Material & quote tab');
    if (got && !inStock && has(rec, 'quote_price_piece') && dv(rec, 'quote_price_piece') !== '$ 0.00') {
      const d = parseMoney(rec.display.diff), tr = has(rec, 'traveller_mat_price_piece');
      add('Quote price per piece', !tr || d === null ? 'warn' : Math.abs(d) < 0.005 ? 'ok' : 'warn', dv(rec, 'quote_price_piece') + (tr ? ' vs traveller ' + dv(rec, 'traveller_mat_price_piece') + (d !== null ? ' (diff ' + dv(rec, 'diff') + ')' : '') : ' · traveller price not entered'));
    }
    const ready = matOk && !!qty && (inStock || quoteNo || got), open = items.filter((i) => i.st === 'bad' || i.st === 'warn').length, icon = { ok: '✓', warn: '!', bad: '✕', na: '–' };
    const ask = el('button', { class: 'btn ' + (ready ? 'btn-primary' : ''), type: 'button', text: 'Request SO ›', onclick: () => requestSO(rec, ready) });
    return el('div', { class: 'fcard ready ' + (ready ? 'ok' : 'warn') }, el('h3', { text: 'Part check' }), el('div', { class: 'readyhead', text: ready ? 'Ready to request the SO' : 'Not ready: ' + open + ' to resolve' }),
      el('ul', { class: 'readylist' }, items.map((i) => el('li', { class: 'r-' + i.st }, el('span', { class: 'ri', text: icon[i.st] }), el('div', {}, el('b', { text: i.label }), el('small', { text: i.detail }))))),
      canEdit() ? el('p', { class: 'muted small', text: 'This part is still a check (1. ANALYSIS). Request SO opens it as a real SO (3.OPEN) once you have the SO# and due date.' }) : '',
      canEdit() ? el('div', { class: 'checkact' }, ask, el('button', { class: 'btn', type: 'button', text: 'Quote details', onclick: () => selectTab(1) })) : '');
  }
  async function requestSO(rec, ready) {
    if (!(await leaveGuard())) return;
    if (!ready && !(await confirmDialog('Request the SO anyway?', el('p', { text: 'The part check is not complete yet (material data, quantity or quote). You can still request the SO now.' }), 'Request SO'))) return;
    const opt = (k) => [['', '— choose —']].concat(state.byKey[k].options.map((o) => [o, o]));
    const people = [['', '— choose a person —']].concat((state.intake.people || []).map((p) => [p, p])), me = (state.intake.people || []).find((p) => p.toLowerCase() === niceName(state.email).toLowerCase()) || '';
    const cur = (k) => norm(rec.values[k]).trim(), iso = (k) => (isIso(cur(k)) ? cur(k) : ''), pick = (k) => (people.find(([p]) => p.toLowerCase() === cur(k).toLowerCase()) || [''])[0];
    const f = { so_no: scInput('text', cur('so_no')), so_req_date: dateIn(iso('so_req_date') || today()), due_date: dateIn(iso('due_date')), so_type: scSelect(opt('so_type'), cur('so_type')), kanban_or_po: scSelect(opt('kanban_or_po'), cur('kanban_or_po')), champion: scSelect(people, pick('champion') || me), req_by: scSelect(people, pick('req_by') || me) };
    const body = el('div', { class: 'scform' }, el('p', { class: 'muted', text: 'Part ' + norm(rec.values.part_no) + ' · ' + norm(rec.values.customer) + ' · ' + norm(rec.values.so_qty) + ' pcs. Check the details below (filled from this record), then click Request SO: the status changes from 1. ANALYSIS to 3.OPEN and it becomes a real SO.' }),
      scField('SO#', f.so_no, 'so_no'), scField('SO request date', f.so_req_date, 'so_req_date'), scField('Due date', f.due_date, 'due_date', true), scField('SO type', f.so_type, 'so_type', true),
      scField('Kanban or PO?', f.kanban_or_po, 'kanban_or_po', true), scField('Champion', f.champion, 'champion', true), scField('Req. by', f.req_by, 'req_by', true));
    const need = ['due_date', 'so_type', 'kanban_or_po', 'champion', 'req_by'];
    const collect = () => { const ch = { status: '3.OPEN', so_required: 'YES' }; Object.entries(f).forEach(([k, i]) => { if (i.value.trim() !== '') ch[k] = i.value.trim(); }); if (ch.so_no && !norm(rec.values.so_no_received_date)) ch.so_no_received_date = today(); return { id: rec.id, baseVersion: rec.version, changes: ch }; };
    for (;;) {
      if (!(await confirmDialog('Request the SO', body, 'Request SO'))) return;
      const c = collect(), miss = {}; need.forEach((k) => { if (!c.changes[k]) miss[k] = state.byKey[k].label + ' is required.'; });
      if (Object.keys(miss).length) { scShowErrors(body, miss); toast('Please fill in the required fields.', true); continue; }
      const r = await api('update', c);
      if (r.ok) { staleDash(); state.current = r.record; state.dirty = false; renderDetail(); updateDirty(); banner('detail-banner', 'ok', 'SO requested: status is now 3.OPEN. Continue with approvals, PO and release.'); toast('SO requested.'); return; }
      if (r.fieldErrors) { scShowErrors(body, r.fieldErrors); toast(r.error || 'Please fix the highlighted fields.', true); continue; }
      toast(r.error || 'Could not request the SO.', true); return;
    }
  }
  function coverageNode(rec) {
    const req = numOf(rec, 'req_ft'), avail = numOf(rec, 'avail_ft');
    if (req === null || req <= 0 || avail === null) return '';
    const pct = Math.max(0, Math.min(100, Math.round(100 * avail / req)));
    return el('div', { class: 'cover', title: 'Available stock against required length' }, el('div', { class: 'coverbar ' + (pct >= 100 ? 'ok' : pct >= 50 ? 'warn' : 'bad') }, el('i', { style: 'width:' + pct + '%' })),
      el('small', { text: pct >= 100 ? 'Stock covers this SO (' + pct + '%)' : 'Stock covers ' + pct + '% · short by ' + (req - avail).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ft' }));
  }
  function afterFacts(rec) {
    const c = $('facts').querySelector('.fcard.ready'), box = $('summarybox');
    $('summary-sub').textContent = c ? '· ' + c.querySelector('.readyhead').textContent : '';
    if (state.sumFor !== rec.id) { state.sumFor = rec.id; box.open = !!c && /(bad|warn)/.test(c.className); }
  }
  function renderFacts(rec) {
    const row = (label, value, tone, badge) => el('div', { class: 'frow' }, el('span', { text: label }), el('span', { class: tone ? 'tone-' + tone : '' }, value === '' || value === '-' ? '—' : value, badge || ''));
    const diffTone = (k) => { const n = parseMoney(rec.display[k]); return n === null ? 'none' : Math.abs(n) < 0.005 ? 'ok' : Math.abs(n) < 5 ? 'warn' : 'bad'; };
    const dateRow = (label, k, watch) => { const d = dateOf(rec, k); const n = daysUntil(d); return row(label, d ? shortDate(d) + (watch && n !== null ? (n < 0 ? ' · ' + Math.abs(n) + ' d late' : n === 0 ? ' · today' : ' · in ' + n + ' d') : '') : '', watch && n !== null && n < 0 ? 'bad' : d ? '' : 'none'); };
    $('facts').replaceChildren(
      isCheck(rec) ? checkCard(rec) : readinessCard(rec),
      el('div', { class: 'fcard' }, el('h3', { text: 'Material needed' }),
        row('Steel type', dv(rec, 'steel_type'), null, lookupBadge(rec, 'steel_type')), row('Bar type', dv(rec, 'bar_type')),
        row('Router bar size', dv(rec, 'router_bar_size'), null, lookupBadge(rec, 'router_bar_size')), row('Qty / bar', dv(rec, 'qty_per_bar'), null, lookupBadge(rec, 'qty_per_bar')),
        row('Required (ft)', dv(rec, 'req_ft')), row('Required (lbs)', dv(rec, 'req_lbs')), row('Required bars', dv(rec, 'req_bar')), row('Available (ft)', dv(rec, 'avail_ft')), coverageNode(rec)),
      el('div', { class: 'fcard' }, el('h3', { text: 'Pricing' }),
        row('Part price', dv(rec, 'part_price'), null, priceBadge(rec)), row('Traveller mat. price / pc', dv(rec, 'traveller_mat_price_piece')),
        row('Quote price / pc', dv(rec, 'quote_price_piece')), row('Diff (traveller vs quote)', dv(rec, 'diff'), diffTone('diff')),
        row('Total price in quote', dv(rec, 'total_price_quote')), row('Price on PO', dv(rec, 'price_on_po')), row('Quote vs PO', dv(rec, 'quote_vs_po_price'), diffTone('quote_vs_po_price')),
        row('Price on invoice', dv(rec, 'price_on_invoice')), row('PO vs invoice', dv(rec, 'diff_po_invoice'), diffTone('diff_po_invoice'))),
      el('div', { class: 'fcard' }, el('h3', { text: 'Key dates' }),
        dateRow('Due', 'due_date', !/CLOSE/.test(dv(rec, 'status'))), dateRow('SO requested', 'so_req_date'), dateRow('Quote requested', 'mat_quote_request_date'), dateRow('Quote received', 'quote_receive_date'),
        dateRow('PO received', 'po_receive_date'), dateRow('PO due', 'po_due_date', !/CLOSE/.test(dv(rec, 'status')) && !has(rec, 'mat_receive_date_stockroom')), dateRow('Material received', 'mat_receive_date_stockroom'), dateRow('Closed', 'so_close_date')));
  }

  // ---------- one SO: page, tabs, editing
  function openRecord(rec, kind, msg) {
    state.current = rec; state.dirty = false; state.scans = []; state.tab = tabForStage(lcOf(rec).stage);
    renderDetail(); show('view-detail'); banner('detail-banner', kind || '', msg || ''); updateDirty();
    renderScans(); loadScans(); state.log = []; loadLog();
  }
  function canEdit() { return state.role !== 'viewer' && state.current && state.current.id; }
  function renderDetail() {
    const rec = state.current;
    $('detail-title').textContent = isCheck(rec) && !norm(rec.values.so_no) ? 'Part check' : 'SO# ' + (norm(rec.values.so_no) || '(none)');
    $('detail-sub').replaceChildren('Part ' + (norm(rec.values.part_no) || '(none)'), priceBadge(rec), ' · ' + (norm(rec.values.customer) || 'no customer') + (norm(rec.values.so_qty) ? ' · ' + norm(rec.values.so_qty) + ' pcs' : ''));
    const closed = /CLOSE/.test(dv(rec, 'status'));
    $('detail-meta').replaceChildren(statusPill(dv(rec, 'status')), dueNode(dateOf(rec, 'due_date'), closed), barNode(norm(rec.display.so_release_status_bar)), barNode(norm(rec.display.mat_status_bar)), el('span', { class: 'badge sc-muted', title: 'Initial workflow: opening, material, release and arrival', text: 'Initial: ' + lcOf(rec).initial }), el('span', { class: 'badge ' + (lcOf(rec).final === 'Overdue' ? 'sc-bad' : lcOf(rec).final === 'Closed — Verified' ? 'sc-ok' : 'sc-muted'), title: 'Final lifecycle: until closure is verified', text: 'Final: ' + lcOf(rec).final }));
    $('detail-meta').children[2].title = 'SO release'; $('detail-meta').children[3].title = 'Material';
    $('btn-delete').hidden = !canEdit() || closed;
    renderStepper(rec); renderNextCard(rec); renderCallouts(rec); renderFacts(rec); afterFacts(rec);
    const form = $('detail-form'); form.replaceChildren();
    tabList().forEach(([title, , keys], i) => {
      form.append(el('div', { class: 'tabpanel', id: 'panel-' + i, role: 'tabpanel', hidden: i !== state.tab },
        el('fieldset', {}, el('legend', { text: title }), el('div', { class: 'grid' }, keys.map((k) => fieldNode(state.byKey[k], rec))))));
    });
    $('scan-upload').hidden = state.role === 'viewer';
    if (!canEdit() && !$('detail-banner').textContent) banner('detail-banner', 'warn', state.role === 'viewer' ? 'You have read-only access.' : 'This SO has no RECORD ID yet, so it cannot be edited.');
  }
  function selectTab(i) {
    state.tab = i; tabList().forEach((_, j) => { $('panel-' + j).hidden = j !== i; });
    [...$('stepper').children].forEach((t, j) => { t.classList.toggle('sel', j === i); t.setAttribute('aria-selected', String(j === i)); });
  }
  function fieldNode(f, rec) {
    const locked = rec.formulaLocked.includes(f.key);
    const editable = f.editable && !locked && canEdit();
    const val = rec.values[f.key];
    const id = 'fld-' + f.key;
    let input;
    if (f.editable && PEOPLE_KEYS.includes(f.key)) {
      const people = (state.intake && state.intake.people) || [], cur = norm(val).trim(), opts = ['', ...people]; if (cur && !people.some((p) => p.toLowerCase() === cur.toLowerCase())) opts.push(cur);
      input = el('select', { id }, opts.map((p) => el('option', { value: p, text: p === '' ? '— choose a person —' : people.includes(p) || p === '' ? p : p + ' (existing)' })));
      input.value = (people.find((p) => p.toLowerCase() === cur.toLowerCase())) || cur;
    } else if (f.type === 'enum') {
      const opts = ['', ...f.options]; if (norm(val) && !f.options.includes(norm(val))) opts.push(norm(val));
      input = el('select', { id }, opts.map((o) => el('option', { value: o, text: o === '' ? '—' : (f.options.includes(o) || o === '' ? o : o + ' (existing)') })));
      input.value = norm(val);
    } else if (f.type === 'date') {
      const legacy = norm(val) && !isIso(norm(val));
      input = el('input', { id, type: 'date', value: isIso(norm(val)) ? norm(val) : '' });
      if (legacy) input.dataset.legacy = norm(val);
    } else if (f.type === 'longtext') { input = el('textarea', { id }); input.value = norm(val); }
    else if (f.editable) { input = el('input', { id, type: 'text', value: norm(val) }); }
    else { input = el('input', { id, type: 'text', value: norm(rec.display[f.key]) }); }
    input.dataset.key = f.key; input.dataset.orig = f.editable ? norm(val) : '';
    if (f.editable && PEOPLE_KEYS.includes(f.key)) input.dataset.orig = input.value;
    if (!editable) input.disabled = true;
    const wrap = el('div', { class: 'field' + (f.required ? ' mandatory' : '') + (editable ? '' : ' ro') + (f.type === 'longtext' ? ' wide' : '') },
      el('label', { for: id }, f.label, f.required ? el('span', { class: 'req', title: 'Required', text: ' *' }) : '', el('span', { class: 'col', text: '(' + f.col + ')' }),
        !f.editable ? el('span', { class: 'tag', text: 'calculated' }) : locked ? el('span', { class: 'tag', text: 'formula' }) : ''),
      input);
    if (input.dataset.legacy) wrap.append(el('div', { class: 'hint', text: 'Existing value "' + input.dataset.legacy + '" is kept unless you pick a date.' }));
    if (f.note) wrap.append(el('div', { class: 'hint', text: f.note }));
    if (f.key === 'part_price' && rec.priceCheck && rec.priceCheck.state !== 'none') {
      const c = rec.priceCheck;
      wrap.append(el('div', { class: 'pricehint ' + (c.state === 'ok' ? 'ok' : 'bad'), text: c.state === 'ok' ? '✓ Matches stockroom sheet (' + money(c.stockPrices[0]) + ')' : '! ' + c.reason + ' — stockroom: ' + (c.stockPrices.length ? c.stockPrices.map(money).join(', ') : 'not listed') }));
    }
    if (LOOKUP_KEYS.includes(f.key) && rec.lookupChecks && rec.lookupChecks[f.key]) {
      const c = rec.lookupChecks[f.key];
      wrap.append(el('div', { class: 'pricehint ' + (c.state === 'ok' ? 'ok' : 'bad'), text: c.state === 'ok' ? '✓ Found in STEEL USAGE' : '! ' + c.reason }));
    }
    if (BAR_KEYS.includes(f.key)) { input.hidden = true; wrap.append(barNode(norm(rec.display[f.key]))); }
    if (f.key === 'email_template') { input.hidden = true; wrap.append(el('button', { class: 'btn btn-sm', type: 'button', text: '✉ Send Email', title: 'Opens an email asking for a material quote', onclick: () => { window.location.href = quoteMailto(); } })); }
    if (editable) input.addEventListener('input', onEdit);
    return wrap;
  }
  function collectChanges() {
    const ch = {};
    $('detail-form').querySelectorAll('[data-key]').forEach((i) => {
      if (i.disabled) return;
      const v = i.value;
      if (i.dataset.legacy && v === '') return;
      if (v !== i.dataset.orig) ch[i.dataset.key] = v;
    });
    return ch;
  }
  // REQ. LBS follows BAR TYPE and MATERIAL CODE while typing (same rule as the backend; saved again on Save)
  function liveLbs() {
    const out = $('fld-req_lbs'), rec = state.current; if (!out || !rec) return;
    const val = (k) => { const i = $('fld-' + k); return i ? i.value : norm(rec.values[k]); };
    const bt = val('bar_type'), ft = parseFloat(norm(rec.display.req_ft).replace(/,/g, '')), code = val('material_code').trim(), sp = code.indexOf(' ');
    const dia = sp > 0 ? parseFloat(code.slice(0, sp)) : NaN, inches = isNaN(ft) ? NaN : ft * 12;
    let r;
    if (bt === 'RD' || bt === 'RD-AL') r = isNaN(dia) || isNaN(inches) ? '#VALUE!' : String(Math.round(Math.PI * Math.pow(dia / 2, 2) * inches * (bt === 'RD' ? 0.283 : 0.098)));
    else if (bt === 'SQ') r = isNaN(dia) || isNaN(inches) ? '#VALUE!' : String(Math.round(dia * dia * inches * 0.283));
    else if (bt === 'REC.' || bt === 'FLAT' || bt === 'TUBING') return;
    else r = '0';
    out.value = r;
  }
  // QUOTE PRICE / PIECE and DIFF follow the quote total and traveller price while typing (same rules as the backend)
  function liveQuote() {
    const rec = state.current, qp = $('fld-quote_price_piece'), df = $('fld-diff'); if (!rec || !qp || !df) return;
    const val = (k) => { const i = $('fld-' + k); return i ? i.value : norm(rec.values[k]); };
    const n = (v) => { const t = String(v).replace(/[$,\s]/g, ''); return t === '' ? 0 : /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN; };
    const m = (x) => (x < 0 ? '-$ ' : '$ ') + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const total = n(val('total_price_quote')), q = n(val('so_qty')), tr = n(val('traveller_mat_price_piece'));
    const ok = !isNaN(total) && !isNaN(q) && q !== 0, per = ok ? total / q : null;
    qp.value = ok ? m(per) : '-'; df.value = !isNaN(tr) && per !== null ? m(tr - per) : '';
  }
  // GAP = days from SO REQ. DATE to APPR. DATE (blank until both are filled)
  function liveGap() {
    const gp = $('fld-gap'); if (!gp || !state.current) return;
    const val = (k) => { const i = $('fld-' + k); return i ? i.value : norm(state.current.values[k]); };
    const a = parseDate(val('appr_date')), b = parseDate(val('so_req_date'));
    gp.value = a && b ? String(Math.round((a - b) / 86400000)) : '';
  }
  // PO / invoice differences follow the typed prices (same rules as the backend)
  function livePrices() {
    const rec = state.current; if (!rec) return;
    const val = (k) => { const i = $('fld-' + k); return i ? i.value : norm(rec.values[k]); };
    const n = (v) => { const t = String(v).replace(/[$,\s]/g, ''); return t === '' ? 0 : /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN; };
    const m = (x) => (x < 0 ? '-$ ' : '$ ') + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const put = (k, v) => { const i = $('fld-' + k); if (i) i.value = v; };
    const po = n(val('price_on_po')), quote = n(val('total_price_quote')), inv = n(val('price_on_invoice')), upd = n(val('updated_po_price'));
    put('quote_vs_po_price', isNaN(po) || isNaN(quote) ? '-' : m(po - quote));
    put('diff_po_invoice', isNaN(inv) || isNaN(po) ? '#VALUE!' : m(inv - po));
    put('diff_updated_po_invoice', isNaN(upd) || isNaN(inv) ? '#VALUE!' : m(upd - inv));
    const rt = norm(rec.display.router_bar_size), ap = rt.indexOf("'"), ft = ap > 0 ? parseFloat(rt.slice(0, ap)) : NaN, bar = n(val('po_mention_bar_size'));
    put('router_vs_po', isNaN(ft) || isNaN(bar) ? '-' : String(Math.round((bar - ft) * 10000) / 10000));
  }
  // mailto link asking for a material quote, filled from the form as it is now
  function quoteMailto() {
    const rec = state.current; if (!rec) return 'mailto:';
    const v = (k) => { const i = $('fld-' + k); return (i ? i.value : norm(rec.values[k])).trim(); };
    const d = (k) => norm(rec.display[k]).trim();
    const code = v('material_code') || d('steel_type'), qty = v('qty_requested');
    const lines = ['Hello,', '', 'Please send a quote for the following material:', '',
      'Material: ' + code + (d('steel_type') && d('steel_type') !== code ? ' (' + d('steel_type') + ')' : ''),
      'Bar type: ' + (v('bar_type') || '—') + (d('router_bar_size') && d('router_bar_size') !== '-' ? ', ' + d('router_bar_size') : ''),
      'Quantity: ' + (qty || (d('req_bar') && d('req_bar') !== '-' ? Math.ceil(parseFloat(d('req_bar'))) + ' bars (' + d('req_ft') + ' ft)' : '—')),
      '', 'For SO ' + v('so_no') + ', part ' + v('part_no') + (v('due_date') ? ', needed by ' + v('due_date') : '') + '.', '', 'Please reply with the price and lead time.', '', 'Thank you.'];
    return 'mailto:?subject=' + encodeURIComponent('Material quote request - SO ' + v('so_no') + ' - ' + code) + '&body=' + encodeURIComponent(lines.join('\n'));
  }
  function onEdit(e) {
    if (e.target.dataset.key === 'bar_type' || e.target.dataset.key === 'material_code') liveLbs();
    if (['total_price_quote', 'traveller_mat_price_piece', 'so_qty'].includes(e.target.dataset.key)) liveQuote();
    if (['appr_date', 'so_req_date'].includes(e.target.dataset.key)) liveGap();
    if (['price_on_po', 'total_price_quote', 'price_on_invoice', 'updated_po_price', 'po_mention_bar_size'].includes(e.target.dataset.key)) livePrices();
    const wrap = e.target.closest('.field');
    wrap.classList.toggle('changed', e.target.value !== e.target.dataset.orig && !(e.target.dataset.legacy && e.target.value === ''));
    wrap.classList.remove('invalid'); wrap.querySelector('.ferr')?.remove();
    updateDirty();
  }
  function updateSaveBar() { $('savebar').hidden = !(state.dirty || state.saving) || $('view-detail').hidden; }
  function updateDirty() {
    const n = Object.keys(collectChanges()).length; state.dirty = n > 0;
    $('btn-save').disabled = !state.dirty || state.saving; $('btn-discard').disabled = !state.dirty || state.saving;
    $('btn-save').textContent = state.saving ? 'Saving…' : 'Save changes' + (n ? ' (' + n + ')' : '');
    $('dirty-flag').textContent = n ? n + ' unsaved change' + (n === 1 ? '' : 's') : 'Saving…';
    tabList().forEach((_, i) => { const c = $('panel-' + i) ? $('panel-' + i).querySelectorAll('.field.changed').length : 0; const b = $('tc-' + i); if (b) { b.hidden = !c; b.textContent = String(c); } });
    $('savebar').hidden = !(state.dirty || state.saving);
  }
  async function save() {
    if (state.saving) return;
    const changes = collectChanges(); if (!Object.keys(changes).length) return;
    const rec = state.current;
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Field' }), el('th', { text: 'Was' }), el('th', { text: 'Now' }))),
      el('tbody', {}, Object.entries(changes).map(([k, v]) => el('tr', {}, el('td', { text: state.byKey[k].label }), el('td', { text: norm(rec.values[k]) || '—' }), el('td', { text: v || '(cleared)' })))));
    if (!(await confirmDialog('Save changes to the sheet?', table, 'Save'))) return;
    state.saving = true; updateDirty(); banner('detail-banner', '', '');
    const r = await api('update', { id: rec.id, baseVersion: rec.version, changes });
    state.saving = false;
    if (r.ok) {
      staleDash(); state.current = r.record; const t = state.tab; renderDetail(); selectTab(t); updateDirty(); banner('detail-banner', 'ok', 'Saved ' + r.changed.length + ' field(s) to the sheet.'); toast('Saved to the sheet.'); return;
    }
    updateDirty();
    if (r.code === 'INVALID') { banner('detail-banner', 'err', 'Some values are invalid. Nothing was saved.'); showFieldErrors('fld-', r.fieldErrors); }
    else if (r.code === 'CONFLICT') conflict(r);
    else if (r.code === 'UNAUTHENTICATED') reauth(r.error);
    else if (r.code === 'BUSY') banner('detail-banner', 'warn', r.error + ' Your edits are still here.');
    else banner('detail-banner', 'err', r.error + ' Your edits have NOT been saved and are still in the form.');
  }
  function conflict(r) {
    const cur = r.current; const mine = collectChanges();
    const theirs = state.fields.filter((f) => f.editable && norm(cur.values[f.key]) !== norm(state.current.values[f.key])).map((f) => f.label);
    const node = el('div', {}, 'Someone else changed this record after you opened it (' + (theirs.join(', ') || 'unknown fields') + '). Your changes were not saved. ',
      el('button', { class: 'btn', type: 'button', text: 'Load latest and re-apply my edits', onclick: () => {
        state.current = Object.assign({}, state.current, cur); const t = state.tab; renderDetail(); selectTab(t);
        Object.entries(mine).forEach(([k, v]) => { const inp = $('fld-' + k); if (inp && !inp.disabled) { inp.value = v; inp.dispatchEvent(new Event('input')); } });
        banner('detail-banner', 'warn', 'Latest version loaded. Review your edits, then save again.');
      } }));
    banner('detail-banner', 'err', '', node);
  }
  function reauth(msg) {
    const holder = el('span', {}); banner('detail-banner', 'err', '', el('div', {}, (msg || 'Session expired.') + ' Your edits are still here. Sign in again, then save: ', holder));
    renderSignIn(holder, (t) => { state.token = t; store('tok', t); banner('detail-banner', 'ok', 'Signed in again. Click Save to continue.'); });
  }
  async function discard() {
    if (await confirmDialog('Discard changes?', el('p', { text: 'Reset this record to the last saved values?' }), 'Discard', true)) { const t = state.tab; renderDetail(); selectTab(t); updateDirty(); banner('detail-banner', '', ''); }
  }

  // ---------- scans
  function renderScans() {
    const box = $('scan-list'); const list = state.scans;
    if (!list.length) { box.className = 'muted'; box.textContent = 'No scan uploaded yet.'; return; }
    box.className = '';
    box.replaceChildren(...list.map((s) => el('div', { class: 'scanitem' }, el('span', { class: 'scanname', text: s.name }),
      el('span', { class: 'muted small', text: ' · ' + norm(s.by) + (s.at ? ' · ' + fmtWhen(s.at) : '') }),
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Download', onclick: () => downloadScan(s) }))));
  }
  async function loadScans() {
    const rec = state.current; if (!rec || !rec.id) return;
    const r = await api('listScans', { id: rec.id });
    if (r.ok && state.current && state.current.id === rec.id) { state.scans = r.scans; renderScans(); }
  }
  async function downloadScan(s) {
    const r = await api('downloadScan', { id: state.current.id, fileId: s.fileId });
    if (!r.ok) { toast(r.error || 'Could not download the scan.', true); return; }
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    const a = el('a', { href: url, download: r.name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const SCAN_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const scanMimeOf = (file) => SCAN_MIME[(file.name.split('.').pop() || '').toLowerCase()] || (Object.values(SCAN_MIME).includes(file.type) ? file.type : '');
  function readBase64(file) {
    return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = () => reject(new Error('Could not read the file.')); fr.readAsDataURL(file); });
  }
  $('scan-file').addEventListener('change', () => {
    const f = $('scan-file').files[0]; const msg = $('scan-msg'); msg.textContent = ''; $('scan-go').disabled = true;
    if (!f) return;
    if (!scanMimeOf(f)) { msg.textContent = 'Only PDF, JPG or PNG files.'; return; }
    if (f.size > 7 * 1024 * 1024) { msg.textContent = 'File is larger than 7 MB.'; return; }
    $('scan-go').disabled = false;
  });
  $('scan-go').onclick = async () => {
    const f = $('scan-file').files[0]; if (!f || !state.current) return;
    const msg = $('scan-msg'); $('scan-go').disabled = true; msg.textContent = 'Uploading…';
    try {
      const data = await readBase64(f);
      const r = await api('uploadScan', { id: state.current.id, fileName: f.name, mime: scanMimeOf(f), data });
      if (!r.ok) { msg.textContent = r.error || 'Upload failed.'; $('scan-go').disabled = false; return; }
      state.scans = r.scans; renderScans(); $('scan-file').value = ''; msg.textContent = 'Uploaded.'; toast('Scan uploaded.');
    } catch (e) { msg.textContent = e.message; $('scan-go').disabled = false; }
  };

  // ---------- print
  function printSheet() {
    if (state.dirty) { toast('Save your changes first so the printout is up to date.', true); return; }
    const rec = state.current; const order = state.fields.map((f) => f.key); const box = $('print-sheet');
    const sections = tabList().map(([title, , keys]) => {
      const rows = keys.map((k) => state.byKey[k])
        .filter((f) => norm(rec.display[f.key]).trim() !== '' && norm(rec.display[f.key]).trim() !== '-')
        .map((f) => el('tr', {}, el('th', { text: f.label }), el('td', { text: norm(rec.display[f.key]) })));
      return rows.length ? el('div', { class: 'ps-sec' }, el('h3', { text: title }), el('table', {}, el('tbody', {}, rows))) : null;
    }).filter(Boolean);
    const checks = [];
    if (rec.priceCheck && rec.priceCheck.state !== 'none') checks.push('Stockroom price: ' + (rec.priceCheck.state === 'ok' ? 'matches' : 'ISSUE — ' + rec.priceCheck.reason));
    if (rec.lookupChecks) checks.push('Steel usage data: ' + (Object.values(rec.lookupChecks).every((c) => c.state === 'ok') ? 'complete' : 'MISSING — ' + Object.entries(rec.lookupChecks).filter(([, c]) => c.state !== 'ok').map(([k]) => state.byKey[k].label).join(', ')));
    box.replaceChildren(
      el('h1', { text: 'SHOP ORDER TRACKING DETAILS' }),
      el('div', { class: 'ps-head' }, el('div', {}, el('strong', { text: 'SO# ' + norm(rec.values.so_no) }), ' · Part ' + norm(rec.values.part_no) + ' · ' + norm(rec.values.customer)),
        el('div', { text: 'Status: ' + norm(rec.display.status) + '   ·   SO release ' + (norm(rec.display.so_release_status_bar) || '—') + '   ·   Material ' + (norm(rec.display.mat_status_bar) || '—') })),
      ...sections,
      checks.length ? el('div', { class: 'ps-sec' }, el('h3', { text: 'Checks' }), ...checks.map((c) => el('div', { text: c }))) : '',
      state.scans.length ? el('div', { class: 'ps-sec' }, el('h3', { text: 'Scanned documents' }), ...state.scans.map((s) => el('div', { text: s.name }))) : '',
      el('div', { class: 'ps-sign' }, el('span', { text: 'Prepared by: ______________________' }), el('span', { text: 'Approved by: ______________________' }), el('span', { text: 'Date: ______________' })),
      el('div', { class: 'ps-foot', text: 'Printed by ' + state.email + ' on ' + new Date().toLocaleString() })
    );
    window.print();
  }

  // ---------- uploads (editors and admins) (stockroom prices, STEEL USAGE data)
  const SHEETJS = { src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw' };
  const UP_MODES = {
    stock: {
      title: 'Upload stockroom price sheet', action: 'uploadStock',
      note: 'CSV or Excel (.xlsx). Prices in this file are compared with PART PRICE for each part number. Uploading replaces the previous stockroom prices for everyone.',
      cols: [['part', 'Part number column', /part|item|sku|p\/n|number/i], ['price', 'Price column', /price|cost|unit|amount/i]],
      build: (r, c) => { const part = String(r[c.part] ?? '').trim(); const price = priceNum(r[c.price]); return part && price !== null && price >= 0 ? { part, price } : null; },
      show: (x) => x.part + ' → ' + money(x.price)
    },
    items: {
      title: 'Replace STOCK list', action: 'uploadStockItems', danger: true,
      note: 'CSV or Excel (.xlsx) exported from the stock system (PartNumber, CustomerName, TotalQuantity, UnitPrice). This replaces the whole STOCK list that PART PRICE and AVAIL (FT) are looked up from.',
      cols: [['part', 'Part number column (PartNumber)', /part/i], ['customer', 'Customer column (CustomerName)', /customer/i], ['quantity', 'Quantity column (TotalQuantity)', /quantity|qty/i], ['price', 'Unit price column (UnitPrice)', /unit.?price|price/i]],
      build: (r, c) => { const part = String(r[c.part] ?? '').trim(); return part ? { part, customer: String(r[c.customer] ?? '').trim(), quantity: priceNum(r[c.quantity]), price: priceNum(r[c.price]) } : null; },
      show: (x) => x.part + ' | ' + (x.customer || '—') + ' | qty ' + (x.quantity ?? '—') + ' | ' + (x.price === null ? '—' : money(x.price))
    },
    steel: {
      title: 'Replace STEEL USAGE data', action: 'uploadSteelUsage', danger: true,
      note: 'CSV or Excel (.xlsx) with one row per part. This DELETES all existing STEEL USAGE data and replaces it with this file. Steel type, router bar size and qty/bar on every SO are looked up from it. A copy of the old data is kept so it can be restored.',
      cols: [['part', 'Part number column (PART NUMBER)', /part/i], ['steel', 'Steel type column (PS_COMP)', /comp|steel/i], ['qty', 'Qty / bar column (PS_QTY PER)', /qty|per/i], ['router', "Router bar size column (MAT'L TYPE)", /mat.?l|router|bar.?size/i]],
      build: (r, c) => { const t = (i) => String(r[i] ?? '').trim(); const part = t(c.part); return part ? { part, steel: t(c.steel), qty: t(c.qty), router: t(c.router) } : null; },
      show: (x) => x.part + ' | ' + (x.steel || '—') + ' | ' + (x.qty || '—') + ' | ' + (x.router || '—')
    }
  };
  const up = { mode: null, sheets: [], file: null, rows: [] };
  function loadSheetJs() {
    return new Promise((resolve, reject) => {
      if (window.XLSX) return resolve();
      const s = document.createElement('script');
      s.src = SHEETJS.src; s.integrity = SHEETJS.integrity; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load the Excel reader. Save the sheet as CSV and try again.'));
      document.head.append(s);
    });
  }
  function parseCsv(t) {
    const rows = []; let r = [], f = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; r.push(f); f = ''; rows.push(r); r = []; }
      else f += c;
    }
    if (f || r.length) { r.push(f); rows.push(r); }
    return rows;
  }
  async function readUploadFile(file) {
    if (file.size > 15 * 1024 * 1024) throw new Error('File is too large (15 MB limit).');
    if (/\.csv$/i.test(file.name)) return [{ name: 'CSV', rows: parseCsv((await file.text()).replace(/^﻿/, '')) }];
    await loadSheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
  }
  const priceNum = (v) => { if (typeof v === 'number') return isFinite(v) ? v : null; const c = String(v ?? '').replace(/[$,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(c) ? parseFloat(c) : null; };
  const colSel = (key) => $('upc-' + key);
  function currentSheet() { return up.sheets[+$('up-sheet').value] || { rows: [] }; }
  function fillColumnPickers() {
    const mode = UP_MODES[up.mode];
    const rows = currentSheet().rows;
    const hi = rows.findIndex((r) => r.filter((c) => String(c).trim() !== '').length >= 2);
    const head = hi >= 0 ? rows[hi] : [];
    const n = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
    const name = (i) => (String(head[i] ?? '').trim() || 'Column ' + (i + 1));
    const used = new Set();
    $('up-cols').replaceChildren(...mode.cols.map(([key, label, re]) => {
      const sel = el('select', { id: 'upc-' + key }, Array.from({ length: n }, (_, i) => el('option', { value: String(i), text: name(i) })));
      let guess = Array.from({ length: n }, (_, i) => i).find((i) => !used.has(i) && re.test(String(head[i] ?? '')));
      if (guess === undefined) guess = Array.from({ length: n }, (_, i) => i).find((i) => !used.has(i));
      if (guess !== undefined) { sel.value = String(guess); used.add(guess); }
      sel.addEventListener('change', updateUploadPreview);
      return el('label', {}, label, sel);
    }));
    up.headerRow = hi;
    updateUploadPreview();
  }
  function collectUploadRows() {
    const mode = UP_MODES[up.mode];
    const c = Object.fromEntries(mode.cols.map(([key]) => [key, +colSel(key).value]));
    const out = []; let skipped = 0;
    currentSheet().rows.slice(Math.max(0, up.headerRow + 1)).forEach((r) => {
      if (r.every((x) => String(x ?? '').trim() === '')) return;
      const x = mode.build(r, c); x ? out.push(x) : skipped++;
    });
    return { out, skipped };
  }
  function updateUploadPreview() {
    const mode = UP_MODES[up.mode]; const { out, skipped } = collectUploadRows();
    up.rows = out;
    $('up-preview').textContent = out.length
      ? out.length + ' valid rows' + (skipped ? ', ' + skipped + ' skipped' : '') + '.  First rows:\n' + out.slice(0, 3).map(mode.show).join('\n')
      : 'No valid rows with this column choice.' + (skipped ? ' (' + skipped + ' rows skipped)' : '');
    $('up-go').disabled = !out.length;
  }
  function openUpload(modeKey) {
    up.mode = modeKey; const mode = UP_MODES[modeKey];
    $('up-title').textContent = mode.title; $('up-note').textContent = mode.note;
    $('up-go').textContent = mode.danger ? 'Replace data' : 'Upload and compare'; $('up-go').className = 'btn ' + (mode.danger ? 'btn-danger' : 'btn-primary');
    $('upload-file').value = ''; $('upload-map').hidden = true; $('upload-msg').textContent = ''; $('up-go').disabled = true; up.rows = [];
    $('dlg-upload').showModal();
  }
  $('btn-upload-steel').onclick = () => openUpload('steel');
  // daily inventory: one ALL CUSTOMER INVENTORY file feeds both the STOCK list and the stockroom prices
  const inv = { rows: [], file: '' };
  const INV_COLS = { part: /^part/i, customer: /customer/i, quantity: /quantity|qty/i, price: /unit.?price|price/i };
  async function invRead(file) {
    const sheets = (await readUploadFile(file)).filter((s) => s.rows.length); let found = '';
    for (const s of sheets) {
      const hi = s.rows.findIndex((r) => r.filter((c) => String(c).trim() !== '').length >= 2); if (hi < 0) continue;
      const head = s.rows[hi].map((c) => String(c).trim()); found = head.filter(Boolean).join(', ');
      const c = {}; for (const [k, re] of Object.entries(INV_COLS)) c[k] = head.findIndex((x) => re.test(x));
      if (Object.values(c).some((i) => i < 0)) continue;
      const rows = []; let skipped = 0;
      s.rows.slice(hi + 1).forEach((r) => {
        if (r.every((x) => String(x ?? '').trim() === '')) return;
        const part = String(r[c.part] ?? '').trim(); if (!part) { skipped++; return; }
        rows.push({ part, customer: String(r[c.customer] ?? '').trim(), quantity: priceNum(r[c.quantity]), price: priceNum(r[c.price]) });
      });
      if (rows.length) return { rows, skipped };
    }
    throw new Error('Could not find the columns PartNumber, CustomerName, TotalQuantity and UnitPrice in this file.' + (found ? ' Columns found: ' + found + '.' : ''));
  }
  $('btn-upload').onclick = () => { $('inv-file').value = ''; $('inv-sum').hidden = true; $('inv-msg').textContent = ''; $('inv-go').disabled = true; inv.rows = []; $('dlg-inv').showModal(); };
  $('inv-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; $('inv-msg').textContent = ''; $('inv-sum').hidden = true; $('inv-go').disabled = true; inv.rows = [];
    if (!f) return;
    $('inv-msg').textContent = 'Reading the file…';
    try {
      const { rows, skipped } = await invRead(f); inv.rows = rows; inv.file = f.name; $('inv-msg').textContent = '';
      const stocked = rows.filter((r) => r.quantity > 0), customers = new Set(rows.map((r) => r.customer).filter(Boolean)).size;
      const value = rows.reduce((t, r) => t + (r.quantity > 0 && r.price ? r.quantity * r.price : 0), 0);
      const stat = (v, l) => el('div', { class: 'invstat' }, el('b', { text: v }), el('small', { text: l }));
      $('inv-sum').replaceChildren(el('p', { class: 'invfile', text: f.name }), el('div', { class: 'invgrid' }, stat(rows.length.toLocaleString(), 'part lines'), stat(stocked.length.toLocaleString(), 'in stock now'),
        stat(String(customers), 'customers'), stat('$' + Math.round(value).toLocaleString(), 'stock value')), skipped ? el('p', { class: 'muted small', text: skipped + ' rows without a part number will be skipped.' }) : '');
      $('inv-sum').hidden = false; $('inv-go').disabled = false;
    } catch (err) { $('inv-msg').textContent = err.message || 'Could not read the file.'; }
  });
  $('dlg-inv').addEventListener('close', async () => {
    if ($('dlg-inv').returnValue !== 'ok' || !inv.rows.length) return;
    const n = inv.rows.length; toast('Uploading ' + n.toLocaleString() + ' parts…');
    const a = await api('uploadStockItems', { rows: inv.rows, fileName: inv.file });
    if (!a.ok) { toast(a.error || 'Upload failed.', true); return; }
    const b = await api('uploadStock', { rows: inv.rows.filter((r) => r.price !== null && r.price >= 0).map((r) => ({ part: r.part, price: r.price })), fileName: inv.file });
    if (!b.ok) { toast('STOCK list updated, but the prices failed: ' + (b.error || 'error') + '. Upload the file again.', true); await loadList(); return; }
    toast('Inventory updated: ' + a.count.toLocaleString() + ' parts' + (a.skipped ? ' (' + a.skipped + ' skipped)' : '') + '.'); inv.rows = [];
    await loadList();
  });
  $('upload-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; $('upload-msg').textContent = ''; $('upload-map').hidden = true; $('up-go').disabled = true;
    if (!file) return;
    try {
      up.sheets = (await readUploadFile(file)).filter((s) => s.rows.length); up.file = file.name;
      if (!up.sheets.length) throw new Error('The file looks empty.');
      $('up-sheet').replaceChildren(...up.sheets.map((s, i) => el('option', { value: String(i), text: s.name + ' (' + s.rows.length + ' rows)' })));
      $('upload-map').hidden = false; fillColumnPickers();
    } catch (err) { $('upload-msg').textContent = err.message || 'Could not read the file.'; }
  });
  $('up-sheet').addEventListener('change', fillColumnPickers);
  $('dlg-upload').addEventListener('close', async () => {
    if ($('dlg-upload').returnValue !== 'ok' || !up.rows.length) return;
    const mode = UP_MODES[up.mode]; const n = up.rows.length;
    if (mode.danger) {
      const body = el('div', {}, el('p', { text: 'This will delete ALL existing ' + (up.mode === 'items' ? 'STOCK list' : 'STEEL USAGE') + ' data and replace it with ' + n + ' rows from "' + up.file + '".' }),
        el('p', { text: up.mode === 'items' ? 'PART PRICE and AVAIL (FT) on every SO will change immediately.' : 'The old data is kept as a copy so it can be restored. Steel type, router bar size and qty/bar on every SO will change immediately.' }));
      if (!(await confirmDialog(up.mode === 'items' ? 'Replace STOCK list?' : 'Replace STEEL USAGE data?', body, 'Delete old data and replace', true))) return;
    }
    toast('Uploading ' + n + ' rows…');
    const r = await api(mode.action, { rows: up.rows, fileName: up.file });
    if (!r.ok) { toast(r.error || 'Upload failed.', true); return; }
    toast((up.mode === 'steel' ? 'STEEL USAGE replaced: ' : up.mode === 'items' ? 'STOCK list replaced: ' : 'Stockroom prices uploaded: ') + r.count + ' rows' + (r.skipped ? ' (' + r.skipped + ' skipped)' : '') + '.');
    await loadList();
  });

  // ---------- admin: users
  const ROLE_OPTIONS = ['viewer', 'editor', 'admin'];
  async function openUsers() {
    show('view-users'); banner('users-banner', '', ''); $('users-grid').tBodies[0].replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted', text: 'Loading users…' })));
    const r = await api('listUsers');
    if (!r.ok) { if (r.code === 'UNAUTHENTICATED') return showLogin(r.error); banner('users-banner', 'err', r.error); return; }
    state.users = r.users; state.bootstrap = r.bootstrap; renderUsers();
  }
  function usersApplied(r) { state.users = r.users; state.bootstrap = r.bootstrap; renderUsers(); }
  async function saveUsers(list, okMsg) {
    banner('users-banner', '', '');
    const r = await api('saveUsers', { users: list });
    if (!r.ok) { banner('users-banner', 'err', r.error); renderUsers(); return false; }
    usersApplied(r); toast(okMsg || 'Saved.'); return true;
  }
  function renderUsers() {
    const users = state.users || [];
    $('users-count').textContent = users.length + ' user' + (users.length === 1 ? '' : 's');
    $('users-grid').tHead.replaceChildren(el('tr', {}, ['EMAIL', 'NAME', 'EMPLOYEE ID', 'ROLE', 'ACTIVE', 'PASSWORD', ''].map((t) => el('th', { text: t }))));
    const me = state.email.toLowerCase();
    $('users-grid').tBodies[0].replaceChildren(...(users.length ? users.map((u) => {
      const sel = el('select', { 'aria-label': 'Role for ' + u.email }, ROLE_OPTIONS.map((r) => el('option', { value: r, text: r })));
      sel.value = u.role;
      sel.addEventListener('change', () => saveUsers([{ email: u.email, role: sel.value, active: u.active }], 'Role updated.'));
      const act = el('input', { type: 'checkbox', 'aria-label': 'Active: ' + u.email }); act.checked = u.active;
      act.addEventListener('change', () => saveUsers([{ email: u.email, role: u.role, active: act.checked }], act.checked ? 'User enabled.' : 'User disabled.'));
      return el('tr', { class: u.active ? '' : 'inactive' }, el('td', { text: u.email + (u.email === me ? '  (you)' : '') }), el('td', { text: norm(u.name) }), el('td', { text: norm(u.employeeId) }),
        el('td', {}, sel), el('td', {}, act),
        el('td', {}, el('button', { class: 'btn btn-sm', type: 'button', text: u.hasPassword ? 'Change' : 'Set password', title: u.hasPassword ? 'A password is set' : 'No password yet: this person cannot sign in', onclick: () => setUserPassword(u) }), u.hasPassword ? '' : el('small', { class: 'muted', text: '  not set' })),
        el('td', {}, el('button', { class: 'btn btn-ghost', type: 'button', text: 'Delete', onclick: async () => {
          if (!(await confirmDialog('Delete user?', el('p', { text: u.email + ' will no longer be able to sign in.' }), 'Delete', true))) return;
          const r = await api('deleteUser', { email: u.email });
          if (!r.ok) { banner('users-banner', 'err', r.error); return; }
          usersApplied(r); toast('User deleted.');
        } })));
    }) : [el('tr', {}, el('td', { colspan: 7, text: 'No users added yet. Add the first one above.' }))]));
    const b = state.bootstrap || [];
    $('users-bootstrap').textContent = b.length ? 'Also allowed by the backend settings (cannot be removed here): ' + b.map((x) => x.email + ' (' + x.role + ')').join(', ') + '.' : '';
  }
  function randomPassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(b, (x) => chars[x % chars.length]).join('');
  }
  async function setUserPassword(u) {
    const pw = el('input', { type: 'text', value: randomPassword(), autocomplete: 'off', 'aria-label': 'New password' });
    const gen = el('button', { class: 'btn btn-sm', type: 'button', text: 'Generate', onclick: () => { pw.value = randomPassword(); } });
    const body = el('div', { class: 'pwform' }, el('p', { text: 'New password for ' + u.email + '. Give it to the person; they can change it themselves after signing in (Password button).' }), el('div', { class: 'findrow' }, pw, gen));
    if (!(await confirmDialog('Set password', body, 'Set password'))) return;
    const r = await api('setPassword', { email: u.email, password: pw.value });
    if (!r.ok) { banner('users-banner', 'err', r.error); return; }
    toast('Password set for ' + u.email + '.'); const ur = await api('listUsers'); if (ur.ok) usersApplied(ur);
  }
  $('user-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('ua-pw').value.trim(), email = $('ua-email').value;
    if (pw && pw.length < 8) { banner('users-banner', 'err', 'The password must be at least 8 characters.'); return; }
    const ok = await saveUsers([{ email, name: $('ua-name').value, employeeId: $('ua-eid').value, role: $('ua-role').value, active: true }], 'User saved.');
    if (!ok) return;
    if (pw) { const r = await api('setPassword', { email, password: pw }); if (!r.ok) banner('users-banner', 'err', r.error); else { toast('User saved with a password.'); const ur = await api('listUsers'); if (ur.ok) usersApplied(ur); } }
    $('user-add').reset(); $('ua-email').focus();
  });
  let importRows = [];
  $('ua-file').addEventListener('change', async () => {
    const f = $('ua-file').files[0]; const msg = $('ua-import-msg'); $('ua-import').disabled = true; importRows = []; msg.textContent = '';
    if (!f) return;
    try {
      const rows = parseCsv((await f.text()).replace(/^\uFEFF/, '')).filter((r) => r.some((c) => String(c).trim() !== ''));
      const head = rows[0].map((c) => String(c).trim().toLowerCase());
      const col = (re) => head.findIndex((h) => re.test(h));
      const ie = col(/mail/), inm = col(/name/), ii = col(/employee|emp.?id|^id$/), ir = col(/role/);
      if (ie < 0) throw new Error('No "email" column found in the first row.');
      importRows = rows.slice(1).map((r) => ({ email: r[ie], name: inm >= 0 ? r[inm] : undefined, employeeId: ii >= 0 ? r[ii] : undefined, role: ir >= 0 && String(r[ir]).trim() ? r[ir] : 'viewer', active: true }));
      msg.textContent = importRows.length + ' rows ready.'; $('ua-import').disabled = !importRows.length;
    } catch (err) { msg.textContent = err.message || 'Could not read the file.'; }
  });
  $('ua-import').onclick = async () => {
    if (!importRows.length) return;
    if (!(await confirmDialog('Import users?', el('p', { text: importRows.length + ' users will be added or updated. Roles in the file are applied.' }), 'Import'))) return;
    const ok = await saveUsers(importRows.slice(0, 500), 'Imported ' + Math.min(importRows.length, 500) + ' users.');
    if (ok) { $('ua-file').value = ''; $('ua-import').disabled = true; importRows = []; $('ua-import-msg').textContent = importRows.length > 500 ? 'Only the first 500 were imported; import the rest separately.' : ''; }
  };

  // ---------- wiring
  // ---------- subcontractor tracking (coordinator view of the BPO lines the subcontractor team executes)
  const SC = { section: 'subcon', tab: 'queue', q: '', filter: 'open', bpo: '', data: null };
  const scCanWrite = () => state.role === 'editor' || state.role === 'admin';
  const dshort = (s) => (isIso(s || '') ? shortDate(parseDate(s)) : '—');
  const qtyFmt = (n) => Number(n || 0).toLocaleString();
  async function openSubcon(section) {
    if (!(await leaveGuard())) return;
    SC.section = section === 'leads' ? 'leads' : 'subcon';
    show('view-subcon'); $('btn-refresh').hidden = true; banner('sc-banner', '', '');
    await loadSubcon();
  }
  async function loadSubcon() {
    const r = await api('scList', { today: today() });
    if (!r.ok) { if (r.code === 'UNAUTHENTICATED') return showLogin(r.error); banner('sc-banner', 'err', r.error); return; }
    SC.data = r; renderSubcon();
  }
  function renderSubcon() {
    const d = SC.data, k = d.kpis, leads = SC.section === 'leads';
    navSync('view-subcon');
    $('sc-title').textContent = leads ? 'Lead Time Calculation' : 'Subcontractor';
    $('sc-sub').textContent = leads ? 'How long each stage actually takes, and when a new PO should arrive.' : 'Monitor what the subcontractor team is doing: requirements sent, stage, quantities, delays, and what needs you.';
    $('sc-actions').hidden = leads || !scCanWrite(); $('sc-kpis').hidden = leads; $('sc-tabs').hidden = leads;
    if (leads) { $('sc-body').replaceChildren(scLeadCalc(), scLeadStats()); return; }
    const kp = (cls, v, l) => el('div', { class: 'kpi ' + cls }, el('div', { class: 'kv', text: String(v) }), el('div', { class: 'kl', text: l }));
    $('sc-kpis').replaceChildren(kp('info', k.open, 'Open lines'), kp(k.needsAction ? 'warn' : 'ok', k.needsAction, 'Need my action'), kp(k.pastDue ? 'bad' : 'ok', k.pastDue, 'Past due'),
      kp(k.forecastLate ? 'warn' : 'ok', k.forecastLate, 'Forecast late'), kp(k.blocked ? 'bad' : 'ok', k.blocked, 'Blocked / on hold'), kp(k.stale ? 'warn' : 'ok', k.stale, 'No recent update'), kp('info', qtyFmt(k.openQty), 'Pcs still open'));
    const tabs = [['queue', 'Needs my action (' + k.needsAction + ')'], ['lines', 'All lines'], ['batches', 'Batches']];
    $('sc-tabs').replaceChildren(...tabs.map(([id, label]) => el('button', { class: 'chip' + (SC.tab === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(SC.tab === id), text: label, onclick: () => { SC.tab = id; renderSubcon(); } })));
    $('sc-body').replaceChildren(SC.tab === 'queue' ? scQueueView() : SC.tab === 'lines' ? scLinesView() : scBatchesView());
  }
  const scBar = (pct, cls) => el('div', { class: 'scbar ' + (cls || ''), title: pct + '%' }, el('i', { style: 'width:' + pct + '%' }), el('span', { text: pct + '%' }));
  const scPrio = (p) => (p === 'NORMAL' ? '' : el('span', { class: 'badge ' + (p === 'LINE DOWN' ? 'sc-bad' : 'sc-warn'), text: p }));
  function scTable(head, body, emptyText) {
    return el('div', { class: 'tablewrap card' }, el('table', { class: 'datatable' }, el('thead', {}, el('tr', {}, head.map((t) => el('th', { text: t })))),
      el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colspan: head.length, class: 'muted', text: emptyText }))])));
  }
  function scLineRow(o, mode) {
    const why = o.reasons.map((r) => el('span', { class: 'badge ' + (r.level === 'crit' ? 'sc-bad' : 'sc-warn'), text: r.text }));
    const exp = el('td', {}, dshort(o.expected), o.projected && !(o.ms && o.ms.eta_camco) ? el('small', { class: 'muted', title: 'Projected from past lead times', text: ' ~' + dshort(o.projected) }) : '');
    const cells = [
      el('td', {}, el('span', { class: 'dot sc-dot-' + o.attention, title: o.attention === 'crit' ? 'Critical' : o.attention === 'warn' ? 'Needs attention' : 'On track' })),
      el('td', {}, el('b', { text: o.so_no }), el('br'), el('small', { class: 'muted', text: 'PO ' + o.po_no }), ' ', scPrio(o.priority)),
      el('td', { title: o.description || '' }, o.part_no, o.ryd_part ? el('br') : '', o.ryd_part ? el('small', { class: 'muted', text: o.ryd_part }) : ''),
      el('td', { text: [o.bpo_no, o.batch].filter(Boolean).join(' · ') || '—' }),
      el('td', {}, qtyFmt(o.qty_stocked + o.qty_rejected), ' / ', qtyFmt(o.qty), o.qty_hold > 0 ? el('br') : '', o.qty_hold > 0 ? el('small', { class: 'sc-bad-text', text: qtyFmt(o.qty_hold) + ' on hold' }) : ''),
      el('td', { text: o.stage }), el('td', {}, scBar(o.progress, o.attention === 'crit' ? 'bad' : o.attention === 'warn' ? 'warn' : '')),
      el('td', { text: dshort(o.required_date) }), exp
    ];
    if (mode === 'queue') cells.push(el('td', { class: 'whycell' }, why), el('td', { class: 'actioncell', text: o.action }));
    else cells.push(el('td', { class: 'whycell' }, o.open ? (why.length ? why : el('span', { class: 'badge sc-ok', text: 'On track' })) : el('span', { class: 'badge sc-muted', text: 'Closed' })));
    cells.push(el('td', {}, scCanWrite() ? el('button', { class: 'btn btn-sm', type: 'button', text: 'Log', title: 'Log a follow-up or update', onclick: (e) => { e.stopPropagation(); scEditLine(o, true); } }) : ''));
    return el('tr', { class: 'clickrow', onclick: () => scEditLine(o) }, cells);
  }
  const SC_HEAD = ['', 'SO / PO', 'PART', 'BPO · BATCH', 'DONE / QTY', 'STAGE', 'PROGRESS', 'REQUIRED', 'EXPECTED'];
  function scQueueView() {
    const byId = new Map(SC.data.lines.map((l) => [l.id, l]));
    const rows = SC.data.queue.map((id) => byId.get(id)).filter(Boolean).map((o) => scLineRow(o, 'queue'));
    return el('div', {}, el('p', { class: 'muted pad', text: 'Lines that are late, blocked, on hold, not acknowledged, or have had no update. Critical first, then by priority and required date. Click a line to see everything and log what the team said.' }),
      scTable(SC_HEAD.concat(['WHY', 'WHAT TO DO', '']), rows, 'Nothing needs your action right now.'));
  }
  function scLinesView() {
    let rows = SC.data.lines;
    const f = SC.filter;
    rows = rows.filter((o) => (f === 'all' || (f === 'open' && o.open) || (f === 'closed' && !o.open)) && (!SC.bpo || o.bpo_no === SC.bpo));
    const q = SC.q.trim().toLowerCase();
    if (q) rows = rows.filter((o) => [o.so_no, o.po_no, o.part_no, o.ryd_part, o.bpo_no, o.batch, o.stage, o.note].some((v) => norm(v).toLowerCase().includes(q)));
    const search = el('input', { type: 'search', placeholder: 'Search SO, PO, part, stage…', 'aria-label': 'Search', value: SC.q });
    search.addEventListener('input', () => {
      SC.q = search.value; clearTimeout(scLinesView.t);
      scLinesView.t = setTimeout(() => { const pos = search.selectionStart; renderSubcon(); const s2 = $('sc-body').querySelector('input[type=search]'); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); } }, 250);
    });
    const bpos = [...new Set(SC.data.lines.map((l) => l.bpo_no).filter(Boolean))].sort();
    const bsel = scSelect([['', 'All BPOs']].concat(bpos.map((b) => [b, b])), SC.bpo); bsel.addEventListener('change', () => { SC.bpo = bsel.value; renderSubcon(); });
    const chips = [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([id, l]) => el('button', { class: 'chip' + (SC.filter === id ? ' on' : ''), type: 'button', text: l, onclick: () => { SC.filter = id; renderSubcon(); } }));
    return el('div', {}, el('div', { class: 'listhead' }, el('div', { class: 'chips' }, chips), el('div', { class: 'listtools' }, bsel, search, el('button', { class: 'btn btn-sm', type: 'button', text: 'Export CSV', onclick: () => scExportCsv(rows) }))),
      scTable(SC_HEAD.concat(['STATUS', '']), rows.map((o) => scLineRow(o, 'lines')), 'No lines here yet. Use "Add line" or "Import BPO sheet".'));
  }
  function scExportCsv(rows) {
    const ms = SC.data.milestones.map((m) => m.key);
    const cols = ['bpo_no', 'batch', 'po_no', 'so_no', 'part_no', 'ryd_part', 'qty', 'qty_shipped', 'qty_received', 'qty_hold', 'qty_rejected', 'qty_stocked', 'priority', 'owner', 'sent_date', 'required_date', 'expected', 'stage', 'progress', 'blocker_type', 'blocker', 'next_action', 'next_action_date', 'revised_date', 'delay_reason', 'last_update', 'note'];
    const esc = (v) => { v = norm(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.concat(ms).join(',')].concat(rows.map((o) => cols.map((c) => esc(o[c])).concat(ms.map((k) => esc(o.ms && o.ms[k]))).join(',')));
    const a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' })), download: 'subcontractor-lines-' + today() + '.csv' });
    document.body.append(a); a.click(); a.remove();
  }
  function scBatchesView() {
    const head = ['BPO', 'BATCH', 'LINES', 'OPEN', 'QTY (PCS)', 'PCS OPEN', 'PROGRESS', 'WHERE THEY ARE', 'REQUIRED', 'EXPECTED', 'ATTENTION', ''];
    const rows = SC.data.batches.map((b) => el('tr', { class: 'clickrow', onclick: () => { SC.tab = 'lines'; SC.bpo = b.bpo_no; SC.q = b.batch; renderSubcon(); } },
      el('td', {}, el('b', { text: b.bpo_no || '—' })), el('td', { text: b.batch || '—' }), el('td', { text: String(b.lines) }), el('td', { text: String(b.open) }), el('td', { text: qtyFmt(b.qty) }), el('td', { text: qtyFmt(b.remaining) }),
      el('td', {}, scBar(b.progress, b.crit ? 'bad' : b.warn ? 'warn' : '')),
      el('td', { class: 'small' }, Object.entries(b.stages).sort((x, y) => y[1] - x[1]).map(([s, n]) => n + ' × ' + s).join(', ') || 'All closed'),
      el('td', { text: dshort(b.required) }), el('td', { text: dshort(b.expected) }),
      el('td', {}, b.crit ? el('span', { class: 'badge sc-bad', text: b.crit + ' critical' }) : '', ' ', b.warn ? el('span', { class: 'badge sc-warn', text: b.warn + ' watch' }) : '', !b.crit && !b.warn && b.open ? el('span', { class: 'badge sc-ok', text: 'On track' }) : ''),
      el('td', {}, scCanWrite() && b.open ? el('button', { class: 'btn btn-sm', type: 'button', text: 'Update batch', onclick: (e) => { e.stopPropagation(); scBatchDialog(b); } }) : '')));
    return el('div', {}, el('p', { class: 'muted pad', text: 'Lines usually move together by BPO batch. "Update batch" applies one date, note or blocker to every open line in the batch and logs it on each line.' }), scTable(head, rows, 'No batches yet.'));
  }

  // ---- dialogs: one form body, re-shown with field errors until it saves or is cancelled
  function scField(label, input, key, req) { return el('label', { class: 'scfield' }, el('span', { class: 'sclabel', text: label + (req ? ' *' : '') }), input, el('small', { class: 'fielderr', 'data-err': key })); }
  const scInput = (type, val, extra) => el('input', Object.assign({ type, value: val == null ? '' : String(val), autocomplete: 'off' }, extra || {}));
  function scSelect(options, val) { const s = el('select', {}, options.map(([v, l]) => el('option', { value: v, text: l }))); s.value = val == null ? '' : val; return s; }
  function scShowErrors(body, errors) { body.querySelectorAll('[data-err]').forEach((n) => { n.textContent = (errors && errors[n.getAttribute('data-err')]) || ''; }); }
  async function scDialog(title, body, collect, action, okLabel) {
    for (;;) {
      if (!(await confirmDialog(title, body, okLabel || 'Save'))) return false;
      const r = await api(action, collect());
      if (r.ok) return r;
      if (r.fieldErrors) { scShowErrors(body, r.fieldErrors); toast(r.error || 'Please fix the highlighted fields.', true); continue; }
      toast(r.error || 'Could not save.', true); return false;
    }
  }
  const dateIn = (v) => scInput('date', v);
  async function scBatchDialog(b) {
    const D = SC.data;
    const ms = scSelect([['', '— no milestone —']].concat(D.milestones.map((m) => [m.key, m.label])), ''), msDate = dateIn(today());
    const f = { revised: dateIn(''), reason: scInput('text', ''), btype: scSelect(D.blockers.map((x) => [x, x || '— no blocker —']), ''), blocker: scInput('text', ''), note: el('textarea', { rows: 3 }),
      clear: el('input', { type: 'checkbox' }), over: el('input', { type: 'checkbox' }) };
    const body = el('div', { class: 'scform' }, el('p', { text: 'Applies to the ' + b.open + ' open line' + (b.open === 1 ? '' : 's') + ' in ' + b.bpo_no + ' · ' + b.batch + '. Each line gets a log entry.' }),
      scField('Milestone reached / estimated', ms, 'ms_any'), scField('Date', msDate, 'ms_date'),
      el('label', { class: 'inline' }, f.over, ' Overwrite dates that are already filled'),
      scField('Revised completion date', f.revised, 'revised_date'), scField('Reason for delay', f.reason, 'delay_reason'),
      scField('Blocker type', f.btype, 'blocker_type'), scField('Blocker', f.blocker, 'blocker'), el('label', { class: 'inline' }, f.clear, ' Clear the blockers on these lines'),
      scField('Note (what the team said)', f.note, 'note'));
    const r = await scDialog('Update batch', body, () => ({ bulk: { bpo_no: b.bpo_no, batch: b.batch, ms: ms.value ? { [ms.value]: msDate.value } : {}, overwrite: f.over.checked, revised_date: f.revised.value, delay_reason: f.reason.value, blocker_type: f.btype.value, blocker: f.blocker.value, clear_blocker: f.clear.checked, note: f.note.value } }), 'scBulk', 'Apply to batch');
    if (r) { toast('Updated ' + r.count + ' lines.'); loadSubcon(); }
  }
  async function scDeleteLine(o) {
    if (!(await confirmDialog('Delete line', el('p', { text: 'Delete PO ' + o.po_no + ' (SO ' + o.so_no + ')? Its update log is deleted too and this cannot be undone.' }), 'Delete', true))) return false;
    const r = await api('scDeleteLine', { id: o.id }); if (!r.ok) { toast(r.error, true); return false; } toast('Deleted PO ' + o.po_no + '.'); return true;
  }
  async function scEditLine(o, focusLog) {
    o = o || {};
    const D = SC.data, ro = !scCanWrite(), isNew = !o.id;
    const f = {
      bpo_no: scInput('text', o.bpo_no, { placeholder: 'e.g. BPO-003' }), batch: scInput('text', o.batch, { placeholder: 'e.g. 2nd Batch' }), po_no: scInput('text', o.po_no), so_no: scInput('text', o.so_no),
      part_no: scInput('text', o.part_no), ryd_part: scInput('text', o.ryd_part), description: scInput('text', o.description), qty: scInput('number', o.qty, { min: 0, step: 'any' }),
      priority: scSelect(D.priorities.map((p) => [p, p]), o.priority || 'NORMAL'), owner: scInput('text', o.owner, { placeholder: 'Person on the team' }),
      sent_date: dateIn(o.sent_date || (isNew ? today() : '')), required_date: dateIn(o.required_date), customer_due_date: dateIn(o.customer_due_date),
      qty_shipped: scInput('number', o.qty_shipped, { min: 0, step: 'any' }), qty_received: scInput('number', o.qty_received, { min: 0, step: 'any' }), qty_hold: scInput('number', o.qty_hold, { min: 0, step: 'any' }),
      qty_rejected: scInput('number', o.qty_rejected, { min: 0, step: 'any' }), qty_stocked: scInput('number', o.qty_stocked, { min: 0, step: 'any' }),
      blocker_type: scSelect(D.blockers.map((x) => [x, x || '— none —']), o.blocker_type || ''), blocker: scInput('text', o.blocker), next_action: scInput('text', o.next_action), next_action_date: dateIn(o.next_action_date),
      revised_date: dateIn(o.revised_date), delay_reason: scInput('text', o.delay_reason), last_update: dateIn(o.last_update || (isNew ? today() : '')),
      escalated: el('input', { type: 'checkbox' }), closed: el('input', { type: 'checkbox' }), note: el('textarea', { rows: 2 })
    };
    f.escalated.checked = !!o.escalated; f.closed.checked = !!o.closed; f.note.value = o.note || '';
    ['po_no', 'so_no', 'part_no', 'qty'].forEach((k) => f[k].classList.add('mandatory-in'));
    const mf = {}; D.milestones.forEach((m) => { mf[m.key] = dateIn(o.ms && o.ms[m.key]); });
    const remaining = el('b', { text: o.id ? qtyFmt(o.remaining) : '—' });
    const info = o.id ? el('div', { class: 'scinfo' }, el('span', { class: 'badge ' + (o.attention === 'crit' ? 'sc-bad' : o.attention === 'warn' ? 'sc-warn' : 'sc-ok'), text: o.stage }), ' ', o.reasons.map((r) => [el('span', { class: 'badge ' + (r.level === 'crit' ? 'sc-bad' : 'sc-warn'), text: r.text }), ' ']),
      o.action ? el('div', { class: 'calcnote', text: 'Suggested: ' + o.action }) : '') : '';
    const log = el('div', { class: 'sclog' }), logKind = scSelect(D.updateKinds.map((k) => [k, k]), 'FOLLOW-UP'), logText = el('textarea', { rows: 2, placeholder: 'What you asked / what the team replied' });
    const loadLog = async () => {
      if (isNew) { log.replaceChildren(el('p', { class: 'muted', text: 'Save the line first, then log follow-ups here.' })); return; }
      const r = await api('scUpdates', { id: o.id });
      log.replaceChildren(...(r.ok && r.updates.length ? r.updates.map((u) => el('div', { class: 'scupd' }, el('b', { text: u.kind }), el('span', { class: 'muted', text: '  ' + fmtWhen(u.at) + ' · ' + niceName(u.by_user || '') }), el('div', { text: u.text }))) : [el('p', { class: 'muted', text: 'No updates logged yet.' })]));
    };
    const addLog = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'Add to log', onclick: async () => {
      const r = await api('scAddUpdate', { id: o.id, kind: logKind.value, text: logText.value });
      if (!r.ok) { toast((r.fieldErrors && Object.values(r.fieldErrors).join(' ')) || r.error, true); return; }
      logText.value = ''; toast('Logged. Latest update set to today.'); await loadLog(); loadSubcon();
    } });
    const section = (t, ...kids) => el('div', { class: 'scwide scsec' }, el('h4', { text: t }), el('div', { class: 'scgrid' }, kids));
    const msFields = D.milestones.map((m) => scField(m.label + (m.estimate ? ' (est.)' : ''), mf[m.key], 'ms_' + m.key));
    const body = el('div', { class: 'scform scorder' }, info,
      section('Requirement sent', scField('SO #', f.so_no, 'so_no', true), scField('PO #', f.po_no, 'po_no', true), scField('BPO #', f.bpo_no, 'bpo_no'), scField('Batch', f.batch, 'batch'),
        scField('Part # (CAMCO)', f.part_no, 'part_no', true), scField('Part # (customer / RYD)', f.ryd_part, 'ryd_part'), scField('Description', f.description, 'description'), scField('Qty requested', f.qty, 'qty', true),
        scField('Priority', f.priority, 'priority'), scField('Team owner', f.owner, 'owner'), scField('Date sent to team', f.sent_date, 'sent_date'), scField('Required at CAMCO', f.required_date, 'required_date'), scField('Customer due / line-down date', f.customer_due_date, 'customer_due_date')),
      section('Milestones (fill a date when it happens)', msFields),
      section('Quantities', scField('Shipped', f.qty_shipped, 'qty_shipped'), scField('Received at CAMCO', f.qty_received, 'qty_received'), scField('On quality hold', f.qty_hold, 'qty_hold'), scField('Rejected / scrapped', f.qty_rejected, 'qty_rejected'),
        scField('Moved to stock', f.qty_stocked, 'qty_stocked'), el('div', { class: 'scfield' }, el('span', { class: 'sclabel', text: 'Still open' }), remaining)),
      section('Follow-up', scField('Blocker type', f.blocker_type, 'blocker_type'), scField('Blocker / reason it is stuck', f.blocker, 'blocker'), scField('Next action', f.next_action, 'next_action'), scField('Next action by', f.next_action_date, 'next_action_date'),
        scField('Revised completion date', f.revised_date, 'revised_date'), scField('Reason for delay', f.delay_reason, 'delay_reason'), scField('Latest update from team', f.last_update, 'last_update'),
        el('label', { class: 'inline' }, f.escalated, ' Escalated'), scField('Current note', f.note, 'note')),
      el('div', { class: 'scwide scsec' }, el('h4', { text: 'Follow-up log' }), isNew || ro ? '' : el('div', { class: 'scaddlog' }, logKind, logText, addLog), log),
      el('div', { class: 'scwide' }, el('label', { class: 'inline' }, f.closed, ' Verified complete: close this line'), el('small', { class: 'fielderr', 'data-err': 'closed' })));
    loadLog();
    if (ro) { body.querySelectorAll('input,select,textarea,button').forEach((n) => { n.disabled = true; }); await confirmDialog('PO ' + o.po_no, body, 'Close'); return; }
    if (focusLog) setTimeout(() => logText.focus(), 120);
    const collect = () => ({ line: Object.assign({ id: o.id }, Object.fromEntries(Object.keys(f).filter((k) => !['escalated', 'closed'].includes(k)).map((k) => [k, f[k].value])), { escalated: f.escalated.checked, closed: f.closed.checked, ms: Object.fromEntries(Object.keys(mf).map((k) => [k, mf[k].value])) }) });
    const extra = o.id ? el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete line', onclick: async () => { if (await scDeleteLine(o)) { $('dlg').close('cancel'); loadSubcon(); } } }) : null;
    if (extra) body.append(el('div', { class: 'scwide' }, extra));
    const r = await scDialog(isNew ? 'Add subcontractor line' : 'SO ' + o.so_no + ' · PO ' + o.po_no, body, collect, 'scSaveLine');
    if (r) { toast('Saved.'); loadSubcon(); }
  }

  // ---- import from the BPO Tracking worksheet (File > Download > CSV; the sheet itself is never touched)
  const BPO_COLS = {
    'BPO NUMBER': 'bpo_no', 'BATCH NUMBER': 'batch', 'PO NUMBER': 'po_no', 'QTY': 'qty', 'SO NUMBER': 'so_no', 'CM_PART NUMBER': 'part_no', 'RYD_PART NUMBER': 'ryd_part', 'NOTES': 'note',
    'PO DUE DATE AT CAMCO': 'required_date', 'RFQ REQUEST DATE TO OLA': 'rfq', 'PO DETAILS RECEIVED FROM OLA DATE': 'po_received', 'PO CREATION DATE': 'po_created', 'PO SENT TO OLA FOR APPROVAL': 'po_sent_approval',
    'PO APPROVED BY OLA': 'po_approved', 'PO SUBMISSION DATE TO VENDOR': 'po_to_vendor', 'ACKNOWLEDGMENT RECEIVED DATE': 'ack', '30% DOWN PAYMENT TO VENDOR': 'down_payment', 'PRODUCTION START DATE': 'production_start',
    'READY-TO-SHIP BY VENDOR': 'ready_to_ship', 'VENDOR SHIP DATE': 'vendor_ship', 'FREIGHT FORWARDER PICKUP DATE': 'forwarder_pickup', 'SHIP DEPARTURE DATE FROM CHINA PORT': 'port_departure',
    'ESTIMATED ARRIVAL DATE AT NEW YORK PORT': 'eta_port', 'ACTUAL ARRIVAL DATE AT NEW YORK PORT': 'arrived_port', 'ESTIMATED ARRIVAL DATE AT CAMCO': 'eta_camco', 'ACTUAL RECEIPT DATE AT CAMCO': 'received_camco',
    'PARTS MOVED TO INSPECTION DATE': 'to_inspection', 'PARTS MOVED TO STOCK DATE': 'to_stock'
  };
  const fmtD = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const toIsoDate = (s) => { const d = parseDate(s); return d ? fmtD(d) : ''; };
  function bpoRows(text) {
    const all = parseCsv(text.replace(/^﻿/, ''));
    const hi = all.findIndex((r) => r.some((c) => String(c).trim().toUpperCase() === 'PO NUMBER'));
    if (hi < 0) return { error: 'This does not look like the BPO Tracking sheet: no "PO NUMBER" column found.' };
    const cols = all[hi].map((h) => BPO_COLS[String(h).replace(/\s+/g, ' ').trim().toUpperCase()] || '');
    const msKeys = new Set(SC.data.milestones.map((m) => m.key));
    const rows = [];
    all.slice(hi + 1).forEach((r) => {
      const o = { ms: {} };
      cols.forEach((k, i) => { const v = String(r[i] == null ? '' : r[i]).trim(); if (!k || !v) return; if (msKeys.has(k)) o.ms[k] = toIsoDate(v); else if (k === 'required_date') o.required_date = toIsoDate(v); else o[k] = v; });
      if (!o.po_no) return;
      const note = norm(o.note); o.note = /^completed$/i.test(note) ? '' : note;
      if (o.ms.rfq) o.sent_date = o.ms.rfq;
      const q = Number(String(o.qty || '').replace(/,/g, '')); o.qty = q;
      if (o.ms.vendor_ship) o.qty_shipped = q;
      if (o.ms.received_camco) o.qty_received = q;
      if (o.ms.to_stock) o.qty_stocked = q;
      const hold = /(\d[\d,]*)\s*PCS?\b.*HOLD/i.exec(note); if (hold) { o.qty_hold = Number(hold[1].replace(/,/g, '')); o.qty_stocked = 0; }
      if (o.ms.to_stock && o.ms.received_camco && !o.qty_hold) o.closed = /^completed$/i.test(note);
      o.last_update = today();
      rows.push(o);
    });
    return { rows };
  }
  $('sc-import').onclick = () => { $('sc-import-file').value = ''; $('sc-import-file').click(); };
  $('sc-import-file').addEventListener('change', async () => {
    const file = $('sc-import-file').files[0]; if (!file) return;
    const parsed = bpoRows(await file.text());
    if (parsed.error) { toast(parsed.error, true); return; }
    if (!parsed.rows.length) { toast('No PO rows found in that file.', true); return; }
    const body = el('div', {}, el('p', { text: parsed.rows.length + ' PO lines found in ' + file.name + '.' }), el('p', { class: 'muted', text: 'New POs are added; POs already tracked are updated from the file. Dates, quantities and the note come from the sheet; the update clock starts today.' }));
    if (!(await confirmDialog('Import BPO Tracking', body, 'Import ' + parsed.rows.length + ' lines'))) return;
    toast('Importing…');
    const r = await api('scImport', { rows: parsed.rows });
    if (!r.ok) { toast(r.error || 'Import failed.', true); return; }
    toast(r.added + ' added, ' + r.updated + ' updated' + (r.problemCount ? ', ' + r.problemCount + ' skipped (see the banner).' : '.'), !!r.problemCount);
    if (r.problemCount) banner('sc-banner', 'err', 'Skipped: ' + r.problems.join(' | '));
    loadSubcon();
  });

  // ---- lead times: what each stage really takes, and when a new PO should arrive
  function scLeadStats() {
    const rows = SC.data.leadStats.map((s) => el('tr', {}, el('td', { text: s.label }), el('td', { text: String(s.n) }), el('td', {}, s.avg == null ? '—' : el('b', { text: s.avg + ' d' })), el('td', { text: s.median == null ? '—' : s.median + ' d' }),
      el('td', { text: s.min == null ? '—' : s.min + '–' + s.max + ' d' }), el('td', { class: 'muted', text: s.skipped ? s.skipped + ' skipped (dates out of order)' : '' })));
    return el('div', {}, el('h3', { class: 'pad', text: 'Actual time per stage (from your tracked lines)' }), el('div', { class: 'tablewrap card' }, el('table', { class: 'datatable' },
      el('thead', {}, el('tr', {}, ['STAGE', 'LINES', 'AVERAGE', 'MEDIAN', 'FASTEST–SLOWEST', ''].map((t) => el('th', { text: t })))), el('tbody', {}, rows))),
      el('p', { class: 'muted small pad', text: 'Counts only lines that have both dates for that stage. Import or fill in the milestone dates and these numbers get more reliable.' }));
  }
  function scLeadCalc() {
    const st = SC.data.leadStats, chain = st.slice(0, 4), enough = chain.every((s) => s.n >= 3);
    const po = scInput('date', today()), need = scInput('date', ''), out = el('div', {});
    const run = () => {
      if (!enough) { out.replaceChildren(el('p', { class: 'muted', text: 'Not enough history yet: each of the first four stages needs at least 3 lines with both dates. Import the BPO sheet or keep milestone dates up to date.' })); return; }
      const sum = (k) => chain.reduce((t, s) => t + s[k], 0), avg = sum('avg'), best = sum('min'), worst = sum('max');
      const add = (iso, n) => { const t = parseDate(iso); if (!t) return ''; t.setDate(t.getDate() + n); return fmtD(t); };
      const rows = [['Best case', best], ['Typical (average)', avg], ['Worst case', worst]].map(([l, n]) => el('tr', {}, el('td', { text: l }), el('td', {}, el('b', { text: n + ' days' })), el('td', { text: po.value ? dshort(add(po.value, n)) : '—' })));
      const parts = [el('div', { class: 'tablewrap card' }, el('table', { class: 'datatable' }, el('thead', {}, el('tr', {}, ['SCENARIO', 'PO TO RECEIPT AT CAMCO', 'EXPECTED AT CAMCO'].map((t) => el('th', { text: t })))), el('tbody', {}, rows)))];
      if (need.value) parts.push(el('p', { class: 'calcnote', text: 'To have parts at CAMCO by ' + dshort(need.value) + ', the PO should reach the vendor by ' + dshort(add(need.value, -avg)) + ' (typical) or ' + dshort(add(need.value, -worst)) + ' to be safe (worst case seen).' }));
      out.replaceChildren(...parts);
    };
    [po, need].forEach((n) => { n.addEventListener('input', run); n.addEventListener('change', run); });
    run();
    return el('section', { class: 'card calc' }, el('h3', { text: 'When will a new PO arrive?' }), el('p', { class: 'muted', text: 'Uses the average, fastest and slowest time your past lines took from PO submitted to the vendor until received at CAMCO.' }),
      el('div', { class: 'calcform' }, scField('PO submitted to vendor', po, 'x1'), scField('Needed at CAMCO by (optional)', need, 'x2')), out);
  }
  $('sc-new').onclick = () => { if (!scCanWrite()) { toast('Viewers cannot add lines.', true); return; } scEditLine(null); };
  $('sc-back').onclick = () => goHome();
  $('nav-dash').onclick = openDash;
  $('dash2-copy').onclick = async () => { if (!state.dashAll) return; try { await navigator.clipboard.writeText(reportText()); toast('Report copied.'); } catch (e) { toast('Could not copy. Select the text from the page instead.', true); } };
  $('dash2-go-sc').onclick = () => openSubcon('subcon');
  $('dash2-new').onclick = openNewForm;
  $('dash2-find').addEventListener('submit', (e) => { e.preventDefault(); findSO($('dash2-find-input').value, $('dash2-status')); });
  $('nav-inhouse').onclick = async () => { if (!state.token || !state.role) return; if (!(await leaveGuard())) return; goHome(); };
  $('nav-subcon').onclick = () => openSubcon('subcon');
  $('nav-lead').onclick = () => openSubcon('leads');

  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('btn-home').onclick = (e) => { e.preventDefault(); openDash(); };
  $('home-new').onclick = openNewForm;
  $('admin-new').onclick = openNewForm;
  $('admin-users').onclick = openUsers;
  $('users-back').onclick = () => goHome();
  $('home-find').addEventListener('submit', (e) => { e.preventDefault(); findSO($('home-find-input').value, $('home-msg')); });
  $('admin-find').addEventListener('submit', (e) => { e.preventDefault(); findSO($('admin-find-input').value, $('list-status')); });
  $('new-back').onclick = () => goHome();
  $('new-submit').onclick = submitNew;
  $('q').addEventListener('input', () => { clearTimeout(applyView.t); applyView.t = setTimeout(applyView, 150); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; applyView(); });
  $('incl-closed').addEventListener('change', () => loadDashboard());
  $('pg-prev').onclick = () => { state.page--; renderTable(); };
  $('pg-next').onclick = () => { state.page++; renderTable(); };
  $('pg-size').onchange = (e) => { state.pageSize = +e.target.value; state.page = 0; renderTable(); };
  $('btn-refresh').onclick = async () => {
    if (!$('view-admin').hidden) return loadDashboard(true);
    if (!$('view-dash').hidden) return loadDash(true);
    if (!$('view-detail').hidden && state.current) {
      if (!(await leaveGuard())) return;
      const r = await api('get', { id: state.current.id });
      if (r.ok) { openRecord(r.record); toast('Reloaded from the sheet.'); } else toast(r.error || 'Could not reload.', true);
    }
  };
  $('btn-back').onclick = async () => { if (!(await leaveGuard())) return; goHome(); };
  $('btn-save').onclick = save;
  $('btn-discard').onclick = discard;
  $('btn-print').onclick = printSheet;
  $('btn-delete').onclick = () => { const r = state.current; if (r) deleteSO(r.id, norm(r.values.so_no) || norm(r.values.part_no)); };
  $('btn-signout').onclick = signOut;
  $('btn-pw').onclick = async () => {
    const mk = (ph, ac) => el('input', { type: 'password', placeholder: ph, autocomplete: ac, 'aria-label': ph });
    const cur = mk('Current password', 'current-password'), n1 = mk('New password (min 8)', 'new-password'), n2 = mk('Repeat new password', 'new-password');
    const body = el('div', { class: 'pwform' }, cur, n1, n2);
    if (!(await confirmDialog('Change my password', body, 'Change password'))) return;
    if (n1.value !== n2.value) { toast('The two new passwords do not match.', true); return; }
    const r = await api('changePassword', { current: cur.value, next: n1.value });
    if (!r.ok) { toast(r.error || 'Could not change the password.', true); return; }
    toast('Password changed.');
  };

  (async function init() {
    show('view-loading');
    const t = store('tok');
    if (t) { state.token = t; await start(); } else await showLogin('');
  })();
})();
