const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");
// Wrap MenuBar in display:none
c = c.replace(
  '<MenuBar\n            active={panel}',
  '<div style={{display:"none"}}><MenuBar\n            active={panel}'
);
// Close the hidden div after MenuBar
c = c.replace(
  'onCheckForUpdates={() => updater.checkForUpdate?.()}\n          />\n          <div style={{ width: 1',
  'onCheckForUpdates={() => updater.checkForUpdate?.()}\n          /></div>\n          <div style={{ width: 1'
);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
