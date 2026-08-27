// StudioSendBar — the StudioPro (Show+ DAW) "chop & send" exits. Operates on the SELECTED region's decoded
// buffer, chopped by its real trim handles [startSec,endSec], and sends that selection via FOUR first-class
// exits, all on VERIFIED rails (never a decorative event):
//   → LIBRARY / → SWEEPER : the ONE shared imaging engine (imagingCommit.commitRegionToLibrary)
//   → DECK                           : render to disk, then the REAL deck-load command path
//                                      (getEngine(stationId).deckCue / loadToDeck — the Library A/B/C path)
// Audition uses the shared regionAudition. Name via the shared InlineNameEditor; class/pool via the shared
// ClassPoolSelect — one commit form, two surfaces (with the Reel Splitter). Self-contained audio: the
// audition plays on the DAW's own AudioContext and never touches on-air playout.
import { useEffect, useRef, useState } from "react";
import InlineNameEditor from "./InlineNameEditor";
import ClassPoolSelect, { useImagingPools } from "./ClassPoolSelect";
import { auditionRegion } from "../audio/regionAudition";
import { commitRegionToLibrary, renderRegionToDisk } from "../audio/imagingCommit";
import { getEngine } from "../audio/engine-registry";
import { SWP_INDIGO } from "../lib/classColors";

type Status = { kind: "idle" | "busy" | "ok" | "err"; msg?: string };
type Exit = null | "class" | "deck";

const btn = (color: string, on = false): React.CSSProperties => ({
  padding: "6px 12px", borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: "pointer",
  border: `1px solid ${color}`, background: on ? `${color}22` : "transparent", color,
});

export default function StudioSendBar({ buffer, startSec, endSec, defaultName, stationId, ctx }: {
  buffer: AudioBuffer; startSec: number; endSec: number; defaultName: string; stationId: number; ctx: AudioContext;
}) {
  const [name, setName] = useState(defaultName);
  const [exit, setExit] = useState<Exit>(null);
  const [cls, setCls] = useState<"SWP">("SWP");
  const [poolId, setPoolId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [playing, setPlaying] = useState(false);
  const pools = useImagingPools(stationId);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => { setName(defaultName); }, [defaultName]);
  // A changed selection invalidates the in-flight audition + status.
  useEffect(() => { stop(); setStatus({ kind: "idle" }); /* eslint-disable-next-line */ }, [buffer, startSec, endSec]);

  const stop = () => { try { srcRef.current?.stop(); } catch { /* already stopped */ } srcRef.current = null; setPlaying(false); };
  const audition = () => {
    if (playing) { stop(); return; }
    const src = auditionRegion(ctx, buffer, startSec, endSec, () => { if (srcRef.current === src) { srcRef.current = null; setPlaying(false); } });
    srcRef.current = src; setPlaying(true);
  };

  const reelSlug = name || "studio";
  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (!(endSec - startSec > 0.02)) { setStatus({ kind: "err", msg: "selection too short" }); return; }
    stop(); setStatus({ kind: "busy", msg: label });
    try { await fn(); setStatus({ kind: "ok", msg: `sent → ${label}` }); setExit(null); }
    catch (e) { setStatus({ kind: "err", msg: (e as Error).message }); }
  };

  const sendLibrary = () => run("Library", () =>
    commitRegionToLibrary(buffer, startSec, endSec, { name, cls: "MUS", poolId: null, reelSlug }));
  const sendClass = () => run("Sweepers", () =>
    commitRegionToLibrary(buffer, startSec, endSec, { name, cls, poolId, reelSlug }));
  const sendDeck = (deck: "A" | "B" | "C") => run(`Deck ${deck}`, async () => {
    const { filePath, durationMs } = await renderRegionToDisk(buffer, startSec, endSec, reelSlug, name);
    const eng = getEngine(stationId);                      // resolve the ACTIVE station's engine fresh (command-path scoping)
    if (eng.getDeck(deck).getState().status === "playing") throw new Error(`Deck ${deck} is on air`);
    if (eng.isDaemonDriven) await eng.deckCue(deck, { filePath, title: name, artist: "", durationMs });
    else await eng.loadToDeck(deck, filePath, name, "", 0, durationMs);
  });

  const openClass = () => { setPoolId(null); setExit("class"); };
  const selDur = Math.max(0, endSec - startSec);

  return (
    <div style={{ borderTop: "1px solid var(--border-primary)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase" }}>Send selection</span>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{selDur.toFixed(2)}s</span>
        <div style={{ minWidth: 160 }}>
          <InlineNameEditor value={name} compact onSave={setName} />
        </div>
        <button onClick={audition} title="Audition the selection (this DAW only — not on air)" style={btn("var(--accent-cyan)", playing)}>{playing ? "■ Stop" : "▶ Audition"}</button>
        <div style={{ flex: 1 }} />
        <button onClick={sendLibrary} style={btn("var(--accent-green)")}>→ Library</button>
        <button onClick={openClass} style={btn(SWP_INDIGO, exit === "class")}>→ Sweeper</button>
        <button onClick={() => setExit(exit === "deck" ? null : "deck")} style={btn("var(--accent-blue)", exit === "deck")}>→ Deck</button>
      </div>

      {exit === "class" && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <ClassPoolSelect cls={cls} poolId={poolId} pools={pools} onCls={setCls} onPool={setPoolId} compact />
          <button onClick={sendClass} style={{ ...btn(SWP_INDIGO), fontWeight: 800 }}>
            Send to Sweepers →
          </button>
          <button onClick={() => setExit(null)} style={{ ...btn("var(--text-tertiary)"), border: "none" }}>cancel</button>
        </div>
      )}

      {exit === "deck" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Load onto deck:</span>
          {(["A", "B", "C"] as const).map(d => (
            <button key={d} onClick={() => sendDeck(d)} style={{ ...btn("var(--accent-blue)"), fontWeight: 800, minWidth: 38 }}>{d}</button>
          ))}
          <button onClick={() => setExit(null)} style={{ ...btn("var(--text-tertiary)"), border: "none" }}>cancel</button>
        </div>
      )}

      {status.kind !== "idle" && (
        <div style={{ fontSize: 12, color: status.kind === "err" ? "var(--accent-red)" : status.kind === "ok" ? "var(--accent-green)" : "var(--text-secondary)" }}>
          {status.kind === "busy" ? `Sending to ${status.msg}…` : status.msg}
        </div>
      )}
    </div>
  );
}
