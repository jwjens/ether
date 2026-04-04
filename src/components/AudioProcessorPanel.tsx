// src/components/AudioProcessorPanel.tsx
// One-click mic processing panel — presets + manual controls
// Designed to sit inside MicDeck and the Podcast mixer channel strip

import { useState, useEffect, useRef } from "react";
import { AudioProcessor, ProcessorSettings, DEFAULT_SETTINGS, PRESETS } from "../audio/AudioProcessor";

interface Props {
  stream: MediaStream | null;
  onProcessorReady?: (processor: AudioProcessor) => void;
  onLevel?: (level: number, peakDb: number, gainReduction: number) => void;
  compact?: boolean; // true = just preset buttons, false = full controls
}

export default function AudioProcessorPanel({ stream, onProcessorReady, onLevel, compact = false }: Props) {
  const processorRef = useRef<AudioProcessor | null>(null);
  const [settings, setSettings] = useState<ProcessorSettings>(DEFAULT_SETTINGS);
  const [activePreset, setActivePreset] = useState<string>("Podcast");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [gainReduction, setGainReduction] = useState(0);
  const [agcGainDb, setAgcGainDb] = useState(0);

  // Build/rebuild processor when stream changes
  useEffect(() => {
    if (!stream) {
      processorRef.current?.destroy();
      processorRef.current = null;
      return;
    }

    processorRef.current?.destroy();
    const proc = new AudioProcessor(stream, settings);
    processorRef.current = proc;

    proc.onMeterUpdate((level, peakDb, gr) => {
      setGainReduction(gr);
      setAgcGainDb(processorRef.current?.getAgcGainDb() ?? 0);
      onLevel?.(level, peakDb, gr);
    });

    onProcessorReady?.(proc);

    return () => { proc.destroy(); };
  }, [stream]);

  // Apply settings when they change
  useEffect(() => {
    processorRef.current?.applySettings(settings);
  }, [settings]);

  const applyPreset = (name: string) => {
    const preset = PRESETS[name];
    if (!preset) return;
    setActivePreset(name);
    setSettings(s => ({ ...s, ...preset }));
  };

  const updateSetting = <K extends keyof ProcessorSettings>(key: K, value: ProcessorSettings[K]) => {
    setActivePreset("Custom");
    setSettings(s => ({ ...s, [key]: value }));
  };

  const PRESET_NAMES = Object.keys(PRESETS);

  if (compact) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Preset chips */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {PRESET_NAMES.map(name => (
            <button key={name} onClick={() => applyPreset(name)} style={{
              padding: "3px 9px", borderRadius: 0, border: "none",
              background: activePreset === name ? (name === "Off" ? "var(--bg-tertiary)" : "rgba(56,189,248,0.15)") : "var(--bg-tertiary)",
              color: activePreset === name ? (name === "Off" ? "var(--text-secondary)" : "var(--accent-cyan)") : "var(--text-tertiary)",
              fontSize: 10, fontWeight: activePreset === name ? 700 : 400,
              cursor: "pointer", transition: "all 0.12s",
              outline: activePreset === name ? `1px solid ${name === "Off" ? "var(--border-primary)" : "rgba(56,189,248,0.3)"}` : "1px solid transparent",
            }}>{name}</button>
          ))}
        </div>
        {/* Auto-Level (AGC) toggle — prominent, one-click */}
      <div style={{ padding: "10px 12px", borderRadius: 0, background: settings.autoLevelEnabled ? "rgba(52,211,153,0.08)" : "var(--bg-tertiary)", border: `1px solid ${settings.autoLevelEnabled ? "rgba(52,211,153,0.25)" : "var(--border-primary)"}`, transition: "all 0.2s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: settings.autoLevelEnabled ? "var(--accent-green)" : "var(--text-primary)" }}>
              Auto-Level (AGC)
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>
              {settings.autoLevelEnabled
                ? `Gain: ${agcGainDb >= 0 ? "+" : ""}${agcGainDb.toFixed(1)} dB — maintaining consistent level`
                : "Automatically keeps your voice at a consistent level"}
            </div>
          </div>
          <button onClick={() => updateSetting("autoLevelEnabled", !settings.autoLevelEnabled)} style={{
            width: 44, height: 24, borderRadius: 0, border: "none",
            background: settings.autoLevelEnabled ? "var(--accent-green)" : "var(--bg-secondary)",
            cursor: "pointer", position: "relative" as const, transition: "background 0.2s", flexShrink: 0,
          }}>
            <div style={{
              position: "absolute" as const, top: 3,
              left: settings.autoLevelEnabled ? 22 : 3,
              width: 18, height: 18, borderRadius: "50%",
              background: settings.autoLevelEnabled ? "#000" : "var(--text-tertiary)",
              transition: "left 0.2s",
            }} />
          </button>
        </div>
        {settings.autoLevelEnabled && (
          <div style={{ marginTop: 10 }}>
            <SliderRow
              label="Target"
              value={settings.targetLufs}
              min={-30} max={-6} unit=" dBFS"
              onChange={v => { updateSetting("targetLufs", v); processorRef.current?.setAgcTarget(v); }}
            />
            {/* AGC gain meter */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 64, flexShrink: 0 }}>AGC gain</span>
              <div style={{ flex: 1, height: 4, borderRadius: 0, background: "var(--bg-secondary)", overflow: "hidden", position: "relative" as const }}>
                {/* Center line */}
                <div style={{ position: "absolute" as const, left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.15)" }} />
                {/* Gain bar from center */}
                <div style={{
                  position: "absolute" as const,
                  height: "100%",
                  left: agcGainDb >= 0 ? "50%" : `${Math.max(0, 50 + agcGainDb * 2)}%`,
                  width: `${Math.min(50, Math.abs(agcGainDb) * 2)}%`,
                  background: agcGainDb > 10 ? "#ef4444" : agcGainDb > 6 ? "#fbbf24" : "var(--accent-green)",
                  transition: "all 0.2s",
                }} />
              </div>
              <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", width: 40, textAlign: "right" as const }}>
                {agcGainDb >= 0 ? "+" : ""}{agcGainDb.toFixed(1)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Gain reduction meter */}
        {settings.compEnabled && activePreset !== "Off" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "var(--text-tertiary)", width: 20, textAlign: "right" as const }}>GR</span>
            <div style={{ flex: 1, height: 3, borderRadius: 0, background: "var(--bg-tertiary)", overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 0,
                width: `${Math.min(100, Math.abs(gainReduction) * 4)}%`,
                background: Math.abs(gainReduction) > 10 ? "#ef4444" : Math.abs(gainReduction) > 6 ? "#fbbf24" : "#34d399",
                transition: "width 0.1s, background 0.2s",
              }} />
            </div>
            <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", width: 28 }}>
              {gainReduction < 0 ? gainReduction.toFixed(1) : "0.0"}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Full panel
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>Audio Processing</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Noise gate · EQ · Compression · Limiter</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: stream ? "#34d399" : "var(--text-tertiary)", boxShadow: stream ? "0 0 6px #34d399" : "none" }} />
          <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontWeight: 600 }}>{stream ? "ACTIVE" : "NO SOURCE"}</span>
        </div>
      </div>

      {/* Presets */}
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 6 }}>Preset</div>
        <div style={{ display: "flex", gap: 6 }}>
          {PRESET_NAMES.map(name => (
            <button key={name} onClick={() => applyPreset(name)} style={{
              flex: 1, padding: "8px 4px", borderRadius: 0,
              background: activePreset === name
                ? name === "Off" ? "var(--bg-tertiary)" : "rgba(56,189,248,0.12)"
                : "var(--bg-tertiary)",
              border: `1px solid ${activePreset === name
                ? name === "Off" ? "var(--border-primary)" : "rgba(56,189,248,0.35)"
                : "var(--border-primary)"}`,
              color: activePreset === name
                ? name === "Off" ? "var(--text-secondary)" : "var(--accent-cyan)"
                : "var(--text-tertiary)",
              fontSize: 10, fontWeight: activePreset === name ? 700 : 400,
              cursor: "pointer", transition: "all 0.12s", textAlign: "center" as const,
            }}>{name}</button>
          ))}
        </div>
      </div>

      {/* Auto-Level (AGC) toggle — prominent, one-click */}
      <div style={{ padding: "10px 12px", borderRadius: 0, background: settings.autoLevelEnabled ? "rgba(52,211,153,0.08)" : "var(--bg-tertiary)", border: `1px solid ${settings.autoLevelEnabled ? "rgba(52,211,153,0.25)" : "var(--border-primary)"}`, transition: "all 0.2s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: settings.autoLevelEnabled ? "var(--accent-green)" : "var(--text-primary)" }}>
              Auto-Level (AGC)
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>
              {settings.autoLevelEnabled
                ? `Gain: ${agcGainDb >= 0 ? "+" : ""}${agcGainDb.toFixed(1)} dB — maintaining consistent level`
                : "Automatically keeps your voice at a consistent level"}
            </div>
          </div>
          <button onClick={() => updateSetting("autoLevelEnabled", !settings.autoLevelEnabled)} style={{
            width: 44, height: 24, borderRadius: 0, border: "none",
            background: settings.autoLevelEnabled ? "var(--accent-green)" : "var(--bg-secondary)",
            cursor: "pointer", position: "relative" as const, transition: "background 0.2s", flexShrink: 0,
          }}>
            <div style={{
              position: "absolute" as const, top: 3,
              left: settings.autoLevelEnabled ? 22 : 3,
              width: 18, height: 18, borderRadius: "50%",
              background: settings.autoLevelEnabled ? "#000" : "var(--text-tertiary)",
              transition: "left 0.2s",
            }} />
          </button>
        </div>
        {settings.autoLevelEnabled && (
          <div style={{ marginTop: 10 }}>
            <SliderRow
              label="Target"
              value={settings.targetLufs}
              min={-30} max={-6} unit=" dBFS"
              onChange={v => { updateSetting("targetLufs", v); processorRef.current?.setAgcTarget(v); }}
            />
            {/* AGC gain meter */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 64, flexShrink: 0 }}>AGC gain</span>
              <div style={{ flex: 1, height: 4, borderRadius: 0, background: "var(--bg-secondary)", overflow: "hidden", position: "relative" as const }}>
                {/* Center line */}
                <div style={{ position: "absolute" as const, left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.15)" }} />
                {/* Gain bar from center */}
                <div style={{
                  position: "absolute" as const,
                  height: "100%",
                  left: agcGainDb >= 0 ? "50%" : `${Math.max(0, 50 + agcGainDb * 2)}%`,
                  width: `${Math.min(50, Math.abs(agcGainDb) * 2)}%`,
                  background: agcGainDb > 10 ? "#ef4444" : agcGainDb > 6 ? "#fbbf24" : "var(--accent-green)",
                  transition: "all 0.2s",
                }} />
              </div>
              <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", width: 40, textAlign: "right" as const }}>
                {agcGainDb >= 0 ? "+" : ""}{agcGainDb.toFixed(1)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Gain reduction meter */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>Gain Reduction</span>
          <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: Math.abs(gainReduction) > 10 ? "#ef4444" : "var(--text-tertiary)" }}>
            {gainReduction < 0 ? `${gainReduction.toFixed(1)} dB` : "0.0 dB"}
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 0, background: "var(--bg-tertiary)", overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 0,
            width: `${Math.min(100, Math.abs(gainReduction) * 4)}%`,
            background: Math.abs(gainReduction) > 10 ? "#ef4444" : Math.abs(gainReduction) > 6 ? "#fbbf24" : "#34d399",
            transition: "width 0.08s linear",
          }} />
        </div>
      </div>

      {/* Toggle advanced */}
      <button onClick={() => setShowAdvanced(s => !s)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-secondary)" }}>Advanced Controls</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" style={{ transform: showAdvanced ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {showAdvanced && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* High-pass filter */}
          <Section label="High-Pass Filter" enabled={settings.highPassEnabled} onToggle={v => updateSetting("highPassEnabled", v)}>
            <SliderRow label="Cutoff" value={settings.highPassFreq} min={20} max={300} unit="Hz" onChange={v => updateSetting("highPassFreq", v)} />
          </Section>

          {/* Noise gate */}
          <Section label="Noise Gate" enabled={settings.gateEnabled} onToggle={v => updateSetting("gateEnabled", v)}>
            <SliderRow label="Threshold" value={settings.gateThresholdDb} min={-80} max={-20} unit="dB" onChange={v => updateSetting("gateThresholdDb", v)} />
          </Section>

          {/* EQ */}
          <Section label="3-Band EQ" enabled={settings.eqEnabled} onToggle={v => updateSetting("eqEnabled", v)}>
            <SliderRow label="Low shelf" value={settings.lowShelfGainDb} min={-12} max={12} unit="dB" onChange={v => updateSetting("lowShelfGainDb", v)} bipolar />
            <SliderRow label="Mid (2.5k)" value={settings.midPeakGainDb} min={-12} max={12} unit="dB" onChange={v => updateSetting("midPeakGainDb", v)} bipolar />
            <SliderRow label="High shelf" value={settings.highShelfGainDb} min={-12} max={12} unit="dB" onChange={v => updateSetting("highShelfGainDb", v)} bipolar />
          </Section>

          {/* Compressor */}
          <Section label="Compressor" enabled={settings.compEnabled} onToggle={v => updateSetting("compEnabled", v)}>
            <SliderRow label="Threshold" value={settings.compThresholdDb} min={-60} max={0} unit="dB" onChange={v => updateSetting("compThresholdDb", v)} />
            <SliderRow label="Ratio" value={settings.compRatio} min={1} max={20} unit=":1" step={0.5} onChange={v => updateSetting("compRatio", v)} />
            <SliderRow label="Attack" value={settings.compAttackMs} min={1} max={100} unit="ms" onChange={v => updateSetting("compAttackMs", v)} />
            <SliderRow label="Release" value={settings.compReleaseMs} min={10} max={1000} unit="ms" onChange={v => updateSetting("compReleaseMs", v)} />
          </Section>

          {/* Output */}
          <Section label="Output" enabled alwaysOn>
            <SliderRow label="Gain" value={settings.outputGainDb} min={-20} max={20} unit="dB" onChange={v => updateSetting("outputGainDb", v)} bipolar />
          </Section>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

function Section({ label, enabled, onToggle, alwaysOn, children }: {
  label: string; enabled: boolean; onToggle?: (v: boolean) => void; alwaysOn?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", opacity: !enabled && !alwaysOn ? 0.5 : 1, transition: "opacity 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: enabled || alwaysOn ? 10 : 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.02em" }}>{label}</span>
        {!alwaysOn && onToggle && (
          <button onClick={() => onToggle(!enabled)} style={{
            width: 32, height: 18, borderRadius: 0, border: "none",
            background: enabled ? "var(--accent-cyan)" : "var(--bg-secondary)",
            cursor: "pointer", position: "relative" as const, transition: "background 0.2s",
            flexShrink: 0,
          }}>
            <div style={{
              position: "absolute" as const, top: 2, left: enabled ? 16 : 2,
              width: 14, height: 14, borderRadius: "50%",
              background: enabled ? "#000" : "var(--text-tertiary)",
              transition: "left 0.2s, background 0.2s",
            }} />
          </button>
        )}
      </div>
      {(enabled || alwaysOn) && children}
    </div>
  );
}

function SliderRow({ label, value, min, max, unit, step = 1, onChange, bipolar }: {
  label: string; value: number; min: number; max: number; unit: string;
  step?: number; onChange: (v: number) => void; bipolar?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 64, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: bipolar && value !== 0 ? (value > 0 ? "var(--accent-cyan)" : "#f87171") : "var(--accent-cyan)", height: 3, cursor: "pointer" }}
      />
      <span style={{ fontSize: 10, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace", width: 48, textAlign: "right" as const }}>
        {value > 0 && bipolar ? `+${value}` : value}{unit}
      </span>
    </div>
  );
}
