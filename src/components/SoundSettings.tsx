// SoundSettings — the numbers that shape every source on air, visible and settable (Jeff, 2026-10-11: "nothing baked
// into code. Every number that shapes the sound is a visible, settable value in the UI, stored in settings, with the
// current value shown").
//
//  · LOUDNESS TARGET (LUFS) — every file on any fader is loaded at gain = this target − the file's measured loudness
//    (audiod/loudness.js). One rule for music, sweepers, carts, announcements, the jukebox. Per station.
//  · FADER SMOOTHING (ms) — every level move (faders, MASTER, MONITOR, AUX/room rows) ramps over this time, so nothing
//    zips. 0 = a hard step. Per station.
//  · THE FADER LAW and HOW A FADER FEELS (Jeff, 2026-10-13, option A; docs/fader-handling-plan-2026-10-13.md): the law's
//    points (position → dB, top at +10, each group's maximum slides it) and the Shift fine factor, wheel step, arrow
//    step and Shift+arrow step. Every fader on the board and the Park page uses them. Drawing only: no level moves.
// What is shown is what is stored and what the engine uses (board:sound-settings reads it the way the engine does).
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { lawProblem, type LawPoint } from "../lib/faderLaw";

const FEEL_ROWS = [
  ["fine", "Fine drag (Shift + drag)", "÷", "The movement is divided by this while Shift is held. 1–100."],
  ["wheelDb", "Mouse wheel step", "dB", "One wheel notch. 0.01–10."],
  ["arrowDb", "Arrow key step", "dB", "Up/Right louder, Down/Left quieter, when the fader is selected. 0.01–10."],
  ["arrowFineDb", "Shift + arrow step", "dB", "0.01–10."],
] as const;

export default function SoundSettings() {
  const { stationId } = useActiveStation();
  const ether = (window as any).ether;
  type Tops = { channel: number; aux: number; master: number; monitor: number };
  type Feel = { fine?: number; wheelDb?: number; arrowDb?: number; arrowFineDb?: number };
  const [cur, setCur] = useState<{ loudnessTargetLufs: number; smoothingMs: number; faderTopDb?: Tops; faderLaw?: LawPoint[] | null; faderFeel?: Feel } | null>(null);
  const [lawDraft, setLawDraft] = useState<{ pos: string; db: string }[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({ loudnessTargetLufs: "", smoothingMs: "", channelTopDb: "", auxTopDb: "", masterTopDb: "", monitorTopDb: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ cached: number; queued: number; measured: number; failed: number } | null>(null);

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      const s = await ether?.invoke?.("board:sound-settings", stationId);
      if (s) {
        setCur(s);
        const t = s.faderTopDb || {};
        const f = s.faderFeel || {};
        setDraft({ loudnessTargetLufs: String(s.loudnessTargetLufs), smoothingMs: String(s.smoothingMs),
                   channelTopDb: String(t.channel ?? ""), auxTopDb: String(t.aux ?? ""), masterTopDb: String(t.master ?? ""), monitorTopDb: String(t.monitor ?? ""),
                   "feel.fine": String(f.fine ?? ""), "feel.wheelDb": String(f.wheelDb ?? ""), "feel.arrowDb": String(f.arrowDb ?? ""), "feel.arrowFineDb": String(f.arrowFineDb ?? "") });
        setLawDraft(Array.isArray(s.faderLaw) ? s.faderLaw.map((p: LawPoint) => ({ pos: String(Math.round(p.pos * 1000) / 10), db: String(p.db) })) : []);
      }
    } catch (e) { setMsg(`Not read: ${String(e)}`); }
  }, [stationId, ether]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const st = await ether?.invoke?.("board:loudness-status"); if (alive) setStatus(st || null); } catch { /* engine not up */ } };
    void tick(); const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [ether]);

  const save = async (key: string) => {
    if (stationId == null) return;
    const v = Number(draft[key]);
    if (!Number.isFinite(v)) { setMsg("Enter a number."); return; }
    try {
      const r = await ether?.invoke?.("board:set-sound-setting", stationId, key, v);
      if (!r || r.ok !== true) { setMsg(`Not saved: ${(r && r.reason) || "no answer"}`); return; }
      setMsg(key === "loudnessTargetLufs" ? `Loudness target is now ${r.value} LUFS — applies to every file from its next load.`
           : key === "smoothingMs" ? `Fader smoothing is now ${r.value} ms.`
           : key.startsWith("feel.") ? `Saved: ${r.value}. Every fader uses it now.`
           : `That fader group now tops out at ${r.value > 0 ? "+" : ""}${r.value} dB — the faders redraw on the same curve; no level moves.`);
      void load();
    } catch (e) { setMsg(`Not saved: ${String(e)}`); }
  };

  const saveLaw = async () => {
    if (stationId == null) return;
    const pts = lawDraft.map(r => ({ pos: Number(r.pos) / 100, db: Number(r.db) }));
    const bad = lawProblem(pts);
    if (bad) { setMsg(bad); return; }
    try {
      const r = await ether?.invoke?.("board:set-sound-setting", stationId, "faderLaw", pts);
      if (!r || r.ok !== true) { setMsg(`Not saved: ${(r && r.reason) || "no answer"}`); return; }
      setMsg("Fader law saved — every fader redraws on it now; no level moves.");
      void load();
    } catch (e) { setMsg(`Not saved: ${String(e)}`); }
  };

  const row = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const;
  const inp = { width: 80, padding: "5px 8px", fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const btn = { padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  return (
    <div>
      <div style={row}>
        <span style={{ width: 170, fontSize: 13 }}>Loudness target</span>
        <input style={inp} value={draft.loudnessTargetLufs} onChange={e => setDraft(d => ({ ...d, loudnessTargetLufs: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>LUFS</span>
        <button style={btn} onClick={() => void save("loudnessTargetLufs")}>Save</button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur ? `${cur.loudnessTargetLufs} LUFS` : "—"}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginBottom: 6 }}>
        Every file on any fader — songs, sweepers, carts, announcements, the jukebox — plays at this loudness:
        Ether measures each file once and sets its gain to the difference. Range −40…−5.
        {status && <> Measured so far: {status.cached} file(s){status.queued ? `, ${status.queued} waiting` : ""}{status.failed ? `, ${status.failed} could not be measured` : ""}.</>}
      </div>
      <div style={row}>
        <span style={{ width: 170, fontSize: 13 }}>Fader smoothing</span>
        <input style={inp} value={draft.smoothingMs} onChange={e => setDraft(d => ({ ...d, smoothingMs: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>ms</span>
        <button style={btn} onClick={() => void save("smoothingMs")}>Save</button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur ? `${cur.smoothingMs} ms` : "—"}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
        How long every level move takes — channel faders, MASTER, MONITOR and the AUX rows — so a move never clicks or zips.
        0 = an instant step. Range 0…500.
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "14px 0 4px" }}>Fader maximum (top of travel)</div>
      {([["channelTopDb", "channel", "Channel faders"], ["auxTopDb", "aux", "AUX rows"], ["masterTopDb", "master", "MASTER"], ["monitorTopDb", "monitor", "MONITOR (and each station's MONITOR strip)"]] as const).map(([key, g, name]) => (
        <div key={key} style={row}>
          <span style={{ width: 170, fontSize: 13 }}>{name}</span>
          <input style={inp} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>dB</span>
          <button style={btn} onClick={() => void save(key)}>Save</button>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur?.faderTopDb ? `${cur.faderTopDb[g] > 0 ? "+" : ""}${cur.faderTopDb[g]} dB` : "—"}</span>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
        Every fader uses the same curve; this sets the level at the very top of each group's travel (0 to +10 dB).
        Lowering it never changes a level that is already set below it.
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "14px 0 4px" }}>How a fader moves</div>
      {FEEL_ROWS.map(([k, name, unit, help]) => (
        <div key={k}>
          <div style={row}>
            <span style={{ width: 170, fontSize: 13 }}>{name}</span>
            <input style={inp} value={draft[`feel.${k}`] ?? ""} onChange={e => setDraft(d => ({ ...d, [`feel.${k}`]: e.target.value }))} />
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{unit}</span>
            <button style={btn} onClick={() => void save(`feel.${k}`)}>Save</button>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur?.faderFeel?.[k] != null ? `${cur.faderFeel[k]}${unit === "dB" ? " dB" : ""}` : "not set"}</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: -4 }}>{help}</div>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 4 }}>
        On every fader: pressing never moves it — it moves by how far you drag. Double-click a fader's level to type an exact one.
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "14px 0 4px" }}>Fader law (where each level sits on the travel)</div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginBottom: 4 }}>
        Points from the bottom up: position on the travel (%) and the level there (dB) on a fader whose top is +10 dB; each
        group's maximum above slides the whole curve. Between points the curve is straight in dB; below the first point it
        falls 30 dB more, then off. The last point must be 100 % = +10 dB.
      </div>
      {lawDraft.length === 0 && <div style={{ fontSize: 12, color: "var(--accent-orange, #f59e0b)" }}>Not set yet — Ether writes the starting law when the audio engine connects.</div>}
      {lawDraft.map((r, i) => (
        <div key={i} style={row}>
          <span style={{ width: 60, fontSize: 12, color: "var(--text-secondary)" }}>Point {i + 1}</span>
          <input style={inp} value={r.pos} onChange={e => setLawDraft(L => L.map((x, j) => j === i ? { ...x, pos: e.target.value } : x))} />
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>%</span>
          <input style={inp} value={r.db} onChange={e => setLawDraft(L => L.map((x, j) => j === i ? { ...x, db: e.target.value } : x))} />
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>dB</span>
          <button style={btn} onClick={() => setLawDraft(L => L.filter((_, j) => j !== i))} disabled={lawDraft.length <= 2}>Remove</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button style={btn} onClick={() => setLawDraft(L => [...L.slice(0, Math.max(0, L.length - 1)), { pos: "", db: "" }, ...L.slice(-1)])} disabled={lawDraft.length >= 16}>Add a point</button>
        <button style={btn} onClick={() => void saveLaw()} disabled={lawDraft.length === 0}>Save law</button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
