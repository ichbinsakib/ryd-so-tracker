// Builds supabase/price-updates.sql (table + the seed rows from the work mailbox) from dev/price-updates-seed.json.
const fs = require('fs');
const path = require('path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dev', 'price-updates-seed.json'), 'utf8'));
const q = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
const header = `-- Price Increase Tracking (admin only): price updates sent to Skye Ingraham, built from the work mailbox.
-- Run once in the Supabase SQL editor (project clumhidxgzfkwzwrtngi). Safe to re-run: seed rows are only added when the table is empty.
create table if not exists price_updates (
  id             uuid primary key default gen_random_uuid(),
  part_no        text not null,
  prev_price     numeric,
  new_price      numeric,
  orig_new_price numeric,                -- first proposed price when it was later revised
  sent_by        text not null default '',
  sent_date      date,                   -- date the (first) price email went to Skye
  revised_date   date,                   -- date a revised proposal went to Skye
  effective_date date,
  reply          text not null default 'none' check (reply in ('none', 'confirmed', 'disputed', 'declined')),
  reply_date     date,
  implemented    boolean,                -- null = unknown
  source_subject text not null default '',
  source_date    date,
  notes          text not null default '',
  history        jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists price_updates_part_idx on price_updates (part_no);
alter table price_updates enable row level security;
grant all on price_updates to service_role;

`;
const cols = ['part_no', 'prev_price', 'new_price', 'orig_new_price', 'sent_by', 'sent_date', 'revised_date', 'effective_date', 'reply', 'reply_date', 'implemented', 'source_subject', 'source_date', 'notes', 'history'];
const cast = { prev_price: 'numeric', new_price: 'numeric', orig_new_price: 'numeric', sent_date: 'date', revised_date: 'date', effective_date: 'date', reply_date: 'date', source_date: 'date', implemented: 'boolean' };
const lit = (c, r) => {
  if (c === 'history') return '$j$' + JSON.stringify(r.history) + '$j$::jsonb';
  const v = r[c];
  const s = v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : q(v);
  return cast[c] ? s + '::' + cast[c] : s;
};
const vals = rows.map((r) => '  (' + cols.map((c) => lit(c, r)).join(', ') + ')').join(',\n');
const sql = header + 'insert into price_updates (' + cols.join(', ') + ')\nselect * from (values\n' + vals + '\n) as v(' + cols.join(', ') + ')\nwhere not exists (select 1 from price_updates);\n';
fs.writeFileSync(path.join(__dirname, '..', 'supabase', 'price-updates.sql'), sql);
console.log('wrote supabase/price-updates.sql with ' + rows.length + ' rows');
