const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  '{!showCarts && <JockStrip deckA={deckA} deckB={deckB} dropDown />}',
  '{!showCarts && <JockStrip deckA={deckA} deckB={deckB} dropDown externalSearch={globalSearch} onSearchChange={setGlobalSearch} />}'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
