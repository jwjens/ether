const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Give desk slot a fixed wider width like the queue panel
c = c.replace(
  ': slot === "mic"\n                ? { width: 185, flexShrink: 0 }\n                : { flex: slot === "A" ? (isActive ? 3 : 1.5) : (slot === "B" || slot === "C") ? 0.75 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)", minWidth: (slot === "B" || slot === "C") ? 120 : 180 };',
  ': slot === "mic"\n                ? { width: 185, flexShrink: 0 }\n                : deckType === "desk"\n                ? { width: 280, flexShrink: 0 }\n                : { flex: slot === "A" ? (isActive ? 3 : 1.5) : (slot === "B" || slot === "C") ? 0.75 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)", minWidth: (slot === "B" || slot === "C") ? 120 : 180 };'
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
