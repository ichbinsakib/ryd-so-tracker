-- Subcontractor updates from the work mailbox, 2026-11-06 .. 2026-11-10. Safe to re-run: every note is added once,
-- milestone dates are only filled where the part has none, and a changed expected date keeps its first value in `orig`.
-- Parts are matched by PO number where the email gives one, otherwise by BPO.
-- Run STEP 0 first and check the lines it lists; then run the rest.

-- STEP 0 (check only): the lines this file touches.
select bpo_no, batch, order_ref, part_no, po_no, closed
  from sc_lines
 where regexp_replace(po_no, '[^0-9]', '', 'g') in ('130778','130779','130780','130781','130783','130785','130786','130787','130788','130789','130790','130791','130792','130715','130741','130949')
    or bpo_no in ('BPO-001-C01', 'BPO-002', 'BPO-003', 'BPO-004', 'BPO-005')
 order by bpo_no, batch, part_no;

-- Helper: add a note to a line once (same text never added twice).
create or replace function pg_temp.sc_note(p_id uuid, p_kind text, p_text text) returns void language sql as $$
  insert into sc_updates (line_id, by_user, kind, text)
  select p_id, 'email 2026-11-10', p_kind, p_text
   where not exists (select 1 from sc_updates u where u.line_id = p_id and u.text = p_text);
$$;

-- 1) BPO-001 3rd batch (SUGU, 13 POs, 23,700 pcs). Isiaq 11/6: picked up 10/29; vessel ETD 11/14-11/18; ETA New York 12/15;
--    ETA CAMCO about 1/15/2027 (one week later than the 1/7 given before). PO 130715 left this batch (ships with the replacements).
with l as (select * from sc_lines
            where regexp_replace(po_no, '[^0-9]', '', 'g') in ('130778','130779','130780','130781','130783','130785','130786','130787','130788','130789','130790','130791','130792'))
update sc_lines s
   set ms   = s.ms || jsonb_strip_nulls(jsonb_build_object(
                'forwarder_pickup', case when coalesce(s.ms->>'forwarder_pickup', '') = '' then '2026-10-29' end,
                'vendor_ship',      case when coalesce(s.ms->>'vendor_ship', '') = '' then '2026-10-29' end)),
       orig = s.orig || jsonb_strip_nulls(jsonb_build_object(
                'exp_ship',    case when coalesce(s.exp->>'exp_ship', '') not in ('', '2026-11-18') and not (s.orig ? 'exp_ship') then s.exp->>'exp_ship' end,
                'exp_arrival', case when coalesce(s.exp->>'exp_arrival', '') not in ('', '2027-01-15') and not (s.orig ? 'exp_arrival') then s.exp->>'exp_arrival' end)),
       exp  = s.exp || '{"exp_ship": "2026-11-18", "exp_arrival": "2027-01-15"}'::jsonb,
       next_action = 'Track vessel departure (ETD 11/14-11/18) and arrival: ETA New York 12/15, ETA CAMCO about 1/15/2027 (Isiaq, weekly updates)',
       next_action_date = '2026-11-18',
       last_update = '2026-11-10', updated_at = now()
  from l where s.id = l.id;
select pg_temp.sc_note(id, 'CHANGE', 'Isiaq 11/6: picked up by the forwarder 10/29. Vessel ETD rescheduled to 11/14-11/18; ETA New York 12/15; ETA CAMCO about 1/15/2027 (previously 1/7/2027). Expected shipment set to 11/18 and expected arrival to 1/15/2027. PO 130715 was removed from this batch and ships separately with the replacement for PO 130741.')
  from sc_lines where regexp_replace(po_no, '[^0-9]', '', 'g') in ('130778','130779','130780','130781','130783','130785','130786','130787','130788','130789','130790','130791','130792');

-- 2) Part 1085919 (CM_19461), PO 130715 and PO 130741: quality hold. Ola 11/5: SUGU's replacements ship together around the end of
--    November and will miss the 12/10 ETA, so CAMCO reworks the held parts itself and charges SUGU the documented labour hours;
--    the parts are NOT returned to SUGU. Kamrul 11/10: created replacement POs 132793 and 132794 (SO 25821S, 2,760 pcs each) for Ola to review.
update sc_lines
   set blocker_type = 'Quality hold',
       blocker = 'Non-conformance on PO 130715 and PO 130741 (2,760 pcs each). CAMCO reworks the parts in house and charges SUGU the labour; replacements ship late November (ETA not confirmed, misses 12/10).',
       next_action = 'Ola to review replacement POs 132793 / 132794 (SO 25821S, 2,760 pcs each) and send them to SUGU; get the replacement shipping schedule; record rework labour hours for the SUGU charge',
       next_action_date = '2026-11-13',
       last_update = '2026-11-10', updated_at = now()
 where regexp_replace(po_no, '[^0-9]', '', 'g') in ('130715', '130741');
select pg_temp.sc_note(id, 'NOTE', 'Ola 11/5: SUGU will ship the replacements for PO 130715 and PO 130741 together around the end of November (schedule not confirmed), which misses the agreed 12/10 ETA. CAMCO will rework the affected parts itself and charge SUGU the documented labour hours; the parts will not be returned to SUGU. Kamrul 11/10: created replacement POs 132793 and 132794 (SO 25821S, 2,760 pcs each) and sent them to Ola for review.')
  from sc_lines where regexp_replace(po_no, '[^0-9]', '', 'g') in ('130715', '130741');

-- 3) BPO-001-C01: SUGU pricing and the new RFQ.
--    SUGU 11/6: price request came from details (materials, packaging, shipping) not settled in the first BPO. Ola 11/9: management stays
--    firm on no increase, but sent a final-accommodation proposal; the decision is with SUGU. Ola 11/9 also sent the BPO-001-C01 RFQ
--    (13 parts) to other vendors, quotes due 11/13; Rich 11/10 told Mulmic 11/17 at the latest. Mulmic 11/10: will quote by 11/17.
--    Rich 11/10: Mulmic's recent quotes are well above CAMCO's own cost.
update sc_lines
   set next_action = 'SUGU to accept or reject CAMCO''s final proposal (sent 11/9). In parallel: collect the BPO-001-C01 RFQ quotes (due 11/13; Mulmic by 11/17) and compare DDP prices',
       next_action_date = '2026-11-13',
       last_update = '2026-11-10', updated_at = now()
 where bpo_no = 'BPO-001-C01' and not closed;
select pg_temp.sc_note(id, 'NOTE', 'SUGU 11/6: the price request came from materials, packaging and shipping details not settled during the first BPO; says it will not happen in future quotes. Ola 11/9: CAMCO management stays firm on no price increase but sent a final-accommodation proposal; the decision is now with SUGU. Ola 11/9: RFQ for BPO-001-C01 (13 parts) sent to other vendors, quotes due 11/13; Rich 11/10 told Mulmic 11/17 at the latest and that its recent quotes are well above CAMCO''s own cost; Mulmic 11/10 confirmed capacity and will quote by 11/17.')
  from sc_lines where bpo_no = 'BPO-001-C01';

-- 4) BPO-002, PO 130949 (Mulmic, RYD 1017345, 4,368 pcs, SO 25332S). Isiaq 11/6: picked up 10/21, vessel departed 10/28,
--    ETA New York 11/22, ETA CAMCO 12/1-12/5. NOTE ONLY: Kamrul's 11/10 move-ticket email lists 1017345 under BPO_002 as received 10/28,
--    which conflicts with this; check before entering dates.
select pg_temp.sc_note(id, 'NOTE', 'Isiaq 11/6 (PO 130949, BPO-002 2nd batch, Mulmic): picked up 10/21, vessel departed 10/28, ETA New York 11/22, ETA CAMCO 12/1-12/5. Check: Kamrul''s 11/10 move-ticket email lists 1017345 (SO 25332S, 4,368 pcs) as received 10/28.')
  from sc_lines where regexp_replace(po_no, '[^0-9]', '', 'g') = '130949';

-- 5) BPO-002: Mulmic payment reminder (11/9). Mulmic will release the 3rd batch shipment of SUB_BPO-002 only after the overdue PIs are paid:
--    130224J shipping 50% balance $2,200.51 (due 11/7); 129817J $917.28 and 129821J $661.50 production 70% balance (due 10/7);
--    130955J-130960J 30% down payments $7,351.34 / $148.80 / $45.60 / $233.28 / $4,518.10 / $138.00 (due 10/7).
--    Kamrul 11/10 also asked Ola when the next BPO-002 cycle and its quotation process start (114-006-609/001, 838-004-371, 838-004-764/002, 1017345, 1079582).
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Mulmic 11/9: the 3rd batch shipment of SUB_BPO-002 is released only after the overdue PIs are paid: 130224J shipping 50% balance $2,200.51 (due 11/7); 129817J $917.28 and 129821J $661.50 production balance (due 10/7); down payments 130955J $7,351.34, 130956J $148.80, 130957J $45.60, 130958J $233.28, 130959J $4,518.10, 130960J $138.00 (due 10/7). Kamrul 11/10 asked Ola when the next BPO-002 cycle and its quotation process start.')
  from sc_lines where bpo_no = 'BPO-002' and not closed;

-- 6) BPO-003 (Diode): samples. Diode 11/7 sent the material report and sample photos; its inspection found dimensional issues and it asks
--    to widen tolerances: CM_1219 REV-02 dim 10 to 0.19-0.21; CM_18328 REV-00 dim 7 to 0.105-0.125, dim 13 to 0.035-0.055, dim 14 to 0.01-0.03;
--    CM_19843 REV-00 dim 19 to 1.500-1.505; CM_0563 REV-01 dim 11 to 0.97-1.01; CM_19932 REV-02 dim 2A to 0.25-0.30 (inches).
--    Ola 11/9 (follow-up 11/10): Engineering is reviewing; asked for at least 6 clear photos per part. Diode 11/10: photos in 1-2 days.
update sc_lines
   set blocker_type = 'Drawing approval',
       blocker = 'Diode asks to widen tolerances on CM_1219, CM_18328, CM_19843, CM_0563 and CM_19932 after its sample inspection; Engineering review pending',
       next_action = 'Receive at least 6 photos per sample part from Diode (promised 11/11-11/12) -> CAMCO Engineering decides on the tolerance changes -> sample approval -> lot production -> revised PO with new dates',
       next_action_date = '2026-11-12',
       last_update = '2026-11-10', updated_at = now()
 where bpo_no = 'BPO-003' and not closed;
select pg_temp.sc_note(id, 'NOTE', 'Diode 11/7: sent material report and sample photos; no inspection report yet because its inspection found dimensional issues. Requests wider tolerances: CM_1219 REV-02 dim 10 to 0.19-0.21; CM_18328 REV-00 dim 7 to 0.105-0.125, dim 13 to 0.035-0.055, dim 14 to 0.01-0.03; CM_19843 REV-00 dim 19 to 1.500-1.505; CM_0563 REV-01 dim 11 to 0.97-1.01; CM_19932 REV-02 dim 2A to 0.25-0.30 (inches). Ola 11/9, follow-up 11/10: Engineering reviewing; asked for at least 6 clear photos per part. Diode 11/10: photos in 1-2 days.')
  from sc_lines where bpo_no = 'BPO-003';

-- 7) BPO-004: quotations received. Mulmic 11/7 (missing total DDP cost per piece; asked 11/10), Yantai Hongyuan (Venice) 11/8
--    (needs EXW label and consolidated shipping per batch; asked 11/10), Diode 11/9 (missing consolidated shipping per batch; asked 11/10).
--    Sumech: quote by 11/20 (Diwali 11/7-11/15). Ola 11/6: Rich wants three quotations before approval; CM_1351 (114-019-767) pricing is key.
update sc_lines
   set ms = case when coalesce(ms->>'quote_received', '') = '' then ms || '{"quote_received": "2026-11-07"}'::jsonb else ms end,
       next_action = 'Get the completed quotes (Mulmic: DDP per piece; Yantai: EXW label + batch shipping; Diode: batch shipping; Sumech by 11/20), compare, then Ola takes the summary to Rich for approval (CM_1351 pricing is key)',
       next_action_date = '2026-11-13',
       last_update = '2026-11-10', updated_at = now()
 where bpo_no = 'BPO-004' and not closed;
select pg_temp.sc_note(id, 'NOTE', 'Quotes received: Mulmic 11/7, Yantai Hongyuan (Venice) 11/8, Diode 11/9. Ola 11/10 asked each to complete them: Mulmic to add total DDP cost per piece; Yantai to label EXW unit price and add consolidated DDP shipping per batch; Diode to add consolidated DDP shipping per batch. Sumech to quote by 11/20 (Diwali). Ola 11/6: Rich wants three quotations before approval; CM_1351 (114-019-767) pricing is a key factor.')
  from sc_lines where bpo_no = 'BPO-004';

-- 8) BPO-005: Ola 11/6: at the RFQ / quotation stage; all items are Mulmic parts machined before; only price negotiation remains.
update sc_lines
   set next_action = 'Ola negotiates pricing with Mulmic (all BPO-005 parts were machined by Mulmic before), then approval, SO requests and PO documents',
       last_update = '2026-11-10', updated_at = now()
 where bpo_no = 'BPO-005' and not closed;
select pg_temp.sc_note(id, 'NOTE', 'Ola 11/6 (reply to Kamrul''s 11/5 follow-up): BPO-005 is at the RFQ / quotation stage; all items belong to Mulmic and were machined before; the remaining step is price negotiation, expected without a long delay.')
  from sc_lines where bpo_no = 'BPO-005';

-- Result: lines touched and notes added today.
select l.bpo_no, l.batch, count(distinct l.id) as lines, count(u.id) as notes_today
  from sc_lines l left join sc_updates u on u.line_id = l.id and u.by_user = 'email 2026-11-10'
 where l.last_update = '2026-11-10'
 group by 1, 2 order by 1, 2;
