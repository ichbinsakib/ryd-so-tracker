-- Add 4 parts that the emails and Kamrul's 10/20 analysis sheet place in BPO-004 / BPO-005 but the app did not list.
-- CAMCO part numbers are not known yet, so Part # holds the RYD number for now; replace it on each order page. Safe to re-run.
with mx as (select coalesce(max(substring(order_ref from 5)::int), 0) as m from sc_lines where order_ref ~ '^SUB-[0-9]+$'),
new_parts(n, bpo, batch, ryd, usage, sib_bpo, sib_part, rfq, nxt, note) as (values
  (1, 'BPO-005', '',    '838-004-618', '1,800', 'BPO-005', '1208',  '2026-09-28', 'Confirm with Ola that 838-004-618 is on the BPO-005 list (Abid asked 9/28 and 9/30); get the CAMCO part number', 'Added 11/5 from email (Abid 9/28: triggered on Kanban, add to BPO-005) and Kamrul''s 10/20 sheet (SUB. BATCH = BPO_005). CAMCO part number pending.'),
  (2, 'BPO-004', '1-3', '1089505',    '4,540', 'BPO-004', '18581', null,         'Get the CAMCO part number; part follows the BPO-004 quote review', 'Added 11/5: Kamrul''s 10/20 sheet shows BPO_004 for this part. CAMCO part number pending.'),
  (3, 'BPO-004', '1-3', '114-008-674','2,000', 'BPO-004', '18581', null,         'Get the CAMCO part number; part follows the BPO-004 quote review', 'Added 11/5: Kamrul''s 10/20 sheet shows BPO_004 for this part. CAMCO part number pending.'),
  (4, 'BPO-004', '1-3', '838-004-428','2,830', 'BPO-004', '18581', null,         'Get the CAMCO part number; part follows the BPO-004 quote review', 'Added 11/5: Kamrul''s 10/20 sheet shows BPO_004 for this part. CAMCO part number pending.')
)
insert into sc_lines (order_ref, bpo_no, batch, part_no, ryd_part, description, qty, priority, owner, ms, so_required, sub_required, decision_note, team_member, comm_ref, review_status, next_action, last_update, note, created_by)
select 'SUB-' || lpad((mx.m + p.n)::text, 4, '0'), p.bpo, p.batch, p.ryd, p.ryd, 'RYD ' || p.ryd, 0, 'NORMAL', s.owner,
       case when p.rfq is null then s.ms else jsonb_build_object('rfq', p.rfq) end, 'YES', 'YES', 'Annual usage: ' || p.usage, s.team_member, 'EMAIL – BPO-005 / BPO-004 part list (Abid, Kamrul)',
       s.review_status, p.nxt, '2026-11-05', p.note, 'email-sync 2026-11-05'
  from new_parts p cross join mx
  join sc_lines s on s.bpo_no = p.sib_bpo and s.part_no = p.sib_part
 where not exists (select 1 from sc_lines x where x.bpo_no = p.bpo and (x.ryd_part = p.ryd or x.description = 'RYD ' || p.ryd));

select bpo_no, batch, part_no, ryd_part, order_ref, review_status from sc_lines where created_by = 'email-sync 2026-11-05' order by order_ref;

-- 838-004-618 copied the review status of its BPO-005 neighbour; it has none of its own yet.
update sc_lines set review_status = '' where order_ref = 'SUB-0153' and created_by = 'email-sync 2026-11-05' and bpo_no = 'BPO-005';
