const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

c = c.replace(
  'const sizeStyle: React.CSSProperties = compact\n            ? { flex: 1, minWidth: 75, maxWidth: 200 }',
  'const sizeStyle: React.CSSProperties = compact\n            ? deckType === "desk" ? { width: 280, flexShrink: 0 } : { flex: 1, minWidth: 75, maxWidth: 200 }'
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
