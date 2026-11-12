-- Subcontractor updates from the work mailbox, 2026-11-10 .. 2026-11-12. Safe to re-run: every note is added once,
-- milestone dates are only filled where the line has none, and a changed expected date keeps its first value in orig.
-- Lines are matched by BPO + batch, SO number or PO number. BPO/batch SO numbers repeat across batches, so the
-- move-ticket updates are limited to the batches that were received (BPO-001 batch 2, BPO-002 batches 1-2).

-- Helper: add a note to a line once (same text never added twice).
create or replace function pg_temp.sc_note(p_id uuid, p_kind text, p_text text) returns void language sql as $$
  insert into sc_updates (line_id, by_user, kind, text)
  select p_id, 'email 2026-11-12', p_kind, p_text
   where not exists (select 1 from sc_updates u where u.line_id = p_id and u.text = p_text);
$$;
-- Helper: set a milestone date only when the line has none.
create or replace function pg_temp.ms_fill(p_ms jsonb, p_key text, p_date text) returns jsonb language sql as $$
  select case when coalesce(p_ms->>p_key, '') = '' then coalesce(p_ms, '{}'::jsonb) || jsonb_build_object(p_key, p_date) else p_ms end;
$$;

-- 1) BPO-001-C01 (repeat of BPO-001, SUGU, 13 parts x 3 batches of 23,700 pcs).
--    Ola 11/11: CAMCO management approved moving forward on the proposal; updated price sheet sent to Kamrul to generate the POs.
--    SUGU 11/12: will return the completed document on or before 11/13. Delivery plan (Kamrul 10/23): ETA CAMCO 1/10, 3/10, 5/10/2027.
update sc_lines s
   set vendor = coalesce(nullif(s.vendor, ''), 'Sugu'),
       ms  = pg_temp.ms_fill(pg_temp.ms_fill(s.ms, 'quote_approved', '2026-11-11'), 'po_received', '2026-11-11'),
       exp = case when coalesce(s.exp->>'exp_arrival', '') = '' then coalesce(s.exp, '{}'::jsonb) || jsonb_build_object('exp_arrival',
               case s.batch when '1' then '2027-01-10' when '2' then '2027-03-10' when '3' then '2027-05-10' end) else s.exp end,
       next_action = 'SUGU returns the completed C01 document by 11/13 -> Kamrul generates the PO documents from Ola''s updated price sheet (11/11) -> SUGU reviews and acknowledges the POs',
       next_action_date = '2026-11-13',
       last_update = '2026-11-12', updated_at = now()
 where s.bpo_no = 'BPO-001-C01' and not s.closed;
select pg_temp.sc_note(id, 'CHANGE', 'Ola 11/11: CAMCO management approved moving forward with SUGU on the proposal basis (price increase not accepted; proposal was the final accommodation). Updated price sheet sent to Kamrul to generate the PO documents. SUGU 11/12: will return the completed document on or before 11/13. Delivery plan: ETA CAMCO batch 1 1/10/2027, batch 2 3/10/2027, batch 3 5/10/2027. The 5-vendor RFQ quotes (Diode, Yantai, Mulmic ...) are now a price benchmark.')
  from sc_lines where bpo_no = 'BPO-001-C01' and not closed;

-- 2) BPO-003 batches 1-3 (Diode): sample approval. Ryan 11/12: photos of 6 parts sent; 3 parts still at surface treatment
--    (CM_18926, CM_19843, CM_19929), photos about 11/13-11/14. Engineering still to decide on the tolerance requests (11/7).
update sc_lines
   set next_action = 'Get photos of the last 3 sample parts (CM_18926, CM_19843, CM_19929; at surface treatment, about 11/13-11/14) -> CAMCO Engineering decides on the tolerance changes -> sample approval -> revised PO delivery date',
       next_action_date = '2026-11-14',
       last_update = '2026-11-12', updated_at = now()
 where bpo_no = 'BPO-003' and not closed;
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Ryan 11/12: sent photos of 6 sample parts; CM_18926, CM_19843 and CM_19929 are still at the surface treatment plant (expected 11/13-11/14). Ola asked for their photos when done. Engineering decision on the tolerance requests (11/7) still open; the 11/8 PO delivery date will be revised after sample approval.')
  from sc_lines where bpo_no = 'BPO-003' and not closed;

-- 3) BPO-004 quotes. Diode: formal quote 11/11, under review, told it is among the highest (asked to improve to the target; Ryan 11/12
--    has not received the target prices). Mulmic: target DDP prices sent 11/11, Kevin checking with engineering (11/12).
--    Yantai: updated quote xlsx 11/12 (first DDP quote; check it is complete).
update sc_lines
   set next_action = 'Compare BPO-004 quotes: resend target prices to Diode (Ryan has not got them); Mulmic revised price vs target (Kevin checking); check Yantai''s 11/12 quote is complete (EXW, DDP per pc, batch shipping); then Ola sends the summary to Rich',
       next_action_date = '2026-11-13',
       last_update = '2026-11-12', updated_at = now()
 where bpo_no = 'BPO-004' and not closed;
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Quotes 11/11-11/12: Diode formal quotation sheet received 11/11 (under review; Ola says it is among the highest, asked to improve to target; Ryan 11/12 has not received the target prices). Mulmic: target DDP per pc sent 11/11, Kevin checking with engineering 11/12 (shipping cost had gone up, production cost same). Yantai (Venice): updated quote sent 11/12 (YANTAI''S QUOTE REQUEST .xlsx, first DDP quote) - confirm it is complete. Kamrul chased Ola for BPO-004/005 status 11/11 and 11/12 (no reply since 11/6).')
  from sc_lines where bpo_no = 'BPO-004' and not closed;

-- 4) BPO-005: no update from Ola since 11/6; Kamrul's 2nd follow-up 11/11-11/12. These parts have no active overseas order, so
--    in-house SOs are being opened to cover demand.
update sc_lines set last_update = '2026-11-12', updated_at = now() where bpo_no = 'BPO-005' and not closed;
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Kamrul 2nd follow-up to Ola 11/11-11/12 on BPO-004/BPO-005 quotes, negotiation and approval timeline (requests waiting 43-75 days). Rich 11/12: most of these were already made overseas - yes, but none has an active overseas order, so in-house SOs are being opened to avoid shortages. No reply from Ola since 11/6.')
  from sc_lines where bpo_no = 'BPO-005' and not closed;

-- 5) BPO-002 batch 3 (Mulmic): shipment released only after the overdue PIs are paid. Ola 11/12: WTPR-174..178 (30% down payments,
--    POs 130955-130960, due 10/7) submitted, pending AP (Mike Brown / Sarah).
update sc_lines
   set blocker_type = 'Payment',
       blocker = 'Mulmic releases the 3rd-batch shipment only after the overdue PIs are paid (30% down payments 130955J-130960J, due 10/7). WTPR-174..178 submitted 11/12, pending AP (Mike Brown / Sarah).',
       next_action = 'Get the overdue Mulmic PIs paid (WTPR-174..178, pending AP); Rich wants to confirm the parts were inspected first',
       next_action_date = '2026-11-16',
       last_update = '2026-11-12', updated_at = now()
 where bpo_no = 'BPO-002' and batch = '3' and not closed;
select pg_temp.sc_note(id, 'ESCALATION', 'Kevin (Mulmic) 11/10-11/12: PIs overdue more than a month; 3rd-batch shipment released only after payment. 30% down payments 130955J $7,351.34, 130956J $148.80, 130957J $45.60, 130958J $233.28, 130959J $4,518.10, 130960J $138.00 (due 10/7). Ola 11/12: WTPR-174..178 submitted, pending processing with Mike Brown and Sarah.')
  from sc_lines where bpo_no = 'BPO-002' and batch = '3' and not closed;

-- 6) Move tickets for received batches (Kamrul 2nd request 11/12, 8 of 18 parts have one). Inspection dates from his list.
update sc_lines s
   set ms = pg_temp.ms_fill(s.ms, 'to_inspection', v.d), last_update = '2026-11-12', updated_at = now()
  from (values ('BPO-002', '25335S', '2026-11-04'), ('BPO-001', '25217S', '2026-11-09'),
               ('BPO-002', '25333S', '2026-11-10'), ('BPO-002', '25345S', '2026-11-10')) v(bpo, so, d)
 where s.bpo_no = v.bpo and s.so_no = v.so and not s.closed
   and ((s.bpo_no = 'BPO-001' and s.batch = '2') or (s.bpo_no = 'BPO-002' and s.batch in ('1', '2')))
   and coalesce(s.ms->>'received_camco', '') <> '';
select pg_temp.sc_note(s.id, 'NOTE', 'Kamrul 11/12: went to inspection (' || v.txt || '), then repack and stock.')
  from sc_lines s join (values ('BPO-002', '25335S', '11/4'), ('BPO-001', '25217S', '11/9; 3,600 pcs'), ('BPO-002', '25333S', '11/10'),
                               ('BPO-002', '25345S', '11/10'), ('BPO-002', '25334S', '400 pcs went to repack 11/12')) v(bpo, so, txt)
    on s.bpo_no = v.bpo and s.so_no = v.so
 where not s.closed and ((s.bpo_no = 'BPO-001' and s.batch = '2') or (s.bpo_no = 'BPO-002' and s.batch in ('1', '2')))
   and coalesce(s.ms->>'received_camco', '') <> '';
--    Received but no move ticket yet: the parts cannot go to inspection/stock until one is created.
update sc_lines s
   set next_action = 'Get the move ticket created (Jay Green / Charlotte / Autumn; Kamrul 2nd request 11/12), then inspection and stock',
       next_action_date = '2026-11-13', last_update = '2026-11-12', updated_at = now()
 where not s.closed and coalesce(s.ms->>'received_camco', '') <> '' and coalesce(s.ms->>'to_inspection', '') = ''
   and ((s.bpo_no = 'BPO-001' and s.batch = '2' and s.so_no in ('25218S','25212S','25100S','25214S','25216S','25215S','25098S','25099S','25211S'))
     or (s.bpo_no = 'BPO-002' and s.batch in ('1', '2') and s.so_no = '25332S'));
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Kamrul 11/12 (2nd request): received, but no move ticket created yet - parts are not visible for inspection/stock. Asked Jay Green, Charlotte and Autumn to create it.')
  from sc_lines s
 where not s.closed and coalesce(s.ms->>'received_camco', '') <> '' and coalesce(s.ms->>'to_inspection', '') = ''
   and ((s.bpo_no = 'BPO-001' and s.batch = '2' and s.so_no in ('25218S','25212S','25100S','25214S','25216S','25215S','25098S','25099S','25211S'))
     or (s.bpo_no = 'BPO-002' and s.batch in ('1', '2') and s.so_no = '25332S'));

-- 7) P/N 1185528, SO 25090S, PO 130224 (Mulmic): 7,008 pcs received 10/24; Ship Receive move ticket still missing; Charlotte 11/12:
--    "This so is not even on the list for china". 50% shipping balance (WTPR-193, $2,200.51) pending AP.
update sc_lines
   set ms = pg_temp.ms_fill(ms, 'received_camco', '2026-10-24'),
       next_action = 'Get the Ship Receive move ticket created (Autumn / Jay) and the SO added to the China list (Charlotte); pay the 50% shipping balance (WTPR-193, pending AP)',
       next_action_date = '2026-11-13',
       last_update = '2026-11-12', updated_at = now()
 where so_no = '25090S' and regexp_replace(po_no, '[^0-9]', '', 'g') = '130224' and not closed;
select pg_temp.sc_note(id, 'FOLLOW-UP', 'Kamrul 11/10 and 11/12: 7,008 pcs received 10/24; asked Autumn/Jay to create the Ship Receive move ticket. Charlotte 11/12: this SO is not on the list for China, parts not visible in the system yet. 50% DDP shipping balance $2,200.51 (130224J, due 11/7): WTPR-193 submitted 11/12, pending AP.')
  from sc_lines where so_no = '25090S' and regexp_replace(po_no, '[^0-9]', '', 'g') = '130224' and not closed;

-- 8) Part 114-019-767 (CM_1351), PO 123788 (SO 23039R, 128 pcs) and PO 123790 (SO 23040R, 160 pcs), SUGU, 2 LCL shipments.
--    Isiaq 11/12: all cargo has arrived at the destination port; delivery after warehouse unloading, expected by 11/25
--    (replaces ETA CAMCO 11/10 and 11/14).
update sc_lines s
   set orig = s.orig || jsonb_strip_nulls(jsonb_build_object('exp_arrival',
                case when coalesce(s.exp->>'exp_arrival', '') not in ('', '2026-11-25') and not (s.orig ? 'exp_arrival') then s.exp->>'exp_arrival' end)),
       exp = coalesce(s.exp, '{}'::jsonb) || '{"exp_arrival": "2026-11-25"}'::jsonb,
       ms  = coalesce(s.ms, '{}'::jsonb) || '{"eta_camco": "2026-11-25"}'::jsonb,
       next_action = 'LCL cargo at destination port (Isiaq 11/12); delivery after warehouse unloading, expected by 11/25',
       next_action_date = '2026-11-25',
       last_update = '2026-11-12', updated_at = now()
 where s.so_no in ('23039R', '23040R') and regexp_replace(s.po_no, '[^0-9]', '', 'g') in ('123788', '123790') and not s.closed;
select pg_temp.sc_note(id, 'CHANGE', 'Isiaq 11/12: all cargo (PO 123788 128 pcs, PO 123790 160 pcs; 2 LCL shipments) has arrived at the destination port. Delivery only after the warehouse finishes unloading; expected at CAMCO by 11/25 (was 11/10 and 11/14). The remaining 240 pcs of PO 123790 will be produced with the BPO-004 quantity.')
  from sc_lines where so_no in ('23039R', '23040R') and regexp_replace(po_no, '[^0-9]', '', 'g') in ('123788', '123790') and not closed;

-- Result: the lines this file touched today.
select bpo_no, batch, so_no, po_no, blocker_type, next_action_date, left(next_action, 90) as next_action,
       (select count(*) from sc_updates u where u.line_id = s.id and u.by_user = 'email 2026-11-12') as notes_today
  from sc_lines s
 where last_update = '2026-11-12'
 order by bpo_no, batch, so_no;
