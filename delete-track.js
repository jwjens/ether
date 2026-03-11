const fs = require('fs');

console.log('\n  Ether — Delete Track\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Find the library table row where A B Q buttons are and add a delete button
// Look for the Q button pattern
if (app.includes('>Q</button>')) {
  app = app.replace(
    /(<button[^>]*>Q<\/button>)/g,
    '$1<button onClick={async () => { if (confirm("Delete \\"" + s.title + "\\"?")) { await execute("DELETE FROM songs WHERE id=?", [s.id]); load(); } }} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500 hover:text-red-400">X</button>'
  );
  console.log('  Added X delete button next to Q in library');
}

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('\n  Done! App should hot-reload.');
console.log('  X button on each song row — click to delete with confirmation.\n');
