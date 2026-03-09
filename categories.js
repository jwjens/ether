const fs = require('fs');

console.log('\n  Ether — Category Assignment in Library\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add category list state to LibraryPanel
if (!app.includes('catList')) {
  app = app.replace(
    'function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {',
    'function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {\n  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);'
  );

  // Load categories alongside songs
  app = app.replace(
    '    } catch (e) { console.error(e); setStatus("Error: " + e); }\n    setLoading(false);\n  };',
    '      setCatList(await query<{ id: number; code: string; color: string | null }>("SELECT id, code, color FROM categories ORDER BY code"));\n    } catch (e) { console.error(e); setStatus("Error: " + e); }\n    setLoading(false);\n  };'
  );

  // Replace the table header to include Category column
  app = app.replace(
    `<th className="px-2 py-1.5">Fmt</th>`,
    `<th className="px-2 py-1.5">Cat</th>\n              <th className="px-2 py-1.5">Fmt</th>`
  );

  // Add category dropdown cell before format cell
  const oldRow = `<td className="px-2 py-1.5 text-zinc-500 uppercase">{s.file_path ? fmtExt(s.file_path) : "--"}</td>`;
  const newRow = `<td className="px-2 py-1.5">
                  <select value={s.category_code || ""} onChange={async (e) => {
                    const catId = catList.find(c => c.code === e.target.value)?.id || null;
                    await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]);
                    load();
                  }} className="bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1 py-0.5">
                    <option value="">—</option>
                    {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-zinc-500 uppercase">{s.file_path ? fmtExt(s.file_path) : "--"}</td>`;

  app = app.replace(oldRow, newRow);

  // Add bulk assign feature - select all visible songs to a category
  app = app.replace(
    '<button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>',
    `<select onChange={async (e) => {
          if (!e.target.value) return;
          const catId = catList.find(c => c.code === e.target.value)?.id || null;
          const ids = filtered.map(s => s.id);
          for (const id of ids) { await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, id]); }
          e.target.value = "";
          load();
        }} className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300">
          <option value="">Assign All...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>`
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (category dropdowns + bulk assign)');
} else {
  console.log('  SKIPPED — category assignment already present');
}

console.log('\n  Done! The app should hot-reload.');
console.log('');
console.log('  New in Library:');
console.log('    - Category dropdown on each song row (A/B/C/D)');
console.log('    - "Assign All" dropdown to bulk-assign visible songs');
console.log('    - Search + Assign All = assign by keyword');
console.log('      (search "Drake", Assign All → A)');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.4.1 category assignment in library"');
console.log('    git push\n');
