/**
 * AboutPanel.tsx
 * Ether Technologies — About screen
 * Triggered from Help → About Ether Technologies
 */

import { useState } from "react";

interface Props {
  onClose: () => void;
}

const VERSION = "1.5.2";
const BUILD_DATE = "March 2026";

const CHANGELOG = [
  {
    version: "1.5.2",
    date: "March 2026",
    changes: [
      "Phone Desk — live call intake, chop & send to deck",
      "Voice Tracker — click-to-assign talk breaks, target duration guide",
      "Theme Studio — 8 named presets, per-element color wheels",
      "Format Clock — custom talk break duration picker",
      "Program Log — multi-hour selection & batch generate",
      "WebGL2 waveform renderer — GPU accelerated, ~0.3ms per draw",
      "EBU R128 loudness, BPM detection & cue points via Rust engine",
      "ASIO/CPAL native audio device support",
    ],
  },
  {
    version: "1.4.0",
    date: "January 2026",
    changes: [
      "Smart Scheduler with AI show notes",
      "Broadcast Editor & Studio Editor",
      "Podcast Studio mode",
      "Cart Wall hot buttons",
      "NexGen / ENCO XML import bridge",
      "Crash recovery & session restore",
    ],
  },
  {
    version: "1.3.0",
    date: "November 2025",
    changes: [
      "Live captions + SRT/VTT export",
      "Voice tracking with format clock integration",
      "Overflow crossfade automation",
      "Subscription & license system",
    ],
  },
];

const OSS_CREDITS = [
  { name: "Tauri",        license: "MIT / Apache 2.0",  url: "https://tauri.app",           desc: "Desktop app framework" },
  { name: "React",        license: "MIT",               url: "https://react.dev",           desc: "UI library" },
  { name: "Rodio",        license: "Apache 2.0",        url: "https://github.com/RustAudio/rodio", desc: "Audio playback" },
  { name: "CPAL",         license: "Apache 2.0",        url: "https://github.com/RustAudio/cpal",  desc: "Cross-platform audio" },
  { name: "Symphonia",    license: "MIT / Apache 2.0",  url: "https://github.com/pdeljanov/Symphonia", desc: "Audio decoding" },
  { name: "ebur128",      license: "MIT",               url: "https://crates.io/crates/ebur128", desc: "EBU R128 loudness" },
  { name: "RustFFT",      license: "MIT / Apache 2.0",  url: "https://github.com/ejmahler/RustFFT", desc: "FFT / DSP" },
  { name: "SQLite",       license: "Public Domain",     url: "https://sqlite.org",          desc: "Embedded database" },
  { name: "tauri-plugin-sql", license: "MIT / Apache 2.0", url: "https://github.com/tauri-apps/plugins-workspace", desc: "SQL plugin" },
  { name: "Serde",        license: "MIT / Apache 2.0",  url: "https://serde.rs",            desc: "Serialization" },
  { name: "Vite",         license: "MIT",               url: "https://vitejs.dev",          desc: "Build tooling" },
  { name: "TypeScript",   license: "Apache 2.0",        url: "https://typescriptlang.org",  desc: "Type system" },
];

const TEAM = [
  { name: "Jeff Jens",       role: "Founder & Lead Engineer",  detail: "Architecture, Rust engine, audio systems" },
];

export default function AboutPanel({ onClose }: Props) {
  const [tab, setTab] = useState<"about" | "changelog" | "credits">("about");
  const [ossExpanded, setOssExpanded] = useState(false);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.7)",
      backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 640, maxHeight: "88vh",
        background: "#0d0d18",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 20,
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.7), 0 0 0 1px rgba(34,211,238,0.06)",
      }}>

        {/* ── Hero ── */}
        <div style={{
          padding: "40px 40px 32px",
          background: "linear-gradient(160deg, #0d0d1f 0%, #0a0a16 60%, #080810 100%)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
          position: "relative",
          overflow: "hidden",
        }}>
          {/* Background glow */}
          <div style={{
            position: "absolute", top: -80, right: -80,
            width: 300, height: 300, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(34,211,238,0.06) 0%, transparent 70%)",
            pointerEvents: "none",
          }} />
          <div style={{
            position: "absolute", bottom: -60, left: -60,
            width: 240, height: 240, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(167,139,250,0.05) 0%, transparent 70%)",
            pointerEvents: "none",
          }} />

          <div style={{ display: "flex", alignItems: "center", gap: 24, position: "relative" }}>
            {/* Logo mark */}
            <div style={{
              width: 72, height: 72, borderRadius: 18, flexShrink: 0,
              background: "linear-gradient(135deg, #22d3ee 0%, #a78bfa 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 40px rgba(34,211,238,0.25), 0 0 80px rgba(167,139,250,0.12)",
            }}>
              <svg width="40" height="40" viewBox="0 0 44 44" fill="none">
                <path d="M4 22 C9 12 14 12 19 22 C24 32 29 32 34 22 C39 12 40 12 40 22"
                  stroke="#080810" strokeWidth="3.5" strokeLinecap="round"/>
              </svg>
            </div>

            {/* Title block */}
            <div>
              <div style={{
                fontFamily: "'Syne', sans-serif",
                fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em",
                background: "linear-gradient(135deg, #f0f0f8 0%, rgba(240,240,248,0.7) 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                marginBottom: 4,
              }}>
                Ether Technologies
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 13, fontWeight: 700, color: "#22d3ee",
                  background: "rgba(34,211,238,0.1)",
                  border: "1px solid rgba(34,211,238,0.25)",
                  borderRadius: 6, padding: "2px 10px",
                }}>v{VERSION}</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", fontFamily: "'DM Mono', monospace" }}>
                  {BUILD_DATE}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Broadcast Automation Platform
              </div>
            </div>

            {/* Close */}
            <button onClick={onClose} style={{
              marginLeft: "auto", width: 30, height: 30, borderRadius: 8,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.35)", cursor: "pointer", fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.1s", flexShrink: 0,
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.15)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.35)"; }}
            >✕</button>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{
          display: "flex", gap: 2, padding: "10px 16px",
          background: "#0a0a14",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}>
          {([
            { id: "about",     label: "About" },
            { id: "changelog", label: "What's New" },
            { id: "credits",   label: "Open Source" },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "6px 16px", borderRadius: 7, fontSize: 11, fontWeight: 700,
              border: "none", cursor: "pointer", transition: "all 0.12s",
              background: tab === t.id ? "rgba(34,211,238,0.12)" : "transparent",
              color: tab === t.id ? "#22d3ee" : "rgba(255,255,255,0.35)",
              letterSpacing: "0.02em",
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>

          {/* ── ABOUT TAB ── */}
          {tab === "about" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

              {/* Description */}
              <div>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", lineHeight: 1.7, margin: 0 }}>
                  Ether is a free, open-source broadcast automation platform built to replace
                  commercial systems like RCS Zetta and GSelector. Designed for radio stations,
                  venues, retail, worship, and podcast studios of any size.
                </p>
              </div>

              {/* Team */}
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.18em", color: "rgba(255,255,255,0.2)", textTransform: "uppercase", marginBottom: 12 }}>Team</div>
                {TEAM.map(member => (
                  <div key={member.name} style={{
                    display: "flex", alignItems: "center", gap: 14,
                    padding: "12px 16px", borderRadius: 12,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                      background: "linear-gradient(135deg, rgba(34,211,238,0.2), rgba(167,139,250,0.2))",
                      border: "1px solid rgba(34,211,238,0.2)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 800,
                      color: "#22d3ee",
                    }}>
                      {member.name.charAt(0)}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#f0f0f8", marginBottom: 2 }}>{member.name}</div>
                      <div style={{ fontSize: 11, color: "#22d3ee", marginBottom: 1 }}>{member.role}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{member.detail}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Contact & Links */}
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.18em", color: "rgba(255,255,255,0.2)", textTransform: "uppercase", marginBottom: 12 }}>Contact & Support</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { label: "GitHub Repository", value: "github.com/jwjens/ether",   href: "https://github.com/jwjens/ether",          icon: "⌥", accent: "#22d3ee" },
                    { label: "Legal & Licensing",  value: "legal@etherradio.app",      href: "mailto:legal@etherradio.app",              icon: "⚖", accent: "#a78bfa" },
                    { label: "Support",            value: "support@etherradio.app",    href: "mailto:support@etherradio.app",            icon: "◎", accent: "#34d399" },
                  ].map(link => (
                    <div key={link.label}
                      onClick={async () => {
                        try {
                          const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
                          await invoke("open_url", { url: link.href });
                        } catch {
                          window.open(link.href, "_blank");
                        }
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 14px", borderRadius: 10,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,255,255,0.05)",
                        cursor: "pointer", transition: "all 0.12s",
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLElement).style.background = link.accent + "0f";
                        (e.currentTarget as HTMLElement).style.borderColor = link.accent + "30";
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)";
                        (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.05)";
                      }}
                    >
                      <span style={{ fontSize: 14, width: 20, textAlign: "center", flexShrink: 0, color: link.accent }}>{link.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 1, letterSpacing: "0.04em" }}>{link.label}</div>
                        <div style={{ fontSize: 12, color: link.accent, fontFamily: "'DM Mono', monospace" }}>{link.value}</div>
                      </div>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ color: link.accent, opacity: 0.5, flexShrink: 0 }}>
                        <path d="M1 9L9 1M9 1H4M9 1V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  ))}
                </div>
              </div>

              {/* Legal footer */}
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.18)", lineHeight: 1.6, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 16 }}>
                Ether is free and open-source software. The core platform will always be free.
                Pro and Station plans fund continued development. © 2025–2026 Ether Technologies.
                Released under the MIT License.
              </div>
            </div>
          )}

          {/* ── CHANGELOG TAB ── */}
          {tab === "changelog" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {CHANGELOG.map((release, ri) => (
                <div key={release.version}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{
                      fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700,
                      color: ri === 0 ? "#22d3ee" : "rgba(255,255,255,0.4)",
                      background: ri === 0 ? "rgba(34,211,238,0.1)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${ri === 0 ? "rgba(34,211,238,0.25)" : "rgba(255,255,255,0.06)"}`,
                      borderRadius: 6, padding: "2px 10px",
                    }}>v{release.version}</span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", fontFamily: "'DM Mono', monospace" }}>{release.date}</span>
                    {ri === 0 && <span style={{ fontSize: 9, fontWeight: 700, color: "#34d399", background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.25)", borderRadius: 4, padding: "1px 7px", letterSpacing: "0.08em" }}>CURRENT</span>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingLeft: 4 }}>
                    {release.changes.map((change, ci) => (
                      <div key={ci} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12, color: ri === 0 ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
                        <span style={{ color: ri === 0 ? "#22d3ee" : "rgba(255,255,255,0.2)", flexShrink: 0, marginTop: 1 }}>→</span>
                        {change}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── OPEN SOURCE TAB ── */}
          {tab === "credits" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.6, margin: 0 }}>
                Ether is built on the shoulders of these excellent open-source projects.
                We're grateful to every maintainer and contributor.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {OSS_CREDITS.map(dep => (
                  <div key={dep.name}
                    onClick={async () => {
                      try {
                        const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
                        await invoke("open_url", { url: dep.url });
                      } catch {
                        window.open(dep.url, "_blank");
                      }
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "9px 14px", borderRadius: 9,
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.04)",
                      cursor: "pointer", transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(167,139,250,0.06)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"; }}
                  >
                    <div style={{ width: 90, flexShrink: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", fontFamily: "'DM Mono', monospace" }}>{dep.name}</div>
                    </div>
                    <div style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{dep.desc}</div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{dep.license}</div>
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ color: "#a78bfa", opacity: 0.4, flexShrink: 0, marginLeft: 6 }}>
                      <path d="M1 9L9 1M9 1H4M9 1V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.18)", lineHeight: 1.6, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 14 }}>
                Full license texts are included in the source repository at github.com/jwjens/ether.
                Ether Technologies is committed to open-source software and giving back to the community.
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: "12px 32px", borderTop: "1px solid rgba(255,255,255,0.05)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "#0a0a14", flexShrink: 0,
        }}>
          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em" }}>
            ETHER TECHNOLOGIES · v{VERSION} · MIT LICENSE
          </span>
          <button onClick={onClose} style={{
            padding: "6px 18px", borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.4)", cursor: "pointer", transition: "all 0.1s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.09)"; (e.currentTarget as HTMLElement).style.color = "#fff"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)"; }}
          >Close</button>
        </div>
      </div>
    </div>
  );
}
