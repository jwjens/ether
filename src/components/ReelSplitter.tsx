// ReelSplitter — purpose-built jingle/sweeper reel → library workflow (NOT a DAW extension).
// One screen: OPEN a long imaging reel → AUTO-CUT on silence → REVIEW (keyboard-first audition + edit) →
// COMMIT as tagged, pooled library items. Built entirely on VERIFIED rails (inventory 2026-07-15):
//   • decode: File → decodeAudioData (browser, self-contained)
//   • auto-cut: src/audio/silenceRegions.ts (JS RMS gaps — native detector can't emit regions)
//   • render+write: slice AudioBuffer → encodeWav (wavEdit.ts) → ether.ffmpeg.writeAudio (media:writeAudio, WORKS)
//   • import: shipped normal pipeline — songs.create({file_path,…}) + songs.updateById({content_class,jingle_category_id})
// NOT used: ether.fs.writeFile (dead, no handler); content-hash/songs_v2 (not shipped — file_path identity).
import { useState, useRef, useCallback, useEffect } from "react";
import { detectSilenceRegions, type Region } from "../audio/silenceRegions";
import { auditionRegion } from "../audio/regionAudition";
import { commitRegionToLibrary, imagingSlug as slug } from "../audio/imagingCommit";
import InlineNameEditor from "./InlineNameEditor";
import ClassPoolSelect, { useImagingPools } from "./ClassPoolSelect";
import { JIN_TEAL, SWP_INDIGO } from "../lib/classColors";

type Cls = "JIN" | "SWP";
interface Reg extends Region { name: string }
const ether = () => (window as any).ether;
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;

export default function ReelSplitter({ stationId, embedded, onCommitted }: { stationId: number; embedded?: boolean; onCommitted?: () => void }) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [reelName, setReelName] = useState("");
  const [regions, setRegions] = useState<Reg[]>([]);
  const [sel, setSel] = useState(0);
  const [threshold, setThreshold] = useState(-45);
  const [cls, setCls] = useState<Cls>("JIN");
  const [poolId, setPoolId] = useState<number | null>(null);
  const pools = useImagingPools(stationId);
  const [playing, setPlaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [commitState, setCommitState] = useState<{ busy: boolean; done: number; total: number; err: string | null } | null>(null);
  const [peaks, setPeaks] = useState<{ min: Float32Array; max: Float32Array } | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ctx = () => (ctxRef.current ||= new (window.AudioContext || (window as any).webkitAudioContext)());

  // ── open + decode ──
  const openBuffer = useCallback(async (file: File) => {
    stop();
    try {
      const ab = await file.arrayBuffer();
      const buf = await ctx().decodeAudioData(ab.slice(0));
      setBuffer(buf); setFileName(file.name); setReelName(slug(file.name));
      setPeaks(computePeaks(buf, 2400));
      const regs = detectSilenceRegions(buf, { thresholdDb: threshold }).map((r, i) => ({ ...r, name: "" }));
      setRegions(nameAll(regs, slug(file.name))); setSel(0);
    } catch (e) { alert("Couldn't read that audio file: " + (e as Error).message); }
  }, [threshold]);

  const pickFile = async () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*";
    input.onchange = () => { const f = input.files?.[0]; if (f) openBuffer(f); };
    input.click();
  };

  const reCut = () => {
    if (!buffer) return; stop();
    const regs = detectSilenceRegions(buffer, { thresholdDb: threshold }).map(r => ({ ...r, name: "" }));
    setRegions(nameAll(regs, reelName)); setSel(0);
  };
  const nameAll = (regs: Reg[], reel: string) => regs.map((r, i) => ({ ...r, name: r.name || `${reel} ${String(i + 1).padStart(2, "0")}` }));

  // ── audition ──
  const stop = () => { try { srcRef.current?.stop(); } catch {} srcRef.current = null; setPlaying(false); };
  const playRegion = (i: number) => {
    if (!buffer) return; stop();
    const r = regions[i]; if (!r) return;
    const src = auditionRegion(ctx(), buffer, r.start, r.end, () => { if (srcRef.current === src) { srcRef.current = null; setPlaying(false); } });
    srcRef.current = src; setPlaying(true);
  };
  const togglePlay = () => { if (playing) stop(); else playRegion(sel); };

  // ── region edits ──
  const patchSel = (patch: Partial<Reg>) => setRegions(rs => rs.map((r, i) => i === sel ? { ...r, ...patch } : r));
  const del = (i: number) => setRegions(rs => { const n = rs.filter((_, k) => k !== i); setSel(s => Math.max(0, Math.min(s, n.length - 1))); return n; });
  const mergeNext = (i: number) => setRegions(rs => { if (i >= rs.length - 1) return rs; const n = [...rs]; n[i] = { ...n[i], end: n[i + 1].end }; n.splice(i + 1, 1); return n; });
  const splitSel = (i: number) => setRegions(rs => { const r = rs[i]; if (!r || r.end - r.start < 0.4) return rs; const mid = (r.start + r.end) / 2; const n = [...rs]; n.splice(i, 1, { ...r, end: mid, name: r.name + "a" }, { start: mid, end: r.end, name: r.name + "b" }); return n; });

  // ── keyboard ──
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); setSel(s => Math.min(regions.length - 1, s + 1)); stop(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); setSel(s => Math.max(0, s - 1)); stop(); }
      else if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); del(sel); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [regions.length, sel, playing]);

  // auto-audition on selection change while playing? no — space-driven only. Repaint waveform on change.
  useEffect(() => { drawWave(); }, [peaks, regions, sel]);
  const drawWave = () => {
    const cv = canvasRef.current, pk = peaks; if (!cv || !pk || !buffer) return;
    const w = cv.width = cv.clientWidth * (window.devicePixelRatio || 1);
    const h = cv.height = cv.clientHeight * (window.devicePixelRatio || 1);
    const g = cv.getContext("2d"); if (!g) return;
    g.clearRect(0, 0, w, h); const mid = h / 2;
    g.strokeStyle = "rgba(255,255,255,0.5)"; g.beginPath();
    const cols = pk.min.length;
    for (let x = 0; x < w; x++) { const c = Math.floor((x / w) * cols); const lo = pk.min[c] || 0, hi = pk.max[c] || 0; g.moveTo(x, mid - hi * mid); g.lineTo(x, mid - lo * mid); }
    g.stroke();
  };

  // Draggable edge of the selected region (0 = start handle, 1 = end handle).
  const onEdgeDrag = (which: 0 | 1) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const wave = waveRef.current; if (!wave || !buffer) return;
    const rect = wave.getBoundingClientRect(); const dur = buffer.duration;
    const move = (ev: MouseEvent) => {
      const t = Math.max(0, Math.min(dur, ((ev.clientX - rect.left) / rect.width) * dur));
      setRegions(rs => rs.map((r, i) => {
        if (i !== sel) return r;
        if (which === 0) return { ...r, start: Math.min(t, r.end - 0.05) };
        return { ...r, end: Math.max(t, r.start + 0.05) };
      }));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  // ── commit ── (render+write+import via the ONE shared imaging engine — imagingCommit.ts)
  const commit = async () => {
    if (!buffer || !regions.length) return;
    setCommitState({ busy: true, done: 0, total: regions.length, err: null });
    try {
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        await commitRegionToLibrary(buffer, r.start, r.end, { name: r.name, cls, poolId, reelSlug: reelName });
        setCommitState({ busy: true, done: i + 1, total: regions.length, err: null });
      }
      setCommitState({ busy: false, done: regions.length, total: regions.length, err: null });
      try { onCommitted?.(); } catch {}
    } catch (e) { setCommitState(s => ({ busy: false, done: s?.done || 0, total: regions.length, err: (e as Error).message })); }
  };

  const accent = cls === "SWP" ? SWP_INDIGO : JIN_TEAL;
  const dur = buffer?.duration || 1;

  return (
    <div ref={rootRef} tabIndex={0} style={{ height: "100%", display: "flex", flexDirection: "column", outline: "none", color: "var(--text-primary)", background: "var(--bg-primary)" }}
      onFocus={() => { /* focusable for keyboard */ }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.06em", color: accent, textTransform: "uppercase" }}>Reel Splitter</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{fileName || "Slice a long imaging reel into tagged library items"}</div>
        <div style={{ flex: 1 }} />
        <button onClick={pickFile} style={{ padding: "6px 14px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 13, cursor: "pointer" }}>{buffer ? "Open another…" : "Open reel…"}</button>
      </div>

      {!buffer ? (
        <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) openBuffer(f); }}
          style={{ flex: 1, margin: 24, border: `2px dashed ${dragOver ? accent : "var(--border-primary)"}`, borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-tertiary)", background: dragOver ? "rgba(20,224,200,0.05)" : "transparent" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Drop a reel — or a single cut — here</div>
          <div style={{ fontSize: 12 }}>or <button onClick={pickFile} style={{ background: "none", border: "none", color: accent, cursor: "pointer", textDecoration: "underline", fontSize: 12 }}>pick a file</button> — a long reel of stacked imaging, or one jingle/sweeper to import + tag</div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Waveform + region overlays */}
          <div ref={waveRef} style={{ position: "relative", height: 150, margin: "12px 16px", background: "var(--bg-secondary)", borderRadius: 6, overflow: "hidden" }}>
            <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
            {regions.map((r, i) => {
              const left = (r.start / dur) * 100, width = ((r.end - r.start) / dur) * 100;
              const isSel = i === sel;
              return (
                <div key={i} onClick={() => { setSel(i); stop(); }} title={r.name}
                  style={{ position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${width}%`,
                    background: isSel ? `${accent}33` : "rgba(255,255,255,0.05)", borderLeft: `2px solid ${isSel ? accent : "rgba(255,255,255,0.25)"}`, borderRight: `2px solid ${isSel ? accent : "rgba(255,255,255,0.25)"}`, cursor: "pointer", boxSizing: "border-box" }}>
                  <span style={{ position: "absolute", top: 2, left: 3, fontSize: 9, fontWeight: 800, color: isSel ? accent : "var(--text-tertiary)" }}>{i + 1}</span>
                  {isSel && <>
                    <div onMouseDown={onEdgeDrag(0)} style={{ position: "absolute", top: 0, bottom: 0, left: -4, width: 8, cursor: "ew-resize", background: accent, opacity: 0.6 }} />
                    <div onMouseDown={onEdgeDrag(1)} style={{ position: "absolute", top: 0, bottom: 0, right: -4, width: 8, cursor: "ew-resize", background: accent, opacity: 0.6 }} />
                  </>}
                </div>
              );
            })}
          </div>

          {/* Auto-cut controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 16px 10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{regions.length} region{regions.length === 1 ? "" : "s"}</span>
            <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
              Silence threshold <input type="range" min={-70} max={-25} value={threshold} onChange={e => setThreshold(Number(e.target.value))} onMouseUp={reCut} />
              <span style={{ fontFamily: "'DM Mono', monospace", width: 42 }}>{threshold} dB</span>
            </label>
            <button onClick={reCut} style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 12, cursor: "pointer" }}>Re-cut</button>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Space = audition · ←/→ = move · Del = remove</span>
          </div>

          {/* Region list */}
          <div style={{ flex: 1, overflow: "auto", padding: "0 16px" }}>
            {regions.map((r, i) => (
              <div key={i} onClick={() => setSel(i)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 8px", borderRadius: 4, marginBottom: 3, background: i === sel ? `${accent}22` : "var(--bg-secondary)", cursor: "pointer" }}>
                <span style={{ width: 22, fontSize: 11, fontWeight: 800, color: accent }}>{i + 1}</span>
                <InlineNameEditor
                  value={r.name}
                  compact
                  onSave={(next) => setRegions(rs => rs.map((x, k) => k === i ? { ...x, name: next } : x))}
                />
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", width: 56 }}>{fmtDur(r.end - r.start)}</span>
                <button onClick={e => { e.stopPropagation(); setSel(i); playRegion(i); }} title="Audition" style={btn}>▶</button>
                <button onClick={e => { e.stopPropagation(); splitSel(i); }} title="Split in half" style={btn}>⌥</button>
                <button onClick={e => { e.stopPropagation(); mergeNext(i); }} title="Merge with next" style={btn} disabled={i >= regions.length - 1}>⌄</button>
                <button onClick={e => { e.stopPropagation(); del(i); }} title="Delete" style={{ ...btn, color: "var(--accent-red)" }}>✕</button>
              </div>
            ))}
          </div>

          {/* Commit form */}
          <div style={{ borderTop: "1px solid var(--border-primary)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <ClassPoolSelect cls={cls} poolId={poolId} pools={pools} onCls={setCls} onPool={setPoolId} />
            <div style={{ flex: 1 }} />
            {commitState && (commitState.busy ? <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Committing {commitState.done}/{commitState.total}…</span>
              : commitState.err ? <span style={{ fontSize: 12, color: "var(--accent-red)" }}>Failed: {commitState.err}</span>
              : <span style={{ fontSize: 12, color: "var(--accent-green)" }}>✓ {commitState.done} committed to Library</span>)}
            <button onClick={commit} disabled={!regions.length || commitState?.busy} style={{ padding: "7px 16px", borderRadius: 4, border: "none", background: accent, color: "#04201c", fontWeight: 800, fontSize: 13, cursor: "pointer", opacity: !regions.length || commitState?.busy ? 0.5 : 1 }}>
              Commit {regions.length} {cls === "SWP" ? "sweeper" : "jingle"}{regions.length === 1 ? "" : "s"} →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: "0 3px" };

// min/max peaks per column for the waveform canvas.
function computePeaks(buf: AudioBuffer, cols: number): { min: Float32Array; max: Float32Array } {
  const data = buf.getChannelData(0); const n = data.length; const per = Math.max(1, Math.floor(n / cols));
  const min = new Float32Array(cols), max = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    let lo = 1, hi = -1; const s = c * per, e = Math.min(n, s + per);
    for (let i = s; i < e; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[c] = lo === 1 ? 0 : lo; max[c] = hi === -1 ? 0 : hi;
  }
  return { min, max };
}
