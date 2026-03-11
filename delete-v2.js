const fs = require('fs');

console.log('  Adding delete button...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

app = app.replace(
  '<button onClick={() => onQueue(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white">Q</button>',
  '<button onClick={() => onQueue(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white">Q</button><button onClick={async () => { if (confirm("Delete " + s.title + "?")) { await execute("DELETE FROM songs WHERE id=?", [s.id]); load(); } }} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500 hover:text-red-400">X</button>'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  DONE — X button added after Q on each song row.\n');
