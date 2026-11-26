/** Made-up SO documents in the same layout as CAMCO's router / traveler / material PO / supplier confirmation (no real data). */
'use strict';
const pad = (s, n) => String(s).padEnd(n);
const BASE = { so: '90001', part: 'TST-100-001', desc: 'PIN, TEST SHAFT', customer: 'RAYMOND', qty: 600, due: '12/15/2026', steel: '1 RD 1045 CF', bar: "12' BAR", pcs: 20,
  price: '21.60', cost: '1.73', po: '139001', poTotal: '1,036.80', grade: '1045', ops: [['005A', '02999', 'SHIP RECEIVE'], ['010', '52000', 'CAMCO CNC SAWS'], ['020', '53000', 'HARDINGE QUESTS'], ['050', '70000', 'INSPECTION - GENERAL'], ['060', '09241', 'STOCKROOM - DELIVER TO STOCK']] };

function router(v) {
  return [
    '             PART NUMBER                     ' + v.so + ' ROUTING                                     Wednesday, November 4, 2026',
    '          ' + pad(v.part, 24) + 'CUSTOMER: ' + pad(v.customer, 50) + "MATERIAL TYPE:  " + v.bar,
    '  ' + pad(v.desc, 93) + 'MATERIAL PCS PER :         ' + v.pcs,
    '                                  STEEL TYPE: ' + pad(v.steel, 49) + 'PART MATERIAL COST:',
    '              PART PRICE                                                                                                $' + v.cost,
    '                 $' + v.price,
    '',
    'OPERATION   WKCTR      WORKCENTER DESCRIPTION                OPERATION DESCRIPTION             CYCLE TIME             SETUP',
    ...v.ops.map((o) => '  ' + pad(o[0], 11) + pad(o[1], 11) + pad(o[2], 38) + '0.5')
  ].join('\n');
}
function traveler(v) {
  return [
    '            CAMCO TRAVELER                                                                 SHOP ORDER           ' + v.so,
    '                                                                                                NUMBER           ' + v.qty,
    'PART NUMBER                 ' + v.part,
    '                                                                                           DUE             ' + v.due,
    'PART DESCRIPTION            ' + v.desc,
    'CUSTOMER                    ' + v.customer,
    'MATERIAL TYPE               ' + v.steel,
    'PART PRICE $' + pad(v.price, 15) + 'MATERIAL COST          $' + v.cost,
    'OP # OP ID QUANTITY INITIALS DATE WORKCENTER DESCRIPTION',
    ...(v.travelerOps || v.ops).map((o, i) => pad(o[0], 5) + pad(String(12700 + i), 29) + pad(o[1], 6) + o[2])
  ].join('\n');
}
function materialPo(v) {
  return [
    '                                    PURCHASE ORDER                       PO NUMBER: ' + v.po + ' A',
    '                                                                             PO DATE: 11/2/2026',
    'VENDOR:                             SHIP TO:                     INVOICE TO:',
    ' TEST STEEL SUPPLY, INC.            CAMCO MANUFACTURING, INC.   CAMCO MANUFACTURING, INC.',
    'LINE SO#                 ITEM DESCRIPTION                        U.O.M.  UNIT PRICE EXTENDED PRICE',
    '1 ' + v.so + ' ' + v.grade + ' COLD FINISH ROUND BAR 1"                         LBS     $1.0800     $' + v.poTotal,
    'PART #: ' + v.part + '                                                            TOTAL:      $' + v.poTotal,
    'DUE DATE: 11/12/2026                                            QUOTE #: SYR - 00001'
  ].join('\n');
}
function supplier(v) {
  return [
    '                 Murphy and Nolan Inc                                 Sales Acknowledgment',
    'Your PO             ' + v.po + ' A (11/3/2026)                            Due              BY DUE DATE-11/12/2026',
    '1 Part ' + v.part + '/SO #' + v.so + '                                                       1.08/LBS                  960 LBS',
    '      Carbon StL Round Bar ' + v.grade + ' Cold Finished                                                     Item Total (USD)         ' + v.poTotal.replace(/,/g, ','),
    '                                                                                                         Net Value     ' + v.poTotal
  ].join('\n');
}
/** the app record the documents should match */
function record(v) {
  const vals = { so_no: v.so, part_no: v.part, customer: v.customer, so_qty: v.qty, due_date: '2026-12-15', part_price: ' $ 21.60 ', steel_type: '1 RD 1045 CF', material_code: '1 RD 1045 CF',
    traveller_mat_price_piece: 1.73, router_bar_size: "12' BAR", qty_per_bar: '20', po_no_1: '139001', price_on_po: 1036.8, status: '1.ANR' };
  return { id: 'test-' + v.so, values: vals, display: vals };
}
module.exports = { BASE, router, traveler, materialPo, supplier, record };
