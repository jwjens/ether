const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  '? [...deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot), ...(!deckConfigs.some(c => c.slot === "mic" && c.enabled) ? ["mic" as DeckSlot] : [])]',
  '? deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot)'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
