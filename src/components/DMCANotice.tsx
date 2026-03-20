import { useState, useEffect } from "react";
import { queryOne, execute } from "../db/client";

export default function DMCANotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const row = await queryOne<{value: string}>(
          "SELECT value FROM station_config_kv WHERE key='dmca_acknowledged'"
        );
        if (!row) setShow(true);
      } catch { setShow(true); }
    })();
  }, []);

  const acknowledge = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('dmca_acknowledged', '1')", []);
    setShow(false);
  };

  if (!show) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20
    }}>
      <div style={{
        background: "var(--bg-secondary)", borderRadius: 16, padding: 32, maxWidth: 540,
        border: "1px solid var(--border-primary)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)"
      }}>
        <div style={{ marginBottom: 12, display: "flex" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><path d="m9 12 2 2 4-4"/></svg>
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
          Music Licensing Notice
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
          If you broadcast music publicly — over the internet or on-air — you are required by law to obtain performance licenses from the relevant PROs (Performing Rights Organizations).
        </p>
        <div style={{ background: "var(--bg-tertiary)", borderRadius: 10, padding: 14, marginBottom: 16, border: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Required licenses for US broadcasters:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { name: "ASCAP", url: "https://www.ascap.com/music-users/music-license", desc: "American Society of Composers, Authors and Publishers" },
              { name: "BMI", url: "https://www.bmi.com/licensing", desc: "Broadcast Music Inc." },
              { name: "SESAC", url: "https://www.sesac.com/licensing", desc: "Society of European Stage Authors and Composers" },
              { name: "SoundExchange", url: "https://www.soundexchange.com", desc: "Digital performance royalties (internet radio)" },
            ].map(org => (
              <div key={org.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-blue)", width: 100, flexShrink: 0 }}>{org.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{org.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5, marginBottom: 20 }}>
          Ether's play log exports (CSV, BMI, ASCAP formats) in the Logs tab help you file accurate royalty reports. Personal/private use does not require licensing.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={acknowledge} style={{
            flex: 1, padding: "10px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer"
          }}>I Understand</button>
          <a href="https://www.ascap.com/music-users/music-license" target="_blank" rel="noopener noreferrer"
            style={{ padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 400,
              background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)",
              cursor: "pointer", textDecoration: "none" }}>Learn More ↗</a>
        </div>
      </div>
    </div>
  );
}
