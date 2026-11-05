-- Subcontractor updates from the work mailbox, 2026-11-05. Each change also gets a note in the order's update log.

-- BPO-001-C01 (SUGU): 11/5 SUGU says it cannot proceed at the existing pricing and asks CAMCO to reconsider the freight adjustment.
-- CAMCO (Ola, 11/3) had already refused any increase and asked for a written yes / opt-out.
insert into sc_updates (line_id, by_user, kind, text)
select id, 'email 2026-11-05', 'NOTE', 'SUGU replied 11/5: cannot proceed with BPO-001-C01 at the existing pricing and asks CAMCO to reconsider a freight/price adjustment (freight about $5,800 per container when quoted, about $12,500 now). CAMCO position (Ola, 11/3): no price increase; SUGU must confirm in writing either to proceed at the agreed pricing or opt out.'
  from sc_lines where bpo_no = 'BPO-001-C01';
update sc_lines set next_action = 'SUGU declined the existing pricing (11/5) and wants an adjustment. CAMCO decides: hold firm and open a new RFQ to other vendors, or reconsider; then SO request + PO documents', last_update = '2026-11-05'
 where bpo_no = 'BPO-001-C01';

-- BPO-003 batch 1 (Diode): 11/5 Ola reminded Diode to send the sample photos, inspection reports and material certificates by 11/8.
insert into sc_updates (line_id, by_user, kind, text)
select id, 'email 2026-11-05', 'NOTE', 'Ola reminded Diode 11/5 to send sample photos, inspection reports and material certificates by 11/8. Diode said the 11/8 PO delivery date is not achievable (sample first, mass production only after CAMCO approval); a revised PO with new dates follows the sample approval.'
  from sc_lines where bpo_no = 'BPO-003' and batch = '1';
update sc_lines set next_action = 'Receive sample photos, inspection report and material certs from Diode by 11/8 (Ola reminded 11/5) → CAMCO Engineering approval → lot production → send revised PO with new ETD/ETA', next_action_date = '2026-11-08', last_update = '2026-11-05'
 where bpo_no = 'BPO-003' and batch = '1';

-- BPO-004: the RFQ went out to vendors on 11/5; replies so far.
insert into sc_updates (line_id, by_user, kind, text)
select id, 'email 2026-11-05', 'NOTE', 'RFQ for BPO-004 sent to vendors 11/5 (Ola). Replies: DSR / Siv Gan acknowledged and is preparing the quotation; Mulmic (Kevin Yeh) is out of office for a week, a colleague (Sooin) will quote; Sumech Engineers acknowledged, closed for Diwali 11/7 to 11/15 and will quote by 11/20 at the latest.'
  from sc_lines where bpo_no = 'BPO-004';
update sc_lines set next_action = 'Waiting for vendor quotes (DSR preparing; Mulmic delayed about a week; Sumech by 11/20); then Rich approves the final quote summary, mark-up/redraw-print review, SO requests and PO documents', last_update = '2026-11-05'
 where bpo_no = 'BPO-004';

select bpo_no, batch, count(*) as lines, max(last_update) as last_update from sc_lines where bpo_no in ('BPO-001-C01','BPO-003','BPO-004') group by 1, 2 order by 1, 2;
