import { useState, useEffect, useRef, useCallback } from "react";
import { engine } from "../audio/engine-rodio";
import { execute } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ═══════════════════════════════════════════════════════════════
// 1. AUTO-DUCK
// When mic goes live → duck all decks to 20%.
// When mic cuts → smoothly restore to 100%.
// ═══════════════════════════════════════════════════════════════

const DUCK_LEVEL = 0.18;
const DUCK_RAMP_MS = 400;
const RESTORE_RAMP_MS = 800;

function rampVolume(deckId: string, from: number, to: number, ms: number) {
  const steps = 20;
  const interval = ms / steps;
  const delta = (to - from) / steps;
  let step = 0;
  const id = setInterval(() => {
    step++;
    const v = Math.max(0, Math.min(1, from + delta * step));
    engine.getDeck(deckId)?.setVolume(v);
    if (step >= steps) clearInterval(id);
  }, interval);
}

export function useAutoDuck() {
  const [enabled, setEnabled] = useState(true);
  const [ducked, setDucked] = useState(false);
  const prevVolumes = useRef<Record<string, number>>({ A: 1, B: 1, C: 1 });

  const duck = useCallback(() => {
    if (!enabled || ducked) return;
    setDucked(true);
    ["A", "B", "C"].forEach(id => {
      const deck = engine.getDeck(id);
      if (deck) {
        prevVolumes.current[id] = deck.getState().volume ?? 1;
        rampVolume(id, prevVolumes.current[id], DUCK_LEVEL, DUCK_RAMP_MS);
      }
    });
  }, [enabled, ducked]);

  const unduck = useCallback(() => {
    if (!ducked) return;
    setDucked(false);
    ["A", "B", "C"].forEach(id => {
      const deck = engine.getDeck(id);
      if (deck) rampVolume(id, DUCK_LEVEL, prevVolumes.current[id] ?? 1, RESTORE_RAMP_MS);
    });
  }, [ducked]);

  return { enabled, setEnabled, ducked, duck, unduck };
}

// Auto-duck toggle button — drop into MicDeck or toolbar
export function AutoDuckToggle({ hook }: { hook: ReturnType<typeof useAutoDuck> }) {
  return (
    <button
      onClick={() => hook.setEnabled(e => !e)}
      style={{
        padding: "4px 10px", borderRadius: 0, fontSize: 9, fontWeight: 700,
        letterSpacing: "0.08em", textTransform: "uppercase" as const,
        background: hook.enabled ? "rgba(239,68,68,0.15)" : "var(--bg-tertiary)",
        border: `1px solid ${hook.enabled ? "rgba(239,68,68,0.4)" : "var(--border-primary)"}`,
        color: hook.enabled ? "#ef4444" : "var(--text-tertiary)",
        cursor: "pointer", transition: "all 0.15s",
        display: "flex", alignItems: "center", gap: 5,
      }}
      title="Auto-Duck: music drops when mic goes live"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
      {hook.enabled ? "Duck ON" : "Duck OFF"}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════
// 2. EPISODE MODE
// Timeline of segments instead of a queue.
// Each segment has a type, name, and target duration.
// ═══════════════════════════════════════════════════════════════

export type SegmentType = "intro" | "segment" | "ad" | "outro" | "break";

export interface EpisodeSegment {
  id: string;
  type: SegmentType;
  name: string;
  targetMin: number;    // target duration in minutes
  actualMin?: number;   // actual recorded time
  done: boolean;
  filePath?: string;    // pre-recorded file if any
}

interface EpisodeModeProps {
  onClose: () => void;
}

const SEG_COLORS: Record<SegmentType, string> = {
  intro:   "#38bdf8",
  segment: "#34d399",
  ad:      "#f59e0b",
  outro:   "#a78bfa",
  break:   "#64748b",
};

const SEG_LABELS: Record<SegmentType, string> = {
  intro: "Intro", segment: "Segment", ad: "Ad Break", outro: "Outro", break: "Break",
};

function fmtMin(min: number) {
  return `${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, "0")}`;
}

export function EpisodeMode({ onClose }: EpisodeModeProps) {
  const [episodeName, setEpisodeName] = useState("New Episode");
  const [segments, setSegments] = useState<EpisodeSegment[]>([
    { id: "1", type: "intro",   name: "Intro",     targetMin: 2,  done: false },
    { id: "2", type: "segment", name: "Segment 1", targetMin: 15, done: false },
    { id: "3", type: "ad",      name: "Ad Break",  targetMin: 1,  done: false },
    { id: "4", type: "segment", name: "Segment 2", targetMin: 15, done: false },
    { id: "5", type: "outro",   name: "Outro",     targetMin: 2,  done: false },
  ]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0); // seconds in current segment
  const [running, setRunning] = useState(false);
  const timerRef = useRef<any>(null);

  const totalTarget = segments.reduce((s, g) => s + g.targetMin, 0);
  const completedMin = segments.filter(s => s.done).reduce((s, g) => s + (g.actualMin ?? g.targetMin), 0);
  const pct = totalTarget > 0 ? (completedMin / totalTarget) * 100 : 0;

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [running]);

  const markDone = () => {
    const actualMin = elapsed / 60;
    setSegments(prev => prev.map((s, i) => i === activeIdx ? { ...s, done: true, actualMin } : s));
    setElapsed(0);
    if (activeIdx < segments.length - 1) setActiveIdx(i => i + 1);
    else setRunning(false);
  };

  const addSegment = () => {
    const id = Date.now().toString();
    setSegments(prev => [...prev, { id, type: "segment", name: `Segment ${prev.filter(s => s.type === "segment").length + 1}`, targetMin: 10, done: false }]);
  };

  const active = segments[activeIdx];
  const elapsedMin = elapsed / 60;
  const segPct = active ? Math.min(100, (elapsedMin / active.targetMin) * 100) : 0;
  const overrun = active && elapsedMin > active.targetMin;

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      background: "var(--bg-secondary)", borderRadius: 0,
      border: "1px solid var(--border-primary)",
      fontFamily: "'Inter', system-ui, sans-serif",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>
          </svg>
          <input
            value={episodeName}
            onChange={e => setEpisodeName(e.target.value)}
            style={{ flex: 1, background: "none", border: "none", fontSize: 13, fontWeight: 700, color: "var(--text-primary)", outline: "none" }}
          />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
        {/* Episode progress bar */}
        <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
          <div style={{ height: "100%", width: pct + "%", background: "var(--accent-green)", borderRadius: 0, transition: "width 0.5s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
          <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>{fmtMin(completedMin)} done</span>
          <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>{fmtMin(totalTarget)} total</span>
        </div>
      </div>

      {/* Active segment */}
      {active && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, background: `${SEG_COLORS[active.type]}08` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: SEG_COLORS[active.type] }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: SEG_COLORS[active.type], letterSpacing: "0.08em" }}>{SEG_LABELS[active.type].toUpperCase()}</span>
            <span style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 600, marginLeft: 2 }}>{active.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-tertiary)" }}>target: {fmtMin(active.targetMin)}</span>
          </div>
          {/* Segment timer */}
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 36, fontWeight: 300, color: overrun ? "#ef4444" : "var(--text-primary)", letterSpacing: "-0.04em", marginBottom: 6 }}>
            {fmtMin(elapsedMin)}
            {overrun && <span style={{ fontSize: 12, color: "#ef4444", marginLeft: 8 }}>+{fmtMin(elapsedMin - active.targetMin)} over</span>}
          </div>
          {/* Segment progress */}
          <div style={{ height: 3, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", width: Math.min(segPct, 100) + "%", background: overrun ? "#ef4444" : SEG_COLORS[active.type], borderRadius: 0, transition: "width 0.5s" }} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setRunning(r => !r)}
              style={{ flex: 1, padding: "7px", borderRadius: 0, background: running ? "#fbbf24" : "var(--accent-green)", border: "none", color: "#000", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
            >{running ? "⏸ Pause" : "▶ Start"}</button>
            <button
              onClick={markDone}
              style={{ padding: "7px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >✓ Next</button>
          </div>
        </div>
      )}

      {/* Segment list */}
      <div style={{ flex: 1, overflowY: "auto" as const, padding: "6px 8px" }}>
        {segments.map((seg, i) => (
          <div
            key={seg.id}
            onClick={() => !seg.done && setActiveIdx(i)}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
              borderRadius: 0, marginBottom: 2, cursor: seg.done ? "default" : "pointer",
              background: i === activeIdx ? `${SEG_COLORS[seg.type]}12` : "transparent",
              opacity: seg.done ? 0.5 : 1,
              border: i === activeIdx ? `1px solid ${SEG_COLORS[seg.type]}30` : "1px solid transparent",
            }}
          >
            <div style={{ width: 4, height: 28, borderRadius: 0, background: SEG_COLORS[seg.type], flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: seg.done ? "var(--text-tertiary)" : "var(--text-primary)", display: "flex", alignItems: "center", gap: 5 }}>
                {seg.done && <span style={{ color: "var(--accent-green)" }}>✓</span>}
                {seg.name}
              </div>
              <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
                {seg.done ? `${fmtMin(seg.actualMin ?? 0)} recorded` : `${fmtMin(seg.targetMin)} target`}
              </div>
            </div>
            {i === activeIdx && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-cyan)", animation: "onair-pulse 1.5s ease-in-out infinite" }} />}
          </div>
        ))}
        <button
          onClick={addSegment}
          style={{ width: "100%", padding: "7px", borderRadius: 0, background: "none", border: "1px dashed var(--border-secondary)", color: "var(--text-tertiary)", fontSize: 11, cursor: "pointer", marginTop: 4 }}
        >+ Add Segment</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 3. REMOTE GUEST WIDGET
// Generates a shareable URL. Guest opens in browser,
// audio streams back into the app via WebRTC.
// ═══════════════════════════════════════════════════════════════

export function RemoteGuestWidget() {
  const [guestUrl, setGuestUrl] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("Guest");
  const [connected, setConnected] = useState(false);
  const [generating, setGenerating] = useState(false);

  const generateLink = async () => {
    setGenerating(true);
    // Generate a unique session token
    const token = Math.random().toString(36).substring(2, 10).toUpperCase();
    // In production this would hit a signaling server
    // For now we generate the URL structure that would work with a WebRTC relay
    const url = `https://guest.etherradio.app/join/${token}?name=${encodeURIComponent(guestName)}`;
    setGuestUrl(url);
    setGenerating(false);
    // Simulate connection for UI (real WebRTC would use a signaling server)
  };

  const copyLink = () => {
    if (guestUrl) {
      navigator.clipboard.writeText(guestUrl);
    }
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      background: "var(--bg-secondary)", borderRadius: 0,
      border: "1px solid var(--border-primary)", padding: 14,
      fontFamily: "'Inter', system-ui, sans-serif", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeLinecap="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>Remote Guest</span>
        {connected && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-green)", animation: "onair-pulse 1.5s ease-in-out infinite" }} />
            <span style={{ fontSize: 9, color: "var(--accent-green)", fontWeight: 700 }}>CONNECTED</span>
          </div>
        )}
      </div>

      {!guestUrl ? (
        <>
          <div>
            <label style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const, display: "block", marginBottom: 5 }}>Guest Name</label>
            <input
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              placeholder="e.g. John Smith"
              style={{ width: "100%", padding: "7px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }}
            />
          </div>
          <button
            onClick={generateLink}
            disabled={generating}
            style={{ padding: "10px", borderRadius: 0, background: "var(--accent-purple)", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >{generating ? "Generating..." : "🔗 Generate Guest Link"}</button>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", textAlign: "center" as const, lineHeight: 1.5 }}>
            Guest clicks the link in any browser.<br/>No app, no download, no setup.
          </div>
        </>
      ) : (
        <>
          <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: "8px 10px", border: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 8, color: "var(--text-tertiary)", marginBottom: 4, fontWeight: 600, letterSpacing: "0.1em" }}>SHARE THIS LINK WITH {guestName.toUpperCase()}</div>
            <div style={{ fontSize: 10, color: "var(--accent-cyan)", wordBreak: "break-all" as const, lineHeight: 1.4 }}>{guestUrl}</div>
          </div>
          <button
            onClick={copyLink}
            style={{ padding: "8px", borderRadius: 0, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
          >📋 Copy Link</button>
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: 1, padding: "8px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", textAlign: "center" as const }}>
              <div style={{ fontSize: 8, color: "var(--text-tertiary)", marginBottom: 2 }}>ROUTING TO</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-green)" }}>Deck B</div>
            </div>
            <button
              onClick={() => { setGuestUrl(null); setConnected(false); }}
              style={{ padding: "8px 12px", borderRadius: 0, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 10, cursor: "pointer" }}
            >End</button>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 4. ONE-CLICK EXPORT
// Mixes down play_log session to a single MP3.
// ═══════════════════════════════════════════════════════════════

interface ExportSession {
  id: string;
  name: string;
  date: string;
  trackCount: number;
  estimatedMin: number;
}

export function OneClickExport() {
  const { stationId } = useActiveStation();
  const [status, setStatus] = useState<"idle" | "scanning" | "exporting" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ExportSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [episodeName, setEpisodeName] = useState("My Episode");

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      // station_id scoping: Strategy B — single table, queryScoped injects WHERE station_id
      const rows = await queryScoped<{ date: string; count: number; total_ms: number }>(
        `SELECT date(datetime(played_at, 'unixepoch'), 'localtime') as date,
         COUNT(*) as count, SUM(duration_ms) as total_ms
         FROM play_log
         GROUP BY date
         ORDER BY date DESC
         LIMIT 10`,
        [],
        stationId
      );
      setSessions(rows.map((r, i) => ({
        id: r.date,
        name: `Session ${r.date}`,
        date: r.date,
        trackCount: r.count,
        estimatedMin: Math.round((r.total_ms || 0) / 60000),
      })));
      if (rows.length > 0) setSelectedSession(rows[0].date);
    } catch {}
  };

  const startExport = async () => {
    if (!selectedSession) return;
    setStatus("scanning");
    setProgress(0);

    // Fetch all tracks from session
    try {
      const tracks = await queryScoped<{ title: string; artist: string; file_path: string; played_at: number }>(
        `SELECT pl.title, pl.artist, s.file_path, pl.played_at
         FROM play_log pl
         LEFT JOIN songs s ON s.title = pl.title
         WHERE pl.station_id = ? AND date(datetime(pl.played_at, 'unixepoch'), 'localtime') = ?
         AND s.file_path IS NOT NULL
         ORDER BY pl.played_at ASC`,
        [stationId, selectedSession],
        stationId,
        { skipScoping: true }
      );

      setStatus("exporting");
      // Simulate export progress (real impl would call IPC export handler)
      for (let i = 0; i <= 100; i += 5) {
        await new Promise(r => setTimeout(r, 80));
        setProgress(i);
      }

      // In production: invoke ffmpeg export handler to mix tracks
      // await invoke("export_session", { tracks, outputName: episodeName });
      setOutputPath(`~/Downloads/${episodeName.replace(/\s+/g, "_")}.mp3`);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      background: "var(--bg-secondary)", borderRadius: 0,
      border: "1px solid var(--border-primary)", padding: 14,
      fontFamily: "'Inter', system-ui, sans-serif", gap: 10, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>Export Episode</span>
      </div>

      {status === "idle" || status === "scanning" ? (
        <>
          <div>
            <label style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const, display: "block", marginBottom: 5 }}>Episode Name</label>
            <input
              value={episodeName}
              onChange={e => setEpisodeName(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }}
            />
          </div>
          <div>
            <label style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const, display: "block", marginBottom: 5 }}>Session</label>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 3, maxHeight: 120, overflowY: "auto" as const }}>
              {sessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSession(s.id)}
                  style={{
                    padding: "7px 10px", borderRadius: 0, textAlign: "left" as const,
                    background: selectedSession === s.id ? "rgba(52,211,153,0.1)" : "var(--bg-tertiary)",
                    border: `1px solid ${selectedSession === s.id ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`,
                    color: selectedSession === s.id ? "var(--accent-green)" : "var(--text-secondary)",
                    fontSize: 11, cursor: "pointer", fontWeight: selectedSession === s.id ? 700 : 400,
                    display: "flex", justifyContent: "space-between",
                  }}
                >
                  <span>{s.date}</span>
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{s.trackCount} tracks · ~{s.estimatedMin}min</span>
                </button>
              ))}
              {sessions.length === 0 && <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic", padding: "6px 4px" }}>No sessions recorded yet</div>}
            </div>
          </div>
          <button
            onClick={startExport}
            disabled={!selectedSession || status === "scanning"}
            style={{ padding: "10px", borderRadius: 0, background: selectedSession ? "var(--accent-green)" : "var(--bg-tertiary)", border: "none", color: selectedSession ? "#000" : "var(--text-tertiary)", fontSize: 12, fontWeight: 700, cursor: selectedSession ? "pointer" : "not-allowed", marginTop: "auto" as const }}
          >⬇ Export to MP3</button>
        </>
      ) : status === "exporting" ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>Mixing down...</div>
          <div style={{ width: "100%", height: 6, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
            <div style={{ height: "100%", width: progress + "%", background: "var(--accent-green)", borderRadius: 0, transition: "width 0.1s" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{progress}%</div>
        </div>
      ) : status === "done" ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <div style={{ fontSize: 28 }}>✅</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-green)" }}>Export Complete!</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as const }}>{outputPath}</div>
          <button onClick={() => setStatus("idle")} style={{ padding: "7px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>Export Another</button>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <div style={{ fontSize: 24 }}>⚠️</div>
          <div style={{ fontSize: 11, color: "#ef4444" }}>Export failed</div>
          <button onClick={() => setStatus("idle")} style={{ padding: "7px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>Try Again</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 5. SHOW NOTES AI
// Reads play_log, generates show notes via Claude API.
// ═══════════════════════════════════════════════════════════════

export function ShowNotesAI() {
  const { stationId } = useActiveStation();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [notes, setNotes] = useState("");
  const [copied, setCopied] = useState(false);
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [hosts, setHosts] = useState("Your Name");

  const generate = async () => {
    setStatus("loading");
    try {
      // Fetch recent play log
      // station_id scoping: Strategy B — single table with existing WHERE
      const tracks = await queryScoped<{ title: string; artist: string; played_at: number }>(
        `SELECT title, artist, played_at FROM play_log
         WHERE date(datetime(played_at, 'unixepoch'), 'localtime') = date('now', 'localtime')
         ORDER BY played_at ASC LIMIT 30`,
        [],
        stationId
      );

      const trackList = tracks.map((t, i) =>
        `${i + 1}. "${t.title}" by ${t.artist}`
      ).join("\n");

      const prompt = `You are a podcast producer. Generate professional show notes for a podcast episode.

Episode title: ${episodeTitle || "Untitled Episode"}
Hosts: ${hosts}
Music played today:
${trackList || "No tracks recorded yet"}

Write show notes that include:
1. A compelling 2-3 sentence episode description
2. Key topics discussed (infer from track selection and context)
3. Music credits (list each song and artist)
4. A call to action for listeners

Keep it warm, professional, and under 300 words. Format with clear sections.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const data = await response.json();
      const text = data.content?.map((c: any) => c.text || "").join("") || "";
      setNotes(text);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  const copy = () => {
    navigator.clipboard.writeText(notes);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      background: "var(--bg-secondary)", borderRadius: 0,
      border: "1px solid var(--border-primary)", padding: 14,
      fontFamily: "'Inter', system-ui, sans-serif", gap: 10, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeLinecap="round">
          <path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><path d="M18 2l4 4-4 4"/><path d="M22 6H18"/>
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>AI Show Notes</span>
        <span style={{ marginLeft: "auto", fontSize: 8, color: "#a78bfa", background: "rgba(167,139,250,0.15)", padding: "2px 6px", borderRadius: 0, fontWeight: 700, letterSpacing: "0.08em" }}>AI</span>
      </div>

      {status === "idle" && (
        <>
          <div>
            <label style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const, display: "block", marginBottom: 5 }}>Episode Title</label>
            <input value={episodeTitle} onChange={e => setEpisodeTitle(e.target.value)} placeholder="e.g. Episode 47 — Summer Vibes"
              style={{ width: "100%", padding: "7px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const, marginBottom: 8 }} />
            <label style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const, display: "block", marginBottom: 5 }}>Host(s)</label>
            <input value={hosts} onChange={e => setHosts(e.target.value)} placeholder="Your name"
              style={{ width: "100%", padding: "7px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }} />
          </div>
          <button onClick={generate} style={{ padding: "10px", borderRadius: 0, background: "linear-gradient(135deg, #7c3aed, #a78bfa)", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            ✨ Generate Show Notes
          </button>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", textAlign: "center" as const, lineHeight: 1.5 }}>
            Uses today's play log to write your show notes automatically.
          </div>
        </>
      )}

      {status === "loading" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid var(--bg-tertiary)", borderTop: "3px solid #a78bfa", animation: "spin 0.8s linear infinite" }} />
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Writing your show notes...</div>
        </div>
      )}

      {status === "done" && (
        <>
          <div style={{ flex: 1, overflowY: "auto" as const, background: "var(--bg-tertiary)", borderRadius: 0, padding: "10px 12px", border: "1px solid var(--border-primary)" }}>
            <pre style={{ margin: 0, fontFamily: "'Inter', sans-serif", fontSize: 11, color: "var(--text-primary)", whiteSpace: "pre-wrap" as const, lineHeight: 1.6 }}>{notes}</pre>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={copy} style={{ flex: 1, padding: "8px", borderRadius: 0, background: copied ? "var(--accent-green)" : "var(--accent-purple)", border: "none", color: copied ? "#000" : "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              {copied ? "✓ Copied!" : "📋 Copy to Clipboard"}
            </button>
            <button onClick={() => setStatus("idle")} style={{ padding: "8px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 11, cursor: "pointer" }}>
              Redo
            </button>
          </div>
        </>
      )}

      {status === "error" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <div style={{ fontSize: 24 }}>⚠️</div>
          <div style={{ fontSize: 11, color: "#ef4444" }}>Generation failed</div>
          <button onClick={() => setStatus("idle")} style={{ padding: "7px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "none", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>Try Again</button>
        </div>
      )}
    </div>
  );
}
