// SyncOffBadge — "SYNC OFF on this computer", shown everywhere while this computer's sync switch is off (Jeff,
// 2026-10-20: "While off, show it plainly on screen everywhere, never silent."). Mounted in the main header and in every
// pop-out window's title bar (PopoutShell). Reads main's switch (sync:get-switch) and follows its change event
// (sync:switch) — and re-reads every 30 s, so a window that missed the event still tells the truth.
import { useEffect, useState } from "react";

export default function SyncOffBadge({ compact }: { compact?: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.invoke) return;
    let alive = true;
    const read = () => ether.invoke("sync:get-switch").then((r: any) => { if (alive && r && r.ok) setOn(!!r.on); }).catch(() => {});
    read();
    const h = ether.on?.("sync:switch", (p: any) => { if (alive && p) setOn(!!p.on); });
    const t = setInterval(read, 30_000);
    return () => { alive = false; clearInterval(t); try { ether.off?.("sync:switch", h); } catch { /* ignore */ } };
  }, []);
  if (on !== false) return null;
  return (
    <span title="Sync is switched off on this computer: nothing goes out and nothing comes in. Preferences → Keep my stuff synced turns it back on."
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: compact ? "1px 6px" : "3px 9px",
               fontSize: compact ? 9 : 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase",
               color: "#1a1206", background: "var(--accent-amber)", borderRadius: 0, whiteSpace: "nowrap" }}>
      Sync off on this computer
    </span>
  );
}
