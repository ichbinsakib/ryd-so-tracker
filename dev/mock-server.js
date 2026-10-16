// LOCAL DEVELOPMENT ONLY. Serves ./frontend and an /api endpoint backed by an in-memory fake sheet
// with SYNTHETIC data, using the exact same Service/Core code as the real Apps Script backend.
// It is not connected to Google Sheets and must never be deployed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const Service = require('../backend/Service.js');
const { FakeSheet, makeRow } = require('../tests/fakeSheet.js');

const statuses = ['1. ANALYSIS', '3.OPEN', '4.CLOSE', '5.HOLD'];
const customers = ['ACME', 'GLOBEX', 'INITECH', 'UMBRELLA'];
const champs = ['ALPHA', 'BRAVO', 'CHARLIE'];
const rows = [];
for (let i = 0; i < 180; i++) {
  rows.push(makeRow(3 + i, 'id-' + (i + 1), {
    status: statuses[i % 4], champion: champs[i % 3], customer: customers[i % 4],
    part_no: i % 17 === 0 ? '00' + (1000 + i) : '10' + (10000 + i * 7), so_qty: 50 + i * 3,
    due_date: '2026-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'),
    so_no: i % 25 === 0 ? '' : 25000 + i, so_type: ['STANDARD', 'REPAIR', 'ROUGH'][i % 3], kanban_or_po: i % 2 ? 'PO' : 'KANBAN',
    notes: i % 5 === 0 ? 'Stock-' + i + ' weeks' : '', req_mat_quote: i % 2 ? 'YES' : 'NO', po_receive_date: i % 13 === 0 ? 'req.form' : '2026-09-' + String(1 + (i % 28)).padStart(2, '0'),
    part_price: ' $ ' + ((i % 9) + 1.5).toFixed(2) + ' ', so_release_status_bar: ((i * 7) % 101) + '%', mat_status_bar: [0, 18, 45, 73, 100][i % 5] + '%', steel_type: i % 6 === 0 ? '-' : '.625 OD x .120 WA A513 TP5 RD TUBING', router_bar_size: i % 6 === 0 ? '-' : "12' BAR", qty_per_bar: i % 6 === 0 ? '-' : (i % 4 === 1 ? '0' : String(20 + i)), total_price_quote: i % 7 === 0 ? 398 : ''
  }, i % 7 === 0 ? { total_price_quote: '=275*7.53' } : {}));
}
const sheet = new FakeSheet(rows);
const root = path.join(__dirname, '..', 'frontend');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = Service.handle(sheet, JSON.parse(body)); } catch (e) { out = { ok: false, code: 'BAD_REQUEST', error: 'Bad JSON' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  const f = path.join(root, req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\\/])+/, ''));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(5173, '127.0.0.1', () => console.log('DEV MOCK (synthetic data) on http://127.0.0.1:5173'));
