// ConsoleStrip.tsx — Wheatstone-style broadcast console channel strip.
//
// Fader: tall narrow rail (min 180px), wide flat horizontal cap (landscape).
// Scale: +6 (reference), 0, −10, −20, −40, −60, ∞ dB on the right of the rail.
// 0 dB has a wider tick + a bright notch on the rail surface for tactile reference.
// VU meter: full height, right side, same color coding as before.

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useMidiState } from "./MidiEngine";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { playClick } from "../lib/uiSound";
import PeakAvgMeter, { type MeterSource } from "./meter/PeakAvgMeter";
import { CH_INDEX, useMeterSubscription, latestMeters } from "./meter/meterStore";
import { useActiveStation } from "../hooks/useActiveStation";
import { useSongMenu } from "../lib/songActions";
import { openChannelRack, useChannelRackLamps } from "../hooks/useChannelRack";
import { isChannelSlot } from "./rack/channelRack";

interface Props {
  label: string;
  color: string;
  volume: number;
  level?: number;
  isPlaying: boolean;
  isOn: boolean;
  onVolumeChange: (v: number) => void;
  onToggleOn: () => void;
  /** PFL pressed. `on` = the state the operator is asking for (the opposite of what the lamp shows now). */
  onPfl?: (on: boolean) => void;
  compact?: boolean;
  /** When provided the strip subscribes to audio:levels IPC directly
   *  and updates the VU bar without triggering React state. */
  deckId?: string;
  /** Hide the channel label row — used when an external bar (ThreeSlotBar) shows it instead. */
  hideLabel?: boolean;
  /** This strip is a SOURCE channel, so its meter reads its OWN slot and is never gated on the
   *  channel switch. Routed by KIND rather than by slot letter — see the meter below. */
  sourceChannel?: boolean;
  /** Rotation role for the color strip: playing rides a progress fill, next pulses, third is solid. */
  role?: "playing" | "next" | "third";
  /** JINGLES overlay v1: 'ARMED' (white) or 'FIRING' (yellow) when a jingle bridges this deck's seam. */
  jingle?: string | null;
  /** Overlay class ('SWP') so the indicator names what's armed/firing (v2). */
  jingleClass?: string | null;
  /** The source is known NOT to be delivering (a mic that is unpatched, disconnected, lost or digitally silent):
   *  the meter draws NOT FED instead of a flat zero. docs/dsp-mic-in-engine.md §4. */
  meterNotFed?: boolean;
}

// Fader cap: wide flat horizontal bar, like a real broadcast console cap
const KNOB_H = 80;  // height of the cap
const KNOB_W = 46;  // width of the cap

// Fader uses a dB-linear taper: position maps linearly to dB (0 dB at top, −60 dB at bottom).
// This matches real broadcast console scaling and keeps scale labels evenly distributed.
const DB_FLOOR = 60; // fader bottom = −60 dB; below this snaps volume to 0

const DB_MARKS: { label: string; db: number; isUnity?: boolean }[] = [
  { label: "0",   db: 0,         isUnity: true },
  { label: "−10", db: -10 },
  { label: "−20", db: -20 },
  { label: "−40", db: -40 },
  { label: "−60", db: -60 },
  { label: "∞",   db: -Infinity },
];

export default function ConsoleStrip({
  label, color, volume, level = 0, isPlaying, isOn, onVolumeChange, onToggleOn, onPfl, compact, deckId, hideLabel, sourceChannel = false, role = "third", jingle = null, jingleClass = null,
  meterNotFed = false,
}: Props) {
  const engine = useAudioEngine();
  const midi = useMidiState();
  // A DECK'S SONG IS AN OBJECT YOU CAN ACT ON. It was the most prominent track on screen and the
  // least actionable — no menu, no gesture, nothing. Same shared set as the queue and the library.
  const songMenu = useSongMenu();
  const openSongMenu = (e: React.MouseEvent) => {
    if (!deckId) return;
    const st: any = engine.getDeck(deckId)?.getState?.();
    if (!st?.filePath) return;          // nothing loaded — no menu, rather than an empty one
    songMenu.open(e, { title: st.title, artist: st.artist, filePath: st.filePath });
  };
  // Station scope — this strip's meter reads only its own station's meter frames.
  const { stationUuid, stationId, isReady } = useActiveStation();
  // Ask the engine for this station's meter windows while an engine-metered strip is on screen (the daemon
  // only emits meters for subscribed stations; every strip renewing is cheap and needs no parent wiring).
  useMeterSubscription([deckId && isReady ? stationId : null]);
  const [dragging, setDragging] = useState(false);
  // Local drag value: the knob follows the pointer instantly off this, instead of waiting
  // for the audio-engine state to round-trip back into `volume` (which ticks, so the knob
  // would skip between positions). Null when not dragging → fall back to the real volume.
  const [dragVol, setDragVol] = useState<number | null>(null);
  // PFL LAMP — for an engine channel it shows the ENGINE's echo (the meters frame's `pfl` bit for this slot),
  // never a local guess: a lamp that lit without the engine doing it is the defect this board keeps paying for.
  // A strip with no engine slot (a guest line) keeps a local lamp: its owner decides what PFL means.
  const [pflLocal, setPflLocal] = useState(false);
  const [pflEcho, setPflEcho] = useState(false);
  // trackRef: the invisible full-area mouse capture overlay
  const trackRef = useRef<HTMLDivElement>(null);
  // faderAreaRef: the flex container we measure for faderH
  const faderAreaRef = useRef<HTMLDivElement>(null);
  const fillRef      = useRef<HTMLDivElement>(null);
  const fillTrackRef = useRef<string>("");
  const [faderH, setFaderH] = useState(220);

  // Measure actual rendered height so knob position math stays accurate
  useEffect(() => {
    const el = faderAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setFaderH(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Progress fill — imperative DOM, no React state, same pattern as VU
  useEffect(() => {
    if (fillRef.current) fillRef.current.style.width = "0%";
  }, []);

  useEffect(() => {
    if (!deckId) return;
    const unsub = engine.on(() => {
      const da = engine.getDeck(deckId.toUpperCase() as "A" | "B" | "C")?.getState?.();
      if (!da) return;
      const trackKey = `~${Math.round(da.durationSec ?? 0)}`;
      const fill = fillRef.current;
      if (!fill) return;
      if (da.status === "playing" && da.durationSec > 0 && trackKey !== fillTrackRef.current) {
        fillTrackRef.current = trackKey;
        const startPct  = da.durationSec > 0 ? (da.positionSec / da.durationSec) * 100 : 0;
        const remaining = Math.max(0, (da.durationSec ?? 0) - (da.positionSec ?? 0));
        fill.style.transition = "none";
        fill.style.width = `${startPct}%`;
        void fill.offsetWidth;
        fill.style.transition = `width ${remaining}s linear`;
        fill.style.width = "100%";
      }
      if (da.status !== "playing") {
        fill.style.transition = "none";
        const pct = da.durationSec > 0 ? (da.positionSec / da.durationSec) * 100 : 0;
        fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        fillTrackRef.current = "";
      }
    });
    return () => unsub();
  }, [deckId, engine]);

  // ── THE STRIP METER — the PRE-FADER tap (Slice 2, docs/dsp-meter-bus.md; Jeff's rulings 1 and 3) ──
  //
  // It used to be the POST-fader peak off audio:levels, with a letter-by-letter routing chain and three
  // different isPlaying gates (see git history for the 2026-08-18 and 2026-08-25 incidents it carried).
  // All of that is gone: every engine slot now has its OWN pre-fader tap, read by index, so
  //   • a channel that is OFF still shows its source (pre-cut — ruling 1), and the fader never moves it;
  //   • no slot can ever fall through to the programme mix, because there is no fallthrough;
  //   • a strip with no engine slot (a patched mic) meters the level its owner hands in, also pre-fader.
  // The post-fader values stay on the wire (audio:levels) for the consumers that read them; a strip shows
  // one meter, not two (ruling 3).
  //
  // An id with no engine slot (the old "MIC" id faked `master × 0.6`) is drawn NOT FED — never a fake level.
  const slotIndex = deckId ? CH_INDEX[deckId.toUpperCase()] : undefined;
  useEffect(() => {
    if (slotIndex === undefined) return;
    const id = setInterval(() => {
      const m = latestMeters(stationUuid);
      const on = !!m && typeof m.pfl === "number" && ((m.pfl >> slotIndex) & 1) === 1;
      setPflEcho(prev => (prev === on ? prev : on));
    }, 100);
    return () => clearInterval(id);
  }, [slotIndex, stationUuid]);
  const pflActive = slotIndex !== undefined ? pflEcho : pflLocal;
  const meterSource: MeterSource = meterNotFed ? { stationUuid: null, ch: -1 }
    : deckId
    ? (slotIndex !== undefined ? { stationUuid, ch: slotIndex } : { stationUuid: null, ch: -1 })
    : { external: level };
  const meterTitle = deckId
    ? (slotIndex !== undefined ? `${label} — pre-fader level (moves with the source, not the fader or ON)` : `${label} — no engine meter for this channel`)
    : `${label} — input level, pre-fader`;

  // SLICE 5 — THE EQ DOOR (docs/dsp-channel-rack-eq.md §4): every strip with an engine slot opens its own
  // channel rack. Lit = that fader's rack has something IN (read from the stored rack, shared per station).
  const rackSlot = deckId && isChannelSlot(deckId.toUpperCase()) ? deckId.toUpperCase() : null;
  const lamps = useChannelRackLamps(rackSlot && isReady ? stationId : null);
  const eqLit = rackSlot ? (lamps as Record<string, boolean | undefined>)[rackSlot] === true : false;

  // MIDI hardware fader sync
  const midiKey = `deck_${label.toLowerCase().replace(/[^a-z]/g, "")}_volume`;
  const midiVolume = midi.faderPositions[midiKey];
  useEffect(() => {
    if (midiVolume !== undefined && Math.abs(midiVolume - volume) > 0.02) {
      onVolumeChange(midiVolume);
    }
  }, [midiVolume]);

  // Top offset of the knob cap — dB-linear taper so scale marks are evenly spaced.
  // 0 dB → knobY=0 (top); −60 dB → knobY=faderH−KNOB_H (bottom).
  const effVol = dragVol ?? volume; // pointer-driven while dragging, real volume otherwise
  const volDb = effVol > 0.001 ? 20 * Math.log10(effVol) : -DB_FLOOR;
  const knobY = (Math.max(-DB_FLOOR, Math.min(0, volDb)) / -DB_FLOOR) * (faderH - KNOB_H);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    const track = trackRef.current;
    if (!track) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const posToVol = (clientY: number, rect: DOMRect) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      if (ratio >= 0.999) return 0;
      const db = -ratio * DB_FLOOR;
      return Math.pow(10, db / 20);
    };
    const onMove = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const v = posToVol(ev.clientY, rect);
      setDragVol(v);          // knob follows the pointer instantly
      onVolumeChange(v);      // engine gets the value too
    };
    const onUp = () => {
      setDragging(false);
      setDragVol(null);       // hand the knob back to the real volume
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    const rect = track.getBoundingClientRect();
    const v0 = posToVol(e.clientY, rect);
    setDragVol(v0);
    onVolumeChange(v0);
  }, [onVolumeChange]);

  const db = effVol > 0.001 ? (20 * Math.log10(effVol)).toFixed(0) : "−∞";

  // JINGLES indicator moved OUT of the fader strip (4.4.63): the jingle's NAME + time now lives as a third
  // line under the playing song's duration in the Up Next deck row (UpNext.tsx). The `jingle`/`jingleClass`
  // props are retained (ignored) so callers don't break; nothing is rendered here.
  void jingle; void jingleClass;

  return (
    <div
      onContextMenu={openSongMenu} style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      backgroundColor: "var(--panel-bg, #0e0e13)",
      borderRight: "var(--panel-border, 1px solid rgba(255,255,255,0.05))",
      userSelect: "none", overflow: "hidden", position: "relative",
    }}>

      {/* ── Channel label ── */}
      {!hideLabel ? (
        <div style={{
          width: "100%", padding: "8px 0",
          background: isOn && isPlaying ? `${color}28` : "var(--strip-label-bg, transparent)",
          borderBottom: "1px solid var(--strip-divider, #303040)",
          textAlign: "center",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
          position: "relative", overflow: "hidden",
          transition: "background 0.3s",
        }}>
          {deckId && (
            <div ref={fillRef} style={{
              position: "absolute", top: 0, left: 0, bottom: 0,
              background: color,
              zIndex: 0, pointerEvents: "none",
            }} />
          )}
          <span style={{
            position: "relative", zIndex: 1,
            color: isOn && isPlaying ? "#fff" : (isOn ? color : "var(--strip-label-text, #555)"),
            textShadow: isOn && isPlaying ? "0 1px 3px rgba(0,0,0,0.6)" : "none",
            transition: "color 0.2s",
          }}>{label}</span>
        </div>
      ) : deckId ? (
        // Label hidden (deck identity now lives in the Up Next deck rows) — but keep a slim
        // color-coded accent so operators still know which fader is A/B/C, with the play
        // progress riding across it.
        <div style={{
          width: "100%", height: 16, position: "relative", overflow: "hidden",
          background: isOn && isPlaying ? `${color}33` : `${color}1a`,
          borderBottom: `2px solid ${color}`,
          transition: "background 0.3s",
        }}>
          {/* Role-driven full-strip fill: next pulses, third is solid. The playing deck gets
              no overlay (role === "playing") so its progress fill below shows through. */}
          {role === "next" && (
            <div className="deck-bar-pulse" style={{
              position: "absolute", inset: 0, background: color, zIndex: 0, pointerEvents: "none",
            }} />
          )}
          {role === "third" && (
            <div style={{
              position: "absolute", inset: 0, background: color, opacity: 0.9, zIndex: 0, pointerEvents: "none",
            }} />
          )}
          {/* Playing deck: progress fill rides left→right (imperative, see effect above) */}
          <div ref={fillRef} style={{
            position: "absolute", top: 0, left: 0, bottom: 0,
            background: color, opacity: 0.85, zIndex: 1, pointerEvents: "none",
          }} />
        </div>
      ) : null}

      {/* ── Main area: fader column + VU meter ── */}
      <div ref={faderAreaRef} style={{
        flex: 1, width: "100%", display: "flex", gap: 14, justifyContent: "center",
        padding: "10px 8px 8px",
        minHeight: 180, overflow: "hidden",
        position: "relative",
      }}>

        {/* ── Fader column: rail + knob cap ── */}
        <div style={{
          width: 54, flexShrink: 0, height: "100%", position: "relative", zIndex: 1,
        }}>

          {/* Mouse / touch capture — covers full column, sits above all visuals */}
          <div
            ref={trackRef}
            onPointerDown={handlePointerDown}
            style={{
              position: "absolute", inset: 0,
              cursor: dragging ? "grabbing" : "ns-resize",
              zIndex: 10,
            }}
          />

          {/* Rail — flat thin track */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: KNOB_H / 2, bottom: KNOB_H / 2,
            width: 4,
            background: "rgba(255,255,255,0.09)",
          }} />

          {/* Active fill — colored segment from bottom to knob */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            bottom: KNOB_H / 2,
            height: Math.max(0, (faderH - KNOB_H) - knobY),
            width: 4,
            background: isOn ? color : "#555",
            opacity: isOn ? 0.7 : 0.06,
            transition: dragging ? "none" : "height 0.08s ease-out",
          }} />

          {/* dB scale removed — clean rail, no per-tick labels (the meter reads the level) */}

          {/* ── Fader knob cap — flat handle (motorized-board friendly) ── */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: knobY,
            width: KNOB_W, height: KNOB_H,
            cursor: "grab",
            zIndex: 5,
            transition: dragging ? "none" : "top 0.08s ease-out",
            background: isOn ? "#e6e6ec" : "#55555f",
            border: dragging ? `2px solid ${color}` : `1px solid ${isOn ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.5)"}`,
            opacity: isOn ? 1 : 0.7,
            borderRadius: 2,
            boxShadow: dragging ? `0 0 0 3px ${color}40` : "none",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {/* Center grip line */}
            <div style={{ width: KNOB_W - 18, height: 2, background: "rgba(0,0,0,0.28)", borderRadius: 1 }} />
          </div>

        </div>{/* end fader column */}

        {/* ── Pre-fader meter — L/R average bars, peak dot, hold, OVER, −18 mark (PeakAvgMeter) ── */}
        <div style={{ width: 32, flexShrink: 0, height: "100%", position: "relative", zIndex: 1, padding: "0 2px" }}>
          <PeakAvgMeter source={meterSource} size="strip" label={label} title={meterTitle} />
        </div>

      </div>{/* end main area */}

      {/* ── EQ — the door to this fader's channel rack (Slice 5) ── */}
      {rackSlot && (
        <div style={{ padding: "8px 8px 0", borderTop: "1px solid var(--strip-divider, #303040)" }}>
          <button onClick={() => { playClick(); openChannelRack(rackSlot as any); }}
            title={`${label}'s channel EQ — Filters and PEQ${eqLit ? " (something is IN)" : " (nothing IN — the audio is untouched)"}. Opens the rack window at ${rackSlot}.`}
            style={{
              width: "100%", height: 32, borderRadius: 3, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              background: eqLit ? "color-mix(in srgb, var(--slot-eq) 22%, transparent)" : "var(--bg-tertiary, #232330)",
              border: `1px solid ${eqLit ? "var(--slot-eq)" : "var(--border-primary, #333)"}`,
            }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: eqLit ? "var(--slot-eq)" : "transparent",
                           border: `1px solid ${eqLit ? "var(--slot-eq)" : "var(--text-tertiary, #666)"}` }} />
            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: eqLit ? "var(--slot-eq)" : "var(--text-tertiary, #666)" }}>EQ</span>
          </button>
        </div>
      )}

      {/* ── ON / PFL — flat ── */}
      <div style={{
        display: "flex", flexDirection: "row", alignItems: "stretch",
        gap: 8, padding: "10px 8px 12px",
        borderTop: "1px solid var(--strip-divider, #303040)",
      }}>

        {/* ON — solid fill when active (brighter while playing), flat */}
        <button onClick={() => { playClick(); onToggleOn(); }} style={{
          flex: 1, height: 38, borderRadius: 3,
          background: isOn ? (isPlaying ? "#2563eb" : "#1e3358") : "var(--bg-tertiary, #232330)",
          border: `1px solid ${isOn ? (isPlaying ? "#3b82f6" : "#2a4a7a") : "var(--border-primary, #333)"}`,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.12s",
        }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", color: isOn ? "#fff" : "var(--text-tertiary, #666)" }}>ON</span>
        </button>

        {/* PFL — solid amber when active, flat */}
        <button onClick={() => { playClick(); if (slotIndex === undefined) setPflLocal(!pflActive); onPfl?.(!pflActive); }}
          title={slotIndex !== undefined ? `PFL — hear ${label} before its fader and ON, after its channel EQ, in this station's local output (the programme there dips). Never on air.` : "PFL"}
          style={{
          flex: 1, height: 38, borderRadius: 3,
          background: pflActive ? "#b8860b" : "var(--bg-tertiary, #232330)",
          border: `1px solid ${pflActive ? "#d4a017" : "var(--border-primary, #333)"}`,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.12s",
        }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", color: pflActive ? "#fff" : "var(--text-tertiary, #666)" }}>PFL</span>
        </button>

      </div>
      {songMenu.node}
    </div>
  );
}
