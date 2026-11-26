/** Tiny text-only PDF writer for SO Review test fixtures: one Courier line per text line, so `pdftotext -layout` gives the text back. */
'use strict';
function pdf(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '?');
  const pages = [];
  for (let i = 0; i < lines.length; i += 65) pages.push(lines.slice(i, i + 65));
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const kids = [];
  pages.forEach((pl) => {
    // each field (text between runs of 2+ spaces) is placed at its own column, like the real CAMCO forms,
    // so pdftotext -layout rebuilds the same columns
    const parts = [];
    pl.forEach((l, row) => { const re = /\S+(?: \S+)*/g; let m; while ((m = re.exec(l))) parts.push('1 0 0 1 ' + (20 + m.index * 4.8).toFixed(1) + ' ' + (1270 - row * 18) + ' Tm (' + esc(m[0]) + ') Tj'); });
    const body = 'BT /F1 8 Tf\n' + parts.join('\n') + '\nET';
    const content = add('<< /Length ' + Buffer.byteLength(body) + ' >>\nstream\n' + body + '\nendstream');
    kids.push(add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 1000 1300] /Resources << /Font << /F1 ' + font + ' 0 R >> >> /Contents ' + content + ' 0 R >>'));
  });
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>';
  objs[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}
module.exports = { pdf };
