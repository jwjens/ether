// SoundSettings — the numbers that shape every source on air, visible and settable (Jeff, 2026-10-11: "nothing baked
// into code. Every number that shapes the sound is a visible, settable value in the UI, stored in settings, with the
// current value shown").
//
//  · LOUDNESS TARGET (LUFS) — every file on any fader is loaded at gain = this target − the file's measured loudness
//    (audiod/loudness.js). One rule for music, sweepers, carts, announcements, the jukebox. Per station.
//  · FADER SMOOTHING (ms) — every level move (faders, MASTER, MONITOR, AUX/room rows) ramps over this time, so nothing
//    zips. 0 = a hard step. Per station.
// What is shown is what is stored and what the engine uses (board:sound-settings reads it the way the engine does).
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

export default function SoundSettings() {
  const { stationId } = useActiveStation();
  const ether = (window as any).ether;
  const [cur, setCur] = useState<{ loudnessTargetLufs: number; smoothingMs: number } | null>(null);
  const [draft, setDraft] = useState<{ loudnessTargetLufs: string; smoothingMs: string }>({ loudnessTargetLufs: "", smoothingMs: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ cached: number; queued: number; measured: number; failed: number } | null>(null);

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      const s = await ether?.invoke?.("board:sound-settings", stationId);
      if (s) { setCur(s); setDraft({ loudnessTargetLufs: String(s.loudnessTargetLufs), smoothingMs: String(s.smoothingMs) }); }
    } catch (e) { setMsg(`Not read: ${String(e)}`); }
  }, [stationId, ether]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const st = await ether?.invoke?.("board:loudness-status"); if (alive) setStatus(st || null); } catch { /* engine not up */ } };
    void tick(); const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [ether]);

  const save = async (key: "loudnessTargetLufs" | "smoothingMs") => {
    if (stationId == null) return;
    const v = Number(draft[key]);
    if (!Number.isFinite(v)) { setMsg("Enter a number."); return; }
    try {
      const r = await ether?.invoke?.("board:set-sound-setting", stationId, key, v);
      if (!r || r.ok !== true) { setMsg(`Not saved: ${(r && r.reason) || "no answer"}`); return; }
      setMsg(key === "loudnessTargetLufs" ? `Loudness target is now ${r.value} LUFS — applies to every file from its next load.` : `Fader smoothing is now ${r.value} ms.`);
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
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
