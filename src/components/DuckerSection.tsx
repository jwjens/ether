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
import { queryScoped } from "../db/stationScoped";

/** One deck's line in the receiver-side list. */
type DeckRow = { slot: string; label: string; type: string; duckable: boolean };

// THE DUCKER'S VALUES ARE THIS STATION'S PREFERENCES — NOTHING ELSE (Jeff's ruling, 2026-10-13). This panel holds no
// numbers of its own. It shows what Preferences holds; a station that has none yet is given the starting values by main
// (written INTO Preferences once — audiod/duck-defaults.js is the one place they live), and "Reset" writes those same
// starting values, which main hands this panel (board:duck-start). docs/duck-from-preferences-2026-10-13.md.
type Params = { depthDb: number; thresholdDb: number; attackMs: number; holdMs: number; releaseMs: number };

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
  const [p, setP] = useState<Params | null>(null);          // null until Preferences are read — never a placeholder
  const [start, setStart] = useState<Params | null>(null);  // the starting values (from main; one place)
  const [missing, setMissing] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const pRef = useRef(p);
  pRef.current = p;

  useEffect(() => {
    (async () => { try { const s = await (window as any).ether?.invoke?.("board:duck-start"); if (s && typeof s === "object") setStart(s as Params); } catch { /* shown as "—" */ } })();
  }, []);

  // ── THE RECEIVER SIDE ────────────────────────────────────────────────────────────────────────
  // A ducker is a sidechain: a TRIGGER and a SET OF CHANNELS it acts on. This list is that set.
  // Every deck is individually duckable or immune, per station, operator's choice — no baked-in rule
  // about any particular deck. Default is all duckable, which is what stations did before this
  // existed, so nothing changes until someone unchecks something here.
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    queryScoped<{ slot: string; label: string; type: string; duckable: number }>(
      "SELECT slot, label, type, COALESCE(duckable,1) AS duckable FROM deck_configs " +
      "WHERE enabled = 1 AND deleted_at IS NULL ORDER BY slot",
      [], stationId
    ).then(rows => {
      if (stop) return;
      setDecks(rows.map(r => ({ slot: r.slot, label: r.label, type: r.type, duckable: r.duckable === 1 })));
    }).catch(() => { /* the panel's own error line covers a failed read */ });
    return () => { stop = true; };
  }, [stationId]);

  const toggleDuckable = async (slot: string, next: boolean) => {
    setDecks(ds => ds.map(d => (d.slot === slot ? { ...d, duckable: next } : d)));
    if (stationId == null) return;
    // ONE path for every fader (2026-10-11, faders are generic): main saves the fader's "ducked by others" and sends it
    // (queued if the engine cannot take it yet) — the same setting the strip's DUCKED button shows.
    try {
      const r = await (window as any).ether?.invoke?.("board:set-routing", stationId, slot, { duckable: next });
      if (!r || r.ok !== true) console.error("[Ducker] ducked-by-others not saved:", r && r.reason);
    } catch (e) { console.error("[Ducker] ducked-by-others not sent:", e); }
  };

  // Load this station's stored values. Absent keys fall back to the engine's own defaults, so a
  // station that has never been tuned shows exactly what it is actually doing.
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    (async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = r?.ok ? r.rows : [];
        const get = (k: string) => {
          const v = rows.find(x => x.key === k)?.value;
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : null;
        };
        if (stop) return;
        const vals = Object.fromEntries((Object.keys(KV) as (keyof Params)[]).map(k => [k, get(KV[k])])) as Record<keyof Params, number | null>;
        const miss = (Object.keys(KV) as (keyof Params)[]).filter(k => vals[k] == null).map(k => KV[k]);
        setMissing(miss);
        setP(miss.length ? null : (vals as Params));
        setLoaded(true);
        // READ ONLY (Jeff, 2026-10-12): the engine restores the saved ducker itself (audiod/board-state.js DUCK_KEYS,
        // the same defaults as above). This used to re-send it every time the panel opened.
      } catch { if (!stop) setLoaded(true); }
    })();
    return () => { stop = true; };
  }, [stationId]);

  const push = (v: Params | null) => {
    if (!v) return;
    if (stationId == null) return;
    try { (window as any).ether?.audio?.setDuckParams?.(stationId, v); } catch { /* engine not up */ }
  };

  /** Live to the engine while dragging — this is a by-ear control. */
  const change = (k: keyof Params) => (n: number) => {
    if (!pRef.current) return;
    const next = { ...pRef.current, [k]: n };
    setP(next);
    push(next);
  };

  /** To the database on release, so it survives a restart. */
  const commit = () => {
    if (stationId == null) return;
    const v = pRef.current;
    if (!v) return;
    const kv = (window as any).ether?.stationConfigKv;
    if (!kv?.upsertByKey) return;
    (Object.keys(KV) as (keyof Params)[]).forEach(k => {
      try { kv.upsertByKey(stationId, KV[k], String(v[k])); } catch { /* surfaced by the panel */ }
    });
  };

  // Writes the STARTING values into this station's Preferences (they come from main; this panel has no copy).
  const reset = () => { if (!start) return; setP(start); pRef.current = start; push(start); setMissing([]); setTimeout(commit, 0); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "0 0 6px", lineHeight: 1.4 }}>
        When a SOURCE channel with <strong>DUCK ON</strong> has audio, this station's programme drops
        underneath it and rises back when the channel goes quiet. Nothing stops and nothing restarts —
        the song keeps playing under the source and comes back mid-song.
        {" "}These settings are for <strong>{stationName || "this station"}</strong> only.
      </p>

      {p == null && loaded && (
        <div style={{ padding: "8px 10px", margin: "4px 0", border: "1px solid var(--accent-amber, #f59e0b)", color: "var(--text-primary)", fontSize: 12, lineHeight: 1.4 }}>
          This station's Preferences have no ducker settings yet ({missing.join(", ")}), so the music is not ducked.
          {" "}<button onClick={reset} disabled={!start} style={{ marginLeft: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>Use the starting values</button>
        </div>
      )}
      {p != null && (<>
      {/* DEPTH READS AS AN AMOUNT OF DUCKING, NOT A NEGATIVE GAIN.
          It was min=-40 max=0, so dragging to "max" gave 0 dB — NO ducking. Jeff maxed it, landed on
          -2 dB, and reported the duck had got weaker; the engine was obeying perfectly. A control
          whose maximum delivers the least of what it is named for is the same defect as the inverted
          ON button earlier in this slice.
          The slider now moves the way the ear expects — right is deeper — and says "28 dB down".
          The stored value stays negative, because that is what the engine's gain maths wants. */}
      <Row label="Depth" unit=" dB down" value={-p.depthDb} min={0} max={40} step={1}
           hint="How far the programme drops under a source. Right is deeper. A short announcement sits fine around 12 dB; a continuous source needs much more or the two clash."
           onChange={v => change("depthDb")(-v)} onCommit={commit} />

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

      </>)}
      {/* ── Which decks step back ──────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14, borderTop: "1px solid var(--border-primary)", paddingTop: 10 }}>
        <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600, marginBottom: 2 }}>
          Which decks step back
        </div>
        <p style={{ fontSize: 10, color: "var(--text-tertiary)", margin: "0 0 8px", lineHeight: 1.4 }}>
          Ticked decks duck when a source plays. Unticked decks <strong>punch through</strong> at full
          level — uncheck CART if you want stingers and drops to cut over a jock on the mic.
          Source channels are never ducked: they are the thing doing the ducking.
        </p>

        {decks.length === 0 && (
          <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>No decks enabled on this station.</span>
        )}

        {decks.map(d => {
          // FADERS ARE GENERIC (Jeff, 2026-10-11): every fader shows and sets its own "ducked by others" — no fader is
          // excluded by what kind of channel it is.
          return (
            <label
              key={d.slot}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={d.duckable}
                onChange={e => toggleDuckable(d.slot, e.target.checked)}
              />
              <span style={{ fontSize: 12, color: "var(--text-primary)", minWidth: 34 }}>{d.slot}</span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{d.label}</span>
            </label>
          );
        })}
      </div>

      <button
        onClick={reset}
        style={{
          alignSelf: "flex-start", marginTop: 8, padding: "4px 10px", fontSize: 11,
          background: "var(--bg-tertiary)", color: "var(--text-secondary)",
          border: "1px solid var(--border-primary)", borderRadius: 3, cursor: "pointer",
        }}
      >Reset to the starting values</button>
      <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.4 }}>
        Starting values (what a new station gets, written into its Preferences once):{" "}
        {start ? `${-start.depthDb} dB down · hold ${start.holdMs} ms · release ${start.releaseMs} ms · attack ${start.attackMs} ms · threshold ${start.thresholdDb} dBFS` : "—"}.
        {" "}The engine uses only the values above — it has none of its own.
      </span>

      {!loaded && (
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
          Reading this station's settings…
        </span>
      )}
    </div>
  );
}
