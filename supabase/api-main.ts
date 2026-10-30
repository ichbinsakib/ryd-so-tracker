// ---------------------------------------------------------------------------
// Network layer (Deno / Supabase Edge Function). Appended after Core, Calc, Service and
// PgAdapter by scripts/build-edge.js. Flow per request:
//   1. verify the Google ID token, work out the caller's role
//   2. load only the rows/lookups the action needs
//   3. run SOService.handle() against a snapshot adapter (collects changes as `ops`)
//   4. save the ops to Postgres, return the result
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

const ALLOWED_ORIGINS = ['https://so.amanasystem.com', 'https://ichbinsakib.github.io', 'http://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173'];

function corsHeaders(origin: string | null) {
  const o = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'content-type, authorization, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
}
function reply(obj: unknown, origin: string | null, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}
function fail(code: string, error: string, extra?: Record<string, unknown>) { return Object.assign({ ok: false, code, error }, extra || {}); }

// ---- sign-in: email + password (set by an admin), then a random session token
const SESSION_HOURS = 12;
const MAX_FAILS = 8;           // wrong passwords allowed per email ...
const FAIL_WINDOW_MIN = 15;    // ... within this many minutes
const tokenCache = new Map<string, { email: string; exp: number }>();

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(idToken: unknown) {
  if (typeof idToken !== 'string' || !/^[0-9a-f]{64}$/.test(idToken)) return { ok: false, error: 'Please sign in.' };
  const now = Date.now();
  const hit = tokenCache.get(idToken);
  if (hit && hit.exp > now) return { ok: true, email: hit.email };
  const rows = must(await sb.from('sessions').select('email,expires_at').eq('token_hash', await sha256hex(idToken)).limit(1)) as any[];
  if (!rows.length || new Date(rows[0].expires_at).getTime() <= now) return { ok: false, error: 'Session expired. Please sign in again.' };
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(idToken, { email: rows[0].email, exp: now + 30_000 });
  return { ok: true, email: rows[0].email as string };
}

async function recentFailures(email: string) {
  const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60_000).toISOString();
  const r = await sb.from('login_attempts').select('*', { count: 'exact', head: true }).eq('email', email).eq('ok', false).gte('at', since);
  if (r.error) throw new Error(r.error.message);
  return r.count || 0;
}

async function login(req: any) {
  const email = String(req.email || '').trim().toLowerCase();
  const password = typeof req.password === 'string' ? req.password : '';
  if (!email || !password || password.length > 200 || email.length > 200) return fail('BAD_LOGIN', 'Enter your email and password.');
  if (await recentFailures(email) >= MAX_FAILS) return fail('LOCKED', 'Too many wrong attempts. Try again in ' + FAIL_WINDOW_MIN + ' minutes.');
  const chk = await sb.rpc('check_login', { p_email: email, p_password: password });
  const good = !chk.error && chk.data === true;
  await sb.from('login_attempts').insert({ email, ok: good });
  if (!good) return fail('BAD_LOGIN', 'Wrong email or password.');
  const { users, cfg } = await loadUsersAndConfig();
  if (!SOCore.roleFor(email, cfg.editors, cfg.viewers, cfg.admins, users)) return fail('FORBIDDEN', 'This account is not authorised for the application. Ask an admin.');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  const ins = await sb.from('sessions').insert({ token_hash: await sha256hex(token), email, expires_at: expires });
  if (ins.error) throw new Error(ins.error.message);
  // housekeeping: forget the failures of this person, expired sessions and old attempts
  await sb.from('login_attempts').delete().eq('email', email).eq('ok', false);
  await sb.from('sessions').delete().lt('expires_at', new Date().toISOString());
  await sb.from('login_attempts').delete().lt('at', new Date(Date.now() - 86400_000).toISOString());
  return { ok: true, token, email, expiresAt: expires };
}

async function logout(idToken: string) {
  tokenCache.delete(idToken);
  await sb.from('sessions').delete().eq('token_hash', await sha256hex(idToken));
  return { ok: true };
}

async function changePassword(email: string, req: any) {
  const current = typeof req.current === 'string' ? req.current : '';
  const next = typeof req.next === 'string' ? req.next : '';
  if (next.length < 8) return fail('INVALID', 'The new password must be at least 8 characters.');
  if (next.length > 128) return fail('INVALID', 'The new password is too long (limit 128 characters).');
  if (await recentFailures(email) >= MAX_FAILS) return fail('LOCKED', 'Too many wrong attempts. Try again in ' + FAIL_WINDOW_MIN + ' minutes.');
  const chk = await sb.rpc('check_login', { p_email: email, p_password: current });
  if (chk.error || chk.data !== true) { await sb.from('login_attempts').insert({ email, ok: false }); return fail('INVALID', 'The current password is wrong.'); }
  const set = await sb.rpc('set_user_password', { p_email: email, p_password: next });
  if (set.error) throw new Error(set.error.message);
  await sb.from('app_audit').insert({ user_email: email, field: 'PASSWORD CHANGED', new_value: email });
  return { ok: true };
}

// ---- helpers
function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return (r.data ?? ([] as unknown)) as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allOrderRows() {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await sb.from('shop_orders').select('row_no,id,data').order('row_no').range(from, from + 999)) as any[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
const toRow = (r: any) => ({ rowNumber: Number(r.row_no), id: r.id, data: r.data || {} });

async function chunkedIn(table: string, cols: string, keyCol: string, keys: string[]) {
  // chunks run in parallel (one round trip of latency instead of one per chunk)
  const jobs: Promise<any[]>[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const part = keys.slice(i, i + 100);
    jobs.push(sb.from(table).select(cols).in(keyCol, part).then((r: any) => must(r) as any[]));
  }
  return (await Promise.all(jobs)).flat();
}
async function metaValue(key: string) {
  const r = must(await sb.from('app_meta').select('value').eq('key', key).limit(1)) as any[];
  return r.length ? r[0].value : null;
}
async function countOf(table: string) {
  const r = await sb.from(table).select('*', { count: 'exact', head: true });
  if (r.error) throw new Error(r.error.message);
  return r.count || 0;
}

const ADMIN_ONLY_ROWS = new Set(['start', 'dashboard', 'list']);
const BY_ID = new Set(['get', 'update', 'deleteSO', 'uploadScan', 'listScans', 'downloadScan']);

async function prefetch(req: any, email: string, role: string | null, users: any[], cfg: any) {
  const opts: any = {
    email, config: cfg, users, rows: [], stock: { rows: [], count: 0, meta: null }, stockItems: {}, steel: {}, steelCount: 0, steelMeta: null,
    scans: [], scanBytes: {}, newId: () => crypto.randomUUID(), now: () => new Date().toISOString()
  };
  if (!role) return opts;
  const action = String(req.action || '');
  const wantsAll = ADMIN_ONLY_ROWS.has(action) && role === 'admin';
  let rows: any[] = [];
  if (wantsAll) rows = await allOrderRows();
  else if (action === 'mySOs') {
    const me = users.find((u: any) => u.email === email);
    const name = (me && me.name) || email.split('@')[0];
    const q = (v: string) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    rows = must(await sb.from('shop_orders').select('row_no,id,data').or('created_by.eq.' + q(email) + ',data->>champion.eq.' + q(name) + ',data->>req_by.eq.' + q(name)).order('row_no').limit(2000)) as any[];
  } else if (action === 'findSO') {
    const want = SOCore.normSo(req.so_no);
    if (want) rows = must(await sb.from('shop_orders').select('row_no,id,data').eq('so_key', want).order('row_no').limit(5)) as any[];
  } else if (BY_ID.has(action) && typeof req.id === 'string' && UUID.test(req.id)) {
    rows = must(await sb.from('shop_orders').select('row_no,id,data').eq('id', req.id).limit(1)) as any[];
  } else if (action === 'createSO' && req.changes && typeof req.changes === 'object') {
    const want = SOCore.normSo(req.changes.so_no);
    if (want) rows = must(await sb.from('shop_orders').select('row_no,id,data').eq('so_key', want).limit(1)) as any[];
  }
  opts.rows = rows.map(toRow);

  // lookups for the calculated columns and the price check (not needed for the dashboard: its bars do not use them)
  const needLookups = ['get', 'findSO', 'update', 'createSO', 'list', 'uploadScan'].includes(action);
  const dashLookups = ['start', 'dashboard', 'mySOs'].includes(action);   // steel + stock lookups feed the material numbers on the dashboard rows
  const tasks: Promise<unknown>[] = [];
  if (needLookups || dashLookups) {
    const parts = new Set<string>(), codes = new Set<string>();
    const add = (d: any) => {
      if (!d) return;
      const p = SOCore.normalizePart(d.part_no); if (p) parts.add(p);
      const m = SOCore.normalizePart(d.material_code); if (m) codes.add(m);
    };
    opts.rows.forEach((r: any) => add(r.data));
    if (req.changes && typeof req.changes === 'object') add(req.changes);
    const pk = [...parts], both = [...new Set([...parts, ...codes])];
    if (both.length) {
      tasks.push(chunkedIn('stock_items', 'part_key,quantity,unit_price', 'part_key', both).then((rs) => {
        rs.forEach((r) => { if (!opts.stockItems[r.part_key]) opts.stockItems[r.part_key] = { quantity: r.quantity === null ? null : Number(r.quantity), unitPrice: r.unit_price === null ? null : Number(r.unit_price) }; });
      }));
    }
    if (pk.length) {
      tasks.push(chunkedIn('steel_usage', 'part_key,steel_type,qty_per_bar,router_bar_size', 'part_key', pk).then((rs) => {
        rs.forEach((r) => { if (!opts.steel[r.part_key]) opts.steel[r.part_key] = { steelType: r.steel_type, qtyPerBar: r.qty_per_bar, routerBarSize: r.router_bar_size }; });
      }));
      if (needLookups) tasks.push(chunkedIn('stockroom_prices', 'part,price', 'part_key', pk).then((rs) => { opts.stock.rows = rs.map((r) => [r.part, Number(r.price)]); }));
    }
  }
  // stock / steel upload info (small): counts and meta
  if (needLookups || wantsAll || action === 'uploadStock' || action === 'uploadSteelUsage') {
    tasks.push(countOf('stockroom_prices').then((n) => { opts.stock.count = n; }));
    tasks.push(metaValue('stock_meta').then((m) => { opts.stock.meta = m; }));
  }
  if (wantsAll || action === 'uploadSteelUsage') {
    tasks.push(metaValue('steel_meta').then((m) => { opts.steelMeta = m; }));
    tasks.push(countOf('steel_usage').then((n) => { opts.steelCount = n; }));
  }
  if (['uploadScan', 'listScans', 'downloadScan'].includes(action) && opts.rows.length) {
    tasks.push(sb.from('so_scans').select('id,record_id,name,mime,path,by_user,at').eq('record_id', req.id).order('at').then((r) => {
      opts.scans = must(r as any).map((s: any) => ({ fileId: s.id, recordId: s.record_id, name: s.name, at: s.at, by: s.by_user, mime: s.mime, path: s.path }));
    }));
  }
  await Promise.all(tasks);
  if (action === 'downloadScan' && typeof req.fileId === 'string') {
    const s = opts.scans.find((x: any) => x.fileId === req.fileId);
    if (s) {
      const dl = await sb.storage.from('scans').download(s.path);
      if (dl.error) throw new Error(dl.error.message);
      const buf = new Uint8Array(await dl.data.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      opts.scanBytes[s.fileId] = { mime: s.mime, data: btoa(bin) };
    }
  }
  return opts;
}

async function flush(ops: any[]) {
  // merge consecutive patches to the same row into one write
  const patches = new Map<string, Record<string, unknown>>();
  for (const o of ops) if (o.type === 'update') patches.set(o.id, Object.assign(patches.get(o.id) || {}, o.patch));
  const doneUpdate = new Set<string>();
  const audits: any[] = [];
  for (const o of ops) {
    if (o.type === 'update') {
      if (doneUpdate.has(o.id)) continue;
      doneUpdate.add(o.id);
      const r = await sb.rpc('patch_order', { p_id: o.id, p_patch: patches.get(o.id) });
      if (r.error) throw new Error(r.error.message);
    } else if (o.type === 'insert') {
      const r = await sb.from('shop_orders').insert({ id: o.id, data: o.data, created_by: String(o.createdBy || '').toLowerCase() });
      if (r.error) { if (r.error.code === '23505') throw { duplicate: true }; throw new Error(r.error.message); }
    } else if (o.type === 'delete') {
      const r = await sb.from('shop_orders').delete().eq('id', o.id);
      if (r.error) throw new Error(r.error.message);
    } else if (o.type === 'audit') {
      audits.push({ at: o.entry.at, user_email: o.entry.user, record_id: String(o.entry.recordId || ''), row_no: o.entry.row, field: o.entry.field, old_value: o.entry.oldValue, new_value: o.entry.newValue });
    } else if (o.type === 'users') {
      const rows = o.list.map((u: any) => ({ email: String(u.email).toLowerCase(), name: u.name || '', employee_id: u.employeeId || '', role: u.role, active: !!u.active, added_by: u.addedBy || '', added_at: u.addedAt || '', updated_by: u.updatedBy || '', updated_at: u.updatedAt || '' }));
      if (rows.length) { const r = await sb.from('app_users').upsert(rows, { onConflict: 'email' }); if (r.error) throw new Error(r.error.message); }
      const existing = must(await sb.from('app_users').select('email')) as any[];
      const keep = new Set(rows.map((x: any) => x.email));
      const gone = existing.map((x) => x.email).filter((e) => !keep.has(e));
      if (gone.length) { const r = await sb.from('app_users').delete().in('email', gone); if (r.error) throw new Error(r.error.message); }
    } else if (o.type === 'stock') {
      const r = await sb.rpc('replace_stockroom_prices', { p_rows: o.rows });
      if (r.error) throw new Error(r.error.message);
      const m = await sb.from('app_meta').upsert({ key: 'stock_meta', value: o.meta }); if (m.error) throw new Error(m.error.message);
    } else if (o.type === 'setPassword') {
      const r = await sb.rpc('set_user_password', { p_email: o.email, p_password: o.password });
      if (r.error) throw new Error(r.error.message);
    } else if (o.type === 'stockItems') {
      const r = await sb.rpc('replace_stock_items', { p_rows: o.rows });
      if (r.error) throw new Error(r.error.message);
    } else if (o.type === 'steel') {
      const r = await sb.rpc('replace_steel_usage', { p_rows: o.rows });
      if (r.error) throw new Error(r.error.message);
    } else if (o.type === 'steelMeta') {
      const m = await sb.from('app_meta').upsert({ key: 'steel_meta', value: o.meta }); if (m.error) throw new Error(m.error.message);
    } else if (o.type === 'scan') {
      const s = o.scan;
      const bin = atob(o.data); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const path = s.recordId + '/' + s.fileId + '-' + s.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const up = await sb.storage.from('scans').upload(path, bytes, { contentType: s.mime, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const r = await sb.from('so_scans').insert({ id: s.fileId, record_id: s.recordId, so_no: String(s.soNo || ''), name: s.name, mime: s.mime, path, by_user: s.by, at: s.at });
      if (r.error) throw new Error(r.error.message);
    }
  }
  if (audits.length) { const r = await sb.from('app_audit').insert(audits); if (r.error) throw new Error(r.error.message); }
}

async function loadUsersAndConfig() {
  const [userRows, cfgMeta] = await Promise.all([
    sb.from('app_users').select('email,name,employee_id,role,active,has_password,added_by,added_at,updated_by,updated_at'),
    metaValue('config')
  ]);
  const users = must(userRows as any).map((u: any) => ({ email: u.email, name: u.name, employeeId: u.employee_id, role: u.role, active: u.active, hasPassword: !!u.has_password, addedBy: u.added_by, addedAt: u.added_at, updatedBy: u.updated_by, updatedAt: u.updated_at }));
  const cfg = { admins: Deno.env.get('ADMINS') || (cfgMeta && cfgMeta.admins) || '', editors: Deno.env.get('EDITORS') || (cfgMeta && cfgMeta.editors) || '', viewers: Deno.env.get('VIEWERS') || (cfgMeta && cfgMeta.viewers) || '' };
  return { users, cfg };
}


// ---- Subcontractor tracking (BPO lines, milestones, quantities, update log)
async function scAudit(email: string, recordId: string, field: string, newValue: string) {
  await sb.from('app_audit').insert({ user_email: email, record_id: recordId, field, new_value: newValue });
}
const scDup = (e: any) => e && /duplicate key|unique/i.test(e.message || '');
const scToday = () => new Date().toISOString().slice(0, 10);
// next free SUB-0001 style references for orders that arrive without one
async function nextRefs(count: number): Promise<string[]> {
  const rows = must(await sb.from('sc_lines').select('order_ref').like('order_ref', 'SUB-%') as any) as any[];
  let max = 0; rows.forEach((x: any) => { const mm = /^SUB-(\d+)$/i.exec(String(x.order_ref || '')); if (mm) max = Math.max(max, +mm[1]); });
  return Array.from({ length: count }, (_, i) => 'SUB-' + String(max + i + 1).padStart(4, '0'));
}
// a date that changes keeps its first value in `orig`; the change is described for the log
function dateChanges(prev: any, value: any) {
  const orig: any = { ...(prev.orig || {}) }, changed: string[] = [];
  const track = (key: string, label: string, a: any, b: any) => { if (a && a !== b) { if (!orig[key]) orig[key] = a; changed.push(label + ': ' + a + ' → ' + (b || 'cleared')); } };
  SOSub.MILESTONES.forEach((x: any) => track(x.key, x.label, (prev.ms || {})[x.key], (value.ms || {})[x.key]));
  SOSub.EXPECTED.forEach((x: any) => track(x.key, x.label, (prev.exp || {})[x.key], (value.exp || {})[x.key]));
  return { orig, changed };
}
const sameVal = (a: any, b: any) => { const x = a == null ? '' : a, y = b == null ? '' : b; if (typeof x === 'object' || typeof y === 'object') return JSON.stringify(x, Object.keys(x || {}).sort()) === JSON.stringify(y, Object.keys(y || {}).sort()); return String(x) === String(y) || (x !== '' && y !== '' && Number(x) === Number(y)); };
// SO lifecycle follow-up log (decisions, follow-ups, escalations, evidence references)
const LOG_KINDS = ['NOTE', 'FOLLOW-UP', 'ESCALATION', 'DECISION', 'EVIDENCE'];
async function logAction(req: any, email: string, role: string | null) {
  if (!role) return fail('FORBIDDEN', 'You are not allowed to use this app.');
  const id = String(req.id || '');
  if (!UUID.test(id)) return fail('BAD_REQUEST', 'Missing SO.');
  if (req.action === 'lgList') {
    const r = await sb.from('so_log').select('id,at,by_user,kind,text,ref').eq('record_id', id).order('at', { ascending: false }).limit(200);
    return { ok: true, log: must(r as any) };
  }
  if (req.action === 'lgAdd') {
    if (role !== 'editor' && role !== 'admin') return fail('FORBIDDEN', 'You have read-only access.');
    const kind = String(req.kind || 'NOTE'), text = String(req.text || '').trim(), ref = String(req.ref || '').trim();
    const errors: any = {};
    if (!LOG_KINDS.includes(kind)) errors.kind = 'Choose a type.';
    if (!text) errors.text = 'Write what happened.'; else if (text.length > 2000) errors.text = 'Keep it under 2000 characters.';
    if (ref.length > 500) errors.ref = 'Keep the reference under 500 characters.';
    if (Object.keys(errors).length) return fail('INVALID', 'Please fix the highlighted fields.', { fieldErrors: errors });
    const ins = await sb.from('so_log').insert({ record_id: id, by_user: email, kind, text, ref });
    if (ins.error) return fail('SERVER_ERROR', ins.error.message);
    return { ok: true };
  }
  return fail('BAD_REQUEST', 'Unknown action.');
}

async function subconAction(req: any, email: string, role: string | null) {
  if (!role) return fail('FORBIDDEN', 'You are not allowed to use this app.');
  const write = role === 'editor' || role === 'admin';
  const action = req.action as string;
  const today = SOSub.isDate(req.today) ? req.today : scToday();
  if (action === 'scList') {
    const r = await sb.from('sc_lines').select('*').order('bpo_no').order('batch').order('so_no');
    const rows = must(r as any) as any[];
    if (write) {   // orders that predate order refs get one, so an exported sheet can always update them
      const blank = rows.filter((x: any) => !String(x.order_ref || '').trim());
      if (blank.length) { const refs = await nextRefs(blank.length); for (let i = 0; i < blank.length; i++) { const u = await sb.from('sc_lines').update({ order_ref: refs[i] }).eq('id', blank[i].id); if (!u.error) blank[i].order_ref = refs[i]; } }
    }
    const built = SOSub.build(rows, today);
    return { ok: true, today, role, milestones: SOSub.MILESTONES, expected: SOSub.EXPECTED, stages: SOSub.STAGES, sectionDefs: SOSub.SECTIONS, decisions: SOSub.DECISIONS, reviewStatuses: SOSub.REVIEW_STATUSES, priorities: SOSub.PRIORITIES, blockers: SOSub.BLOCKERS, updateKinds: SOSub.UPDATE_KINDS, cfg: SOSub.CFG, ...built };
  }
  if (action === 'scUpdates') {
    const r = await sb.from('sc_updates').select('id,at,by_user,kind,text').eq('line_id', String(req.id)).order('at', { ascending: false }).limit(100);
    return { ok: true, updates: must(r as any) };
  }
  if (!write) return fail('FORBIDDEN', 'Viewers cannot change subcontractor data.');
  const bad = (errors: any) => fail('INVALID', 'Please fix the highlighted fields.', { fieldErrors: errors });
  const dupMsg = fail('INVALID', 'That PO # is already tracked.', { fieldErrors: { po_no: 'That PO # is already tracked.' } });
  const dupRef = fail('INVALID', 'That order ref is already used.', { fieldErrors: { order_ref: 'That order ref is already used.' } });
  const dupFail = (e: any) => (/ref_uq|order_ref/i.test(e.message || '') ? dupRef : dupMsg);
  if (action === 'scSaveLine') {
    const c = SOSub.cleanLine(req.line || {}); if (!c.ok) return bad(c.errors);
    let id = req.line.id as string | undefined;
    if (id) {
      // a date that changes keeps its first value in `orig` and the change is logged, so history is never overwritten
      const prevRows = must(await sb.from('sc_lines').select('ms,exp,orig').eq('id', id).limit(1) as any) as any[];
      const prev = prevRows[0] || {}, orig: any = { ...(prev.orig || {}) }, changed: string[] = [];
      const track = (key: string, label: string, a: any, b: any) => { if (a && a !== b) { if (!orig[key]) orig[key] = a; changed.push(label + ': ' + a + ' → ' + (b || 'cleared')); } };
      SOSub.MILESTONES.forEach((x: any) => track(x.key, x.label, (prev.ms || {})[x.key], (c.value.ms as any)[x.key]));
      SOSub.EXPECTED.forEach((x: any) => track(x.key, x.label, (prev.exp || {})[x.key], (c.value.exp as any)[x.key]));
      const upd: any = { ...c.value, orig, updated_at: new Date().toISOString() }; if (!upd.order_ref) delete upd.order_ref;   // a blank ref never wipes the existing one
      const r = await sb.from('sc_lines').update(upd).eq('id', id).select('id').single();
      if (r.error) return scDup(r.error) ? dupFail(r.error) : fail('SERVER_ERROR', r.error.message);
      if (changed.length) await sb.from('sc_updates').insert({ line_id: id, by_user: email, kind: 'CHANGE', text: changed.join('; ').slice(0, 1900) });
    } else {
      const ins: any = { ...c.value, created_by: email }; if (!ins.order_ref) ins.order_ref = (await nextRefs(1))[0];
      const r = await sb.from('sc_lines').insert(ins).select('id').single();
      if (r.error) return scDup(r.error) ? dupFail(r.error) : fail('SERVER_ERROR', r.error.message);
      id = (r.data as any).id;
    }
    await scAudit(email, id as string, req.line.id ? 'SUBCON LINE UPDATED' : 'SUBCON LINE ADDED', c.value.po_no + ' / SO ' + c.value.so_no);
    return { ok: true, id };
  }
  if (action === 'scDeleteLine') {
    const r = await sb.from('sc_lines').delete().eq('id', String(req.id)); if (r.error) return fail('SERVER_ERROR', r.error.message);
    await scAudit(email, String(req.id), 'SUBCON LINE DELETED', ''); return { ok: true };
  }
  if (action === 'scAddUpdate') {
    const c = SOSub.cleanUpdate(req); if (!c.ok) return bad(c.errors);
    const ins = await sb.from('sc_updates').insert({ line_id: String(req.id), by_user: email, kind: c.value.kind, text: c.value.text });
    if (ins.error) return fail('SERVER_ERROR', ins.error.message);
    const patch: any = { last_update: today, updated_at: new Date().toISOString() };
    if (c.value.kind === 'ESCALATION') patch.escalated = true;
    const u = await sb.from('sc_lines').update(patch).eq('id', String(req.id)); if (u.error) return fail('SERVER_ERROR', u.error.message);
    return { ok: true };
  }
  if (action === 'scBulk') {
    const b = req.bulk || {};
    const patchMs: any = {}, errors: any = {};
    for (const m of SOSub.MILESTONES) { const v = String((b.ms || {})[m.key] || '').trim(); if (!v) continue; if (!SOSub.isDate(v)) errors['ms_' + m.key] = 'Use a valid date.'; else patchMs[m.key] = v; }
    const blockerType = String(b.blocker_type || ''), blocker = String(b.blocker || '').trim().slice(0, 500), note = String(b.note || '').trim().slice(0, 2000);
    const revised = String(b.revised_date || '').trim();
    if (!SOSub.BLOCKERS.includes(blockerType)) errors.blocker_type = 'Unknown blocker type.';
    if (revised && !SOSub.isDate(revised)) errors.revised_date = 'Use a valid date.';
    if (Object.keys(errors).length) return bad(errors);
    if (!Object.keys(patchMs).length && !blocker && !b.clear_blocker && !note && !revised) return fail('INVALID', 'Nothing to apply: enter a date, note, blocker or revised date.');
    const sel = await sb.from('sc_lines').select('id,ms,po_no').eq('bpo_no', String(b.bpo_no || '')).eq('batch', String(b.batch || '')).eq('closed', false).limit(300);
    const rows = must(sel as any); if (!rows.length) return fail('NOT_FOUND', 'No open lines in that batch.');
    const summary: string[] = [];
    Object.keys(patchMs).forEach((k) => summary.push(SOSub.MILESTONES.find((m: any) => m.key === k).label + ' ' + patchMs[k]));
    if (revised) summary.push('revised date ' + revised);
    if (b.clear_blocker) summary.push('blocker cleared'); else if (blocker) summary.push('blocker: ' + blocker);
    const text = (summary.length ? summary.join('; ') + (note ? '. ' : '') : '') + note;
    for (const r of rows as any[]) {
      const ms = { ...(r.ms || {}) }; for (const k of Object.keys(patchMs)) { if (b.overwrite || !ms[k]) ms[k] = patchMs[k]; }
      const patch: any = { ms, last_update: today, updated_at: new Date().toISOString() };
      if (b.clear_blocker) { patch.blocker = ''; patch.blocker_type = ''; } else if (blocker) { patch.blocker = blocker; patch.blocker_type = blockerType; }
      if (revised) { patch.revised_date = revised; if (b.delay_reason) patch.delay_reason = String(b.delay_reason).trim().slice(0, 500); }
      if (note) patch.note = note;
      const u = await sb.from('sc_lines').update(patch).eq('id', r.id); if (u.error) return fail('SERVER_ERROR', u.error.message);
    }
    const ins = await sb.from('sc_updates').insert((rows as any[]).map((r) => ({ line_id: r.id, by_user: email, kind: 'CHANGE', text: 'Batch update: ' + text })));
    if (ins.error) return fail('SERVER_ERROR', ins.error.message);
    await scAudit(email, String(b.bpo_no) + ' ' + String(b.batch), 'SUBCON BATCH UPDATE', text.slice(0, 300));
    return { ok: true, count: rows.length };
  }
  if (action === 'scImport') {
    const list = Array.isArray(req.rows) ? req.rows.slice(0, 500) : [];
    if (!list.length) return fail('INVALID', 'The file has no rows to import.');
    const good: any[] = [], problems: string[] = [];
    list.forEach((row: any, i: number) => { const c = SOSub.cleanLine(row); if (c.ok && !c.value.po_no) { problems.push('Row ' + (i + 1) + ': PO # is required to import a line.'); return; } if (c.ok) good.push(c.value); else problems.push('Row ' + (i + 1) + ' (PO ' + (row && row.po_no || '?') + '): ' + Object.values(c.errors).join(' ')); });
    const keys = good.map((g) => g.po_no.toUpperCase());
    const ex = await sb.from('sc_lines').select('id,po_key').in('po_key', keys);
    const have = new Map(must(ex as any).map((r: any) => [r.po_key, r.id]));
    const seen = new Set<string>(); let added = 0, updated = 0;
    const fresh: any[] = [];
    for (const g of good) {
      const k = g.po_no.toUpperCase(); if (seen.has(k)) { problems.push('PO ' + g.po_no + ' appears twice in the file; the first row was used.'); continue; } seen.add(k);
      if (have.has(k)) { const { order_ref: _r, ...gu } = g; const u = await sb.from('sc_lines').update({ ...gu, updated_at: new Date().toISOString() }).eq('id', have.get(k)); if (u.error) return fail('SERVER_ERROR', u.error.message); updated++; }
      else fresh.push({ ...g, created_by: email });
    }
    if (fresh.length) { const refs = await nextRefs(fresh.length); fresh.forEach((f: any, i: number) => { f.order_ref = refs[i]; }); const ins = await sb.from('sc_lines').insert(fresh); if (ins.error) return fail('SERVER_ERROR', ins.error.message); added = fresh.length; }
    await scAudit(email, '', 'SUBCON IMPORT', added + ' added, ' + updated + ' updated');
    return { ok: true, added, updated, problems: problems.slice(0, 20), problemCount: problems.length };
  }
  if (action === 'scImportTemplate') {
    const list = Array.isArray(req.rows) ? req.rows.slice(0, 500) : [];
    if (!list.length) return fail('INVALID', 'The sheet has no rows to import.');
    const all = must(await sb.from('sc_lines').select('*') as any) as any[];
    const byRef = new Map<string, any>(), byPo = new Map<string, any>();
    all.forEach((l: any) => { if (l.order_ref) byRef.set(String(l.order_ref).toUpperCase(), l); if (l.po_key) byPo.set(l.po_key, l); });
    const problems: string[] = [], plan: any[] = [], seen = new Set<string>(); const preview: any[] = [];
    list.forEach((row: any, i: number) => {
      const label = 'Row ' + (row && row.__row ? row.__row : i + 2), inc: any = SOSub.fromTemplateRow(row || {});
      if (!inc.part_no && !inc.order_ref && !inc.po_no && !Object.keys(inc.ms).length) return;   // an empty line in the sheet
      const ref = String(inc.order_ref || '').trim().toUpperCase();
      const ex = ref ? byRef.get(ref) : (inc.po_no ? byPo.get(String(inc.po_no).trim().toUpperCase()) : undefined);
      const key = ex ? ex.id : (ref || 'new' + i);
      if (seen.has(key)) { problems.push(label + ': this order appears twice in the sheet; the first one was used.'); return; } seen.add(key);
      const c = SOSub.cleanLine(SOSub.mergeLine(ex || null, inc));
      if (!c.ok) { problems.push(label + ' (' + (ref || inc.part_no || '?') + '): ' + Object.values(c.errors).join(' ')); return; }
      if (!ex && !inc.part_no) { problems.push(label + ': Part # is required for a new order.'); return; }
      const diff = ex ? Object.keys(c.value).filter((k) => !sameVal(ex[k], (c.value as any)[k])) : ['new'];
      plan.push({ ex, value: c.value, diff, label });
      if (preview.length < 8) preview.push({ row: label, ref: ref || (ex ? ex.order_ref : ''), part: c.value.part_no, action: ex ? (diff.length ? 'update' : 'no change') : 'new' });
    });
    const adds = plan.filter((p) => !p.ex), upds = plan.filter((p) => p.ex && p.diff.length), same = plan.filter((p) => p.ex && !p.diff.length).length;
    if (req.dryRun === true) return { ok: true, dryRun: true, added: adds.length, updated: upds.length, unchanged: same, problems: problems.slice(0, 20), problemCount: problems.length, preview };
    if (problems.length && req.skipProblems !== true) return fail('INVALID', problems.length + ' row(s) have problems. Fix them or import the rest.', { problems: problems.slice(0, 20), problemCount: problems.length });
    const refs = await nextRefs(adds.filter((p) => !p.value.order_ref).length); let ri = 0;
    const fresh = adds.map((p) => ({ ...p.value, order_ref: p.value.order_ref || refs[ri++], created_by: email }));
    if (fresh.length) { const ins = await sb.from('sc_lines').insert(fresh); if (ins.error) return scDup(ins.error) ? fail('INVALID', 'A PO # or order ref in the sheet is already used by another order.') : fail('SERVER_ERROR', ins.error.message); }
    for (const p of upds) {
      const { orig, changed } = dateChanges(p.ex, p.value); const v: any = { ...p.value, orig, updated_at: new Date().toISOString() }; if (!v.order_ref) delete v.order_ref;
      const u = await sb.from('sc_lines').update(v).eq('id', p.ex.id); if (u.error) return scDup(u.error) ? fail('INVALID', p.label + ': that PO # or order ref is already used by another order.') : fail('SERVER_ERROR', u.error.message);
      await sb.from('sc_updates').insert({ line_id: p.ex.id, by_user: email, kind: 'CHANGE', text: ('Excel import' + (changed.length ? ': ' + changed.join('; ') : '')).slice(0, 1900) });
    }
    await scAudit(email, '', 'SUBCON EXCEL IMPORT', fresh.length + ' added, ' + upds.length + ' updated');
    return { ok: true, added: fresh.length, updated: upds.length, unchanged: same, problems: problems.slice(0, 20), problemCount: problems.length };
  }
  return fail('BAD_REQUEST', 'Unknown action.');
}

async function handleRequest(req: any) {
  if (req && req.action === 'login') return await login(req);
  const auth = await verifyToken(req && req.idToken);
  if (!auth.ok) return fail('UNAUTHENTICATED', (auth as any).error || 'Please sign in.');
  const email = (auth as any).email as string;
  if (req.action === 'logout') return await logout(req.idToken);

  const { users, cfg } = await loadUsersAndConfig();
  const role = SOCore.roleFor(email, cfg.editors, cfg.viewers, cfg.admins, users);
  if (req.action === 'changePassword' && role) return await changePassword(email, req);

  if (typeof req.action === 'string' && req.action.startsWith('sc')) return await subconAction(req, email, role);
  if (typeof req.action === 'string' && req.action.startsWith('lg')) return await logAction(req, email, role);

  const opts = await prefetch(req, email, role, users, cfg);
  const snap = SOPg.create(opts);
  const result = SOService.handle(snap.adapter, req);
  if (result && result.ok && snap.ops.length) {
    try { await flush(snap.ops); }
    catch (e: any) {
      if (e && e.duplicate) return fail('INVALID', 'Please fix the highlighted fields.', { fieldErrors: { so_no: 'That SO# already exists.' } });
      throw e;
    }
  }
  return result;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'POST') return reply({ ok: true, service: 'Shop Order Tracking Details API', note: 'POST requests with a Google ID token are required.' }, origin);
  let req: any;
  try {
    const body = await request.text();
    if (!body || body.length > 14_000_000) return reply(fail('BAD_REQUEST', 'Bad request size.'), origin);
    req = JSON.parse(body);
    const big = body.length > 100_000;
    if (big && !['uploadStock', 'uploadStockItems', 'uploadSteelUsage', 'uploadScan', 'scImport', 'scImportTemplate'].includes(req && req.action)) return reply(fail('BAD_REQUEST', 'Bad request size.'), origin);
  } catch (_e) {
    return reply(fail('BAD_REQUEST', 'Request is not valid JSON.'), origin);
  }
  try {
    return reply(await handleRequest(req), origin);
  } catch (e: any) {
    console.error('API error', e && e.message ? e.message : e);
    return reply(fail('SERVER_ERROR', 'Unexpected server error: ' + (e && e.message ? e.message : String(e))), origin);
  }
});
