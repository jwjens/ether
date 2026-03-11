const fs = require('fs');

console.log('  Fixing broken JSX...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Remove the broken wrapper that was added around the library panel
// Fix: remove the extra <div> and </div>} that were injected

// Remove the wrapping div and import button that broke things
app = app.replace(
  '{panel === "library" && <div>{showImport && <ImportDialog onDone={() => { setShowImport(false); }} />}<div style={{ marginBottom: 12 }}><button onClick={() => setShowImport(!showImport)} style={{ padding: "8px 18px", borderRadius: "var(--radius-xs, 6px)", fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", marginRight: 8 }}>{showImport ? "Cancel Import" : "Import Folder"}</button></div>',
  '{panel === "library" && '
);

// Remove the closing </div>} that was added before clocks
app = app.replace(
  '</div>}\n          {panel === "clocks"',
  '{panel === "clocks"'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED — removed broken wrapper');
console.log('  App should hot-reload.\n');
console.log('  ImportDialog.tsx is still created and ready.');
console.log('  We will wire it in properly next.\n');
