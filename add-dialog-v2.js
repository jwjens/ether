const fs = require('fs');

console.log('  Adding ImportDialog render...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Insert right after the status line, before the loading check
app = app.replace(
  '{status ? <div className="px-3 py-1.5 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">{status}</div> : null}',
  '{status ? <div className="px-3 py-1.5 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">{status}</div> : null}\n      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  DONE — ImportDialog renders when you click Import');
console.log('  App should hot-reload.\n');
