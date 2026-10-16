/* RYD-SO Tracker frontend. No build step. All access control is enforced by the backend. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null, email: '', role: null, fields: [], byKey: {}, intake: null,
    dash: null, view: [], page: 0, pageSize: 50, current: null, dirty: false, saving: false, scans: []
  };
  const LOOKUP_KEYS = ['steel_type', 'router_bar_size', 'qty_per_bar'];
  const BAR_KEYS = ['so_release_status_bar', 'mat_status_bar'];
  const SECTIONS = [
    ['Order', 'notes', 'so_no'],
    ['Material requirement', 'steel_type', 'email_template'],
    ['Material quote', 'qty_requested', 'update_mat_cost_date'],
    ['SO request, approvals & PO', 'kanban_or_po', 'po_approve_date'],
    ['Release & prints', 'print_traveller', 'update_date'],
    ['Receiving & invoice', 'po_no_2', 'note'],
    ['Close', 'so_close_date', 'so_close_date']
  ];
  const VIEWS = ['view-loading', 'view-login', 'view-home', 'view-admin', 'view-new', 'view-detail'];

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
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? norm(iso) : d.toLocaleString(); };
  const daysAgo = (iso) => { const d = new Date(iso); return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 86400000); };
  const money = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toFixed(2));
  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function show(id) { VIEWS.forEach((v) => { $(v).hidden = v !== id; }); }
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

  // ---- stockroom price / STEEL USAGE check indicators (shown on the SO page) ----
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
  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts) return resolve();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google sign-in.')); document.head.append(s);
    });
  }
  let gisReady = false;
  async function renderSignIn(container, onToken) {
    if (CFG.DEV_MODE) {
      container.replaceChildren(el('button', { class: 'btn btn-primary', text: 'Dev sign-in (editor)', onclick: () => onToken('tok-editor') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (viewer)', onclick: () => onToken('tok-viewer') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (stranger)', onclick: () => onToken('tok-stranger') }),
        ' ', el('button', { class: 'btn', text: 'Dev sign-in (admin)', onclick: () => onToken('tok-admin') }));
      return;
    }
    await loadGis();
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: (r) => onToken(r.credential), auto_select: false });
    gisReady = true;
    google.accounts.id.renderButton(container, { theme: 'outline', size: 'large' });
  }
  async function onSignedIn(token) { state.token = token; store('tok', token); $('login-msg').textContent = ''; await start(); }
  function signOut() {
    state.token = null; store('tok', null); state.dash = null; state.current = null; state.dirty = false;
    if (gisReady) google.accounts.id.disableAutoSelect();
    $('user').textContent = ''; $('btn-signout').hidden = true; $('btn-refresh').hidden = true; $('refreshed').textContent = '';
    showLogin('');
  }
  async function showLogin(msg) {
    show('view-login'); $('login-msg').textContent = msg || '';
    try { await renderSignIn($('g-signin'), onSignedIn); } catch (e) { $('login-msg').textContent = e.message; }
  }

  // ---------- start / home
  async function start() {
    show('view-loading');
    const r = await api('whoami');
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      if (r.code === 'FORBIDDEN') { signOut(); return showLogin(r.error); }
      return showLogin(r.error || 'Could not reach the server.');
    }
    Object.assign(state, { email: r.email, role: r.role, fields: r.fields, intake: r.intake });
    state.byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
    $('user').textContent = r.email + ' · ' + r.role; $('btn-signout').hidden = false;
    goHome();
  }
  function goHome() {
    state.dirty = false; state.current = null;
    if (state.role === 'admin') return loadDashboard();
    $('btn-refresh').hidden = true; $('refreshed').textContent = '';
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

  // ---------- admin dashboard
  async function loadDashboard() {
    show('view-admin'); $('btn-refresh').hidden = false;
    $('grid').tBodies[0].replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Loading from the sheet…' })));
    const ls = $('list-status'); ls.className = 'statusline'; ls.textContent = 'Loading from the sheet…';
    $('btn-refresh').disabled = true;
    const r = await api('dashboard', { includeClosed: $('incl-closed').checked });
    $('btn-refresh').disabled = false;
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      ls.className = 'statusline err'; ls.textContent = r.error + ' (data unavailable)'; return;
    }
    state.dash = r;
    $('refreshed').textContent = 'Last refreshed ' + new Date(r.refreshedAt).toLocaleTimeString();
    renderCards(r); applyView();
    if (!r.writable) toast('The sheet has no RECORD ID column yet, so editing is disabled.', true);
  }
  function freshness(when, sub, whenIso, subText, emptyText) {
    const w = $(when), s = $(sub), card = w.closest('.card');
    card.classList.remove('stale', 'never');
    if (!whenIso) { w.textContent = emptyText; s.textContent = ''; card.classList.add('never'); return; }
    const d = daysAgo(whenIso);
    w.textContent = fmtWhen(whenIso);
    s.textContent = (d === null ? '' : d === 0 ? 'today' : d + ' day' + (d === 1 ? '' : 's') + ' ago') + (subText ? ' · ' + subText : '');
    if (d !== null && d > 30) card.classList.add('stale');
  }
  function renderCards(r) {
    const sm = r.stock.meta || {};
    freshness('stock-when', 'stock-sub', r.stock.has ? sm.uploadedAt : null,
      r.stock.count + ' parts' + (sm.uploadedBy ? ' · by ' + sm.uploadedBy : '') + (sm.fileName ? ' · ' + sm.fileName : ''), 'Never uploaded');
    const st = r.steel.meta;
    freshness('steel-when', 'steel-sub', st ? st.at : null,
      st ? st.count + ' rows' + (st.by ? ' · by ' + st.by : '') + (st.fileName ? ' · ' + st.fileName : '') : '', 'Not updated through the app yet');
  }
  function applyView() {
    const q = $('q').value.trim().toLowerCase();
    state.view = (state.dash ? state.dash.rows : []).filter((r) => !q || [r.so_no, r.part_no, r.customer].some((v) => norm(v).toLowerCase().includes(q)));
    state.page = 0; renderTable();
  }
  function renderTable() {
    $('grid').tHead.replaceChildren(el('tr', {}, ['SO#', 'PART #', 'CUSTOMER', 'STATUS', 'SO RELEASE STATUS BAR', 'MATERIAL STATUS BAR'].map((h) => el('th', { text: h }))));
    const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = state.view.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
    const body = $('grid').tBodies[0];
    if (!slice.length) body.replaceChildren(el('tr', {}, el('td', { colspan: 6, text: state.dash && state.dash.rows.length ? 'No SOs match your filter.' : 'No open SOs.' })));
    else body.replaceChildren(...slice.map((r) => el('tr', { tabindex: 0, onclick: () => openById(r.id), onkeydown: (e) => { if (e.key === 'Enter') openById(r.id); } },
      el('td', { text: norm(r.so_no) }), el('td', { text: norm(r.part_no) }), el('td', { text: norm(r.customer) }),
      el('td', {}, r.status ? el('span', { class: 'pill ' + (/OPEN/.test(r.status) ? 's-open' : /HOLD/.test(r.status) ? 's-hold' : /CLOSE/.test(r.status) ? 's-close' : ''), text: r.status }) : ''),
      el('td', {}, barNode(r.soBar)), el('td', {}, barNode(r.matBar)))));
    $('pg-info').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
    $('pg-prev').disabled = state.page === 0; $('pg-next').disabled = state.page >= pages - 1;
    const ls = $('list-status'); ls.className = 'statusline';
    ls.textContent = state.view.length + ' of ' + (state.dash ? state.dash.rows.length : 0) + ' SOs · lowest progress first';
  }
  async function openById(id) {
    const r = await api('get', { id });
    if (!r.ok) { toast(r.error || 'Could not open the SO.', true); return; }
    openRecord(r.record);
  }
  const loadList = () => loadDashboard();

  // ---------- open a new SO
  function newField(key) {
    const f = state.byKey[key]; const req = state.intake.required.includes(key); const id = 'nf-' + key;
    let input;
    if (f.type === 'enum') input = el('select', { id }, ['', ...f.options].map((o) => el('option', { value: o, text: o === '' ? '— choose —' : o })));
    else if (f.type === 'date') input = el('input', { id, type: 'date', value: key === 'so_req_date' ? today() : '' });
    else if (f.type === 'longtext') input = el('textarea', { id });
    else input = el('input', { id, type: 'text', inputmode: f.type === 'number' ? 'decimal' : 'text' });
    input.dataset.key = key;
    input.addEventListener('input', () => { const w = input.closest('.field'); w.classList.remove('invalid'); w.querySelector('.ferr')?.remove(); });
    return el('div', { class: 'field' + (f.type === 'longtext' ? ' wide' : '') },
      el('label', { for: id }, f.label, req ? el('span', { class: 'req', title: 'Required', text: ' *' }) : el('span', { class: 'tag', text: 'optional' })), input);
  }
  function openNewForm() {
    state.dirty = false;
    $('new-form').replaceChildren(el('fieldset', {}, el('legend', { text: 'Order details' }), el('div', { class: 'grid' }, state.intake.keys.map(newField))));
    banner('new-banner', '', ''); show('view-new');
    $('nf-so_no').focus();
  }
  function collectNew() { const ch = {}; $('new-form').querySelectorAll('[data-key]').forEach((i) => { ch[i.dataset.key] = i.value.trim(); }); return ch; }
  function showFieldErrors(prefix, errs) {
    Object.entries(errs || {}).forEach(([k, m]) => {
      const i = $(prefix + k); if (!i) return; const w = i.closest('.field'); w.classList.add('invalid'); w.querySelector('.ferr')?.remove(); w.append(el('div', { class: 'ferr', text: m }));
    });
    document.querySelector('.field.invalid')?.scrollIntoView({ block: 'center' });
  }
  let creating = false;
  async function submitNew() {
    if (creating) return;
    const ch = collectNew(); const missing = {};
    state.intake.required.forEach((k) => { if (!ch[k]) missing[k] = state.byKey[k].label + ' is required.'; });
    if (Object.keys(missing).length) { banner('new-banner', 'err', 'Please fill in all required fields.'); showFieldErrors('nf-', missing); return; }
    const table = el('table', {}, el('tbody', {}, state.intake.keys.filter((k) => ch[k]).map((k) => el('tr', {}, el('td', { text: state.byKey[k].label }), el('td', { text: ch[k] })))));
    if (!(await confirmDialog('Open this SO?', table, 'Open SO'))) return;
    creating = true; $('new-submit').disabled = true; $('new-submit').textContent = 'Opening…'; banner('new-banner', '', '');
    const r = await api('createSO', { changes: ch });
    creating = false; $('new-submit').disabled = false; $('new-submit').textContent = 'Open SO';
    if (r.ok) { toast('SO ' + norm(r.record.values.so_no) + ' opened.'); openRecord(r.record, 'ok', 'SO opened and added to the sheet. Fill in the rest of the details if needed, then print and upload the scan.'); return; }
    if (r.code === 'UNAUTHENTICATED') { banner('new-banner', 'err', r.error + ' Your form is still here — sign in again, then click Open SO.'); const h = el('span'); $('new-banner').append(' ', h); renderSignIn(h, (t) => { state.token = t; store('tok', t); banner('new-banner', 'ok', 'Signed in again. Click Open SO to continue.'); }); return; }
    if (r.code === 'INVALID') { banner('new-banner', 'err', r.error); showFieldErrors('nf-', r.fieldErrors); return; }
    banner('new-banner', 'err', (r.error || 'Could not open the SO.') + ' Nothing was created; your answers are still in the form.');
  }

  // ---------- one SO (edit, print, scan)
  function openRecord(rec, kind, msg) {
    state.current = rec; state.dirty = false; state.scans = [];
    renderDetail(); show('view-detail'); banner('detail-banner', kind || '', msg || ''); updateDirty();
    renderScans(); loadScans();
  }
  function canEdit() { return state.role !== 'viewer' && state.current && state.current.id; }
  function renderDetail() {
    const rec = state.current;
    $('detail-title').replaceChildren('SO# ' + (norm(rec.values.so_no) || '(none)') + ' · Part ' + (norm(rec.values.part_no) || '(none)'), priceBadge(rec));
    const form = $('detail-form'); form.replaceChildren();
    const order = state.fields.map((f) => f.key);
    SECTIONS.forEach(([title, from, to]) => {
      const keys = order.slice(order.indexOf(from), order.indexOf(to) + 1);
      form.append(el('fieldset', {}, el('legend', { text: title }), el('div', { class: 'grid' }, keys.map((k) => fieldNode(state.byKey[k], rec)))));
    });
    $('scan-upload').hidden = state.role === 'viewer';
    if (!canEdit() && !$('detail-banner').textContent) banner('detail-banner', 'warn', state.role === 'viewer' ? 'You have read-only access.' : 'This SO has no RECORD ID yet, so it cannot be edited.');
  }
  function fieldNode(f, rec) {
    const locked = rec.formulaLocked.includes(f.key);
    const editable = f.editable && !locked && canEdit();
    const val = rec.values[f.key];
    const id = 'fld-' + f.key;
    let input;
    if (f.type === 'enum') {
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
    if (!editable) input.disabled = true;
    const wrap = el('div', { class: 'field' + (editable ? '' : ' ro') + (f.type === 'longtext' ? ' wide' : '') },
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
  function onEdit(e) {
    const wrap = e.target.closest('.field');
    wrap.classList.toggle('changed', e.target.value !== e.target.dataset.orig && !(e.target.dataset.legacy && e.target.value === ''));
    wrap.classList.remove('invalid'); wrap.querySelector('.ferr')?.remove();
    updateDirty();
  }
  function updateDirty() {
    const n = Object.keys(collectChanges()).length; state.dirty = n > 0;
    $('dirty-flag').hidden = !state.dirty; $('btn-save').disabled = !state.dirty || state.saving; $('btn-discard').disabled = !state.dirty || state.saving;
    $('btn-save').textContent = state.saving ? 'Saving…' : 'Save changes' + (n ? ' (' + n + ')' : '');
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
      state.current = r.record; renderDetail(); updateDirty(); banner('detail-banner', 'ok', 'Saved ' + r.changed.length + ' field(s) to the sheet.'); toast('Saved to the sheet.'); return;
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
        state.current = Object.assign({}, state.current, cur); renderDetail();
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
    if (await confirmDialog('Discard changes?', el('p', { text: 'Reset this record to the last saved values?' }), 'Discard', true)) { renderDetail(); updateDirty(); banner('detail-banner', '', ''); }
  }

  // ---------- scans
  function renderScans() {
    const box = $('scan-list'); const list = state.scans;
    if (!list.length) { box.className = 'muted'; box.textContent = 'No scan uploaded yet.'; return; }
    box.className = '';
    box.replaceChildren(...list.map((s) => el('div', { class: 'scanitem' }, el('span', { class: 'scanname', text: s.name }),
      el('span', { class: 'muted', text: ' · ' + norm(s.by) + (s.at ? ' · ' + fmtWhen(s.at) : '') }),
      el('button', { class: 'btn', type: 'button', text: 'Download', onclick: () => downloadScan(s) }))));
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
    const sections = SECTIONS.map(([title, from, to]) => {
      const rows = order.slice(order.indexOf(from), order.indexOf(to) + 1).map((k) => state.byKey[k])
        .filter((f) => norm(rec.display[f.key]).trim() !== '' && norm(rec.display[f.key]).trim() !== '-')
        .map((f) => el('tr', {}, el('th', { text: f.label }), el('td', { text: norm(rec.display[f.key]) })));
      return rows.length ? el('div', { class: 'ps-sec' }, el('h3', { text: title }), el('table', {}, el('tbody', {}, rows))) : null;
    }).filter(Boolean);
    const checks = [];
    if (rec.priceCheck && rec.priceCheck.state !== 'none') checks.push('Stockroom price: ' + (rec.priceCheck.state === 'ok' ? 'matches' : 'ISSUE — ' + rec.priceCheck.reason));
    if (rec.lookupChecks) checks.push('Steel usage data: ' + (Object.values(rec.lookupChecks).every((c) => c.state === 'ok') ? 'complete' : 'MISSING — ' + Object.entries(rec.lookupChecks).filter(([, c]) => c.state !== 'ok').map(([k]) => state.byKey[k].label).join(', ')));
    box.replaceChildren(
      el('h1', { text: 'RYD-SO — Sales order details' }),
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

  // ---------- admin: uploads (stockroom prices, STEEL USAGE data)
  const SHEETJS = { src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw' };
  const UP_MODES = {
    stock: {
      title: 'Upload stockroom price sheet', action: 'uploadStock',
      note: 'CSV or Excel (.xlsx). Prices in this file are compared with PART PRICE for each part number. Uploading replaces the previous stockroom prices for everyone.',
      cols: [['part', 'Part number column', /part|item|sku|p\/n|number/i], ['price', 'Price column', /price|cost|unit|amount/i]],
      build: (r, c) => { const part = String(r[c.part] ?? '').trim(); const price = priceNum(r[c.price]); return part && price !== null && price >= 0 ? { part, price } : null; },
      show: (x) => x.part + ' → ' + money(x.price)
    },
    steel: {
      title: 'Replace STEEL USAGE data', action: 'uploadSteelUsage', danger: true,
      note: 'CSV or Excel (.xlsx) with one row per part. This DELETES all existing data in the STEEL USAGE tab and replaces it with this file. RYD-SO, IR-SO and ITT-SO read steel type, router bar size and qty/bar from that tab. A copy of the old data is kept in the tab "STEEL USAGE (previous)".',
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
  $('btn-upload').onclick = () => openUpload('stock');
  $('btn-upload-steel').onclick = () => openUpload('steel');
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
      const body = el('div', {}, el('p', { text: 'This will delete ALL existing data in the STEEL USAGE tab and replace it with ' + n + ' rows from "' + up.file + '".' }),
        el('p', { text: 'The old data is copied to the tab "STEEL USAGE (previous)" first, so it can be restored. Every tab that looks up steel type, router bar size or qty/bar will change immediately.' }));
      if (!(await confirmDialog('Replace STEEL USAGE data?', body, 'Delete old data and replace', true))) return;
    }
    toast('Uploading ' + n + ' rows…');
    const r = await api(mode.action, { rows: up.rows, fileName: up.file });
    if (!r.ok) { toast(r.error || 'Upload failed.', true); return; }
    toast((up.mode === 'steel' ? 'STEEL USAGE replaced: ' : 'Stockroom prices uploaded: ') + r.count + ' rows' + (r.skipped ? ' (' + r.skipped + ' skipped)' : '') + '.');
    await loadList();
  });

  // ---------- wiring
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('btn-home').onclick = async (e) => { e.preventDefault(); if (!state.token || !state.role) return; if (!(await leaveGuard())) return; goHome(); };
  $('home-new').onclick = openNewForm;
  $('admin-new').onclick = openNewForm;
  $('home-find').addEventListener('submit', (e) => { e.preventDefault(); findSO($('home-find-input').value, $('home-msg')); });
  $('admin-find').addEventListener('submit', (e) => { e.preventDefault(); findSO($('admin-find-input').value, $('list-status')); });
  $('new-back').onclick = () => goHome();
  $('new-submit').onclick = submitNew;
  $('q').addEventListener('input', () => { clearTimeout(applyView.t); applyView.t = setTimeout(applyView, 150); });
  $('incl-closed').addEventListener('change', () => loadDashboard());
  $('pg-prev').onclick = () => { state.page--; renderTable(); };
  $('pg-next').onclick = () => { state.page++; renderTable(); };
  $('pg-size').onchange = (e) => { state.pageSize = +e.target.value; state.page = 0; renderTable(); };
  $('btn-refresh').onclick = async () => {
    if (!$('view-admin').hidden) return loadDashboard();
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
  $('btn-signout').onclick = signOut;

  (async function init() {
    const t = store('tok');
    show('view-loading');
    if (t) { state.token = t; await start(); } else await showLogin('');
  })();
})();
