/* RYD-SO Tracker frontend. No build step. All access control is enforced by the backend. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const state = {
    token: null, email: '', role: null, fields: [], byKey: {}, records: [], writable: false,
    refreshedAt: null, view: [], sortKey: 'so_no', sortDir: 'desc', page: 0, pageSize: 50,
    visibleCols: null, stock: null, current: null, dirty: false, saving: false
  };
  const LOOKUP_KEYS = ['steel_type', 'router_bar_size', 'qty_per_bar'];
  const BAR_KEYS = ['so_release_status_bar', 'mat_status_bar'];
  const DEFAULT_COLS = ['status', 'so_release_status_bar', 'mat_status_bar', 'part_price', 'steel_type', 'router_bar_size', 'qty_per_bar', 'so_no', 'part_no', 'customer', 'champion', 'so_qty', 'due_date', 'so_type', 'kanban_or_po', 'req_mat_quote', 'quote_received', 'so_close_date'];
  const SECTIONS = [
    ['Order', 'notes', 'so_no'],
    ['Material requirement', 'steel_type', 'email_template'],
    ['Material quote', 'qty_requested', 'update_mat_cost_date'],
    ['SO request, approvals & PO', 'kanban_or_po', 'po_approve_date'],
    ['Release & prints', 'print_traveller', 'update_date'],
    ['Receiving & invoice', 'po_no_2', 'note'],
    ['Close', 'so_close_date', 'so_close_date']
  ];

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
  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function show(id) { ['view-login', 'view-list', 'view-detail'].forEach((v) => { $(v).hidden = v !== id; }); }
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
  // Progress bar: 100% = solid green; below that the colour progresses red -> orange -> yellow -> green.
  function pctOf(text) { const n = parseFloat(String(text).replace('%', '')); return isNaN(n) || !/%/.test(String(text)) ? null : Math.max(0, Math.min(100, n)); }
  function barNode(text) {
    const p = pctOf(text);
    if (p === null) return el('span', { text: norm(text) });
    const color = p >= 100 ? 'hsl(135 65% 38%)' : 'hsl(' + Math.round(p * 1.1) + ' 80% 45%)';
    return el('div', { class: 'bar' + (p >= 100 ? ' bar-done' : ''), title: text, role: 'progressbar', 'aria-valuenow': String(p), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      el('i', { style: 'width:' + p + '%;background:' + color }), el('span', { text: p % 1 ? p.toFixed(1) + '%' : p + '%' }));
  }
  // ---- stockroom price check indicators ----
  const money = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toFixed(2));
  function priceBadge(rec) {
    const c = rec.priceCheck; if (!c || c.state === 'none') return '';
    if (c.state === 'ok') return el('span', { class: 'chk', title: 'Price matches stockroom sheet (' + money(c.appPrice) + ')', text: '✓' });
    return el('button', { class: 'issue', type: 'button', title: c.reason + ' — click for details', text: '!', onclick: (e) => { e.stopPropagation(); showPriceDialog(rec); } });
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
    return el('button', { class: 'issue', type: 'button', title: c.reason, text: '!', onclick: (e) => {
      e.stopPropagation();
      $('dp-title').textContent = 'Missing data · part ' + norm(rec.values.part_no);
      $('dp-body').replaceChildren(el('p', { text: c.reason + '.' }), el('p', { class: 'muted', text: 'An admin can fix this by uploading STEEL USAGE data that includes this part number.' }));
      $('dlg-price').showModal();
    } });
  }
  function showStockStatus() {
    const st = state.stock, box = $('stock-status');
    if (!st || !st.has) { box.textContent = state.role === 'admin' ? 'No stockroom price sheet uploaded yet. Use "Upload stockroom sheet" to enable price checks.' : 'Stockroom price check is not active yet (no sheet uploaded).'; return; }
    const m = st.meta || {};
    box.textContent = 'Stockroom prices: ' + st.count + ' parts' + (m.uploadedAt ? ', uploaded ' + new Date(m.uploadedAt).toLocaleString() : '') + (m.uploadedBy ? ' by ' + m.uploadedBy : '') + (m.fileName ? ' (' + m.fileName + ')' : '') + '. ✓ = matches, ! = issue.';
  }

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const norm = (v) => (v === null || v === undefined ? '' : String(v));

  // ---------- API
  async function api(action, body) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 45000);
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
  async function onSignedIn(token) {
    state.token = token; store('tok', token); $('login-msg').textContent = '';
    await loadList();
  }
  function signOut() {
    state.token = null; store('tok', null); state.records = [];
    if (gisReady) google.accounts.id.disableAutoSelect();
    $('user').textContent = ''; $('btn-signout').hidden = true;
    showLogin('');
  }
  async function showLogin(msg) {
    show('view-login'); $('login-msg').textContent = msg || '';
    try { await renderSignIn($('g-signin'), onSignedIn); } catch (e) { $('login-msg').textContent = e.message; }
  }

  // ---------- list
  async function loadList() {
    const ls = $('list-status'); ls.className = 'statusline'; ls.textContent = 'Loading records from the sheet…';
    show('view-list'); $('btn-refresh').disabled = true;
    const r = await api('list');
    $('btn-refresh').disabled = false;
    if (!r.ok) {
      if (r.code === 'UNAUTHENTICATED') return showLogin(r.error);
      if (r.code === 'FORBIDDEN') { signOut(); return showLogin(r.error); }
      ls.className = 'statusline err'; ls.textContent = r.error + ' (data unavailable)'; return;
    }
    Object.assign(state, { email: r.email, role: r.role, fields: r.fields, records: r.records, writable: r.writable, refreshedAt: r.refreshedAt, stock: r.stock });
    $('btn-upload').hidden = r.role !== 'admin'; $('btn-upload-steel').hidden = r.role !== 'admin'; showStockStatus();
    state.byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
    if (!state.visibleCols) state.visibleCols = DEFAULT_COLS.slice();
    $('user').textContent = state.email + ' · ' + state.role; $('btn-signout').hidden = false;
    $('refreshed').textContent = 'Last refreshed ' + new Date(state.refreshedAt).toLocaleTimeString();
    buildFilters(); buildColPicker(); applyView();
    if (!state.writable) toast('The sheet has no RECORD ID column yet, so editing is disabled. See docs/setup.', true);
  }
  function fillSelect(id, key, placeholder) {
    const sel = $(id); const keep = sel.value;
    const vals = [...new Set(state.records.map((r) => norm(r.values[key]).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    sel.replaceChildren(el('option', { value: '', text: placeholder }), ...vals.map((v) => el('option', { value: v, text: v })));
    sel.value = vals.includes(keep) ? keep : '';
  }
  function buildFilters() {
    fillSelect('f-status', 'status', 'All statuses'); fillSelect('f-customer', 'customer', 'All customers');
    fillSelect('f-champion', 'champion', 'All champions'); fillSelect('f-sotype', 'so_type', 'All SO types'); fillSelect('f-kanban', 'kanban_or_po', 'Kanban/PO');
  }
  function buildColPicker() {
    const box = $('colpicker-list');
    box.replaceChildren(...state.fields.map((f) => el('label', {},
      el('input', { type: 'checkbox', checked: state.visibleCols.includes(f.key), onchange: (e) => {
        state.visibleCols = state.fields.map((x) => x.key).filter((k) => (k === f.key ? e.target.checked : state.visibleCols.includes(k)));
        renderTable();
      } }), ' ' + f.label + ' (' + f.col + ')')));
  }
  const SEARCH_KEYS = ['so_no', 'part_no', 'po_no_1', 'po_no_2', 'invoice_no', 'customer', 'notes', 'note', 'steel_type', 'material_code', 'champion'];
  function applyView() {
    const q = $('q').value.trim().toLowerCase();
    const pf = $('f-price').value, sf = $('f-steel').value;
    const fl = { status: $('f-status').value, customer: $('f-customer').value, champion: $('f-champion').value, so_type: $('f-sotype').value, kanban_or_po: $('f-kanban').value };
    state.view = state.records.filter((r) => {
      for (const [k, v] of Object.entries(fl)) if (v && norm(r.values[k]).trim() !== v) return false;
      if (pf && (!r.priceCheck || r.priceCheck.state !== pf)) return false;
      if (sf) { const bad = r.lookupChecks && Object.values(r.lookupChecks).some((c) => c.state === 'issue'); if (sf === 'issue' ? !bad : (bad || !r.lookupChecks)) return false; }
      if (!q) return true;
      return SEARCH_KEYS.some((k) => norm(r.values[k]).toLowerCase().includes(q) || norm(r.display[k]).toLowerCase().includes(q));
    });
    sortView(); state.page = 0; renderTable();
  }
  function sortVal(r, f) {
    const v = r.values[f.key];
    if (BAR_KEYS.includes(f.key)) return pctOf(r.display[f.key]);
    if (f.type === 'date') return isIso(norm(v)) ? norm(v) : '';
    if (f.type === 'number' || f.type === 'currency') { const n = parseFloat(String(r.display[f.key]).replace(/[$,]/g, '')); return isNaN(n) ? null : n; }
    return norm(v).toLowerCase();
  }
  function sortView() {
    const f = state.byKey[state.sortKey]; if (!f) return; const dir = state.sortDir === 'asc' ? 1 : -1;
    state.view.sort((a, b) => {
      const x = sortVal(a, f), y = sortVal(b, f);
      if (x === '' || x === null) return (y === '' || y === null) ? 0 : 1;   // blanks last
      if (y === '' || y === null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }
  function renderTable() {
    const cols = state.fields.filter((f) => state.visibleCols.includes(f.key));
    $('grid').tHead.replaceChildren(el('tr', {}, cols.map((f) => el('th', {
      class: state.sortKey === f.key ? 'sorted ' + (state.sortDir === 'desc' ? 'desc' : '') : '', title: 'Sort by ' + f.label + ' (column ' + f.col + ')', text: f.label,
      onclick: () => { state.sortDir = state.sortKey === f.key && state.sortDir === 'asc' ? 'desc' : 'asc'; state.sortKey = f.key; sortView(); state.page = 0; renderTable(); }
    }))));
    const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = state.view.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
    const body = $('grid').tBodies[0];
    if (!slice.length) body.replaceChildren(el('tr', {}, el('td', { colspan: cols.length || 1, text: state.records.length ? 'No records match your search or filters.' : 'No records found in the sheet.' })));
    else body.replaceChildren(...slice.map((r) => el('tr', { tabindex: 0, onclick: () => openRecord(r.id || ('row-' + r.row)), onkeydown: (e) => { if (e.key === 'Enter') openRecord(r.id || ('row-' + r.row)); } },
      cols.map((f) => {
        const text = norm(r.display[f.key]);
        if (BAR_KEYS.includes(f.key)) return el('td', {}, barNode(text));
        if (f.key === 'part_no' || f.key === 'part_price') return el('td', { title: text }, text, priceBadge(r));
        if (LOOKUP_KEYS.includes(f.key)) return el('td', { title: text }, text, lookupBadge(r, f.key));
        if (f.key === 'status') return el('td', {}, text ? el('span', { class: 'pill ' + (/OPEN/.test(text) ? 's-open' : /HOLD/.test(text) ? 's-hold' : /CLOSE/.test(text) ? 's-close' : ''), text }) : '');
        return el('td', { title: text, text });
      }))));
    $('pg-info').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
    $('pg-prev').disabled = state.page === 0; $('pg-next').disabled = state.page >= pages - 1;
    const ls = $('list-status'); ls.className = 'statusline';
    ls.textContent = state.view.length + ' of ' + state.records.length + ' records';
  }

  // ---------- detail
  function findRecord(id) { return state.records.find((r) => (r.id || 'row-' + r.row) === id); }
  function openRecord(id) {
    const rec = findRecord(id); if (!rec) return;
    state.current = rec; state.dirty = false; renderDetail(); show('view-detail');
    banner('', ''); updateDirty();
  }
  function banner(kind, msg, node) { const b = $('detail-banner'); b.className = kind; b.replaceChildren(node || msg || ''); }
  function canEdit() { return state.role !== 'viewer' && state.writable && state.current && state.current.id; }
  function renderDetail() {
    const rec = state.current;
    $('detail-title').textContent = 'SO# ' + (norm(rec.values.so_no) || '(none)') + ' · Part ' + (norm(rec.values.part_no) || '(none)') + ' · row ' + rec.row;
    const form = $('detail-form'); form.replaceChildren();
    const order = state.fields.map((f) => f.key);
    SECTIONS.forEach(([title, from, to]) => {
      const keys = order.slice(order.indexOf(from), order.indexOf(to) + 1);
      form.append(el('fieldset', {}, el('legend', { text: title }), el('div', { class: 'grid' }, keys.map((k) => fieldNode(state.byKey[k], rec)))));
    });
    if (!canEdit()) banner('warn', state.role === 'viewer' ? 'You have read-only access.' : 'Editing is disabled until RECORD IDs are set up in the sheet.');
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
    if (f.type === 'longtext' || f.key === 'email_template') { /* wide below */ }
    const wrap = el('div', { class: 'field' + (editable ? '' : ' ro') + (f.type === 'longtext' ? ' wide' : '') },
      el('label', { for: id }, f.label, f.required ? el('span', { class: 'req', title: 'Required', text: ' *' }) : '', el('span', { class: 'col', text: '(' + f.col + ')' }),
        !f.editable ? el('span', { class: 'tag', text: 'calculated' }) : locked ? el('span', { class: 'tag', text: 'formula' }) : ''),
      input);
    if (f.key === 'part_price' && rec.priceCheck && rec.priceCheck.state !== 'none') {
      const c = rec.priceCheck;
      wrap.append(el('div', { class: 'pricehint ' + (c.state === 'ok' ? 'ok' : 'bad'), text: c.state === 'ok' ? '✓ Matches stockroom sheet (' + money(c.stockPrices[0]) + ')' : '! ' + c.reason + ' — stockroom: ' + (c.stockPrices.length ? c.stockPrices.map(money).join(', ') : 'not listed') }));
    }
    if (LOOKUP_KEYS.includes(f.key) && rec.lookupChecks && rec.lookupChecks[f.key]) {
      const c = rec.lookupChecks[f.key];
      wrap.append(el('div', { class: 'pricehint ' + (c.state === 'ok' ? 'ok' : 'bad'), text: c.state === 'ok' ? '✓ Found in STEEL USAGE' : '! ' + c.reason }));
    }
    if (BAR_KEYS.includes(f.key)) { input.hidden = true; wrap.append(barNode(norm(rec.display[f.key]))); }
    if (input.dataset.legacy) wrap.append(el('div', { class: 'hint', text: 'Existing value "' + input.dataset.legacy + '" is kept unless you pick a date.' }));
    if (f.note) wrap.append(el('div', { class: 'hint', text: f.note }));
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
    const wrap = e.target.closest('.field'); const k = e.target.dataset.key;
    wrap.classList.toggle('changed', e.target.value !== e.target.dataset.orig && !(e.target.dataset.legacy && e.target.value === ''));
    wrap.classList.remove('invalid'); wrap.querySelector('.ferr')?.remove();
    updateDirty();
  }
  function updateDirty() {
    const n = Object.keys(collectChanges()).length; state.dirty = n > 0;
    $('dirty-flag').hidden = !state.dirty; $('btn-save').disabled = !state.dirty || state.saving; $('btn-discard').disabled = !state.dirty || state.saving;
    $('btn-save').textContent = state.saving ? 'Saving…' : 'Save changes' + (n ? ' (' + n + ')' : '');
  }
  async function backToList() {
    if (state.dirty && !(await confirmDialog('Discard unsaved changes?', el('p', { text: 'You have unsaved changes on this record. If you leave they will be lost.' }), 'Discard and leave', true))) return;
    state.dirty = false; show('view-list');
  }
  function showFieldErrors(errs) {
    Object.entries(errs || {}).forEach(([k, m]) => {
      const i = $('fld-' + k); if (!i) return; const w = i.closest('.field'); w.classList.add('invalid'); w.querySelector('.ferr')?.remove(); w.append(el('div', { class: 'ferr', text: m }));
    });
    document.querySelector('.field.invalid')?.scrollIntoView({ block: 'center' });
  }
  async function save() {
    if (state.saving) return;
    const changes = collectChanges(); if (!Object.keys(changes).length) return;
    const rec = state.current;
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Field' }), el('th', { text: 'Was' }), el('th', { text: 'Now' }))),
      el('tbody', {}, Object.entries(changes).map(([k, v]) => el('tr', {}, el('td', { text: state.byKey[k].label }), el('td', { text: norm(rec.values[k]) || '—' }), el('td', { text: v || '(cleared)' })))));
    if (!(await confirmDialog('Save changes to the sheet?', table, 'Save'))) return;
    state.saving = true; updateDirty(); banner('', '');
    const r = await api('update', { id: rec.id, baseVersion: rec.version, changes });
    state.saving = false;
    if (r.ok) {
      const i = state.records.findIndex((x) => x.id === rec.id); state.records[i] = r.record; state.current = r.record; state.refreshedAt = r.refreshedAt;
      $('refreshed').textContent = 'Last refreshed ' + new Date(r.refreshedAt).toLocaleTimeString();
      renderDetail(); updateDirty(); applyView(); show('view-detail'); banner('ok', 'Saved ' + r.changed.length + ' field(s) to the sheet.'); toast('Saved to the sheet.');
      return;
    }
    updateDirty();
    if (r.code === 'INVALID') { banner('err', 'Some values are invalid. Nothing was saved.'); showFieldErrors(r.fieldErrors); }
    else if (r.code === 'CONFLICT') conflict(r);
    else if (r.code === 'UNAUTHENTICATED') reauth(r.error);
    else if (r.code === 'BUSY') banner('warn', r.error + ' Your edits are still here.');
    else banner('err', r.error + ' Your edits have NOT been saved and are still in the form.');
  }
  function conflict(r) {
    const cur = r.current; const mine = collectChanges();
    const theirs = state.fields.filter((f) => f.editable && norm(cur.values[f.key]) !== norm(state.current.values[f.key])).map((f) => f.label);
    const node = el('div', {}, 'Someone else changed this record after you opened it (' + (theirs.join(', ') || 'unknown fields') + '). Your changes were not saved. ',
      el('button', { class: 'btn', type: 'button', text: 'Load latest and re-apply my edits', onclick: () => {
        const i = state.records.findIndex((x) => x.id === cur.id); state.records[i] = cur; state.current = cur; renderDetail();
        Object.entries(mine).forEach(([k, v]) => { const inp = $('fld-' + k); if (inp && !inp.disabled) { inp.value = v; inp.dispatchEvent(new Event('input')); } });
        banner('warn', 'Latest version loaded. Review your edits, then save again.');
      } }));
    banner('err', '', node);
  }
  function reauth(msg) {
    const holder = el('span', {}); banner('err', '', el('div', {}, (msg || 'Session expired.') + ' Your edits are still here. Sign in again, then save: ', holder));
    renderSignIn(holder, (t) => { state.token = t; store('tok', t); banner('ok', 'Signed in again. Click Save to continue.'); });
  }
  async function discard() {
    if (await confirmDialog('Discard changes?', el('p', { text: 'Reset this record to the last saved values?' }), 'Discard', true)) { renderDetail(); updateDirty(); banner('', ''); }
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
  $('q').addEventListener('input', () => { clearTimeout(applyView.t); applyView.t = setTimeout(applyView, 150); });
  ['f-status', 'f-customer', 'f-champion', 'f-sotype', 'f-kanban', 'f-price', 'f-steel'].forEach((id) => $(id).addEventListener('change', applyView));
  $('btn-clear').onclick = () => { $('q').value = ''; ['f-status', 'f-customer', 'f-champion', 'f-sotype', 'f-kanban', 'f-price', 'f-steel'].forEach((id) => { $(id).value = ''; }); applyView(); };
  $('btn-refresh').onclick = async () => {
    if (!$('view-detail').hidden && state.dirty && !(await confirmDialog('Refresh and lose edits?', el('p', { text: 'You have unsaved changes on the open record.' }), 'Refresh anyway', true))) return;
    state.dirty = false; await loadList();
  };
  $('pg-prev').onclick = () => { state.page--; renderTable(); }; $('pg-next').onclick = () => { state.page++; renderTable(); };
  $('pg-size').onchange = (e) => { state.pageSize = +e.target.value; state.page = 0; renderTable(); };
  $('btn-back').onclick = backToList; $('btn-save').onclick = save; $('btn-discard').onclick = discard; $('btn-signout').onclick = signOut;

  (async function init() {
    const t = store('tok');
    if (t) { state.token = t; await loadList(); } else await showLogin('');
  })();
})();
