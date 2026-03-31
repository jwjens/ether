const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
// Remove the broken hidden div we added
c = c.replace('<div style={{display:"none"}}><MenuBar', '<MenuBar');
c = c.replace('onCheckForUpdates={() => updater.checkForUpdate?.()}\n          /></div>', 'onCheckForUpdates={() => updater.checkForUpdate?.()}\n          />');
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Reverted");
