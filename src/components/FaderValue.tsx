// FaderValue — a fader's dB readout (Jeff, 2026-10-13, docs/fader-handling-plan-2026-10-13.md): always the exact level
// to 0.1 dB, lit while the fader moves; DOUBLE-CLICK it to type an exact number (Enter applies, Esc cancels). A number
// above the fader group's maximum stops at the maximum and says so. "off" turns the fader off.
import { useEffect, useRef, useState } from "react";
import { formatDb, parseDbInput, topGain } from "../lib/faderLaw";

export default function FaderValue({ gain, topDb, onChange, active, style, disabled, typeRequest }: {
  gain: number; topDb: number; onChange: (gain: number) => void; active?: boolean; style?: React.CSSProperties; disabled?: boolean;
  /** Bump to open typing from outside (a fader whose readout sits under its drag surface, e.g. a channel cap). */
  typeRequest?: number;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (typing != null) inputRef.current?.select(); }, [typing != null]);
  useEffect(() => { if (typeRequest && !disabled) setTyping(gain > 0 ? (20 * Math.log10(gain)).toFixed(1) : "off"); }, [typeRequest]);
  useEffect(() => { if (!note) return; const t = window.setTimeout(() => setNote(null), 3000); return () => window.clearTimeout(t); }, [note]);

  const apply = () => {
    const db = parseDbInput(typing ?? "");
    if (db == null) { setNote("Type a level in dB, e.g. −5"); return; }
    setTyping(null);
    if (db === -Infinity) { onChange(0); return; }
    const top = topGain(topDb);
    const g = Math.pow(10, db / 20);
    if (g > top + 1e-9) { onChange(top); setNote(`Stopped at the maximum, ${formatDb(top)}`); return; }
    onChange(g);
  };

  if (typing != null) {
    return (
      <input ref={inputRef} value={typing} autoFocus
        onChange={e => setTyping(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") apply(); else if (e.key === "Escape") setTyping(null); }}
        onBlur={() => setTyping(null)}
        onPointerDown={e => e.stopPropagation()}
        aria-label="Type a level in dB"
        style={{ ...style, width: 64, background: "var(--bg-primary)", border: "1px solid #8868D8", color: "var(--text-primary)",
          font: "inherit", fontFamily: "'DM Mono', monospace", padding: "0 4px", outline: "none" }} />
    );
  }
  return (
    <span
      onDoubleClick={e => { if (disabled) return; e.stopPropagation(); setTyping(gain > 0 ? (20 * Math.log10(gain)).toFixed(1) : "off"); }}
      onPointerDown={e => e.stopPropagation()}
      title={disabled ? undefined : "Double-click to type an exact level"}
      style={{ ...style, cursor: disabled ? undefined : "text", position: "relative",
        ...(active ? { color: "#fff", background: "#8868D8", padding: "0 4px" } : null) }}>
      {formatDb(gain)}
      {note && (
        <span style={{ position: "absolute", right: 0, top: "100%", marginTop: 2, whiteSpace: "nowrap", fontSize: 10.5, zIndex: 5,
          background: "#2a1d05", border: "1px solid #f59e0b", color: "#ffd27a", padding: "2px 6px" }}>{note}</span>
      )}
    </span>
  );
}
