import { useState, useEffect } from "react";
import { query } from "../db/client";
import { engine, DeckState } from "../audio/engine";

interface SongResult {
  id: number; title: string; file_path: string | null;
  artist_name: string | null;
}

interface RecentItem {
  title: string; artist: string | null; played_at: number;
}

interface Props {
  deckA: DeckState | null;
  deckB: DeckState | null;
}

export default function JockStrip({ deckA, deckB }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SongResult[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [time, setTime] = useState(new Date());
  const [showResults, setShowResults] = useState(false);

  // Clock
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Load recent plays
  useEffect(() => {
    const load = async () => {
      try {
        const rows = await query<RecentItem>("SELECT title, artist, played_at FROM play_log ORDER BY played_at DESC LIMIT 5");
        setRecent(rows);
      } catch {}
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  // Search
  useEffect(() => {
    if (search.length < 2) { setResults([]); setShowResults(false); return; }
    const timer = setTimeout(async () => {
      const rows = await query<SongResult>(
        "SELECT s.id, s.title, s.file_path, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL AND (s.title LIKE ? OR a.name LIKE ?) ORDER BY s.title LIMIT 8",
        ["%" + search + "%", "%" + search + "%"]
      );
      setResults(rows);
      setShowResults(true);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const addToQueue = (song: SongResult) => {
    if (song.file_path) {
      engine.addToQueue([{ filePath: song.file_path, title: song.title, artist: song.artist_name || "" }]);
    }
    setSearch("");
    setShowResults(false);
  };

  const loadToDeckA = (song: SongResult) => {
    if (song.file_path) engine.loadToDeck("A", song.file_path, song.title, song.artist_name || "");
    setSearch("");
    setShowResults(false);
  };

  // Next up from queue
  const queue = engine.getQueue();
  const nextUp = queue.length > 0 ? queue[0] : null;

  // Active deck info
  const active = deckA?.status === "playing" ? deckA : deckB?.status === "playing" ? deckB : null;

  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = time.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 space-y-2">
      {/* Row 1: Search + Teleprompter */}
      <div className="flex items-center gap-3">
        {/* Quick Search */}
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Quick search — type to find a song..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowResults(true); }}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            style={{ width: "100%", padding: "8px 12px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xs)", fontSize: 13, color: "var(--text-primary)", outline: "none" }}
          />
          {showResults && results.length > 0 && (
            <div style={{ position: "absolute" as any, top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--bg-elevated)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", zIndex: 50, maxHeight: 240, overflowY: "auto" as any }}>
              {results.map(r => (
                <div key={r.id} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-700 border-b border-zinc-700 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-100 truncate">{r.title}</div>
                    <div className="text-[10px] text-zinc-500 truncate">{r.artist_name || "Unknown"}</div>
                  </div>
                  <div className="flex gap-1 ml-2 shrink-0">
                    <button onMouseDown={e => { e.preventDefault(); addToQueue(r); }} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white">Q</button>
                    <button onMouseDown={e => { e.preventDefault(); loadToDeckA(r); }} className="px-2 py-0.5 bg-blue-700 hover:bg-blue-600 rounded text-[9px] font-bold text-white">A</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Teleprompter */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <div style={{ fontSize: 18, fontFamily: "monospace", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1 }}>{timeStr}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{dateStr}</div>
          </div>
          {nextUp && (
            <div className="border-l border-zinc-700 pl-3">
              <div className="text-[9px] text-zinc-500 uppercase">Next Up</div>
              <div className="text-xs text-zinc-300 truncate max-w-[180px]">{nextUp.title}</div>
              <div className="text-[10px] text-zinc-500 truncate max-w-[180px]">{nextUp.artist}</div>
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Recent history */}
      {recent.length > 0 && (
        <div className="flex items-center gap-1 overflow-hidden">
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase" as any, flexShrink: 0, marginRight: 4 }}>History:</span>
          {recent.map((r, i) => (
            <span key={i} style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>
              {i > 0 && <span className="text-zinc-700 mx-1">|</span>}
              <span className="text-zinc-400">{r.artist || ""}</span>
              {r.artist ? " — " : ""}
              <span>{r.title}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
