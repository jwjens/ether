const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  'onChange={e => { /* search handled by JockStrip */ }}',
  'value={globalSearch} onChange={e => setGlobalSearch(e.target.value)}'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
