const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  ') : !["A","B","C"].includes(slot) ? (\n                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 18, border: "1px solid var(--border-primary)", overflow: "hidden" }}>\n                    <PlaylistPlayer deckSlot={slot} color={config?.color || "#34d399"} />\n                  </div>\n                ) : (',
  ') : deckType === "desk" ? (\n                  <InlineProducerDesk episodeTitle={undefined} />\n                ) : !["A","B","C"].includes(slot) ? (\n                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 18, border: "1px solid var(--border-primary)", overflow: "hidden" }}>\n                    <PlaylistPlayer deckSlot={slot} color={config?.color || "#34d399"} />\n                  </div>\n                ) : ('
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
