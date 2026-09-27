// DesignationBypassBanner — while the designation bypass is ON for any station on this machine, every screen says
// so, naming the machine and the operator who turned it on (audit 20). Read from designation:status (the main
// process's own view), polled every 30 s. Off → renders nothing.
import { useEffect, useState } from "react";

export default function DesignationBypassBanner() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await (window as any).ether?.invoke?.("designation:status"); if (alive && Array.isArray(r)) setRows(r); } catch { /* keep what we have */ }
    };
    void load();
    const t = setInterval(load, 30_000);
    const onChange = () => { void load(); };
    window.addEventListener("ether:designation-changed", onChange);
    return () => { alive = false; clearInterval(t); window.removeEventListener("ether:designation-changed", onChange); };
  }, []);
  const on = rows.filter(r => r && r.state === "bypassed");
  if (!on.length) return null;
  return (
    <div role="alert" style={{ background: "var(--accent-red, #ef4444)", color: "#fff", padding: "6px 14px", fontSize: 13, fontWeight: 700, lineHeight: 1.4 }}>
      {on.map(r => {
        const b = r.bypass || {};
        let since = "";
        try { if (b.at) since = ` since ${new Date(b.at * 1000).toLocaleString()}`; } catch { /* no time */ }
        return (
          <div key={r.stationId}>
            ⚠ DESIGNATION BYPASSED — {r.station}: on {b.machine || "this machine"} by {b.operator || "an unnamed operator"}{since}.
            {" "}Every machine with Keep the log filled ON generates this station. End it: Health Monitor → Designated generator.
          </div>
        );
      })}
    </div>
  );
}
