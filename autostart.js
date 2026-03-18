const fs = require('fs');
let f = fs.readFileSync('src/App.tsx', 'utf8');

f = f.replace(
  'if (q.length >= 1) await engine.loadToDeck("B", q[0].filePath, q[0].title, q[0].artist);\n          if (q.length >= 2) await engine.loadToDeck("C" as any, q[1].filePath, q[1].title, q[1].artist);',
  `if (q.length >= 1) {
            try {
              await engine.loadToDeck("B", q[0].filePath, q[0].title, q[0].artist);
              console.log("B loaded ok:", q[0].title);
            } catch(e) { console.error("B load failed:", e); }
          }
          if (q.length >= 2) {
            try {
              await engine.loadToDeck("C" as any, q[1].filePath, q[1].title, q[1].artist);
              console.log("C loaded ok:", q[1].title);
            } catch(e) { console.error("C load failed:", e); }
          }`
);

fs.writeFileSync('src/App.tsx', f);
console.log('Done');
