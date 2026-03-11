import { useState } from "react";
import { execute } from "../db/client";

interface Props {
  onComplete: () => void;
}

const MODES = [
  {
    id: "radio",
    title: "Radio Station",
    desc: "College radio, internet streaming, community FM, low-power FM",
    icon: "📻",
    features: "Format clocks, rotation rules, jock tools, cart wall, voice tracking",
    color: "#2563eb",
  },
  {
    id: "venue",
    title: "Venue / Attraction",
    desc: "Theme parks, museums, restaurants, hotels, event spaces",
    icon: "🎪",
    features: "Scheduled announcements, zone playlists, closing warnings, background music",
    color: "#7c3aed",
  },
  {
    id: "retail",
    title: "Retail / Business",
    desc: "Stores, gyms, offices, lobbies, waiting rooms",
    icon: "🏬",
    features: "Daypart playlists, brand music, simple scheduling, set and forget",
    color: "#0d9488",
  },
  {
    id: "worship",
    title: "House of Worship",
    desc: "Churches, mosques, temples, community centers",
    icon: "⛪",
    features: "Service scheduling, pre-service music, announcement automation",
    color: "#d97706",
  },
];

export default function FirstRunWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [stationName, setStationName] = useState("");
  const [tagline, setTagline] = useState("");
  const [selectedMode, setSelectedMode] = useState("");

  const finish = async () => {
    await execute(
      "UPDATE station_config SET station_name=?, mode=?, tagline=?, setup_complete=1 WHERE id=1",
      [stationName || "My Station", selectedMode, tagline]
    );
    onComplete();
  };

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 99998,
      background: "#09090b",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ width: 600, maxWidth: "90%" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 28, fontWeight: 300, color: "#fff", letterSpacing: "-0.03em" }}>
            <span style={{ color: "#2563eb" }}>Eth</span>er
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginTop: 4 }}>
            Setup
          </div>
        </div>

        {/* Step 0: Mode selection */}
        {step === 0 && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 300, color: "#fff", textAlign: "center", marginBottom: 8, letterSpacing: "-0.02em" }}>
              What are you using Ether for?
            </h2>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", textAlign: "center", marginBottom: 32 }}>
              This customizes your interface. You can change this later in Settings.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {MODES.map(m => (
                <button key={m.id} onClick={() => { setSelectedMode(m.id); setStep(1); }} style={{
                  padding: 20,
                  borderRadius: 12,
                  border: selectedMode === m.id ? "2px solid " + m.color : "1px solid rgba(255,255,255,0.08)",
                  background: selectedMode === m.id ? m.color + "15" : "rgba(255,255,255,0.03)",
                  cursor: "pointer",
                  textAlign: "left" as const,
                  transition: "all 0.2s ease",
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>{m.icon}</div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#fff", marginBottom: 4 }}>{m.title}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8, lineHeight: 1.4 }}>{m.desc}</div>
                  <div style={{ fontSize: 10, color: m.color, lineHeight: 1.4 }}>{m.features}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 1: Station name */}
        {step === 1 && (
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 20, fontWeight: 300, color: "#fff", marginBottom: 8, letterSpacing: "-0.02em" }}>
              {selectedMode === "radio" ? "Name your station" : selectedMode === "venue" ? "Name your venue" : selectedMode === "retail" ? "Name your business" : "Name your organization"}
            </h2>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 32 }}>
              This appears in the header and on any public displays.
            </p>

            <input
              autoFocus
              type="text"
              placeholder={selectedMode === "radio" ? "KETH 101.5" : selectedMode === "venue" ? "Magical Forest" : "My Business"}
              value={stationName}
              onChange={e => setStationName(e.target.value)}
              style={{
                width: "100%",
                maxWidth: 400,
                padding: "14px 20px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "#fff",
                fontSize: 18,
                fontWeight: 300,
                textAlign: "center" as const,
                outline: "none",
                letterSpacing: "-0.01em",
                marginBottom: 16,
              }}
              onKeyDown={e => { if (e.key === "Enter") setStep(2); }}
            />

            <div>
              <input
                type="text"
                placeholder="Tagline (optional)"
                value={tagline}
                onChange={e => setTagline(e.target.value)}
                style={{
                  width: "100%",
                  maxWidth: 400,
                  padding: "10px 20px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.03)",
                  color: "rgba(255,255,255,0.6)",
                  fontSize: 13,
                  fontWeight: 300,
                  textAlign: "center" as const,
                  outline: "none",
                  marginBottom: 32,
                }}
                onKeyDown={e => { if (e.key === "Enter") setStep(2); }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
              <button onClick={() => setStep(0)} style={{
                padding: "10px 24px", borderRadius: 8, border: "none",
                background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)",
                fontSize: 13, cursor: "pointer",
              }}>Back</button>
              <button onClick={() => setStep(2)} style={{
                padding: "10px 32px", borderRadius: 8, border: "none",
                background: "#2563eb", color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Continue</button>
            </div>
          </div>
        )}

        {/* Step 2: Ready */}
        {step === 2 && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 22, fontWeight: 300, color: "#fff", marginBottom: 8, letterSpacing: "-0.02em" }}>
              {stationName || "Your station"} is ready
            </h2>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>
              {selectedMode === "radio" && "Import your music library, set up format clocks, and start broadcasting."}
              {selectedMode === "venue" && "Import background music, set up scheduled announcements, and go live."}
              {selectedMode === "retail" && "Import your playlists, schedule dayparts, and let it run."}
              {selectedMode === "worship" && "Import your music, schedule services, and automate transitions."}
            </p>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginBottom: 32 }}>
              Start by going to Library and importing a music folder.
            </p>

            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
              <button onClick={() => setStep(1)} style={{
                padding: "10px 24px", borderRadius: 8, border: "none",
                background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)",
                fontSize: 13, cursor: "pointer",
              }}>Back</button>
              <button onClick={finish} style={{
                padding: "12px 40px", borderRadius: 10, border: "none",
                background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
                color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
                boxShadow: "0 8px 24px rgba(37, 99, 235, 0.3)",
              }}>Launch Ether</button>
            </div>
          </div>
        )}

        {/* Progress dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 40 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: step >= i ? "#2563eb" : "rgba(255,255,255,0.1)",
              transition: "background 0.3s ease",
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}
