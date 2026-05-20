import { useState } from "react";
import type { VenueProfile } from "./FirstRunWizard";

// Replaces FirstRunWizard at the first_run_complete gate in App.tsx.
// Implements the four screens of docs/onboarding-spec-v1.md with the
// three FirstRunWizard fields (venue_type, experience_mode, station_name +
// station_tagline) bolted on between Screen 3/3b and Screen 4 so the
// downstream readers in OnShiftScreen / SettingsPanel / App.tsx persona
// labels keep working.

type OnboardingState =
  | 'welcome'            // Screen 1 — path picker
  | 'create'             // Screen 2a — POST /account/create
  | 'connect'            // Screen 2b — POST /account/connect
  | 'pickStation'        // Screen 3  — list from /account/connect
  | 'addStation'         // Screen 3b — POST /account/add-station
  | 'experienceMode'     // bolted, restyled FirstRunWizard step 0
  | 'venueType'          // bolted, restyled FirstRunWizard step 1
  | 'nameStation'        // bolted, restyled FirstRunWizard step 2 (name + tagline)
  | 'pickAudioLocation'  // Screen 3.5 — Milestone B only; skipped in Milestone A
  | 'pulling'            // Screen 4 — initial library sync
  | 'done';              // calls onComplete(); App.tsx routes to main UI

interface Props {
  onComplete: (profile: VenueProfile) => void;
}

// ── Shared visual constants ────────────────────────────────────────────
// Pulled from FirstRunWizard so the whole onboarding feels like one product.
// Extracted as module-level consts so each screen body stays readable as the
// flow grows across commits.

const OVERLAY_STYLE: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 9998,
  background: "#080810",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'Inter', system-ui, sans-serif",
  padding: 24,
};

const SHELL_STYLE: React.CSSProperties = {
  width: "100%", maxWidth: 640, position: "relative",
};

const GLOW_STYLE: React.CSSProperties = {
  position: "absolute", width: 700, height: 700, borderRadius: "50%",
  background: "radial-gradient(circle, rgba(34,211,238,0.05) 0%, transparent 70%)",
  pointerEvents: "none",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.2em",
  color: "#22d3ee", textTransform: "uppercase",
  marginBottom: 12,
};

const HEADING_STYLE: React.CSSProperties = {
  fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800,
  letterSpacing: "-0.04em", color: "#f0f0f8", lineHeight: 1.1, marginBottom: 12,
};

const SUB_STYLE: React.CSSProperties = {
  fontSize: 14, color: "rgba(255,255,255,0.4)", lineHeight: 1.6,
};

const CARD_STYLE: React.CSSProperties = {
  padding: "22px 24px", borderRadius: 0, textAlign: "left",
  background: "rgba(255,255,255,0.03)",
  border: "1.5px solid rgba(255,255,255,0.08)",
  cursor: "pointer", transition: "all 0.2s",
  display: "flex", alignItems: "center", gap: 16,
  color: "#f0f0f8",
};

const ANIMATION_CSS = `
  @keyframes onb-in {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

export default function OnboardingFlow({ onComplete }: Props) {
  const [state, setState] = useState<OnboardingState>('welcome');

  // Stub for the done branch — wired in commits #7-9 once the bolted screens
  // and Screen 4 collect venueType/name/tagline. Kept here so the onComplete
  // prop is referenced and the call shape lines up with handleWizardComplete
  // in App.tsx.
  if (state === 'done') {
    onComplete({ venueType: 'radio', name: '', tagline: '' });
    return null;
  }

  // ── Screen 1 — Welcome / choose path ─────────────────────────────────
  if (state === 'welcome') {
    return (
      <div style={OVERLAY_STYLE}>
        <div style={GLOW_STYLE} />
        <div style={SHELL_STYLE}>
          <div style={{ animation: "onb-in 0.4s ease both" }}>
            <div style={{ textAlign: "center", marginBottom: 40 }}>
              <div style={LABEL_STYLE}>Welcome to Ether</div>
              <h1 style={HEADING_STYLE}>Set up your<br />Ether station</h1>
              <p style={SUB_STYLE}>
                Are you setting up Ether for the first time,<br />
                or adding this computer to an existing account?
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520, margin: "0 auto" }}>
              <PathButton
                title="Create new account"
                subtitle="First install — set up a new station under your license"
                onClick={() => setState('create')}
              />
              <PathButton
                title="Connect to existing account"
                subtitle="Adding this computer to a station you already use"
                onClick={() => setState('connect')}
              />
            </div>
          </div>
        </div>
        <style>{ANIMATION_CSS}</style>
      </div>
    );
  }

  // ── Placeholder for unbuilt screens ──────────────────────────────────
  // Replaced screen-by-screen by tasks #3-9. Until then, clicking through
  // Screen 1 lands here; "Back to start" returns to the welcome screen so
  // the operator isn't trapped during dev.
  return (
    <div style={OVERLAY_STYLE}>
      <div style={GLOW_STYLE} />
      <div style={SHELL_STYLE}>
        <div style={{ textAlign: "center", animation: "onb-in 0.4s ease both" }}>
          <div style={LABEL_STYLE}>OnboardingFlow — scaffold</div>
          <h1 style={HEADING_STYLE}>{stateLabel(state)}</h1>
          <p style={SUB_STYLE}>Not implemented yet — building in a follow-up commit.</p>
          <button
            onClick={() => setState('welcome')}
            style={{
              marginTop: 32, padding: "12px 28px", borderRadius: 0,
              background: "transparent", color: "rgba(255,255,255,0.4)",
              border: "1px solid rgba(255,255,255,0.1)",
              fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
              letterSpacing: "0.04em", cursor: "pointer",
            }}
          >
            ← Back to start
          </button>
        </div>
      </div>
      <style>{ANIMATION_CSS}</style>
    </div>
  );
}

function stateLabel(s: OnboardingState): string {
  switch (s) {
    case 'create':            return 'Screen 2a — Create new account';
    case 'connect':           return 'Screen 2b — Connect to existing account';
    case 'pickStation':       return 'Screen 3 — Pick or add a station';
    case 'addStation':        return 'Screen 3b — Add a new station';
    case 'experienceMode':    return 'Choose your deck layout';
    case 'venueType':         return 'What are you using Ether for?';
    case 'nameStation':       return 'Name your station';
    case 'pickAudioLocation': return 'Screen 3.5 — Audio library location (Milestone B)';
    case 'pulling':           return 'Connecting to your station…';
    case 'welcome':           return 'Welcome';
    case 'done':              return 'All set';
  }
}

function PathButton({ title, subtitle, onClick }: { title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={CARD_STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "#22d3ee";
        e.currentTarget.style.background  = "rgba(34,211,238,0.06)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
        e.currentTarget.style.background  = "rgba(255,255,255,0.03)";
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, color: "#f0f0f8", letterSpacing: "-0.02em", marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>
          {subtitle}
        </div>
      </div>
      <div style={{ fontSize: 18, color: "rgba(34,211,238,0.5)" }}>→</div>
    </button>
  );
}
