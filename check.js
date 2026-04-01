const fs = require("fs");
// Clear deck config from localStorage by patching the storage key
let c = fs.readFileSync("C:/openair/src/components/DeckConfigurator.tsx", "utf8");
console.log("STORAGE_KEY:", c.match(/STORAGE_KEY = "([^"]+)"/)?.[1]);
