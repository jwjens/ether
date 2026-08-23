// DuckerSection — the ducker's tuning, for ONE station, in that station's Preferences.
//
// Slice 3 of docs/aux-channel-ducker-announcements-design-2026-08-21.md (§B.6).
//
// WHY PREFERENCES AND NOT THE CHANNEL STRIP: there is exactly ONE duck envelope per station bus, so
// depth/threshold/attack/hold/release are station-wide by construction — a per-channel depth would
// need a per-channel envelope. Putting them on a strip would imply a per-channel setting that does
// not exist. The strip keeps the one thing that IS per channel: whether that channel arms the duck.
//
// PER STATION, like the rest of Preferences: these are stored in station_config_kv under this
// station's id and pushed to that station's own engine. One station's ducker says nothing about
// another's, which is the same isolation the engine enforces.
//
// Values are pushed to the engine LIVE as they move, so Jeff can dial by ear against real audio, and
// written to the database on release so they survive a restart. Both, deliberately: pushing without
// storing forgets, storing without pushing needs a relaunch to hear.

import { useEffect, useRef, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

/** The engine's own defaults (native/src/audio.rs BusState::new) — kept in step deliberately. */
export const DUCK_DEFAULTS = {
  depthDb: -22,        // how far the programme drops
  thresholdDb: -45,    // source level that engages it
  attackMs: 30,        // duck fast; a late duck is heard as a stumble
  holdMs: 700,         // stay down between words
  releaseMs: 500,      // come back like a house system returning
};

type Params = typeof DUCK_DEFAULTS;

const KV = {
  depthDb: "duck_depth_db",
  thresholdDb: "duck_threshold_db",
  attackMs: "duck_attack_ms",
  holdMs: "duck_hold_ms",
  releaseMs: "duck_release_ms",
} as const;

function Row({ label, hint, value, min, max, step, unit, onChange, onCommit }: {
  label: string; hint: string; value: number; min: number; max: number; step: number;
  unit: string; onChange: (v: number) => void; onCommit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-cyan)" }}>
          {value}{unit}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        aria-label={label}
        style={{ width: "100%" }}
      />
      <span style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{hint}</span>
    </div>
  );
}

export default function DuckerSection() {
  const { stationId, stationName } = useActiveStation();
  const [p, setP] = useState<Params>(DUCK_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const pRef = useRef(p);
  pRef.current = p;

  // Load this station's stored values. Absent keys fall back to the engine's own defaults, so a
  // station that has never been tuned shows exactly what it is actually doing.
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    (async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = r?.ok ? r.rows : [];
        const get = (k: string, d: number) => {
          const v = rows.find(x => x.key === k)?.value;
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : d;
        };
        if (stop) return;
        const next: Params = {
          depthDb:     get(KV.depthDb,     DUCK_DEFAULTS.depthDb),
          thresholdDb: get(KV.thresholdDb, DUCK_DEFAULTS.thresholdDb),
          attackMs:    get(KV.attackMs,    DUCK_DEFAULTS.attackMs),
          holdMs:      get(KV.holdMs,      DUCK_DEFAULTS.holdMs),
          releaseMs:   get(KV.releaseMs,   DUCK_DEFAULTS.releaseMs),
        };
        setP(next);
        setLoaded(true);
        // Assert downward on open: the engine boots at ITS defaults, and the board states the
        // operator's settings rather than assuming them — the same rule the jukebox cut follows.
        push(next);
      } catch { if (!stop) setLoaded(true); }
    })();
    return () => { stop = true; };
  }, [stationId]);

  const push = (v: Params) => {
    if (stationId == null) return;
    try { (window as any).ether?.audio?.setDuckParams?.(stationId, v); } catch { /* engine not up */ }
  };

  /** Live to the engine while dragging — this is a by-ear control. */
  const change = (k: keyof Params) => (n: number) => {
    const next = { ...pRef.current, [k]: n };
    setP(next);
    push(next);
  };

  /** To the database on release, so it survives a restart. */
  const commit = () => {
    if (stationId == null) return;
    const v = pRef.current;
    const kv = (window as any).ether?.stationConfigKv;
    if (!kv?.upsertByKey) return;
    (Object.keys(KV) as (keyof Params)[]).forEach(k => {
      try { kv.upsertByKey(stationId, KV[k], String(v[k])); } catch { /* surfaced by the panel */ }
    });
  };

  const reset = () => { setP(DUCK_DEFAULTS); push(DUCK_DEFAULTS); setTimeout(commit, 0); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "0 0 6px", lineHeight: 1.4 }}>
        When a SOURCE channel with <strong>DUCK ON</strong> has audio, this station's programme drops
        underneath it and rises back when the channel goes quiet. Nothing stops and nothing restarts —
        the song keeps playing under the source and comes back mid-song.
        {" "}These settings are for <strong>{stationName || "this station"}</strong> only.
      </p>

      <Row label="Depth" unit=" dB" value={p.depthDb} min={-40} max={0} step={1}
           hint="How far the programme drops. A short announcement sits fine around −12; a continuous source needs much more or the two clash."
           onChange={change("depthDb")} onCommit={commit} />

      <Row label="Hold" unit=" ms" value={p.holdMs} min={0} max={3000} step={50}
           hint="How long it stays down after the source goes quiet. This is what stops the music fluttering up between words — the setting most worth dialling by ear."
           onChange={change("holdMs")} onCommit={commit} />

      <Row label="Release" unit=" ms" value={p.releaseMs} min={50} max={3000} step={50}
           hint="How the music comes back. Too fast reads as a lurch; too slow and it feels like the station is asleep."
           onChange={change("releaseMs")} onCommit={commit} />

      <Row label="Attack" unit=" ms" value={p.attackMs} min={1} max={300} step={1}
           hint="How fast the duck engages. A late duck is heard as a stumble on the first syllable."
           onChange={change("attackMs")} onCommit={commit} />

      <Row label="Threshold" unit=" dBFS" value={p.thresholdDb} min={-70} max={-10} step={1}
           hint="The source level that engages the duck. It is read post-fader and post-cut, so a closed fader or a cut channel can never duck — the board stays the gate."
           onChange={change("thresholdDb")} onCommit={commit} />

      <button
        onClick={reset}
        style={{
          alignSelf: "flex-start", marginTop: 8, padding: "4px 10px", fontSize: 11,
          background: "var(--bg-tertiary)", color: "var(--text-secondary)",
          border: "1px solid var(--border-primary)", borderRadius: 3, cursor: "pointer",
        }}
      >Reset to defaults</button>

      {!loaded && (
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
          Reading this station's settings…
        </span>
      )}
    </div>
  );
}
