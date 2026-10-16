// ParkTalkSettings — Preferences → "Park page — Hold to talk" (2026-10-16, docs/park-mic-build-2026-10-16.md).
//
// Jeff: "2 Park mic input sources (Park Mic 1, Park Mic 2), listed under Mic with the other inputs. The user puts each on
// any fader … On the phone, HOLD TO TALK lets staff pick which Park mic to talk on, shown by the user's names. … longest
// talk 20 s, echo cancellation and noise suppression ON, auto gain OFF."
//
// NO LIMITER HERE (Jeff, 2026-10-16): "Remove the special Park mic limiter … The Park mic fader uses its own processor like
// every other fader, and nothing is applied automatically or baked in." The fader's own rack is where any processing goes.
//
// Every number is a setting here, shown with its value. Jeff's values are written in once, when a Park mic is first put on
// a fader (main, mic:set) — never over a set value. Hold to talk is off for this station until all are set. Each mic
// shows the fader it is on — by its BOARD LETTER, never the engine slot (src/lib/boardName.ts) — and whether that fader
// also goes on air (its MAIN button on the strip). Main reads and decides (electron/park-talk.js); this panel shows and saves.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { useBoardName } from "../hooks/useBoardName";
import { saveRefusal } from "../lib/parkListenSettings";

type Mic = { mic: number; name: string; fader: string | null; conflict: string[] | null; stream: boolean | null; on: boolean | null };
type State = { ready: boolean; missing: string[]; maxSec: number | null; echo: boolean | null; noise: boolean | null; agc: boolean | null;
               locked: boolean; mics: Mic[] };

const K = { maxSec: "park_talk_max_sec", echo: "park_talk_echo_cancel", noise: "park_talk_noise_suppress", agc: "park_talk_auto_gain" };
const nameKey = (n: number) => `park_mic_${n}_name`;

export default function ParkTalkSettings() {
  const { stationId, stationName } = useActiveStation();
  // ONE NAME PER FADER (Jeff, 2026-10-16: "S1 is an internal name and must never show on screen").
  const boardName = useBoardName();
  const fname = (slot: string | null | undefined) => (slot ? boardName(slot) : "");
  const ether = (window as any).ether;
  const [s, setS] = useState<State | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      const r = await ether?.invoke?.("park:talk-state", stationId);
      if (!r?.ok) { setMsg(`Not read: ${r?.error || "no answer"}`); return; }
      setS(r);
      const d: Record<string, string> = { [K.maxSec]: r.maxSec != null ? String(r.maxSec) : "" };
      for (const m of r.mics as Mic[]) d[nameKey(m.mic)] = m.name;
      setDraft(d);
    } catch (e) { setMsg(`Not read: ${String(e)}`); }
  }, [stationId, ether]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const h = ether?.on?.("park:talk-status", () => void load());
    return () => { try { if (h) ether?.off?.("park:talk-status", h); } catch { /* closing */ } };
  }, [ether, load]);

  const where = stationName ? ` for ${stationName}` : "";
  const save = async (key: string, value: string, what: string) => {
    if (stationId == null) return;
    try {
      const refused = saveRefusal(await ether.stationConfigKv.upsertByKey(stationId, key, value));
      if (refused) { setMsg(`Not saved${where}: ${refused}`); return; }
      setMsg(`Saved${where}: ${what}.`);
      window.dispatchEvent(new CustomEvent("ether:ops-push", { detail: { stationId } }));
      void load();
    } catch (e) { setMsg(`Not saved${where}: ${String(e)}`); }
  };

  const row = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", flexWrap: "wrap" } as const;
  const inp = { width: 80, padding: "5px 8px", fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const btn = { padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;
  const lab = { width: 210, fontSize: 13 } as const;
  const small = { fontSize: 12, color: "var(--text-secondary)" } as const;
  if (!s) return <div style={small}>{msg || "Reading…"}</div>;
  const toggle = (key: string, label: string, val: boolean | null) => (
    <div style={row}>
      <span style={lab}>{label}</span>
      <button style={{ ...btn, minWidth: 64 }} onClick={() => void save(key, val ? "0" : "1", `${label} ${val ? "OFF" : "ON"}`)} aria-pressed={!!val}>{val == null ? "not set" : val ? "ON" : "OFF"}</button>
      <span style={small}>click to switch</span>
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: "2px 0 8px", lineHeight: 1.5 }}>
        Logged-in staff hold <strong>HOLD TO TALK</strong> on the Park page and talk on one of these Park mics. Each Park mic
        is an input like a sound-card mic: on the board, set a fader's source to <strong>Mic</strong> and pick the Park mic.
        It plays in the park like every fader. Its <strong>MAIN</strong> button on the board puts the voice on air as well
        (lit) or keeps it in the park only (not lit); <strong>DUCK</strong> dips the music while someone talks. Park MUTE
        silences it in the park. One person talks on a mic at a time.
      </div>
      {s.mics.map(m => (
        <div key={m.mic} style={{ padding: "8px 10px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", marginBottom: 8 }}>
          <div style={row}>
            <span style={{ ...lab, fontWeight: 700 }}>Park Mic {m.mic} — name on the phone</span>
            <input style={{ ...inp, width: 180 }} value={draft[nameKey(m.mic)] ?? ""} maxLength={40}
              onChange={e => setDraft(d => ({ ...d, [nameKey(m.mic)]: e.target.value }))} />
            <button style={btn} onClick={() => { const v = (draft[nameKey(m.mic)] || "").trim(); if (!v) { setMsg("Give the Park mic a name."); return; } void save(nameKey(m.mic), v, `Park Mic ${m.mic} is "${v}" on the phone`); }}>Save</button>
          </div>
          <div style={{ ...small, paddingLeft: 2 }}>
            {m.fader
              ? <>On fader <b>{fname(m.fader)}</b> · {m.stream === false ? "park only (MAIN not lit)" : "park and on air (MAIN lit)"}{m.on === false ? " · the fader is OFF" : ""}
                  {m.conflict && <span style={{ color: "#f59e0b" }}> · also on {m.conflict.filter(x => x !== m.fader).map(fname).join(", ")} — keep it on one fader</span>}</>
              : <span style={{ color: "#f59e0b" }}>Not on a fader — on the board, set a fader's source to Mic and pick “Park Mic {m.mic} (Park page)”.</span>}
          </div>
        </div>
      ))}
      <div style={row}>
        <span style={lab}>Longest talk</span>
        <input style={inp} value={draft[K.maxSec] ?? ""} onChange={e => setDraft(d => ({ ...d, [K.maxSec]: e.target.value }))} />
        <span style={small}>seconds</span>
        <button style={btn} onClick={() => { const v = (draft[K.maxSec] || "").trim(); const n = Number(v);
          if (v === "" || !Number.isFinite(n) || n < 1 || n > 600) { setMsg("Longest talk must be 1 to 600 s."); return; }
          void save(K.maxSec, String(n), `Longest talk ${n} s`); }}>Save</button>
        <span style={small}>now: {s.maxSec != null ? `${s.maxSec} s` : "not set"}</span>
      </div>
      {toggle(K.echo, "Phone echo cancellation", s.echo)}
      {toggle(K.noise, "Phone noise suppression", s.noise)}
      {toggle(K.agc, "Phone automatic gain", s.agc)}
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Echo cancellation removes what the phone itself plays (not the park speakers). Noise suppression helps with crowd
        and wind. Automatic gain makes quiet talkers louder but also lifts background noise. Any processing of the voice
        (EQ, compressor) goes in the Park mic fader's own rack, like every other fader.
      </div>
      <div style={{ fontSize: 12, marginTop: 8, color: s.ready ? "var(--text-secondary)" : "var(--accent-orange, #f59e0b)" }}>
        {s.locked ? "Park page control is OFF on this station: Hold to talk is locked. " : ""}
        {s.ready ? "Hold to talk is available on this station's Park page for every Park mic that is on a fader." : "Hold to talk is off for this station until the longest talk and the three phone settings are set."}
      </div>
      {msg && <div role="status" style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("Not") || msg.includes("must") ? "var(--accent-orange, #f59e0b)" : "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
