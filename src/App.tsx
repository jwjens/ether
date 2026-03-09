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

const AUDIO_EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return AUDIO_EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").replace(/^\d+\.?\s*/, ""); }
function fmtFromPath(p: string) { return (p.split(".").pop() || "").toLowerCase(); }
function fmtTime(sec: number) { if (!sec || sec < 0) return "0:00"; const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return m + ":" + String(s).padStart(2, "0"); }
function fmtTimeMs(ms: number) { return fmtTime(ms / 1000); }

// ============================================================
// APP
// ============================================================

export default function App() {
  const [panel, setPanel] = useState<Panel>("live");
  const [onAir, setOnAir] = useState(false);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);

  useEffect(() => {
    engine.init();
    const unsub = engine.on((id, state) => {
      if (id === "A") setDeckA({ ...state });
      else setDeckB({ ...state });
    });
    return unsub;
  }, []);

  const loadToA = useCallback((song: SongRow) => {
    if (song.file_path) engine.loadToDeck("A", song.file_path, song.title, song.artist_name || "");
  }, []);
  const loadToB = useCallback((song: SongRow) => {
    if (song.file_path) engine.loadToDeck("B", song.file_path, song.title, song.artist_name || "");
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
          {panel === "live" && <LivePanel deckA={deckA} deckB={deckB} />}
          {panel === "library" && <LibraryPanel onLoadA={loadToA} onLoadB={loadToB} />}
          {panel === "clocks" && <Placeholder title="Clock Builder" />}
          {panel === "logs" && <Placeholder title="Log Builder" />}
          {panel === "spots" && <Placeholder title="Spot Inventory" />}
          {panel === "settings" && <Placeholder title="Settings" />}
        </main>
      </div>
      <footer className="h-7 flex items-center justify-between px-4 bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0">
        <span>{deckA?.status === "playing" ? "Playing: " + deckA.title : "Ready"}</span>
        <span>SQLite: connected | Audio: Web Audio API | Mode: Manual</span>
      </footer>
    </div>
  );
}

// ============================================================
// NAV
// ============================================================

function Nav({ active, set }: { active: Panel; set: (p: Panel) => void }) {
  const items: { id: Panel; label: string }[] = [
    { id: "live", label: "Live Assist" }, { id: "library", label: "Library" },
    { id: "clocks", label: "Clocks" }, { id: "logs", label: "Logs" },
    { id: "spots", label: "Spots" }, { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="w-48 bg-zinc-900 border-r border-zinc-800 flex flex-col py-2 shrink-0">
      {items.map(i => (
        <button key={i.id} onClick={() => set(i.id)}
          className={active === i.id
            ? "px-4 py-2.5 text-sm text-left bg-zinc-800 text-white border-l-2 border-blue-400"
            : "px-4 py-2.5 text-sm text-left text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-l-2 border-transparent"
          }>{i.label}</button>
      ))}
      <div className="mt-auto px-4 py-3 text-[10px] text-zinc-600">Ether v0.1.0<br/>Free forever</div>
    </nav>
  );
}

// ============================================================
// LIVE PANEL with real playback
// ============================================================

function LivePanel({ deckA, deckB }: { deckA: DeckState | null; deckB: DeckState | null }) {
  const handleCrossfade = () => {
    if (deckA?.status === "playing" && deckB?.filePath) {
      engine.crossfade("A", "B", 2000);
    } else if (deckB?.status === "playing" && deckA?.filePath) {
      engine.crossfade("B", "A", 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Live Assist</h1>
        <button onClick={handleCrossfade} className="px-4 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold text-white">CROSSFADE</button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <DeckCard deck={deckA} deckId="A" color="text-blue-400" />
        <DeckCard deck={deckB} deckId="B" color="text-emerald-400" />
      </div>
      <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <h2 className="text-xs font-bold text-zinc-400 uppercase mb-3">Up Next</h2>
        <div className="text-sm text-zinc-500 italic">Load songs from the Library tab (right-click or use A/B buttons).</div>
      </div>
      <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <h2 className="text-xs font-bold text-zinc-400 uppercase mb-3">Cart Wall</h2>
        <div className="grid grid-cols-8 gap-1.5">
          {Array.from({ length: 32 }, (_, i) => (
            <button key={i} className="aspect-square rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-600 flex items-center justify-center">{i < 12 ? "F" + (i + 1) : ""}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeckCard({ deck, deckId, color }: { deck: DeckState | null; deckId: "A" | "B"; color: string }) {
  const d = engine.getDeck(deckId);
  const status = deck?.status || "idle";
  const title = deck?.title || "No track loaded";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const remaining = dur - pos;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  const handlePlay = () => {
    if (!d) return;
    if (status === "playing") d.pause();
    else if (status === "paused") d.resume();
    else if (status === "idle" || status === "ended") d.play();
  };

  const handleStop = () => { if (d) d.stop(); };

  const playLabel = status === "playing" ? "Pause" : status === "paused" ? "Resume" : "Play";
  const playColor = status === "playing"
    ? "px-4 py-1.5 rounded text-xs font-bold flex-1 bg-yellow-600 text-white"
    : "px-4 py-1.5 rounded text-xs font-bold flex-1 bg-emerald-700 hover:bg-emerald-600 text-white";

  return (
    <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="flex items-center justify-between mb-2">
        <span className={"text-xs font-bold uppercase tracking-wider " + color}>{"Deck " + deckId}</span>
        <span className={"text-[10px] uppercase " + (status === "playing" ? "text-emerald-400 font-bold" : "text-zinc-500")}>{status}</span>
      </div>

      <div className="text-sm text-zinc-200 truncate mb-1">{title}</div>
      {deck?.artist && <div className="text-xs text-zinc-500 truncate mb-2">{deck.artist}</div>}

      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
        <div className="h-full bg-blue-500 transition-all" style={{ width: pct + "%" }}></div>
      </div>

      <div className="flex justify-between text-xs font-mono text-zinc-500 mb-3">
        <span>{fmtTime(pos)}</span>
        <span>-{fmtTime(remaining)}</span>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={handleStop} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">Stop</button>
        <button onClick={handlePlay} className={playColor}>{playLabel}</button>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-500 mt-3">
        <span>Vol</span>
        <input type="range" min="0" max="100" value={Math.round((deck?.volume || 1) * 100)}
          onChange={e => d?.setVolume(parseInt(e.target.value) / 100)}
          className="flex-1 h-1.5 accent-blue-500" />
        <span>{Math.round((deck?.volume || 1) * 100)}%</span>
      </div>

      {deck?.error && <div className="text-xs text-red-400 mt-2">{deck.error}</div>}
    </div>
  );
}

// ============================================================
// LIBRARY PANEL — with load-to-deck buttons
// ============================================================

function LibraryPanel({ onLoadA, onLoadB }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void }) {
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");

  const load = async () => {
    try {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name, al.title as album_title, c.code as category_code, c.color as category_color FROM songs s LEFT JOIN artists a ON a.id = s.artist_id LEFT JOIN albums al ON al.id = s.album_id LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.title LIMIT 500");
      setSongs(rows);
      const r = await queryOne<{ c: number }>("SELECT COUNT(*) as c FROM songs");
      setCount(r ? r.c : 0);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

useEffect(() => { setTimeout(() => load(), 1000); }, []);

  const handleImportFolder = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Music Folder" });
      if (!folder) return;
      setImporting(true);
      setImportStatus("Scanning...");
      const entries = await readDir(folder as string);
      const files: string[] = [];
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          files.push((folder as string) + sep + e.name);
        }
      }
      if (files.length === 0) { setImportStatus("No audio files found."); setTimeout(() => setImportStatus(""), 3000); setImporting(false); return; }
      let n = 0;
      for (const fp of files) {
        const ex = await queryOne<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [fp]);
        if (ex) continue;
        await execute("INSERT INTO songs (title, file_path, file_format, daypart_mask) VALUES (?, ?, ?, ?)", [titleFromFile(fp), fp, fmtFromPath(fp), 16777215]);
        n++;
        setImportStatus("Importing... " + n);
      }
      setImportStatus("Done! " + n + " imported.");
      setTimeout(() => setImportStatus(""), 4000);
      setImporting(false);
      load();
    } catch (e) { console.error(e); setImportStatus("Error: " + e); setImporting(false); }
  };

  const handleDelete = async (id: number) => { await execute("DELETE FROM songs WHERE id = ?", [id]); load(); };

  const filtered = search ? songs.filter(s => (s.title || "").toLowerCase().includes(search.toLowerCase()) || (s.artist_name || "").toLowerCase().includes(search.toLowerCase())) : songs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Song Library</h1>
        <span className="text-xs text-zinc-500">{count} tracks</span>
      </div>
      <div className="flex items-center gap-2">
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500" />
        <button onClick={handleImportFolder} disabled={importing}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium text-white">Import Folder</button>
      </div>
      {importStatus && <div className="px-3 py-2 bg-blue-900 border border-blue-700 rounded text-sm text-blue-200">{importStatus}</div>}
      {loading ? <div className="text-sm text-zinc-500">Loading...</div> : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-zinc-400 text-lg mb-2">No music yet</div>
          <div className="text-zinc-600 text-sm mb-6">Import a folder of audio files to get started.</div>
          <button onClick={handleImportFolder} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2 w-8"></th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Artist</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2 text-right">Load</th>
            </tr></thead>
            <tbody>{filtered.map((s, i) => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800 group">
                <td className="px-3 py-2 text-zinc-600 text-xs">{i + 1}</td>
                <td className="px-3 py-2 text-zinc-100">{s.title}</td>
                <td className="px-3 py-2 text-zinc-400">{s.artist_name || "Unknown"}</td>
                <td className="px-3 py-2 text-zinc-500 text-xs uppercase">{s.file_path ? fmtFromPath(s.file_path) : "--"}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => onLoadA(s)} className="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-[10px] font-bold text-white mr-1">A</button>
                  <button onClick={() => onLoadB(s)} className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[10px] font-bold text-white">B</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return <div className="flex flex-col items-center justify-center h-full text-center"><h1 className="text-xl font-bold mb-2">{title}</h1><p className="text-xs text-zinc-600 mt-2">Coming soon</p></div>;
}

function ClockDisplay() {
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  useEffect(() => { const id = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000); return () => clearInterval(id); }, []);
  return <span className="font-mono text-xs">{time}</span>;
}
