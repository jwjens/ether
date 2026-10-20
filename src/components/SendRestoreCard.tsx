// SendRestoreCard — "Send this restore to every machine" (Jeff, 2026-10-20: "After a restore, give me an admin action
// 'Send this restore to every machine' (with a confirm) that makes the restored data replace the mistake on every
// computer. Without that action, use (a)."). Shown in Preferences → Keep my stuff synced while a restore has not been
// sent. Main does the work and checks the admin PIN (electron/main.js sync:send-restore; electron/sync/restore-sync.js).
import { useEffect, useState } from "react";

export default function SendRestoreCard() {
  const [info, setInfo] = useState<any>(null);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const read = () => (window as any).ether?.invoke?.("sync:restore-point").then((r: any) => setInfo(r && r.ok ? r : null)).catch(() => setInfo(null));
  useEffect(() => { read(); const t = setInterval(read, 15_000); return () => clearInterval(t); }, []);
  if (!info || !info.point || info.point.sent || !info.point.rows) return msg ? <div style={{ fontSize: 12.5, marginBottom: 14, color: "var(--accent-green)" }}>{msg}</div> : null;

  const p = info.point, pv = info.preview || { putBack: 0, remove: 0 };
  const when = p.at ? new Date(p.at).toLocaleString() : "";
  const send = async () => {
    if (info.syncOn) { setMsg("Switch sync off first (the switch above), then send the restore."); return; }
    if (!/^\d{4}$/.test(pin)) { setMsg("Enter your 4-digit admin PIN."); return; }
    if (!confirm(`Send this restore to every computer?\n\nRestored: ${p.backup || "a backup"} (${when}).\n` +
                 `${pv.putBack} row(s) go back to the backup's version on every computer; ${pv.remove} row(s) this computer created since the backup are removed everywhere.\n\n` +
                 `Other computers' changes are kept, unless they changed one of these same rows — then the backup's version wins.`)) return;
    setBusy(true); setMsg("");
    try {
      const r = await (window as any).ether.invoke("sync:send-restore", pin);
      if (r && r.ok) { setMsg(`✓ Sent by ${r.by}: ${r.putBack} row(s) put back, ${r.removed} removed. Switch sync back on to send it and catch up.`); setPin(""); read(); }
      else setMsg(`✗ ${(r && r.error) || "not sent"}`);
    } catch (e: any) { setMsg(`✗ ${e?.message || String(e)}`); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ border: "1px solid var(--accent-amber)", background: "var(--bg-secondary)", padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>This computer was restored from a backup</div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 8 }}>
        {p.backup || "A backup"} · restored {when}. Since that backup, this computer had sent {p.changes} change(s) to {p.rows} row(s) — they are still on the
        other computers. <b>Send this restore</b> puts those rows back to the backup's version everywhere ({pv.putBack} put back, {pv.remove} removed).
        If you don't, switching sync back on brings those changes back here too.
        {info.syncOn && <span style={{ color: "var(--accent-amber)", fontWeight: 700 }}> Sync is on — switch it off first.</span>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as any }}>
        <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} placeholder="Admin PIN"
          style={{ width: 90, padding: "6px 8px", fontSize: 12, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
        <button onClick={send} disabled={busy}
          style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, background: "var(--accent-amber)", color: "#1a1206", border: "none", cursor: busy ? "default" : "pointer" }}>
          {busy ? "Sending…" : "Send this restore to every machine"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{msg}</div>}
    </div>
  );
}
