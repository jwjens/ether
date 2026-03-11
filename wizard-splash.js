const fs = require('fs');

console.log('\n  Ether — First-Run Wizard + Splash Screen\n');

// ============================================================
// 1. Add station_config table
// ============================================================

let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('station_config')) {
  client = client.replace(
    '  console.log("DB ready");',
    [
      '  await d.execute("CREATE TABLE IF NOT EXISTS station_config (id INTEGER PRIMARY KEY, station_name TEXT NOT NULL DEFAULT \'My Station\', mode TEXT NOT NULL DEFAULT \'\', tagline TEXT, logo_path TEXT, setup_complete INTEGER NOT NULL DEFAULT 0)");',
      '  const cfgCount = await d.select("SELECT COUNT(*) as c FROM station_config");',
      '  if ((cfgCount as any)[0].c === 0) {',
      '    await d.execute("INSERT INTO station_config (id) VALUES (1)");',
      '  }',
      '  console.log("DB ready");',
    ].join('\n')
  );
  fs.writeFileSync('src/db/client.ts', client, 'utf8');
  console.log('  UPDATED client.ts (station_config table)');
}

// ============================================================
// 2. Create SplashScreen component
// ============================================================

fs.writeFileSync('src/components/SplashScreen.tsx', `import { useState, useEffect } from "react";

interface Props {
  onDone: () => void;
}

export default function SplashScreen({ onDone }: Props) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");

  useEffect(() => {
    const steps = [
      { pct: 15, msg: "Loading database..." },
      { pct: 35, msg: "Checking audio devices..." },
      { pct: 55, msg: "Loading library..." },
      { pct: 75, msg: "Starting audio engine..." },
      { pct: 90, msg: "Preparing interface..." },
      { pct: 100, msg: "Ready" },
    ];

    let i = 0;
    const timer = setInterval(() => {
      if (i < steps.length) {
        setProgress(steps[i].pct);
        setStatus(steps[i].msg);
        i++;
      } else {
        clearInterval(timer);
        setTimeout(onDone, 400);
      }
    }, 350);

    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 99999,
      background: "#09090b",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 32 }}>
        <div style={{
          width: 80,
          height: 80,
          borderRadius: 20,
          background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 20px 40px rgba(37, 99, 235, 0.3)",
          marginBottom: 20,
          marginLeft: "auto",
          marginRight: "auto",
        }}>
          <span style={{ fontSize: 36, fontWeight: 300, color: "#fff", letterSpacing: "-0.03em" }}>E</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 300, color: "#fff", letterSpacing: "-0.03em" }}>
            <span style={{ color: "#2563eb" }}>Eth</span>er
          </div>
          <div style={{ fontSize: 11, fontWeight: 300, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", textTransform: "uppercase" as const, marginTop: 4 }}>
            Broadcast Automation
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ width: 240 }}>
        <div style={{
          height: 2,
          background: "rgba(255,255,255,0.08)",
          borderRadius: 1,
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: progress + "%",
            background: "linear-gradient(90deg, #2563eb, #7c3aed)",
            borderRadius: 1,
            transition: "width 0.3s ease",
          }} />
        </div>
        <div style={{
          fontSize: 10,
          fontWeight: 300,
          color: "rgba(255,255,255,0.25)",
          textAlign: "center" as const,
          marginTop: 8,
          letterSpacing: "0.02em",
        }}>
          {status}
        </div>
      </div>

      {/* Version */}
      <div style={{
        position: "absolute",
        bottom: 24,
        fontSize: 10,
        fontWeight: 300,
        color: "rgba(255,255,255,0.15)",
        letterSpacing: "0.04em",
      }}>
        v1.7 — Free forever
      </div>
    </div>
  );
}
`, 'utf8');
console.log('  CREATED SplashScreen.tsx');

// ============================================================
// 3. Create FirstRunWizard component
// ============================================================

fs.writeFileSync('src/components/FirstRunWizard.tsx', `import { useState } from "react";
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
`, 'utf8');
console.log('  CREATED FirstRunWizard.tsx');

// ============================================================
// 4. Wire into App.tsx
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('SplashScreen')) {
  app = app.replace(
    'import Announcements, { startAnnouncementEngine } from "./components/Announcements";',
    'import Announcements, { startAnnouncementEngine } from "./components/Announcements";\nimport SplashScreen from "./components/SplashScreen";\nimport FirstRunWizard from "./components/FirstRunWizard";'
  );

  // Add splash and wizard states
  app = app.replace(
    'const [showNowPlaying, setShowNowPlaying] = useState(false);',
    'const [showNowPlaying, setShowNowPlaying] = useState(false);\n  const [showSplash, setShowSplash] = useState(true);\n  const [showWizard, setShowWizard] = useState(false);\n  const [stationName, setStationName] = useState("Ether");'
  );

  // Check if first run after splash completes
  app = app.replace(
    '  useEffect(() => {\n    engine.init();\n    startAnnouncementEngine();',
    '  useEffect(() => {\n    engine.init();\n    startAnnouncementEngine();\n    // Check if first run\n    queryOne<{ setup_complete: number; station_name: string }>("SELECT setup_complete, station_name FROM station_config WHERE id=1").then(cfg => {\n      if (cfg && cfg.setup_complete) {\n        setStationName(cfg.station_name || "Ether");\n      } else {\n        setShowWizard(true);\n      }\n    }).catch(() => {});'
  );

  // Add splash and wizard renders at the top of the JSX
  app = app.replace(
    '  return (\n    <div className={"h-screen flex flex-col "',
    '  return (\n    <>\n    {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}\n    {!showSplash && showWizard && <FirstRunWizard onComplete={() => { setShowWizard(false); queryOne<{ station_name: string }>("SELECT station_name FROM station_config WHERE id=1").then(c => { if (c) setStationName(c.station_name); }); }} />}\n    <div className={"h-screen flex flex-col "'
  );

  // Close the fragment at the end
  app = app.replace(
    /(\s*\);\s*}\s*$)/,
    '\n    </>\n  );\n}\n'
  );

  // Use stationName in header
  app = app.replace(
    '<span style={{ color: "var(--text-primary)" }}>er</span></span>',
    '<span style={{ color: "var(--text-primary)" }}>er</span></span><span style={{ fontSize: 12, fontWeight: 300, color: "var(--text-tertiary)", marginLeft: 12 }}>{stationName}</span>'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (splash + wizard)');
}

console.log('\n  Done! Delete DB and restart fresh:');
console.log('  Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force -ErrorAction SilentlyContinue');
console.log('  npm run tauri:dev\n');
console.log('  ON FIRST LAUNCH:');
console.log('    1. Splash screen — Ether logo, gradient progress bar');
console.log('       "Loading database..." "Starting audio engine..." "Ready"');
console.log('');
console.log('    2. First-run wizard — "What are you using Ether for?"');
console.log('       Radio Station — clocks, rotation, jock tools');
console.log('       Venue / Attraction — announcements, zones, background music');
console.log('       Retail / Business — daypart playlists, set and forget');
console.log('       House of Worship — service scheduling, automation');
console.log('');
console.log('    3. Name your station/venue — appears in header');
console.log('');
console.log('    4. "Launch Ether" — takes you to the dashboard');
console.log('');
console.log('  ON SUBSEQUENT LAUNCHES:');
console.log('    Splash screen only (2 seconds), then straight to dashboard.');
console.log('    Station name shows in the header bar.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.8.0 splash screen + first-run wizard"');
console.log('    git push\n');
