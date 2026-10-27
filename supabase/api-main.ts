// ---------------------------------------------------------------------------
// Network layer (Deno / Supabase Edge Function). Appended after Core, Calc, Service and
// PgAdapter by scripts/build-edge.js. Flow per request:
//   1. verify the Google ID token, work out the caller's role
//   2. load only the rows/lookups the action needs
//   3. run SOService.handle() against a snapshot adapter (collects changes as `ops`)
//   4. save the ops to Postgres, return the result
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '2633337182-5qjj6uq4vuejlejghq9qvq9fm1jv99i5.apps.googleusercontent.com';
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

// ---- Google sign-in token (cached until it expires, so only the first request per token pays the lookup)
const tokenCache = new Map<string, { email: string; exp: number }>();
async function verifyToken(idToken: unknown) {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4000) return { ok: false, error: 'Please sign in.' };
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(idToken);
  if (hit && hit.exp > now) return { ok: true, email: hit.email };
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return { ok: false, error: 'Session expired or invalid. Please sign in again.' };
  const info = await res.json();
  const chk = SOCore.checkTokenInfo(info, GOOGLE_CLIENT_ID, now);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(idToken, { email: chk.email, exp: Math.min(Number(info.exp), now + 3000) });
  return { ok: true, email: chk.email };
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
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = keys.slice(i, i + 40);
    out.push(...(must(await sb.from(table).select(cols).in(keyCol, part)) as any[]));
  }
  return out;
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
  else if (action === 'findSO') {
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
  const tasks: Promise<unknown>[] = [];
  if (needLookups) {
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
      tasks.push(chunkedIn('stockroom_prices', 'part,price', 'part_key', pk).then((rs) => { opts.stock.rows = rs.map((r) => [r.part, Number(r.price)]); }));
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
      const r = await sb.from('shop_orders').insert({ id: o.id, data: o.data });
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

async function handleRequest(req: any) {
  const auth = await verifyToken(req && req.idToken);
  if (!auth.ok) return fail('UNAUTHENTICATED', (auth as any).error || 'Please sign in.');
  const email = (auth as any).email as string;

  const [userRows, cfgMeta] = await Promise.all([
    sb.from('app_users').select('email,name,employee_id,role,active,added_by,added_at,updated_by,updated_at'),
    metaValue('config')
  ]);
  const users = must(userRows as any).map((u: any) => ({ email: u.email, name: u.name, employeeId: u.employee_id, role: u.role, active: u.active, addedBy: u.added_by, addedAt: u.added_at, updatedBy: u.updated_by, updatedAt: u.updated_at }));
  const cfg = { admins: Deno.env.get('ADMINS') || (cfgMeta && cfgMeta.admins) || '', editors: Deno.env.get('EDITORS') || (cfgMeta && cfgMeta.editors) || '', viewers: Deno.env.get('VIEWERS') || (cfgMeta && cfgMeta.viewers) || '' };
  const role = SOCore.roleFor(email, cfg.editors, cfg.viewers, cfg.admins, users);

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
    if (big && !['uploadStock', 'uploadStockItems', 'uploadSteelUsage', 'uploadScan'].includes(req && req.action)) return reply(fail('BAD_REQUEST', 'Bad request size.'), origin);
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
