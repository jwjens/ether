// LinkRelayApprovals.tsx — "Allow <computer> to feed this station?" (docs/remote-link-relay-plan-2026-10-28.md).
// Jeff, 2026-10-28: "Receiver approves a sender the first time only, then remembers it." A relay session from a computer
// that this station's Link fader does not already take its feed from waits here until someone allows it; allowed once,
// it is remembered for that station (electron/link-relay-client.js). Shown in Settings → Remote Link and on the Health
// Monitor's Remote Link row. Nothing shows when nothing waits.
import { useEffect, useState } from "react";

type Pending = { stationId: number; stationName: string; senderMachine: string; senderName: string };

export default function LinkRelayApprovals() {
  const api = (window as any).ether?.audio;
  const [list, setList] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api?.linkRelayPending?.().then((l: Pending[]) => { if (alive) setList(Array.isArray(l) ? l : []); }).catch(() => {});
    const off = api?.onLinkRelayPending?.((l: Pending[]) => setList(Array.isArray(l) ? l : []));
    return () => { alive = false; try { off?.(); } catch { /* gone */ } };
  }, [api]);
  if (!list.length) return null;
  return (
    <div data-link-relay-approvals="1" style={{ padding: 10, border: "1px solid var(--accent-amber, #f59e0b)", background: "rgb(from var(--accent-amber, #f59e0b) r g b / 0.08)", display: "flex", flexDirection: "column", gap: 6 }}>
      {list.map(p => {
        const k = `${p.stationId}|${p.senderMachine}`;
        return (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
            <span style={{ flex: 1, minWidth: 220 }}><b>{p.senderName}</b> wants to send a feed to <b>{p.stationName}</b>'s Link fader. Allow it? (Asked once; remembered after.)</span>
            <button disabled={busy === k} style={{ padding: "4px 12px", cursor: "pointer", fontWeight: 700 }}
              onClick={async () => { setBusy(k); setMsg(null); const r = await api?.linkRelayApprove?.(p.stationId, p.senderMachine); setBusy(null); if (!r?.ok) setMsg(r?.reason || "Not allowed — try again."); }}>
              {busy === k ? "Allowing…" : "Allow"}
            </button>
          </div>
        );
      })}
      {msg && <div style={{ fontSize: 12, color: "var(--accent-red, #ef4444)" }}>{msg}</div>}
    </div>
  );
}
