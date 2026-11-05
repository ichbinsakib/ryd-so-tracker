-- Status catch-up from the RYD-SO worksheet, 2026-11-05. Safe to re-run.
-- 10 ANR orders are OPEN in the sheet.
update shop_orders set data = jsonb_set(data, '{status}', '"3.OPEN"')
 where data->>'status' = '1.ANR' and data->>'so_no' in ('25787','25788','25797','25798','25799','25800','25801','25802','25803','25808');
-- 2 of the 3 RFS rows for part 61152-U2430-71 (1025 pcs) are on HOLD in the sheet.
update shop_orders set data = jsonb_set(data, '{status}', '"5.HOLD"')
 where row_no in (select row_no from shop_orders where data->>'status' = '2.RFS' and data->>'part_no' = '61152-U2430-71' and data->>'so_qty' = '1025' order by row_no limit 2);
select data->>'status' as status, count(*) from shop_orders group by 1 order by 1;
