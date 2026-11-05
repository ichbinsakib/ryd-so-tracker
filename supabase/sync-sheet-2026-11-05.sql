-- Sync from the RYD-SO worksheet, 2026-11-05. Safe to re-run.
-- 1) Add the 3 rows the app did not have.
insert into shop_orders (data, created_by)
select e, 'sheet-sync-2026-11-05'
  from jsonb_array_elements($j$[
{"notes":"KANBAN 89% ,","status":"1. ANALYSIS","champion":"KAMRUL","customer":"RAYMOND","part_no":"1116299","so_qty":704,"due_date":"2026-12-20","material_code":"6061 ALUMINUM T6511 RECTANGLE BAR 2.00 X 2.25","bar_type":"REC.","verify_qty_per_bar":"-","qty_requested":"MINIMUM 1016 LBS; 16 BARS REQUIRED; EACH BAR 12' BAR","req_mat_quote":"YES","mat_quote_request_date":"2026-10-23","need_followup":"YES","followups_required":"1","followup_email_dates":"10/27/26","quote_received":"YES","quote_receive_date":"2026-10-28","traveller_mat_price_piece":6.25,"total_price_quote":4802.25,"update_mat_cost_traveller":"YES","update_mat_cost_date":"2026-11-04","kanban_or_po":"KANBAN","so_type":"STANDARD","so_req_date":"2026-11-04","req_by":"KAMRUL"},
{"notes":"Kanban 105%, that why we need to see some days","status":"1. ANALYSIS","champion":"KAMRUL","customer":"RAYMOND","part_no":"838-004-764/001","so_qty":1260,"material_code":"0.5\" RD 1215 CDS","bar_type":"RD","verify_qty_per_bar":"-","qty_requested":"MINIMUM 48 LBS; 6 BARS REQUIRED; EACH BAR 12' BAR","req_mat_quote":"YES","mat_quote_request_date":"2026-10-24","need_followup":"YES","followups_required":"10/26","quote_received":"YES","total_price_quote":93.12},
{"notes":"11/4-Although we are not expecting a shortage, we will need one SO to cover the potential supply gap caused by the delay in placing the BPO_001_C01 order.","status":"2.RFS","champion":"KAMRUL","customer":"RAYMOND","part_no":"61152-U2430-71","so_qty":820,"due_date":"2026-12-10","material_code":"2.5 RD 8620 HR","bar_type":"RD","verify_qty_per_bar":"-","qty_requested":"MINIMUM 12300 LBS; 75 BARS REQUIRED; EACH BAR 10' BAR","req_mat_quote":"YES","mat_quote_request_date":"2026-10-23","total_price_quote":5137,"update_mat_cost_traveller":"YES","update_mat_cost_date":"2026-10-30","kanban_or_po":"KANBAN","so_type":"STANDARD","so_req_date":"2026-10-28","req_by":"KAMRUL"}
]$j$::jsonb) e
 where not exists (select 1 from shop_orders s where s.data->>'part_no' = e->>'part_no' and s.data->>'so_qty' = e->>'so_qty' and s.data->>'status' = e->>'status');

-- 2) These 3 were RFS in the app; the sheet now has them as ANR with an SO#. Update them (SO# is given, so the ANR rule is met).
update shop_orders set data = data || $j${"notes":"Need to review with Sakib Sir or munna vai, need to HR material not CF","status":"1.ANR","due_date":"2026-12-20","so_no":"25819","kanban_or_po":"KANBAN","so_type":"STANDARD","so_req_date":"2026-10-28","req_by":"KAMRUL","total_price_quote":2530,"update_mat_cost_traveller":"YES","update_mat_cost_date":"2026-10-30"}$j$::jsonb
 where data->>'status' = '2.RFS' and data->>'part_no' = '1280934' and data->>'so_qty' = '767';
update shop_orders set data = data || $j${"notes":"Kanban 9%","status":"1.ANR","due_date":"2026-11-30","so_no":"25832","kanban_or_po":"KANBAN","so_type":"STANDARD","so_req_date":"2026-10-28","req_by":"KAMRUL","appr_date":"2026-11-05","total_price_quote":151.62,"update_mat_cost_traveller":"YES","update_mat_cost_date":"2026-10-30"}$j$::jsonb
 where data->>'status' = '2.RFS' and data->>'part_no' = '1027351/002' and data->>'so_qty' = '646';
update shop_orders set data = data || $j${"notes":"mat quote req again for 3 pcs, 11/2","status":"1.ANR","due_date":"2026-11-30","so_no":"25829","kanban_or_po":"KANBAN","so_type":"STANDARD","so_req_date":"2026-10-28","req_by":"KAMRUL","appr_date":"2026-11-04","total_price_quote":226.8,"update_mat_cost_traveller":"YES","update_mat_cost_date":"2026-10-30"}$j$::jsonb
 where data->>'status' = '2.RFS' and data->>'part_no' = '115-001-858' and data->>'so_qty' = '3';

-- Result check
select data->>'status' as status, count(*) from shop_orders group by 1 order by 1;
