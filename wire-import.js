const fs = require('fs');

console.log('\n  Wiring Import Dialog...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add import if missing
if (!app.includes('ImportDialog')) {
  app = app.replace(
    'import CartWall from "./components/CartWall";',
    'import CartWall from "./components/CartWall";\nimport ImportDialog from "./components/ImportDialog";'
  );
  console.log('  Added ImportDialog import');
}

// 2. Add showImport state if missing
if (!app.includes('showImport')) {
  app = app.replace(
    'const [showCarts, setShowCarts] = useState(false);',
    'const [showCarts, setShowCarts] = useState(false);\n  const [showImport, setShowImport] = useState(false);'
  );
  console.log('  Added showImport state');
}

// 3. Find the library panel render and add import button + dialog BEFORE existing content
// Instead of wrapping (which breaks), render them as siblings using a fragment
const libraryMatch = app.match(/\{panel === "library" && (<\w+)/);
if (libraryMatch) {
  const existingStart = '{panel === "library" && ' + libraryMatch[1];
  app = app.replace(
    existingStart,
    '{panel === "library" && <><div style={{ marginBottom: 12 }}><button onClick={() => setShowImport(!showImport)} style={{ padding: "8px 18px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: showImport ? "var(--accent-red, #dc2626)" : "var(--accent-blue, #2563eb)", color: "#fff", border: "none", cursor: "pointer" }}>{showImport ? "Cancel" : "Import Folder"}</button></div>{showImport && <ImportDialog onDone={() => setShowImport(false)} />}' + libraryMatch[1]
  );
  
  // Find the closing of the library panel and add the fragment close
  // Look for the next panel after library
  const afterLibrary = app.indexOf('{panel === "clocks"');
  if (afterLibrary > 0) {
    // Find the closing }> before clocks
    const beforeClocks = app.lastIndexOf('}', afterLibrary);
    // We need to close the fragment - insert </> before the last }
    const chunk = app.substring(0, afterLibrary);
    // Count back to find the right closing bracket for the library panel
    // Find pattern: />}\n or />} \n before clocks
    app = app.replace(
      /(\/>}\s*)\n(\s*\{panel === "clocks")/,
      '$1</>}\n$2'
    );
  }
  
  console.log('  Wired ImportDialog into Library panel');
} else {
  console.log('  WARNING: Could not find library panel pattern');
}

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('\n  Done! npm run tauri:dev\n');
