-- Lead time calculator (from the LT worksheet): routing steps per part (TRAVELLER sheet) and days per work center (CT sheet).
-- Run once in the SQL editor, then load the data with the files made by `node scripts/gen-leadtime-sql.js`.
create table if not exists lt_workcenters (
  workcenter  text primary key,
  description text not null default '',
  lead_days   numeric
);
create table if not exists lt_routings (
  part_key text primary key,        -- upper-cased part number
  part     text not null,
  ops      jsonb not null           -- [[op, workcenter, description], ...] sorted like the sheet (numbers first, then text)
);
alter table lt_workcenters enable row level security;
alter table lt_routings enable row level security;
grant all on lt_workcenters, lt_routings to service_role;
