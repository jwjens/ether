// ActiveStationBadge.tsx — small header pill showing the active station.
//
// Click → opens the Stations manager page so the operator can switch or
// add stations. Shows callsign/freq if set, falls back to the full name.
// Hidden entirely when only one station exists (no point cluttering the
// header for single-station installs).

import { useEffect, useState } from "react";

interface ActiveStation {
  slug: string;
  name: string;
  callsign?: string;
  frequency?: string;
}

export default function ActiveStationBadge({ onClick }: { onClick: () => void }) {
  const ether = (window as any).ether;
  const [station, setStation] = useState<ActiveStation | null>(null);
  const [stationCount, setStationCount] = useState(1);

  useEffect(() => {
    if (!ether?.stations) return;
    ether.stations.getActive?.().then((s: ActiveStation) => setStation(s));
    ether.stations.list?.().then((l: any[]) => setStationCount(Array.isArray(l) ? l.length : 1));
  }, []);

  // Single-station install — show nothing
  if (stationCount <= 1 || !station) return null;

  const label = station.callsign
    ? (station.frequency ? `${station.callsign} · ${station.frequency}` : station.callsign)
    : station.name;

  return (
    <button onClick={onClick} title={`Active station: ${station.name}. Click to switch or manage.`} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700,
      letterSpacing: "0.06em", textTransform: "uppercase",
      background: "rgba(56,189,248,0.12)", color: "#38bdf8",
      border: "1px solid rgba(56,189,248,0.3)",
      cursor: "pointer", flexShrink: 0,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    }}
      onMouseEnter={e => { e.currentTarget.style.background = "rgba(56,189,248,0.2)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "rgba(56,189,248,0.12)"; }}
    >
      <span style={{ fontSize: 8 }}>●</span>
      <span>{label}</span>
    </button>
  );
}
