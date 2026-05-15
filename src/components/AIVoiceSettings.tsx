// AIVoiceSettings.tsx — provider/API key/voice picker for AI Auto-DJ.
//
// Lives inside SettingsPanel as a Section. Three providers:
//   - elevenlabs:  best quality, voice cloning supported, paid
//   - openai:      simpler, $15/M chars, six built-in voices
//   - browser:     Web Speech API, free, lower quality
//
// Test button generates a short clip with current settings so the user
// hears their voice before committing.

import { useEffect, useState } from "react";
import { getActiveStationIdSync } from "../hooks/useActiveStation";

type Provider = "elevenlabs" | "openai" | "browser";

interface Voice {
  id: string;
  name: string;
  description?: string;
  preview?: string;
}

interface Config {
  provider: Provider;
  apiKey: string;
  voiceId: string;
  model: string;
  stability: number;
  similarity: number;
}

const PROVIDER_INFO: Record<Provider, { label: string; desc: string; signupUrl: string }> = {
  elevenlabs: {
    label: "ElevenLabs",
    desc: "Best quality, supports voice cloning. Free tier: 10k chars/mo. Paid: $5/mo for 30k chars.",
    signupUrl: "https://elevenlabs.io",
  },
  openai: {
    label: "OpenAI TTS",
    desc: "Simple, six built-in voices. $15/M chars (tts-1) or $30/M chars (tts-1-hd). Use your existing OpenAI key.",
    signupUrl: "https://platform.openai.com/api-keys",
  },
  browser: {
    label: "Browser (Web Speech API)",
    desc: "Free, runs locally on the operator's machine. Quality is lower and depends on the OS — fine for staging/testing, not great on-air.",
    signupUrl: "",
  },
};

const ELEVENLABS_MODELS = [
  { id: "eleven_turbo_v2_5",   name: "Turbo v2.5 (fastest)" },
  { id: "eleven_multilingual_v2", name: "Multilingual v2 (highest quality)" },
  { id: "eleven_monolingual_v1", name: "Monolingual v1 (legacy)" },
];
const OPENAI_MODELS = [
  { id: "tts-1",    name: "tts-1 (faster, cheaper)" },
  { id: "tts-1-hd", name: "tts-1-hd (higher quality)" },
];

export default function AIVoiceSettings() {
  const ether = (window as any).ether;
  const [config, setConfig]     = useState<Config | null>(null);
  const [voices, setVoices]     = useState<Voice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [testAudio, setTestAudio]   = useState<string | null>(null);

  useEffect(() => {
    ether?.ai?.getConfig?.().then((c: Config) => {
      setConfig(c);
      if (c.provider !== "browser" && c.apiKey) loadVoices(c.provider, c.apiKey);
      if (c.provider === "browser") loadBrowserVoices();
    });
  }, []);

  const loadBrowserVoices = () => {
    try {
      const list = (window.speechSynthesis?.getVoices?.() || []).map(v => ({
        id: v.voiceURI, name: v.name, description: v.lang,
      }));
      setVoices(list);
    } catch { setVoices([]); }
  };

  const loadVoices = async (provider: Provider, apiKey: string) => {
    if (provider === "browser") { loadBrowserVoices(); return; }
    setLoadingVoices(true);
    try {
      const r = await ether.ai.listVoices({ provider, apiKey });
      if (r?.ok) setVoices(r.voices || []);
      else { setVoices([]); console.warn("[AI-VOICE] listVoices:", r?.error); }
    } catch (e) { console.error(e); }
    setLoadingVoices(false);
  };

  const updateConfig = (patch: Partial<Config>) => {
    setConfig(c => c ? { ...c, ...patch } : c);
  };

  const save = async () => {
    if (!config) return;
    try {
      const r = await ether.ai.setConfig(config);
      setConfig(r);
      setSavedMsg("✓ Saved");
      setTimeout(() => setSavedMsg(""), 2500);
    } catch (e: any) {
      setSavedMsg("Error: " + (e?.message || e));
    }
  };

  const testVoice = async () => {
    if (!config) return;
    setTestStatus("Generating...");
    setTestAudio(null);
    try {
      // Save first so the test uses the latest settings
      await ether.ai.setConfig(config);
      if (config.provider === "browser") {
        // Browser TTS: use SpeechSynthesis directly
        const u = new SpeechSynthesisUtterance("This is your AI DJ. Up next, the latest from Ether Radio.");
        const v = window.speechSynthesis.getVoices().find(v => v.voiceURI === config.voiceId);
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
        setTestStatus("✓ Playing via Web Speech");
        setTimeout(() => setTestStatus(""), 3500);
        return;
      }
      const r = await ether.ai.generate({
        title: "Test clip",
        script: "This is your AI DJ. Up next on Ether Radio, the freshest sound on the dial.",
        stationId: getActiveStationIdSync(),
      });
      if (r?.ok) {
        setTestStatus("✓ Generated " + (r.segment?.size_bytes ? `(${Math.round(r.segment.size_bytes / 1024)} KB)` : ""));
        const p = r.segment?.file_path;
        if (p) setTestAudio("file:///" + p.replace(/\\/g, "/"));
      } else {
        setTestStatus("✗ " + (r?.error || "failed"));
      }
    } catch (e: any) {
      setTestStatus("✗ " + (e?.message || e));
    }
  };

  if (!config) return <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Loading…</div>;
  const info = PROVIDER_INFO[config.provider];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>Provider</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {(["elevenlabs", "openai", "browser"] as Provider[]).map(p => (
            <button key={p} onClick={() => { updateConfig({ provider: p, voiceId: "" }); setVoices([]); }} style={{
              padding: "10px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
              background: config.provider === p ? "var(--accent-blue)" : "var(--bg-tertiary)",
              color:      config.provider === p ? "#fff" : "var(--text-secondary)",
              border: config.provider === p ? "none" : "1px solid var(--border-primary)",
              cursor: "pointer", textAlign: "left" as any,
            }}>
              <div>{PROVIDER_INFO[p].label}</div>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8, lineHeight: 1.5 }}>
          {info.desc}
          {info.signupUrl && <> · <a href={info.signupUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-blue)" }}>Sign up</a></>}
        </div>
      </div>

      {config.provider !== "browser" && (
        <>
          <Field label="API key">
            <input type="password" value={config.apiKey} onChange={e => updateConfig({ apiKey: e.target.value })}
              placeholder={config.provider === "elevenlabs" ? "sk-..." : "sk-..."}
              style={inputStyle} />
            <button onClick={() => loadVoices(config.provider, config.apiKey)} style={{
              marginTop: 6, padding: "6px 12px", fontSize: 11, fontWeight: 600,
              background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
              color: "var(--text-secondary)", cursor: "pointer", borderRadius: 0,
            }}>
              {loadingVoices ? "Loading…" : voices.length > 0 ? `↻ Reload voices (${voices.length} loaded)` : "Load voices"}
            </button>
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Voice">
              <select value={config.voiceId} onChange={e => updateConfig({ voiceId: e.target.value })} style={inputStyle}>
                <option value="">Choose a voice…</option>
                {voices.map(v => (
                  <option key={v.id} value={v.id}>{v.name}{v.description ? ` — ${v.description}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select value={config.model} onChange={e => updateConfig({ model: e.target.value })} style={inputStyle}>
                {(config.provider === "elevenlabs" ? ELEVENLABS_MODELS : OPENAI_MODELS).map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </Field>
          </div>

          {config.provider === "elevenlabs" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label={`Stability (${config.stability.toFixed(2)})`}>
                <input type="range" min={0} max={1} step={0.05} value={config.stability}
                  onChange={e => updateConfig({ stability: parseFloat(e.target.value) })} style={{ width: "100%" }} />
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>Lower = more expressive, Higher = more consistent</div>
              </Field>
              <Field label={`Similarity (${config.similarity.toFixed(2)})`}>
                <input type="range" min={0} max={1} step={0.05} value={config.similarity}
                  onChange={e => updateConfig({ similarity: parseFloat(e.target.value) })} style={{ width: "100%" }} />
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>How closely to clone the original voice</div>
              </Field>
            </div>
          )}
        </>
      )}

      {config.provider === "browser" && (
        <Field label="Voice (from your operating system)">
          <select value={config.voiceId} onChange={e => updateConfig({ voiceId: e.target.value })} style={inputStyle}>
            <option value="">System default</option>
            {voices.map(v => <option key={v.id} value={v.id}>{v.name} ({v.description})</option>)}
          </select>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Voices come from Windows / macOS / Linux. {voices.length} available.
          </div>
        </Field>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border-primary)" }}>
        <button onClick={save} style={{
          padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700,
          background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer",
        }}>Save settings</button>
        <button onClick={testVoice} disabled={config.provider !== "browser" && (!config.apiKey || !config.voiceId)} style={{
          padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600,
          background: "var(--bg-tertiary)", color: "var(--text-secondary)",
          border: "1px solid var(--border-primary)",
          cursor: (config.provider !== "browser" && (!config.apiKey || !config.voiceId)) ? "not-allowed" : "pointer",
          opacity: (config.provider !== "browser" && (!config.apiKey || !config.voiceId)) ? 0.5 : 1,
        }}>Generate test clip</button>
        {savedMsg && <span style={{ fontSize: 12, color: savedMsg.startsWith("✓") ? "#22c55e" : "#ef4444" }}>{savedMsg}</span>}
        {testStatus && <span style={{ fontSize: 12, color: testStatus.startsWith("✓") ? "#22c55e" : testStatus.startsWith("✗") ? "#ef4444" : "var(--text-tertiary)" }}>{testStatus}</span>}
      </div>

      {testAudio && (
        <audio src={testAudio} controls autoPlay style={{ width: "100%" }} />
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>
      {children}
    </div>
  );
}
