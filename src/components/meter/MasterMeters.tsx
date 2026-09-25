// ── MasterMeters — the master's pinned meter column + the Wild Meter (Slice 2, docs/dsp-meter-bus.md §3) ──
//
// PGM / LOCAL / STREAM / MONITOR, all POST-fader (ruling 3), each L/R. The Wild Meter is the same component
// with a selector over the 12 channel taps (pre-fader) and the 6 bus taps — spec §5, "a Wild Meter on the
// master for spot-checking any source". The selector only chooses which tap is drawn; no engine work.
import React, { useState } from "react";
import PeakAvgMeter, { type MeterSource } from "./PeakAvgMeter";
import { BUS, CH_INDEX, useMeterSubscription } from "./meterStore";
import { useActiveStation } from "../../hooks/useActiveStation";

const COLUMN: { name: keyof typeof BUS; title: string }[] = [
  { name: "PGM",     title: "PGM — the programme mix after the master fader (what the station is putting out)" },
  { name: "LOCAL",   title: "LOCAL — the local air output (not fed when no local output device is set)" },
  { name: "STREAM",  title: "STREAM — exactly what is sent to the stream encoder" },
  { name: "MONITOR", title: "MONITOR — the studio monitor output, after the monitor fader" },
];

const WILD_CHOICES: { key: string; label: string }[] = [
  ...Object.keys(BUS).map(b => ({ key: `bus:${b}`, label: `${b} (bus, post-fader)` })),
  ...Object.keys(CH_INDEX).map(c => ({ key: `ch:${c}`, label: `${c.length === 1 ? "Deck " + c : c} (channel, pre-fader)` })),
];

function sourceOf(key: string, stationUuid: string | null | undefined): MeterSource {
  const [kind, name] = key.split(":");
  return kind === "bus" ? { stationUuid, bus: (BUS as any)[name] } : { stationUuid, ch: CH_INDEX[name] };
}

/** The whole column. `rail` = the collapsed master rail: PGM only, full height. */
export default function MasterMeters({ rail = false }: { rail?: boolean }) {
  const { stationId, stationUuid, isReady } = useActiveStation();
  useMeterSubscription([isReady ? stationId : null]);
  const [wild, setWild] = useState<string>(() => {
    try { return localStorage.getItem("ether.wildMeter") || "ch:A"; } catch { return "ch:A"; }
  });
  const pickWild = (k: string) => { setWild(k); try { localStorage.setItem("ether.wildMeter", k); } catch { /* per-viewer convenience only */ } };

  if (rail) {
    return <PeakAvgMeter source={{ stationUuid, bus: BUS.PGM }} size="strip" label="PGM" title={COLUMN[0].title} />;
  }
  return (
    <div style={{ display: "flex", gap: 6, height: 130, alignItems: "stretch" }}>
      {COLUMN.map(c => (
        <div key={c.name} style={{ flex: 1, minWidth: 0, display: "flex" }}>
          <PeakAvgMeter source={{ stationUuid, bus: BUS[c.name] }} size="master" label={c.name} title={c.title} />
        </div>
      ))}
      <div style={{ width: 1, background: "var(--border-primary)", margin: "0 2px" }} />
      <div style={{ flex: 1.3, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <PeakAvgMeter source={sourceOf(wild, stationUuid)} size="master" label="WILD"
            title="Wild Meter — spot-check any channel (pre-fader) or bus (post-fader); pick it below" />
        </div>
        <select value={wild} onChange={e => pickWild(e.target.value)} title="Wild Meter source"
          style={{
            width: "100%", fontSize: 9, padding: "1px 2px", background: "var(--bg-tertiary)",
            color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 2,
          }}>
          {WILD_CHOICES.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
      </div>
    </div>
  );
}
