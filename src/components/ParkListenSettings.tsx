// ParkListenSettings — Preferences → "Park page — Listen" (2026-10-13, docs/park-listen-plan-2026-10-13.md).
//
// Jeff: "Every number involved (buffer, quality) is a visible setting, nothing in code." So nothing here has a value
// until the operator sets it, and Listen stays off for this station until all four are set:
//   · park_listen_bitrate_kbps Opus quality the station sends (6–510 kbps)
//   · park_listen_channels     mono or stereo (Jeff, 2026-10-13: mono — "only for quick observing")
//   · park_listen_frame_ms     Opus frame length (2.5 / 5 / 10 / 20 / 40 / 60 ms) — shorter = less delay, more overhead
//   · park_listen_buffer_ms    how much the listener's phone holds before playing (0–4000 ms; the browser's
//                              jitterBufferTarget) — more = fewer dropouts on a weak connection, more delay. 0 is a value.
// WHAT is sent is not a setting (Jeff, 2026-10-16): the complete local mix the park hears — every MAIN and AUX source,
// after MONITOR and MUTE (audiod/listen.js LISTEN_ALL). The old "Park speakers are fed from" choice is gone; an old
// park_listen_output row is simply no longer read.
// A save shows what was actually STORED for which station (read back), or why it was refused — never "Saved." on faith.
// The sender's live state (park:listen-status from main) is shown under the settings: observed, never claimed.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { LISTEN_KEYS, storedValue, saveRefusal, type ListenKey } from "../lib/parkListenSettings";

type Key = ListenKey;
const KEYS = LISTEN_KEYS;
const FRAMES = ["2.5", "5", "10", "20", "40", "60"];
const UNIT: Record<Key, string> = { park_listen_bitrate_kbps: " kbps", park_listen_channels: "", park_listen_frame_ms: " ms", park_listen_buffer_ms: " ms" };
const NAME: Record<Key, string> = { park_listen_bitrate_kbps: "Listen quality", park_listen_channels: "Channels", park_listen_frame_ms: "Frame length", park_listen_buffer_ms: "Listener buffer" };
const EMPTY: Record<Key, string> = { park_listen_bitrate_kbps: "", park_listen_channels: "", park_listen_frame_ms: "", park_listen_buffer_ms: "" };

export default function ParkListenSettings() {
  const { stationId, stationName } = useActiveStation();
  const ether = (window as any).ether;
  const [cur, setCur] = useState<Record<Key, string>>(EMPTY);
  const [draft, setDraft] = useState<Record<Key, string>>(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);
  const [live, setLive] = useState<any>(null);

  const read = useCallback(async (): Promise<Record<Key, string> | null> => {
    if (stationId == null) return null;
    const res: any = await ether?.stationConfigKv?.list?.(stationId);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    const next = { ...EMPTY };
    for (const k of KEYS) next[k] = storedValue(rows, k);
    return next;
  }, [stationId, ether]);
  const load = useCallback(async () => {
    try { const next = await read(); if (next) { setCur(next); setDraft(next); } }
    catch (e) { setMsg(`Not read: ${String(e)}`); }
  }, [read]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const h = ether?.on?.("park:listen-status", (m: any) => { if (m && Number(m.stationId) === Number(stationId)) setLive(m); });
    return () => { try { ether?.off?.("park:listen-status", h); } catch { /* ignore */ } };
  }, [ether, stationId]);

  const valid = (k: Key, v: string): string | null => {
    if (k === "park_listen_channels") return ["mono", "stereo"].includes(v) ? null : "Choose Mono or Stereo.";
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) return "Enter a number.";
    if (k === "park_listen_bitrate_kbps" && !(n >= 6 && n <= 510)) return "Quality must be 6–510 kbps.";
    if (k === "park_listen_frame_ms" && !FRAMES.includes(v)) return `Frame length must be one of ${FRAMES.join(", ")} ms.`;
    if (k === "park_listen_buffer_ms" && !(n >= 0 && n <= 4000)) return "Listener buffer must be 0–4000 ms.";
    return null;
  };
  const save = async (k: Key) => {
    if (stationId == null) { setMsg("Not saved: no station is active."); return; }
    const v = draft[k].trim();
    const bad = valid(k, v);
    if (bad) { setMsg(bad); return; }
    const where = stationName ? ` for ${stationName}` : "";
    try {
      // The IPC answers {ok:false, error} instead of throwing — it used to be ignored, so a refused save said "Saved."
      const refused = saveRefusal(await ether.stationConfigKv.upsertByKey(stationId, k, v));
      if (refused) { setMsg(`Not saved${where}: ${refused}`); return; }
      // Read it back: the message says what is STORED, not what was typed.
      const next = await read();
      if (next) { setCur(next); setDraft(next); }
      const got = next ? next[k] : "";
      if (got !== v) { setMsg(`Not saved${where}: ${NAME[k]} reads "${got || "not set"}" after saving "${v}".`); return; }
      setMsg(`Saved${where}: ${NAME[k]} ${got}${UNIT[k]}. It applies the next time someone presses Listen (and at once on the Park page for the buffer).`);
      window.dispatchEvent(new CustomEvent("ether:ops-push", { detail: { stationId } }));
    } catch (e) { setMsg(`Not saved${where}: ${String(e)}`); }
  };

  const ready = KEYS.every(k => cur[k] !== "");
  const row = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const;
  const inp = { width: 80, padding: "5px 8px", fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const btn = { padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const now = (k: Key) => <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>now: {cur[k] !== "" ? `${cur[k]}${UNIT[k]}` : "not set"}</span>;
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: "2px 0 6px" }}>
        Listen sends everything the park hears: every MAIN and AUX source (music, announcements, commercials, sound
        effects, carts), after MONITOR and MUTE.
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Listen quality</span>
        <input style={inp} value={draft.park_listen_bitrate_kbps} onChange={e => setDraft(d => ({ ...d, park_listen_bitrate_kbps: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>kbps</span>
        <button style={btn} onClick={() => void save("park_listen_bitrate_kbps")}>Save</button>
        {now("park_listen_bitrate_kbps")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Channels</span>
        <select style={{ ...inp, width: 100 }} value={draft.park_listen_channels} onChange={e => setDraft(d => ({ ...d, park_listen_channels: e.target.value }))}>
          <option value="">— choose —</option>
          <option value="mono">Mono</option>
          <option value="stereo">Stereo</option>
        </select>
        <button style={btn} onClick={() => void save("park_listen_channels")}>Save</button>
        {now("park_listen_channels")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Frame length</span>
        <select style={{ ...inp, width: 100 }} value={draft.park_listen_frame_ms} onChange={e => setDraft(d => ({ ...d, park_listen_frame_ms: e.target.value }))}>
          <option value="">— choose —</option>
          {FRAMES.map(f => <option key={f} value={f}>{f} ms</option>)}
        </select>
        <button style={btn} onClick={() => void save("park_listen_frame_ms")}>Save</button>
        {now("park_listen_frame_ms")}
      </div>
      <div style={row}>
        <span style={{ width: 210, fontSize: 13 }}>Listener buffer (on the phone)</span>
        <input style={inp} value={draft.park_listen_buffer_ms} onChange={e => setDraft(d => ({ ...d, park_listen_buffer_ms: e.target.value }))} />
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>ms</span>
        <button style={btn} onClick={() => void save("park_listen_buffer_ms")}>Save</button>
        {now("park_listen_buffer_ms")}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Logged-in staff can press <strong>Listen</strong> on the Park page to hear exactly what the park speakers get — after
        the park fader and MUTE, with the carts. It plays only on their own phone; their phone volume never changes the
        park. Quality: higher = better sound, more data. Mono sounds clearer than stereo at a low quality setting. Frame
        length: shorter = less delay. Listener buffer: more = fewer dropouts on a weak connection, but more delay (0 = the
        phone's own minimum). Nothing is sent unless someone is listening, and it never touches the on-air stream or playout.
      </div>
      <div style={{ fontSize: 12, marginTop: 8, color: ready ? "var(--text-secondary)" : "var(--accent-orange, #f59e0b)" }}>
        {ready ? "Listen is available on this station's Park page." : "Listen is off for this station until all four are set."}
        {live && <> Sender: <strong>{live.state}</strong>{live.errorMsg ? ` — ${live.errorMsg}` : ""}.</>}
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("Not") ? "var(--accent-orange, #f59e0b)" : "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
