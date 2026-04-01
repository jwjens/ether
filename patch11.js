const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Change compact trigger to 5 (already correct) and make non-compact B/C narrower
// Also reset deckWidths to null for B and C
c = c.replace(
  'const [deckWidths, setDeckWidths] = useState<Record<string, number | null>>({ A: null, B: null, C: null, mic: null });',
  'const [deckWidths, setDeckWidths] = useState<Record<string, number | null>>({ A: null, B: null, C: null, mic: null, D: null, E: null, F: null });'
);

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
