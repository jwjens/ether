// ParkTalkSettings — Preferences → "Park page — Hold to talk" (2026-10-16, docs/park-mic-build-2026-10-16.md).
//
// Jeff: "2 Park mic input sources (Park Mic 1, Park Mic 2), listed under Mic with the other inputs. The user puts each on
// any fader; that fader's existing settings (MAIN/AUX, ON, stream) decide where it's heard. On the phone, HOLD TO TALK
// lets staff pick which Park mic to talk on, shown by the user's names. … limiter, longest talk 20 s, echo cancellation
// and noise suppression ON, auto gain OFF." "Limiter via the fader's compressor is fine."
//
// Every number is a setting here, shown with its value. Jeff's values are written in once, when a Park mic is first put on
// a fader (main, mic:set) — never over a set value. Hold to talk is off for this station until all are set. Each mic
// shows the fader it is on and where that fader is heard (its own MAIN/AUX, To stream and ON — set on the strip).
// The limiter is that fader's channel compressor: "Put the limiter on …" writes these numbers into it, visible in the
// strip's rack. Main reads and decides (electron/park-talk.js); this panel only shows and saves.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { saveRefusal } from "../lib/parkListenSettings";
import { rackWritten } from "../hooks/useChannelRack";
import { limiterRack, limiterCheck } from "../lib/parkLimiter";
import { useBoardName } from "../hooks/useBoardName";

type Mic = { mic: number; name: string; fader: string | null; conflict: string[] | null; local: string | null; stream: boolean | null; on: boolean | null };
type State = { ready: boolean; missing: string[]; maxSec: number | null; echo: boolean | null; noise: boolean | null; agc: boolean | null;
               limit: { ceilingDb: number | null; attackMs: number | null; releaseMs: number | null }; locked: boolean; mics: Mic[] };

const K = {
  maxSec: "park_talk_max_sec", echo: "park_talk_echo_cancel", noise: "park_talk_noise_suppress", agc: "park_talk_auto_gain",
  ceilingDb: "park_talk_limit_ceiling_db", attackMs: "park_talk_limit_attack_ms", releaseMs: "park_talk_limit_release_ms",
};
const nameKey = (n: number) => `park_mic_${n}_name`;

export default function ParkTalkSettings() {
  const { stationId, stationName } = useActiveStation();
  // ONE NAME PER FADER (Jeff, 2026-10-16: "S1 is an internal name and must never show on screen"): every fader this panel
  // names is called by its board letter, the same helper the strip uses (src/lib/boardName.ts).
  const boardName = useBoardName();
  const fname = (slot: string | null | undefined) => (slot ? boardName(slot) : "");
  // Is the limiter on each Park mic's fader right now? Read from that fader's rack (null = not read yet).
  const [limNow, setLimNow] = useState<Record<number, string | null>>({});
  const ether = (window as any).ether;
  const [s, setS] = useState<State | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  // THE LIMITER BUTTON'S OWN ANSWER, right under that Park mic (Jeff, 2026-10-16: "clicking … does nothing. No change, no
  // message" — the answer used to land at the foot of the panel, out of sight). Per mic; "busy" while it works.
  const [lim, setLim] = useState<Record<number, { text: string; bad: boolean; busy?: boolean }>>({});

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      const r = await ether?.invoke?.("park:talk-state", stationId);
      if (!r?.ok) { setMsg(`Not read: ${r?.error || "no answer"}`); return; }
      setS(r);
      const d: Record<string, string> = {
        [K.maxSec]: r.maxSec != null ? String(r.maxSec) : "",
        [K.ceilingDb]: r.limit?.ceilingDb != null ? String(r.limit.ceilingDb) : "",
        [K.attackMs]: r.limit?.attackMs != null ? String(r.limit.attackMs) : "",
        [K.releaseMs]: r.limit?.releaseMs != null ? String(r.limit.releaseMs) : "",
      };
      for (const m of r.mics as Mic[]) d[nameKey(m.mic)] = m.name;
      setDraft(d);
      const now: Record<number, string | null> = {};
      for (const m of r.mics as Mic[]) {
        if (!m.fader) continue;
        try {
          const g = await ether.audio.getRack(stationId, `ch:${m.fader}`);
          const why = limiterCheck(g?.ok ? g.doc : null, r.limit);
          now[m.mic] = why == null ? "on" : why;
        } catch { now[m.mic] = null; }
      }
      setLimNow(now);
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
  const saveNum = (key: string, label: string, unit: string, lo: number, hi: number) => {
    const v = (draft[key] || "").trim(); const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < lo || n > hi) { setMsg(`${label} must be ${lo} to ${hi} ${unit}.`); return; }
    void save(key, String(n), `${label} ${n} ${unit}`);
  };
  const putLimiter = async (m: Mic) => {
    const say = (text: string, bad: boolean, busy = false) => setLim(x => ({ ...x, [m.mic]: { text, bad, busy } }));
    // Every way out says something (never a silent return).
    if (stationId == null) { say("The limiter was NOT put on: no station is active.", true); return; }
    if (!m.fader) { say(`The limiter was NOT put on: Park Mic ${m.mic} isn't on a fader.`, true); return; }
    const F = fname(m.fader);
    if (!s) { say("The limiter was NOT put on: the settings haven't been read yet.", true); return; }
    const L = s.limit;
    if (L.ceilingDb == null || L.attackMs == null || L.releaseMs == null) { say("The limiter was NOT put on: set its ceiling, attack and release below first.", true); return; }
    const rack = `ch:${m.fader}`;
    say(`Putting the limiter on fader ${F}…`, false, true);
    try {
      const cur = await ether.audio.getRack(stationId, rack);
      if (!cur?.ok) { say(`The limiter was NOT put on fader ${F}: its rack could not be read (${cur?.reason || "no answer"}).`, true); return; }
      const r = await ether.audio.setRack(stationId, limiterRack(cur.doc, L), rack);
      if (!r?.ok) { say(`The limiter was NOT put on fader ${F}: ${r?.reason || r?.error || "the engine refused it"}.`, true); return; }
      // Read it back: the line says what the fader's rack HOLDS now, not what was sent.
      const back = await ether.audio.getRack(stationId, rack);
      const why = limiterCheck(back?.ok ? back.doc : null, L);
      if (why) { say(`The limiter was NOT put on fader ${F}: its rack now holds ${why}.`, true); setLimNow(x => ({ ...x, [m.mic]: why })); return; }
      rackWritten(stationId);   // the fader's EQ lamp and any open rack window re-read it
      setLimNow(x => ({ ...x, [m.mic]: "on" }));
      say(`Done — limiter on fader ${F}: ${L.ceilingDb} dB, 20:1 (attack ${L.attackMs} ms, release ${L.releaseMs} ms). It is the COMP in fader ${F}'s rack.`, false);
    } catch (e) { say(`The limiter was NOT put on fader ${F}: ${String((e as Error)?.message || e)}`, true); }
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
        That fader's own settings decide where the voice is heard: MAIN or AUX, ON, and <strong>TO STREAM</strong> (OFF =
        the park only, never the stream). Park MUTE silences it in the park. One person talks on a mic at a time.
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
              ? <>On fader <b>{fname(m.fader)}</b> · heard on {m.local === "aux" ? "AUX" : "MAIN"} · {m.stream === false ? "park only (To stream OFF)" : "park + stream (To stream ON)"}{m.on === false ? " · the fader is OFF" : ""}
                  {m.conflict && <span style={{ color: "#f59e0b" }}> · also on {m.conflict.filter(x => x !== m.fader).map(fname).join(", ")} — keep it on one fader</span>}
                  {" "}<button style={{ ...btn, padding: "2px 8px", fontSize: 11, marginLeft: 6 }} disabled={!!lim[m.mic]?.busy} onClick={() => void putLimiter(m)}>Put the limiter on fader {fname(m.fader)}</button>
                  {limNow[m.mic] !== undefined && limNow[m.mic] !== null && (
                    <span style={{ marginLeft: 8, fontWeight: 700, color: limNow[m.mic] === "on" ? "#4ade80" : "var(--accent-orange, #f59e0b)" }}>
                      {limNow[m.mic] === "on" ? "Limiter: ON" : `Limiter: not on (fader ${fname(m.fader)} has ${limNow[m.mic]})`}
                    </span>
                  )}</>
              : <span style={{ color: "#f59e0b" }}>Not on a fader — on the board, set a fader's source to Mic and pick “Park Mic {m.mic} (Park page)”.</span>}
          </div>
          {lim[m.mic] && <div role="status" style={{ fontSize: 12, marginTop: 6, fontWeight: 600, color: lim[m.mic].bad ? "var(--accent-orange, #f59e0b)" : "var(--accent-cyan)" }}>{lim[m.mic].text}</div>}
        </div>
      ))}
      <div style={row}>
        <span style={lab}>Longest talk</span>
        <input style={inp} value={draft[K.maxSec] ?? ""} onChange={e => setDraft(d => ({ ...d, [K.maxSec]: e.target.value }))} />
        <span style={small}>seconds</span>
        <button style={btn} onClick={() => saveNum(K.maxSec, "Longest talk", "s", 1, 600)}>Save</button>
        <span style={small}>now: {s.maxSec != null ? `${s.maxSec} s` : "not set"}</span>
      </div>
      {toggle(K.echo, "Phone echo cancellation", s.echo)}
      {toggle(K.noise, "Phone noise suppression", s.noise)}
      {toggle(K.agc, "Phone automatic gain", s.agc)}
      <div style={{ fontSize: 12, fontWeight: 700, padding: "8px 0 2px" }}>Voice limiter (the Park mic fader's compressor at 20:1)</div>
      {([[K.ceilingDb, "Ceiling", "dB", -40, 0, s.limit.ceilingDb], [K.attackMs, "Attack", "ms", 0.1, 330, s.limit.attackMs], [K.releaseMs, "Release", "ms", 50, 3000, s.limit.releaseMs]] as const).map(([key, label, unit, lo, hi, now]) => (
        <div key={key} style={row}>
          <span style={lab}>{label}</span>
          <input style={inp} value={draft[key] ?? ""} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
          <span style={small}>{unit}</span>
          <button style={btn} onClick={() => saveNum(key, `Limiter ${label.toLowerCase()}`, unit, lo, hi)}>Save</button>
          <span style={small}>now: {now != null ? `${now} ${unit}` : "not set"}</span>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Echo cancellation removes what the phone itself plays (not the park speakers). Noise suppression helps with crowd
        and wind. Automatic gain makes quiet talkers louder but also lifts background noise. The limiter catches a shout or a
        bumped phone before the speakers; after saving its numbers, press “Put the limiter on fader …” to write them into
        that fader's compressor (you can see and change it in the fader's rack).
      </div>
      <div style={{ fontSize: 12, marginTop: 8, color: s.ready ? "var(--text-secondary)" : "var(--accent-orange, #f59e0b)" }}>
        {s.locked ? "Park page control is OFF on this station: Hold to talk is locked. " : ""}
        {s.ready ? "Hold to talk is available on this station's Park page for every Park mic that is on a fader." : "Hold to talk is off for this station until the longest talk and the three phone settings are set."}
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("Not") || msg.includes("must") ? "var(--accent-orange, #f59e0b)" : "var(--accent-cyan)" }}>{msg}</div>}
    </div>
  );
}
