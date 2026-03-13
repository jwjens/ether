const fs = require('fs');

// 1. Add station_config_kv table migration to client.ts
let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('station_config_kv')) {
  client = client.replace(
    'console.log("DB ready");',
    `await d.execute("CREATE TABLE IF NOT EXISTS station_config_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')");
  console.log("DB ready");`
  );
  fs.writeFileSync('src/db/client.ts', client);
  console.log('Added station_config_kv table');
}

// 2. Write NowPlayingSettings.tsx
fs.writeFileSync('src/components/NowPlayingSettings.tsx', `import { useState, useEffect } from "react";
import { query, execute } from "../db/client";

export default function NowPlayingSettings() {
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{key:string,value:string}>("SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled')");
        for (const r of rows) {
          if (r.key === 'ig_handle') setIgHandle(r.value);
          if (r.key === 'ig_enabled') setIgEnabled(r.value === '1');
        }
      } catch {}
    })();
  }, []);

  const save = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_handle', ?)", [igHandle]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_enabled', ?)", [igEnabled ? '1' : '0']);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ padding: "0 0 20px" }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>Now Playing Screen</h3>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 16, border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Instagram Feed</div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Shows in the Now Playing window when no ads are configured. Enter a profile (@handle) or hashtag (#tag).
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={igHandle}
            onChange={e => setIgHandle(e.target.value)}
            placeholder="@opportunityvillage or #ovlasvegas"
            style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div
            onClick={() => setIgEnabled(!igEnabled)}
            style={{
              width: 36, height: 20, borderRadius: 10, cursor: "pointer", transition: "background 0.2s",
              background: igEnabled ? "var(--accent-blue)" : "var(--bg-secondary)",
              border: "1px solid var(--border-primary)", position: "relative"
            }}
          >
            <div style={{
              position: "absolute", top: 2, left: igEnabled ? 18 : 2,
              width: 14, height: 14, borderRadius: 7, background: "#fff", transition: "left 0.2s"
            }} />
          </div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Enable Instagram feed</span>
        </div>

        <button
          onClick={save}
          style={{ padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: saved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", transition: "background 0.3s" }}
        >{saved ? "Saved!" : "Save"}</button>
      </div>
    </div>
  );
}
`);
console.log('NowPlayingSettings.tsx written');
console.log('Done');
