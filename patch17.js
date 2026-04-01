const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Add InlineProducerDesk import
c = c.replace(
  'import ProducerDesk from "./components/ProducerDesk";',
  'import ProducerDesk, { InlineProducerDesk } from "./components/ProducerDesk";'
);

// Replace BoutiqueCartWall with InlineProducerDesk for desk type
c = c.replace(
  '} : deckType === "desk" ? (\n                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 18, border: "1px solid var(--border-primary)", overflow: "hidden", display: "flex", flexDirection: "column" }}>\n                    <BoutiqueCartWall deckSlot={slot} compact={false} />\n                  </div>\n                ) : (',
  '} : deckType === "desk" ? (\n                  <InlineProducerDesk episodeTitle={undefined} />\n                ) : ('
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
