// HelpPanel.tsx — in-app searchable documentation.
//
// Ships with docs for every major Ether feature. Searchable, keyboard-
// navigable (↑↓ to pick topic), left-nav table of contents. Content
// written in plain text with simple section headings — no markdown
// dependency. Hardcoded so it ships with the app (no network needed).

import { useEffect, useMemo, useState } from "react";

interface DocTopic {
  id: string;
  title: string;
  category: string;
  tags: string[];
  body: string;   // plain text, paragraphs separated by \n\n, headings prefixed with "# "
}

const TOPICS: DocTopic[] = [
  {
    id: "getting-started", category: "Basics", tags: ["intro", "start", "first"],
    title: "Getting started",
    body: `
# Welcome to Ether

Ether is a complete broadcast automation suite — think RCS Zetta or Wide Orbit, but modern, friendly, and one-fifth the price.

# The 3-minute tour

1. Import music (Library → Import Dialog → pick a folder of MP3s). Ether reads ID3 tags and auto-assigns categories when it can.
2. Click AUTO in the top toolbar. Ether fills the queue and starts playing.
3. Click the burger menu → Schedule → Shows & Dayparts to set up a 24-hour schedule.

# What to explore next

- Clocks (Schedule → Clocks) — build your rotation hour by hour
- Pair Mobile App (Settings → Pair Mobile App) — voice-track from your phone
- Stream Metadata (Settings → Stream Metadata Outputs) — push now-playing to Icecast/Shoutcast/TuneIn/RDS
`,
  },
  {
    id: "scheduling", category: "Scheduling", tags: ["schedule", "clocks", "rotation", "dayparts"],
    title: "Scheduling — clocks, dayparts, and rotation",
    body: `
# Concepts

Ether's scheduling engine has three layers:

1. Categories — rotation buckets for your songs (A/Power, B/Secondary, C/Recurrent, D/Gold, plus custom). Assigned at song-import time or bulk-edited.
2. Format clocks — an hour template. A clock has N slots in order: "song A", "song B", "news", "sweeper", "spot", "song C". You build one clock and reuse it.
3. Shows and dayparts — they tie clocks to the calendar. "6 AM–10 AM Mon–Fri" uses the "Mornings" clock; "10 PM–2 AM" uses "Nights".

# How rotation picks songs

When a music slot fires, Ether:
1. Looks at the slot's category (e.g. "A / Power")
2. Filters by daypart (songs restricted to this hour range via the daypart mask)
3. Applies separation rules (no same artist within 60 min, no same song within 4 hours, etc.)
4. Picks one at random from what's left

The exact "why" for every pick is logged to Schedule → Scheduler Reasons so you can audit.

# PD Picks (pinned songs)

To force a specific song at a specific time, use PD Picks (Schedule → PD Picks). Pin a song to "4 PM Mon–Fri" and it'll play there instead of rotation.

Force Play toggle: ignore separation rules. Use sparingly — that's how you end up playing the same song 4 times in a row.

# Schedule preview

Schedule → Schedule Preview shows the next 24/48/72 hours with clock slots and PD picks visualized. Red borders = conflicts (pin in a slot the clock doesn't have).
`,
  },
  {
    id: "voice-tracking", category: "Voice Tracking", tags: ["voice", "record", "mobile", "phone", "ether2go"],
    title: "Voice tracking & Ether2Go mobile app",
    body: `
# Voice tracking in the studio

Tools → Voice Tracker opens the studio voice tracker. Pick a song, record between intro and outro, drop into the rotation. Uses your input device from Settings → Audio Devices.

# Voice tracking from your phone (Ether2Go)

Ether2Go is a phone web app — no install, works on any phone on the same WiFi.

Pairing (one-time):
1. Settings → Pair Mobile App → Generate 6-digit code
2. On your phone, open http://<studio-ip>:3400/m (the URL is shown on the settings page)
3. Enter the code
4. Done — the token is saved on the phone

Recording:
1. Tap the big red button
2. Say your break
3. Review and add a title
4. Upload

On the studio side, Tools → Voice Track Inbox shows every upload. Click "→ Queue" to drop one into the playout engine.

# Tips

- Record in a quiet space. Ether2Go uses the phone mic's built-in echo cancellation + noise suppression.
- Mobile phones can record with the screen off — just start recording, lock the phone, come back later.
`,
  },
  {
    id: "streaming", category: "Streaming", tags: ["stream", "icecast", "shoutcast", "tunein", "rds", "pad"],
    title: "Streaming & metadata outputs",
    body: `
# Broadcasting online (Icecast/Shoutcast)

The built-in stream encoder ships audio to any Icecast 2 or Shoutcast server. Configure in Stream Manager (Tools → Stream Manager):

1. Server host and port
2. Mount point (Icecast) or SID (Shoutcast)
3. Source password
4. Bitrate (128kbps is the usual sweet spot for music)

Hit Start — now you're streaming.

# Now-playing metadata (PAD)

"PAD" = Program Associated Data. What shows in your listener's car radio, app, or stream player.

Settings → Stream Metadata Outputs lets you configure multiple targets in parallel:
- Icecast 2 — admin API
- Shoutcast v1/v2 — admin.cgi
- TuneIn AIR — Partner ID + Key + Station ID (get from tunein.com/broadcasters)
- RDS Encoder — Serial (COM port) to Inovonics, Audemat, Deva
- Generic Webhook — POST JSON to any URL

Every target can be enabled/disabled independently. If TuneIn is down, your Icecast still updates. Each target records last status + error inline.
`,
  },
  {
    id: "eas", category: "Compliance", tags: ["eas", "fcc", "emergency", "alert", "rwt", "rmt"],
    title: "EAS Logbook (FCC compliance)",
    body: `
# What it does

Ether keeps the FCC-required logbook of every Required Weekly Test (RWT), Required Monthly Test (RMT), and actual alert received or transmitted. Per 47 CFR § 11.61, these must be retained for 2 years.

Schedule → EAS Logbook.

# Important

Ether does not generate the EAS audio. That's the job of your EAS encoder/decoder (SAGE Digital ENDEC, Trilithic/DASDEC, etc.). Ether is the logbook + compliance dashboard + exportable records the FCC inspector wants.

# Workflow

After each test your EAS box generates, log it:
- Date/time received
- Alert code (RWT / RMT / NPT / real alert)
- Direction (received / transmitted / both)
- Originator (PEP / EAS / WXR / CIV)
- Sender callsign
- Retransmitted? Time retransmitted
- Operator initials

The compliance dashboard at the top shows RWT count this week, RMT this month, days since last — color-coded against FCC requirements.

# Export for inspection

CSV for spreadsheets, printable PDF for the inspector's binder. Both include the compliance summary header.
`,
  },
  {
    id: "midi-gpio", category: "Hardware", tags: ["midi", "gpio", "controller", "hardware", "streamdeck"],
    title: "MIDI controllers & GPIO",
    body: `
# MIDI controllers

Ether supports any MIDI device via the Web MIDI API. Behringer X-Touch, Novation Launchpad, Stream Deck (via MIDI plugin), etc.

Tools → MIDI Engine:
1. Plug in your device
2. Click "Learn" on an action (e.g. "Deck A Play")
3. Press the button/move the fader you want to bind
4. Save

Mappings are stored in the DB and survive restarts.

# GPIO (General Purpose I/O)

For broadcast hardware speaking TCP/UDP text: Axia GPIO nodes, WheatNet Logic, Broadcast Tools SS-series, SAS Sierra.

Tools → GPIO:
- Add device (TCP/UDP/HTTP)
- Map GPI pins to Ether actions (e.g. "pin 1 HIGH → play emergency cart")
- Map Ether events to GPO pins (e.g. "song plays → drive pin 3 HIGH for 200ms")

All happens in main process, zero latency impact on audio.
`,
  },
  {
    id: "backups", category: "Backups", tags: ["backup", "restore", "zip", "recovery", "disaster"],
    title: "Backups and disaster recovery",
    body: `
# Three layers of backup

1. Local DB backup (Settings → Backup & Restore → Backup Now)
   — Copies the SQLite DB to userData/backups. Auto-cleaned after 7 days.
   — Fast, zero-config. Great for "oops" moments.

2. Portable ZIP (Settings → Backup & Restore → Export Backup ZIP)
   — DB + localStorage settings + library path manifest.
   — Save anywhere: USB drive, cloud storage, email to yourself.
   — Import on any Ether install to restore.

3. Custom cloud destination (Pro+ → Cloud Backup → Custom Destination)
   — PUTs gzipped DB to S3/R2/Backblaze URL or a local network share.
   — Set interval (1-168h). Runs automatically in background.

# What's NOT in backups

Your audio files. Ether records their paths but not the actual MP3/WAV/FLAC. Keep your library on its own drive, ideally with its own backup strategy.

# Crash recovery

Ether auto-saves deck state + queue every few seconds. On next launch, if a crash was detected, you'll see a restore banner. Click it — deck A reloads where it was, queue comes back.
`,
  },
  {
    id: "stations", category: "Advanced", tags: ["stations", "multi", "group", "college"],
    title: "Running multiple stations",
    body: `
# Multi-station mode

Station group owners (and colleges with multiple signals) can run N stations from one Ether install. Each station has its own SQLite database — total data isolation.

Schedule → Stations:
1. "+ Add Station" — name, callsign, frequency, city
2. Click "Switch to this station"
3. Ether relaunches against the new station's fresh DB
4. Build your library, schedule, etc.

# What's shared

Nothing at the data level. Each station is fully independent. License key, user accounts, OS-level settings are shared (they live in Ether's config, not the per-station DB).

# Active station

The top-right pill shows the active station. Single-station installs hide it. Multi-station installs click the pill to switch.

# Gotchas

- Switching relaunches Ether. Any unsaved Studio Editor work will be lost.
- Each station has its own AI voice segments, PD picks, EAS logs, everything.
- Deleting a station removes its DB file — no undo.
`,
  },
  {
    id: "gselector", category: "Migration", tags: ["gselector", "rcs", "import", "migrate"],
    title: "Importing from GSelector",
    body: `
# One-shot migration

If you're coming from RCS GSelector, Ether reads GSelector's XML export format directly.

Schedule → Import from GSelector.

# How to export from GSelector

In GSelector: File → Export → XML. Choose what to export:
- Music Library (all songs with category/artist metadata)
- Categories (just the rotation codes)
- Hour Templates (your format clocks)

A full export of all three is the fastest path.

# What Ether imports

- Categories (code, name, color)
- Songs (title, artist, category, duration, intro/outro markers, BPM, energy, year, file path)
- Hour Templates → Format Clocks with slot order preserved

# What you'll still need to do

- If file paths don't resolve (e.g. GSelector ran on Windows, Ether is on Mac), bulk remap in Library → Bulk Edit.
- Separation rules and scheduling-rule tunings don't cross over — set those in Settings → Music Scheduling Rules.
- Dayparts/shows need to be built in Schedule → Shows & Dayparts. We import the clocks, you wire them to times.

Existing categories/songs/clocks with matching names are left alone — the import only adds new entries. Safe to run incrementally.
`,
  },
  {
    id: "shortcuts", category: "Basics", tags: ["keyboard", "shortcuts", "hotkeys"],
    title: "Keyboard shortcuts",
    body: `
# Global

- Space — play/pause the active deck
- A — toggle AUTO mode (auto-advance on/off)
- G — open Play Log
- Ctrl/⌘ + K — open global search

# Decks

- 1/2/3 — focus decks A/B/C
- P — play focused deck
- S — stop focused deck

# Queue

- ↑/↓ — select queue item
- Delete — remove from queue
- Enter — load selected into next available deck

# Views

- L — Live view
- Ctrl/⌘ + , — Settings
- ? — this help panel (when focused on anything non-text-input)
`,
  },
  {
    id: "troubleshooting", category: "Basics", tags: ["help", "error", "broken", "fix"],
    title: "Troubleshooting common issues",
    body: `
# "No audio output"

Settings → Audio Devices. Make sure an output device is selected. If Windows, check that nothing else has exclusive mode on the device.

# "Dead air — watchdog didn't kick in"

The watchdog requires AUTO to be on. Click AUTO in the toolbar (persists across restarts). If the queue is empty AND no refill source is configured, the watchdog logs a warning but can't play anything — ensure a Smart Scheduler rule or format clock is set up.

# "Port 3400 already in use"

Another Ether instance is running (check Task Manager / Activity Monitor for zombie processes). Kill it and relaunch. The REST API needs port 3400 — if blocked, Ether still plays audio but remote control / mobile app / integrations won't work.

# "Mobile app won't pair"

Both devices must be on the same WiFi network. Corporate networks often block direct device-to-device traffic — try a guest network or personal hotspot. The pairing code expires after 10 minutes.

# "AI voice generation fails"

Check Settings → AI Voice Generation. API key must be valid for the chosen provider. If using ElevenLabs, also pick a voice ID (click "Load voices" first). Click "Generate test clip" to confirm before committing to real templates.

# Where are the logs?

Ctrl/⌘ + Shift + I opens DevTools. Console tab shows engine events prefixed like [ENGINE], [WATCHDOG], [METADATA]. Station Health panel (the live console) mirrors important events without needing DevTools.
`,
  },
];

const CATEGORIES = Array.from(new Set(TOPICS.map(t => t.category)));

function renderBody(body: string) {
  const parts = body.trim().split(/\n\n+/);
  return parts.map((p, i) => {
    if (p.startsWith("# ")) {
      return <h3 key={i} style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)", marginTop: i === 0 ? 0 : 22, marginBottom: 8, letterSpacing: "-0.02em" }}>{p.slice(2)}</h3>;
    }
    // Line-style lists (starting with "- ")
    const lines = p.split("\n");
    if (lines.every(l => l.startsWith("- "))) {
      return (
        <ul key={i} style={{ margin: "0 0 12px 18px", padding: 0, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.7 }}>
          {lines.map((l, j) => <li key={j}>{renderInline(l.slice(2))}</li>)}
        </ul>
      );
    }
    // Numbered list
    if (lines.every(l => /^\d+\.\s/.test(l))) {
      return (
        <ol key={i} style={{ margin: "0 0 12px 22px", padding: 0, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.7 }}>
          {lines.map((l, j) => <li key={j}>{renderInline(l.replace(/^\d+\.\s/, ""))}</li>)}
        </ol>
      );
    }
    return <p key={i} style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.7 }}>{renderInline(p)}</p>;
  });
}
function renderInline(text: string) {
  // Minimal inline: <b>**bold**</b> via splitter, nothing else
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} style={{ color: "var(--text-primary)" }}>{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}

export default function HelpPanel({ onClose, initialTopic }: { onClose?: () => void; initialTopic?: string }) {
  const [search, setSearch]   = useState("");
  const [activeId, setActiveId] = useState<string>(initialTopic || TOPICS[0].id);

  const filtered = useMemo(() => {
    if (!search) return TOPICS;
    const q = search.toLowerCase();
    return TOPICS.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.tags.some(tag => tag.includes(q)) ||
      t.body.toLowerCase().includes(q)
    );
  }, [search]);

  const byCategory = useMemo(() => {
    const m: Record<string, DocTopic[]> = {};
    for (const t of filtered) {
      if (!m[t.category]) m[t.category] = [];
      m[t.category].push(t);
    }
    return m;
  }, [filtered]);

  const active = TOPICS.find(t => t.id === activeId) || TOPICS[0];

  useEffect(() => {
    if (filtered.length > 0 && !filtered.find(t => t.id === activeId)) setActiveId(filtered[0].id);
  }, [filtered, activeId]);

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Help & Documentation</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            {TOPICS.length} topics · searchable · works offline
          </div>
        </div>
        {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search docs… (title, content, tags)"
        style={{
          width: "100%", padding: "10px 14px", marginBottom: 14,
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          color: "var(--text-primary)", fontSize: 14, outline: "none", borderRadius: 0,
        }}
      />

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, alignItems: "flex-start" }}>
        {/* Left nav */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "10px 0", maxHeight: "75vh", overflowY: "auto" }}>
          {Object.keys(byCategory).length === 0 ? (
            <div style={{ padding: "20px 14px", color: "var(--text-tertiary)", fontSize: 12, textAlign: "center" as any }}>No matches</div>
          ) : (
            Object.entries(byCategory).map(([cat, items]) => (
              <div key={cat} style={{ marginBottom: 10 }}>
                <div style={{ padding: "6px 14px", fontSize: 10, fontWeight: 800, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{cat}</div>
                {items.map(t => (
                  <button key={t.id} onClick={() => setActiveId(t.id)} style={{
                    display: "block", width: "100%", textAlign: "left" as any,
                    padding: "7px 14px", fontSize: 13, border: "none", cursor: "pointer",
                    background: activeId === t.id ? "rgb(from var(--accent-blue) r g b / 0.12)" : "transparent",
                    color: activeId === t.id ? "var(--accent-blue)" : "var(--text-secondary)",
                    fontWeight: activeId === t.id ? 700 : 500,
                    borderLeft: activeId === t.id ? "2px solid var(--accent-blue)" : "2px solid transparent",
                  }}>
                    {t.title}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Content */}
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "24px 28px", maxHeight: "75vh", overflowY: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginBottom: 4 }}>{active.category}</div>
          <h2 style={{ margin: "0 0 14px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em" }}>{active.title}</h2>
          {renderBody(active.body)}
          <div style={{ marginTop: 24, paddingTop: 14, borderTop: "1px solid var(--border-primary)", fontSize: 11, color: "var(--text-tertiary)" }}>
            Tags: {active.tags.map(t => <code key={t} style={{ marginRight: 6, background: "var(--bg-tertiary)", padding: "1px 5px" }}>{t}</code>)}
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
