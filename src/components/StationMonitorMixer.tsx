import { posToGain, gainToPos, formatDb, faderMarks, MAX_GAIN } from "../lib/faderLaw";
import { useFaderTop } from "../lib/useFaderTop";
// src/components/StationMonitorMixer.tsx
// Per-station LOCAL monitor mixer. Each station is a collapsible strip with its own monitor
// fader (what you HEAR on the local speakers) + output device. The monitor fader drives the
// native per-station monitor gain, which affects ONLY the local output — every station keeps
// broadcasting to Icecast at full air level regardless of where you set these. So you can pull
// the stations you're not running down to 0 and hear only the one you are, in real-time, without
// touching anybody's broadcast. Replaces the old single Audio-Routing dropdown + Current Routing.

//
// THE PARK (Jeff, 2026-10-13, docs/park-sound-urgent-check-2026-10-13.md): the Park page's fader and MUTE are a
// station's strip here. The station on screen is first and always open, so it is never scrolled out of sight. Each strip
// has a real MUTE (the level is kept; monitor_muted), the last change from anywhere ("Muted from Park page by Ryan,
// 8:42 PM"), and "Park page control: ON/OFF" — OFF locks the Park pages' fader, MUTE, carts and closing time; only
// here turns it back on. A change made elsewhere (a Park page, a Take) shows at once (main's "ops:changed").

import { useState, useEffect, useCallback, useRef } from "react";
import { query } from "../db/client";
import { useStreamStatus } from "../contexts/StreamStatusContext";
import { useActiveStation } from "../hooks/useActiveStation";
import { parseParkSoundLast, parkSoundLine, recordParkSound, type ParkSoundLast } from "../lib/parkSound";

interface Station { id: number; name: string; uuid?: string | null; }
interface ParkState { muted: boolean; locked: boolean; last: ParkSoundLast | null; }

const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", fontSize: 12, padding: "3px 6px", borderRadius: 0,
  cursor: "pointer", outline: "none",
};

export default function StationMonitorMixer() {
  const { dests } = useStreamStatus();
  const monTop = useFaderTop("monitor");   // the MONITOR group's top (Preferences)
  const [stations, setStations] = useState<Station[]>([]);
  const [devices,  setDevices]  = useState<string[]>([]);
  const [vol, setVol] = useState<Record<number, number>>({});
  const [dev, setDev] = useState<Record<number, string>>({});
  const [park, setPark] = useState<Record<number, ParkState>>({});
  const { stationId: activeId } = useActiveStation();
  const levelNote = useRef<Record<number, number>>({});   // a pending "Level set … in Ether" record per station
  const [open, setOpen] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("ether_monitor_open") || "{}"); } catch { return {}; }
  });

  // Load stations + each station's saved monitor level / output device, for DISPLAY. Not re-sent (2026-10-11): the
  // engine restores both itself at its own start (audiod/board-state.js) — this used to push them once per mount and
  // drop a failure, and the device push reopened every station's output on every mount.
  useEffect(() => {
    (async () => {
      const ether = (window as any).ether;
      try {
        const stns: Station[] = await ether.stations.list();
        setStations(stns);
        const v: Record<number, number> = {}, d: Record<number, string> = {};
        await Promise.all(stns.map(async (s) => {
          const rows = await query<{ key: string; value: string }>(
            "SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN ('monitor_volume','audio_output_device') AND deleted_at IS NULL", [s.id]);
          const mv = rows.find(r => r.key === "monitor_volume")?.value;
          const od = rows.find(r => r.key === "audio_output_device")?.value;
          v[s.id] = mv != null && mv !== "" ? Math.max(0, Math.min(MAX_GAIN, parseFloat(mv))) : 1;
          d[s.id] = od ?? "";
        }));
        setVol(v); setDev(d);
        await Promise.all(stns.map(s => readPark(s.id)));
        const devs = await ether.audio.listOutputDevices();
        setDevices(Array.isArray(devs) ? devs : []);
      } catch (e) { console.warn("[StationMonitorMixer] init:", e); }
    })();
  }, []);

  useEffect(() => { try { localStorage.setItem("ether_monitor_open", JSON.stringify(open)); } catch {} }, [open]);

  // SLICE 7 — a Take sets the station's monitor level in the engine and writes monitor_volume; re-read the stored
  // levels so the knobs show what is running. DISPLAY ONLY: the load above also (re)applies output devices, which a
  // Take must never do, so it is deliberately not re-run.
  useEffect(() => {
    const show = (window as any).ether?.show;
    const h = show?.onApplied?.(async () => {
      try {
        const rows = await query<{ station_id: number; value: string }>(
          "SELECT station_id, value FROM station_config_kv WHERE key='monitor_volume' AND deleted_at IS NULL", []);
        setVol(prev => {
          const next = { ...prev };
          for (const r of rows) { const n = parseFloat(r.value); if (Number.isFinite(n)) next[r.station_id] = Math.max(0, Math.min(MAX_GAIN, n)); }
          return next;
        });
      } catch { /* keep what is shown */ }
    });
    return () => { if (h) show.offApplied?.(h); };
  }, []);

  // One station's strip state as saved: level, MUTE, the studio's lock, and who changed the sound last.
  const readPark = useCallback(async (sid: number) => {
    try {
      const rows = await query<{ key: string; value: string }>(
        "SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN ('monitor_volume','monitor_muted','park_control','park_sound_last') AND deleted_at IS NULL", [sid]);
      const kv = (k: string) => rows.find(r => r.key === k)?.value;
      const mv = parseFloat(kv("monitor_volume") ?? "");
      if (Number.isFinite(mv)) setVol(prev => ({ ...prev, [sid]: Math.max(0, Math.min(MAX_GAIN, mv)) }));
      setPark(prev => ({ ...prev, [sid]: { muted: kv("monitor_muted") === "1", locked: kv("park_control") === "off", last: parseParkSoundLast(kv("park_sound_last")) } }));
    } catch { /* keep what is shown */ }
  }, []);
  // A change from anywhere else (a Park page, a Take, Preferences) — main announces it by station UUID.
  useEffect(() => {
    const ether = (window as any).ether;
    const h = ether?.on?.("ops:changed", (p: any) => {
      const st = stations.find(s => s.uuid && s.uuid === p?.stationUuid);
      if (st) void readPark(st.id);
    });
    return () => { try { if (h) ether?.off?.("ops:changed", h); } catch { /* ignore */ } };
  }, [stations, readPark]);

  const setMuted = useCallback(async (sid: number, muted: boolean) => {
    setPark(prev => ({ ...prev, [sid]: { ...(prev[sid] ?? { locked: false, last: null }), muted } }));
    const r: any = await (window as any).ether?.audio?.setMonitorMute?.(sid, muted);
    if (!r?.ok) { console.warn(`[monitor-mixer] MUTE not applied for station ${sid}:`, r?.reason); void readPark(sid); return; }
    await recordParkSound(sid, { what: muted ? "muted" : "unmuted", via: "ether" });
    void readPark(sid);
  }, [readPark]);
  const setLocked = useCallback(async (sid: number, locked: boolean) => {
    setPark(prev => ({ ...prev, [sid]: { ...(prev[sid] ?? { muted: false, last: null }), locked } }));
    await (window as any).ether?.stationConfigKv?.upsertByKey?.(sid, "park_control", locked ? "off" : "on");
    void readPark(sid);
  }, [readPark]);

  const setMonitor = useCallback((sid: number, value: number) => {
    setVol(prev => ({ ...prev, [sid]: value }));
    // The operator's change: to the engine, then saved. Nothing re-sends it on attach any more (2026-10-12) — the engine
    // restores monitor_volume itself (audiod/board-state.js).
    (window as any).ether?.audio?.setMonitorVolume?.(sid, value);
    (window as any).ether?.stationConfigKv?.upsertByKey?.(sid, "monitor_volume", String(value));
    // Who and when: one record once the fader stops moving, not one per step of a drag.
    window.clearTimeout(levelNote.current[sid]);
    levelNote.current[sid] = window.setTimeout(() => { void recordParkSound(sid, { what: "level", level: value, via: "ether" }).then(() => readPark(sid)); }, 700);
  }, [readPark]);

  const setDevice = useCallback((sid: number, device: string) => {
    setDev(prev => ({ ...prev, [sid]: device }));
    (window as any).ether?.audio?.setOutputDevice?.(sid, device);
    // Machine-local (LOCAL_ONLY_KEYS, 2026-09-26) — set-local is its only writer; upsertByKey would skip it.
    Promise.resolve((window as any).ether?.invoke?.("station_config_kv:set-local", sid, "audio_output_device", device))
      .then((w: any) => { if (!w || w.ok !== true) console.warn(`[monitor-mixer] output device for station ${sid} not saved:`, w && w.error); })
      .catch((e: any) => console.warn("[monitor-mixer] output device not saved:", e));
  }, []);

  return (
    <div style={{ borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
      <div style={{ padding: "5px 10px", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" }}>Station Monitors</span>
      </div>

      {stations.length === 0 ? (
        <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No stations</div>
      ) : [...stations].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId)).map((s) => {
        // The station on screen is first and always open — its strip is the Park page's fader, never scrolled away.
        const isActive = s.id === activeId;
        const isOpen = isActive || open[s.id] !== false; // default expanded
        const v = vol[s.id] ?? 1;
        const live = dests[`icecast:${s.id}`]?.state === "live";
        const ps = park[s.id];
        const muted = !!ps?.muted;
        const line = parkSoundLine(ps?.last ?? null);
        return (
          <div key={s.id} style={{ borderBottom: "1px solid var(--border-primary)" }}>
            {/* Strip header — name + on-air dot + collapse chevron */}
            <div
              onClick={() => { if (!isActive) setOpen(o => ({ ...o, [s.id]: !isOpen })); }}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", cursor: "pointer", userSelect: "none" }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                style={{ color: "var(--text-secondary)", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: live ? "var(--status-live, #ef4444)" : "var(--status-offline, #555)",
                boxShadow: live ? "0 0 6px var(--status-live, #ef4444)" : "none" }} title={live ? "ON AIR" : "off air"} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
              <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: muted ? "var(--text-tertiary)" : "var(--accent-teal)" }}>
                {Math.round(v * 100)}
              </span>
              {/* The strip's real MUTE: the level stays where it is; MUTED here or on any Park page brings it back. */}
              <button
                onClick={e => { e.stopPropagation(); void setMuted(s.id, !muted); }}
                aria-pressed={muted}
                title={muted ? "Muted — press to bring the sound back at its level" : "Mute this station's speakers (the level is kept)"}
                style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", padding: "2px 8px", cursor: "pointer", borderRadius: 0,
                  background: muted ? "#7f1d1d" : "var(--bg-tertiary)", border: `1px solid ${muted ? "var(--status-live, #ef4444)" : "var(--border-primary)"}`,
                  color: muted ? "#fff" : "var(--text-secondary)" }}>
                {muted ? "MUTED" : "MUTE"}
              </button>
            </div>

            {isOpen && (
              <div style={{ padding: "0 12px 9px", display: "flex", flexDirection: "column", gap: 7 }}>
                {/* Monitor fader (local speakers only) */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", width: 52, flexShrink: 0 }}>Monitor</span>
                  {/* THE ONE CONSOLE LAW (src/lib/faderLaw.ts): the slider is TRAVEL, the stored level is GAIN */}
                  <input
                    type="range" min={0} max={1} step={0.001} value={gainToPos(v, monTop)} list="ether-fader-law-monitor"
                    onChange={e => setMonitor(s.id, posToGain(parseFloat(e.target.value), monTop))}
                    style={{ flex: 1, accentColor: "var(--accent-teal)", cursor: "pointer", opacity: muted ? 0.45 : 1 }}
                    title="Local speaker level for this station — does NOT affect its broadcast"
                  />
                  <datalist id="ether-fader-law-monitor">{faderMarks(monTop).map(m => <option key={m.label} value={m.pos} label={m.label} />)}</datalist>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 54, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatDb(v)}</span>
                </div>
                {/* Who changed the sound last, and when — the same line the Park page shows. */}
                {line && (
                  <div style={{ fontSize: 10.5, color: "var(--text-primary)", background: "var(--bg-tertiary)", borderLeft: "2px solid #8868D8", padding: "3px 7px" }}>{line}</div>
                )}
                {/* THE STUDIO'S LOCK: OFF locks every Park page's fader, MUTE, carts and closing time. Only here turns it back on. */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.06em", color: "var(--text-secondary)", textTransform: "uppercase" }}>Park page control</span>
                  <span style={{ display: "inline-flex", border: "1px solid var(--border-primary)" }}>
                    {(["on", "off"] as const).map(k => {
                      const sel = (k === "off") === !!ps?.locked;
                      return (
                        <button key={k} onClick={() => void setLocked(s.id, k === "off")} aria-pressed={sel}
                          title={k === "off" ? "Lock the Park pages: fader, MUTE, carts and closing time (Listen still works)" : "Let logged-in staff control the park from the Park page"}
                          style={{ fontSize: 10, fontWeight: 700, padding: "2px 9px", cursor: "pointer", border: "none", borderRadius: 0,
                            background: sel ? (k === "on" ? "var(--accent-teal)" : "#f59e0b") : "transparent",
                            color: sel ? "#111" : "var(--text-tertiary)" }}>
                          {k.toUpperCase()}
                        </button>
                      );
                    })}
                  </span>
                </div>
                {/* Output device */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", width: 52, flexShrink: 0 }}>Output</span>
                  <select value={dev[s.id] ?? ""} onChange={e => setDevice(s.id, e.target.value)} style={selectStyle}>
                    <option value="">System Default</option>
                    {devices.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div style={{ padding: "5px 12px 7px", fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic", lineHeight: 1.5 }}>
        Monitor levels are what you hear locally — broadcasts are unaffected.
      </div>
    </div>
  );
}
