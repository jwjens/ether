const fs = require('fs');
let f = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add selectedIds state
f = f.replace(
  '  const [status, setStatus] = useState("");',
  '  const [status, setStatus] = useState("");\n  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());'
);

// 2. Add bulk functions before queueAll
f = f.replace(
  '  const queueAll = () => {',
  `  const toggleSelect = (id: number) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const selectAll = () => {
    setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(s => s.id)));
  };
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm("Delete " + selectedIds.size + " song(s) from library?")) return;
    for (const id of selectedIds) await execute("DELETE FROM songs WHERE id=?", [id]);
    setSelectedIds(new Set()); load();
  };
  const deleteAll = async () => {
    if (!confirm("Delete ALL " + count + " songs? This cannot be undone.")) return;
    await execute("DELETE FROM songs", []); setSelectedIds(new Set()); load();
  };
  const queueAll = () => {`
);

// 3. Add Delete Selected / Delete All buttons next to Queue All
f = f.replace(
  '<button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>',
  `<button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>
        {selectedIds.size > 0 && <button onClick={deleteSelected} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs font-bold text-white">Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} className="px-3 py-1.5 bg-zinc-700 hover:bg-red-900 rounded text-xs font-bold text-zinc-400 hover:text-red-300">Delete All</button>`
);

// 4. Add checkbox column to table header
f = f.replace(
  '<th className="px-2 py-1.5 w-7">#</th>',
  `<th className="px-2 py-1.5 w-7"><input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={selectAll} /></th>
              <th className="px-2 py-1.5 w-7">#</th>`
);

// 5. Add checkbox to each row
f = f.replace(
  '<td className="px-2 py-1.5 text-zinc-600">{i+1}</td>',
  `<td className="px-2 py-1.5"><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                <td className="px-2 py-1.5 text-zinc-600">{i+1}</td>`
);

fs.writeFileSync('src/App.tsx', f);
console.log('Done');
