// src/components/SmartSegueEditor.tsx
//
// The Smart Segue Editor — 3-track visual timeline.
// Track 1: Outgoing Song (outro zone highlighted amber)
// Track 2: Voice Track (draggable, elastic)
// Track 3: Incoming Song (intro/post zone highlighted green)
//
// The "Golden Sync" line: a vertical marker at the exact point
// where the incoming song's POST (intro vocals) begins.
// If the voice track overlaps that point → line turns red.
// If the voice track ends before that point → line stays green.
//
// Usage:
//   import SmartSegueEditor from "./components/SmartSegueEditor";
//   <SmartSegueEditor
//     outgoing={{ title, artist, durationMs, outroMs }}
//     incoming={{ title, artist, durationMs, introMs }}
//     voiceTrackMs={0}
//     onVoiceTrackChange={(ms) => ...}
//   />

import { useCallback, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────

interface Track {
  title: string;
  artist: string;
  durationMs: number;
  introMs?: number;   // incoming: where vocals start (the POST)
  outroMs?: number;   // outgoing: where outro begins
}

interface Props {
  outgoing: Track;
  incoming: Track;
  voiceTrackMs: number;           // duration of the voice track
  voiceOffsetMs?: number;         // where in the timeline voice starts (default: at outgoing outro)
  onVoiceOffsetChange?: (ms: number) => void;
  onGoldenSyncStatus?: (status: "green" | "red", overlapMs: number) => void;
}

// ── Constants ─────────────────────────────────────────────────

const TRACK_HEIGHT = 40;
const VOICE_HEIGHT = 32;
const TIMELINE_PAD = 16;
const MIN_VISIBLE_MS = 20000; // show at least 20 seconds

// ── Helpers ───────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// ── SmartSegueEditor ──────────────────────────────────────────

export default function SmartSegueEditor({
  outgoing,
  incoming,
  voiceTrackMs,
  voiceOffsetMs,
  onVoiceOffsetChange,
  onGoldenSyncStatus,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);

  // Voice track starts at the outgoing song's outro by default
  const defaultOffset = Math.max(0, outgoing.durationMs - (outgoing.outroMs ?? 15000));
  const [voiceOffset, setVoiceOffset] = useState(voiceOffsetMs ?? defaultOffset);

  // Timeline window: from (outgoing.duration - outroMs - 5s) to (incoming.introMs + 5s)
  const windowStartMs = Math.max(0, outgoing.durationMs - (outgoing.outroMs ?? 15000) - 5000);
  const windowEndMs   = windowStartMs + Math.max(
    MIN_VISIBLE_MS,
    voiceTrackMs + (incoming.introMs ?? 8000) + 10000,
  );
  const windowMs = windowEndMs - windowStartMs;

  const pct = useCallback((ms: number) => {
    return ((ms - windowStartMs) / windowMs) * 100;
  }, [windowStartMs, windowMs]);

  // The Golden Sync point: where the incoming intro ends (vocals begin)
  // In timeline coordinates: outgoing.duration + incoming.introMs
  const goldenSyncMs = outgoing.durationMs + (incoming.introMs ?? 8000);
  const voiceEndMs   = voiceOffset + voiceTrackMs;

  // Overlap = how far voice track runs past the Golden Sync line
  const overlapMs = voiceEndMs - goldenSyncMs;
  const isGreen   = overlapMs <= 0;

  // Notify parent
  if (onGoldenSyncStatus) {
    onGoldenSyncStatus(isGreen ? "green" : "red", Math.max(0, overlapMs));
  }

  // ── Drag logic ─────────────────────────────────────────────

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { startX: e.clientX, startOffset: voiceOffset };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pxPerMs = rect.width / windowMs;
      const deltaPx = ev.clientX - dragRef.current.startX;
      const deltaMs = deltaPx / pxPerMs;
      const newOffset = Math.max(0, dragRef.current.startOffset + deltaMs);
      setVoiceOffset(newOffset);
      onVoiceOffsetChange?.(newOffset);
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Render ─────────────────────────────────────────────────

  const goldenPct    = pct(goldenSyncMs);
  const outgoingPct  = pct(outgoing.durationMs);
  const outroPct     = pct(outgoing.durationMs - (outgoing.outroMs ?? 15000));
  const voiceStartPct = pct(voiceOffset);
  const voiceEndPct  = pct(voiceEndMs);
  const incomingStartPct = pct(outgoing.durationMs);
  const introEndPct  = pct(goldenSyncMs);

  const goldenColor = isGreen ? "#34d399" : "#ef4444";
  const voiceColor  = isGreen ? "rgba(139,92,246,0.7)" : "rgba(239,68,68,0.6)";

  return (
    <div style={{
      background: "rgba(8,8,14,0.95)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 0,
      padding: "12px 16px 16px",
      fontFamily: "'Inter', system-ui, sans-serif",
      userSelect: "none",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "rgba(255,255,255,0.4)", textTransform: "uppercase" }}>
            Smart Segue
          </span>
          {/* Golden Sync badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "2px 7px", borderRadius: 0,
            background: isGreen ? "rgba(52,211,153,0.1)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${isGreen ? "rgba(52,211,153,0.3)" : "rgba(239,68,68,0.4)"}`,
            transition: "all 0.2s",
          }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: goldenColor, transition: "background 0.2s" }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: goldenColor, letterSpacing: "0.06em", transition: "color 0.2s" }}>
              {isGreen ? "GOLDEN SYNC" : `COLLISION +${(overlapMs / 1000).toFixed(1)}s`}
            </span>
          </div>
        </div>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>
          Drag voice track to adjust
        </span>
      </div>

      {/* Timeline canvas */}
      <div ref={containerRef} style={{ position: "relative", height: TRACK_HEIGHT * 2 + VOICE_HEIGHT + 24, marginBottom: 8 }}>

        {/* ── Track 1: Outgoing Song ── */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: TRACK_HEIGHT }}>
          <TrackLabel label="OUT" color="rgba(251,191,36,0.7)" />
          {/* Full bar */}
          <div style={{
            position: "absolute", left: 0, right: 0,
            top: 14, height: 14, borderRadius: 0,
            background: "rgba(255,255,255,0.06)",
            overflow: "hidden",
          }}>
            {/* Body */}
            <div style={{ position: "absolute", left: 0, width: `${Math.min(100, outgoingPct)}%`, height: "100%", background: "rgba(255,255,255,0.12)" }} />
            {/* Outro zone (amber) */}
            <div style={{
              position: "absolute",
              left: `${Math.max(0, outroPct)}%`,
              width: `${Math.min(100, outgoingPct) - Math.max(0, outroPct)}%`,
              height: "100%",
              background: "rgba(251,191,36,0.45)",
            }} title={`Outro: ${fmtMs(outgoing.outroMs ?? 15000)}`} />
          </div>
          {/* Title */}
          <div style={{ position: "absolute", left: 4, top: 0, fontSize: 9, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap", overflow: "hidden", maxWidth: "60%" }}>
            {outgoing.title} — {outgoing.artist}
          </div>
          <div style={{ position: "absolute", right: 4, top: 0, fontSize: 9, color: "rgba(251,191,36,0.6)" }}>
            outro {fmtMs(outgoing.outroMs ?? 15000)}
          </div>
        </div>

        {/* ── Track 2: Voice Track (draggable) ── */}
        <div style={{ position: "absolute", top: TRACK_HEIGHT + 4, left: 0, right: 0, height: VOICE_HEIGHT }}>
          <TrackLabel label="VT" color="rgba(139,92,246,0.8)" />
          {/* Voice track block */}
          {voiceTrackMs > 0 && (
            <div
              onMouseDown={startDrag}
              style={{
                position: "absolute",
                left: `${Math.max(0, Math.min(99, voiceStartPct))}%`,
                width: `${Math.max(1, voiceEndPct - voiceStartPct)}%`,
                top: 14, height: 16,
                background: voiceColor,
                border: `1px solid ${isGreen ? "rgba(139,92,246,0.9)" : "rgba(239,68,68,0.8)"}`,
                borderRadius: 0,
                cursor: "grab",
                display: "flex", alignItems: "center", justifyContent: "center",
                overflow: "hidden",
                transition: "background 0.2s, border-color 0.2s",
              }}
              title="Drag to reposition voice track"
            >
              <span style={{ fontSize: 8, color: "#fff", fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.06em" }}>
                {fmtMs(voiceTrackMs)}
              </span>
            </div>
          )}
          {voiceTrackMs === 0 && (
            <div style={{ position: "absolute", left: 4, top: 14, fontSize: 9, color: "rgba(255,255,255,0.2)", fontStyle: "italic" }}>
              No voice track loaded
            </div>
          )}
        </div>

        {/* ── Track 3: Incoming Song ── */}
        <div style={{ position: "absolute", top: TRACK_HEIGHT + VOICE_HEIGHT + 8, left: 0, right: 0, height: TRACK_HEIGHT }}>
          <TrackLabel label="IN" color="rgba(52,211,153,0.7)" />
          <div style={{
            position: "absolute", left: 0, right: 0,
            top: 14, height: 14, borderRadius: 0,
            background: "rgba(255,255,255,0.06)",
            overflow: "hidden",
          }}>
            {/* Intro zone (green) — from incomingStart to goldenSync */}
            <div style={{
              position: "absolute",
              left: `${Math.max(0, incomingStartPct)}%`,
              width: `${Math.max(0, introEndPct - incomingStartPct)}%`,
              height: "100%",
              background: "rgba(52,211,153,0.45)",
            }} title={`Intro: ${fmtMs(incoming.introMs ?? 8000)}`} />
            {/* Body after intro */}
            <div style={{
              position: "absolute",
              left: `${Math.max(0, introEndPct)}%`,
              right: 0,
              height: "100%",
              background: "rgba(255,255,255,0.12)",
            }} />
          </div>
          <div style={{ position: "absolute", left: 4, top: 0, fontSize: 9, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap", overflow: "hidden", maxWidth: "60%" }}>
            {incoming.title} — {incoming.artist}
          </div>
          <div style={{ position: "absolute", right: 4, top: 0, fontSize: 9, color: "rgba(52,211,153,0.6)" }}>
            intro {fmtMs(incoming.introMs ?? 8000)}
          </div>
        </div>

        {/* ── Golden Sync line ── */}
        <div style={{
          position: "absolute",
          left: `${Math.max(0, Math.min(99.5, goldenPct))}%`,
          top: 0, bottom: 0,
          width: 2,
          background: `linear-gradient(to bottom, transparent, ${goldenColor}, ${goldenColor}, transparent)`,
          transition: "background 0.2s",
          pointerEvents: "none",
          zIndex: 10,
        }}>
          {/* Label */}
          <div style={{
            position: "absolute", top: "50%", left: 4,
            transform: "translateY(-50%)",
            fontSize: 7, fontWeight: 800, color: goldenColor,
            letterSpacing: "0.1em", whiteSpace: "nowrap",
            background: "rgba(8,8,14,0.8)", padding: "1px 4px", borderRadius: 0,
            transition: "color 0.2s",
          }}>
            POST
          </div>
        </div>

        {/* Outgoing end marker */}
        <div style={{
          position: "absolute",
          left: `${Math.max(0, Math.min(99.5, outgoingPct))}%`,
          top: 0, height: TRACK_HEIGHT,
          width: 1,
          background: "rgba(255,255,255,0.15)",
          pointerEvents: "none",
        }} />
      </div>

      {/* Info row */}
      <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
        <InfoChip label="VT Start" value={fmtMs(voiceOffset)} color="rgba(139,92,246,0.7)" />
        <InfoChip label="VT End"   value={fmtMs(voiceEndMs)} color={isGreen ? "rgba(52,211,153,0.7)" : "rgba(239,68,68,0.7)"} />
        <InfoChip label="Post"     value={fmtMs(goldenSyncMs)} color="rgba(255,255,255,0.3)" />
        {!isGreen && (
          <InfoChip label="Overlap" value={`+${fmtMs(overlapMs)}`} color="#ef4444" />
        )}
      </div>
    </div>
  );
}

function TrackLabel({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      position: "absolute", left: 0, top: 0,
      fontSize: 7, fontWeight: 800, letterSpacing: "0.14em",
      color, opacity: 0.9,
    }}>
      {label}
    </div>
  );
}

function InfoChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 7, color: "rgba(255,255,255,0.25)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 10, color, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{value}</span>
    </div>
  );
}
