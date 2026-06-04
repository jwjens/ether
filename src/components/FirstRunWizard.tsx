import { useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

export type ExperienceMode = "solo" | "standard" | "live_radio";

interface Props {
  onComplete: (profile: VenueProfile) => void;
}

export interface VenueProfile {
  venueType: VenueType;
  name: string;
  tagline: string;
}

export type VenueType = "radio" | "venue" | "retail" | "worship" | "podcast";

export const VENUE_LABELS: Record<VenueType, {
  type: string;
  icon: string;
  tagline: string;
  library: string;
  spots: string;
  clock: string;
  log: string;
  dj: string;
  automation: string;
  schedule: string;
  showName: string;
}> = {
  radio: {
    type: "Radio Station",
    icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>`,
    tagline: "AM · FM · Internet · Podcast · College Radio",
    library: "Song Library",
    spots: "Spots & Promos",
    clock: "Program Clock",
    log: "Play Log",
    dj: "DJ / Host",
    automation: "Automation",
    schedule: "Show Schedule",
    showName: "Station Name",
  },
  venue: {
    type: "Venue / Attraction",
    icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    tagline: "Bars · Clubs · Theme Parks · Arenas · Events",
    library: "Music Library",
    spots: "Announcements",
    clock: "Event Schedule",
    log: "Activity Log",
    dj: "Entertainment Host",
    automation: "Auto-Play",
    schedule: "Event Schedule",
    showName: "Venue Name",
  },
  retail: {
    type: "Retail / Business",
    icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    tagline: "Stores · Restaurants · Hotels · Gyms · Offices",
    library: "Music Library",
    spots: "Store Messages",
    clock: "Playlist Schedule",
    log: "Playback Log",
    dj: "Manager",
    automation: "Auto-Play",
    schedule: "Store Hours",
    showName: "Business Name",
  },
  worship: {
    type: "House of Worship",
    icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 22V10"/><path d="M6 22V10"/><path d="M2 10h20"/><path d="M12 2v8"/><path d="M9 5h6"/></svg>`,
    tagline: "Churches · Mosques · Synagogues · Temples",
    library: "Worship Library",
    spots: "Ministry Audio",
    clock: "Service Schedule",
    log: "Service Log",
    dj: "Worship Leader",
    automation: "Auto-Play",
    schedule: "Service Schedule",
    showName: "Congregation Name",
  },
  podcast: {
    type: "Podcast / YouTube",
    icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    tagline: "Podcasts · YouTube · Livestreams · Video Shows",
    library: "Episode Library",
    spots: "Sponsorship Reads",
    clock: "Episode Schedule",
    log: "Episode Log",
    dj: "Host",
    automation: "Auto-Publish",
    schedule: "Release Schedule",
    showName: "Show Name",
  },
};

const PLACEHOLDER_NAMES: Record<VenueType, string> = {
  radio: "WKTR 94.5 The Rock",
  venue: "The Blue Room",
  retail: "Main Street Coffee",
  worship: "Grace Community Church",
  podcast: "The Daily Deep Dive",
};

const PLACEHOLDER_TAGLINES: Record<VenueType, string> = {
  radio: "Your city's home for classic rock",
  venue: "Where the night comes alive",
  retail: "Good coffee, great atmosphere",
  worship: "A place to belong",
  podcast: "Weekly conversations worth having",
};

const EXPERIENCE_MODES: Array<{ id: ExperienceMode; label: string; tagline: string; desc: string; badge: string }> = [
  {
    id: "solo",
    label: "Solo",
    tagline: "One deck · Simple play/pause",
    desc: "Single deck, no crossfades. Best for podcasters and first-time users.",
    badge: "BEGINNER",
  },
  {
    id: "standard",
    label: "Standard",
    tagline: "Two decks · Crossfades included",
    desc: "Decks A and B always visible. Smooth crossfades between them. For independent broadcasters.",
    badge: "POPULAR",
  },
  {
    id: "live_radio",
    label: "Live Radio",
    tagline: "All six decks · Full automation",
    desc: "All six decks unlocked. Format clock scheduling, hard transitions, full rotation engine.",
    badge: "PRO",
  },
];

export default function FirstRunWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [experienceMode, setExperienceMode] = useState<ExperienceMode | null>(null);
  const [venueType, setVenueType] = useState<VenueType | null>(null);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [saving, setSaving] = useState(false);
  const { stationId } = useActiveStation();

  const selectedLabel = venueType ? VENUE_LABELS[venueType] : null;

  const handleComplete = async () => {
    if (!venueType || !name.trim()) return;
    setSaving(true);
    try {
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'station_name', name.trim());
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'station_tagline', tagline.trim());
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'venue_type', venueType);
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'experience_mode', experienceMode || "standard");
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'first_run_complete', '1');
      onComplete({ venueType, name: name.trim(), tagline: tagline.trim() });
    } catch (e) {
      console.error("Wizard save failed:", e);
      onComplete({ venueType, name: name.trim(), tagline: tagline.trim() });
    }
    setSaving(false);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9998,
      background: "#080810",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', system-ui, sans-serif",
      padding: 24,
    }}>
      {/* Background glow */}
      <div style={{ position: "absolute", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(136,104,216,0.05) 0%, transparent 70%)", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: 640, position: "relative" as any }}>
        {/* Step dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 48 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ width: i === step ? 24 : 8, height: 8, borderRadius: 0, background: i === step ? "#8868D8" : i < step ? "rgba(136,104,216,0.4)" : "rgba(255,255,255,0.1)", transition: "all 0.3s ease" }} />
          ))}
        </div>

        {/* ── STEP 0: Experience mode ── */}
        {step === 0 && (
          <div style={{ animation: "wiz-in 0.4s ease both" }}>
            <div style={{ textAlign: "center" as any, marginBottom: 40 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.2em", color: "#8868D8", textTransform: "uppercase" as any, marginBottom: 12 }}>Welcome to Ether</div>
              <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8", lineHeight: 1.1, marginBottom: 12 }}>How do you want<br />to broadcast?</h1>
              <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>This sets your default deck layout. You can change it anytime in Settings.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column" as any, gap: 12, maxWidth: 520, margin: "0 auto" }}>
              {EXPERIENCE_MODES.map(mode => {
                const selected = experienceMode === mode.id;
                return (
                  <button key={mode.id} onClick={() => setExperienceMode(mode.id)} style={{
                    padding: "20px 24px", borderRadius: 0, textAlign: "left" as any,
                    background: selected ? "rgba(136,104,216,0.08)" : "rgba(255,255,255,0.03)",
                    border: `1.5px solid ${selected ? "#8868D8" : "rgba(255,255,255,0.08)"}`,
                    cursor: "pointer", transition: "all 0.2s",
                    boxShadow: selected ? "0 0 24px rgba(136,104,216,0.12)" : "none",
                    display: "flex", alignItems: "center", gap: 20,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, color: selected ? "#8868D8" : "#f0f0f8", letterSpacing: "-0.02em" }}>{mode.label}</span>
                        <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.12em", color: selected ? "#8868D8" : "rgba(255,255,255,0.25)", background: selected ? "rgba(136,104,216,0.15)" : "rgba(255,255,255,0.06)", padding: "2px 7px", borderRadius: 0 }}>{mode.badge}</span>
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: selected ? "rgba(136,104,216,0.7)" : "rgba(255,255,255,0.35)", marginBottom: 4, letterSpacing: "0.02em" }}>{mode.tagline}</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>{mode.desc}</div>
                    </div>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${selected ? "#8868D8" : "rgba(255,255,255,0.15)"}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {selected && <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#8868D8" }} />}
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 32, textAlign: "center" as any }}>
              <button onClick={() => experienceMode && setStep(1)} disabled={!experienceMode} style={{
                padding: "13px 48px", borderRadius: 0,
                background: experienceMode ? "linear-gradient(135deg, #8868D8, #a78bfa)" : "rgba(255,255,255,0.06)",
                color: experienceMode ? "#000" : "rgba(255,255,255,0.2)",
                fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                border: "none", cursor: experienceMode ? "pointer" : "default",
                letterSpacing: "0.04em",
                boxShadow: experienceMode ? "0 0 32px rgba(136,104,216,0.3)" : "none",
                transition: "all 0.2s",
              }}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1: Venue type ── */}
        {step === 1 && (
          <div style={{ animation: "wiz-in 0.4s ease both" }}>
            <div style={{ textAlign: "center" as any, marginBottom: 40 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.2em", color: "#8868D8", textTransform: "uppercase" as any, marginBottom: 12 }}>Welcome to Ether</div>
              <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8", lineHeight: 1.1, marginBottom: 12 }}>What are you using<br />Ether for?</h1>
              <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>We'll customize the interface and language to match your setup.</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              {(["radio", "venue", "retail"] as VenueType[]).map((type) => {
                const label = VENUE_LABELS[type];
                const selected = venueType === type;
                return (
                  <button key={type} onClick={() => setVenueType(type)} style={{
                    padding: "24px 20px", borderRadius: 0,
                    background: selected ? "rgba(136,104,216,0.1)" : "rgba(255,255,255,0.03)",
                    border: `1.5px solid ${selected ? "#8868D8" : "rgba(255,255,255,0.08)"}`,
                    cursor: "pointer", textAlign: "left" as any, transition: "all 0.2s",
                    boxShadow: selected ? "0 0 24px rgba(136,104,216,0.15)" : "none",
                  }}>
                    <div style={{ marginBottom: 10, color: "rgba(255,255,255,0.7)" }} dangerouslySetInnerHTML={{ __html: label.icon }} />
                    <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 15, fontWeight: 700, color: selected ? "#8868D8" : "#f0f0f8", marginBottom: 5, letterSpacing: "-0.02em" }}>{label.type}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>{label.tagline}</div>
                    {selected && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#8868D8" }} /><span style={{ fontSize: 10, fontWeight: 700, color: "#8868D8", letterSpacing: "0.1em" }}>SELECTED</span></div>}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: "66.6%", margin: "0 auto" }}>
              {(["worship", "podcast"] as VenueType[]).map((type) => {
                const label = VENUE_LABELS[type];
                const selected = venueType === type;
                return (
                  <button key={type} onClick={() => setVenueType(type)} style={{
                    padding: "24px 20px", borderRadius: 0,
                    background: selected ? "rgba(136,104,216,0.1)" : "rgba(255,255,255,0.03)",
                    border: `1.5px solid ${selected ? "#8868D8" : "rgba(255,255,255,0.08)"}`,
                    cursor: "pointer", textAlign: "left" as any, transition: "all 0.2s",
                    boxShadow: selected ? "0 0 24px rgba(136,104,216,0.15)" : "none",
                  }}>
                    <div style={{ marginBottom: 10, color: "rgba(255,255,255,0.7)" }} dangerouslySetInnerHTML={{ __html: label.icon }} />
                    <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 15, fontWeight: 700, color: selected ? "#8868D8" : "#f0f0f8", marginBottom: 5, letterSpacing: "-0.02em" }}>{label.type}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>{label.tagline}</div>
                    {selected && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#8868D8" }} /><span style={{ fontSize: 10, fontWeight: 700, color: "#8868D8", letterSpacing: "0.1em" }}>SELECTED</span></div>}
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 32, textAlign: "center" as any }}>
              <button onClick={() => venueType && setStep(2)} disabled={!venueType} style={{
                padding: "13px 48px", borderRadius: 0,
                background: venueType ? "linear-gradient(135deg, #8868D8, #a78bfa)" : "rgba(255,255,255,0.06)",
                color: venueType ? "#000" : "rgba(255,255,255,0.2)",
                fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                border: "none", cursor: venueType ? "pointer" : "default",
                letterSpacing: "0.04em",
                boxShadow: venueType ? "0 0 32px rgba(136,104,216,0.3)" : "none",
                transition: "all 0.2s",
              }}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Name ── */}
        {step === 2 && selectedLabel && (
          <div style={{ animation: "wiz-in 0.4s ease both" }}>
            <div style={{ textAlign: "center" as any, marginBottom: 40 }}>
              <div style={{ marginBottom: 12, color: "rgba(255,255,255,0.7)" }} dangerouslySetInnerHTML={{ __html: selectedLabel.icon }} />
              <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8", lineHeight: 1.1, marginBottom: 12 }}>
                Name your<br />{selectedLabel.type.toLowerCase()}
              </h1>
              <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }}>This shows in the header and on your Now Playing screen.</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column" as any, gap: 12, maxWidth: 420, margin: "0 auto" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.3)", textTransform: "uppercase" as any, marginBottom: 8 }}>{selectedLabel.showName}</div>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && name.trim() && setStep(3)}
                  placeholder={PLACEHOLDER_NAMES[venueType!]}
                  style={{
                    width: "100%", padding: "14px 18px",
                    borderRadius: 0, fontSize: 20, fontWeight: 600,
                    fontFamily: "'Syne', sans-serif",
                    background: "rgba(255,255,255,0.05)",
                    border: "1.5px solid rgba(255,255,255,0.12)",
                    color: "#f0f0f8", outline: "none",
                    letterSpacing: "-0.02em",
                    boxSizing: "border-box" as any,
                    transition: "border-color 0.2s",
                  }}
                  onFocus={e => (e.target.style.borderColor = "#8868D8")}
                  onBlur={e => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>

              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.3)", textTransform: "uppercase" as any, marginBottom: 8 }}>Tagline <span style={{ opacity: 0.5 }}>(optional)</span></div>
                <input
                  value={tagline}
                  onChange={e => setTagline(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && name.trim() && setStep(3)}
                  placeholder={PLACEHOLDER_TAGLINES[venueType!]}
                  style={{
                    width: "100%", padding: "12px 18px",
                    borderRadius: 0, fontSize: 14,
                    background: "rgba(255,255,255,0.04)",
                    border: "1.5px solid rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.6)", outline: "none",
                    boxSizing: "border-box" as any,
                    transition: "border-color 0.2s",
                    fontFamily: "'Inter', system-ui, sans-serif",
                  }}
                  onFocus={e => (e.target.style.borderColor = "#8868D8")}
                  onBlur={e => (e.target.style.borderColor = "rgba(255,255,255,0.08)")}
                />
              </div>
            </div>

            <div style={{ marginTop: 36, display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setStep(1)} style={{ padding: "12px 24px", borderRadius: 0, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 13 }}>← Back</button>
              <button onClick={() => name.trim() && setStep(3)} disabled={!name.trim()} style={{
                padding: "13px 48px", borderRadius: 0,
                background: name.trim() ? "linear-gradient(135deg, #8868D8, #a78bfa)" : "rgba(255,255,255,0.06)",
                color: name.trim() ? "#000" : "rgba(255,255,255,0.2)",
                fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                border: "none", cursor: name.trim() ? "pointer" : "default",
                letterSpacing: "0.04em",
                boxShadow: name.trim() ? "0 0 32px rgba(136,104,216,0.3)" : "none",
                transition: "all 0.2s",
              }}>Continue →</button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Ready ── */}
        {step === 3 && selectedLabel && (
          <div style={{ animation: "wiz-in 0.4s ease both", textAlign: "center" as any }}>
            {/* Animated checkmark */}
            <div style={{ marginBottom: 28 }}>
              <div style={{
                width: 72, height: 72, borderRadius: "50%",
                background: "linear-gradient(135deg, #8868D8, #a78bfa)",
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "0 auto",
                boxShadow: "0 0 40px rgba(136,104,216,0.4)",
                animation: "wiz-check 0.5s cubic-bezier(0.34,1.56,0.64,1) both",
              }}>
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <path d="M8 16l6 6 10-12" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>

            <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8", marginBottom: 10 }}>
              {venueType === "radio" ? "Your station is ready." : venueType === "worship" ? "Welcome." : venueType === "podcast" ? "Your studio is ready." : "You're all set."}
            </h1>

            {/* Station name preview */}
            <div style={{ margin: "20px auto", padding: "16px 28px", borderRadius: 0, background: "rgba(136,104,216,0.08)", border: "1px solid rgba(136,104,216,0.2)", display: "inline-block" }}>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, color: "#f0f0f8", letterSpacing: "-0.03em" }}>{name}</div>
              {tagline && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{tagline}</div>}
            </div>

            {/* Feature preview */}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" as any, margin: "20px 0 32px" }}>
              {[
                selectedLabel.library,
                selectedLabel.spots,
                selectedLabel.clock,
                selectedLabel.log,
                "Voice Tracking",
                "Show Prep",
              ].map(f => (
                <span key={f} style={{ padding: "4px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "rgba(167,139,250,0.1)", color: "rgba(167,139,250,0.8)", border: "1px solid rgba(167,139,250,0.2)" }}>{f}</span>
              ))}
            </div>

            <button onClick={handleComplete} disabled={saving} style={{
              padding: "16px 56px", borderRadius: 0,
              background: "linear-gradient(135deg, #8868D8, #a78bfa)",
              color: "#000",
              fontFamily: "'Syne', sans-serif", fontSize: 15, fontWeight: 800,
              border: "none", cursor: saving ? "default" : "pointer",
              letterSpacing: "0.04em",
              boxShadow: "0 0 40px rgba(136,104,216,0.4), 0 0 80px rgba(167,139,250,0.2)",
              animation: "wiz-glow 2s ease-in-out infinite",
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? "Setting up..." : `Launch Ether →`}
            </button>

            <div style={{ marginTop: 16, fontSize: 11, color: "rgba(255,255,255,0.2)" }}>You can change these settings anytime in Settings</div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes wiz-in {
          from{opacity:0;transform:translateY(16px);}
          to{opacity:1;transform:translateY(0);}
        }
        @keyframes wiz-check {
          from{opacity:0;transform:scale(0.5);}
          to{opacity:1;transform:scale(1);}
        }
        @keyframes wiz-glow {
          0%,100%{box-shadow:0 0 40px rgba(136,104,216,0.4),0 0 80px rgba(167,139,250,0.2);}
          50%{box-shadow:0 0 60px rgba(136,104,216,0.6),0 0 100px rgba(167,139,250,0.35);}
        }
      `}</style>
    </div>
  );
}
