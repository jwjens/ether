// ParkTalkLine — by a fader whose input is a Park mic (Hold to talk, 2026-10-16; docs/park-mic-build-2026-10-16.md).
//
// Jeff: "STOP in Ether, who/when shown." While someone talks: "Talking now: Ryan (Park page) · 6 s" and STOP, which ends
// the talk at once. Otherwise the last talk: "Last: Ryan, 8:42 PM, 14 s". Read from main (park:talk-state) — observed:
// the live line comes from the daemon's receiver, the last talk from the station's saved record.
import { useCallback, useEffect, useState } from "react";

type TalkMic = { mic: number; name: string; fader: string | null; talking: { by: string | null; since: string; receiving: boolean } | null;
                 last: { by: string | null; at: string; sec: number; how: string } | null };
const HOW: Record<string, string> = { limit: "cut at the limit", lease: "phone gone", locked: "locked by the studio", ether: "stopped in Ether",
                                      "no-audio": "no voice arrived", shutdown: "Ether closed" };

export default function ParkTalkLine({ stationId, mic }: { stationId: number | null; mic: number }) {
  const ether = (window as any).ether;
  const [m, setM] = useState<TalkMic | null>(null);
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (stationId == null) return;
    try { const s = await ether?.invoke?.("park:talk-state", stationId); setM(s?.ok ? (s.mics || []).find((x: TalkMic) => x.mic === mic) || null : null); }
    catch { /* keep the last */ }
  }, [stationId, mic, ether]);
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const h = ether?.on?.("park:talk-status", (p: any) => { if (p && Number(p.mic) === mic) void load(); });
    return () => { try { if (h) ether?.off?.("park:talk-status", h); } catch { /* closing */ } };
  }, [ether, mic, load]);
  useEffect(() => { if (!m?.talking) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [m?.talking]);

  const stop = async () => {
    setErr(null);
    const r = await ether?.invoke?.("park:talk-stop", stationId, mic);
    if (!r?.ok) setErr(r?.error || "not stopped");
    void load();
  };
  if (!m) return null;
  const line = { fontSize: 8, lineHeight: 1.35, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
  if (m.talking) {
    const sec = Math.max(0, Math.round((now - new Date(m.talking.since).getTime()) / 1000));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ ...line, color: m.talking.receiving ? "#4ade80" : "#fbbf24", fontWeight: 700 }}
             title={m.talking.receiving ? "The voice is arriving on this fader" : "Connecting — no voice yet"}>
          ● Talking now: {m.talking.by || "someone"} (Park page) · {sec} s{m.talking.receiving ? "" : " · connecting"}
        </div>
        <button onClick={() => void stop()} aria-label={`Stop the talk on ${m.name}`}
          style={{ height: 20, fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 2,
                   background: "color-mix(in srgb, #ef4444 20%, transparent)", border: "1px solid #ef4444", color: "#ef4444" }}>
          STOP TALK
        </button>
        {err && <div style={{ ...line, color: "#ef4444" }}>⚠ {err}</div>}
      </div>
    );
  }
  if (!m.last) return <div style={line}>{m.name} · nobody has talked yet</div>;
  const t = new Date(m.last.at);
  const how = HOW[m.last.how] ? `, ${HOW[m.last.how]}` : "";
  return <div style={line} title={`${m.name}: the last talk from the Park page`}>Last: {m.last.by || "someone"}, {t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, {Math.round(m.last.sec)} s{how}</div>;
}
