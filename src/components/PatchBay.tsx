// src/components/PatchBay.tsx — THE PATCH BAY: outputs (step 1 of docs/ether-audio-patch-bay-plan.md) and, under each
// station's outputs, its inputs (step 2, src/components/PatchBayInputs.tsx).
//
// The ONE place this computer's audio outputs are patched (Jeff's Outputs answers, docs/outputs-section-plan-2026-10-27.md):
//   rows    = Ether's outputs, per station: Master (the existing main/monitor output, after the MONITOR fader), Cue (PFL),
//             Aux;
//   columns = every output channel pair on every device on this computer (a stereo device = one column "1-2"; an
//             8-channel interface = 1-2, 3-4, 5-6, 7-8);
//   a click on a crosspoint connects it; a row may connect to up to 4 devices at once.
// Each connected crosspoint shows what the ENGINE has open (audio_output_patch_state), naming the device — live, opening,
// missing, failed, stalled. No silent fallback: a missing device is said, in red, by name. Saved per computer
// (station_config_kv `patch_outputs`, machine-local). Levels and mutes stay on the board; nothing about the board changes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { query } from "../db/client";
import PatchBayInputs from "./PatchBayInputs";

type Dest = { device: string; pair: number };
type Patch = { master: Dest[]; aux: Dest[]; cue: Dest[]; stall_switch: boolean | null };
type Row = "master" | "cue" | "aux";
type DevInfo = { name: string; channels: number; rate: number; is_default?: boolean };
type DestState = { requested: string; pair: number; state: string; opened: string; opened_pair: number; channels: number; rate: number; stalls: number };
type RowState = { master: DestState[]; aux: DestState[]; cue: DestState[]; soft_clock: boolean };

const MAX_DESTS = 4;   // native/src/patch.rs MAX_DESTS
const ROWS: { key: Row; label: string; what: string }[] = [
  { key: "master", label: "Master", what: "The station's local output, after the MONITOR fader. Nothing patched = the Windows default." },
  { key: "cue", label: "Cue (PFL)", what: "Where PFL plays. Nothing patched = PFL plays over Master." },
  { key: "aux", label: "Aux", what: "The aux monitor bus. Nothing patched = the aux is silent." },
];
const pairLabel = (p: number) => `${p + 1}-${p + 2}`;
const same = (a: Dest, b: Dest) => a.device === b.device && a.pair === b.pair;
type Col = { device: string; pair: number; channels: number; present: boolean; isDefault: boolean };

function words(st: DestState | undefined, d: Dest, row: Row, softClock: boolean): { text: string; bad: boolean } {
  const name = `${d.device} ${pairLabel(d.pair)}`;
  if (!st) return { text: `${name}: waiting for the engine`, bad: false };
  switch (st.state) {
    case "open": return { text: `Live: ${st.opened || d.device} ch ${pairLabel(st.opened_pair)} (${st.rate} Hz, ${st.channels} ch)${st.stalls ? `. It has stalled ${st.stalls} time(s) since Ether started; each time the same device was reopened` : ""}`, bad: false };
    case "opening": return { text: `Opening ${name}…`, bad: false };
    case "not_found": return { text: `MISSING: ${d.device} is not connected to this computer. Nothing else plays in its place.${row === "master" && softClock ? " The stream keeps going." : ""}`, bad: true };
    case "stalled": return { text: `STALLED: ${d.device} keeps stopping. Retrying the same device.`, bad: true };
    case "failed": return { text: `FAILED: ${d.device} would not open ch ${pairLabel(d.pair)}${st.channels ? "" : ""}. Retrying.`, bad: true };
    default: return { text: `${name}: ${st.state}`, bad: false };
  }
}

export default function PatchBay() {
  const ether = (window as any).ether;
  const [stations, setStations] = useState<{ id: number; name: string }[]>([]);
  const [devices, setDevices] = useState<DevInfo[] | null>(null);
  const [patches, setPatches] = useState<Record<number, Patch>>({});
  const [states, setStates] = useState<Record<number, RowState | null>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try { setStations(await query<{ id: number; name: string }>("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id", [])); }
      catch { setStations([]); }
    })();
  }, []);

  const loadDevices = useCallback(async () => {
    try { const d = await ether?.patchBay?.devices?.(); setDevices(Array.isArray(d) ? d : []); } catch { setDevices([]); }
  }, [ether]);
  useEffect(() => { void loadDevices(); }, [loadDevices]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const next: Record<number, Patch> = {};
      for (const s of stations) {
        try { const r = await ether?.patchBay?.get?.(s.id); if (r && r.ok) next[s.id] = r.patch; } catch { /* shown as not loaded */ }
      }
      if (alive) setPatches(next);
    })();
    return () => { alive = false; };
  }, [stations, ether]);

  // What the engine actually has open — polled, never assumed from the click.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const next: Record<number, RowState | null> = {};
      for (const s of stations) { try { next[s.id] = await ether?.patchBay?.state?.(s.id); } catch { next[s.id] = null; } }
      if (alive) setStates(next);
    };
    void poll();
    const id = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [stations, ether]);

  // Columns: every channel pair of every device here, plus any patched device that is NOT here (so it can be seen and
  // unpatched — never hidden).
  const cols = useMemo<Col[]>(() => {
    const out: Col[] = [];
    for (const d of devices || []) {
      const n = Math.max(1, d.channels || 2);
      for (let p = 0; p < Math.max(1, Math.floor(n / 2)) * 2; p += 2) out.push({ device: d.name, pair: p, channels: n, present: true, isDefault: !!d.is_default });
    }
    for (const p of Object.values(patches)) for (const r of ["master", "aux", "cue"] as Row[]) for (const d of p[r] || []) {
      if (!out.some(c => c.device === d.device && c.pair === d.pair)) out.push({ device: d.device, pair: d.pair, channels: 0, present: false, isDefault: false });
    }
    return out;
  }, [devices, patches]);

  const save = useCallback(async (sid: number, next: Patch) => {
    setBusy(true); setErr(null);
    try {
      const r = await ether?.patchBay?.set?.(sid, next);
      if (r && r.ok) setPatches(prev => ({ ...prev, [sid]: r.patch }));
      else setErr(`Not changed: ${(r && r.reason) || "no answer from Ether"}`);
    } catch (e: any) { setErr(`Not changed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [ether]);

  const toggle = (sid: number, row: Row, col: Col) => {
    const p = patches[sid]; if (!p) return;
    const d: Dest = { device: col.device, pair: col.pair };
    const list = p[row] || [];
    if (list.some(x => same(x, d))) { void save(sid, { ...p, [row]: list.filter(x => !same(x, d)) }); return; }
    if (list.length >= MAX_DESTS) { setErr(`${ROWS.find(r => r.key === row)!.label} already plays to ${MAX_DESTS} devices. Disconnect one first.`); return; }
    void save(sid, { ...p, [row]: [...list, d] });
  };

  const cellStyle: React.CSSProperties = { width: 34, height: 30, border: "1px solid var(--border-primary)", textAlign: "center", cursor: busy ? "wait" : "pointer", padding: 0 };
  const deviceGroups = useMemo(() => {
    const g: { device: string; span: number; present: boolean; isDefault: boolean }[] = [];
    for (const c of cols) { const last = g[g.length - 1]; if (last && last.device === c.device) last.span++; else g.push({ device: c.device, span: 1, present: c.present, isDefault: c.isDefault }); }
    return g;
  }, [cols]);

  return (
    <div style={{ padding: 16, color: "var(--text-primary)", fontSize: 13, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Patch Bay</h2>
        <button onClick={() => void loadDevices()} style={{ fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>Refresh output devices</button>
      </div>
      <div style={{ color: "var(--text-tertiary)", marginBottom: 12, lineHeight: 1.5 }}>
        <b>Outputs:</b> click a square to connect an output to a device's channels. Click again to disconnect. One output can play to up to {MAX_DESTS} devices
        at once. <b>Inputs:</b> click a square to bring an input, a Park mic or the Remote Link feed in on a source fader; the fader's SOURCE
        on the board changes with it. Saved for this computer only. Levels and mutes stay on the board. The stream to listeners never depends on these devices.
      </div>
      {err && <div style={{ color: "var(--accent-red, #ef4444)", fontWeight: 700, marginBottom: 10 }}>{err}</div>}
      {devices && devices.length === 0 && <div style={{ color: "var(--accent-red, #ef4444)", marginBottom: 10 }}>The audio engine listed no output devices. If Ether just updated, fully close and reopen it.</div>}

      {stations.map(s => {
        const p = patches[s.id];
        const st = states[s.id];
        return (
          <div key={s.id} style={{ marginBottom: 22 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>{s.name}</div>
            {!p ? <div style={{ color: "var(--text-tertiary)" }}>Loading…</div> : (
              <>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Outputs</div>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th />
                      {deviceGroups.map(g => (
                        <th key={g.device} colSpan={g.span} style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", maxWidth: 34 * g.span + 40, color: g.present ? "var(--text-secondary)" : "var(--accent-red, #ef4444)", borderBottom: "1px solid var(--border-primary)" }} title={g.device}>
                          {g.device}{g.isDefault ? " (Windows default)" : ""}{g.present ? "" : " (NOT CONNECTED)"}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      <th />
                      {cols.map(c => <th key={c.device + c.pair} style={{ fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)" }}>{pairLabel(c.pair)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map(r => (
                      <tr key={r.key}>
                        <td style={{ paddingRight: 10, fontWeight: 700, whiteSpace: "nowrap" }} title={r.what}>{r.label}</td>
                        {cols.map(c => {
                          const on = (p[r.key] || []).some(x => same(x, { device: c.device, pair: c.pair }));
                          const ds = on && st ? (st[r.key] || []).find(x => x.requested === c.device && x.pair === c.pair) : undefined;
                          const bad = on && ds && ds.state !== "open" && ds.state !== "opening";
                          return (
                            <td key={c.device + c.pair} style={{ ...cellStyle, background: on ? (bad ? "var(--accent-red, #ef4444)" : "var(--accent-teal, #14b8a6)") : "transparent" }}
                                onClick={() => !busy && toggle(s.id, r.key, c)}
                                title={on ? words(ds, { device: c.device, pair: c.pair }, r.key, !!st?.soft_clock).text : `Connect ${r.label} to ${c.device} ch ${pairLabel(c.pair)}`}>
                              {on ? (bad ? "!" : "●") : ""}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                  {ROWS.map(r => {
                    const list = p[r.key] || [];
                    if (r.key === "master" && list.length === 0) {
                      const m = st?.master?.[0];
                      return <div key={r.key} style={{ color: m?.state === "open" ? "var(--text-secondary)" : "var(--accent-red, #ef4444)" }}>
                        ● Master: nothing patched, so it plays on the Windows default{m?.state === "open" ? `: ${m.opened} ch ${pairLabel(m.opened_pair)}` : `. ${m ? m.state.replace("_", " ") : "waiting for the engine"}`}
                      </div>;
                    }
                    if (list.length === 0) return <div key={r.key} style={{ color: "var(--text-tertiary)" }}>● {r.label}: {r.key === "cue" ? "nothing patched, so PFL plays over Master" : "nothing patched, so the aux is silent"}</div>;
                    return list.map(d => {
                      const ds = st ? (st[r.key] || []).find(x => x.requested === d.device && x.pair === d.pair) : undefined;
                      const w = words(ds, d, r.key, !!st?.soft_clock);
                      return <div key={r.key + d.device + d.pair} style={{ color: w.bad ? "var(--accent-red, #ef4444)" : "var(--text-secondary)", fontWeight: w.bad ? 700 : 400 }}>● {r.label}: {w.text}</div>;
                    });
                  })}
                  {st?.soft_clock && <div style={{ color: "var(--accent-red, #ef4444)", fontWeight: 700 }}>No Master device is open. The station runs on its own clock, so the stream to listeners keeps going.</div>}
                </div>
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700 }}>If the Master device stalls, switch to the Windows default:</span>
                  {([["Not set", null], ["On", true], ["Off", false]] as [string, boolean | null][]).map(([label, v]) => (
                    <button key={label} disabled={busy} onClick={() => void save(s.id, { ...p, stall_switch: v })}
                      style={{ fontSize: 12, padding: "3px 12px", cursor: "pointer", fontWeight: p.stall_switch === v ? 800 : 400,
                               background: p.stall_switch === v ? "var(--accent-teal, #14b8a6)" : "transparent", color: p.stall_switch === v ? "#111" : "var(--text-secondary)",
                               border: "1px solid var(--border-primary)" }}>{label}</button>
                  ))}
                  {p.stall_switch === null && <span style={{ color: "var(--text-tertiary)" }}>Not set: a stalling device is shown in red and retried; Ether never switches on its own.</span>}
                </div>
                <div style={{ marginTop: 14 }}><PatchBayInputs stationId={s.id} /></div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
