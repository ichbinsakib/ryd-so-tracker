-- Move 1089505, 114-008-674 and 838-004-428 from BPO-004 to BPO-005.
-- Why: the revised BPO-004 part list (Ola to SUGU, 9/28, 16 parts) does not contain them, Ola's 10/23 email says BPO-005 is the next package
-- after BPO-004 with more parts added, and the user confirmed they went on BPO-005. (Kamrul's 10/20 sheet labels them BPO_004.)
update sc_lines
   set bpo_no = 'BPO-005', batch = '', ms = jsonb_build_object('rfq', '2026-09-17'), review_status = '',
       next_action = 'Confirm the BPO-005 part list with Ola; get the CAMCO part number',
       note = 'Added 11/5 to BPO-005. Not in the revised BPO-004 part list (9/28); Kamrul''s 10/20 sheet labels this part BPO_004. CAMCO part number pending.',
       last_update = '2026-11-05'
 where created_by = 'email-sync 2026-11-05' and bpo_no = 'BPO-004' and ryd_part in ('1089505', '114-008-674', '838-004-428');

select bpo_no, order_ref, part_no, review_status from sc_lines where created_by = 'email-sync 2026-11-05' order by order_ref;
