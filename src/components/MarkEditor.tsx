// src/components/MarkEditor.tsx — set a mark by ear.
//
// ONE MARK, ONE MARKER. This edits `post_ms` on a song (where the vocal begins) or `dry_ms` on a cut
// (how much of it carries no music under the voice). Same gesture, same picture, one component: they
// are the same question asked of two kinds of audio, and two editors would drift.
//
// NOTHING CONSUMES THESE MARKS YET. Slice 3 (chain types) is what reads them. Setting a mark here
// changes no placement, no seam and no sound — it records a decision for a later slice to act on. That
// is deliberate: the marks can be laid down at leisure, by ear, before anything depends on them.
//
// SHARED ENGINE, NEVER COPIED (CLAUDE.md). The waveform comes from ../audio/waveformPeaks and the
// audition from ../audio/regionAudition — the same two the Reel Splitter and the StudioPro DAW use.
// The audition runs on its own AudioContext and NEVER touches the on-air engine or the decks.
//
// AN AUTO VALUE IS A CANDIDATE, NEVER A FACT. The header says which it is. Dragging the marker and
// pressing SET stamps source='operator' and confirmed_at — a human agreed, and the record says so.
import { useCallback, useEffect, useRef, useState } from "react";
import { auditionRegion } from "../audio/regionAudition";
import { computePeaks } from "../audio/waveformPeaks";
import { readFile } from "../lib/ipc";

export type MarkKind = "post" | "dry";

/** How far before the mark the audition starts. You cannot hear whether a post is right by starting
 *  ON it — you need the run-up, which is exactly what the imaging plays over. */
const PREROLL_S = 3;

interface Props {
  filePath: string;
  title: string;
  kind: MarkKind;
  /** Current stored value, in ms — null when nothing is marked. */
  valueMs: number | null;
  source: string | null;          // 'auto' | 'operator' | null
  confirmedAt: string | null;
  /** Where the audio actually starts (silence trim), in ms — the marker opens here, not at zero. */
  introEndMs?: number | null;
  onSave: (ms: number) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  onClose: () => void;
}

const LABEL: React.CSSProperties = { fontSize: "var(--t-micro)", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" };
const COPY: Record<MarkKind, { title: string; what: string; hint: string }> = {
  post: {
    title: "POST — where the vocal begins",
    what: "Drag the marker to the first word. Imaging may talk up to here and no further.",
    hint: "Audition starts 3 seconds early so you hear the run-up, not just the word.",
  },
  dry: {
    title: "DRY — how much of this cut has no music under it",
    what: "Drag the marker to where the bed comes in. Before it, the cut is dry and can sit over a song's tail.",
    hint: "A stinger with no voice at all is fully dry — drag the marker to the end.",
  },
};

export default function MarkEditor(p: Props) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<{ min: Float32Array; max: Float32Array } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [markMs, setMarkMs] = useState<number | null>(p.valueMs);
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const ctx = () => (ctxRef.current ||= new (window.AudioContext || (window as any).webkitAudioContext)());

  // ── load + decode ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null); setBuffer(null); setPeaks(null);
      try {
        const bytes = await readFile(p.filePath);
        const buf = await ctx().decodeAudioData((bytes as any).buffer.slice(0));
        if (!alive) return;
        setBuffer(buf);
        setPeaks(computePeaks(buf, 900));
        // Open ON the stored mark when there is one; otherwise at the audio's real start, because a
        // marker at zero on a file with 400ms of leading silence is a marker in the wrong place.
        setMarkMs(prev => prev ?? (p.introEndMs != null ? p.introEndMs : 0));
      } catch (e: any) {
        if (alive) setErr(String(e?.message || e));
      }
    })();
    return () => {
      alive = false;
      try { srcRef.current?.stop(); } catch {}
      srcRef.current = null;
    };
  }, [p.filePath]);

  // ── draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const cv = canvasRef.current, pk = peaks, buf = buffer;
    if (!cv || !pk || !buf) return;
    const w = cv.width, h = cv.height, mid = h / 2;
    const g = cv.getContext("2d"); if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "var(--bg-tertiary)";
    g.fillStyle = "#12121a"; g.fillRect(0, 0, w, h);
    // waveform
    g.strokeStyle = "#4a4a5e"; g.beginPath();
    for (let x = 0; x < pk.min.length && x < w; x++) {
      g.moveTo(x + 0.5, mid - pk.max[x] * mid);
      g.lineTo(x + 0.5, mid - pk.min[x] * mid);
    }
    g.stroke();
    // everything BEFORE the mark, tinted — for a post that is the talk-up window, for a dry length
    // that is the dry part. The tint is the answer to "how much", which the number alone does not give.
    if (markMs != null) {
      const x = (markMs / 1000 / buf.duration) * w;
      g.fillStyle = "rgba(136,104,216,0.16)"; g.fillRect(0, 0, x, h);
      g.strokeStyle = "#8868D8"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.lineWidth = 1;
    }
  }, [peaks, buffer, markMs]);
  useEffect(() => { draw(); }, [draw]);

  // ── drag ──────────────────────────────────────────────────────────────────
  const setFromX = (clientX: number) => {
    const cv = canvasRef.current, buf = buffer; if (!cv || !buf) return;
    const r = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setMarkMs(Math.round(frac * buf.duration * 1000));
    setDirty(true);
  };
  const onDown = (e: React.MouseEvent) => {
    setFromX(e.clientX);
    const move = (ev: MouseEvent) => setFromX(ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  // ── audition ──────────────────────────────────────────────────────────────
  const audition = () => {
    const buf = buffer; if (!buf || markMs == null) return;
    try { srcRef.current?.stop(); } catch {}
    const from = Math.max(0, markMs / 1000 - PREROLL_S);
    // Run PAST the mark so you hear whether the word lands where the marker says it does.
    const to = Math.min(buf.duration, markMs / 1000 + 2);
    const src = auditionRegion(ctx(), buf, from, to, () => {
      if (srcRef.current === src) { srcRef.current = null; setPlaying(false); }
    });
    srcRef.current = src; setPlaying(true);
  };
  const stop = () => { try { srcRef.current?.stop(); } catch {} srcRef.current = null; setPlaying(false); };

  const copy = COPY[p.kind];
  const secs = (ms: number | null) => ms == null ? "—" : `${(ms / 1000).toFixed(2)}s`;
  const isAuto = p.source === "auto";

  return (
    <div style={{ padding: 16, borderTop: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <span style={{ fontSize: "var(--t-lead)", fontWeight: 700 }}>{p.title}</span>
        <div style={{ flex: 1 }} />
        <button onClick={p.onClose} style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-lead)" }}>✕</button>
      </div>
      <div style={{ ...LABEL, marginBottom: 2 }}>{copy.title}</div>
      <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.5 }}>
        {copy.what} <span style={{ opacity: 0.8 }}>{copy.hint}</span>
      </div>

      {/* WHOSE VALUE IS THIS. An auto mark is a candidate nobody has agreed with, and the panel says so
          rather than letting it look settled. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: "var(--t-small)" }}>
        <span style={LABEL}>Stored</span>
        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{secs(p.valueMs)}</span>
        {p.valueMs == null ? (
          <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>not marked</span>
        ) : isAuto ? (
          <span style={{ color: "#f59e0b", fontWeight: 700 }} title="A detector proposed this. Nobody has agreed with it yet.">CANDIDATE — auto, unconfirmed</span>
        ) : (
          <span style={{ color: "var(--text-secondary)" }}>
            set by ear{p.confirmedAt ? ` · ${new Date(p.confirmedAt).toLocaleDateString()}` : ""}
          </span>
        )}
      </div>

      {err ? (
        <div style={{ fontSize: "var(--t-body)", color: "#ef4444" }}>
          Could not read this file — {err}
        </div>
      ) : !buffer ? (
        <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontStyle: "italic" }}>decoding…</div>
      ) : (
        <>
          <canvas ref={canvasRef} width={900} height={120} onMouseDown={onDown}
            style={{ width: "100%", height: 120, cursor: "ew-resize", display: "block", borderRadius: "var(--r-0)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={playing ? stop : audition}
              style={{ padding: "5px 14px", fontWeight: 800, fontSize: "var(--t-small)", letterSpacing: "0.06em", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", cursor: "pointer" }}>
              {playing ? "STOP" : `▶ FROM ${PREROLL_S}s BEFORE`}
            </button>
            <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: "var(--t-lead)", color: "#8868D8", minWidth: 70 }}>
              {secs(markMs)}
            </span>
            <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>
              of {buffer.duration.toFixed(2)}s
            </span>
            <div style={{ flex: 1 }} />
            {p.kind === "dry" && (
              <button onClick={() => { setMarkMs(Math.round(buffer.duration * 1000)); setDirty(true); }}
                title="No voice in this cut at all — it is dry all the way through."
                style={{ padding: "5px 12px", fontSize: "var(--t-small)", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>
                FULLY DRY
              </button>
            )}
            {p.valueMs != null && (
              <button onClick={() => { stop(); p.onClear(); }}
                title="Remove the mark. Nothing guesses in its place."
                style={{ padding: "5px 12px", fontSize: "var(--t-small)", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer" }}>
                CLEAR
              </button>
            )}
            <button disabled={markMs == null || !dirty}
              onClick={() => { stop(); if (markMs != null) { p.onSave(markMs); setDirty(false); } }}
              style={{ padding: "5px 16px", fontWeight: 800, fontSize: "var(--t-small)", letterSpacing: "0.06em",
                background: dirty ? "rgba(136,104,216,0.2)" : "transparent",
                border: `1px solid ${dirty ? "#8868D8" : "var(--border-primary)"}`,
                color: dirty ? "#8868D8" : "var(--text-tertiary)",
                cursor: markMs == null || !dirty ? "default" : "pointer", opacity: markMs == null || !dirty ? 0.5 : 1 }}>
              SET BY EAR
            </button>
          </div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginTop: 8 }}>
            Nothing plays this mark yet — it is recorded for a later slice. Setting it changes no seam.
          </div>
        </>
      )}
    </div>
  );
}
