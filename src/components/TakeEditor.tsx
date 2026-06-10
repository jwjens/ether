import { useRef, useEffect, useState, useMemo } from "react";
import WaveformEditor from "./WaveformEditor";
import { extractPeaksRange, spliceOut, sliceRegion, insertAt, makeSilence, applyFadeRegion } from "../audio/wavEdit";

// Self-contained clip editor — the full editing toolkit (mark in/out, splice, cut/copy/paste,
// fade, insert silence, undo/redo, zoom) over an AudioBuffer. Used by PhoneDesk (the call editor)
// and shareable with VoiceTracker. Keyboard is scoped to a focusable container so it never
// fights the global Space/deck shortcuts while the dock is open over the decks.

function fmtMs(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

type SendAction = { label: string; title?: string; onSend: (buf: AudioBuffer) => void };

export default function TakeEditor({ initialBuffer, onDiscard, sendActions }: {
  initialBuffer: AudioBuffer;
  onDiscard: () => void;
  sendActions: SendAction[];
}) {
  const [editBuffer, setEditBuffer] = useState<AudioBuffer>(initialBuffer);
  const [editPeaks, setEditPeaks]   = useState<Float32Array>(() => extractPeaksRange(initialBuffer, 0, initialBuffer.duration, 2000));
  const [editDur, setEditDur]       = useState(initialBuffer.duration);
  const [editPlayhead, setEditPlayhead] = useState(0);
  const [selection, setSelection]   = useState<{ start: number; end: number } | null>(null);
  const [zoomLevel, setZoomLevel]   = useState(1);
  const [viewStart, setViewStart]   = useState(0);
  const undoRef      = useRef<{ buffer: AudioBuffer; peaks: Float32Array; dur: number }[]>([]);
  const redoRef      = useRef<{ buffer: AudioBuffer; peaks: Float32Array; dur: number }[]>([]);
  const clipboardRef = useRef<AudioBuffer | null>(null);
  const ctxRef       = useRef<AudioContext | null>(null);
  const srcRef       = useRef<AudioBufferSourceNode | null>(null);
  const rafRef       = useRef(0);
  const startRef     = useRef(0);
  const playheadRef  = useRef(0);
  const markRef      = useRef<number | null>(null);
  const rootRef      = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { playheadRef.current = editPlayhead; }, [editPlayhead]);

  // New recording handed in → reset everything.
  useEffect(() => {
    setEditBuffer(initialBuffer);
    setEditPeaks(extractPeaksRange(initialBuffer, 0, initialBuffer.duration, 2000));
    setEditDur(initialBuffer.duration);
    setEditPlayhead(0); setSelection(null); setZoomLevel(1); setViewStart(0);
    undoRef.current = []; redoRef.current = [];
    rootRef.current?.focus();
  }, [initialBuffer]);

  const stopPlayback = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    try { srcRef.current?.stop(); } catch { /* ignore */ }
    srcRef.current = null; setPlaying(false);
  };
  const playEdit = () => {
    stopPlayback();
    const ctx = ctxRef.current || new AudioContext(); ctxRef.current = ctx;
    const src = ctx.createBufferSource(); src.buffer = editBuffer; src.connect(ctx.destination);
    const end = editBuffer.duration;
    const from = (editPlayhead >= end - 0.05 || editPlayhead < 0) ? 0 : editPlayhead;
    src.start(0, from); srcRef.current = src; startRef.current = ctx.currentTime - from; setPlaying(true);
    const tick = () => {
      const pos = ctx.currentTime - startRef.current;
      if (pos >= end || !srcRef.current) { stopPlayback(); setEditPlayhead(0); return; }
      setEditPlayhead(pos); ensureVisible(pos);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };
  useEffect(() => stopPlayback, []);

  // ── Zoom view window ──
  const viewLen = (zoomLevel <= 1 || editDur === 0) ? editDur : editDur / zoomLevel;
  const effViewStart = zoomLevel <= 1 ? 0 : Math.max(0, Math.min(viewStart, Math.max(0, editDur - viewLen)));
  const effViewEnd = Math.min(editDur, effViewStart + (viewLen || editDur));
  const viewPeaks = useMemo(
    () => extractPeaksRange(editBuffer, effViewStart, Math.min(editBuffer.duration, effViewEnd) || editBuffer.duration, 2000),
    [editBuffer, effViewStart, effViewEnd, editPeaks],
  );
  const clampView = (s: number, vl: number) => Math.max(0, Math.min(Math.max(0, editDur - vl), s));
  const ensureVisible = (ph: number) => {
    if (zoomLevel <= 1) return;
    const vl = editDur / zoomLevel;
    setViewStart(vs => ph < vs ? clampView(ph - vl * 0.15, vl) : ph > vs + vl ? clampView(ph - vl * 0.85, vl) : vs);
  };
  const cycleZoom = () => {
    const next = zoomLevel === 1 ? 4 : zoomLevel === 4 ? 10 : 1;
    setZoomLevel(next);
    setViewStart(next > 1 ? clampView(playheadRef.current - (editDur / next) / 2, editDur / next) : 0);
  };
  const panViewTo = (clientX: number, rect: DOMRect) => {
    if (zoomLevel <= 1) return;
    const vl = editDur / zoomLevel;
    setViewStart(clampView(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * editDur - vl / 2, vl));
  };

  // ── Edit ops (history-managed) ──
  const applyBuffer = (nb: AudioBuffer, clampPlayhead = true) => {
    undoRef.current.push({ buffer: editBuffer, peaks: editPeaks, dur: editDur });
    redoRef.current = [];
    setEditBuffer(nb); setEditPeaks(extractPeaksRange(nb, 0, nb.duration, 2000)); setEditDur(nb.duration);
    if (clampPlayhead) setEditPlayhead(p => Math.min(p, nb.duration));
  };
  const hasSel = () => !!(selection && selection.end - selection.start >= 0.005);
  const deleteSelection = () => { if (!hasSel()) return; stopPlayback(); applyBuffer(spliceOut(editBuffer, selection!.start, selection!.end)); setSelection(null); };
  const cutSelection    = () => { if (!hasSel()) return; stopPlayback(); clipboardRef.current = sliceRegion(editBuffer, selection!.start, selection!.end); applyBuffer(spliceOut(editBuffer, selection!.start, selection!.end)); setSelection(null); };
  const copySelection   = () => { if (!hasSel()) return; clipboardRef.current = sliceRegion(editBuffer, selection!.start, selection!.end); };
  const pasteClip       = () => { if (!clipboardRef.current) return; stopPlayback(); applyBuffer(insertAt(editBuffer, playheadRef.current, clipboardRef.current)); };
  const insertSilence   = (sec = 0.5) => { stopPlayback(); applyBuffer(insertAt(editBuffer, playheadRef.current, makeSilence(editBuffer.sampleRate, editBuffer.numberOfChannels, sec))); };
  const fadeSelection   = (type: "in" | "out") => { if (!hasSel()) return; stopPlayback(); applyBuffer(applyFadeRegion(editBuffer, selection!.start, selection!.end, type), false); };
  const selectAll       = () => { if (editDur > 0) setSelection({ start: 0, end: editDur }); };
  const undoEdit = () => {
    const prev = undoRef.current.pop(); if (!prev) return; stopPlayback();
    redoRef.current.push({ buffer: editBuffer, peaks: editPeaks, dur: editDur });
    setEditBuffer(prev.buffer); setEditPeaks(prev.peaks); setEditDur(prev.dur); setSelection(null);
  };
  const redoEdit = () => {
    const nxt = redoRef.current.pop(); if (!nxt) return; stopPlayback();
    undoRef.current.push({ buffer: editBuffer, peaks: editPeaks, dur: editDur });
    setEditBuffer(nxt.buffer); setEditPeaks(nxt.peaks); setEditDur(nxt.dur); setSelection(null);
  };

  // ── Keyboard — scoped to the editor (onKeyDown on a focusable root) ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key, code = e.code;
    if (code === "Space") { e.preventDefault(); e.stopPropagation(); playing ? stopPlayback() : playEdit(); return; }
    if (code === "ArrowLeft" || code === "ArrowRight") {
      e.preventDefault();
      stopPlayback();
      const delta = (code === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
      const newPh = Math.max(0, Math.min(editDur, playheadRef.current + delta));
      setEditPlayhead(newPh); ensureVisible(newPh); return;
    }
    if (code === "KeyQ") { e.preventDefault(); cycleZoom(); return; }
    if (code === "BracketLeft")  { e.preventDefault(); const ph = playheadRef.current; setSelection(sel => ({ start: ph, end: Math.max(ph, sel?.end ?? ph) })); return; }
    if (code === "BracketRight") { e.preventDefault(); const ph = playheadRef.current; setSelection(sel => ({ start: Math.min(ph, sel?.start ?? ph), end: ph })); return; }
    if (code === "KeyK") { e.preventDefault(); setSelection(null); markRef.current = null; return; }
    if (code === "KeyM") {
      e.preventDefault(); const ph = playheadRef.current;
      if (markRef.current === null) { markRef.current = ph; setSelection(null); }
      else { const a = markRef.current; setSelection({ start: Math.min(a, ph), end: Math.max(a, ph) }); markRef.current = null; }
      return;
    }
    if (k === "Backspace" || k === "Delete") { e.preventDefault(); deleteSelection(); return; }
    if (e.ctrlKey || e.metaKey) {
      const kk = k.toLowerCase();
      if (kk === "z" && e.shiftKey) { e.preventDefault(); redoEdit(); }
      else if (kk === "z") { e.preventDefault(); undoEdit(); }
      else if (kk === "y") { e.preventDefault(); redoEdit(); }
      else if (kk === "a") { e.preventDefault(); selectAll(); }
      else if (kk === "c") { e.preventDefault(); copySelection(); }
      else if (kk === "x") { e.preventDefault(); cutSelection(); }
      else if (kk === "v") { e.preventDefault(); pasteClip(); }
    }
  };

  const navBtn: React.CSSProperties = { height: 34, padding: "0 11px", borderRadius: 0, cursor: "pointer", fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 };

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} onMouseDown={() => rootRef.current?.focus()}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", outline: "none", background: "var(--bg-primary)" }}>
      {/* Waveform */}
      <div style={{ flex: 1, minHeight: 80, position: "relative" }}>
        <WaveformEditor
          peaks={viewPeaks} duration={editDur} viewStart={effViewStart} viewEnd={effViewEnd}
          playhead={editPlayhead} selection={selection}
          onSelectionChange={setSelection}
          onSeek={(s) => { stopPlayback(); setEditPlayhead(s); ensureVisible(s); }}
        />
        {zoomLevel > 1 && (
          <div style={{ position: "absolute", top: 6, right: 8, fontSize: 9, fontWeight: 800, color: "var(--accent-cyan)", background: "rgba(0,0,0,0.55)", padding: "2px 7px", pointerEvents: "none" }}>×{zoomLevel}</div>
        )}
      </div>
      {zoomLevel > 1 && editDur > 0 && (
        <div onMouseDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect(); panViewTo(e.clientX, rect);
          const move = (ev: MouseEvent) => panViewTo(ev.clientX, rect);
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
          window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
        }} style={{ height: 10, flexShrink: 0, background: "var(--bg-tertiary)", position: "relative", cursor: "grab", borderTop: "1px solid var(--border-primary)" }}>
          <div style={{ position: "absolute", top: 1, bottom: 1, left: (effViewStart / editDur * 100) + "%", width: (Math.max(0.02, (effViewEnd - effViewStart) / editDur) * 100) + "%", background: "var(--accent-cyan)", opacity: 0.45 }} />
        </div>
      )}

      {/* Transport */}
      <div style={{ height: 50, padding: "0 12px", display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <button onClick={() => playing ? stopPlayback() : playEdit()} title="Play / stop (Space)" style={{ ...navBtn, width: 40, background: playing ? "var(--accent-green)" : "var(--bg-tertiary)", color: playing ? "#0a160d" : "var(--text-secondary)", border: `1px solid ${playing ? "var(--accent-green)" : "var(--border-secondary)"}` }}>
          {playing ? <svg width="9" height="9" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8" /></svg> : <svg width="9" height="11" viewBox="0 0 6 8" fill="currentColor"><polygon points="0,0 6,4 0,8" /></svg>}
        </button>
        <button onClick={undoEdit} disabled={!undoRef.current.length} title="Undo (Ctrl+Z)" style={{ ...navBtn, width: 36, opacity: undoRef.current.length ? 1 : 0.4 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" /></svg>
        </button>
        <button onClick={redoEdit} disabled={!redoRef.current.length} title="Redo (Ctrl+Y)" style={{ ...navBtn, width: 36, opacity: redoRef.current.length ? 1 : 0.4 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" /></svg>
        </button>
        <button onClick={() => fadeSelection("in")} disabled={!hasSel()} title="Fade in across selection" style={{ ...navBtn, width: 32, opacity: hasSel() ? 1 : 0.4 }}><svg width="14" height="11" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 16 L22 3" /><path d="M2 16 L22 16" /></svg></button>
        <button onClick={() => fadeSelection("out")} disabled={!hasSel()} title="Fade out across selection" style={{ ...navBtn, width: 32, opacity: hasSel() ? 1 : 0.4 }}><svg width="14" height="11" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 3 L22 16" /><path d="M2 16 L22 16" /></svg></button>
        <button onClick={() => insertSilence(0.5)} title="Insert 0.5s silence at playhead" style={{ ...navBtn, padding: "0 8px", fontWeight: 800, fontSize: 9, letterSpacing: "0.04em" }}>SIL</button>

        <div style={{ flex: 1, minWidth: 0, fontSize: 9, color: "var(--text-tertiary)" }}>
          {selection
            ? <span style={{ color: "var(--accent-cyan)", fontWeight: 700 }}>Sel {fmtMs(Math.round(selection.start * 1000))}–{fmtMs(Math.round(selection.end * 1000))} · Del to cut</span>
            : <>Drag or <b>[ ]</b> mark · ←→ scrub · Del cut · K deselect · Q zoom</>}
          <div>{fmtMs(Math.round(editDur * 1000))} total</div>
        </div>

        {sendActions.map(a => (
          <button key={a.label} onClick={() => a.onSend(editBuffer)} title={a.title || `Send to ${a.label}`}
            style={{ ...navBtn, color: "#0a160d", background: "var(--accent-green)", border: "none", fontWeight: 800, padding: "0 13px" }}>{a.label}</button>
        ))}
        <button onClick={() => { stopPlayback(); onDiscard(); }} title="Discard" style={{ ...navBtn, width: 32, color: "var(--text-tertiary)" }}>✕</button>
      </div>
    </div>
  );
}
