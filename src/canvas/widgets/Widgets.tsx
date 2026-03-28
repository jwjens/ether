// ── QueueWidget ───────────────────────────────────────────────
import UpNext from "../../components/UpNext";
import MicDeck from "../../components/MicDeck";
import { LiveHourClock, SongHistoryStrip } from "../../components/LiveFeatures";
import { DeckState } from "../../audio/engine-rodio";
import { WidgetInstance } from "../WidgetRegistry";
import { useState } from "react";
import { query } from "../../db/client";

interface BaseProps { instance: WidgetInstance; }
interface EngineProps extends BaseProps { engine: any; }
interface DeckProps extends BaseProps { deckStates: Record<string, DeckState | null>; }

export function QueueWidget({ instance, engine }: EngineProps) {
  return (
    <div style={{ height: "100%", overflow: "hidden", background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border-primary)" }}>
      <UpNext queueLen={engine?.getQueue?.()?.length || 0} onQueueChange={() => {}} />
    </div>
  );
}

// ── MicWidget ─────────────────────────────────────────────────
export function MicWidget({ instance }: BaseProps) {
  return (
    <div style={{ height: "100%", overflow: "hidden" }}>
      <MicDeck />
    </div>
  );
}

// ── ClockWidget ───────────────────────────────────────────────
export function ClockWidget({ instance }: BaseProps) {
  return (
    <div style={{
      height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border-primary)",
    }}>
      <LiveHourClock />
    </div>
  );
}

// ── NowPlayingWidget ──────────────────────────────────────────
export function NowPlayingWidget({ instance, deckStates }: DeckProps) {
  const playing = Object.values(deckStates).find(d => d?.status === "playing");
  const title = playing?.title || "Nothing playing";
  const artist = playing?.artist || "";
  const pos = playing?.positionSec || 0;
  const dur = playing?.durationSec || 0;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  return (
    <div style={{
      height: "100%", padding: "14px 16px",
      background: "var(--bg-secondary)", borderRadius: 14,
      border: "1px solid var(--border-primary)",
      display: "flex", flexDirection: "column" as const, justifyContent: "center", gap: 6,
      fontFamily: "'Inter', sans-serif",
    }}>
      <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.14em", color: "var(--accent-cyan)", textTransform: "uppercase" as const }}>Now Playing</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{title}</div>
      {artist && <div style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{artist}</div>}
      {dur > 0 && (
        <div style={{ height: 3, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: pct + "%", background: "var(--accent-cyan)", borderRadius: 2, transition: "width 1s linear" }} />
        </div>
      )}
    </div>
  );
}

// ── HistoryWidget ─────────────────────────────────────────────
export function HistoryWidget({ instance }: BaseProps) {
  return (
    <div style={{
      height: "100%", overflow: "hidden",
      display: "flex", alignItems: "center",
      background: "var(--bg-secondary)",
      borderRadius: 14,
      border: "1px solid var(--border-primary)",
    }}>
      <SongHistoryStrip />
    </div>
  );
}

// ── LogoWidget ────────────────────────────────────────────────
export function LogoWidget({ instance }: BaseProps) {
  const [logoUrl, setLogoUrl] = useState<string | null>(instance.config.logoUrl || null);
  const [stationName, setStationName] = useState(instance.config.stationName || "");

  const handleUpload = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "svg", "webp"] }] });
      if (path && typeof path === "string") {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(path);
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        setLogoUrl(url);
      }
    } catch {}
  };

  return (
    <div style={{
      height: "100%",
      background: "var(--bg-secondary)",
      borderRadius: 14,
      border: "1px solid var(--border-primary)",
      display: "flex", flexDirection: "column" as const,
      alignItems: "center", justifyContent: "center", gap: 8,
      cursor: "pointer",
      overflow: "hidden",
    }}
    onClick={!logoUrl ? handleUpload : undefined}
    >
      {logoUrl ? (
        <>
          <img src={logoUrl} alt="Station logo" style={{ maxWidth: "80%", maxHeight: "70%", objectFit: "contain" }} />
          {stationName && <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textAlign: "center" as const }}>{stationName}</div>}
          <button
            onClick={e => { e.stopPropagation(); setLogoUrl(null); }}
            style={{ fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}
          >Change logo</button>
        </>
      ) : (
        <>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as const }}>Click to upload<br/>your station logo</div>
        </>
      )}
    </div>
  );
}

// ── LibraryWidget ─────────────────────────────────────────────
export function LibraryWidget({ instance, engine }: EngineProps) {
  const [songs, setSongs] = useState<any[]>([]);
  const [search, setSearch] = useState("");

  const load = async () => {
    try {
      const rows = await query<any>(
        "SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY s.title LIMIT 200"
      );
      setSongs(rows);
    } catch {}
  };

  useState(() => { load(); });

  const filtered = search ? songs.filter(s => s.title?.toLowerCase().includes(search.toLowerCase()) || s.artist_name?.toLowerCase().includes(search.toLowerCase())) : songs;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" as const, background: "var(--bg-secondary)", borderRadius: 14, border: "1px solid var(--border-primary)", overflow: "hidden", fontFamily: "'Inter', sans-serif" }}>
      {/* Search */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search songs..."
          style={{ width: "100%", padding: "6px 10px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }}
        />
      </div>
      {/* Song list */}
      <div style={{ flex: 1, overflowY: "auto" as const }}>
        {filtered.slice(0, 50).map((s, i) => (
          <div key={s.id} style={{ padding: "8px 12px", borderBottom: i < filtered.length - 1 ? "1px solid var(--border-primary)" : "none", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
            onClick={() => engine?.addToQueue?.([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "" }])}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{s.title}</div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{s.artist_name || "—"}</div>
            </div>
            <button onClick={e => { e.stopPropagation(); engine?.getDeck?.("A") && engine.loadToDeck?.("A", s.file_path, s.title, s.artist_name || ""); }}
              style={{ padding: "3px 7px", borderRadius: 5, background: "rgba(56,189,248,0.15)", color: "var(--accent-cyan)", border: "none", cursor: "pointer", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>A</button>
          </div>
        ))}
      </div>
    </div>
  );
}
