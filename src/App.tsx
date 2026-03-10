import { useState, useEffect, useCallback } from "react";
import { query, execute, queryOne } from "./db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine, DeckState } from "./audio/engine";
import { fillQueueFromSchedule, refillFromSchedule } from "./audio/loggen";
import { readID3 } from "./audio/id3";
import Waveform from "./components/Waveform";
import OnAirDeck from "./components/OnAirDeck";
import CartWall from "./components/CartWall";
import UpNext from "./components/UpNext";
import Scheduler from "./components/Scheduler";
import Logs from "./components/Logs";
import NowPlaying from "./components/NowPlaying";
import Spots from "./components/Spots";
import RulesEditor from "./components/RulesEditor";
import AudioDevices from "./components/AudioDevices";
import VoiceTracker from "./components/VoiceTracker";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "settings";

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
function fmtTimeLong(s: number) { if (!s || s < 0) return "00:00.0"; const m = Math.floor(s/60); const sec = s % 60; return String(m).padStart(2,"0") + ":" + sec.toFixed(1).padStart(4,"0"); }

export default function App() {
  const [panel, setPanel] = useState<Panel>("live");
  const [onAir, setOnAir] = useState(false);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [autoAdv, setAutoAdv] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");

  // Log plays to database
  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    return engine.onPlayStart(async (deckId, title, artist, filePath) => {
      try {
        await execute(
          "INSERT INTO play_log (title, artist, deck, played_at) VALUES (?, ?, ?, unixepoch())",
          [title, artist, deckId]
        );
      } catch (e) { console.error('Log write error:', e); }
    });
  }, []);

  // Refill callback: loads all songs from DB when queue empties
  useEffect(() => {
    engine.setRefillCallback(async () => {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const dA = engine.getDeck("A");
      const dB = engine.getDeck("B");
      switch(e.code) {
        case "Space": e.preventDefault(); if (dA) { if (dA.getState().status === "playing") dA.pause(); else if (dA.getState().status === "paused") dA.resume(); else dA.play(); } break;
        case "KeyB": if (dB) { if (dB.getState().status === "playing") dB.pause(); else if (dB.getState().status === "paused") dB.resume(); else dB.play(); } break;
        case "KeyX": if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000); else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000); break;
        case "Escape": dA?.stop(); dB?.stop(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deckA, deckB]);

  useEffect(() => {
    engine.init();
    return engine.on((id, st) => {
      if (id === "A") setDeckA({...st});
      else setDeckB({...st});
      setQueueLen(engine.getQueue().length);
    });
  }, []);

  const handleOutputChange = (deviceId: string) => { setOutputDevice(deviceId); engine.setOutputDevice(deviceId); };
  const handleInputChange = (deviceId: string) => { setInputDevice(deviceId); };

  const toggleAuto = () => { const n = !autoAdv; setAutoAdv(n); engine.autoAdvance = n; };
  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };
  const toggleContinuous = async () => {
    const n = !continuous;
    setContinuous(n);
    engine.continuous = n;
    if (n) {
      // Auto-start: fill queue from schedule and play
      engine.autoAdvance = true;
      setAutoAdv(true);
      engine.shuffle = true;
      setShuffle(true);
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count > 0) {
          const q = engine.getQueue();
          if (q.length > 0) {
            const first = q.shift();
            if (first) {
              engine.clearQueue();
              engine.addToQueue(q);
              await engine.loadToDeck('A', first.filePath, first.title, first.artist);
              engine.getDeck('A')?.play();
            }
          }
        }
      }
    }
  };

  const loadA = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("A", s.file_path, s.title, s.artist_name || ""); }, []);
  const loadB = useCallback((s: SongRow) => { if (s.file_path) engine.loadToDeck("B", s.file_path, s.title, s.artist_name || ""); }, []);
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) { engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "" }]); setQueueLen(engine.getQueue().length); }
  }, []);

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {showNowPlaying && <NowPlaying onExit={() => setShowNowPlaying(false)} />}
      <header className="h-12 flex items-center justify-between px-4 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tracking-tight"><span className="text-blue-400">Eth</span>er</span>
          <span className="text-xs text-zinc-500">v0.2.0</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <button onClick={() => setShowNowPlaying(true)} className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] font-bold text-zinc-400">NOW PLAYING</button>
          <ClockDisplay />
          <button onClick={() => { engine.init(); setOnAir(!onAir); }} className={onAir ? "ml-3 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider bg-red-600 text-white animate-pulse" : "ml-3 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider bg-zinc-700 text-zinc-400 hover:bg-zinc-600"}>{onAir ? "ON AIR" : "OFF AIR"}</button>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Nav active={panel} set={setPanel} />
        <main className="flex-1 overflow-auto p-4">
          {panel === "live" && <LivePanel deckA={deckA} deckB={deckB} autoAdv={autoAdv} shuffle={shuffle} continuous={continuous} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} toggleContinuous={toggleContinuous} queueLen={queueLen} />}
          {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} />}
          {panel === "clocks" && <Scheduler />}
          {panel === "logs" && <Logs />}
          {panel === "spots" && <Spots />}
          {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
          {panel === "settings" && <div className="space-y-6"><AudioDevices onOutputChange={handleOutputChange} onInputChange={handleInputChange} currentOutput={outputDevice} currentInput={inputDevice} /><RulesEditor /></div>}
        </main>
      </div>
      <footer className="h-7 flex items-center justify-between px-4 bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0">
        <span>{deckA?.status === "playing" ? "Playing: " + deckA.title : "Ready"}</span>
        <span>{autoAdv ? "AUTO" : "MANUAL"}{shuffle ? " | SHUFFLE" : ""}{continuous ? " | 24/7" : ""} | Queue: {queueLen} | Space=Play/Pause X=Crossfade</span>
      </footer>
    </div>
  );
}

function Nav({ active, set }: { active: Panel; set: (p: Panel) => void }) {
  const items: { id: Panel; label: string }[] = [
    { id: "live", label: "Live Assist" }, { id: "library", label: "Library" },
    { id: "clocks", label: "Schedule" }, { id: "logs", label: "Logs" },
    { id: "spots", label: "Spots" }, { id: "voicetrack" as Panel, label: "Voice Track" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="w-44 bg-zinc-900 border-r border-zinc-800 flex flex-col py-2 shrink-0">
      {items.map(i => <button key={i.id} onClick={() => set(i.id)} className={active === i.id ? "px-4 py-2.5 text-sm text-left bg-zinc-800 text-white border-l-2 border-blue-400" : "px-4 py-2.5 text-sm text-left text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-l-2 border-transparent"}>{i.label}</button>)}
      <div className="mt-auto px-4 py-3 text-[10px] text-zinc-600">Ether v0.2.0<br/>Free forever</div>
    </nav>
  );
}

// ============================================================
// LIVE PANEL — polished
// ============================================================

function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; shuffle: boolean; continuous: boolean; toggleAuto: () => void; toggleShuffle: () => void; toggleContinuous: () => void; queueLen: number }) {
  const handleXfade = () => {
    if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000);
    else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000);
  };

  return (
    <div className="flex gap-3 h-full">
      {/* Left column - Up Next */}
      <div className="w-64 shrink-0">
        <UpNext queueLen={queueLen} />
      </div>

      {/* Right column - Decks + Controls */}
      <div className="flex-1 space-y-3">
        {/* Control buttons */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Live Assist</h1>
          <div className="flex items-center gap-1.5">
            <button onClick={async () => { const n = await fillQueueFromSchedule(); }} className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG</button>
            <button onClick={toggleContinuous} className={continuous ? "px-2.5 py-1 rounded text-[11px] font-bold bg-rose-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>24/7</button>
            <button onClick={toggleShuffle} className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE</button>
            <button onClick={toggleAuto} className={autoAdv ? "px-2.5 py-1 rounded text-[11px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO</button>
            <button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>
          </div>
        </div>

        {/* Deck A - On Air style */}
        <OnAirDeck deck={deckA} label="Deck A — On Air" />

        {/* Deck A Controls */}
        <div className="flex items-center gap-2">
          <button onClick={() => engine.getDeck("A")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
          <button onClick={() => { const d = engine.getDeck("A"); if (!d) return; const st = deckA?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckA?.status === "playing" ? "#ca8a04" : "#2563eb" }}>{deckA?.status === "playing" ? "PAUSE" : deckA?.status === "paused" ? "RESUME" : "PLAY"}</button>
          <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32">
            <span>VOL</span>
            <input type="range" min="0" max="100" value={Math.round((deckA?.volume || 1) * 100)} onChange={e => engine.getDeck("A")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" />
            <span>{Math.round((deckA?.volume || 1) * 100)}%</span>
          </div>
        </div>

        {/* Deck B - On Air style */}
        <OnAirDeck deck={deckB} label="Deck B — Standby" />

        {/* Deck B Controls */}
        <div className="flex items-center gap-2">
          <button onClick={() => engine.getDeck("B")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
          <button onClick={() => { const d = engine.getDeck("B"); if (!d) return; const st = deckB?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckB?.status === "playing" ? "#ca8a04" : "#059669" }}>{deckB?.status === "playing" ? "PAUSE" : deckB?.status === "paused" ? "RESUME" : "PLAY"}</button>
          <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32">
            <span>VOL</span>
            <input type="range" min="0" max="100" value={Math.round((deckB?.volume || 1) * 100)} onChange={e => engine.getDeck("B")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-emerald-500" />
            <span>{Math.round((deckB?.volume || 1) * 100)}%</span>
          </div>
          {/* Cart Wall */}
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
            <div className="text-[10px] font-bold text-zinc-400 uppercase mb-2">Cart Wall</div>
            <CartWall />
          </div>
        </div>
      </div>
    </div>
  );
}

function DeckCard({ deck, deckId, accentColor, waveColor, playedColor }: { deck: DeckState | null; deckId: "A" | "B"; accentColor: string; waveColor: string; playedColor: string }) {
  const d = engine.getDeck(deckId);
  const st = deck?.status || "idle";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const progress = dur > 0 ? pos / dur : 0;
  const peaks = deck?.peaks || [];

  const handlePlay = () => {
    if (!d) return;
    if (st === "playing") d.pause();
    else if (st === "paused") d.resume();
    else d.play();
  };

  const pLabel = st === "playing" ? "PAUSE" : st === "paused" ? "RESUME" : "PLAY";

  const statusColor = st === "playing" ? "text-emerald-400" : st === "paused" ? "text-yellow-400" : st === "loading" ? "text-blue-400" : st === "error" ? "text-red-400" : "text-zinc-600";

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: accentColor }}>{"Deck " + deckId}</span>
          <span className={"text-[10px] uppercase font-bold " + statusColor}>{st}</span>
        </div>
      </div>

      <div className="px-3 pt-2">
        <div className="text-sm text-zinc-100 truncate font-medium">{deck?.title || "No track loaded"}</div>
        <div className="text-[11px] text-zinc-500 truncate">{deck?.artist || ""}</div>
      </div>

      <div className="px-3 py-2">
        <Waveform peaks={peaks} progress={progress} color={waveColor} playedColor={playedColor} height={50} />
      </div>

      <div className="flex justify-between px-3 text-zinc-400 mb-2">
        <span className="text-lg font-mono font-bold">{fmtTimeLong(pos)}</span>
        <span className="text-lg font-mono font-bold text-zinc-600">-{fmtTimeLong(dur - pos)}</span>
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-2">
        <button onClick={() => d?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
        <button onClick={handlePlay} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: st === "playing" ? "#ca8a04" : accentColor }}>{pLabel}</button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-3 text-xs text-zinc-500">
        <span className="text-[10px]">VOL</span>
        <input type="range" min="0" max="100" value={Math.round((deck?.volume || 1) * 100)} onChange={e => d?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" />
        <span className="text-[10px] w-8 text-right">{Math.round((deck?.volume || 1) * 100)}%</span>
      </div>

      {deck?.error ? <div className="px-3 pb-2 text-[11px] text-red-400">{deck.error}</div> : null}
    </div>
  );
}

// ============================================================
// LIBRARY
// ============================================================

function LibraryPanel({ onLoadA, onLoadB, onQueue }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void }) {
  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);
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
      setCatList(await query<{ id: number; code: string; color: string | null }>("SELECT id, code, color FROM categories ORDER BY code"));
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
          const tags = await readID3(fp);
          const title = tags.title || titleFromFile(fp);
          const artist = tags.artist || null;
          const album = tags.album || null;
          const genre = tags.genre || null;
          let artistId: number | null = null;
          if (artist) {
            const exArt = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artist]);
            if (exArt) { artistId = exArt.id; }
            else { const r = await execute("INSERT INTO artists (name) VALUES (?)", [artist]); artistId = r.lastInsertId; }
          }
          let albumId: number | null = null;
          if (album) {
            const exAlb = await queryOne<{ id: number }>("SELECT id FROM albums WHERE title = ? AND (artist_id = ? OR artist_id IS NULL)", [album, artistId]);
            if (exAlb) { albumId = exAlb.id; }
            else { const r = await execute("INSERT INTO albums (title, artist_id) VALUES (?, ?)", [album, artistId]); albumId = r.lastInsertId; }
          }
          await execute("INSERT INTO songs (title, artist_id, album_id, file_path, file_format, genre, daypart_mask) VALUES (?, ?, ?, ?, ?, ?, ?)", [title, artistId, albumId, fp, fmtExt(fp), genre, 16777215]);
          n++;
        }
        setStatus("Importing... " + n);
      }
      setStatus("Done! " + n + " imported."); setTimeout(() => setStatus(""), 4000);
      setImporting(false); load();
    } catch (e) { console.error(e); setStatus("Error: " + e); setImporting(false); }
  };

  const queueAll = () => {
    const items = filtered.filter(s => s.file_path);
    engine.addToQueue(items.map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" })));
  };

  const filtered = search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Song Library</h1>
        <span className="text-xs text-zinc-500">{count} tracks</span>
      </div>
      <div className="flex items-center gap-2">
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500" />
        <select onChange={async (e) => {
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
        <button onClick={queueAll} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Queue All</button>
        <button onClick={handleImport} disabled={importing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold text-white">Import</button>
      </div>
      {status ? <div className="px-3 py-1.5 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">{status}</div> : null}
      {loading ? <div className="text-sm text-zinc-500">Loading...</div> : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-zinc-400 text-lg mb-2">No music yet</div>
          <button onClick={handleImport} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Music Folder</button>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-2 py-1.5 w-7">#</th>
              <th className="px-2 py-1.5">Title</th>
              <th className="px-2 py-1.5">Artist</th>
              <th className="px-2 py-1.5">Cat</th>
              <th className="px-2 py-1.5">Fmt</th>
              <th className="px-2 py-1.5 text-right w-28">Load</th>
            </tr></thead>
            <tbody>{filtered.map((s, i) => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800 group">
                <td className="px-2 py-1.5 text-zinc-600">{i+1}</td>
                <td className="px-2 py-1.5 text-zinc-100">{s.title}</td>
                <td className="px-2 py-1.5 text-zinc-400">{s.artist_name || "Unknown"}</td>
                <td className="px-2 py-1.5">
                  <select value={s.category_code || ""} onChange={async (e) => {
                    const catId = catList.find(c => c.code === e.target.value)?.id || null;
                    await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]);
                    load();
                  }} className="bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-200 px-1 py-0.5">
                    <option value="">—</option>
                    {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-zinc-500 uppercase">{s.file_path ? fmtExt(s.file_path) : "--"}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => onLoadA(s)} className="px-1.5 py-0.5 bg-blue-700 hover:bg-blue-600 rounded text-[9px] font-bold text-white mr-0.5">A</button>
                  <button onClick={() => onLoadB(s)} className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-[9px] font-bold text-white mr-0.5">B</button>
                  <button onClick={() => onQueue(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white">Q</button>
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