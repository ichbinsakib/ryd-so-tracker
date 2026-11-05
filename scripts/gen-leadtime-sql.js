// Builds the SQL that loads the lead time calculator data from the public tracking sheet.
//   node scripts/gen-leadtime-sql.js [outDir]      (default outDir: ./lt-sql, which is git-ignored)
// Writes lt-1.sql (work centers) and lt-2.sql ... lt-N.sql (routings, about 400 KB each). Run them in order in the SQL editor.
// Same rules as the LT worksheet: only TRAVELLER rows with RM_SWITCH = YES, one row per operation (first one wins),
// operations sorted numbers first then text, lead days looked up by work center in CT (column C).
const fs = require('fs');
const path = require('path');
const SHEET = '1BzamRKdlm6HS-_TqB_MUYRx9QTvNydWxFZeXtrgkY7s';

function parseCsv(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// Worksheet ids (the number after gid= in the sheet address). The plain export keeps text like 005A; the gviz export blanks it.
const GID = { TRAVELLER: 985952349, CT: 522812238 };
async function sheet(name) {
  const r = await fetch('https://docs.google.com/spreadsheets/d/' + SHEET + '/export?format=csv&gid=' + GID[name]);
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status + ' (is the sheet still shared for viewing?)');
  return parseCsv(await r.text());
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const t = (s) => String(s === undefined ? '' : s).trim();
function opOrder(a, b) {
  const na = /^\d+(\.\d+)?$/.test(a[0]), nb = /^\d+(\.\d+)?$/.test(b[0]);
  if (na && nb) return parseFloat(a[0]) - parseFloat(b[0]);
  if (na !== nb) return na ? -1 : 1;
  return a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0;
}

(async () => {
  const out = path.resolve(process.argv[2] || 'lt-sql'); fs.mkdirSync(out, { recursive: true });
  const [ct, tr] = await Promise.all([sheet('CT'), sheet('TRAVELLER')]);

  const wc = new Map();
  ct.slice(1).forEach((r) => { const k = t(r[0]); if (k && !wc.has(k)) wc.set(k, [k, t(r[1]), t(r[2])]); });
  const wcRows = [...wc.values()].map(([k, d, days]) => '(' + q(k) + ',' + q(d) + ',' + (days !== '' && isFinite(Number(days)) ? Number(days) : 'null') + ')');
  fs.writeFileSync(path.join(out, 'lt-1.sql'), 'truncate lt_workcenters;\ninsert into lt_workcenters (workcenter, description, lead_days) values\n' + wcRows.join(',\n') + ';\n');

  const parts = new Map();
  tr.slice(1).forEach((r) => {
    if (t(r[4]).toUpperCase() !== 'YES') return;
    const part = t(r[0]), op = t(r[1]); if (!part || !op) return;
    const key = part.toUpperCase().replace(/\s+/g, ' ');
    if (!parts.has(key)) parts.set(key, { part, ops: new Map() });
    const p = parts.get(key); if (!p.ops.has(op.toLowerCase())) p.ops.set(op.toLowerCase(), [op, t(r[2]), t(r[3])]);
  });
  const lines = [...parts.entries()].map(([key, p]) => '(' + q(key) + ',' + q(p.part) + ',' + q(JSON.stringify([...p.ops.values()].sort(opOrder))) + '::jsonb)');
  let n = 1, buf = [], size = 0;
  const flush = () => { if (!buf.length) return; n++; fs.writeFileSync(path.join(out, 'lt-' + n + '.sql'), (n === 2 ? 'truncate lt_routings;\n' : '') + 'insert into lt_routings (part_key, part, ops) values\n' + buf.join(',\n') + '\non conflict (part_key) do update set part = excluded.part, ops = excluded.ops;\n'); buf = []; size = 0; };
  lines.forEach((l) => { buf.push(l); size += l.length; if (size > 400000) flush(); });
  flush();
  console.log('work centers: ' + wc.size + ', parts with a routing: ' + parts.size + ', files: lt-1.sql .. lt-' + n + '.sql in ' + out);
})().catch((e) => { console.error(e.message); process.exit(1); });
