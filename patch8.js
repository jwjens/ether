const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Find and remove the MenuBar component from the header
// It renders File View Library Schedule Tools Help
const menuBarStart = c.indexOf('<MenuBar\n            active={panel}');
const menuBarEnd = c.indexOf('/>', menuBarStart) + 2;
if (menuBarStart > -1) {
  c = c.slice(0, menuBarStart) + c.slice(menuBarEnd);
  console.log("Removed MenuBar");
}

// Remove the separator div right after where MenuBar was
c = c.replace(
  '\n          <div style={{ width: 1, height: 16, background: "var(--border-primary)" }} />\n          <SessionNameBar',
  '\n          <SessionNameBar'
);

// Remove search + toolbar from header (CENTER section we added)
const centerStart = c.indexOf('{/* CENTER: Toolbar + Search */}');
const centerEnd = c.indexOf('{/* RIGHT: Status controls */}', centerStart);
if (centerStart > -1 && centerEnd > -1) {
  c = c.slice(0, centerStart) + c.slice(centerEnd);
  console.log("Removed center toolbar");
}

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
