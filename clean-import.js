const fs = require('fs');

console.log('\n  Cleaning up import buttons...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Fix line 404 - replace the double button mess with just the heading
app = app.replace(
  '<h1 className="text-lg font-bold">Song Library</h1><button onClick={() => setShowImport(!showImport)} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: showImport ? "#dc2626" : "#2563eb", color: "#fff", border: "none", cursor: "pointer", marginLeft: 12 }}>{showImport ? "Cancel" : "Import Folder"}</button><button onClick={() => setShowImport(!showImport)} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: showImport ? "#dc2626" : "#2563eb", color: "#fff", border: "none", cursor: "pointer", marginLeft: 12 }}>{showImport ? "Cancel" : "Import Folder"}</button>',
  '<h1 className="text-lg font-bold">Song Library</h1>'
);

// Replace the old Import button on line 421 to toggle showImport instead
app = app.replace(
  '<button onClick={handleImport} disabled={importing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold text-white">Import</button>',
  '<button onClick={() => setShowImport(!showImport)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">{showImport ? "Cancel" : "Import"}</button>'
);

// Replace the big Import Music Folder button on line 427
app = app.replace(
  '<button onClick={handleImport} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>',
  '<button onClick={() => setShowImport(true)} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>'
);

// Make sure ImportDialog is shown somewhere in the library panel
// Add it right after the track count line if not already there
if (!app.includes('{showImport && <ImportDialog')) {
  app = app.replace(
    '<span className="text-xs text-zinc-500">{count} tracks</span>\n      </div>',
    '<span className="text-xs text-zinc-500">{count} tracks</span>\n      </div>\n      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}'
  );
}

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED — one Import button opens the category picker dialog');
console.log('  App should hot-reload.\n');
