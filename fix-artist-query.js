const fs = require('fs');
let f = fs.readFileSync('src/components/ImportDialog.tsx', 'utf8');
f = f.replace('WHERE title = ?", [artistName])', 'WHERE name = ?", [artistName])');
fs.writeFileSync('src/components/ImportDialog.tsx', f);
console.log('Done');
