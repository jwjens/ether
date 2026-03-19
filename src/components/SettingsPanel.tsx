import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { query, execute } from "../db/client";
import { getStationTimezone, setStationTimezone, COMMON_TIMEZONES } from "../utils/timezone";
import { processAllSongs, getProcessingStats } from "../audio/processor";

// ── Shared UI primitives ─────────────────────────────────────

function Section({ icon, title, description, children }: { icon: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border-primary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em", fontFamily: "'Syne', sans-serif" }}>{title}</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{description}</div>
          </div>
        </div>
      </div>
      <div style={{ padding: "16px 20px" }}>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div onClick={() => onChange(!value)} style={{
        width: 40, height: 22, borderRadius: 11, cursor: "pointer",
        background: value ? "var(--accent-blue)" : "var(--bg-tertiary)",
        border: "1px solid " + (value ? "var(--accent-blue)" : "var(--border-secondary)"),
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}>
        <div style={{
          position: "absolute", top: 3, left: value ? 20 : 3,
          width: 14, height: 14, borderRadius: 7, background: "#fff",
          transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </div>
      <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 0", borderBottom: "1px solid var(--border-primary)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function CodeBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-tertiary)", borderRadius: 8, padding: "10px 14px", border: "1px solid var(--border-primary)" }}>
      <span style={{ flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--accent-cyan)", wordBreak: "break-all" as any }}>{value}</span>
      <button onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{ padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", flexShrink: 0 }}>
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}

// ── Main Settings Panel ──────────────────────────────────────

export default function SettingsPanel() {
  // Station
  const [timezone, setTimezone] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [stationName, setStationName] = useState("");
  const [stationNameSaved, setStationNameSaved] = useState(false);

  // Audio devices
  const [devices, setDevices] = useState<{ deviceId: string; label: string; kind: string }[]>([]);
  const [currentOutput, setCurrentOutput] = useState("");
  const [currentInput, setCurrentInput] = useState("");

  // Connections
  const [dashboardUrl, setDashboardUrl] = useState("");

  // Now Playing
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [igSaved, setIgSaved] = useState(false);

  // Backup
  const [backups, setBackups] = useState<string[]>([]);
  const [backupStatus, setBackupStatus] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);

  // Processing
  const [processingStats, setProcessingStats] = useState<any>(null);
  const [processing, setProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState("");
  const [processingDone, setProcessingDone] = useState(0);
  const [processingTotal, setProcessingTotal] = useState(0);

  // Rules
  const [rules, setRules] = useState<any[]>([]);

  const RULE_META: Record<string, { label: string; hint: string }> = {
    artist_separation_min: { label: "Same artist plays again after", hint: "Minutes before you hear the same artist twice" },
    song_separation_min:   { label: "Same song plays again after", hint: "Minutes before the exact same song can repeat" },
    title_separation_min:  { label: "Same title (different artist) after", hint: "Covers or remixes of the same song" },
    max_same_gender:       { label: "Max songs in a row by same gender", hint: "Keeps the mix balanced between male and female artists" },
    max_same_category:     { label: "Max songs in a row from same category", hint: "Prevents playing too many songs from one rotation category" },
  };

  useEffect(() => {
    // Timezone
    getStationTimezone().then(setTimezone);

    // Autostart
    import("@tauri-apps/plugin-autostart").then(({ isEnabled }) => isEnabled().then(setAutostart).catch(() => {})).catch(() => {});

    // Dashboard URL
    invoke<string>("get_local_ip").then(ip => setDashboardUrl("http://" + ip + ":4242")).catch(() => setDashboardUrl("http://localhost:4242"));

    // Instagram settings
    query<{ key: string; value: string }>("SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled','station_name')").then(rows => {
      for (const r of rows) {
        if (r.key === "ig_handle") setIgHandle(r.value);
        if (r.key === "ig_enabled") setIgEnabled(r.value === "1");
        if (r.key === "station_name") setStationName(r.value);
      }
    }).catch(() => {});

    // Backups
    invoke<string[]>("list_backups").then(setBackups).catch(() => {});

    // Processing stats
    getProcessingStats().then(setProcessingStats).catch(() => {});

    // Rules
    query<any>("SELECT * FROM separation_rules ORDER BY id").then(setRules).catch(() => {});

    // Audio devices
    loadDevices();
  }, []);

  const loadDevices = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === "audioinput" || d.kind === "audiooutput").map(d => ({
        deviceId: d.deviceId, label: d.label || "Device " + d.deviceId.substring(0, 8), kind: d.kind,
      })));
    } catch {}
  };

  const saveStationName = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('station_name', ?)", [stationName]).catch(() => {});
    setStationNameSaved(true);
    setTimeout(() => setStationNameSaved(false), 2000);
  };

  const toggleAutostart = async () => {
    try {
      if (autostart) {
        const { disable } = await import("@tauri-apps/plugin-autostart");
        await disable(); setAutostart(false);
      } else {
        const { enable } = await import("@tauri-apps/plugin-autostart");
        await enable(); setAutostart(true);
      }
    } catch {}
  };

  const saveIg = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_handle', ?)", [igHandle]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ig_enabled', ?)", [igEnabled ? "1" : "0"]);
    setIgSaved(true); setTimeout(() => setIgSaved(false), 2000);
  };

  const backup = async () => {
    setBackupLoading(true);
    try {
      await invoke<string>("backup_db");
      setBackupStatus("✓ Backup saved");
      invoke<string[]>("list_backups").then(setBackups).catch(() => {});
    } catch (e) { setBackupStatus("Error: " + String(e)); }
    setBackupLoading(false);
    setTimeout(() => setBackupStatus(""), 4000);
  };

  const restore = async (name: string) => {
    if (!confirm("Restore from " + formatBackupName(name) + "?\n\nYour current library and settings will be replaced. Ether will need to restart.")) return;
    try {
      const msg = await invoke<string>("restore_db", { backupName: name });
      setBackupStatus(msg);
    } catch (e) { setBackupStatus("Error: " + String(e)); }
  };

  const formatBackupName = (name: string) => {
    const ts = name.replace("openair-backup-", "").replace(".db", "");
    return new Date(parseInt(ts) * 1000).toLocaleString();
  };

  const TIME_RULES = ["artist_separation_min", "song_separation_min", "title_separation_min"];

  // Unit state for each time-based rule — stored in minutes in DB, display in hours or minutes
  const [ruleUnits, setRuleUnits] = useState<Record<number, "min" | "hr">>({});

  const getDisplayValue = (rule: any) => {
    const unit = ruleUnits[rule.id] || "min";
    return unit === "hr" ? Math.round(rule.value / 60 * 10) / 10 : rule.value;
  };

  const setDisplayValue = async (rule: any, display: number) => {
    const unit = ruleUnits[rule.id] || "min";
    const minutes = unit === "hr" ? Math.round(display * 60) : display;
    await updateRule(rule.id, "value", minutes);
  };

  const updateRule = async (id: number, field: string, val: number) => {
    await execute("UPDATE separation_rules SET " + field + " = ? WHERE id = ?", [val, id]);
    query<any>("SELECT * FROM separation_rules ORDER BY id").then(setRules);
  };

  const handleProcessAll = async () => {
    setProcessing(true); setProcessingProgress("Starting...");
    const count = await processAllSongs((d, t, title) => {
      setProcessingDone(d); setProcessingTotal(t);
      setProcessingProgress("Analyzing: " + title + " (" + d + "/" + t + ")");
    });
    setProcessingProgress("Done! Analyzed " + count + " songs.");
    setProcessing(false);
    getProcessingStats().then(setProcessingStats);
  };

  const outputs = devices.filter(d => d.kind === "audiooutput");
  const inputs = devices.filter(d => d.kind === "audioinput");

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "4px 0 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 20, fontFamily: "'Syne', sans-serif" }}>Settings</h1>

      {/* ── Station ── */}
      <Section icon="🎙" title="Your Station" description="Basic information about your station">
        <SettingRow label="Station name" hint="Shows in the header and window title">
          <div style={{ display: "flex", gap: 8 }}>
            <input value={stationName} onChange={e => setStationName(e.target.value)}
              placeholder="My Radio Station"
              style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", width: 200, outline: "none" }} />
            <button onClick={saveStationName}
              style={{ padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: stationNameSaved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
              {stationNameSaved ? "Saved!" : "Save"}
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Timezone" hint="Used for scheduling, play logs, and DST handling">
          <select value={timezone} onChange={e => { setTimezone(e.target.value); setStationTimezone(e.target.value); }}
            style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", maxWidth: 280 }}>
            {COMMON_TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
          </select>
        </SettingRow>
        <div style={{ paddingTop: 12 }}>
          <Toggle value={autostart} onChange={toggleAutostart} label="Start Ether automatically when Windows boots" />
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6, marginLeft: 52 }}>Recommended if you run a 24/7 station</div>
        </div>
      </Section>

      {/* ── Audio ── */}
      <Section icon="🔊" title="Audio Devices" description="Choose where music plays and which mic to use for voice tracking">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, minWidth: 0 }}>
          {/* Output */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Where music plays</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Your speakers, headphones, or broadcast console</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {outputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No output devices found</div> :
                outputs.map(d => (
                  <button key={d.deviceId} onClick={() => setCurrentOutput(d.deviceId)} style={{
                    padding: "9px 12px", borderRadius: 8, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                    background: currentOutput === d.deviceId ? "rgba(56,189,248,0.12)" : "var(--bg-tertiary)",
                    border: "1px solid " + (currentOutput === d.deviceId ? "var(--accent-blue)" : "var(--border-primary)"),
                    color: currentOutput === d.deviceId ? "var(--accent-blue)" : "var(--text-secondary)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                    {currentOutput === d.deviceId && <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>ACTIVE</span>}
                  </button>
                ))}
            </div>
          </div>
          {/* Input */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Your microphone</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>For voice tracking and live mic breaks</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {inputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No microphones found</div> :
                inputs.map(d => (
                  <button key={d.deviceId} onClick={() => setCurrentInput(d.deviceId)} style={{
                    padding: "9px 12px", borderRadius: 8, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                    background: currentInput === d.deviceId ? "rgba(52,211,153,0.12)" : "var(--bg-tertiary)",
                    border: "1px solid " + (currentInput === d.deviceId ? "var(--accent-green)" : "var(--border-primary)"),
                    color: currentInput === d.deviceId ? "var(--accent-green)" : "var(--text-secondary)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                    {currentInput === d.deviceId && <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>ACTIVE</span>}
                  </button>
                ))}
            </div>
          </div>
        </div>
        <button onClick={loadDevices} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer" }}>
          ↻ Rescan Devices
        </button>
      </Section>

      {/* ── Music Scheduling Rules ── */}
      <Section icon="🎵" title="Music Scheduling Rules" description="Control how songs are selected — how long before the same artist or song can play again">
        <div style={{ display: "flex", flexDirection: "column" as any }}>
          {rules.map((r, i) => {
            const meta = RULE_META[r.rule_type];
            if (!meta) return null;
            const isLast = i === rules.length - 1;
            return (
              <div key={r.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                padding: "14px 0",
                borderBottom: isLast ? "none" : "1px solid var(--border-primary)",
                opacity: r.is_active ? 1 : 0.45,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{meta.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{meta.hint}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <input type="number" value={getDisplayValue(r)}
                    onChange={e => setDisplayValue(r, parseFloat(e.target.value) || 0)}
                    style={{ width: 60, padding: "5px 8px", borderRadius: 7, fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 500, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", textAlign: "center" as any, outline: "none" }} />
                  {TIME_RULES.includes(r.rule_type) ? (
                    <select
                      value={ruleUnits[r.id] || "min"}
                      onChange={e => setRuleUnits(prev => ({ ...prev, [r.id]: e.target.value as "min" | "hr" }))}
                      style={{ padding: "5px 8px", borderRadius: 7, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}
                    >
                      <option value="min">min</option>
                      <option value="hr">hrs</option>
                    </select>
                  ) : (
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)", width: 42 }}>songs</span>
                  )}
                  <button onClick={() => updateRule(r.id, "is_hard", r.is_hard ? 0 : 1)} style={{
                    padding: "5px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none",
                    background: r.is_hard ? "rgba(248,113,113,0.15)" : "var(--bg-tertiary)",
                    color: r.is_hard ? "var(--accent-red)" : "var(--text-tertiary)",
                  }}>{r.is_hard ? "STRICT" : "SOFT"}</button>
                  <div onClick={() => updateRule(r.id, "is_active", r.is_active ? 0 : 1)} style={{
                    width: 36, height: 20, borderRadius: 10, cursor: "pointer",
                    background: r.is_active ? "var(--accent-green)" : "var(--bg-tertiary)",
                    border: "1px solid " + (r.is_active ? "var(--accent-green)" : "var(--border-secondary)"),
                    position: "relative", transition: "background 0.2s", flexShrink: 0,
                  }}>
                    <div style={{ position: "absolute", top: 3, left: r.is_active ? 18 : 3, width: 12, height: 12, borderRadius: 6, background: "#fff", transition: "left 0.2s" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: 8, fontSize: 11, color: "var(--text-tertiary)" }}>
          <strong style={{ color: "var(--accent-red)" }}>STRICT</strong> — rule is enforced absolutely, no exceptions.&nbsp;&nbsp;
          <strong style={{ color: "var(--text-secondary)" }}>SOFT</strong> — rule is preferred but can be broken if no better option exists.
        </div>
      </Section>

      {/* ── Connections ── */}
      <Section icon="📡" title="Remote Access & Website" description="Control Ether from your phone, or show what's playing on your website">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Mobile remote control</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>Open this on any phone or tablet connected to the same WiFi — no app needed</div>
            {dashboardUrl && <CodeBox value={dashboardUrl} />}
          </div>
          <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Now playing for your website</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>Your website can fetch this URL every 10 seconds to show the current song automatically</div>
            {dashboardUrl && <CodeBox value={dashboardUrl + "/now-playing.json"} />}
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>Returns: song title, artist, whether it's playing, and a timestamp</div>
          </div>
        </div>
      </Section>

      {/* ── Now Playing Screen ── */}
      <Section icon="📺" title="Now Playing Screen" description="Customize what shows on the on-air display window">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Instagram feed</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>Shows recent posts on the Now Playing screen when no ads are running. Enter a profile handle or hashtag.</div>
            <input value={igHandle} onChange={e => setIgHandle(e.target.value)}
              placeholder="@yourstation or #yourhashtag"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", marginBottom: 12, boxSizing: "border-box" as any }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Toggle value={igEnabled} onChange={setIgEnabled} label="Show Instagram feed on screen" />
              <button onClick={saveIg} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: igSaved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
                {igSaved ? "Saved!" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Loudness ── */}
      <Section icon="🎚" title="Loudness Normalization" description="Make every song play at the same volume — no more jarring jumps between quiet and loud tracks">
        {processingStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Analyzed", value: processingStats.processed + " / " + processingStats.total },
              { label: "Average loudness", value: processingStats.avgLufs ? processingStats.avgLufs + " LUFS" : "—" },
              { label: "Still to analyze", value: processingStats.unprocessed, highlight: processingStats.unprocessed > 0 },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "12px 14px", textAlign: "center" as any }}>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: (s as any).highlight ? "var(--accent-amber)" : "var(--text-primary)" }}>{s.value}</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {processingProgress && (
          <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 8, fontSize: 12, color: "var(--accent-blue)", marginBottom: 12 }}>
            {processingProgress}
            {processingTotal > 0 && (
              <div style={{ width: "100%", height: 3, background: "rgba(56,189,248,0.15)", borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
                <div style={{ width: (processingDone / processingTotal * 100) + "%", height: "100%", background: "var(--accent-blue)", transition: "width 0.3s" }} />
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleProcessAll} disabled={processing} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: processing ? "var(--bg-tertiary)" : "var(--accent-blue)", color: processing ? "var(--text-tertiary)" : "#fff", border: "none", cursor: processing ? "default" : "pointer" }}>
            {processing ? "Analyzing..." : "Analyze all songs"}
          </button>
          <button onClick={async () => { await execute("UPDATE songs SET lufs_measured=NULL, peak_db=NULL, gain_db=0"); getProcessingStats().then(setProcessingStats); }}
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
            Reset
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 10 }}>Target is -14 LUFS — the broadcast standard used by most radio stations. This runs in the background and doesn't affect playback.</div>
      </Section>

      {/* ── Backup ── */}
      <Section icon="🛡" title="Backup & Restore" description="Save a copy of your entire library, schedule, and settings — takes about 2 seconds">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: backups.length > 0 ? 16 : 0 }}>
          <button onClick={backup} disabled={backupLoading} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", opacity: backupLoading ? 0.6 : 1 }}>
            {backupLoading ? "Saving..." : "💾 Back up now"}
          </button>
          {backupStatus && <span style={{ fontSize: 12, color: backupStatus.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{backupStatus}</span>}
        </div>
        {backups.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase" as any, marginBottom: 8 }}>Saved backups</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {backups.map(name => (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-tertiary)", borderRadius: 8, padding: "9px 12px", border: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{formatBackupName(name)}</span>
                  <button onClick={() => restore(name)} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8 }}>Backups older than 7 days are automatically deleted</div>
          </div>
        )}
        {backups.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8 }}>No backups yet — click "Back up now" to create your first one</div>}
      </Section>
    </div>
  );
}
