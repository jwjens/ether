const fs = require('fs');
let f = fs.readFileSync('src/db/client.ts', 'utf8');

// Add album column migration after the existing ALTER TABLE tries
const target = `  try { await d.execute("ALTER TABLE categories ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"); } catch {}`;
const addition = `
  // Fix albums table - rename 'name' to 'title' if needed
  try {
    await d.execute("ALTER TABLE albums RENAME COLUMN name TO title");
  } catch {}`;

f = f.replace(target, target + addition);
fs.writeFileSync('src/db/client.ts', f);
console.log('Done');
