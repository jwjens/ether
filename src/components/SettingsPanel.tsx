import { useState, useEffect } from "react";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
import { query, execute } from "../db/client";
import { getStationTimezone, setStationTimezone, COMMON_TIMEZONES } from "../utils/timezone";
import { processLibrary as processAllSongs, getProcessingStats } from "../audio/songAnalysis";

// ── Shared UI primitives ─────────────────────────────────────

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border-primary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", color: "var(--text-tertiary)" }}>{icon}</span>
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
  const [tab, setTab] = useState<"general" | "ai">("general");

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

  // AI / Voice Assistant (legacy)
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicKeySaved, setAnthropicKeySaved] = useState(false);

  // AI & Integrations tab
  const [aiProvider, setAiProviderState] = useState<"anthropic" | "openai" | "google">("anthropic");
  const [aiProviderSaved, setAiProviderSaved] = useState(false);
  const [keyStatus, setKeyStatus] = useState({ anthropic: false, openai: false, google: false, weather: false });
  const [anthropicInput, setAnthropicInput] = useState("");
  const [openaiInput, setOpenaiInput] = useState("");
  const [googleInput, setGoogleInput] = useState("");
  const [weatherInput, setWeatherInput] = useState("");
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

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
    (window as any).ether.autostart.isEnabled().then((v: boolean) => setAutostart(v)).catch(() => {});

    // Dashboard URL
    invoke<string>("get_local_ip").then(ip => setDashboardUrl("http://" + ip + ":4242")).catch(() => setDashboardUrl("http://localhost:4242"));

    // Instagram settings
    query<{ key: string; value: string }>("SELECT key, value FROM station_config_kv WHERE key IN ('ig_handle','ig_enabled','station_name','anthropic_api_key')").then(rows => {
      for (const r of rows) {
        if (r.key === "ig_handle") setIgHandle(r.value);
        if (r.key === "ig_enabled") setIgEnabled(r.value === "1");
        if (r.key === "station_name") setStationName(r.value);
        if (r.key === "anthropic_api_key") { setAnthropicKey(r.value); (window as any).__ANTHROPIC_API_KEY__ = r.value; }
      }
    }).catch(() => {});

    // AI key status + provider
    invoke("ai:getKeyStatus").then((s: any) => setKeyStatus(s)).catch(() => {});
    invoke("ai:getProvider").then((p: any) => setAiProviderState(p)).catch(() => {});

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
        
        await disable(); setAutostart(false);
      } else {
        
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

  const saveAnthropicKey = async () => {
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('anthropic_api_key', ?)", [anthropicKey]);
    (window as any).__ANTHROPIC_API_KEY__ = anthropicKey;
    setAnthropicKeySaved(true);
    setTimeout(() => setAnthropicKeySaved(false), 2000);
  };

  const connectProvider = async (provider: string, key: string) => {
    if (!key.trim()) return;
    setConnectingProvider(provider);
    await invoke("ai:setKey", { provider, key: key.trim() }).catch(() => {});
    const s: any = await invoke("ai:getKeyStatus").catch(() => keyStatus);
    setKeyStatus(s);
    setConnectingProvider(null);
    if (provider === "anthropic") setAnthropicInput("");
    if (provider === "openai") setOpenaiInput("");
    if (provider === "google") setGoogleInput("");
    if (provider === "weather") setWeatherInput("");
  };

  const disconnectProvider = async (provider: string) => {
    await invoke("ai:setKey", { provider, key: "" }).catch(() => {});
    const s: any = await invoke("ai:getKeyStatus").catch(() => keyStatus);
    setKeyStatus(s);
  };

  const saveProvider = async (provider: "anthropic" | "openai" | "google") => {
    setAiProviderState(provider);
    await invoke("ai:setProvider", provider).catch(() => {});
    setAiProviderSaved(true);
    setTimeout(() => setAiProviderSaved(false), 1500);
  };

  const tabStyle = (t: string): React.CSSProperties => ({
    padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
    background: tab === t ? "var(--accent-blue)" : "transparent",
    color: tab === t ? "#fff" : "var(--text-secondary)",
    transition: "all 0.15s",
  });

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "4px 0 40px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 16, fontFamily: "'Syne', sans-serif" }}>Settings</h1>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, padding: "4px", background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)", width: "fit-content" }}>
        <button style={tabStyle("general")} onClick={() => setTab("general")}>General</button>
        <button style={tabStyle("ai")} onClick={() => setTab("ai")}>AI &amp; Integrations</button>
      </div>

      {tab === "general" && <>

      {/* ── Station ── */}
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>} title="Your Station" description="Basic information about your station">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>} title="Audio Devices" description="Choose where music plays and which mic to use for voice tracking">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>} title="Music Scheduling Rules" description="Control how songs are selected — how long before the same artist or song can play again">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>} title="Remote Access & Website" description="Control Ether from your phone, or show what's playing on your website">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>} title="Now Playing Screen" description="Customize what shows on the on-air display window">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>} title="Loudness Normalization" description="Make every song play at the same volume — no more jarring jumps between quiet and loud tracks">
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
      <Section icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>} title="Backup & Restore" description="Save a copy of your entire library, schedule, and settings — takes about 2 seconds">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: backups.length > 0 ? 16 : 0 }}>
          <button onClick={backup} disabled={backupLoading} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", opacity: backupLoading ? 0.6 : 1 }}>
            {backupLoading ? "Saving..." : "Back up now"}
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

      </> /* end tab === "general" */}

      {tab === "ai" && <>
        {/* ── Active AI Provider ── */}
        <Section
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>}
          title="Active AI Provider"
          description="Choose which AI powers the DeskProducer assistant"
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            {(["anthropic", "openai", "google"] as const).map(p => {
              const labels = { anthropic: "Claude (Anthropic)", openai: "ChatGPT (OpenAI)", google: "Gemini (Google)" };
              const active = aiProvider === p;
              const hasKey = keyStatus[p];
              return (
                <button key={p} onClick={() => saveProvider(p)} style={{
                  padding: "9px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${active ? "var(--accent-blue)" : "var(--border-primary)"}`,
                  background: active ? "var(--accent-blue)" : "var(--bg-tertiary)",
                  color: active ? "#fff" : hasKey ? "var(--text-primary)" : "var(--text-tertiary)",
                  transition: "all 0.15s", display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: hasKey ? "var(--accent-green)" : "var(--text-tertiary)", flexShrink: 0, display: "inline-block" }} />
                  {labels[p]}
                </button>
              );
            })}
          </div>
          {aiProviderSaved && <div style={{ fontSize: 11, color: "var(--accent-green)", marginTop: 8 }}>✓ Saved</div>}
        </Section>

        {/* ── Provider Cards ── */}
        {([
          {
            id: "anthropic",
            name: "Anthropic (Claude)",
            placeholder: "sk-ant-...",
            keyUrl: "https://console.anthropic.com/settings/keys",
            keyUrlLabel: "console.anthropic.com/settings/keys",
            hint: "Starts with sk-ant-",
            value: anthropicInput,
            set: setAnthropicInput,
            color: "#d4770a",
          },
          {
            id: "openai",
            name: "OpenAI (ChatGPT)",
            placeholder: "sk-...",
            keyUrl: "https://platform.openai.com/api-keys",
            keyUrlLabel: "platform.openai.com/api-keys",
            hint: "Starts with sk-",
            value: openaiInput,
            set: setOpenaiInput,
            color: "#10a37f",
          },
          {
            id: "google",
            name: "Google (Gemini)",
            placeholder: "AIza...",
            keyUrl: "https://aistudio.google.com/apikey",
            keyUrlLabel: "aistudio.google.com/apikey",
            hint: "Starts with AIza",
            value: googleInput,
            set: setGoogleInput,
            color: "#4285f4",
          },
        ] as const).map(card => {
          const connected = (keyStatus as any)[card.id];
          const busy = connectingProvider === card.id;
          return (
            <div key={card.id} style={{ background: "var(--bg-secondary)", border: `1px solid ${connected ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, borderRadius: 16, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: card.color, flexShrink: 0 }} />
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>{card.name}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: connected ? "var(--accent-green)" : "var(--text-tertiary)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
                  {connected ? "Connected" : "Not connected"}
                </div>
              </div>
              <div style={{ padding: "14px 20px" }}>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>
                  Get your API key at{" "}
                  <a href={card.keyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-cyan)", textDecoration: "none" }} onClick={e => { e.preventDefault(); (window as any).ether?.system?.openUrl(card.keyUrl); }}>
                    {card.keyUrlLabel}
                  </a>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="password"
                    value={card.value}
                    onChange={e => card.set(e.target.value as any)}
                    placeholder={connected ? "••••••••••••••••" : card.placeholder}
                    style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
                  />
                  <button
                    onClick={() => connectProvider(card.id, card.value)}
                    disabled={!card.value.trim() || busy}
                    style={{ padding: "8px 16px", borderRadius: 8, fontSize: 11, fontWeight: 600, border: "none", cursor: card.value.trim() && !busy ? "pointer" : "default", background: card.value.trim() && !busy ? "var(--accent-blue)" : "var(--bg-tertiary)", color: card.value.trim() && !busy ? "#fff" : "var(--text-tertiary)", transition: "all 0.15s", whiteSpace: "nowrap" as const }}>
                    {busy ? "Saving..." : "Connect"}
                  </button>
                  {connected && (
                    <button onClick={() => disconnectProvider(card.id)} style={{ padding: "8px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, border: "1px solid var(--border-secondary)", cursor: "pointer", background: "transparent", color: "var(--text-tertiary)", transition: "all 0.15s", whiteSpace: "nowrap" as const }}>
                      Disconnect
                    </button>
                  )}
                </div>
                {card.value && <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6 }}>{card.hint}</div>}
              </div>
            </div>
          );
        })}

        {/* ── Weather (OpenWeatherMap) ── */}
        <Section
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>}
          title="Weather — OpenWeatherMap"
          description="Powers the Weather button in DeskProducer with real Las Vegas conditions"
        >
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 10 }}>
            Free API key at{" "}
            <a href="https://openweathermap.org/api" target="_blank" rel="noreferrer" style={{ color: "var(--accent-cyan)", textDecoration: "none" }} onClick={e => { e.preventDefault(); (window as any).ether?.system?.openUrl("https://openweathermap.org/api"); }}>
              openweathermap.org/api
            </a>
            {" "}— sign up, then copy the key from your dashboard. You can also set <code style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 4 }}>OPENWEATHERMAP_API_KEY</code> in your .env file.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={weatherInput}
              onChange={e => setWeatherInput(e.target.value)}
              placeholder={keyStatus.weather ? "••••••••••••••••" : "Paste API key..."}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
            />
            <button
              onClick={() => connectProvider("weather", weatherInput)}
              disabled={!weatherInput.trim() || connectingProvider === "weather"}
              style={{ padding: "8px 16px", borderRadius: 8, fontSize: 11, fontWeight: 600, border: "none", cursor: weatherInput.trim() ? "pointer" : "default", background: weatherInput.trim() ? "var(--accent-blue)" : "var(--bg-tertiary)", color: weatherInput.trim() ? "#fff" : "var(--text-tertiary)", transition: "all 0.15s" }}>
              {connectingProvider === "weather" ? "Saving..." : "Connect"}
            </button>
            {keyStatus.weather && (
              <button onClick={() => disconnectProvider("weather")} style={{ padding: "8px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, border: "1px solid var(--border-secondary)", cursor: "pointer", background: "transparent", color: "var(--text-tertiary)" }}>
                Disconnect
              </button>
            )}
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: keyStatus.weather ? "var(--accent-green)" : "var(--text-tertiary)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: keyStatus.weather ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            {keyStatus.weather ? "Connected — Weather button is live" : "Not connected — Weather button will show a placeholder"}
          </div>
        </Section>
      </> /* end tab === "ai" */}

    </div>
  );
}
