const fs = require('fs');
let f = fs.readFileSync('src/components/ImportDialog.tsx', 'utf8');

f = f.replace(
  `    setProgress({ done: 0, total: files.length, current: "Importing..." });`,
  `    setProgress({ done: 0, total: files.length, current: "Importing..." });

    // DEBUG: log actual DB schema
    const songCols = await query<{name:string}>("PRAGMA table_info(songs)");
    console.log("SONGS TABLE COLS:", (songCols as any[]).map(c=>c.name).join(", "));
    const albCols = await query<{name:string}>("PRAGMA table_info(albums)");
    console.log("ALBUMS TABLE COLS:", (albCols as any[]).map(c=>c.name).join(", "));`
);

fs.writeFileSync('src/components/ImportDialog.tsx', f);
console.log('Done');
