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
  await revokeSessions(email, typeof req.idToken === 'string' ? req.idToken : undefined);   // sign out the person's other devices, keep this one
  await sb.from('app_audit').insert({ user_email: email, field: 'PASSWORD CHANGED', new_value: email });
  return { ok: true };
}

// After a password change/reset: drop the person's sessions (all of them, or all but `keepToken`) and their cached tokens.
async function revokeSessions(email: string, keepToken?: string) {
  const who = String(email || '').trim().toLowerCase();
  if (!who) return;
  for (const [tok, v] of tokenCache) if (String(v.email).toLowerCase() === who && tok !== keepToken) tokenCache.delete(tok);
  let q = sb.from('sessions').delete().eq('email', who);
  if (keepToken) q = q.neq('token_hash', await sha256hex(keepToken));
  const r = await q;
  if (r.error) throw new Error(r.error.message);
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
    const page = must(await sb.from('shop_orders').select('row_no,id,data,status_since,updated_at').order('row_no').range(from, from + 999)) as any[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
// every row of a query, 1000 at a time (PostgREST caps one response at 1000 rows). `page(from, to)` must build
// a fresh, fully ordered query (end with a unique column such as id) and apply .range(from, to).
async function pagedRows(page: (from: number, to: number) => PromiseLike<any>): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await page(from, from + 999)) as any[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const toRow = (r: any) => ({ rowNumber: Number(r.row_no), id: r.id, data: r.data || {}, statusSince: r.status_since || null, updatedAt: r.updated_at || null });

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
  const wantsAll = ADMIN_ONLY_ROWS.has(action) && (role === 'admin' || role === 'editor');
  let rows: any[] = [];
  if (wantsAll) rows = await allOrderRows();
  else if (action === 'mySOs') rows = await allOrderRows(); // every signed-in user sees every SO; viewers are read-only
  else if (action === 'findSO') {
    const want = SOCore.normSo(req.so_no);
    if (want) rows = must(await sb.from('shop_orders').select('row_no,id,data').eq('so_key', want).order('row_no').limit(5)) as any[];
  } else if (BY_ID.has(action) && typeof req.id === 'string' && UUID.test(req.id)) {
    rows = must(await sb.from('shop_orders').select('row_no,id,data,updated_at').eq('id', req.id).limit(1)) as any[];
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
  // Shop-order writes and every audit line go to apply_order_ops in ONE transaction (atomic-writes.sql): all of a save
  // lands or none of it, and an update whose row changed since it was read is refused (CONFLICT) instead of overwriting.
  // Consecutive patches to the same row are merged into one write that keeps the first version check.
  const patches = new Map<string, Record<string, unknown>>(), expects = new Map<string, string | null>();
  for (const o of ops) if (o.type === 'update') { patches.set(o.id, Object.assign(patches.get(o.id) || {}, o.patch)); if (!expects.has(o.id)) expects.set(o.id, o.expect || null); }
  const doneUpdate = new Set<string>();
  const orderOps: any[] = [];
  for (const o of ops) {
    if (o.type === 'update') {
      if (doneUpdate.has(o.id)) continue;
      doneUpdate.add(o.id);
      orderOps.push({ type: 'update', id: o.id, patch: patches.get(o.id), expect: expects.get(o.id) });
    } else if (o.type === 'insert') {
      orderOps.push({ type: 'insert', id: o.id, data: o.data, createdBy: String(o.createdBy || '').toLowerCase() });
    } else if (o.type === 'delete') {
      orderOps.push({ type: 'delete', id: o.id, expect: o.expect || null });
    } else if (o.type === 'audit') {
      orderOps.push({ type: 'audit', at: o.entry.at, user: o.entry.user, recordId: String(o.entry.recordId || ''), row: o.entry.row, field: o.entry.field, oldValue: o.entry.oldValue, newValue: o.entry.newValue });
    } else if (o.type === 'users') {
      // only the users this request changed are written, and only the ones it removed are deleted: a concurrent
      // edit by another admin (someone added or changed meanwhile) is never undone
      const rows = (o.changed || o.list).map((u: any) => ({ email: String(u.email).toLowerCase(), name: u.name || '', employee_id: u.employeeId || '', role: u.role, active: !!u.active, added_by: u.addedBy || '', added_at: u.addedAt || '', updated_by: u.updatedBy || '', updated_at: u.updatedAt || '' }));
      if (rows.length) { const r = await sb.from('app_users').upsert(rows, { onConflict: 'email' }); if (r.error) throw new Error(r.error.message); }
      const gone = (o.removed || []).map((e: string) => String(e).toLowerCase());
      if (gone.length) { const r = await sb.from('app_users').delete().in('email', gone); if (r.error) throw new Error(r.error.message); }
    } else if (o.type === 'stock') {
      const r = await sb.rpc('replace_stockroom_prices', { p_rows: o.rows });
      if (r.error) throw new Error(r.error.message);
      const m = await sb.from('app_meta').upsert({ key: 'stock_meta', value: o.meta }); if (m.error) throw new Error(m.error.message);
    } else if (o.type === 'setPassword') {
      const r = await sb.rpc('set_user_password', { p_email: o.email, p_password: o.password });
      if (r.error) throw new Error(r.error.message);
      await revokeSessions(o.email);   // an admin reset signs the person out everywhere
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
      if (r.error) { await sb.storage.from('scans').remove([path]); throw new Error(r.error.message); }   // no orphaned file without its record
    }
  }
  if (orderOps.length) {
    const r = await sb.rpc('apply_order_ops', { p_ops: orderOps });
    if (r.error) {
      if (r.error.code === '23505') throw { duplicate: true };   // so_no set to one that exists (shop_orders_so_key_uq)
      if (r.error.code === 'P0409') throw { conflict: true };    // the row changed since it was read
      throw new Error(r.error.message);
    }
  }
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
  const rows = await pagedRows((a, b) => sb.from('sc_lines').select('id,order_ref').like('order_ref', 'SUB-%').order('id').range(a, b));   // max over ALL refs, not the first 1000
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

// Lead time calculator (the LT worksheet): routing steps of a part and the days each work center takes.
async function ltAction(req: any, role: string | null) {
  if (!role) return fail('FORBIDDEN', 'You are not allowed to use this app.');
  const part = String(req.part_no === undefined || req.part_no === null ? '' : req.part_no).trim();
  if (!part) return fail('INVALID', 'Enter a part number.');
  if (part.length > 80) return fail('INVALID', 'That part number is too long.');
  const key = SOCore.normalizePart(part);
  const rt = must(await sb.from('lt_routings').select('part,ops').eq('part_key', key).limit(1) as any) as any[];
  const st = must(await sb.from('stock_items').select('quantity').eq('part_key', key).limit(1) as any) as any[];
  const stock = st.length && st[0].quantity !== null ? Number(st[0].quantity) : null;
  if (!rt.length) return { ok: true, found: false, part, stock };
  const ops: any[] = Array.isArray(rt[0].ops) ? rt[0].ops : [];
  const wcs = [...new Set(ops.map((o: any) => String(o[1] || '').trim()).filter(Boolean))];
  const days: any = {};
  if (wcs.length) (must(await sb.from('lt_workcenters').select('workcenter,lead_days').in('workcenter', wcs) as any) as any[]).forEach((w: any) => { days[w.workcenter] = w.lead_days === null ? null : Number(w.lead_days); });
  const steps = ops.map((o: any) => { const wc = String(o[1] || '').trim(); return { op: o[0], workcenter: wc, description: o[2] || '', days: wc in days ? days[wc] : null }; });
  const total = steps.reduce((t: number, x: any) => t + (typeof x.days === 'number' ? x.days : 0), 0);
  return { ok: true, found: true, part: rt[0].part, stock, steps, total };
}

// Price Increase Tracking: price updates sent to Skye. Admin only, enforced here (the rows never leave the server for other roles).
const PU_REPLIES = ['none', 'confirmed', 'disputed', 'declined'];
async function puAction(req: any, email: string, role: string | null) {
  if (role !== 'admin') return fail('FORBIDDEN', 'Only an admin can use Price Increase Tracking.');
  if (req.action === 'puList') {
    const r = await sb.from('price_updates').select('id,part_no,prev_price,new_price,orig_new_price,sent_by,sent_date,revised_date,effective_date,reply,reply_date,implemented,source_subject,source_date,notes,history').order('effective_date', { ascending: true, nullsFirst: true });
    if (r.error) return fail('SERVER_ERROR', r.error.message);
    return { ok: true, rows: r.data || [] };
  }
  if (req.action === 'puSet' || req.action === 'puAdd') {
    const adding = req.action === 'puAdd';
    const id = String(req.id || '');
    if (!adding && !UUID.test(id)) return fail('BAD_REQUEST', 'Missing record.');
    const patch: any = {}, errors: any = {};
    const dateOrNull = (v: any) => (v === null || v === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined);
    const num = (v: any) => (v === null || v === '' ? null : isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e7 ? Math.round(Number(v) * 10000) / 10000 : undefined);
    const text = (v: any, max: number) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
    if (req.part_no !== undefined || adding) { const pn = text(req.part_no, 40); if (!/^[0-9][0-9A-Za-z\-\/]*$/.test(pn)) errors.part_no = 'Enter the part number.'; else patch.part_no = pn; }
    for (const k of ['prev_price', 'new_price', 'orig_new_price']) if (req[k] !== undefined || (adding && k !== 'orig_new_price')) { const n = num(req[k]); if (n === undefined) errors[k] = 'Enter a price like 12.50.'; else patch[k] = n; }
    for (const k of ['sent_date', 'revised_date', 'effective_date', 'reply_date', 'source_date']) if (req[k] !== undefined) { const d = dateOrNull(req[k]); if (d === undefined) errors[k] = 'Use a valid date.'; else patch[k] = d; }
    if (req.reply !== undefined) { if (!PU_REPLIES.includes(String(req.reply))) errors.reply = 'Unknown reply status.'; else patch.reply = String(req.reply); }
    if (req.implemented !== undefined) patch.implemented = req.implemented === null ? null : !!req.implemented;
    if (req.sent_by !== undefined) patch.sent_by = text(req.sent_by, 80);
    if (req.source_subject !== undefined) patch.source_subject = text(req.source_subject, 300);
    if (req.notes !== undefined) { const n = String(req.notes); if (n.length > 4000) errors.notes = 'Keep the note under 4000 characters.'; else patch.notes = n; }
    if (adding && patch.prev_price === null && patch.new_price === null) errors.new_price = 'Enter at least the new price.';
    if (Object.keys(errors).length) return fail('INVALID', 'Please fix the highlighted fields.', { fieldErrors: errors });
    if (adding) {
      if (patch.sent_by === undefined) patch.sent_by = '';
      patch.history = [{ date: patch.sent_date || new Date().toISOString().slice(0, 10), who: email, text: 'Added manually.' }];
      const ins = await sb.from('price_updates').insert(patch).select('id').single();
      if (ins.error) return fail('SERVER_ERROR', ins.error.message);
      await sb.from('app_audit').insert({ user_email: email, field: 'PRICE UPDATE ADDED', new_value: patch.part_no });
      return { ok: true, id: (ins.data as any).id };
    }
    patch.updated_at = new Date().toISOString();
    const u = await sb.from('price_updates').update(patch).eq('id', id);
    if (u.error) return fail('SERVER_ERROR', u.error.message);
    await sb.from('app_audit').insert({ user_email: email, field: 'PRICE UPDATE', new_value: id + ' ' + JSON.stringify(patch) });
    return { ok: true };
  }
  if (req.action === 'puDelete') {
    const id = String(req.id || '');
    if (!UUID.test(id)) return fail('BAD_REQUEST', 'Missing record.');
    const d = await sb.from('price_updates').delete().eq('id', id);
    if (d.error) return fail('SERVER_ERROR', d.error.message);
    await sb.from('app_audit').insert({ user_email: email, field: 'PRICE UPDATE DELETED', new_value: id });
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
    const rows = await pagedRows((a, b) => sb.from('sc_lines').select('*').order('bpo_no').order('batch').order('so_no').order('id').range(a, b));
    if (write) {   // orders that predate order refs get one, so an exported sheet can always update them
      const blank = rows.filter((x: any) => !String(x.order_ref || '').trim());
      if (blank.length) { const refs = await nextRefs(blank.length); for (let i = 0; i < blank.length; i++) { const u = await sb.from('sc_lines').update({ order_ref: refs[i] }).eq('id', blank[i].id); if (!u.error) blank[i].order_ref = refs[i]; } }
    }
    let events: any[] = [], boardSaved = true;
    try { events = await pagedRows((a, b) => sb.from('sc_bpo_events').select('id,bpo_no,batch,at,event_date,by_user,kind,from_stage,to_stage,text,applied').order('at', { ascending: true }).order('id').range(a, b)); }
    catch (_e) { boardSaved = false; }   // before subcon5.sql is applied the board simply follows the dates
    const built = SOSub.build(rows, today, undefined, events);
    return { ok: true, today, role, boardStages: SOSub.BOARD, boardSaved, milestones: SOSub.MILESTONES, expected: SOSub.EXPECTED, stages: SOSub.STAGES, sectionDefs: SOSub.SECTIONS, decisions: SOSub.DECISIONS, reviewStatuses: SOSub.REVIEW_STATUSES, priorities: SOSub.PRIORITIES, blockers: SOSub.BLOCKERS, updateKinds: SOSub.UPDATE_KINDS, cfg: SOSub.CFG, ...built };
  }
  if (action === 'scUpdates') {
    const r = await sb.from('sc_updates').select('id,at,by_user,kind,text').eq('line_id', String(req.id)).order('at', { ascending: false }).limit(100);
    return { ok: true, updates: must(r as any) };
  }
  if (action === 'scBpoLog') {
    const bpo = String(req.bpo_no || ''), batch = String(req.batch || '');
    const lr = must(await sb.from('sc_lines').select('id,part_no').eq('bpo_no', bpo).eq('batch', batch).limit(500) as any) as any[];
    const ids = lr.map((x: any) => x.id), names: any = {}; lr.forEach((x: any) => { names[x.id] = x.part_no; });
    let updates: any[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const u = must(await sb.from('sc_updates').select('id,line_id,at,by_user,kind,text').in('line_id', ids.slice(i, i + 100)).order('at', { ascending: false }).limit(500) as any) as any[];
      updates = updates.concat(u.map((x: any) => ({ ...x, part_no: names[x.line_id] || '' })));
    }
    const ev = await sb.from('sc_bpo_events').select('id,at,event_date,by_user,kind,from_stage,to_stage,text,applied').eq('bpo_no', bpo).eq('batch', batch).order('at', { ascending: false }).limit(500);
    return { ok: true, updates: updates.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500), events: ev.error ? [] : ev.data };
  }
  if (!write) return fail('FORBIDDEN', 'Viewers cannot change subcontractor data.');
  if (action === 'scMoveBpo' || action === 'scBpoNote' || action === 'scDeleteBpo') {
    const bpo = String(req.bpo_no || ''), batch = String(req.batch || '');
    const sel = await sb.from('sc_lines').select('*').eq('bpo_no', bpo).eq('batch', batch).limit(500);
    const lines = must(sel as any) as any[]; if (!lines.length) return fail('NOT_FOUND', 'That BPO has no parts.');
    const note = String(req.note || '').trim().slice(0, 1000);
    const tag = (bpo || 'No BPO') + (batch ? ' batch ' + batch : '');
    if (action === 'scDeleteBpo') {
      if (role !== 'admin') return fail('FORBIDDEN', 'Only an admin can delete a BPO.');
      if (String(req.confirm || '') !== 'DELETE') return fail('BAD_REQUEST', 'Deletion not confirmed.');
      const ids = lines.map((x: any) => x.id);
      for (let i = 0; i < ids.length; i += 100) { const d = await sb.from('sc_lines').delete().in('id', ids.slice(i, i + 100)); if (d.error) return fail('SERVER_ERROR', d.error.message); }
      await sb.from('sc_bpo_events').delete().eq('bpo_no', bpo).eq('batch', batch);
      await scAudit(email, tag, 'SUBCON BPO DELETED', lines.length + ' part numbers: ' + lines.slice(0, 10).map((x: any) => x.part_no).join(', '));
      return { ok: true, count: lines.length };
    }
    if (action === 'scBpoNote') {
      const kind = String(req.kind || 'NOTE'); if (!['NOTE', 'FOLLOW-UP'].includes(kind)) return fail('INVALID', 'Choose a type.', { fieldErrors: { kind: 'Choose a type.' } });
      if (!note) return fail('INVALID', 'Write the update.', { fieldErrors: { text: 'Write the update.' } });
      const date = SOSub.isDate(req.date) ? req.date : today;
      const ins = await sb.from('sc_bpo_events').insert({ bpo_no: bpo, batch, by_user: email, kind, event_date: date, text: note });
      if (ins.error) return fail('SERVER_ERROR', ins.error.message);
      for (const x of lines.filter((l: any) => !l.closed)) await sb.from('sc_lines').update({ last_update: date > today ? today : date, updated_at: new Date().toISOString() }).eq('id', x.id);
      return { ok: true };
    }
    // scMoveBpo: the move is saved as history; the milestone date is written only when asked, and only where the part has none
    const to = String(req.to || ''), stages = SOSub.BOARD;
    if (to !== 'AUTO' && !stages.some((s: any) => s.key === to)) return fail('BAD_REQUEST', 'Unknown stage.');
    const date = SOSub.isDate(req.date) ? req.date : today;
    if (date > today) return fail('INVALID', 'The date cannot be in the future.', { fieldErrors: { date: 'The date cannot be in the future.' } });
    const evq = await sb.from('sc_bpo_events').select('bpo_no,batch,at,event_date,kind,to_stage').eq('bpo_no', bpo).eq('batch', batch).order('at', { ascending: true });
    const card = SOSub.boardOf(lines.map((l: any) => SOSub.describe(l, today)), evq.error ? [] : evq.data, today)[0];
    if (!card) return fail('INVALID', 'This BPO has no active parts to move.');
    if (card.stage === to && !(to === 'AUTO')) return { ok: true, unchanged: true };
    const def = stages.find((s: any) => s.key === to);
    let applied = '';
    if (req.apply && def && def.ms) {
      const label = SOSub.milestoneLabel(def.ms); let n = 0;
      for (const l of lines) {
        if (l.closed || (l.ms || {})[def.ms]) continue;
        const ms = { ...(l.ms || {}), [def.ms]: date };
        const u = await sb.from('sc_lines').update({ ms, last_update: date, updated_at: new Date().toISOString() }).eq('id', l.id); if (u.error) return fail('SERVER_ERROR', u.error.message);
        await sb.from('sc_updates').insert({ line_id: l.id, by_user: email, kind: 'CHANGE', text: 'Moved on the BPO board to ' + def.label + ': ' + label + ' ' + date + (note ? '. ' + note : '') });
        n++;
      }
      applied = n ? label + ' ' + date + ' recorded on ' + n + ' part' + (n === 1 ? '' : 's') : 'All parts already had ' + label;
    }
    const ins = await sb.from('sc_bpo_events').insert({ bpo_no: bpo, batch, by_user: email, kind: 'MOVE', event_date: date, from_stage: card.stage, to_stage: to, text: note, applied });
    if (ins.error) return fail('SERVER_ERROR', ins.error.message);
    await scAudit(email, tag, 'SUBCON BPO MOVED', card.stage + ' → ' + to + (note ? ' · ' + note.slice(0, 200) : ''));
    return { ok: true, from: card.stage, to, applied };
  }
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
      // refuse the save when the line changed after this form was loaded (no silent overwrite of another person's dates)
      let q = sb.from('sc_lines').update(upd).eq('id', id);
      if (req.line.updated_at) q = q.eq('updated_at', String(req.line.updated_at));
      const r = await q.select('id');
      if (r.error) return scDup(r.error) ? dupFail(r.error) : fail('SERVER_ERROR', r.error.message);
      if (!(r.data as any[]).length) return fail('CONFLICT', 'This order was changed by someone else since you opened it. Reload it, then make your change again.');
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
    const sel = await sb.from('sc_lines').select('id,ms,po_no,note').eq('bpo_no', String(b.bpo_no || '')).eq('batch', String(b.batch || '')).eq('closed', false).limit(300);
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
      if (note) { const own = String(r.note || '').trim(); patch.note = (own ? own + '\n' + today + ': ' + note : note).slice(0, 2000); }   // added to each part's own note, never replacing it
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
    const problems: string[] = [];
    const poOf = (row: any) => String(row && row.po_no != null ? row.po_no : '').trim().slice(0, 60);
    const keys = [...new Set(list.map((row: any) => poOf(row).toUpperCase()).filter(Boolean))] as string[];
    const have = new Map<string, any>((keys.length ? await chunkedIn('sc_lines', '*', 'po_key', keys) : []).map((r: any) => [r.po_key, r]));
    const seen = new Set<string>(); let added = 0, updated = 0, unchanged = 0;
    const fresh: any[] = [], upds: any[] = [];
    list.forEach((row: any, i: number) => {
      const po = poOf(row), k = po.toUpperCase(), label = 'Row ' + (i + 1) + ' (PO ' + (po || '?') + '): ';
      if (!po) { problems.push('Row ' + (i + 1) + ': PO # is required to import a line.'); return; }
      if (seen.has(k)) { problems.push('PO ' + po + ' appears twice in the file; the first row was used.'); return; }
      seen.add(k);
      const ex = have.get(k);
      if (ex) {   // merge: only the cells the CSV filled in change; dates keep their first value in orig
        const m = SOPg.bpoImportMerge(ex, row);
        if (!m.ok) { problems.push(label + Object.values(m.errors).join(' ')); return; }
        if (m.diff.length) upds.push({ ex, m }); else unchanged++;
      } else {
        const c = SOSub.cleanLine(row);
        if (!c.ok) { problems.push(label + Object.values(c.errors).join(' ')); return; }
        fresh.push({ ...c.value, created_by: email });
      }
    });
    for (const { ex, m } of upds) {
      const v: any = { ...m.value, orig: m.orig, updated_at: new Date().toISOString() }; delete v.order_ref;   // the CSV never carries the order ref
      const u = await sb.from('sc_lines').update(v).eq('id', ex.id);
      if (u.error) return scDup(u.error) ? dupFail(u.error) : fail('SERVER_ERROR', u.error.message);
      const fields = m.diff.filter((d: string) => d !== 'ms' && d !== 'exp');
      const text = 'BPO Tracking import' + (m.changed.length ? ': ' + m.changed.join('; ') : '') + (fields.length ? (m.changed.length ? '; ' : ': ') + 'updated ' + fields.join(', ') : '');
      await sb.from('sc_updates').insert({ line_id: ex.id, by_user: email, kind: 'CHANGE', text: text.slice(0, 1900) });
      updated++;
    }
    if (fresh.length) { const refs = await nextRefs(fresh.length); fresh.forEach((f: any, i: number) => { f.order_ref = refs[i]; }); const ins = await sb.from('sc_lines').insert(fresh); if (ins.error) return scDup(ins.error) ? dupFail(ins.error) : fail('SERVER_ERROR', ins.error.message); added = fresh.length; }
    await scAudit(email, '', 'SUBCON IMPORT', added + ' added, ' + updated + ' updated, ' + unchanged + ' unchanged');
    return { ok: true, added, updated, unchanged, problems: problems.slice(0, 20), problemCount: problems.length };
  }
  if (action === 'scImportTemplate') {
    const list = Array.isArray(req.rows) ? req.rows.slice(0, 500) : [];
    if (!list.length) return fail('INVALID', 'The sheet has no rows to import.');
    const all = await pagedRows((a, b) => sb.from('sc_lines').select('*').order('id').range(a, b));
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

// ---- SO Tracker: the planner PC uploads a self-contained HTML report (stUpload); every signed-in user reads it (stGet)
const ST_BUCKET = 'so-tracker';
const ST_MAX_GZ_B64 = 4_000_000;     // compressed upload, per file
const ST_MAX_TEXT = 6_000_000;       // decompressed, per file
async function gunzipB64(b64: unknown, max: number): Promise<string> {
  if (typeof b64 !== 'string' || !b64 || b64.length > ST_MAX_GZ_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error('Bad file data.');
  const bin = atob(b64.replace(/\s+/g, '')); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { await reader.cancel(); throw new Error('File too large.'); }
    parts.push(value);
  }
  const all = new Uint8Array(size); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}
async function stAction(req: any, email: string, role: string | null) {
  if (!role) return fail('FORBIDDEN', 'You are not allowed to use this app.');
  if (req.action === 'stGet') {
    const notYet = 'The SO Tracker has not been uploaded yet. It is published by the planner\'s PC every day at 7:00 AM.';
    const run = await sb.from('so_tracker_runs').select('run_at,counts,parts,created_at').order('created_at', { ascending: false }).limit(1);
    const r: any = !run.error && run.data && run.data[0] ? run.data[0] : {};
    if (req.summary === true) {   // dashboard tile: the latest run's numbers only, no HTML download
      if (run.error) return fail('SERVER_ERROR', run.error.message);
      if (!run.data || !run.data[0]) return fail('NOT_FOUND', notYet);
      return { ok: true, run_at: r.run_at || '', uploaded_at: r.created_at || '', counts: r.counts || {}, parts: r.parts ?? null };
    }
    const dl = await sb.storage.from(ST_BUCKET).download('latest/so_tracker.html');
    if (dl.error || !dl.data) return fail('NOT_FOUND', notYet);
    return { ok: true, run_at: r.run_at || '', uploaded_at: r.created_at || '', counts: r.counts || {}, parts: r.parts ?? null, html: await dl.data.text() };
  }
  // stUpload: only accounts flagged can_upload_tracker (column added by supabase/so-tracker.sql)
  const flag = await sb.from('app_users').select('can_upload_tracker').eq('email', email).eq('active', true).limit(1);
  if (flag.error || !flag.data || !flag.data[0] || flag.data[0].can_upload_tracker !== true) return fail('FORBIDDEN', 'This account may not upload the SO Tracker.');
  let html: string, results: string;
  try { html = await gunzipB64(req.html_gz_b64, ST_MAX_TEXT); results = await gunzipB64(req.results_gz_b64, ST_MAX_TEXT); }
  catch (e: any) { return fail('INVALID', (e && e.message) || 'Bad file data.'); }
  if (!/<html[\s>]/i.test(html)) return fail('INVALID', 'The page is not an HTML document.');
  try { JSON.parse(results); } catch (_e) { return fail('INVALID', 'The results file is not valid JSON.'); }
  const m = req.manifest && typeof req.manifest === 'object' ? req.manifest : {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(m.today || '')) ? String(m.today) : new Date().toISOString().slice(0, 10);
  const up = async (path: string, text: string, type: string) => {
    const r = await sb.storage.from(ST_BUCKET).upload(path, new Blob([text], { type }), { upsert: true, contentType: type });
    if (r.error) throw new Error(r.error.message);
  };
  await up('latest/so_tracker.html', html, 'text/html; charset=utf-8');
  await up('latest/so_tracker_results.json', results, 'application/json');
  await up('history/' + day + '/so_tracker.html', html, 'text/html; charset=utf-8');
  const runAt = String(req.run_at || m.run_at || '').slice(0, 60);
  const parts = Number.isFinite(Number(m.parts)) ? Math.round(Number(m.parts)) : null;
  const ins = await sb.from('so_tracker_runs').insert({ run_at: runAt, uploaded_by: email, counts: m.counts && typeof m.counts === 'object' ? m.counts : null, sources: Array.isArray(m.sources) || (m.sources && typeof m.sources === 'object') ? m.sources : null, parts });
  if (ins.error) throw new Error(ins.error.message);
  await sb.from('app_audit').insert({ user_email: email, field: 'SO TRACKER UPLOAD', new_value: runAt + ' (' + Math.round(html.length / 1024) + ' KB)' });
  return { ok: true };
}

// ---- status reminders: called by pg_cron every 15 minutes with a shared secret (no user session)
const REMIND_TO = Deno.env.get('REMIND_TO') || 'sahamed@camcomfginc.com';
const APP_URL = 'https://so.amanasystem.com';

async function sendMail(to: string, m: { subject: string; text: string; html: string }) {
  // Preferred: a small Apps Script web app that sends from a Google account (no app password needed).
  const hook = Deno.env.get('MAIL_WEBHOOK_URL'), mailKey = Deno.env.get('MAIL_KEY');
  if (hook) {
    const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: mailKey || '', subject: m.subject, text: m.text, html: m.html }), redirect: 'follow' });
    let out: any = null; try { out = await r.json(); } catch (_e) { /* not JSON */ }
    if (!out || out.ok !== true) throw new Error('Mailer failed: ' + (out && out.error ? out.error : 'HTTP ' + r.status));
    return;
  }
  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (!user || !pass) throw new Error('Set MAIL_WEBHOOK_URL + MAIL_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD.');
  const nodemailer = (await import('npm:nodemailer@6.9.14')).default;
  const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  await tx.sendMail({ from: '"Shop Order Tracker" <' + user + '>', to, subject: m.subject, text: m.text, html: m.html });
}

async function statusReminders(req: any) {
  const key = Deno.env.get('CRON_KEY') || '';
  if (key.length < 16 || typeof req.cronKey !== 'string' || (await sha256hex(req.cronKey)) !== (await sha256hex(key))) return fail('UNAUTHENTICATED', 'Not allowed.');
  if (req.test === true) { await sendMail(REMIND_TO, { subject: 'SO reminder test', text: 'This is a test of the Shop Order status reminder email.', html: '<p>This is a test of the Shop Order status reminder email.</p>' }); return { ok: true, test: true, to: REMIND_TO }; }
  const rows = must(await sb.from('shop_orders').select('id,data,status_since,remind_count,last_remind_at').in('data->>status', SOReminders.statuses())) as any[];
  const items = SOReminders.due(rows, Date.now());
  if (!items.length) return { ok: true, watching: rows.length, sent: 0 };
  if (req.dryRun === true) return { ok: true, dryRun: true, watching: rows.length, due: items.length };
  await sendMail(REMIND_TO, SOReminders.buildEmail(items, APP_URL));
  const nowIso = new Date().toISOString();
  for (const it of items) {
    const u = await sb.from('shop_orders').update({ remind_count: it.number, last_remind_at: nowIso }).eq('id', it.id);
    if (u.error) console.error('reminder bookkeeping failed', it.id, u.error.message);
  }
  await sb.from('app_audit').insert({ user_email: 'system', field: 'STATUS REMINDER', new_value: items.length + ' SOs to ' + REMIND_TO });
  return { ok: true, watching: rows.length, sent: items.length };
}

// ---------- SO Review: release-document checks (admin only). The checks themselves run on an office PC (agent/so-review-agent.js),
// which can reach the network share and Outlook; it reads the SO data and submits results with its own key (SO_REVIEW_AGENT_KEY).
const SR_RESULTS = ['PASS', 'FAIL', 'MISSING DOCUMENT', 'PENDING REVIEW'];
const SR_RELEASE = ['RELEASED', 'POSSIBLE', 'NOT FOUND', 'ERROR'];
const SR_FOLDER = ['NEED TO RELEASE', 'RELEASED', 'GONE'];
const srSo = (s: unknown) => String(s ?? '').trim().toUpperCase().slice(0, 30);
const srText = (s: unknown, n: number) => String(s ?? '').slice(0, n);
async function srAgentOk(req: any) {
  const key = Deno.env.get('SO_REVIEW_AGENT_KEY') || '';
  return key.length >= 32 && typeof req.agentKey === 'string' && (await sha256hex(req.agentKey)) === (await sha256hex(key));
}

async function srAgentAction(req: any) {
  if (!(await srAgentOk(req))) return fail('UNAUTHENTICATED', 'Not allowed.');
  const action = String(req.action);
  if (action === 'srAgentRecords') {
    // every shop order with its calculated columns (price, steel, bar size...), exactly as an admin sees it in the app
    const { users, cfg } = await loadUsersAndConfig();
    const admin = (users.find((u: any) => u.active !== false && u.role === 'admin') || {} as any).email || SOCore.parseEmailList(cfg.admins)[0];
    if (!admin) return fail('NOT_READY', 'No admin account to read the SO list as.');
    const r = SOService.handle(SOPg.create(await prefetch({ action: 'list' }, admin, 'admin', users, cfg)).adapter, { action: 'list', idToken: 'agent' });
    if (!r || !r.ok) return r || fail('SERVER_ERROR', 'Could not read the SO list.');
    const known = must(await sb.from('so_review_sos').select('so_no,fingerprint,folder_state,folder_path,result,release_status') as any) as any[];
    return { ok: true, now: new Date().toISOString(), records: r.records.map((x: any) => ({ id: x.id, values: x.values, display: x.display })), known };
  }
  if (action === 'srAgentPoll') {
    const q = must(await sb.from('so_review_requests').select('*').eq('status', 'QUEUED').order('id').limit(50) as any) as any[];
    if (q.length) { const u = await sb.from('so_review_requests').update({ status: 'RUNNING', picked_at: new Date().toISOString() }).in('id', q.map((x) => x.id)); if (u.error) return fail('SERVER_ERROR', u.error.message); }
    return { ok: true, requests: q };
  }
  if (action === 'srAgentSubmit') {
    const now = new Date().toISOString(), agent = srText(req.agent, 80);
    const reviews = Array.isArray(req.reviews) ? req.reviews.slice(0, 400) : [];
    for (const it of reviews) {
      const so = srSo(it.so_no); if (!so) continue;
      if (!SR_RESULTS.includes(it.result) || !SR_RELEASE.includes(it.release_status) || !SR_FOLDER.includes(it.folder_state)) return fail('INVALID', 'Bad review values for SO ' + so + '.');
      const row: any = { so_no: so, customer_folder: srText(it.customer_folder, 60), folder_path: srText(it.folder_path, 500), folder_state: it.folder_state, result: it.result,
        release_status: it.release_status, needs_attention: !!it.needs_attention, fingerprint: srText(it.fingerprint, 200), updated_at: now };
      if (it.review && typeof it.review === 'object') {
        const rv = it.review;
        const ins = await sb.from('so_reviews').insert({ so_no: so, reviewed_at: now, result: it.result, docs_found: Number(rv.docs_found) || 0, docs_required: Number(rv.docs_required) || 5,
          summary: rv.summary || {}, documents: rv.documents || [], checks: rv.checks || [], discrepancies: rv.discrepancies || [], missing: rv.missing || [], release: rv.release || {},
          errors: rv.errors || [], fingerprint: row.fingerprint, agent }).select('id').single();
        if (ins.error) return fail('SERVER_ERROR', ins.error.message);
        row.latest_review_id = (ins.data as any).id; row.reviewed_at = now;
      }
      const up = await sb.from('so_review_sos').upsert(row, { onConflict: 'so_no' });
      if (up.error) return fail('SERVER_ERROR', up.error.message);
    }
    const moves = Array.isArray(req.moves) ? req.moves.slice(0, 400) : [];
    for (const m of moves) {
      const rec = { so_no: srSo(m.so_no), from_path: srText(m.from_path, 500), to_path: srText(m.to_path, 500), moved_at: m.moved_at || now, reason: srText(m.reason, 500), email_ref: srText(m.email_ref, 1000), moved_by: srText(m.moved_by || 'agent', 120) };
      const r = await sb.from('so_folder_moves').upsert(rec, { onConflict: 'so_no,to_path', ignoreDuplicates: true });
      if (r.error) return fail('SERVER_ERROR', r.error.message);
      await sb.from('app_audit').insert({ user_email: 'so-review-agent', field: 'SO FOLDER MOVED', old_value: rec.from_path, new_value: rec.so_no + ' -> ' + rec.to_path + ' (' + rec.reason + ')' });
    }
    for (const d of (Array.isArray(req.requestsDone) ? req.requestsDone : [])) {
      await sb.from('so_review_requests').update({ status: d.status === 'ERROR' ? 'ERROR' : 'DONE', done_at: now, message: srText(d.message, 1000) }).eq('id', Number(d.id));
    }
    if (req.status && typeof req.status === 'object') {
      const m = await sb.from('app_meta').upsert({ key: 'so_review_agent', value: { ...req.status, at: now, agent } }); if (m.error) return fail('SERVER_ERROR', m.error.message);
      if (req.status.final) await sb.from('app_audit').insert({ user_email: 'so-review-agent', field: 'SO REVIEW RUN', new_value: srText(JSON.stringify(req.status.counts || {}) + (req.status.error ? ' ERROR: ' + req.status.error : ''), 1000) });
    }
    return { ok: true, saved: reviews.length, moves: moves.length };
  }
  return fail('BAD_REQUEST', 'Unknown action.');
}

async function srAction(req: any, email: string, role: string | null) {
  if (role !== 'admin') return fail('FORBIDDEN', 'SO Review is for administrators only.');
  const action = String(req.action);
  if (action === 'srList') {
    const sos = await pagedRows((a, b) => sb.from('so_review_sos').select('*').order('so_no').range(a, b));
    const ids = sos.map((s: any) => s.latest_review_id).filter(Boolean);
    const reviews: any[] = [];
    for (let i = 0; i < ids.length; i += 100) reviews.push(...(must(await sb.from('so_reviews').select('*').in('id', ids.slice(i, i + 100)) as any) as any[]));
    const byId = new Map(reviews.map((r) => [r.id, r]));
    const moves = must(await sb.from('so_folder_moves').select('*').order('moved_at', { ascending: false }).limit(200) as any);
    const requests = must(await sb.from('so_review_requests').select('*').order('id', { ascending: false }).limit(30) as any);
    return { ok: true, items: sos.map((s: any) => ({ ...s, review: byId.get(s.latest_review_id) || null })), moves, requests, agent: await metaValue('so_review_agent') };
  }
  if (action === 'srHistory') {
    const so = srSo(req.so_no); if (!so) return fail('BAD_REQUEST', 'Missing SO number.');
    const h = must(await sb.from('so_reviews').select('id,reviewed_at,result,docs_found,docs_required,discrepancies,missing,release,errors').eq('so_no', so).order('reviewed_at', { ascending: false }).limit(30) as any);
    return { ok: true, history: h };
  }
  if (action === 'srRun') {
    const open = must(await sb.from('so_review_requests').select('id').eq('kind', 'RUN').in('status', ['QUEUED', 'RUNNING']).limit(1) as any) as any[];
    if (open.length) return { ok: true, queued: false, message: 'A review is already queued or running.' };
    const r = await sb.from('so_review_requests').insert({ kind: 'RUN', requested_by: email }); if (r.error) return fail('SERVER_ERROR', r.error.message);
    await sb.from('app_audit').insert({ user_email: email, field: 'SO REVIEW REQUESTED', new_value: 'manual run' });
    return { ok: true, queued: true };
  }
  if (action === 'srConfirm') {
    const so = srSo(req.so_no); if (!so) return fail('BAD_REQUEST', 'Missing SO number.');
    const s = must(await sb.from('so_review_sos').select('so_no,folder_state').eq('so_no', so).limit(1) as any) as any[];
    if (!s.length) return fail('NOT_FOUND', 'SO ' + so + ' has not been reviewed.');
    if (s[0].folder_state !== 'NEED TO RELEASE') return fail('INVALID', 'SO ' + so + ' is not in NEED TO RELEASE any more.');
    const open = must(await sb.from('so_review_requests').select('id').eq('kind', 'CONFIRM_RELEASE').eq('so_no', so).in('status', ['QUEUED', 'RUNNING']).limit(1) as any) as any[];
    if (open.length) return { ok: true, queued: false, message: 'Already confirmed; the folder moves on the next run.' };
    const r = await sb.from('so_review_requests').insert({ kind: 'CONFIRM_RELEASE', so_no: so, note: srText(req.note, 500), requested_by: email }); if (r.error) return fail('SERVER_ERROR', r.error.message);
    await sb.from('app_audit').insert({ user_email: email, field: 'SO RELEASE CONFIRMED', new_value: so + (req.note ? ': ' + srText(req.note, 300) : '') });
    return { ok: true, queued: true };
  }
  return fail('BAD_REQUEST', 'Unknown action.');
}

async function handleRequest(req: any) {
  if (req && req.action === 'statusReminders') return await statusReminders(req);
  if (req && req.action === 'login') return await login(req);
  if (req && typeof req.action === 'string' && req.action.startsWith('srAgent')) return await srAgentAction(req);   // the SO Review agent, own key
  const auth = await verifyToken(req && req.idToken);
  if (!auth.ok) return fail('UNAUTHENTICATED', (auth as any).error || 'Please sign in.');
  const email = (auth as any).email as string;
  if (req.action === 'logout') return await logout(req.idToken);

  const { users, cfg } = await loadUsersAndConfig();
  const role = SOCore.roleFor(email, cfg.editors, cfg.viewers, cfg.admins, users);
  if (req.action === 'changePassword' && role) return await changePassword(email, req);

  if (typeof req.action === 'string' && req.action.startsWith('sc')) return await subconAction(req, email, role);
  if (typeof req.action === 'string' && req.action.startsWith('lg')) return await logAction(req, email, role);
  if (req.action === 'ltLookup') return await ltAction(req, role);
  if (typeof req.action === 'string' && req.action.startsWith('sr')) return await srAction(req, email, role);
  if (req.action === 'stGet' || req.action === 'stUpload') return await stAction(req, email, role);
  if (typeof req.action === 'string' && req.action.startsWith('pu')) return await puAction(req, email, role);

  const opts = await prefetch(req, email, role, users, cfg);
  const snap = SOPg.create(opts);
  const result = SOService.handle(snap.adapter, req);
  if (result && result.ok && snap.ops.length) {
    try { await flush(snap.ops); }
    catch (e: any) {
      if (e && e.duplicate) return fail('INVALID', 'Please fix the highlighted fields.', { fieldErrors: { so_no: 'That SO# already exists.' } });
      if (e && e.conflict) {
        // hand back the record as it is now, so the page can show what changed and let the user re-apply their edits
        let current: any = null;
        if (typeof req.id === 'string' && UUID.test(req.id)) {
          const fresh = SOPg.create(await prefetch({ action: 'get', id: req.id }, email, role, users, cfg));
          const g = SOService.handle(fresh.adapter, { action: 'get', id: req.id, idToken: req.idToken });
          if (g && g.ok) current = g.record;
        }
        return fail('CONFLICT', 'This record was changed by someone else since you opened it. Your changes were not saved.', current ? { current } : {});
      }
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
    if (big && !['uploadStock', 'uploadStockItems', 'uploadSteelUsage', 'uploadScan', 'scImport', 'scImportTemplate', 'stUpload', 'srAgentSubmit'].includes(req && req.action)) return reply(fail('BAD_REQUEST', 'Bad request size.'), origin);
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
