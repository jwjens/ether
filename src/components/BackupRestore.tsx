import { useState, useEffect } from "react";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);

export default function BackupRestore() {
  const [backups, setBackups] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const loadBackups = async () => {
    try {
      const list = await invoke<string[]>("list_backups");
      setBackups(list);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadBackups(); }, []);

  const backup = async () => {
    setLoading(true);
    try {
      const path = await invoke<string>("backup_db");
      setStatus("✓ Backup saved");
      loadBackups();
    } catch (e) {
      setStatus("Error: " + String(e));
    }
    setLoading(false);
    setTimeout(() => setStatus(""), 4000);
  };

  const restore = async (name: string) => {
    if (!confirm("Restore from " + name + "? Current data will be replaced. Ether will need to restart.")) return;
    try {
      const msg = await invoke<string>("restore_db", { backupName: name });
      setStatus(msg);
    } catch (e) {
      setStatus("Error: " + String(e));
    }
  };

  const formatBackupName = (name: string) => {
    const ts = name.replace("openair-backup-", "").replace(".db", "");
    const d = new Date(parseInt(ts) * 1000);
    return d.toLocaleString();
  };

  return (
    <div style={{ padding: "0 0 20px" }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>Database Backup</h3>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Backup your entire library, schedule, and settings. Backups older than 7 days are automatically deleted.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={backup} disabled={loading}
            style={{ padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            {loading ? "Backing up..." : "Backup Now"}
          </button>
          {status && <span style={{ fontSize: 12, color: status.startsWith("✓") ? "var(--accent-green)" : "#ef4444" }}>{status}</span>}
        </div>

        {backups.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Saved Backups</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {backups.map(name => (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-secondary)", borderRadius: 0, padding: "8px 12px", border: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{formatBackupName(name)}</span>
                  <button onClick={() => restore(name)}
                    style={{ padding: "4px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {backups.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>No backups yet.</div>
        )}
      </div>
    </div>
  );
}
