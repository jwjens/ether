// src/components/PatchBayInputs.tsx — THE PATCH BAY, INPUTS (step 2 of docs/ether-audio-patch-bay-plan.md), one station.
//
//   rows    = the station's source faders on the board (D, E, F, S1–S5 that are on the board);
//   columns = every input channel of every input device on this computer (Park Mic 1/2 included), then the station's
//             Remote Link feed;
//   a click connects that input to that fader; a click on a connected square disconnects it.
// The grid keeps no record of its own. It reads and writes the same three records as the board's SOURCE dropdown —
// deck_configs.kind, mic_input_<slot>, link_input — through the same writers (src/lib/inputPatch.ts), so the dropdown
// and the grid always say the same thing (Jeff, 2026-10-28). Each connected square shows the ENGINE's state.
// Level, gain, ON and the channel's own controls stay on the board and in Preferences.

import { useCallback, useEffect, useMemo, useState } from "react";
import { query } from "../db/client";
import { useMicInputs, useInputDevices, micStateWords } from "../hooks/useMicInputs";
import { useRemoteLink, rxWords } from "../hooks/useRemoteLink";
import { boardNames } from "../lib/boardName";
import { compareSlots } from "./DeckConfigurator";
import { faderInput, crosspointOn, planConnect, planDisconnect, inputColumns, type GridCol, type StationRecords, type Step } from "../lib/inputPatch";

type Fader = { slot: string; kind: string };
type Row = { slot: string; type: string; enabled: number; kind: string };
const colKey = (c: GridCol) => (c.kind === "link" ? "link" : `${c.device}#${c.channel}`);

export default function PatchBayInputs({ stationId }: { stationId: number }) {
  const ether = (window as any).ether;
  const mic = useMicInputs(stationId);
  const link = useRemoteLink(stationId);
  const { devices, reload } = useInputDevices();
  const [faders, setFaders] = useState<Fader[] | null>(null);
  // The board's own fader names (src/lib/boardName.ts): S1 is "G" on a default board, never "S1".
  const [names, setNames] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The board's source faders, re-read whenever the board changes anywhere (the same broadcast the board listens to).
  useEffect(() => {
    let alive = true;
    query<Row>("SELECT slot, type, enabled, COALESCE(kind,'') AS kind FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL", [stationId])
      .then(rows => {
        if (!alive) return;
        const sorted = [...rows].sort(compareSlots);
        // Every row, enabled or not, names the faders — exactly as the board does (removing one never renames another).
        setNames(boardNames(sorted.map(r => r.slot)));
        setFaders(sorted.filter(r => r.type === "source" && r.enabled === 1).map(r => ({ slot: r.slot, kind: r.kind })));
      })
      .catch(() => { if (alive) { setFaders([]); setNames({}); } });
    return () => { alive = false; };
  }, [stationId, tick]);
  useEffect(() => {
    if (!ether?.deckConfigs?.onChanged) return;
    const h = ether.deckConfigs.onChanged((v: { stationId: number | null }) => { if (!v || v.stationId == null || v.stationId === stationId) setTick(t => t + 1); });
    return () => ether.deckConfigs.offChanged?.(h);
  }, [ether, stationId]);

  const records: StationRecords = useMemo(() => ({
    kinds: Object.fromEntries((faders || []).map(f => [f.slot, f.kind])),
    micPatches: mic.patches,
    linkInputSlot: link.cfg?.input ? link.cfg.input.slot : null,
  }), [faders, mic.patches, link.cfg]);

  const cols = useMemo(() => inputColumns(devices || [], Object.values(mic.patches)), [devices, mic.patches]);
  const groups = useMemo(() => {
    const g: { key: string; label: string; span: number; present: boolean }[] = [];
    for (const c of cols) {
      const key = c.kind === "link" ? "link" : c.device;
      const last = g[g.length - 1];
      if (last && last.key === key) last.span++; else g.push({ key, label: c.label, span: 1, present: c.present });
    }
    return g;
  }, [cols]);

  /** The steps, in order, through the board's own writers. A refused step stops the rest and is said. */
  const run = useCallback(async (steps: Step[]) => {
    setBusy(true); setErr(null);
    try {
      for (const st of steps) {
        let r: { ok: boolean; reason?: string; error?: string } | undefined;
        if (st.op === "mic") r = await mic.setPatch(st.slot, st.patch);
        else if (st.op === "link") {
          if (!link.cfg) { r = { ok: false, reason: "the Remote Link settings are still loading" }; }
          else if (st.slot == null) r = await link.setInput(null);
          else {
            const cur = link.cfg.input, d = link.cfg.defaults;
            // Exactly what the board's dropdown sends when it is set to Link (SourceChannelStrip linkTo).
            r = await link.setInput({ slot: st.slot, jitterMs: cur?.jitterMs ?? d.jitterMs, port: cur?.port ?? d.port,
                                      autoCut: cur?.autoCut ?? link.cfg.autoCutDefault.autoCut, autoCutSec: cur?.autoCutSec ?? link.cfg.autoCutDefault.autoCutSec });
          }
        } else {
          r = await ether?.deckConfigs?.updateBySlot?.(stationId, st.slot, { kind: st.kind });
          if (r && (r as any).ok !== false) r = { ok: true };
        }
        if (!r || r.ok === false) { setErr(`Not changed: ${(r && (r.reason || r.error)) || "no answer from Ether"}`); break; }
      }
    } catch (e: any) { setErr(`Not changed: ${e?.message || e}`); }
    finally { setBusy(false); setTick(t => t + 1); }
  }, [mic, link, ether, stationId]);

  const click = (slot: string, col: GridCol) => {
    if (busy) return;
    const f = faderInput(slot, { kind: records.kinds[slot] || "", micPatch: records.micPatches[slot], linkInputSlot: records.linkInputSlot });
    void run(crosspointOn(f, col) ? planDisconnect(slot, col, records) : planConnect(slot, col, records));
  };

  /** What the engine says about one fader's input, in words (the same words the board's strip uses). */
  const stateOf = (slot: string): { text: string; bad: boolean } => {
    const f = faderInput(slot, { kind: records.kinds[slot] || "", micPatch: records.micPatches[slot], linkInputSlot: records.linkInputSlot });
    switch (f.type) {
      case "mic": { const w = micStateWords(mic.states[slot], true); return { text: `${f.device.startsWith("park:") ? f.device.replace("park:", "Park Mic ") : f.device} input ${f.channel}: ${w.text}`, bad: w.tone === "bad" }; }
      case "mic-unpatched": return { text: "set to Mic on the board, no input connected", bad: true };
      case "link": { const w = rxWords(link.state?.rx ?? null, true, !!link.cfg?.input?.from, link.cfg?.inputRefusal ?? null); return { text: `Remote Link: ${w.text}`, bad: w.tone === "bad" }; }
      case "link-unpatched": return { text: "set to Link on the board, but the Link feed is not on this fader", bad: true };
      case "other": return { text: `a ${f.kind} source (set on the board), no input`, bad: false };
      default: return { text: "no source", bad: false };
    }
  };

  const cell: React.CSSProperties = { width: 34, height: 30, border: "1px solid var(--border-primary)", textAlign: "center", cursor: busy ? "wait" : "pointer", padding: 0 };
  if (faders == null) return <div style={{ color: "var(--text-tertiary)" }}>Loading…</div>;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontWeight: 700 }}>Inputs</span>
        <button onClick={() => void reload()} style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}>Refresh inputs</button>
      </div>
      {err && <div style={{ color: "var(--accent-red, #ef4444)", fontWeight: 700, marginBottom: 6 }}>{err}</div>}
      {faders.length === 0 ? (
        <div style={{ color: "var(--text-tertiary)" }}>This station has no source faders on its board. Add one with + on the board, then connect an input to it here.</div>
      ) : (
        <>
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th />
                {groups.map(g => (
                  <th key={g.key} colSpan={g.span} title={g.label} style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", maxWidth: 34 * g.span + 40, borderBottom: "1px solid var(--border-primary)",
                                                                          color: g.present ? "var(--text-secondary)" : "var(--accent-red, #ef4444)" }}>
                    {g.label}{g.present ? "" : " (NOT CONNECTED)"}
                  </th>
                ))}
              </tr>
              <tr>
                <th />
                {cols.map(c => <th key={colKey(c)} style={{ fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)" }}>{c.kind === "link" ? "feed" : c.channel}</th>)}
              </tr>
            </thead>
            <tbody>
              {faders.map(f => {
                const fi = faderInput(f.slot, { kind: f.kind, micPatch: records.micPatches[f.slot], linkInputSlot: records.linkInputSlot });
                const st = stateOf(f.slot);
                return (
                  <tr key={f.slot}>
                    <td style={{ paddingRight: 10, fontWeight: 700, whiteSpace: "nowrap" }} title="A source fader on the board">Fader {names[f.slot] || f.slot}</td>
                    {cols.map(c => {
                      const on = crosspointOn(fi, c);
                      const bad = on && st.bad;
                      return (
                        <td key={colKey(c)} onClick={() => click(f.slot, c)} style={{ ...cell, background: on ? (bad ? "var(--accent-red, #ef4444)" : "var(--accent-teal, #14b8a6)") : "transparent" }}
                            title={on ? `${st.text}. Click to disconnect.` : c.kind === "link" ? `Bring the Remote Link feed in on fader ${names[f.slot] || f.slot}` : `Connect ${c.label} input ${c.channel} to fader ${names[f.slot] || f.slot}`}>
                          {on ? (bad ? "!" : "●") : ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            {faders.map(f => { const st = stateOf(f.slot); return (
              <div key={f.slot} style={{ color: st.bad ? "var(--accent-red, #ef4444)" : "var(--text-secondary)", fontWeight: st.bad ? 700 : 400 }}>● Fader {names[f.slot] || f.slot}: {st.text}</div>
            ); })}
          </div>
        </>
      )}
    </div>
  );
}
