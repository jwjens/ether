import { useState, useEffect, useCallback } from "react";
import { query, execute, queryOne } from "./db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine, DeckState } from "./audio/engine";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "settings";

interface SongRow {
  id: number; title: string; file_path: string | null;
  artist_name: string | null; album_title: string | null;
  genre: string | null; duration_ms: number;
  category_code: string | null; category_color: string | null;
}

const EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").replace(/^\d+\.?\s*/, ""); }
function fmtExt(p: string) { return (p.split(".").pop() || "").toLowerCase(); }
function fmtTime(s: number) { if (!s || s < 0) return "0:00"; return Math.floor(s/60) + ":" + String(Math.floor(s%60)).padStart(2,"0"); }

export default function App() {
  const [panel, setPanel] = useState<Panel>("live");
  const [onAir, setOnAir] = useState(false);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [autoAdv, setAutoAdv] = useState(false);
  const [queueLen, setQueueLen] = useState(0);

  useEffect(() => {
    engine.init();
    return engine.on((id, st) => {
      if (id === "A") setDeckA({...st});
      else setDeckB({...st});
      setQueueLen(engine.getQueue().length);
    });
  }, []);

  const toggleAuto = () => {
    const next = !autoAdv;
    setAutoAdv(next);
    engine.autoAdvance = next;
  };

  const loadA = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("A", s.file_path, s.title, s.artist_name || ""); }, []);
  const loadB = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("B", s.file_path, s.title, s.artist_name || ""); }, []);
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) {
      engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "" }]);
      setQueueLen(engine.getQueue().length);
    }
  }, []);

  const cls = onAir
    ? "ml-3 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider bg-red-600 text-white animate-pulse"
    : "ml-3 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider bg-zinc-700 text-zinc-400 hover:bg-zinc-600";

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <header className="h-12 flex items-center justify-between px-4 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tracking-tight"><span className="text-blue-400">Eth</span>er</span>
          <span className="text-xs text-zinc-500">v0.1.0</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <ClockDisplay />
          <button onClick={() => { engine.init(); setOnAir(!onAir); }} className={cls}>{onAir ? "ON AIR" : "OFF AIR"}</button>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Nav active={panel} set={setPanel} />
        <main className="flex-1 overflow-auto p-6">
          {panel === "live" && <LivePanel deckA={deckA} deckB={deckB} autoAdv={autoAdv} toggleAuto={toggleAuto} queueLen={queueLen} />}
          {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} />}
          {panel === "clocks" && <PH title="Clock Builder" />}
          {panel === "logs" && <PH title="Log Builder" />}
          {panel === "spots" && <PH title="Spot Inventory" />}
          {panel === "settings" && <PH title="Settings" />}
        </main>
      </div>
      <footer className="h-7 flex items-center justify-between px-4 bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0">
        <span>{deckA?.status === "playing" ? "Playing: " + deckA.title : "Ready"}</span>
        <span>{autoAdv ? "AUTO" : "MANUAL"} | Queue: {queueLen} | SQLite | Web Audio</span>
      </footer>
    </div>
  );
}

function Nav({ active, set }: { active: Panel; set: (p: Panel) => void }) {
  const items: { id: Panel; label: string }[] = [
    { id: "live", label: "Live Assist" }, { id: "library", label: "Library" },
    { id: "clocks", label: "Clocks" }, { id: "logs", label: "Logs" },
    { id: "spots", label: "Spots" }, { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="w-48 bg-zinc-900 border-r border-zinc-800 flex flex-col py-2 shrink-0">
      {items.map(i => <button key={i.id} onClick={() => set(i.id)} className={active === i.id ? "px-4 py-2.5 text-sm text-left bg-zinc-800 text-white border-l-2 border-blue-400" : "px-4 py-2.5 text-sm text-left text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-l-2 border-transparent"}>{i.label}</button>)}
      <div className="mt-auto px-4 py-3 text-[10px] text-zinc-600">Ether v0.1.0<br/>Free forever</div>
    </nav>
  );
}

function LivePanel({ deckA, deckB, autoAdv, toggleAuto, queueLen }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; toggleAuto: () => void; queueLen: number }) {
  const handleXfade = () => {
    if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000);
    else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000);
  };

  const queue = engine.getQueue();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Live Assist</h1>
        <div className="flex items-center gap-2">
          <button onClick={toggleAuto} className={autoAdv ? "px-3 py-1.5 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1.5 rounded text-xs font-bold bg-zinc-700 text-zinc-400 hover:bg-zinc-600"}>{autoAdv ? "AUTO ON" : "AUTO OFF"}</button>
          <button onClick={handleXfade} className="px-4 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold text-white">CROSSFADE</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <DeckCard deck={deckA} deckId="A" color="text-blue-400" />
        <DeckCard deck={deckB} deckId="B" color="text-emerald-400" />
      </div>
      <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase">Up Next ({queueLen})</h2>
          {queue.length > 0 && <button onClick={() => { engine.clearQueue(); }} className="text-xs text-zinc-600 hover:text-zinc-400">Clear</button>}
        </div>
        {queue.length === 0 ? (
          <div className="text-sm text-zinc-500 italic">Queue is empty. Go to Library and click Q to add songs, or turn on AUTO.</div>
        ) : (
          <div className="space-y-1">
            {queue.slice(0, 10).map((item, i) => (
              <div key={i} className="flex items-center justify-between px-2 py-1.5 bg-zinc-800 rounded text-sm">
                <span className="text-zinc-300">{i + 1}. {item.title}</span>
                <span className="text-zinc-500 text-xs">{item.artist}</span>
              </div>
            ))}
            {queue.length > 10 && <div className="text-xs text-zinc-600 text-center">+ {queue.length - 10} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function DeckCard({ deck, deckId, color }: { deck: DeckState | null; deckId: "A" | "B"; color: string }) {
  const d = engine.getDeck(deckId);
  const st = deck?.status || "idle";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  const handlePlay = () => {
    if (!d) return;
    if (st === "playing") d.pause();
    else if (st === "paused") d.resume();
    else d.play();
  };

  const pLabel = st === "playing" ? "Pause" : st === "paused" ? "Resume" : "Play";
  const pCls = st === "playing"
    ? "px-4 py-1.5 rounded text-xs font-bold flex-1 bg-yellow-600 text-white"
    : "px-4 py-1.5 rounded text-xs font-bold flex-1 bg-emerald-700 hover:bg-emerald-600 text-white";

  return (
    <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="flex items-center justify-between mb-2">
        <span className={"text-xs font-bold uppercase tracking-wider " + color}>{"Deck " + deckId}</span>
        <span className={"text-[10px] uppercase " + (st === "playing" ? "text-emerald-400 font-bold" : "text-zinc-500")}>{st}</span>
      </div>
      <div className="text-sm text-zinc-200 truncate mb-1">{deck?.title || "No track loaded"}</div>
      {deck?.artist ? <div className="text-xs text-zinc-500 truncate mb-2">{deck.artist}</div> : null}
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
        <div className="h-full bg-blue-500 transition-all" style={{ width: pct + "%" }}></div>
      </div>
      <div className="flex justify-between text-xs font-mono text-zinc-500 mb-3">
        <span>{fmtTime(pos)}</span><span>-{fmtTime(dur - pos)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => d?.stop()} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">Stop</button>
        <button onClick={handlePlay} className={pCls}>{pLabel}</button>
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-500 mt-3">
        <span>Vol</span>
        <input type="range" min="0" max="100" value={Math.round((deck?.volume || 1) * 100)} onChange={e => d?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1.5 accent-blue-500" />
        <span>{Math.round((deck?.volume || 1) * 100)}%</span>
      </div>
      {deck?.error ? <div className="text-xs text-red-400 mt-2">{deck.error}</div> : null}
    </div>
  );
}

function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("");

  const load = async () => {
    try {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name, al.title as album_title, c.code as category_code, c.color as category_color FROM songs s LEFT JOIN artists a ON a.id = s.artist_id LEFT JOIN albums al ON al.id = s.album_id LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.title LIMIT 500");
      setSongs(rows);
      const r = await queryOne<{ c: number }>("SELECT COUNT(*) as c FROM songs");
      setCount(r ? r.c : 0);
    } catch (e) { console.error(e); setStatus("Error: " + e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleImport = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Music Folder" });
      if (!folder) return;
      setImporting(true); setStatus("Scanning...");
      const entries = await readDir(folder as string);
      const files: string[] = [];
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          files.push((folder as string) + sep + e.name);
        }
      }
      if (files.length === 0) { setStatus("No audio files found."); setTimeout(() => setStatus(""), 3000); setImporting(false); return; }
      let n = 0;
      for (const fp of files) {
        const ex = await queryOne<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [fp]);
        if (!ex) {
          await execute("INSERT INTO songs (title, file_path, file_format, daypart_mask) VALUES (?, ?, ?, ?)", [titleFromFile(fp), fp, fmtExt(fp), 16777215]);
          n++;
        }
        setStatus("Importing... " + n);
      }
      setStatus("Done! " + n + " imported."); setTimeout(() => setStatus(""), 4000);
      setImporting(false); load();
    } catch (e) { console.error(e); setStatus("Error: " + e); setImporting(false); }
  };

  const queueAll = () => {
    const items = (search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs).filter(s => s.file_path);
    engine.addToQueue(items.map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" })));
  };

  const filtered = search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Song Library</h1>
        <span className="text-xs text-zinc-500">{count} tracks</span>
      </div>
      <div className="flex items-center gap-2">
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500" />
        <button onClick={queueAll} className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium text-white">Queue All</button>
        <button onClick={handleImport} disabled={importing} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium text-white">Import Folder</button>
      </div>
      {status ? <div className="px-3 py-2 bg-blue-900 border border-blue-700 rounded text-sm text-blue-200">{status}</div> : null}
      {loading ? <div className="text-sm text-zinc-500">Loading...</div> : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-zinc-400 text-lg mb-2">No music yet</div>
          <div className="text-zinc-600 text-sm mb-6">Import a folder of audio files to get started.</div>
          <button onClick={handleImport} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Artist</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2 text-right">Load</th>
            </tr></thead>
            <tbody>{filtered.map((s, i) => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800 group">
                <td className="px-3 py-2 text-zinc-600 text-xs">{i+1}</td>
                <td className="px-3 py-2 text-zinc-100">{s.title}</td>
                <td className="px-3 py-2 text-zinc-400">{s.artist_name || "Unknown"}</td>
                <td className="px-3 py-2 text-zinc-500 text-xs uppercase">{s.file_path ? fmtExt(s.file_path) : "--"}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => onLoadA(s)} className="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-[10px] font-bold text-white mr-1">A</button>
                  <button onClick={() => onLoadB(s)} className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[10px] font-bold text-white mr-1">B</button>
                  <button onClick={() => onQueue(s)} className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] font-bold text-white">Q</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PH({ title }: { title: string }) {
  return <div className="flex flex-col items-center justify-center h-full text-center"><h1 className="text-xl font-bold mb-2">{title}</h1><p className="text-xs text-zinc-600 mt-2">Coming soon</p></div>;
}

function ClockDisplay() {
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  useEffect(() => { const id = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000); return () => clearInterval(id); }, []);
  return <span className="font-mono text-xs">{time}</span>;
}