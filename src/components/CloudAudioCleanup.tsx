// CloudAudioCleanup — "Release cloud audio now" (Jeff, 2026-10-20: "Cloud audio cleanup: no computer is picked … make it
// an admin button. Nothing claims it."). Audio of songs deleted long enough ago is removed from the cloud — only after the
// same checks as always (no live song still uses the file, nothing scheduled needs it). Admin PIN, checked in main
// (cleanup:release-cloud-audio → electron/deletion-sweep.js). It never runs on its own.
import { useState } from "react";

export default function CloudAudioCleanup() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const run = async () => {
    if (!/^\d{4}$/.test(pin)) { setMsg("✗ Enter your 4-digit admin PIN."); return; }
    if (!confirm("Release cloud audio now?\n\nAudio files of songs deleted long enough ago are removed from the cloud, after the usual checks " +
                 "(no live song still uses the file, nothing scheduled needs it). This cannot be undone.")) return;
    setBusy(true); setMsg("");
    try {
      const r = await (window as any).ether.invoke("cleanup:release-cloud-audio", pin);
      if (r && r.ok) setMsg(`✓ Done by ${r.by}: ${r.released?.done ?? 0} file(s) released, ${r.released?.error ?? 0} failed, ${r.checked?.permanent_shared ?? 0} kept (still in use).`);
      else setMsg(`✗ ${(r && r.error) || "not run"}`);
      setPin("");
    } catch (e: any) { setMsg(`✗ ${e?.message || String(e)}`); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ padding: "12px 14px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", marginBottom: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)" }}>Cloud audio cleanup</div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 10px", lineHeight: 1.5 }}>
        Removes from the cloud the audio of songs deleted long enough ago — never a file a live song still uses or something
        scheduled needs. It only runs when an admin presses this; no computer does it on its own.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as any }}>
        <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} placeholder="Admin PIN"
          style={{ width: 90, padding: "6px 8px", fontSize: 12, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
        <button onClick={run} disabled={busy}
          style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: busy ? "default" : "pointer" }}>
          {busy ? "Releasing…" : "Release cloud audio now"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{msg}</div>}
    </div>
  );
}
