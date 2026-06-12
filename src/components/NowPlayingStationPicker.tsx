import { useEffect, useState } from "react";

// Small picker shown when the operator opens the Now Playing window on a multi-station
// install: "which station should the screen show?" One station → a single Open button;
// several → click the one you want. onPick gets the chosen station id.
interface Station { id: number; name: string; callsign?: string; is_active: number; }

export default function NowPlayingStationPicker({ onPick, onClose }: {
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const ether = (window as any).ether;
  const [stations, setStations] = useState<Station[] | null>(null);

  useEffect(() => {
    (async () => {
      try { const list = await ether.stations.list(); setStations(Array.isArray(list) ? list : []); }
      catch { setStations([]); }
    })();
  }, []);

  // One station → open it straight away once we know there's only one (still inside a modal so
  // the click is intentional). We render the single-station confirm rather than auto-firing.
  const single = stations && stations.length === 1 ? stations[0] : null;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ width: 380, maxHeight: "70vh", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", boxShadow: "0 30px 80px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Now Playing — Choose Station</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: 14, overflowY: "auto" }}>
          {stations === null ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading stations…</div>
          ) : stations.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>No stations.</div>
          ) : single ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Show <strong style={{ color: "var(--text-primary)" }}>{single.name}</strong> on the Now Playing screen?
              </div>
              <button
                onClick={() => onPick(single.id)}
                style={{ padding: "10px 0", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}
              >
                OK — Open Now Playing
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {stations.map(s => (
                <button
                  key={s.id}
                  onClick={() => onPick(s.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", cursor: "pointer", textAlign: "left" as const }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; }}
                >
                  {!!s.is_active && <span style={{ fontSize: 9, color: "#22c55e" }}>●</span>}
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                  {s.callsign && <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{s.callsign}</span>}
                  <span style={{ color: "var(--text-tertiary)" }}>›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
