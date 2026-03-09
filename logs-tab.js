const fs = require('fs');

console.log('\n  Ether — Logs Tab (Play History)\n');

// ============================================================
// 1. Add play_log table to migrations
// ============================================================

let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('play_log')) {
  client = client.replace(
    '  console.log("DB ready");',
    '  await d.execute("CREATE TABLE IF NOT EXISTS play_log (id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER, title TEXT NOT NULL, artist TEXT, file_path TEXT, category_code TEXT, show_name TEXT, clock_name TEXT, deck TEXT, played_at INTEGER NOT NULL DEFAULT (unixepoch()))");\n  console.log("DB ready");'
  );
  fs.writeFileSync('src/db/client.ts', client, 'utf8');
  console.log('  UPDATED client.ts (play_log table)');
}

// ============================================================
// 2. Update engine to emit play events we can log
// ============================================================

let engineCode = fs.readFileSync('src/audio/engine.ts', 'utf8');
if (!engineCode.includes('onPlayStart')) {
  engineCode = engineCode.replace(
    '  private listeners = new Set<Listener>();',
    '  private listeners = new Set<Listener>();\n  private playStartCallbacks = new Set<(deckId: DeckId, title: string, artist: string, filePath: string) => void>();'
  );
  engineCode = engineCode.replace(
    '  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }',
    '  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }\n  onPlayStart(fn: (deckId: DeckId, title: string, artist: string, filePath: string) => void): () => void { this.playStartCallbacks.add(fn); return () => this.playStartCallbacks.delete(fn); }'
  );
  engineCode = engineCode.replace(
    '  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string) {\n    this.init(); const d = this.getDeck(id); if (d) await d.load(filePath, title, artist);\n  }',
    '  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string) {\n    this.init(); const d = this.getDeck(id); if (d) await d.load(filePath, title, artist);\n  }\n\n  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {\n    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));\n  }'
  );

  // Notify on play in Deck class
  engineCode = engineCode.replace(
    "    this.source = src; this.startedAt = this.ctx.currentTime;\n    this.offset = fromSec; this.status = \"playing\"; this.emit();",
    "    this.source = src; this.startedAt = this.ctx.currentTime;\n    this.offset = fromSec; this.status = \"playing\"; this.emit();\n    if (fromSec === 0) { (globalThis as any).__etherEngine?.notifyPlayStart(this.id, this.title, this.artist, this.filePath); }"
  );

  fs.writeFileSync('src/audio/engine.ts', engineCode, 'utf8');
  console.log('  UPDATED engine.ts (play start events)');
}

// ============================================================
// 3. Create Logs component
// ============================================================

fs.mkdirSync('src/components', { recursive: true });
fs.writeFileSync('src/components/Logs.tsx', [
'import { useState, useEffect } from "react";',
'import { query, execute } from "../db/client";',
'',
'interface LogEntry {',
'  id: number;',
'  title: string;',
'  artist: string | null;',
'  category_code: string | null;',
'  show_name: string | null;',
'  clock_name: string | null;',
'  deck: string | null;',
'  played_at: number;',
'}',
'',
'function fmtTimestamp(epoch: number): string {',
'  const d = new Date(epoch * 1000);',
'  return d.toLocaleTimeString();',
'}',
'',
'function fmtDate(epoch: number): string {',
'  const d = new Date(epoch * 1000);',
'  return d.toLocaleDateString();',
'}',
'',
'export default function Logs() {',
'  const [entries, setEntries] = useState<LogEntry[]>([]);',
'  const [total, setTotal] = useState(0);',
'  const [filter, setFilter] = useState<"today" | "all">("today");',
'',
'  const load = async () => {',
'    let where = "";',
'    if (filter === "today") {',
'      const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);',
'      where = " WHERE played_at >= " + startOfDay;',
'    }',
'    const rows = await query<LogEntry>("SELECT * FROM play_log" + where + " ORDER BY played_at DESC LIMIT 200");',
'    setEntries(rows);',
'    const r = await query<{ c: number }>("SELECT COUNT(*) as c FROM play_log" + where);',
'    setTotal(r.length > 0 ? r[0].c : 0);',
'  };',
'',
'  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [filter]);',
'',
'  const clearLog = async () => {',
'    await execute("DELETE FROM play_log");',
'    load();',
'  };',
'',
'  const exportCSV = () => {',
'    const header = "Time,Title,Artist,Category,Show,Clock,Deck";',
'    const rows = entries.map(e => {',
'      const time = new Date(e.played_at * 1000).toISOString();',
'      return [time, e.title, e.artist || "", e.category_code || "", e.show_name || "", e.clock_name || "", e.deck || ""].map(f => \'"\' + String(f).replace(/"/g, \'""\'  ) + \'"\').join(",");',
'    });',
'    const csv = header + "\\n" + rows.join("\\n");',
'    const blob = new Blob([csv], { type: "text/csv" });',
'    const url = URL.createObjectURL(blob);',
'    const a = document.createElement("a");',
'    a.href = url;',
'    a.download = "ether-log-" + new Date().toISOString().split("T")[0] + ".csv";',
'    a.click();',
'    URL.revokeObjectURL(url);',
'  };',
'',
'  // Stats',
'  const uniqueArtists = new Set(entries.filter(e => e.artist).map(e => e.artist)).size;',
'  const uniqueSongs = new Set(entries.map(e => e.title)).size;',
'',
'  return (',
'    <div className="space-y-3">',
'      <div className="flex items-center justify-between">',
'        <h1 className="text-lg font-bold">Play Log</h1>',
'        <div className="flex items-center gap-2">',
'          <button onClick={() => setFilter("today")} className={filter === "today" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>Today</button>',
'          <button onClick={() => setFilter("all")} className={filter === "all" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>All Time</button>',
'          <button onClick={exportCSV} className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Export CSV</button>',
'          <button onClick={clearLog} className="px-3 py-1 bg-zinc-800 hover:bg-red-900 rounded text-xs font-bold text-zinc-400 hover:text-red-400">Clear</button>',
'        </div>',
'      </div>',
'',
'      <div className="grid grid-cols-3 gap-3">',
'        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">',
'          <div className="text-2xl font-bold text-zinc-100">{total}</div>',
'          <div className="text-[10px] text-zinc-500 uppercase">Songs Played</div>',
'        </div>',
'        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">',
'          <div className="text-2xl font-bold text-zinc-100">{uniqueArtists}</div>',
'          <div className="text-[10px] text-zinc-500 uppercase">Unique Artists</div>',
'        </div>',
'        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">',
'          <div className="text-2xl font-bold text-zinc-100">{uniqueSongs}</div>',
'          <div className="text-[10px] text-zinc-500 uppercase">Unique Songs</div>',
'        </div>',
'      </div>',
'',
'      {entries.length === 0 ? (',
'        <div className="text-center py-12">',
'          <div className="text-zinc-400 text-lg mb-2">No plays yet</div>',
'          <div className="text-zinc-600 text-xs">Start playing music and the log will appear here.</div>',
'        </div>',
'      ) : (',
'        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">',
'          <table className="w-full text-xs">',
'            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">',
'              <th className="px-3 py-2">Time</th>',
'              <th className="px-3 py-2">Title</th>',
'              <th className="px-3 py-2">Artist</th>',
'              <th className="px-3 py-2">Cat</th>',
'              <th className="px-3 py-2">Show</th>',
'              <th className="px-3 py-2">Deck</th>',
'            </tr></thead>',
'            <tbody>{entries.map(e => (',
'              <tr key={e.id} className="border-b border-zinc-800 hover:bg-zinc-800">',
'                <td className="px-3 py-1.5 text-zinc-400 font-mono">{fmtTimestamp(e.played_at)}</td>',
'                <td className="px-3 py-1.5 text-zinc-100">{e.title}</td>',
'                <td className="px-3 py-1.5 text-zinc-400">{e.artist || ""}</td>',
'                <td className="px-3 py-1.5 text-zinc-500">{e.category_code || ""}</td>',
'                <td className="px-3 py-1.5 text-zinc-500">{e.show_name || ""}</td>',
'                <td className="px-3 py-1.5 text-zinc-500">{e.deck || ""}</td>',
'              </tr>',
'            ))}</tbody>',
'          </table>',
'        </div>',
'      )}',
'    </div>',
'  );',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/components/Logs.tsx');

// ============================================================
// 4. Wire into App.tsx
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('import Logs')) {
  // Add import
  app = app.replace(
    'import Scheduler from "./components/Scheduler";',
    'import Scheduler from "./components/Scheduler";\nimport Logs from "./components/Logs";'
  );

  // Replace placeholder
  app = app.replace(
    '{panel === "logs" && <PH title="Log Builder" />}',
    '{panel === "logs" && <Logs />}'
  );

  // Add play logging - register callback on engine
  if (!app.includes('play_log')) {
    app = app.replace(
      "  // Refill callback",
      [
        "  // Log plays to database",
        "  useEffect(() => {",
        "    (globalThis as any).__etherEngine = engine;",
        "    return engine.onPlayStart(async (deckId, title, artist, filePath) => {",
        "      try {",
        "        await execute(",
        "          \"INSERT INTO play_log (title, artist, deck, played_at) VALUES (?, ?, ?, unixepoch())\",",
        "          [title, artist, deckId]",
        "        );",
        "      } catch (e) { console.error('Log write error:', e); }",
        "    });",
        "  }, []);",
        "",
        "  // Refill callback",
      ].join("\n")
    );
  }

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (Logs tab + play logging)');
}

console.log('\n  Done! Restart: npm run tauri:dev');
console.log('');
console.log('  Logs tab shows:');
console.log('    - Every song that played with timestamp');
console.log('    - Artist, category, show, and deck');
console.log('    - Stats: total plays, unique artists, unique songs');
console.log('    - Filter: Today or All Time');
console.log('    - Export CSV button (for OV reporting)');
console.log('    - Auto-refreshes every 5 seconds');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.6.1 play log with history and CSV export"');
console.log('    git push\n');
