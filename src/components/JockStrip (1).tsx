import { useState, useEffect } from "react";
import { query } from "../db/client";
import { engine, DeckState } from "../audio/engine";

interface SongResult {
  id: number; title: string; file_path: string | null;
  artist_name: string | null;
}

interface Props {
  deckA: DeckState | null;
  deckB: DeckState | null;
}

export default function JockStrip({ deckA, deckB }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SongResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    if (search.length < 2) { setResults([]); setShowResults(false); return; }
    const timer = setTimeout(async () => {
      const rows = await query<SongResult>(
        "SELECT s.id, s.title, s.file_path, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL AND (s.title LIKE ? OR a.name LIKE ?) ORDER BY s.title LIMIT 12",
        ["%" + search + "%", "%" + search + "%"]
      );
      setResults(rows);
      setShowResults(true);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const addToQueue = (song: SongResult) => {
    if (song.file_path) engine.addToQueue([{ filePath: song.file_path, title: song.title, artist: song.artist_name || "" }]);
    setSearch(""); setShowResults(false);
  };
  const loadToDeckA = (song: SongResult) => {
    if (song.file_path) engine.loadToDeck("A", song.file_path, song.title, song.artist_name || "");
    setSearch(""); setShowResults(false);
  };
  const loadToDeckB = (song: SongResult) => {
    if (song.file_path) engine.loadToDeck("B", song.file_path, song.title, song.artist_name || "");
    setSearch(""); setShowResults(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        placeholder="Quick search — type to find a song..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        onFocus={() => { if (results.length > 0) setShowResults(true); }}
        onBlur={() => setTimeout(() => setShowResults(false), 200)}
        style={{
          width: "100%", padding: "12px 16px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          borderRadius: 12, fontSize: 14,
          color: "var(--text-primary)", outline: "none",
        }}
      />
      {showResults && results.length > 0 && (
        <div style={{
          position: "absolute", bottom: "100%", left: 0, right: 0,
          marginBottom: 6, background: "var(--bg-elevated, var(--bg-secondary))",
          border: "1px solid var(--border-secondary)",
          borderRadius: 12, boxShadow: "var(--shadow-lg)",
          zIndex: 50, maxHeight: 320, overflowY: "auto",
        }}>
          {results.map(r => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", borderBottom: "1px solid var(--border-primary)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.artist_name || "Unknown"}</div>
              </div>
              <div style={{ display: "flex", gap: 6, marginLeft: 10 }}>
                <button onMouseDown={e => { e.preventDefault(); addToQueue(r); }} style={{ padding: "4px 10px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", cursor: "pointer" }}>Q</button>
                <button onMouseDown={e => { e.preventDefault(); loadToDeckA(r); }} style={{ padding: "4px 10px", background: "#0ea5e9", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#000", cursor: "pointer" }}>A</button>
                <button onMouseDown={e => { e.preventDefault(); loadToDeckB(r); }} style={{ padding: "4px 10px", background: "#10b981", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#000", cursor: "pointer" }}>B</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
