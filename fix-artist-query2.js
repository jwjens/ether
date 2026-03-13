const fs = require('fs');
let f = fs.readFileSync('src/components/ImportDialog.tsx', 'utf8');
// Fix the second artist lookup after INSERT
f = f.replace(
  'artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE title = ?", [artistName]);',
  'artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artistName]);'
);
fs.writeFileSync('src/components/ImportDialog.tsx', f);
console.log('Done');
