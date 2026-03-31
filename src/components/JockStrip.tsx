import { useState, useEffect } from "react";
import { query } from "../db/client";
import { engine, DeckState } from "../audio/engine-rodio";

interface SongResult {
  id: number;
  title: string;
  file_path: string | null;
  artist_name: string | null;
  duration_ms: number;
}

interface Props {
  deckA: DeckState | null;
  deckB: DeckState | null;
  externalSearch?: string;
  onSearchChange?: (v: string) => void;
}

function fmtDur(ms: number): string {
  if (!ms) return "";
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export default function JockStrip({ deckA, deckB, dropDown = false, externalSearch, onSearchChange }: Props & { dropDown?: boolean; externalSearch?: string; onSearchChange?: (v: string) => void }) {
  const [search, setSearch] = useState("");

  // Sync external search (from header bar)
  useEffect(() => {
    if (externalSearch !== undefined && externalSearch !== search) {
      setSearch(externalSearch);
    }
  }, [externalSearch]);
  const [results, setResults] = useState<SongResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (search.length < 2) { setResults([]); setShowResults(false); return; }
    const timer = setTimeout(async () => {
      const rows = await query<SongResult>(
        "SELECT s.id, s.title, s.file_path, s.duration_ms, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL AND (s.title LIKE ? OR a.name LIKE ?) ORDER BY s.title LIMIT 12",
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
      {/* Search input */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 16px",
        background: focused ? "var(--bg-secondary)" : "var(--bg-tertiary)",
        transition: "background 0.15s ease",
        borderRadius: 12,
      }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.35, color: "var(--text-primary)" }}>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          type="text"
          placeholder="Quick search — type to find a song..."
          value={search}
          onChange={e => { setSearch(e.target.value); onSearchChange?.(e.target.value); }}
          onFocus={() => { setFocused(true); if (results.length > 0) setShowResults(true); }}
          onBlur={() => { setFocused(false); setTimeout(() => setShowResults(false), 300); }}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            fontSize: 13, color: "var(--text-primary)",
            fontFamily: "'Inter', system-ui, sans-serif",
            letterSpacing: "-0.01em",
          }}
        />
        {search && (
          <button
            onMouseDown={e => { e.preventDefault(); setSearch(""); setShowResults(false); onSearchChange?.(""); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
          >×</button>
        )}
      </div>

      {/* Results dropdown — opens upward so it doesn't get clipped by bottom of screen */}
      {showResults && results.length > 0 && (
        <div style={{
          position: "absolute",
          ...(dropDown ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" }),
          left: 0, right: 0,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-secondary)",
          borderRadius: 12,
          boxShadow: dropDown ? "0 8px 32px rgba(0,0,0,0.12), 0 0 0 1px var(--border-primary)" : "0 -8px 32px rgba(0,0,0,0.12), 0 0 0 1px var(--border-primary)",
          zIndex: 9999,
          maxHeight: 340,
          overflowY: "auto",
        }}>
          <div style={{
            padding: "7px 14px 5px",
            fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)",
            letterSpacing: "0.12em", textTransform: "uppercase" as any,
            borderBottom: "1px solid var(--border-primary)",
            position: "sticky", top: 0,
            background: "var(--bg-secondary)",
          }}>
            {results.length} result{results.length !== 1 ? "s" : ""} — drag to queue or use buttons
          </div>
          {results.map((r, i) => (
            <div
              key={r.id}
              onMouseDown={e => {
                if (e.button !== 0) return;
                e.preventDefault();
                let dragging = false;
                const startY = e.clientY;
                const startX = e.clientX;

                const ghost = document.createElement("div");
                ghost.style.cssText = `position:fixed;z-index:99999;padding:6px 12px;background:#22d3ee;color:#000;border-radius:8px;font-size:12px;font-weight:600;font-family:Inter,sans-serif;pointer-events:none;opacity:0;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.25);`;
                ghost.textContent = r.title;
                document.body.appendChild(ghost);

                const onMove = (ev: MouseEvent) => {
                  if (!dragging && (Math.abs(ev.clientY - startY) > 4 || Math.abs(ev.clientX - startX) > 4)) {
                    dragging = true;
                    ghost.style.opacity = "1";
                  }
                  if (!dragging) return;
                  ghost.style.left = (ev.clientX + 12) + "px";
                  ghost.style.top = (ev.clientY - 16) + "px";
                };

                const onUp = (ev: MouseEvent) => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  document.body.removeChild(ghost);
                  if (!dragging) return;
                  const items = Array.from(document.querySelectorAll("[data-queue-item]"));
                  let insertIdx = items.length;
                  for (let j = 0; j < items.length; j++) {
                    const rect = items[j].getBoundingClientRect();
                    if (ev.clientY < rect.top + rect.height / 2) { insertIdx = j; break; }
                  }
                  if (r.file_path) {
                    const q = engine.getQueue();
                    q.splice(insertIdx, 0, { filePath: r.file_path, title: r.title, artist: r.artist_name || "" });
                    engine.clearQueue();
                    engine.addToQueue(q);
                    setShowResults(false);
                    setSearch("");
                  }
                };

                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 14px",
                borderBottom: i < results.length - 1 ? "1px solid var(--border-primary)" : "none",
                cursor: "grab",
                userSelect: "none" as any,
                background: "transparent",
                transition: "background 0.1s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, letterSpacing: "-0.01em" }}>{r.title}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, marginTop: 1 }}>{r.artist_name || "Unknown"}</div>
              </div>
              {r.duration_ms > 0 && (
                <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", flexShrink: 0 }}>{fmtDur(r.duration_ms)}</span>
              )}
              <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                <button onMouseDown={e => { e.preventDefault(); addToQueue(r); }} style={{ padding: "4px 9px", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", cursor: "pointer" }}>Q</button>
                <button onMouseDown={e => { e.preventDefault(); loadToDeckA(r); }} style={{ padding: "4px 9px", background: "#38bdf8", border: "none", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "#000", cursor: "pointer" }}>A</button>
                <button onMouseDown={e => { e.preventDefault(); loadToDeckB(r); }} style={{ padding: "4px 9px", background: "#34d399", border: "none", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "#000", cursor: "pointer" }}>B</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
