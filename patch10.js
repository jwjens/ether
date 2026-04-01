const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
c = c.replace(
  ': { flex: isActive ? 3 : (slot === "B" || slot === "C") ? 0.65 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)", minWidth: (slot === "B" || slot === "C") ? 120 : 160 };',
  ': { flex: slot === "A" ? (isActive ? 3 : 1.5) : (slot === "B" || slot === "C") ? 0.75 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)", minWidth: (slot === "B" || slot === "C") ? 120 : 180 };'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
