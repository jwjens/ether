const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Ensure mic is always in the deck order even when deckConfigs exists
c = c.replace(
  'const activeDeckOrder: DeckSlot[] = deckConfigs && deckConfigs.length > 0\n    ? deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot)\n    : DEFAULT_DECK_ORDER;',
  'const activeDeckOrder: DeckSlot[] = deckConfigs && deckConfigs.length > 0\n    ? [...deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot), ...(!deckConfigs.some(c => c.slot === "mic" && c.enabled) ? ["mic" as DeckSlot] : [])]\n    : DEFAULT_DECK_ORDER;'
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
