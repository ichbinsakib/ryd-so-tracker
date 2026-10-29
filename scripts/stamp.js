// Adds ?v=<content hash> to the CSS/JS references in frontend/index.html so browsers fetch new files right after a deploy
// (GitHub Pages lets browsers cache files for 10 minutes). Run before committing frontend changes: node scripts/stamp.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = path.join(__dirname, '..', 'frontend');
const file = path.join(dir, 'index.html');
let html = fs.readFileSync(file, 'utf8');
for (const name of ['styles.css', 'config.js', 'lifecycle.js', 'app.js']) {
  const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, name))).digest('hex').slice(0, 8);
  html = html.replace(new RegExp('(href|src)="' + name.replace('.', '\\.') + '(\\?v=[0-9a-f]+)?"'), '$1="' + name + '?v=' + hash + '"');
}
fs.writeFileSync(file, html);
console.log('stamped frontend/index.html');
