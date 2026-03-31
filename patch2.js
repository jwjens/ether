const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  'onChange={e => { if (e.target.value) setPanel("library"); }}',
  'onChange={e => setGlobalSearch(e.target.value)} value={globalSearch}'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
