/**
 * SpotifyImport.tsx — Spotify Library Integration
 *
 * Two-layer content safety pipeline:
 *   Layer 1 — Spotify acoustic data: valence, energy, speechiness thresholds
 *              + Spotify explicit flag (server-side + client-side double-check)
 *   Layer 2 — Musixmatch lyrical scan: violence, sexual content, hate speech,
 *              political terms flagged amber for manual review
 *
 * Workflow:
 *   1. Pick genre seeds
 *   2. Set safety sliders
 *   3. Import → preview list of clean tracks
 *   4. Confirm & Write to Library
 *   5. Optional: Run Lyrics Scan on confirmed tracks
 */

import { useState, useEffect, useRef } from "react";

// ── Genre seeds ───────────────────────────────────────────────

interface GenreSeed {
  id:    string;   // Spotify genre ID
  label: string;
  emoji: string;
}

const GENRE_SEEDS: GenreSeed[] = [
  { id: "soul",       label: "Soul",       emoji: "🎷" },
  { id: "motown",     label: "Motown",     emoji: "🎤" },
  { id: "funk",       label: "Funk",       emoji: "🎸" },
  { id: "pop",        label: "Pop",        emoji: "🎵" },
  { id: "r-n-b",      label: "R&B",        emoji: "🎶" },
  { id: "jazz",       label: "Jazz",       emoji: "🎺" },
  { id: "classical",  label: "Classical",  emoji: "🎻" },
  { id: "country",    label: "Country",    emoji: "🤠" },
  { id: "gospel",     label: "Gospel",     emoji: "✝️" },
  { id: "acoustic",   label: "Acoustic",   emoji: "🪗" },
  { id: "ambient",    label: "Ambient",    emoji: "🌊" },
  { id: "electronic", label: "Electronic", emoji: "🎛" },
];

// ── Track types ───────────────────────────────────────────────

interface SpotifyTrack {
  title:      string;
  artist:     string;
  album:      string;
  durationMs: number;
  spotifyUri: string;
  spotifyId:  string;
  explicit:   boolean;
  previewUrl: string | null;
  imageUrl:   string | null;
}

interface LyricResult {
  found:    boolean;
  flagged:  boolean;
  matches:  { category: string; term: string }[];
  scanning?: boolean;
  error?:   string;
}

interface ImportedTrack extends SpotifyTrack {
  approved:   boolean;   // user can reject individual tracks
  lyric:      LyricResult | null;
  written:    boolean;
}

// ── Helpers ───────────────────────────────────────────────────

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Main component ────────────────────────────────────────────

interface Props { onClose: () => void; }

export default function SpotifyImport({ onClose }: Props) {
  // Controls
  const [seeds, setSeeds]             = useState<string[]>(["soul", "pop"]);
  const [valence, setValence]         = useState(0.7);
  const [energy, setEnergy]           = useState(0.7);
  const [speechiness, setSpeechiness] = useState(0.05);
  const [trackLimit, setTrackLimit]   = useState(100);

  // State machine: idle → fetching → preview → importing → done
  type Phase = "idle" | "fetching" | "preview" | "importing" | "done";
  const [phase, setPhase]             = useState<Phase>("idle");
  const [tracks, setTracks]           = useState<ImportedTrack[]>([]);
  const [error, setError]             = useState<string | null>(null);
  const [progress, setProgress]       = useState("");
  const [lyricPhase, setLyricPhase]   = useState<"idle" | "running" | "done">("idle");
  const cancelRef                     = useRef(false);

  // Credential status
  const [credStatus, setCredStatus]   = useState<{ hasClientId: boolean; hasClientSecret: boolean } | null>(null);

  // Load cred status on mount
  useEffect(() => {
    (window as any).ether.spotify.getCredentialStatus().then(setCredStatus).catch(() => {});
  }, []);

  // ── Genre toggle ──────────────────────────────────────────

  const toggleSeed = (id: string) => {
    setSeeds(prev => {
      if (prev.includes(id)) return prev.length > 1 ? prev.filter(s => s !== id) : prev;
      if (prev.length >= 5) return prev; // Spotify max 5
      return [...prev, id];
    });
  };

  // ── Fetch from Spotify ────────────────────────────────────

  const runImport = async () => {
    setError(null);
    setPhase("fetching");
    cancelRef.current = false;

    try {
      // Spotify API returns max 100 per call. For larger limits, make multiple calls.
      const calls = Math.ceil(trackLimit / 100);
      const allTracks: SpotifyTrack[] = [];

      for (let i = 0; i < calls; i++) {
        if (cancelRef.current) break;
        const result = await (window as any).ether.spotify.getRecommendations({
          seeds,
          valence,
          energy,
          speechiness,
          limit: Math.min(100, trackLimit - allTracks.length),
        });
        if (!result.ok) { setError(result.error); setPhase("idle"); return; }
        // Client-side explicit re-check (belt and suspenders)
        const clean = (result.tracks as SpotifyTrack[]).filter(t => !t.explicit);
        allTracks.push(...clean);
      }

      // Deduplicate by title+artist
      const seen = new Set<string>();
      const deduped = allTracks.filter(t => {
        const key = `${t.title.toLowerCase()}::${t.artist.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      setTracks(deduped.map(t => ({ ...t, approved: true, lyric: null, written: false })));
      setPhase("preview");
    } catch (e: any) {
      setError(e.message || "Unknown error");
      setPhase("idle");
    }
  };

  // ── Write to library ──────────────────────────────────────

  const confirmImport = async () => {
    setPhase("importing");
    const approved = tracks.filter(t => t.approved);
    let done = 0;

    for (const track of approved) {
      if (cancelRef.current) break;
      const result = await (window as any).ether.library.writeTrack({
        title:      track.title,
        artist:     track.artist,
        album:      track.album,
        durationMs: track.durationMs,
        spotifyUri: track.spotifyUri,
      });
      done++;
      setProgress(`Writing to library… ${done}/${approved.length}`);
      setTracks(prev => prev.map(t => t.spotifyId === track.spotifyId ? { ...t, written: result.ok } : t));
    }

    setPhase("done");
  };

  // ── Lyric scan ────────────────────────────────────────────

  const runLyricScan = async () => {
    setLyricPhase("running");
    const toScan = tracks.filter(t => t.approved && t.written && !t.lyric);

    for (const track of toScan) {
      if (cancelRef.current) break;
      setTracks(prev => prev.map(t => t.spotifyId === track.spotifyId
        ? { ...t, lyric: { found: false, flagged: false, matches: [], scanning: true } } : t));

      const result = await (window as any).ether.musixmatch.scanLyrics(track.title, track.artist);
      setTracks(prev => prev.map(t => t.spotifyId === track.spotifyId
        ? { ...t, lyric: result.ok ? { found: result.found, flagged: result.flagged, matches: result.matches || [] } : { found: false, flagged: false, matches: [], error: result.error } }
        : t));
    }

    setLyricPhase("done");
  };

  // ── Styles ────────────────────────────────────────────────

  const S = {
    bg:      "#0e0e12",
    card:    "#111118",
    border:  "#1e1e2e",
    text:    "#e0e0f0",
    muted:   "#4a4a6a",
    purple:  "var(--accent-blue)",
    green:   "#34d399",
    amber:   "#f59e0b",
    red:     "#ef4444",
    blue:    "var(--accent-blue)",
  } as const;

  const approvedCount = tracks.filter(t => t.approved).length;
  const flaggedCount  = tracks.filter(t => t.lyric?.flagged).length;

  // ── Render ────────────────────────────────────────────────

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9995,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 860, maxHeight: "90vh",
        background: S.bg, border: `1px solid ${S.border}`,
        display: "flex", flexDirection: "column",
        boxShadow: "0 40px 100px rgba(0,0,0,0.7)",
        overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 24px", borderBottom: `1px solid ${S.border}`, flexShrink: 0 }}>
          <div style={{ width: 32, height: 32, background: "#1db954", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: S.text, letterSpacing: "-0.02em", fontFamily: "'Syne', sans-serif" }}>Import from Spotify</div>
            <div style={{ fontSize: 11, color: S.muted, marginTop: 2 }}>
              Two-layer content safety · Acoustic filters + Lyric scan · Explicit always blocked
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {credStatus && !credStatus.hasClientId && (
            <div style={{ fontSize: 10, color: S.amber, padding: "4px 10px", border: `1px solid ${S.amber}40`, background: `${S.amber}10` }}>
              Add credentials in Settings → AI &amp; Integrations
            </div>
          )}
          <button onClick={onClose} style={{ width: 28, height: 28, background: "transparent", border: `1px solid ${S.border}`, color: S.muted, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

          {/* Left — controls */}
          <div style={{ width: 280, flexShrink: 0, borderRight: `1px solid ${S.border}`, overflowY: "auto", padding: "20px 18px", display: "flex", flexDirection: "column", gap: 22 }}>

            {/* Genre seeds */}
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: S.muted, textTransform: "uppercase", marginBottom: 10 }}>
                Genre Seeds <span style={{ fontSize: 9, fontWeight: 400, color: "#2a2a4a", marginLeft: 4 }}>max 5</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {GENRE_SEEDS.map(g => {
                  const active = seeds.includes(g.id);
                  return (
                    <button key={g.id} onClick={() => toggleSeed(g.id)} style={{
                      padding: "5px 10px", border: "none", borderRadius: 0,
                      background: active ? S.purple + "30" : "#18181f",
                      outline: active ? `1px solid ${S.purple}` : `1px solid ${S.border}`,
                      color: active ? "#c0a8ff" : S.muted,
                      fontSize: 11, fontWeight: active ? 700 : 400, cursor: "pointer",
                      transition: "all 0.1s",
                    }}>
                      {g.emoji} {g.label}
                    </button>
                  );
                })}
              </div>
              {seeds.length >= 5 && <div style={{ fontSize: 10, color: S.amber, marginTop: 6 }}>Max 5 genres selected</div>}
            </div>

            {/* Safety sliders */}
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: S.muted, textTransform: "uppercase", marginBottom: 12 }}>Content Safety</div>

              <SafetySlider
                label="How Happy"
                hint="Minimum positivity (valence)"
                value={valence} min={0} max={1} step={0.05}
                onChange={setValence}
                color={S.green}
                display={v => `${Math.round(v * 100)}%`}
              />
              <SafetySlider
                label="How Upbeat"
                hint="Minimum energy level"
                value={energy} min={0} max={1} step={0.05}
                onChange={setEnergy}
                color={S.blue}
                display={v => `${Math.round(v * 100)}%`}
              />
              <SafetySlider
                label="No Talking / Skits"
                hint="Max speechiness (lower = less speech)"
                value={speechiness} min={0} max={0.5} step={0.01}
                onChange={setSpeechiness}
                color={S.amber}
                display={v => v <= 0.05 ? "Strict" : v <= 0.15 ? "Moderate" : "Loose"}
                invert
              />

              {/* Explicit — always blocked */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, padding: "8px 12px", background: "#0a0a0e", border: `1px solid ${S.border}` }}>
                <div style={{ width: 20, height: 20, background: S.red + "20", border: `1px solid ${S.red}40`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={S.red} strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: S.red }}>Explicit — Always Blocked</div>
                  <div style={{ fontSize: 9, color: S.muted, marginTop: 1 }}>Two-layer check: Spotify flag + local filter</div>
                </div>
              </div>
            </div>

            {/* Track count */}
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: S.muted, textTransform: "uppercase", marginBottom: 10 }}>Tracks to Fetch</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[50, 100, 200, 500].map(n => (
                  <button key={n} onClick={() => setTrackLimit(n)} style={{
                    flex: 1, padding: "7px 0", border: "none", borderRadius: 0,
                    background: trackLimit === n ? S.purple + "30" : "#18181f",
                    outline: trackLimit === n ? `1px solid ${S.purple}` : `1px solid ${S.border}`,
                    color: trackLimit === n ? "#c0a8ff" : S.muted,
                    fontSize: 11, fontWeight: trackLimit === n ? 700 : 400, cursor: "pointer",
                    transition: "all 0.1s",
                  }}>{n}</button>
                ))}
              </div>
              {trackLimit > 100 && (
                <div style={{ fontSize: 10, color: S.muted, marginTop: 6 }}>
                  Requires {Math.ceil(trackLimit / 100)} API calls — may take a moment
                </div>
              )}
            </div>

            {/* Import button */}
            <div>
              {error && (
                <div style={{ padding: "10px 12px", background: S.red + "12", border: `1px solid ${S.red}40`, fontSize: 11, color: S.red, marginBottom: 10 }}>
                  {error}
                </div>
              )}
              <button
                onClick={runImport}
                disabled={phase === "fetching" || phase === "importing"}
                style={{
                  width: "100%", padding: "13px 0", border: "none", borderRadius: 0,
                  background: phase === "fetching" ? "#18181f" : "#1db954",
                  color: phase === "fetching" ? S.muted : "#000",
                  fontSize: 13, fontWeight: 800, cursor: phase === "fetching" ? "default" : "pointer",
                  letterSpacing: "0.04em", fontFamily: "'Syne', sans-serif",
                  transition: "all 0.2s",
                }}
              >
                {phase === "fetching" ? "Scanning Spotify…" : phase === "preview" || phase === "done" ? "Re-Fetch" : "Fetch Tracks"}
              </button>
            </div>

          </div>

          {/* Right — preview + results */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>

            {phase === "idle" && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: S.muted }}>
                <div style={{ fontSize: 32, opacity: 0.3 }}>🎵</div>
                <div style={{ fontSize: 13 }}>Configure your filters and click Fetch Tracks</div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>Clean tracks will appear here for review before being added to your library</div>
              </div>
            )}

            {phase === "fetching" && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <div style={{ width: 36, height: 36, border: `3px solid ${S.border}`, borderTop: `3px solid #1db954`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                <div style={{ fontSize: 13, color: S.muted }}>Scanning Spotify Recommendations…</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {(phase === "preview" || phase === "importing" || phase === "done") && (
              <>
                {/* Track list header */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: `1px solid ${S.border}`, flexShrink: 0, background: "#0c0c10" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: S.text }}>
                    {tracks.length} clean tracks found
                  </div>
                  <div style={{ fontSize: 11, color: S.muted }}>
                    {approvedCount} approved
                    {flaggedCount > 0 && <span style={{ color: S.amber, marginLeft: 8 }}>{flaggedCount} lyric flags</span>}
                  </div>
                  <div style={{ flex: 1 }} />

                  {/* Lyric scan button */}
                  {phase === "done" && lyricPhase !== "running" && (
                    <button
                      onClick={runLyricScan}
                      style={{
                        padding: "6px 14px", border: `1px solid ${S.amber}50`, borderRadius: 0,
                        background: `${S.amber}10`, color: S.amber,
                        fontSize: 11, fontWeight: 700, cursor: "pointer",
                      }}
                    >
                      {lyricPhase === "done" ? "Re-Scan Lyrics" : "Scan Lyrics (Musixmatch)"}
                    </button>
                  )}
                  {lyricPhase === "running" && (
                    <div style={{ fontSize: 11, color: S.amber }}>Scanning lyrics…</div>
                  )}

                  {/* Confirm import */}
                  {phase === "preview" && (
                    <button
                      onClick={confirmImport}
                      style={{
                        padding: "8px 20px", border: "none", borderRadius: 0,
                        background: S.green, color: "#000",
                        fontSize: 12, fontWeight: 800, cursor: "pointer",
                        letterSpacing: "0.03em", fontFamily: "'Syne', sans-serif",
                      }}
                    >
                      Confirm & Import {approvedCount} Tracks →
                    </button>
                  )}

                  {phase === "importing" && (
                    <div style={{ fontSize: 11, color: S.muted }}>{progress}</div>
                  )}

                  {phase === "done" && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: S.green }}>
                      ✓ {tracks.filter(t => t.written).length} tracks added to library
                    </div>
                  )}
                </div>

                {/* Track rows */}
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {tracks.map(track => (
                    <TrackRow
                      key={track.spotifyId}
                      track={track}
                      phase={phase}
                      onToggleApprove={() => setTracks(prev =>
                        prev.map(t => t.spotifyId === track.spotifyId ? { ...t, approved: !t.approved } : t)
                      )}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ height: 32, borderTop: `1px solid ${S.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: "#1a1a28", letterSpacing: "0.14em", fontFamily: "'DM Mono', monospace" }}>BUILT BY DENIRO</span>
          <span style={{ fontSize: 9, color: S.muted }}>Explicit blocked · Acoustic screened · Lyric verified</span>
        </div>

      </div>
    </div>
  );
}

// ── Safety slider sub-component ───────────────────────────────

function SafetySlider({ label, hint, value, min, max, step, onChange, color, display, invert }: {
  label: string; hint: string;
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
  color: string;
  display: (v: number) => string;
  invert?: boolean;
}) {
  const fillPct = invert
    ? (1 - (value - min) / (max - min)) * 100
    : ((value - min) / (max - min)) * 100;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#c0c0e0" }}>{label}</div>
          <div style={{ fontSize: 9, color: "#3a3a5a" }}>{hint}</div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'DM Mono', monospace" }}>{display(value)}</div>
      </div>
      <div style={{ position: "relative", height: 4, background: "#18181f", border: "1px solid #1e1e2e" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${fillPct}%`, background: color, transition: "width 0.1s" }} />
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", marginTop: 4, accentColor: color, cursor: "pointer" }}
      />
    </div>
  );
}

// ── Track row sub-component ───────────────────────────────────

function TrackRow({ track, phase, onToggleApprove }: {
  track: ImportedTrack;
  phase: string;
  onToggleApprove: () => void;
}) {
  const S = {
    border: "#1e1e2e", text: "#e0e0f0", muted: "#4a4a6a",
    green: "#34d399", amber: "#f59e0b", red: "#ef4444",
  };

  const flagColor = track.lyric?.flagged ? S.amber : track.lyric?.found === false && track.lyric ? "#3a3a5a" : "transparent";
  const isRejected = !track.approved;
  const isWritten  = track.written;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
      borderBottom: `1px solid ${S.border}`,
      background: isRejected ? "#0a0a0e" : track.lyric?.flagged ? `${S.amber}06` : "transparent",
      opacity: isRejected ? 0.4 : 1,
      transition: "all 0.15s",
    }}>
      {/* Artwork */}
      <div style={{ width: 32, height: 32, background: "#18181f", flexShrink: 0, overflow: "hidden" }}>
        {track.imageUrl
          ? <img src={track.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, opacity: 0.3 }}>♪</div>}
      </div>

      {/* Track info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{track.title}</div>
        <div style={{ fontSize: 10, color: S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{track.artist}</div>
      </div>

      {/* Album */}
      <div style={{ width: 120, fontSize: 10, color: "#2a2a4a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
        {track.album}
      </div>

      {/* Duration */}
      <div style={{ fontSize: 10, color: S.muted, fontFamily: "'DM Mono', monospace", width: 36, textAlign: "right", flexShrink: 0 }}>
        {fmtDur(track.durationMs)}
      </div>

      {/* Lyric scan result */}
      <div style={{ width: 80, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {track.lyric?.scanning && <div style={{ fontSize: 9, color: S.muted }}>Scanning…</div>}
        {track.lyric && !track.lyric.scanning && track.lyric.flagged && (
          <div title={track.lyric.matches.map(m => `${m.category}: "${m.term}"`).join(", ")} style={{
            padding: "2px 7px", fontSize: 9, fontWeight: 700, color: S.amber,
            background: `${S.amber}15`, border: `1px solid ${S.amber}40`,
            cursor: "help",
          }}>
            ⚠ {track.lyric.matches.length} flag{track.lyric.matches.length !== 1 ? "s" : ""}
          </div>
        )}
        {track.lyric && !track.lyric.scanning && !track.lyric.flagged && track.lyric.found && (
          <div style={{ fontSize: 9, color: S.green }}>✓ Clean</div>
        )}
        {track.lyric && !track.lyric.scanning && !track.lyric.found && (
          <div style={{ fontSize: 9, color: "#2a2a4a" }}>No lyrics</div>
        )}
      </div>

      {/* Written status */}
      {isWritten && (
        <div style={{ width: 16, flexShrink: 0, color: S.green, fontSize: 12 }}>✓</div>
      )}

      {/* Approve/reject toggle */}
      {phase === "preview" && (
        <button onClick={onToggleApprove} style={{
          width: 28, height: 28, border: `1px solid ${isRejected ? S.red : S.border}`,
          background: isRejected ? `${S.red}15` : "transparent",
          color: isRejected ? S.red : S.muted,
          cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 0, flexShrink: 0,
        }} title={isRejected ? "Click to approve" : "Click to reject"}>
          {isRejected ? "+" : "−"}
        </button>
      )}
    </div>
  );
}
