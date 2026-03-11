const fs = require('fs');

console.log('\n  Wiring Import Dialog into LibraryPanel...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add import at top if missing
if (!app.includes('ImportDialog')) {
  app = app.replace(
    'import CartWall from "./components/CartWall";',
    'import CartWall from "./components/CartWall";\nimport ImportDialog from "./components/ImportDialog";'
  );
  console.log('  Added ImportDialog import');
}

// Add showImport state inside LibraryPanel function
if (!app.includes('showImport')) {
  app = app.replace(
    'function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {',
    'function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {\n  const [showImport, setShowImport] = useState(false);'
  );
  console.log('  Added showImport state');
}

// Add import button next to "Song Library" heading
app = app.replace(
  '<h1 className="text-lg font-bold">Song Library</h1>',
  '<h1 className="text-lg font-bold">Song Library</h1><button onClick={() => setShowImport(!showImport)} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: showImport ? "#dc2626" : "#2563eb", color: "#fff", border: "none", cursor: "pointer", marginLeft: 12 }}>{showImport ? "Cancel" : "Import Folder"}</button>'
);

// Add ImportDialog right after the heading row
app = app.replace(
  '<span className="text-xs text-zinc-500">{count} tracks</span>\n      </div>',
  '<span className="text-xs text-zinc-500">{count} tracks</span>\n      </div>\n      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  Added Import Folder button + dialog to Library\n');
console.log('  npm run tauri:dev\n');
