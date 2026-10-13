// ParkListenSettings — Preferences → "Park page — Listen" (2026-10-13, docs/park-listen-plan-2026-10-13.md).
//
// Jeff: "Every number involved (buffer, quality) is a visible setting, nothing in code." So nothing here has a value
// until the operator sets it, and Listen stays off for this station until all four are set:
//   · park_listen_output       which local output feeds the park speakers: MONITOR (main), AUX, or both
//   · park_listen_bitrate_kbps Opus quality the station sends (6–510 kbps)
//   · park_listen_frame_ms     Opus frame length (2.5 / 5 / 10 / 20 / 40 / 60 ms) — shorter = less delay, more overhead
//   · park_listen_buffer_ms    how much the listener's phone holds before playing (0–4000 ms; the browser's
//                              jitterBufferTarget) — more = fewer dropouts on a weak connection, more delay
// The sender's live state (park:listen-status from main) is shown under the settings: observed, never claimed.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

const KEYS = ["park_listen_output", "park_listen_bitrate_kbps", "park_listen_frame_ms", "park_listen_buffer_ms"] as const;
type Key = typeof KEYS[number];
const FRAMES = ["2.5", "5", "10", "20", "40", "60"];

export default function ParkListenSettings() {
  const { stationId } = useActiveStation();
  const ether = (window as any).ether;
  const [cur, setCur] = useState<Record<Key, string>>({ park_listen_output: "", park_listen_bitrate_kbps: "", park_listen_frame_ms: "", park_listen_buffer_ms: "" });
  const [draft, setDraft] = useState<Record<Key, string>>(cur);
  const [msg, setMsg] = useState<string | null>(null);
  const [live, setLive] = useState<any>(null);

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      const res: any = await ether?.stationConfigKv?.list?.(stationId);
      const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
      const v = (k: Key) => String(rows.find(r => r?.key === k && !r?.deleted_at)?.value ?? "");
      const next = { park_listen_output: v("park_listen_output"), park_listen_bitrate_kbps: v("park_listen_bitrate_kbps"),
                     park_listen_frame_ms: v("park_listen_frame_ms"), park_listen_buffer_ms: v("park_listen_buffer_ms") };
      setCur(next); setDraft(next);
    } catch (e) { setMsg(`Not read: ${String(e)}`); }
  }, [stationId, ether]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const h = ether?.on?.("park:listen-status", (m: any) => { if (m && Number(m.stationId) === Number(stationId)) setLive(m); });
    return () => { try { ether?.off?.("park:listen-status", h); } catch { /* ignore */ } };
  }, [ether, stationId]);

  const valid = (k: Key, v: string): string | null => {
    if (k === "park_listen_output") return ["monitor", "aux", "both"].includes(v) ? null : "Choose MONITOR, AUX or both.";
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) return "Enter a number.";
    if (k === "park_listen_bitrate_kbps" && !(n >= 6 && n <= 510)) return "Quality must be 6–510 kbps.";
    if (k === "park_listen_frame_ms" && !FRAMES.includes(v)) return `Frame length must be one of ${FRAMES.join(", ")} ms.`;
    if (k === "park_listen_buffer_ms" && !(n >= 0 && n <= 4000)) return "Listener buffer must be 0–4000 ms.";
    return null;
  };
  const save = async (k: Key) => {
    if (stationId == null) return;
    const v = draft[k].trim();
    const bad = valid(k, v);
    if (bad) { setMsg(bad); return; }
    try {
      await ether.stationConfigKv.upsertByKey(stationId, k, v);
      setMsg("Saved. It applies the next time someone presses Listen (and at once on the Park page for the buffer).");
      window.dispatchEvent(new CustomEvent("ether:ops-push", { detail: { stationId } }));
      void load();
    } catch (e) { setMsg(`Not saved: ${String(e)}`); }
  };

  const ready = KEYS.every(k => cur[k] !== "");
  const row = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const;
  const inp = { width: 80, padding: "5px 8px", fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const btn = { padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const now = (k: Key, unit: string) => <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur[k] ? `${cur[k]}${unit}` : "not set"}</span>;
  return (
    <div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Park speakers are fed from</span>
        <select style={{ ...inp, width: 150 }} value={draft.park_listen_output} onChange={e => setDraft(d => ({ ...d, park_listen_output: e.target.value }))}>
          <option value="">— choose —</option>
          <option value="monitor">MONITOR (main output)</option>
          <option value="aux">AUX output</option>
          <option value="both">Both</option>
        </select>
        <button style={btn} onClick={() => void save("park_listen_output")}>Save</button>
        {now("park_listen_output", "")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Listen quality</span>
        <input style={inp} value={draft.park_listen_bitrate_kbps} onChange={e => setDraft(d => ({ ...d, park_listen_bitrate_kbps: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>kbps</span>
        <button style={btn} onClick={() => void save("park_listen_bitrate_kbps")}>Save</button>
        {now("park_listen_bitrate_kbps", " kbps")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Frame length</span>
        <select style={{ ...inp, width: 100 }} value={draft.park_listen_frame_ms} onChange={e => setDraft(d => ({ ...d, park_listen_frame_ms: e.target.value }))}>
          <option value="">— choose —</option>
          {FRAMES.map(f => <option key={f} value={f}>{f} ms</option>)}
        </select>
        <button style={btn} onClick={() => void save("park_listen_frame_ms")}>Save</button>
        {now("park_listen_frame_ms", " ms")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Listener buffer (on the phone)</span>
        <input style={inp} value={draft.park_listen_buffer_ms} onChange={e => setDraft(d => ({ ...d, park_listen_buffer_ms: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>ms</span>
        <button style={btn} onClick={() => void save("park_listen_buffer_ms")}>Save</button>
        {now("park_listen_buffer_ms", " ms")}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Logged-in staff can press <strong>Listen</strong> on the Park page to hear exactly what the park speakers get — after
        the park fader and MUTE, with the carts. It plays only on their own phone; their phone volume never changes the
        park. Quality: higher = better sound, more data. Frame length: shorter = less delay. Listener buffer: more = fewer
        dropouts on a weak connection, but more delay. Nothing is sent unless someone is listening, and it never touches
        the on-air stream or playout.
      </div>
      <div style={{ fontSize: 12, marginTop: 8, color: ready ? "var(--text-secondary)" : "var(--accent-orange, #f59e0b)" }}>
        {ready ? "Listen is available on this station's Park page." : "Listen is off for this station until all four are set."}
        {live && <> Sender: <strong>{live.state}</strong>{live.errorMsg ? ` — ${live.errorMsg}` : ""}.</>}
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
