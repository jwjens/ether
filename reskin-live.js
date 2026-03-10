const fs = require('fs');

console.log('\n  Ether — Reskin Live Assist\n');

// ============================================================
// Rewrite OnAirDeck with themed styles
// ============================================================

fs.writeFileSync('src/components/OnAirDeck.tsx', `import { useState, useEffect } from "react";
import { DeckState } from "../audio/engine";

interface Props {
  deck: DeckState | null;
  label: string;
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + ms;
}

export default function OnAirDeck({ deck, label }: Props) {
  const [blink, setBlink] = useState(false);

  const status = deck?.status || "idle";
  const title = deck?.title || "";
  const artist = deck?.artist || "";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const remaining = dur - pos;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  const introEnd = dur * 0.08;
  const outroStart = dur * 0.92;
  const isInIntro = pos < introEnd && status === "playing";
  const isInOutro = pos > outroStart && status === "playing";
  const isEnding = remaining < 15 && remaining > 0 && status === "playing";
  const isCritical = remaining < 5 && remaining > 0 && status === "playing";

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 300);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  // Theme-aware color system
  let accentColor = "var(--accent-blue)";
  let bgTint = "var(--bg-secondary)";
  let statusLabel = "IDLE";
  let statusColor = "var(--text-tertiary)";

  if (status === "playing") {
    if (isInIntro) {
      accentColor = "var(--accent-blue)";
      bgTint = "rgba(37, 99, 235, 0.06)";
      statusLabel = "INTRO — TALK";
      statusColor = "var(--accent-blue)";
    } else if (isCritical) {
      accentColor = "var(--accent-red)";
      bgTint = blink ? "rgba(220, 38, 38, 0.12)" : "rgba(220, 38, 38, 0.06)";
      statusLabel = "ENDING";
      statusColor = "var(--accent-red)";
    } else if (isEnding) {
      accentColor = "var(--accent-red)";
      bgTint = "rgba(220, 38, 38, 0.04)";
      statusLabel = "ENDING";
      statusColor = "var(--accent-red)";
    } else if (isInOutro) {
      accentColor = "var(--accent-amber)";
      bgTint = "rgba(217, 119, 6, 0.04)";
      statusLabel = "OUTRO";
      statusColor = "var(--accent-amber)";
    } else {
      accentColor = "var(--accent-green)";
      bgTint = "rgba(22, 163, 74, 0.04)";
      statusLabel = "PLAYING";
      statusColor = "var(--accent-green)";
    }
  } else if (status === "paused") {
    statusLabel = "PAUSED";
    statusColor = "var(--accent-amber)";
  } else if (status === "loading") {
    statusLabel = "LOADING";
    statusColor = "var(--accent-blue)";
  }

  return (
    <div style={{
      background: bgTint,
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-primary)",
      boxShadow: "var(--shadow-sm)",
      overflow: "hidden",
      transition: "background 0.3s ease",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        borderBottom: "1px solid var(--border-primary)",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: accentColor }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: statusColor }}>{statusLabel}</span>
      </div>

      {/* Content */}
      <div style={{ padding: "12px 16px" }}>
        {/* Title */}
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, letterSpacing: "-0.02em" }}>
          {title || "No track loaded"}
        </div>
        {artist && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{artist}</div>}

        {/* Timer */}
        {dur > 0 && (
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", margin: "12px 0 8px" }}>
            <div>
              <div style={{ fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-tertiary)", marginBottom: 2 }}>
                {isInIntro ? "Intro Left" : "Remaining"}
              </div>
              <div style={{ fontSize: 36, fontWeight: 800, fontFamily: "monospace", lineHeight: 1, color: accentColor, letterSpacing: "-0.02em" }}>
                {isInIntro ? fmtCountdown(introEnd - pos) : fmtCountdown(remaining)}
              </div>
            </div>
            <div style={{ textAlign: "right" as const }}>
              <div style={{ fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-tertiary)", marginBottom: 2 }}>Elapsed</div>
              <div style={{ fontSize: 18, fontFamily: "monospace", color: "var(--text-secondary)" }}>{fmtElapsed(pos)}</div>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {dur > 0 && (
          <div style={{ position: "relative", height: 6, background: "var(--bg-tertiary)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: pct + "%", background: accentColor, borderRadius: 3, transition: "width 0.2s linear" }}></div>
          </div>
        )}
      </div>
    </div>
  );
}
`, 'utf8');
console.log('  REWROTE OnAirDeck.tsx (themed)');

// ============================================================
// Rewrite UpNext with themed styles
// ============================================================

let upnext = fs.readFileSync('src/components/UpNext.tsx', 'utf8');

// Just update the outer container styling
upnext = upnext.replace(
  'className={"bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-full overflow-hidden"}',
  'style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}'
);

// Update header
upnext = upnext.replace(
  'className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0"',
  'style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}'
);

upnext = upnext.replace(
  'className="text-[10px] font-bold text-zinc-400 uppercase"',
  'style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.04em" }}'
);

fs.writeFileSync('src/components/UpNext.tsx', upnext, 'utf8');
console.log('  UPDATED UpNext.tsx (themed container)');

// ============================================================
// Rewrite CartWall with themed styles
// ============================================================

let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');

// Update empty slot styling
cart = cart.replace(
  'className="w-full rounded-lg flex flex-col items-center justify-center bg-zinc-800 hover:bg-zinc-700"',
  'className="w-full rounded-lg flex flex-col items-center justify-center" style={{ background: "var(--bg-tertiary)", border: "2px dashed var(--border-secondary)", cursor: "pointer" }}'
);

// Update grid gap
cart = cart.replace(
  'className="grid grid-cols-8 gap-2',
  'className="grid grid-cols-8 gap-3'
);

fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  UPDATED CartWall.tsx (themed)');

// ============================================================
// Update Live Assist controls styling
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Update the control bar buttons to use CSS vars
// GEN LOG button
app = app.replace(
  'className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG',
  'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: "var(--accent-green)", color: "#fff", border: "none", cursor: "pointer" }}>GEN LOG'
);

// 24/7 button
app = app.replace(
  'className={continuous ? "px-2.5 py-1 rounded text-[11px] font-bold bg-rose-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>24/7',
  'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: continuous ? "var(--accent-red)" : "var(--bg-tertiary)", color: continuous ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>24/7'
);

// SHUFFLE button
app = app.replace(
  'className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE',
  'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: shuffle ? "var(--accent-amber)" : "var(--bg-tertiary)", color: shuffle ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>SHUFFLE'
);

// AUTO button
app = app.replace(
  'className={autoAdv ? "px-2.5 py-1 rounded text-[11px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO',
  'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: autoAdv ? "var(--accent-blue)" : "var(--bg-tertiary)", color: autoAdv ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>AUTO'
);

// CARTS button
app = app.replace(
  'className={showCarts ? "px-2.5 py-1 rounded text-[11px] font-bold bg-orange-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>CARTS',
  'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: showCarts ? "var(--accent-orange)" : "var(--bg-tertiary)", color: showCarts ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>CARTS'
);

// AUTO-X button
if (app.includes('AUTO-X')) {
  app = app.replace(
    'className={autoXfade ? "px-2.5 py-1 rounded text-[11px] font-bold bg-indigo-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO-X',
    'style={{ padding: "5px 12px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: autoXfade ? "var(--accent-purple)" : "var(--bg-tertiary)", color: autoXfade ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>AUTO-X'
  );
}

// CROSSFADE button
app = app.replace(
  'className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE',
  'style={{ padding: "5px 14px", borderRadius: "var(--radius-xs)", fontSize: 11, fontWeight: 700, background: "var(--accent-purple)", color: "#fff", border: "none", cursor: "pointer" }}>CROSSFADE'
);

// Deck control buttons - STOP
app = app.replace(
  /style=\{\{ backgroundColor: deckA\?\.status === "playing" \? "#ca8a04" : "#2563eb" \}\}/g,
  'style={{ backgroundColor: deckA?.status === "playing" ? "var(--accent-amber)" : "var(--accent-blue)", borderRadius: "var(--radius-xs)" }}'
);
app = app.replace(
  /style=\{\{ backgroundColor: deckB\?\.status === "playing" \? "#ca8a04" : "#059669" \}\}/g,
  'style={{ backgroundColor: deckB?.status === "playing" ? "var(--accent-amber)" : "var(--accent-green)", borderRadius: "var(--radius-xs)" }}'
);

// Cart wall container
app = app.replace(
  'className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 mt-3 shrink-0"',
  'style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", padding: 16, marginTop: 12, flexShrink: 0 }}'
);

// Jock strip container
app = app.replace(
  'className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 space-y-2"',
  'style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", padding: "10px 14px" }}'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  UPDATED App.tsx (themed controls)');

console.log('\n  Done! npm run tauri:dev');
console.log('');
console.log('  Live Assist is now themed:');
console.log('    - Clean white deck cards with subtle colored tints');
console.log('    - Big bold countdown timers in accent colors');
console.log('    - Smooth progress bars');
console.log('    - Pill-shaped control buttons');
console.log('    - Themed queue panel');
console.log('    - Themed cart wall');
console.log('    - Everything respects light/dark toggle');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.5.1 reskinned Live Assist"');
console.log('    git push\n');
