const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Add desk type rendering in deck slot
c = c.replace(
  '} else (\n                  <OnAirDeck deck={deck} label={config?.label || "Deck " + slot} deckId={slot as "A"|"B"|"C"} onPlay={play} onPause={pause} onResume={resume} onStop={stop} onVolume={vol} onDragStart={startDeckDrag(slot as DeckSlot)} />\n                )}',
  '} : deckType === "desk" ? (\n                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 18, border: "1px solid var(--border-primary)", overflow: "hidden", display: "flex", flexDirection: "column" }}>\n                    <BoutiqueCartWall deckSlot={slot} compact={false} />\n                  </div>\n                ) : (\n                  <OnAirDeck deck={deck} label={config?.label || "Deck " + slot} deckId={slot as "A"|"B"|"C"} onPlay={play} onPause={pause} onResume={resume} onStop={stop} onVolume={vol} onDragStart={startDeckDrag(slot as DeckSlot)} />\n                )}'
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
